"""BitTorrent v1 wire tests. All trackers, peers and bootstrap nodes bind IPv4 loopback."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import os
from pathlib import Path
import socketserver
import struct
import sys
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit

import direct_torrent as bt
from direct_dns import Resolver
from direct_net import DirectRoute
from test_direct_download import LocalCLI


BLOCK = 16384
PL = 8*BLOCK + 53
LENGTHS = (PL + 71, PL - 71 + 15, PL - 15 + 1123)
PAYLOAD = (bytes(range(251)) * (sum(LENGTHS)//251+1))[:sum(LENGTHS)]
NAMES = ('one.bin', 'dir/two.dat', 'three.bin')
HASHES = b''.join(hashlib.sha1(PAYLOAD[i:i+PL]).digest() for i in range(0, len(PAYLOAD), PL))
INFO = {b'name': b'collection', b'piece length': PL, b'pieces': HASHES,
        b'files': [{b'length': n, b'path': name.encode().split(b'/')} for n, name in zip(LENGTHS, NAMES)],
        b'comment': b'm'*17000}  # Metadata spans two BEP 9 blocks.
RAW_INFO = bt.bencode(INFO)
DIGEST = hashlib.sha1(RAW_INFO).digest()
PROTOCOL = b'\x13BitTorrent protocol'
HOST = '127.0.0.1'


def addr(port):
    return b'\x7f\0\0\1'+struct.pack('!H', port)


class CodecTests(unittest.TestCase):
    def test_bencode_roundtrip_rejects_ambiguous_or_truncated_values(self):
        obj = {b'\0': b'\xff', b'a': [0, -9, 123, {}, b''], b'empty': []}
        self.assertEqual(bt.bdecode(bt.bencode(obj)), obj)
        for bad in (b'i03e', b'i-0e', b'3:xy', b'l', b'd1:ai1e1:ai2ee', b'le0:', b'l'*80+b'e'*80):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                bt.bdecode(bad)

    def test_exact_unsorted_info_span_single_file_trackers_and_web_seeds(self):
        info = b'd4:name5:a.bin6:lengthi1e12:piece lengthi4e6:pieces20:'+hashlib.sha1(b'Z').digest()+b'e'
        primary, alt = b'http://127.0.0.1:1/a', b'udp://127.0.0.1:2/a'
        top = b'd4:info'+info+b'8:announce'+bt.bencode(primary)+b'13:announce-list'+bt.bencode([[alt],[primary]])+b'8:url-list7:/mirror' + b'e'
        obj, span = bt.bdecode_with_info_span(top)
        self.assertEqual(top[slice(*span)], info)
        self.assertNotEqual(info, bt.bencode(obj[b'info']))
        meta = bt.parse_torrent(top)
        self.assertEqual(meta.info_hash, hashlib.sha1(info).digest())
        self.assertEqual((meta.name, meta.total, meta.tiers, meta.web_seeds),
                         ('a.bin', 1, ((alt.decode(),), (primary.decode(),)), ('/mirror',)))
        self.assertEqual(meta.files[0].parts, ('a.bin',))

    def test_hex_and_base32_magnets(self):
        for xt in (DIGEST.hex().upper(), base64.b32encode(DIGEST).decode().lower()):
            query = urlencode([('dn', 'sample name'), ('xt', 'urn:btih:'+xt), ('tr', 'http://127.0.0.1:1'), ('tr', 'udp://127.0.0.1:2')])
            m = bt.parse_magnet('magnet:?'+query)
            self.assertEqual((m.info_hash, m.name, m.trackers), (DIGEST, 'sample name', ('http://127.0.0.1:1', 'udp://127.0.0.1:2')))
        for xt in ('urn:btih:123', 'urn:btmh:abc', 'urn:btih:'+'0'*32):
            with self.assertRaises(ValueError):
                bt.parse_magnet('magnet:?xt='+xt)

    def test_unsafe_paths_links_file_directory_and_case_collisions(self):
        def encode(names):
            return bt.bencode({b'info': {b'name': b'root', b'piece length': 128, b'pieces': b'',
                              b'files': [{b'length': 0, b'path': p} for p in names]}})
        for p in (b'../escape.txt', b'/absolute', b'C:', b'C:relative', b'\\a', b'one/two', b'.', b'..', b'con.txt',
                  b'LPT2', b'NUL', b'aux .bin', b'a\0b', b'X\n', b' space.', b''):
            with self.subTest(path=p), self.assertRaises(ValueError):
                bt.parse_torrent(encode([[p]]))
        for paths in ([[]], [[b'a'], [b'A']], [[b'a'], [b'a', b'child']]):
            with self.assertRaises(ValueError):
                bt.parse_torrent(encode(paths))
        for changes in ({b'attr': b'l'}, {b'symlink path': [b'outside']}, {b'pieces': b'invalid'}, {b'name': b'../x'}):
            with self.assertRaises(ValueError):
                bt.from_info(bt.bencode({**INFO, **changes}))

    def test_compact_ipv4_and_ipv6(self):
        self.assertEqual(bt.compact(addr(6881), 6), [(HOST, 6881)])
        raw6 = ipaddress.IPv6Address('::1').packed + b'\x00\x50'
        self.assertEqual(bt.compact(raw6, 18), [('::1', 80)])
        with self.assertRaises(ValueError):
            bt.compact(raw6[1:], 18)


class Seeder(socketserver.StreamRequestHandler):
    def send(self, kind, payload=b''):
        self.request.sendall(struct.pack('!IB', 1+len(payload), kind)+payload)

    def handle(self):
        try:
            self.stream()
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass

    def stream(self):
        s = self.server
        self.request.settimeout(5)
        hello = self.rfile.read(68)
        assert len(hello) == 68 and hello[:20] == PROTOCOL and hello[25] & 16
        assert hello[28:48] == DIGEST and hello[48:56] == b'-PS1100-'
        s.ids.append(hello[48:])
        self.request.sendall(PROTOCOL + b'\0\0\0\0\0\x10\0\0'+DIGEST+b'fixture-peer'.ljust(20, b'0'))
        self.send(5, bytes([sum(128 >> i for i in s.pieces if i != s.have)]))
        if s.have is not None:
            self.send(4, struct.pack('!I', s.have))
        ours, interested = None, False
        pending, sent = [], {}
        while header := self.rfile.read(4):
            n, = struct.unpack('!I', header)
            assert 0 < n <= 65536
            frame = self.rfile.read(n)
            assert len(frame) == n
            kind, raw = frame[0], frame[1:]
            if kind == 20 and raw[0] == 0:
                ours = bt.bdecode(raw[1:])[b'm'][b'ut_metadata']
                self.send(20, b'\0'+bt.bencode({b'm': {b'ut_metadata': 7}, b'metadata_size': len(RAW_INFO)}))
            elif kind == 20:
                assert raw[0] == 7
                req = bt.bdecode(raw[1:])
                assert req[b'msg_type'] == 0
                i = req[b'piece']
                s.metadata.append(i)
                block = RAW_INFO[i*BLOCK:(i+1)*BLOCK]
                if s.bad_metadata and i == 0:
                    block = bytes([block[0]^1])+block[1:]
                self.send(20, bytes([ours])+bt.bencode({b'msg_type': 1, b'piece': i, b'total_size': len(RAW_INFO)})+block)
            elif kind == 2:
                interested = True
                self.send(1)
            elif kind == 6:
                i, offset, size = struct.unpack('!III', raw)
                end = min(PL, len(PAYLOAD)-i*PL)
                assert interested and i in s.pieces and offset % BLOCK == 0 and size == min(BLOCK, end-offset)
                s.requests.append((i, offset, size))
                block = PAYLOAD[i*PL+offset:i*PL+offset+size]
                if i in s.bad_pieces and not offset:
                    block = bytes([block[0]^1])+block[1:]
                    if s.bad_once:
                        s.bad_pieces.remove(i)
                pending.append(struct.pack('!II', i, offset)+block)
                # Hold each window until all requests arrive; deliver the blocks in reverse order.
                if len(pending) == min(8, (end+BLOCK-1)//BLOCK-sent.get(i, 0)):
                    s.windows.append(len(pending))
                    sent[i] = sent.get(i, 0)+len(pending)
                    for msg in reversed(pending):
                        self.send(7, msg)
                    pending.clear()
            elif kind == 5:  # Client offered verified data during its explicit seed interval.
                assert raw[0] & 128
                self.send(2)
            elif kind == 1:
                self.send(6, struct.pack('!III', 0, 0, BLOCK))
            elif kind == 7:
                assert raw == struct.pack('!II', 0, 0) + PAYLOAD[:BLOCK]
                s.uploads.append(raw[8:])
                return


class HttpTracker(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        s = self.server
        q = parse_qs(urlsplit(self.path).query, encoding='latin1')
        assert q['info_hash'][0].encode('latin1') == DIGEST
        assert len(q['peer_id'][0]) == 20 and q['compact'] == ['1']
        s.announces.append((q['peer_id'][0].encode('latin1'), int(q['left'][0])))
        peers = ([{b'ip': HOST.encode(), b'port': p} for p in s.ports] if s.dictionary
                 else b''.join(addr(p) for p in s.ports))
        raw = bt.bencode({b'interval': 30, b'peers': peers, b'peers6': s.extra6})
        self.send_response(200)
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class UdpTracker(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        conn, action, tid = struct.unpack_from('!QII', data)
        self.server.actions.append(action)
        if action == 0:
            assert len(data) == 16 and conn == 0x41727101980
            reply = struct.pack('!Q', 123456)
        else:
            assert len(data) == 98 and action == 1 and conn == 123456
            assert data[16:36] == DIGEST and data[36:44] == b'-PS1100-'
            reply = struct.pack('!III', 30, 0, 1)+b''.join(addr(p) for p in self.server.ports)
        sock.sendto(struct.pack('!II', action, tid)+reply, self.client_address)


class DhtNode(socketserver.BaseRequestHandler):
    def handle(self):
        data, sock = self.request
        msg = bt.bdecode(data)
        assert msg[b'y'] == b'q' and msg[b'q'] == b'get_peers' and msg[b'a'][b'info_hash'] == DIGEST
        self.server.queries.append(msg[b'a'][b'id'])
        raw = bt.bencode({b't': msg[b't'], b'y': b'r', b'r': {b'id': b'Q'*20, **self.server.response}})
        sock.sendto(raw, self.client_address)


class LiveTorrentTests(LocalCLI, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.errors = []
        self.addCleanup(self.assertEqual, self.errors, [])
        self.peer = self.seeder()
        self.tracker = self.server(ThreadingHTTPServer, HttpTracker)
        self.tracker.ports = [self.peer.server_address[1]]
        self.tracker.dictionary, self.tracker.extra6, self.tracker.announces = False, b'', []
        self.url = 'http://%s:%d/announce?key=fixture' % self.tracker.server_address
        self.torrent = self.tmp/'fixture.torrent'
        self.torrent.write_bytes(bt.bencode({b'announce': self.url, b'info': INFO}))
        self.magnet = 'magnet:?'+urlencode(dict(xt='urn:btih:'+DIGEST.hex(), tr=self.url))

    def server(self, cls, handler):
        s = cls((HOST, 0), handler)
        s.daemon_threads = True
        s.handle_error = lambda *args: self.errors.append(repr(sys.exc_info()[1]))
        self.serve(s)
        return s

    def seeder(self):
        s = self.server(socketserver.ThreadingTCPServer, Seeder)
        s.pieces, s.have, s.bad_pieces, s.bad_once = set(range(4)), None, set(), False
        s.ids, s.metadata, s.requests, s.windows, s.uploads = [], [], [], [], []
        s.bad_metadata = False
        return s

    def get(self, *opts, source=None, ok=True):
        return self.cli('--no-dht', '--retries', '0', *opts, source or self.torrent, ok=ok)

    def paths(self):
        return [self.out/'collection'/n for n in NAMES]

    def assert_content(self, result):
        self.assertEqual(b''.join(p.read_bytes() for p in self.paths()), PAYLOAD)
        self.assertEqual(result['infoHash'], DIGEST.hex())
        for f, path, length in zip(result['files'], self.paths(), LENGTHS):
            self.assertEqual((Path(f['path']), f['bytes'], f['sha256']), (path, length, hashlib.sha256(path.read_bytes()).hexdigest()))

    def test_info_http_tracker_download_then_rehash_deleted_and_zeroed_files(self):
        r = self.get('--bt-info')
        self.assertEqual((r['name'], r['totalBytes'], r['pieceLength'], r['pieceCount'], r['infoHash']),
                         ('collection', len(PAYLOAD), PL, 4, DIGEST.hex()))
        self.assertEqual([f['length'] for f in r['files']], list(LENGTHS))
        self.assertEqual(r['trackers'], [self.url])
        self.assertFalse(self.out.exists())
        self.assertFalse(self.tracker.announces)
        self.assert_content(self.get())
        self.assertIn(8, self.peer.windows)
        self.assertEqual(self.tracker.announces, [(self.peer.ids[0], len(PAYLOAD))])
        self.assertFalse(self.peer.uploads)
        paths = self.paths()
        for idx, expected in [(1, {1, 2}), (0, {0, 1})]:
            if idx == 1:
                paths[idx].unlink()
            else:
                paths[idx].write_bytes(bytes(LENGTHS[idx]))
            self.peer.requests.clear()
            r = self.get()
            self.assert_content(r)
            self.assertEqual(r['reusedPieces'], 4-len(expected))
            self.assertEqual({i for i, _, _ in self.peer.requests}, expected)
        announces = len(self.tracker.announces)
        self.assertEqual(self.get()['downloadedPieces'], 0)
        self.assertEqual(len(self.tracker.announces), announces)

    def test_udp_tracker_and_multiple_peers_with_disjoint_pieces(self):
        second = self.seeder()
        self.peer.pieces, self.peer.have, second.pieces = {0, 2}, 2, {1, 3}
        tracker = self.server(socketserver.UDPServer, UdpTracker)
        tracker.ports, tracker.actions = [self.peer.server_address[1], second.server_address[1]], []
        self.torrent.write_bytes(bt.bencode({b'info': INFO, b'announce-list': [[f'udp://{HOST}:{tracker.server_address[1]}/announce']]}))
        self.assert_content(self.get('--max-peers', '2'))
        self.assertEqual(tracker.actions, [0, 1])
        for peer in [self.peer, second]:
            self.assertEqual({i for i, _, _ in peer.requests}, peer.pieces)
        self.assertEqual(self.peer.ids, second.ids)

    def test_magnet_only_two_metadata_blocks_then_payload_and_verified_cache(self):
        self.torrent.unlink()
        self.tracker.dictionary = True
        self.assert_content(self.get(source=self.magnet))
        self.assertEqual(self.peer.metadata, [0, 1])
        self.assertTrue(self.peer.requests)
        self.assertEqual(len(self.tracker.announces), 1)
        # Cached metadata alone cannot claim an on-disk piece is present.
        self.peer.requests.clear()
        self.paths()[2].unlink()
        self.assert_content(self.get(source=self.magnet))
        self.assertEqual({i for i, _, _ in self.peer.requests}, {2, 3})
        self.assertEqual(self.peer.metadata, [0, 1])

    def test_invalid_magnet_metadata_never_downloads_or_creates_payload(self):
        self.peer.bad_metadata = True
        self.get('--bt-info', source=self.magnet, ok=False)
        self.assertEqual(self.peer.metadata, [0, 1])
        self.assertFalse(self.peer.requests)
        self.assertFalse(self.out.exists())
        self.peer.bad_metadata = False
        self.assertEqual(self.get('--bt-info', source=self.magnet)['infoHash'], DIGEST.hex())
        self.assertFalse(self.peer.requests)
        self.assertFalse(self.out.exists())

    def test_select_verifies_unselected_bytes_in_shared_pieces_before_writing(self):
        one, two, three = self.paths()
        two.parent.mkdir(parents=True)
        marker = b'?'*LENGTHS[1]
        two.write_bytes(marker)
        # First byte of piece 1 is in unselected file 0. The selected slice must not be committed.
        self.peer.bad_pieces = {1}
        self.get('--overwrite', '--bt-select', '1', ok=False)
        self.assertTrue(self.peer.requests)  # The corrupt data was rejected, not a preflight collision.
        self.assertEqual(two.read_bytes(), marker)
        self.assertFalse(one.exists() or three.exists())
        self.peer.requests.clear()
        self.peer.bad_pieces.clear()
        r = self.get('--bt-select', 'dir/*.dat')
        self.assertEqual(two.read_bytes(), PAYLOAD[LENGTHS[0]:sum(LENGTHS[:2])])
        self.assertEqual(len(r['files']), 1)
        self.assertEqual({i for i, _, _ in self.peer.requests}, {1, 2})
        self.assertFalse(one.exists() or three.exists())
        self.peer.requests.clear()
        self.assertEqual(self.get('--bt-select', '1')['reusedPieces'], 2)
        self.assertFalse(self.peer.requests)

    def test_unowned_or_mismatched_selected_files_require_overwrite(self):
        one, two, three = self.paths()
        two.parent.mkdir(parents=True)
        two.write_bytes(b'keep unrelated file')
        self.assertIn('overwrite', self.get(ok=False)['error'])
        self.assertFalse(one.exists() or three.exists())
        # A successful selection grants no rights over a different file in the same torrent.
        self.get('--bt-select', '0')
        self.assertIn('overwrite', self.get('--bt-select', '1', ok=False)['error'])
        self.assertEqual(two.read_bytes(), b'keep unrelated file')
        self.assert_content(self.get('--overwrite'))
        marker = self.out/('.phuket-bt-'+DIGEST.hex())/'.phuket-bt-state.json'
        import json
        state = json.loads(marker.read_bytes()); state['info_hash'] = 'wrong'
        marker.write_text(json.dumps(state), encoding='utf-8')
        self.peer.requests.clear()
        self.assertIn('overwrite', self.get(ok=False)['error'])
        self.assertFalse(self.peer.requests)

    def test_corrupt_piece_requeued_and_optional_outbound_seed(self):
        self.peer.bad_pieces, self.peer.bad_once = {0}, True
        self.assert_content(self.get('--retries', '1', '--seed-time', '.35'))
        self.assertEqual(sum((i, off) == (0, 0) for i, off, _ in self.peer.requests), 2)
        self.assertTrue(self.peer.uploads)

    def test_iterative_dht_fallback_uses_only_configured_loopback_nodes(self):
        self.tracker.ports = []
        leaf = self.server(socketserver.UDPServer, DhtNode)
        leaf.response, leaf.queries = {b'values': [addr(self.peer.server_address[1])]}, []
        first = self.server(socketserver.UDPServer, DhtNode)
        first.response, first.queries = {b'nodes': b'Q'*20 + addr(leaf.server_address[1])}, []
        self.assert_content(self.cli('--dht-bootstrap', f'{HOST}:{first.server_address[1]}', '--retries', '0', self.torrent))
        self.assertEqual(len(first.queries), 1)
        self.assertEqual(first.queries, leaf.queries)
        self.assertEqual(len(first.queries[0]), 20)

    def test_tracker_magnet_uses_only_tracker_peers_until_metadata_is_known(self):
        from unittest.mock import patch
        private = bt.bencode({**INFO, b'private': 1})
        digest = hashlib.sha1(private).hexdigest()
        magnet = 'magnet:?'+urlencode(dict(xt='urn:btih:'+digest, tr=self.url))
        tracker_peer = [('127.0.0.1', 1001)]
        with patch.object(bt, 'tracker_peers', return_value=tracker_peer), patch.object(bt, 'dht_peers') as dht, \
                patch.object(bt, 'fetch_metadata', return_value=private) as fetch, \
                patch.object(bt, 'transfer_pieces', side_effect=OSError('fixture stop')) as pieces:
            with self.assertRaisesRegex(OSError, 'fixture stop'):
                bt.download_torrent(magnet, self.out, None, None)
            self.assertEqual(fetch.call_args.args[0], tracker_peer)
            self.assertEqual(pieces.call_args.args[2], tracker_peer)
            dht.assert_not_called()
        # Verified private metadata may be cached. A trackerless magnet still cannot use DHT for payload.
        with patch.object(bt, 'dht_peers') as dht, self.assertRaisesRegex(ValueError, 'Private magnet'):
            bt.download_torrent(magnet.split('&tr=')[0], self.out, None, None)
        dht.assert_not_called()

    def test_trackerless_public_magnet_still_uses_explicit_dht_bootstrap(self):
        leaf = self.server(socketserver.UDPServer, DhtNode)
        leaf.response, leaf.queries = {b'values': [addr(self.peer.server_address[1])]}, []
        self.assert_content(self.cli('--dht-bootstrap', f'{HOST}:{leaf.server_address[1]}', '--retries', '0',
                                     'magnet:?xt=urn:btih:'+DIGEST.hex()))
        self.assertEqual(len(leaf.queries), 1)
        self.assertFalse(self.tracker.announces)

    def test_http_tracker_dictionary_and_ipv6(self):
        self.tracker.dictionary = True
        self.tracker.extra6 = ipaddress.IPv6Address('::1').packed + struct.pack('!H', 6881)
        route = DirectRoute(name='System')
        self.assertCountEqual(bt.http_tracker(self.url, DIGEST, b'x'*20, 10, route, Resolver(route, system_route=True), 2),
                              [(HOST, self.peer.server_address[1]), ('::1', 6881)])

    def test_existing_links_do_not_receive_torrent_writes(self):
        self.out.mkdir()
        other = self.tmp/'elsewhere'
        other.mkdir()
        link = self.out/'collection'
        try:
            link.symlink_to(other, target_is_directory=True)
        except OSError:  # Some Windows accounts cannot create symbolic links. Test a hard-linked file instead.
            link.mkdir()
            sentinel = other/'sentinel'
            sentinel.write_bytes(b'preserve me')
            os.link(sentinel, link/'one.bin')
            self.get(ok=False)
            self.assertEqual(sentinel.read_bytes(), b'preserve me')
        else:
            self.get(ok=False)
            self.assertEqual(list(other.iterdir()), [])
        self.assertFalse(self.peer.requests)


if __name__ == '__main__':
    unittest.main()
