"""Outbound-only BitTorrent v1 client. All DNS, tracker, DHT and peer I/O uses the supplied route."""
from __future__ import annotations

import base64
from bisect import bisect_right
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
import fnmatch
import hashlib
import http.client
import ipaddress
import os
from pathlib import Path
import re
import secrets
import select
import struct
import threading
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from direct_download import (OutputClaims, atomic_write, checksums, confined, extract_archive, extract_dest,
                             no_links, open_http, regular_file, safe_segment)

MAX_META = 16 * 1024**2
BLOCK = 16 * 1024
MAX_PEERS = 256
PROTOCOL = b'\x13BitTorrent protocol'
BOOTSTRAP = [('router.bittorrent.com', 6881), ('dht.transmissionbt.com', 6881), ('router.utorrent.com', 6881)]


def bencode(obj):
    if type(obj) is int:
        return b'i' + str(obj).encode() + b'e'
    if isinstance(obj, str):
        obj = obj.encode()
    if isinstance(obj, bytes):
        return str(len(obj)).encode() + b':' + obj
    if isinstance(obj, (list, tuple)):
        return b'l' + b''.join(map(bencode, obj)) + b'e'
    if isinstance(obj, dict):
        pairs = [(k.encode() if isinstance(k, str) else k, v) for k, v in obj.items()]
        if not all(isinstance(k, bytes) for k, _ in pairs) or len({k for k, _ in pairs}) != len(pairs):
            raise ValueError('Invalid bencode dictionary keys')
        return b'd' + b''.join(bencode(k) + bencode(v) for k, v in sorted(pairs)) + b'e'
    raise TypeError('Unsupported bencode type')


class _Decoder:
    def __init__(self, data):
        if len(data) > MAX_META:
            raise ValueError('Bencoded message too large')
        self.data, self.pos, self.items, self.span = data, 0, 0, None

    def item(self, depth=0):
        d, p = self.data, self.pos
        self.items += 1
        if p >= len(d) or depth > 64 or self.items > 250_000:
            raise ValueError('Invalid bencode size or nesting')
        c = d[p:p+1]
        self.pos += 1
        if c == b'i':
            end = d.find(b'e', p+1, p+23)
            if end < 0 or not re.fullmatch(rb'0|-?[1-9][0-9]*', d[p+1:end]):
                raise ValueError('Invalid bencoded integer')
            self.pos = end+1
            return int(d[p+1:end])
        if c.isdigit():
            colon = d.find(b':', p, p+12)
            if colon < 0 or not re.fullmatch(rb'0|[1-9][0-9]*', d[p:colon]):
                raise ValueError('Invalid byte string length')
            self.pos = colon+1+int(d[p:colon])
            if self.pos > len(d):
                raise ValueError('Truncated byte string')
            return d[colon+1:self.pos]
        if c not in (b'l', b'd'):
            raise ValueError('Invalid bencode token')
        out = [] if c == b'l' else {}
        while d[self.pos:self.pos+1] != b'e':
            if c == b'l':
                out.append(self.item(depth+1))
            else:
                key = self.item(depth+1)
                if not isinstance(key, bytes) or key in out:
                    raise ValueError('Duplicate or invalid dictionary key')
                start = self.pos
                out[key] = self.item(depth+1)
                if depth == 0 and key == b'info':
                    self.span = start, self.pos
        self.pos += 1
        return out


def bdecode_with_info_span(data):
    """Return (object, (start, exclusive_end) or None). Accept unsorted keys without normalizing the hash."""
    decoder = _Decoder(data)
    obj = decoder.item()
    if decoder.pos != len(data):
        raise ValueError('Trailing bencoded data')
    return obj, decoder.span


def bdecode(data):
    return bdecode_with_info_span(data)[0]


def text(v):
    if not isinstance(v, bytes):
        raise ValueError('Expected UTF-8 byte string')
    return v.decode('utf-8')


def integer(v, low, high):
    if type(v) is not int or not low <= v <= high:
        raise ValueError('Invalid integer in torrent message')
    return v


@dataclass(frozen=True)
class TorrentFile:
    parts: tuple[str, ...]
    offset: int
    length: int


@dataclass(frozen=True)
class Magnet:
    info_hash: bytes
    name: str
    trackers: tuple[str, ...]


def parse_magnet(uri):
    u = urlsplit(uri)
    if u.scheme != 'magnet' or len(uri) > 65536:
        raise ValueError('Invalid magnet link')
    keys, name, trackers = set(), '', []
    for k, v in parse_qsl(u.query, max_num_fields=256):
        if k == 'xt' and v.lower().startswith('urn:btih:'):
            digest = v[9:]
            if re.fullmatch('[a-fA-F0-9]{40}', digest):
                keys.add(bytes.fromhex(digest))
            elif re.fullmatch('[a-zA-Z2-7]{32}', digest):
                keys.add(base64.b32decode(digest.upper()))
            else:
                raise ValueError('Invalid magnet btih')
        elif k == 'tr':
            trackers.append(v)
        elif k == 'dn':
            name = v
    if len(keys) != 1:
        raise ValueError('Expected a single BitTorrent v1 info hash')
    return Magnet(keys.pop(), name, tuple(dict.fromkeys(trackers)))


@dataclass(frozen=True)
class Torrent:
    name: str
    info_hash: bytes
    files: tuple[TorrentFile, ...]
    total: int
    piece_length: int
    hashes: bytes
    tiers: tuple
    web_seeds: tuple
    private: bool

    @property
    def piece_count(self):
        return len(self.hashes)//20

    @property
    def trackers(self):
        return tuple(dict.fromkeys(url for tier in self.tiers for url in tier))

    def size(self, index):
        return min(self.piece_length, self.total - self.piece_length*index)

    def valid(self, index, data):
        return len(data) == self.size(index) and hashlib.sha1(data).digest() == self.hashes[20*index:20*index+20]

    def summary(self):
        return {'name': self.name, 'infoHash': self.info_hash.hex(), 'totalBytes': self.total,
                'pieceLength': self.piece_length, 'pieceCount': self.piece_count, 'trackers': list(self.trackers),
                'webSeeds': list(self.web_seeds), 'files': [{'index': i, 'path': '/'.join(f.parts), 'length': f.length}
                                                      for i, f in enumerate(self.files)]}


def regular_entry(v):
    return (isinstance(v, dict) and isinstance(v.get(b'attr', b''), bytes)
            and b'l' not in v.get(b'attr', b'') and b'symlink path' not in v)


def from_info(raw, tiers=(), seeds=()):
    info = bdecode(raw)
    if not regular_entry(info):
        raise ValueError('Invalid or unsupported torrent info')
    name = safe_segment(text(info.get(b'name')))
    length = integer(info.get(b'piece length'), 1, 32*1024**2)
    hashes = info.get(b'pieces')
    files, total = [], 0
    multi = b'files' in info
    entries = info.get(b'files', [info])
    if (multi == (b'length' in info) or not isinstance(entries, list) or not 1 <= len(entries) <= 100_000):
        raise ValueError('Invalid torrent file list')
    for entry in entries:
        if not regular_entry(entry):
            raise ValueError('Links are not supported')
        size = integer(entry.get(b'length'), 0, 2**63-1-total)
        segments = entry.get(b'path') if multi else []
        if not isinstance(segments, list) or len(segments) > 128 or multi and not segments:
            raise ValueError('Invalid torrent path')
        parts = (name, *(safe_segment(text(x)) for x in segments))
        files.append(TorrentFile(parts, total, size))
        total += size
    if not isinstance(hashes, bytes) or len(hashes) != 20*((total+length-1)//length):
        raise ValueError('Piece hash count does not match file sizes')
    OutputClaims().reserve(Path(*f.parts) for f in files)
    return Torrent(name, hashlib.sha1(raw).digest(), tuple(files), total, length, hashes, tuple(tiers), tuple(seeds), info.get(b'private') == 1)


def parse_torrent(source):
    if isinstance(source, bytes):
        raw = source
    else:
        with regular_file(Path(source), 'rb') as f:
            raw = f.read(MAX_META+1)
    obj, span = bdecode_with_info_span(raw)
    if not span or not isinstance(obj, dict):
        raise ValueError('Torrent does not contain info')
    tiers = []
    tier_list = obj.get(b'announce-list', [])
    if not isinstance(tier_list, list):
        raise ValueError('Invalid announce-list')
    for tier in tier_list:
        if not isinstance(tier, list):
            raise ValueError('Invalid tracker tier')
        if tier:
            tiers.append(tuple(text(v) for v in tier))
    if b'announce' in obj:
        url = text(obj[b'announce'])
        if not any(url in tier for tier in tiers):
            tiers.insert(0, (url,))
    seeds = obj.get(b'url-list', [])
    if isinstance(seeds, bytes):
        seeds = [seeds]
    if not isinstance(seeds, list):
        raise ValueError('Invalid web seed list')
    return from_info(raw[slice(*span)], tiers, [text(s) for s in seeds])


def compact(raw, width):
    if not isinstance(raw, bytes) or len(raw) % width:
        raise ValueError('Malformed compact address list')
    out = []
    for p in range(0, min(len(raw), width*MAX_PEERS), width):
        port = int.from_bytes(raw[p+width-2:p+width], 'big')
        ip = ipaddress.ip_address(raw[p:p+width-2])
        if port and not (ip.is_unspecified or ip.is_multicast):
            out.append((str(ip), port))
    return out


def http_tracker(url, digest, peer_id, left, route, resolver, timeout):
    u = urlsplit(url)
    q = urlencode(dict(info_hash=digest, peer_id=peer_id, port=6881, uploaded=0, downloaded=0,
                       left=left, compact=1, numwant=64, event='started'))
    url = urlunsplit((*u[:3], '&'.join(filter(None, (u.query, q))), ''))
    with open_http(url, route=route, resolver=resolver, timeout=timeout) as (r, _):
        if r.status != 200:
            raise OSError(f'Tracker HTTP {r.status}')
        raw = r.read(1024**2+1)
    if len(raw) > 1024**2:
        raise ValueError('Tracker response too large')
    obj = bdecode(raw)
    if not isinstance(obj, dict) or b'failure reason' in obj:
        raise ValueError('Tracker rejected announce')
    peers = obj.get(b'peers', b'')
    if isinstance(peers, list):
        result = [(text(p[b'ip']), integer(p[b'port'], 1, 65535)) for p in peers[:MAX_PEERS] if isinstance(p, dict) and b'ip' in p and b'port' in p]
    else:
        result = compact(peers, 6)
    return result + compact(obj.get(b'peers6', b''), 18)


def udp_tracker(url, digest, peer_id, left, route, resolver, timeout):
    u = urlsplit(url)
    if not u.hostname or not u.port or u.username is not None:
        raise ValueError('Invalid UDP tracker URL')
    for ip in resolver(u.hostname, u.port):
        try:
            with route.connect_udp(ip, u.port, timeout) as sock:
                def exchange(conn, action, payload):
                    tid = secrets.randbits(32)
                    sock.send(struct.pack('!QII', conn, action, tid) + payload)
                    data = sock.recv(65535)
                    if len(data) < 8 or struct.unpack_from('!II', data) != (action, tid):
                        raise ValueError('Invalid UDP tracker transaction')
                    return data[8:]
                raw = exchange(0x41727101980, 0, b'')
                if len(raw) != 8:
                    raise ValueError('Bad UDP connection ID')
                packet = digest + peer_id + struct.pack('!QQQIIIiH', 0, left, 0, 2, 0, secrets.randbits(32), 64, 6881)
                reply = exchange(int.from_bytes(raw, 'big'), 1, packet)
                if len(reply) < 12:
                    raise ValueError('Truncated UDP announce')
                return compact(reply[12:], 6 if ipaddress.ip_address(ip).version == 4 else 18)
        except OSError:
            continue
    raise OSError('UDP tracker unreachable')


def dht_peers(digest, bootstrap, route, resolver, timeout=3., limit=32):
    """Read-only iterative get_peers. Query closest returned node IDs first, with fixed budgets."""
    pending = [(2**160, host, port) for host, port in bootstrap]
    visited, peers = set(), set()
    node_id = secrets.token_bytes(20)
    target = int.from_bytes(digest, 'big')
    deadline = time.monotonic() + min(12, timeout*4)
    while pending and len(visited) < 32 and len(peers) < limit and time.monotonic() < deadline:
        pending.sort(reverse=True)
        _, host, port = pending.pop()
        if (host, port) in visited:
            continue
        visited.add((host, port))
        try:
            for ip in resolver(host, port):
                tid = secrets.token_bytes(4)
                try:
                    with route.connect_udp(ip, port, min(timeout, 2)) as sock:
                        sock.send(bencode({b't': tid, b'y': b'q', b'q': b'get_peers', b'a': {b'id': node_id, b'info_hash': digest}}))
                        msg = bdecode(sock.recv(65535))
                except OSError:
                    continue
                if not isinstance(msg, dict) or msg.get(b't') != tid or msg.get(b'y') != b'r' or not isinstance(msg.get(b'r'), dict):
                    break
                reply = msg[b'r']
                values = reply.get(b'values', [])
                if isinstance(values, list):
                    for value in values[:MAX_PEERS]:
                        if isinstance(value, bytes) and len(value) in (6, 18):
                            peers.update(compact(value, len(value)))
                for key, width in [(b'nodes', 26), (b'nodes6', 38)]:
                    nodes = reply.get(key, b'')
                    if not isinstance(nodes, bytes) or len(nodes) % width:
                        continue
                    for pos in range(0, min(len(nodes), 16*width), width):
                        distance = target ^ int.from_bytes(nodes[pos:pos+20], 'big')
                        for h, p in compact(nodes[pos+20:pos+width], width-20):
                            pending.append((distance, h, p))
                break
        except (ValueError, OSError):
            continue
    return sorted(peers)[:MAX_PEERS]


def discover(tiers, digest, peer_id, left, route, resolver, timeout, bootstrap, max_peers):
    peers, tried = {}, set()
    for tier in tiers:
        for url in tier:
            if url in tried or len(tried) >= 32:
                continue
            tried.add(url)
            try:
                scheme = urlsplit(url).scheme
                if scheme not in ('http', 'https', 'udp'):
                    continue
                ask = udp_tracker if scheme == 'udp' else http_tracker
                found = ask(url, digest, peer_id, left, route, resolver, timeout)
                peers.update(dict.fromkeys(found))
                if found:
                    break
            except (ValueError, OSError, http.client.HTTPException):
                continue
        if len(peers) >= MAX_PEERS:
            break
    if bootstrap and len(peers) < min(max_peers, 4):
        peers.update(dict.fromkeys(dht_peers(digest, bootstrap, route, resolver, timeout, max_peers)))
    return list(peers)[:MAX_PEERS]


def exact(sock, n, deadline, stop):
    buf = bytearray()
    while len(buf) < n:
        left = deadline - time.monotonic()
        if stop.is_set() or left <= 0:
            raise TimeoutError('Peer stopped or timed out')
        sock.settimeout(min(left, .5))
        try:
            chunk = sock.recv(n-len(buf))
        except TimeoutError:
            continue
        if not chunk:
            raise EOFError('Peer disconnected')
        buf.extend(chunk)
    return bytes(buf)


class Peer:
    def __init__(self, sock, extended, timeout, stop, count):
        self.sock, self.extended, self.timeout, self.stop = sock, extended, timeout, stop
        self.count, self.bits, self.choked = count, None, True

    def send(self, kind, payload=b''):
        self.sock.sendall(struct.pack('!IB', len(payload)+1, kind) + payload)

    def message(self, deadline):
        n, = struct.unpack('!I', exact(self.sock, 4, deadline, self.stop))
        if n > max(65536, (self.count+7)//8+1, (MAX_META//20+7)//8+1 if not self.count else 0):
            raise ValueError('Oversized peer frame')
        raw = exact(self.sock, n, deadline, self.stop)
        if not raw:
            return -1, b''
        kind, payload = raw[0], raw[1:]
        if kind in (0, 1):
            if payload:
                raise ValueError('Invalid choke message')
            self.choked = kind == 0
        elif kind == 5 and self.count:
            if len(payload) != (self.count+7)//8:
                raise ValueError('Invalid bitfield size')
            self.bits = bytearray(payload)
        elif kind == 4 and self.count:
            if len(payload) != 4:
                raise ValueError('Invalid have message')
            i, = struct.unpack('!I', payload)
            if i >= self.count:
                raise ValueError('Invalid piece index')
            if self.bits is None:
                self.bits = bytearray((self.count+7)//8)
            self.bits[i//8] |= 128 >> (i%8)
        return kind, payload

    def has(self, i):
        return self.bits is None or self.bits[i//8] & (128 >> (i%8))

    def metadata(self, digest, limiter):
        if not self.extended:
            raise ValueError('Peer has no extension protocol')
        self.send(20, b'\0' + bencode({b'm': {b'ut_metadata': 1}}))
        deadline = time.monotonic() + self.timeout
        while True:
            kind, payload = self.message(deadline)
            if kind != 20 or payload[:1] != b'\0':
                continue
            msg = bdecode(payload[1:])
            if not isinstance(msg, dict) or not isinstance(msg.get(b'm'), dict):
                raise ValueError('Bad extension handshake')
            remote = integer(msg[b'm'].get(b'ut_metadata'), 1, 255)
            size = integer(msg.get(b'metadata_size'), 1, MAX_META)
            break
        raw = bytearray(size)
        # Each side assigns its own extension IDs. Requests use theirs, replies use ours (1).
        for i in range((size+BLOCK-1)//BLOCK):
            self.send(20, bytes([remote]) + bencode({b'msg_type': 0, b'piece': i}))
            deadline = time.monotonic()+self.timeout
            while True:
                kind, payload = self.message(deadline)
                if kind != 20 or payload[:1] != b'\1':
                    continue
                decoder = _Decoder(payload[1:])
                header = decoder.item()
                if not isinstance(header, dict) or (header.get(b'msg_type'), header.get(b'piece'), header.get(b'total_size')) != (1, i, size):
                    raise ValueError('Rejected or invalid metadata piece')
                block = payload[1+decoder.pos:]
                if len(block) != min(BLOCK, size-i*BLOCK):
                    raise ValueError('Wrong metadata block size')
                if limiter:
                    limiter.consume(len(block))
                raw[i*BLOCK:i*BLOCK+len(block)] = block
                break
        if hashlib.sha1(raw).digest() != digest:
            raise ValueError('Magnet metadata hash mismatch')
        return bytes(raw)

    def piece(self, i, size, limiter):
        buf = bytearray(size)
        todo = deque(range(0, size, BLOCK))
        pending = {}
        deadline = time.monotonic()+self.timeout
        while todo or pending:
            while not self.choked and todo and len(pending) < 8:
                offset = todo.popleft()
                pending[offset] = min(BLOCK, size-offset)
                self.send(6, struct.pack('!III', i, offset, pending[offset]))
            kind, payload = self.message(deadline)
            if kind == 0:
                todo.extendleft(pending)
                pending.clear()
            elif kind == 7:
                if len(payload) < 8:
                    raise ValueError('Truncated piece message')
                index, offset = struct.unpack_from('!II', payload)
                if index != i or offset not in pending:
                    continue  # Stale block following a choke/cancel.
                block = payload[8:]
                if len(block) != pending.pop(offset):
                    raise ValueError('Incorrect block length')
                if limiter:
                    limiter.consume(len(block))
                buf[offset:offset+len(block)] = block
                deadline = time.monotonic()+self.timeout
        return buf


@contextmanager
def connect_peer(addr, digest, peer_id, route, resolver, timeout, stop, count=0):
    host, port = addr
    deadline = time.monotonic()+timeout
    for ip in resolver(host, port):
        remaining = deadline-time.monotonic()
        if stop.is_set() or remaining <= 0:
            break
        try:
            sock = route.connect(ip, port, remaining)
        except OSError:
            continue
        with sock:
            sock.sendall(PROTOCOL + b'\0\0\0\0\0\x10\0\0' + digest + peer_id)
            hello = exact(sock, 68, deadline, stop)
            if hello[:20] != PROTOCOL or hello[28:48] != digest or hello[48:] == peer_id:
                raise ValueError('Invalid BitTorrent handshake')
            yield Peer(sock, bool(hello[25] & 16), timeout, stop, count)
        return
    raise OSError('Could not connect to peer on the selected route')


_PEER_ERRORS = (ValueError, OSError, EOFError)


def fetch_metadata(addresses, digest, peer_id, route, resolver, timeout, max_peers, limiter):
    stop = threading.Event()
    def fetch(addr):
        if not stop.is_set():
            with connect_peer(addr, digest, peer_id, route, resolver, timeout, stop) as peer:
                return peer.metadata(digest, limiter)
    with ThreadPoolExecutor(max_workers=max_peers) as pool:
        futures = [pool.submit(fetch, addr) for addr in addresses]
        try:
            for future in as_completed(futures):
                try:
                    return future.result()
                except _PEER_ERRORS:
                    continue
        finally:
            stop.set()
            for f in futures:
                f.cancel()
    raise OSError('No peer supplied verified magnet metadata')


def select_files(meta, selection):
    if selection is None:
        return set(range(len(meta.files)))
    selected = set()
    for token in selection.split(','):
        token = token.strip()
        if token.isdecimal():
            hits = {integer(int(token), 0, len(meta.files)-1)}
        else:
            hits = {i for i, f in enumerate(meta.files) if any(fnmatch.fnmatchcase(p, token) for p in
                    ('/'.join(f.parts), '/'.join(f.parts[1:]), f.parts[-1]))} if token else set()
        if not hits:
            raise ValueError('File selection matched no files')
        selected.update(hits)
    return selected


class PieceStore:
    def __init__(self, meta, root, cache, selected):
        self.meta, self.cache, self.selected = meta, cache, selected
        self.paths = [confined(root, *f.parts) for f in meta.files]
        self.ends = [f.offset+f.length for f in meta.files]
        self.wanted = set()
        for n in selected:
            f = meta.files[n]
            if f.length:
                self.wanted.update(range(f.offset//meta.piece_length, (f.offset+f.length-1)//meta.piece_length+1))

    def segments(self, i):
        start = i*self.meta.piece_length
        end = start+self.meta.size(i)
        n = bisect_right(self.ends, start)
        while n < len(self.ends):
            f = self.meta.files[n]
            if f.offset >= end:
                break
            first, last = max(start, f.offset), min(end, self.ends[n])
            if last > first:
                yield n, first-f.offset, first-start, last-first
            n += 1

    def prepare(self):
        for n in self.selected:
            path = self.paths[n]
            no_links(path.parent).mkdir(parents=True, exist_ok=True)
            if not path.exists():
                regular_file(path, 'xb').close()
            else:
                regular_file(path, 'r+b').close()  # Check for hard links before any transfer.

    def read(self, i):
        result = bytearray(self.meta.size(i))
        for n, offset, begin, size in self.segments(i):
            path = self.paths[n]
            if n not in self.selected:
                side = confined(self.cache, f'boundary-{i}')
                if side.is_file():
                    path, offset = side, begin
            try:
                with regular_file(path, 'rb') as f:
                    f.seek(offset)
                    block = f.read(size)
            except FileNotFoundError:
                return None
            if len(block) != size:
                return None
            result[begin:begin+size] = block
        return result

    def commit(self, i, data):
        # Caller has verified the complete piece. Each worker owns its file handles/cursors.
        boundary = False
        for n, offset, begin, size in self.segments(i):
            if n not in self.selected:
                boundary = True
                continue
            with regular_file(self.paths[n], 'r+b') as f:
                f.seek(offset)
                f.write(memoryview(data)[begin:begin+size])
        if boundary:
            self.cache.mkdir(exist_ok=True)
            atomic_write(confined(self.cache, f'boundary-{i}'), data)

    def verified(self):
        done = set()
        for i in self.wanted:
            data = self.read(i)
            if data is not None and self.meta.valid(i, data):
                done.add(i)
        return done


class Work:
    def __init__(self, indices):
        self.pending = deque(sorted(indices))
        self.active = set()
        self.cv = threading.Condition()
        self.stop = threading.Event()

    def claim(self, peer):
        with self.cv:
            while not self.pending and self.active and not self.stop.is_set():
                self.cv.wait(.25)
            for _ in range(len(self.pending)):
                i = self.pending.popleft()
                if peer.has(i):
                    self.active.add(i)
                    return i
                self.pending.append(i)
        return None

    def finish(self, i, ok):
        with self.cv:
            self.active.remove(i)
            if not ok:
                self.pending.append(i)
            if not self.pending and not self.active:
                self.stop.set()
            self.cv.notify_all()


def transfer_pieces(store, missing, addresses, peer_id, route, resolver, timeout, max_peers, retries, limiter, progress):
    if not addresses:
        raise OSError('No peers found for missing pieces')
    work = Work(missing)
    meta = store.meta
    total = sum(meta.size(i) for i in store.wanted)
    done = total - sum(meta.size(i) for i in missing)
    def worker(addr):
        nonlocal done
        if work.stop.is_set():
            return
        try:
            with connect_peer(addr, meta.info_hash, peer_id, route, resolver, timeout, work.stop, meta.piece_count) as peer:
                peer.send(2)  # interested
                deadline = time.monotonic()+timeout
                while not work.stop.is_set():
                    i = work.claim(peer) if not peer.choked else None
                    if i is None:
                        # An in-flight piece may be returned by another peer without a new HAVE.
                        if peer.choked or time.monotonic() >= deadline or select.select([peer.sock], [], [], .1)[0]:
                            peer.message(deadline)
                        continue
                    ok = False
                    try:
                        buf = peer.piece(i, meta.size(i), limiter)
                        if not meta.valid(i, buf):
                            raise ValueError('Peer supplied a corrupt piece')
                        try:
                            store.commit(i, buf)
                        except (OSError, ValueError) as e:
                            raise RuntimeError('Could not commit verified piece') from e
                        ok = True
                        if progress:
                            with work.cv:
                                done += len(buf)
                                progress(meta.name, done, total)
                    finally:
                        work.finish(i, ok)
                    deadline = time.monotonic()+timeout
        except _PEER_ERRORS:
            return  # Its uncommitted piece is available to another worker.
    # Each worker buffers one whole piece for SHA-1, so large-piece torrents use fewer workers.
    workers = min(max_peers, max(1, 128*1024**2 // meta.piece_length))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        try:
            for _ in range(retries+1):
                for f in as_completed([pool.submit(worker, addr) for addr in addresses]):
                    f.result()
                if not work.pending:
                    return
        finally:
            work.stop.set()
    raise OSError(f'Could not verify {len(work.pending)} remaining piece(s)')


def seed(store, addresses, peer_id, route, resolver, timeout, max_peers, seconds, limiter):
    """Offer verified pieces on outbound connections only; never open an unbound listener."""
    deadline = time.monotonic()+seconds
    meta = store.meta
    bits = bytearray((meta.piece_count+7)//8)
    for i in store.wanted:
        bits[i//8] |= 128 >> (i%8)
    stop = threading.Event()
    def upload(addr):
        left = deadline-time.monotonic()
        if left <= 0:
            return
        try:
            with connect_peer(addr, meta.info_hash, peer_id, route, resolver, min(timeout, left), stop, meta.piece_count) as peer:
                peer.send(5, bits)
                peer.send(1)
                cached, data = None, None
                while time.monotonic() < deadline:
                    kind, payload = peer.message(deadline)
                    if kind != 6 or len(payload) != 12:
                        continue
                    i, offset, n = struct.unpack('!III', payload)
                    if i not in store.wanted or not 0 < n <= BLOCK or offset+n > meta.size(i):
                        raise ValueError('Invalid block request')
                    if cached != i:
                        data = store.read(i)
                        if data is None or not meta.valid(i, data):
                            return
                        cached = i
                    if limiter:
                        limiter.consume(n)
                    peer.send(7, struct.pack('!II', i, offset) + data[offset:offset+n])
        except _PEER_ERRORS:
            return
    with ThreadPoolExecutor(max_workers=max_peers) as pool:
        while addresses and time.monotonic() < deadline:
            list(pool.map(upload, addresses))
            stop.wait(min(1., max(0., deadline-time.monotonic())))


def download_torrent(source, root, route, resolver, *, info_only=False, select=None, no_dht=False, bootstrap=None,
                     max_peers=24, seed_time=0., timeout=20., retries=5, resume=True, rate_limiter=None,
                     claims=None, report_hash=True, sha256=None, md5=None, progress=None, extract=False):
    peer_id = b'-PS1100-' + secrets.token_bytes(12)
    bootstrap = [] if no_dht else BOOTSTRAP if bootstrap is None else bootstrap
    is_magnet = isinstance(source, str) and source.lower().startswith('magnet:')
    parsed = parse_magnet(source) if is_magnet else parse_torrent(source)
    claims = claims or OutputClaims()
    cache = confined(root, '.phuket-bt-'+parsed.info_hash.hex())
    if not info_only:
        claims.reserve([cache])
    addresses, raw = [], None
    if is_magnet:
        tiers = [(url,) for url in parsed.trackers]
        metadata_path = confined(cache, 'info')
        if metadata_path.is_file():
            with regular_file(metadata_path, 'rb') as f:
                cached = f.read(MAX_META+1)
            if len(cached) <= MAX_META and hashlib.sha1(cached).digest() == parsed.info_hash:
                raw = cached
        if raw is None:
            addresses = discover(tiers, parsed.info_hash, peer_id, 1, route, resolver, timeout, bootstrap, max_peers)
            raw = fetch_metadata(addresses, parsed.info_hash, peer_id, route, resolver, timeout, max_peers, rate_limiter)
        meta = from_info(raw, tiers)
    else:
        meta = parsed
    if info_only:
        return {'ok': True, **meta.summary()}
    selected = select_files(meta, select)
    if (md5 or sha256) and len(selected) != 1:
        raise ValueError('A whole-file checksum needs exactly one selected file')
    store = PieceStore(meta, root, cache, selected)
    claims.reserve(store.paths[n] for n in selected)
    if extract:
        claims.reserve(extract_dest(store.paths[n]) for n in selected)
    store.prepare()
    if is_magnet:
        cache.mkdir(exist_ok=True)
        atomic_write(metadata_path, raw)
    verified = store.verified() if resume else set()
    missing = store.wanted - verified
    if (missing or seed_time) and not addresses:
        left = meta.total - sum(meta.size(i) for i in verified)
        addresses = discover(meta.tiers, meta.info_hash, peer_id, left, route, resolver, timeout,
                             [] if meta.private else bootstrap, max_peers)
    if missing:
        transfer_pieces(store, missing, addresses, peer_id, route, resolver, timeout, max_peers, retries, rate_limiter, progress)
    files = []
    for i in sorted(selected):
        target, length = store.paths[i], meta.files[i].length
        with regular_file(target, 'r+b') as f:
            f.truncate(length)
        files.append({'path': str(target), 'bytes': length, **checksums(target, sha256=sha256, md5=md5, report=report_hash)})
    if extract:
        for f in files:
            f['extractedTo'] = str(extract_archive(Path(f['path'])))
    if seed_time:
        seed(store, addresses, peer_id, route, resolver, timeout, max_peers, seed_time, rate_limiter)
    return {'ok': True, 'infoHash': meta.info_hash.hex(), 'files': files, 'reusedPieces': len(verified),
            'downloadedPieces': len(missing)}
