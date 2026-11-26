"""Phuket direct downloader. Run with --help; --system-route skips proxies, not OS routing."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass, replace
from email.message import Message
from email.utils import collapse_rfc2231_value, parsedate_to_datetime
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import threading
import time
import unicodedata
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from direct_dns import Resolver
from direct_net import DirectHTTPConnection, DirectHTTPSConnection, DirectRoute, list_physical_routes, pick_direct_route

VERSION = '1.1.0'
CAPABILITIES = ['physical-nic', 'skip-proxy', 'resume', 'parallel-chunks', 'batch', 'torrent', 'magnet', 'dht', 'checksum', 'rate-limit', 'extract']
BLOCK = 64 * 1024
CHECKPOINT = 1024 * 1024
HASH_LIMIT = 512 * 1024**2
_BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f-\x9f]')
_DEVICE = re.compile(r'(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|(?:COM|LPT)[0-9\xb9\xb2\xb3])', re.I)


def safe_segment(name):
    if (not isinstance(name, str) or not name or name in ('.', '..') or name.endswith(('.', ' '))
            or _BAD_NAME.search(name) or _DEVICE.fullmatch(name.split('.')[0].rstrip(' '))
            or len(name.encode('utf-8')) > 255):
        raise ValueError('Unsafe file or directory name')
    return name


def no_links(path):
    path = Path(path).absolute()
    for node in (*reversed(path.parents), path):
        try:
            st = node.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(st.st_mode) or getattr(st, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError('Refusing to follow a symlink or reparse point')
    return path


def confined(root, *segments):
    root = no_links(root)
    path = no_links(root.joinpath(*(safe_segment(s) for s in segments)))
    # Guard containment lexically after validating each individual component. Resolving a
    # not-yet-created directory twice can give different Windows paths while another job creates it.
    if not path.is_relative_to(root):
        raise ValueError('Path escapes the output directory')
    return path


def regular_file(path, mode):
    """Never truncate before checking the opened object, including its hard-link count."""
    path = no_links(path)
    if path.exists() and not stat.S_ISREG(path.stat().st_mode):
        raise ValueError('Expected a regular file')
    flags = {'rb': os.O_RDONLY, 'r+b': os.O_RDWR, 'xb': os.O_WRONLY | os.O_CREAT | os.O_EXCL,
             'w+b': os.O_RDWR | os.O_CREAT}[mode]
    fd = os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0), 0o600)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or (mode != 'rb' and st.st_nlink > 1):
            raise ValueError('Unsafe output file')
        if mode == 'w+b':
            os.ftruncate(fd, 0)
        return os.fdopen(fd, mode)
    except BaseException:
        os.close(fd)
        raise


def atomic_write(path, data):
    no_links(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


class OutputClaims:
    """Reserve names for the entire batch, including partial files and extract trees."""
    def __init__(self):
        self.lock = threading.Lock()
        self.leaves, self.parents = set(), set()

    def reserve(self, paths):
        def key(p):
            return unicodedata.normalize('NFC', str(p.absolute())).casefold()
        leaves, parents = set(), set()
        for p in paths:
            k = key(p)
            if k in leaves:
                raise ValueError('Duplicate output path')
            leaves.add(k)
            parents.update(key(x) for x in p.parents)
        with self.lock:
            if leaves & (parents | self.leaves | self.parents) or parents & self.leaves:
                raise ValueError('Overlapping output paths in batch')
            self.leaves.update(leaves)
            self.parents.update(parents)


def parse_rate(text):
    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*([KMG]?)(?:i?B)?', str(text).strip(), re.I)
    if not m:
        raise ValueError('Expected a rate such as 500K or 1.5MB')
    rate = float(m[1]) * 1024 ** (' KMG'.index(m[2].upper() or ' '))
    if not math.isfinite(rate) or rate < 1:
        raise ValueError('Rate must be at least one byte per second')
    return rate


class RateLimiter:
    def __init__(self, rate):
        self.rate = parse_rate(rate)
        self.capacity = min(BLOCK, self.rate / 4)
        self.tokens, self.stamp = self.capacity, time.monotonic()
        self.lock = threading.Lock()

    def consume(self, size):
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.stamp) * self.rate) - size
            self.stamp = now
            wait = -self.tokens / self.rate
        if wait > 0:
            time.sleep(wait)


def http_url(url):
    if len(url) > 16384 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 or c == '\\' for c in url):
        raise ValueError('Invalid characters in URL')
    u = urlsplit(url)
    if (u.scheme not in ('http', 'https') or not u.hostname or u.username is not None
            or u.password is not None or u.port == 0):
        raise ValueError('Expected an HTTP(S) URL without embedded credentials')
    return u


def origin(u):
    return u.scheme, u.hostname.encode('idna').lower(), u.port or (443 if u.scheme == 'https' else 80)


def header_map(headers):
    result = {}
    for name, value in (headers or {}).items():
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or re.search(r'[\x00-\x1f\x7f]', value):
            raise ValueError('Invalid HTTP header')
        name = name.lower()
        if name in ('host', 'content-length', 'transfer-encoding', 'proxy-connection'):
            raise ValueError('Cannot override HTTP routing or framing headers')
        if name != 'proxy-authorization':  # A proxy credential never belongs on an origin request.
            result[name] = value
    result.update({'accept-encoding': 'identity', 'connection': 'close'})
    return result


@contextmanager
def open_http(url, *, route, resolver, timeout=20., method='GET', headers=None):
    """Yield a streaming (response, final_url); redirects stay on this route."""
    headers = header_map(headers)
    for hop in range(11):
        u = http_url(url)
        url = urlunsplit((*u[:4], ''))
        cls = DirectHTTPSConnection if u.scheme == 'https' else DirectHTTPConnection
        conn = cls(u.hostname.encode('idna').decode('ascii'), origin(u)[2], route=route, resolver=resolver, timeout=timeout)
        target = quote(u.path or '/', safe="/:!$&'()*+,;=@%[]~")
        if u.query:
            target += '?' + quote(u.query, safe="/:!$&'()*+,;=@%[]~?")
        try:
            conn.request(method, target, headers=headers)
            with conn.getresponse() as response:
                if response.status not in (301, 302, 303, 307, 308):
                    yield response, url
                    return
                location = response.getheader('Location')
                if not location or hop == 10:
                    raise ValueError('Missing redirect location or too many redirects')
                url = urljoin(url, location)
                if origin(http_url(url)) != origin(u):
                    safe = {'user-agent', 'accept', 'accept-language', 'range', 'if-range'}
                    headers = header_map({k: v for k, v in headers.items() if k in safe})
        finally:
            conn.close()


def filename_for(response, url):
    msg = Message()
    if len(raw := response.getheader('Content-Disposition') or '') > 8192:
        raw = ''
    msg['Content-Disposition'] = raw
    names = [v for k, v in (msg.get_params(header='content-disposition') or []) if k.lower() == 'filename']
    extended = [collapse_rfc2231_value(v) for v in names if isinstance(v, tuple)]
    raw = next(iter(extended or [v for v in names if isinstance(v, str)]), '') or unquote(urlsplit(url).path.split('/')[-1])
    name = _BAD_NAME.sub('_', re.split(r'[/\\]', raw)[-1]).strip(' .')
    name = name.encode('utf-8')[:200].decode('utf-8', 'ignore').rstrip(' .') or 'download'
    if _DEVICE.fullmatch(name.split('.')[0].rstrip(' ')):
        name = '_' + name
    return safe_segment(name)


class HttpError(OSError):
    def __init__(self, status):
        super().__init__(f'Server returned HTTP {status}')
        self.status = status


def length_of(response):
    raw = response.getheader('Content-Length')
    if raw is None:
        return None
    if not re.fullmatch(r'[0-9]{1,19}', raw) or int(raw) > 2**63 - 1:
        raise ValueError('Invalid Content-Length')
    return int(raw)


def content_range(response):
    m = re.fullmatch(r'bytes (\d{1,19})-(\d{1,19})/(\d{1,19})', response.getheader('Content-Range') or '', re.I)
    if m:
        a, b, total = map(int, m.groups())
        if 0 <= a <= b < total <= 2**63-1 and length_of(response) in (None, b-a+1):
            return a, b, total
    raise ValueError('Invalid Content-Range')


@dataclass(frozen=True)
class HttpInfo:
    url: str
    final_url: str
    total: int | None
    ranges: bool
    etag: str | None
    modified: str | None
    content_type: str | None
    filename: str

    @property
    def validator(self):
        tag = self.etag
        if tag and re.fullmatch(r'"[\x21\x23-\x7e\x80-\xff]*"', tag):
            return tag  # If-Range requires a strong entity tag, never W/ or a bare token.
        if self.modified:
            try:
                parsedate_to_datetime(self.modified)
                return self.modified
            except (ValueError, TypeError, OverflowError):
                pass  # A placeholder such as 'unknown' is not an HTTP-date.
        return None

    def identity(self):
        return {'url': self.url, 'finalUrl': self.final_url, 'totalSize': self.total,
                'etag': self.etag, 'lastModified': self.modified}

    def summary(self):
        return {**self.identity(), 'acceptRanges': self.ranges, 'contentType': self.content_type, 'filename': self.filename}


def probe_http(url, route, resolver, *, headers=None, timeout=20.):
    base = header_map(headers)
    for method in ('HEAD', 'GET'):
        if method == 'GET':
            base['range'] = 'bytes=0-0'
        with open_http(url, route=route, resolver=resolver, method=method, headers=base, timeout=timeout) as (r, final):
            if method == 'HEAD' and r.status in (405, 501):
                continue
            ranges = (r.getheader('Accept-Ranges') or '').lower().strip() == 'bytes'
            if r.status == 206:
                a, b, size = content_range(r)
                if method == 'GET' and (a, b) != (0, 0):
                    raise ValueError('Incorrect probe range')
                ranges = True
            elif r.status == 416 and r.getheader('Content-Range') == 'bytes */0':
                size = 0
            elif r.status == 200:
                size = length_of(r)
            else:
                raise HttpError(r.status)
            return HttpInfo(url, final, size, ranges, r.getheader('ETag'), r.getheader('Last-Modified'),
                            r.getheader('Content-Type'), filename_for(r, final))


def checksums(path, *, sha256=None, md5=None, report=True):
    size = path.stat().st_size
    hashes = {}
    if sha256 or report and size <= HASH_LIMIT:
        hashes['sha256'] = hashlib.sha256()
    if md5:
        hashes['md5'] = hashlib.md5(usedforsecurity=False)
    if hashes:
        with regular_file(path, 'rb') as stream:
            while block := stream.read(1024 * 1024):
                for h in hashes.values():
                    h.update(block)
    values = {k: v.hexdigest() for k, v in hashes.items()}
    for name, expected in [('sha256', sha256), ('md5', md5)]:
        if expected and values[name] != expected.lower():
            raise ValueError(f'{name.upper()} checksum mismatch')
    return values


class RangeIgnored(Exception):
    pass


def split_ranges(size, count):
    if size is None or size == 0:
        return [[0, None if size is None else -1, 0]]
    count = min(count, size)
    return [[size*i//count, size*(i+1)//count-1, 0] for i in range(count)]


class HttpTransfer:
    def __init__(self, info, dest, route, resolver, headers, timeout, retries, limiter, progress, expected_digest=False):
        self.info, self.dest, self.expected_digest = info, dest, expected_digest
        self.part = confined(dest.parent, dest.name + '.part')
        self.meta = confined(dest.parent, dest.name + '.part.meta.json')
        self.net = dict(route=route, resolver=resolver, timeout=timeout)
        self.headers, self.retries, self.limiter, self.progress = header_map(headers), retries, limiter, progress
        self.lock, self.cancel = threading.Lock(), threading.Event()
        self.chunks = []

    def checkpoint(self, idx=None, done=None):
        with self.lock:
            if idx is not None:
                self.chunks[idx][2] = done
            data = {**self.info.identity(), 'chunks': self.chunks}
            atomic_write(self.meta, json.dumps(data, separators=(',', ':')).encode())
            if self.progress:
                self.progress(self.dest.name, sum(c[2] for c in self.chunks), self.info.total)

    def saved_chunks(self):
        if not self.part.is_file() or not self.meta.is_file():
            return None
        with regular_file(self.meta, 'rb') as stream:
            raw = stream.read(64*1024)
        try:
            data = json.loads(raw)
            if not isinstance(data, dict) or any(k not in data or data[k] != v for k, v in self.info.identity().items()):
                return None
            chunks = data['chunks']
            if not isinstance(chunks, list) or not 1 <= len(chunks) <= 16:
                return None
            length, next_byte = self.part.stat().st_size, 0
            for a, b, done in chunks:
                if type(a) is not int or a != next_byte or type(done) is not int or done < 0:
                    return None
                if b is None:
                    if self.info.total is not None or len(chunks) != 1:
                        return None
                    next_byte = None
                else:
                    if type(b) is not int or b < a - (self.info.total == 0) or done > b-a+1:
                        return None
                    next_byte = b+1
                if done and a+done > length:
                    return None
            if next_byte != self.info.total or len(chunks) > 1 and length != self.info.total:
                return None
            return chunks
        except (ValueError, TypeError, KeyError):
            return None

    def request_headers(self, byte_range):
        headers = self.headers.copy()
        if byte_range:
            headers['range'] = byte_range
            if self.info.validator:
                headers['if-range'] = self.info.validator
        return headers

    def same_entity(self, r, final):
        if (final != self.info.final_url or any(old and r.getheader(k) not in (None, old) for k, old in
                [('ETag', self.info.etag), ('Last-Modified', self.info.modified)])):
            raise ValueError('Representation changed during download; retry to re-probe it')
        if (r.getheader('Content-Encoding') or 'identity').lower() != 'identity':
            raise ValueError('Cannot safely range-download an encoded representation')

    def orphan_prefix(self):
        # Without a checkpoint the provenance of a .part is unknown. Compare it before reuse.
        n = self.part.stat().st_size
        if not n or self.info.total is None or n >= self.info.total:
            return 0
        headers = self.request_headers(f'bytes=0-{n-1}')
        with open_http(self.info.url, headers=headers, **self.net) as (r, final):
            if r.status != 206 or content_range(r) != (0, n-1, self.info.total):
                return 0
            self.same_entity(r, final)
            with regular_file(self.part, 'rb') as old:
                left = n
                while left:
                    block = r.read(min(left, BLOCK))
                    if not block or block != old.read(len(block)):
                        return 0
                    if self.limiter:
                        self.limiter.consume(len(block))
                    left -= len(block)
        return n

    def prepare(self, count, resume):
        if not (self.info.validator or self.expected_digest):
            count, resume = 1, False  # Never splice unvalidated representations, even in one process.
        self.cancel.clear()
        self.chunks = self.saved_chunks() if resume else None
        if self.chunks:
            if len(self.chunks) == 1:
                with regular_file(self.part, 'r+b') as stream:
                    stream.truncate(self.chunks[0][2])
            return
        prefix = 0
        if resume and self.part.is_file() and not self.meta.exists():
            prefix = self.orphan_prefix()
            if prefix:
                count = 1
        self.meta.unlink(missing_ok=True)
        self.chunks = split_ranges(self.info.total, count)
        self.chunks[0][2] = prefix
        if not prefix:
            with regular_file(self.part, 'w+b') as stream:
                if len(self.chunks) > 1:
                    stream.truncate(self.info.total)
        self.checkpoint()

    def stream_chunk(self, idx):
        a, b, done = self.chunks[idx]
        multi = len(self.chunks) > 1
        if done and not (self.info.validator or self.expected_digest):
            self.checkpoint(idx, 0)  # Even an in-process retry needs a fresh whole response.
            done = 0
        if b is not None and done == b-a+1:
            return
        wanted = f'bytes={a+done}-{b if multi else ""}' if multi or done else None
        with open_http(self.info.url, headers=self.request_headers(wanted), **self.net) as (r, final):
            if r.status not in (200, 206):
                raise HttpError(r.status)
            if wanted and r.status == 200:
                if multi:
                    raise RangeIgnored()  # Stop all writers before restarting as a single stream.
                # If-Range failed (or Range was ignored). This entire body is the new entity.
                self.info = replace(self.info, final_url=final, total=length_of(r), etag=r.getheader('ETag'),
                                    modified=r.getheader('Last-Modified'))
                self.chunks = split_ranges(self.info.total, 1)
                self.checkpoint()
                done = 0
            self.same_entity(r, final)
            if r.status == 206:
                start, end, size = content_range(r)
                if not wanted or start != a+done or end != (size-1 if b is None else b) or self.info.total not in (None, size):
                    raise ValueError('Response does not match the requested byte range')
                limit = end-a+1
            else:
                size = length_of(r)
                if self.info.total is not None and size not in (None, self.info.total):
                    raise ValueError('Content length changed during download')
                limit = self.info.total if self.info.total is not None else size
            with regular_file(self.part, 'r+b') as stream:
                if not multi:
                    stream.truncate(done)
                stream.seek(a+done)
                published = done
                def flush():
                    stream.flush()
                    os.fsync(stream.fileno())
                    self.checkpoint(idx, done)
                try:
                    while not self.cancel.is_set():
                        block = r.read1(BLOCK)
                        if not block:
                            if limit is not None and done != limit:
                                raise OSError('Incomplete HTTP response')
                            break
                        if limit is not None and done+len(block) > limit:
                            raise ValueError('Response exceeds requested range')
                        if self.limiter:
                            self.limiter.consume(len(block))
                        stream.write(block)
                        done += len(block)
                        if done-published >= CHECKPOINT:
                            flush()
                            published = done
                finally:
                    if done != published:
                        flush()

    def worker(self, idx):
        for attempt in range(self.retries+1):
            if self.cancel.is_set():
                return
            try:
                self.stream_chunk(idx)
                return
            except (OSError, http.client.HTTPException) as e:
                if attempt == self.retries or isinstance(e, HttpError) and e.status < 500 and e.status not in (408, 429):
                    raise
                self.cancel.wait(min(.2 * 2**attempt, 5))

    def transfer(self, workers):
        with ThreadPoolExecutor(max_workers=min(len(self.chunks), workers)) as pool:
            futures = [pool.submit(self.worker, i) for i in range(len(self.chunks))]
            try:
                for f in as_completed(futures):
                    f.result()
            except BaseException:
                self.cancel.set()
                for f in futures:
                    f.cancel()
                raise


def _windows_lock_api():
    import ctypes
    from ctypes import wintypes
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    api.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
    api.CreateMutexW.restype = wintypes.HANDLE
    api.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    api.OpenProcess.restype = wintypes.HANDLE
    api.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    api.WaitForSingleObject.restype = wintypes.DWORD
    api.ReleaseMutex.argtypes = api.CloseHandle.argtypes = (wintypes.HANDLE,)
    return api


@contextmanager
def _lock_directory(directory):
    # Serialize the short PID-check/unlink/create transaction, not the download.
    # Two concurrent stale-lock cleaners must never unlink a successor's live lock.
    if os.name == 'nt':
        import ctypes
        st = directory.stat()
        api = _windows_lock_api()
        handle = api.CreateMutexW(None, False, f'Global\\PhuketDL-{st.st_dev:x}-{st.st_ino:x}')
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if api.WaitForSingleObject(handle, 5000) not in (0, 0x80):  # Acquired or abandoned.
                raise OSError('Could not acquire download directory lock')
            try:
                yield
            finally:
                api.ReleaseMutex(handle)
        finally:
            api.CloseHandle(handle)
    else:
        import fcntl
        fd = os.open(directory, os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)


def _pid_alive(pid):
    if not 0 < pid <= 0xffffffff:
        raise ValueError('Invalid download lock PID')
    if os.name == 'nt':
        # os.kill(pid, 0) is destructive on Windows. Poll a SYNCHRONIZE handle instead.
        import ctypes
        api = _windows_lock_api()
        handle = api.OpenProcess(0x00100000, False, pid)
        if not handle:
            error = ctypes.get_last_error()
            if error in (5, 87):
                return error == 5  # Access denied means live; invalid PID means dead.
            raise ctypes.WinError(error)
        try:
            result = api.WaitForSingleObject(handle, 0)
            if result == 0xffffffff:
                raise ctypes.WinError(ctypes.get_last_error())
            return result != 0
        finally:
            api.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, OverflowError):
        return False
    except PermissionError:
        pass
    return True


@contextmanager
def download_lock(path):
    with _lock_directory(path.parent):
        try:
            lock = regular_file(path, 'xb')  # O_CREAT | O_EXCL
        except FileExistsError:
            with regular_file(path, 'rb') as f:
                raw = f.read(64).strip()
            if raw and _pid_alive(int(raw)):
                raise FileExistsError('Download already in progress for this destination') from None
            # An empty lock means the guarded creator died before it could write its PID.
            path.unlink()
            lock = regular_file(path, 'xb')
        try:
            with lock:
                lock.write(str(os.getpid()).encode('ascii'))
        except BaseException:
            path.unlink()
            raise
    try:
        yield
    finally:
        with _lock_directory(path.parent):
            path.unlink()


def _publish_file(part, dest, overwrite):
    no_links(dest)
    if overwrite:
        os.replace(part, dest)
    elif os.name == 'nt':
        os.rename(part, dest)  # Windows rename fails atomically if dest exists.
    else:
        os.link(part, dest)  # POSIX rename would clobber a concurrent creator.
        part.unlink()


def download_http(url, root, route, resolver, *, filename=None, headers=None, timeout=20., connections=4,
                  min_chunk_size=256*1024, resume=True, overwrite=False, retries=5, rate_limiter=None,
                  sha256=None, md5=None, extract=False, claims=None, progress=None, report_hash=True):
    info = probe_http(url, route, resolver, headers=headers, timeout=timeout)
    dest = confined(root, filename or info.filename)
    t = HttpTransfer(info, dest, route, resolver, headers, timeout, retries, rate_limiter, progress, bool(sha256 or md5))
    lock_path = confined(dest.parent, dest.name + '.phuket-dl.lock')
    paths = [dest, t.part, t.meta, lock_path]
    if extract:
        paths.append(extract_dest(dest))
    (claims or OutputClaims()).reserve(paths)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with download_lock(lock_path):
        if dest.exists() and not overwrite:
            raise FileExistsError('Destination exists; use --overwrite to replace it')
        count = connections if info.ranges and info.total and info.total >= min_chunk_size else 1
        t.prepare(count, resume and not overwrite)
        try:
            t.transfer(connections)
        except RangeIgnored:
            t.info = probe_http(url, route, resolver, headers=headers, timeout=timeout)
            t.prepare(1, False)
            t.transfer(1)
        length = t.part.stat().st_size
        if t.info.total is not None and t.info.total != length:
            raise ValueError('Incomplete file')
        try:
            hashes = checksums(t.part, sha256=sha256, md5=md5, report=report_hash)
        except ValueError:
            t.meta.unlink(missing_ok=True)
            t.part.unlink(missing_ok=True)
            raise
        _publish_file(t.part, dest, overwrite)
        t.meta.unlink(missing_ok=True)
        result = {'ok': True, 'path': str(dest), 'bytes': length, **hashes}
        if extract:
            result['extractedTo'] = str(extract_archive(dest))
        return result


_ARCHIVES = ('.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.zip', '.tar')


def extract_dest(path):
    for ext in _ARCHIVES:
        if path.name.lower().endswith(ext):
            return confined(path.parent, path.name[:-len(ext)] or 'extracted')
    raise ValueError('Unsupported archive extension')


def extract_archive(path):
    """Stage regular files in a private empty tree. Never merge with or overwrite an existing tree."""
    dest = extract_dest(path)
    if dest.exists():
        raise FileExistsError('Extraction directory already exists')
    stage = Path(tempfile.mkdtemp(dir=dest.parent))
    total = count = 0
    def member(name, size, directory, reader):
        nonlocal total, count
        count += 1
        total += size
        if count > 100_000 or size < 0 or total > 8*1024**3:
            raise ValueError('Archive exceeds extraction limits')
        parts = name.removesuffix('/').split('/')
        # tar writers commonly include a leading ./ entry.
        while parts and parts[0] == '.':
            parts.pop(0)
        if not parts and directory:
            return
        out = confined(stage, *parts)
        if directory:
            out.mkdir(parents=True, exist_ok=True)
            return
        out.parent.mkdir(parents=True, exist_ok=True)
        with reader() as src, regular_file(out, 'xb') as dst:
            remaining = size
            while remaining:
                block = src.read(min(remaining, BLOCK))
                if not block:
                    raise ValueError('Truncated archive member')
                dst.write(block)
                remaining -= len(block)
            if src.read(1):
                raise ValueError('Archive member exceeds its declared length')
    try:
        with regular_file(path, 'rb') as stream:
            if path.name.lower().endswith('.zip'):
                with zipfile.ZipFile(stream) as archive:
                    for item in archive.infolist():
                        kind = stat.S_IFMT(item.external_attr >> 16)
                        if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or item.orig_filename != item.filename:
                            raise ValueError('Unsupported ZIP member')
                        member(item.filename, item.file_size, item.is_dir(), lambda: archive.open(item))
            else:
                with tarfile.open(fileobj=stream, mode='r|*') as archive:
                    for item in archive:
                        if item.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) or item.sparse:
                            raise ValueError('Unsupported TAR member')
                        member(item.name, item.size, item.isdir(), lambda: archive.extractfile(item))
        if no_links(dest).exists():
            raise FileExistsError('Extraction directory already exists')
        stage.rename(dest)
        return dest
    finally:
        if stage.exists():
            shutil.rmtree(stage)


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def arguments(argv):
    p = _Parser(description=__doc__, allow_abbrev=False)
    p.add_argument('targets', nargs='*', help='HTTP(S) URL, local .torrent file, or magnet URI')
    p.add_argument('-i', '--input-file', help='UTF-8 file with one target per line')
    p.add_argument('-d', '--dir', default='.', type=Path)
    p.add_argument('-o', '--output', type=Path, help='output path for a single HTTP target')
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--system-route', action='store_const', const='skip-proxy', dest='mode',
                      help='ignore app proxies; VPN/TUN and OS routing still apply')
    mode.add_argument('--physical-nic', action='store_const', const='physical-nic', dest='mode')
    p.add_argument('--interface', default=os.environ.get('PHUKET_DIRECT_INTERFACE', ''))
    p.add_argument('--dns', action='append', metavar='IP[,IP...]', help='DNS addresses; may be repeated')
    p.add_argument('--info', action='store_true', help='probe only; do not download file data')
    p.add_argument('--bt-info', action='store_true', help='read verified torrent metadata only')
    p.add_argument('--bt-select', help='zero-based file indices or globs, separated by commas')
    p.add_argument('--max-peers', type=int, default=24)
    p.add_argument('--no-dht', action='store_true')
    p.add_argument('--dht-bootstrap', action='append', metavar='HOST:PORT', help='replace default DHT bootstrap nodes')
    p.add_argument('--seed-time', type=float, default=0., metavar='SECONDS')
    p.add_argument('-f', '--overwrite', action='store_true')
    p.add_argument('--no-resume', action='store_true')
    p.add_argument('-c', '--connections', type=int, default=4)
    p.add_argument('-j', '--jobs', type=int, default=3)
    p.add_argument('--min-chunk-size', type=int, default=256*1024, metavar='BYTES', help='minimum file size for parallel ranges')
    p.add_argument('--timeout', type=float, default=20.)
    p.add_argument('--retries', type=int, default=5)
    p.add_argument('--max-rate', help='shared bytes per second; K, M, G suffixes supported')
    p.add_argument('-H', '--header', action='append', default=[])
    p.add_argument('-A', '--user-agent', default=f'PhuketSwitch-Direct/{VERSION}')
    p.add_argument('-e', '--referer')
    p.add_argument('--sha256')
    p.add_argument('--md5')
    p.add_argument('--extract', action='store_true')
    p.add_argument('--inspect-routes', action='store_true')
    p.add_argument('--self-check', action='store_true')
    p.add_argument('--json', action='store_true')
    p.add_argument('-q', '--quiet', action='store_true')
    return p.parse_args(argv)


def bootstrap_nodes(items):
    if items is None:
        return None
    nodes = []
    for item in items:
        u = urlsplit('udp://'+item)
        if not u.hostname or not u.port or u.username is not None or u.path or u.query or u.fragment:
            raise ValueError('Expected DHT bootstrap HOST:PORT (bracket IPv6 addresses)')
        nodes.append((u.hostname, u.port))
    return nodes


def run(args):
    from direct_torrent import download_torrent, parse_torrent
    if args.self_check:
        return {'ok': True, 'version': VERSION, 'python': sys.version.split()[0], 'capabilities': CAPABILITIES}
    dns = [s for item in (args.dns if args.dns is not None else [os.getenv('PHUKET_DIRECT_DNS', '')])
           for s in re.split(r'[,\s]+', item.strip()) if s]
    if args.inspect_routes:
        routes = list_physical_routes(dns)
        selected = pick_direct_route(args.interface, routes=routes) if routes else None
        return {'ok': True, 'adapters': [r.to_dict() for r in routes], 'selected': selected.to_dict() if selected else None}
    if not (1 <= args.connections <= 16 and 1 <= args.jobs <= 8 and 1 <= args.max_peers <= 64 and
            0 <= args.retries <= 20 and args.min_chunk_size > 0 and 0 < args.timeout <= 600 and
            0 <= args.seed_time <= 86400):
        raise ValueError('Invalid connection, job, peer, retry, size or time limit')
    for digest, n in [(args.sha256, 64), (args.md5, 32)]:
        if digest is not None and not re.fullmatch('[a-fA-F0-9]{%d}' % n, digest):
            raise ValueError('Invalid expected digest')
    nodes = bootstrap_nodes(args.dht_bootstrap)
    headers = {'user-agent': args.user_agent}
    if args.referer:
        headers['referer'] = args.referer
    for header in args.header:
        name, sep, value = header.partition(':')
        if not sep or name.lower() in ('range', 'if-range'):
            raise ValueError('Expected Name: Value; byte ranges are managed by the downloader')
        headers[name.lower()] = value.strip()
    headers = header_map(headers)
    targets = list(args.targets)
    if args.input_file:
        with regular_file(Path(args.input_file), 'rb') as f:
            raw = f.read(4*1024**2+1)
        if len(raw) > 4*1024**2:
            raise ValueError('Input list too large')
        targets.extend(s for line in raw.decode('utf-8-sig').splitlines() if (s := line.strip()) and not s.startswith('#'))
    if not 1 <= len(targets) <= 4096:
        raise ValueError('Expected 1 to 4096 download targets')
    if len(targets) != 1 and (args.output or args.sha256 or args.md5):
        raise ValueError('An explicit output or checksum requires one target')
    root, filename = args.dir, None
    if args.output:
        output = root / args.output
        root, filename = output.parent, safe_segment(output.name)
    mode = args.mode or os.environ.get('PHUKET_DIRECT_MODE') or 'physical-nic'
    if mode not in ('physical-nic', 'skip-proxy'):
        raise ValueError('Invalid PHUKET_DIRECT_MODE')
    def local_torrent(s):
        return not s.lower().startswith(('magnet:', 'https:', 'http:')) and s.lower().endswith('.torrent')
    info_only = args.info or args.bt_info
    if not (info_only and all(map(local_torrent, targets))):
        route = DirectRoute(name='System') if mode == 'skip-proxy' else pick_direct_route(args.interface, dns)
        resolver = Resolver(route, system_route=route.system_route, servers=dns if route.system_route else (), timeout=args.timeout)
    if not info_only and len(targets) > 1:
        root = no_links(root)
        root.mkdir(parents=True, exist_ok=True)
        root = no_links(root).resolve(strict=True)
    claims = OutputClaims()
    limiter = RateLimiter(args.max_rate) if args.max_rate else None
    def progress(name, done, total):
        print(f'{name}: {done} / {total if total is not None else "?"} bytes', file=sys.stderr, flush=True)
    common = dict(timeout=args.timeout, retries=args.retries, resume=not (args.no_resume or args.overwrite),
                  rate_limiter=limiter, sha256=args.sha256, md5=args.md5, claims=claims, report_hash=args.json,
                  progress=progress if sys.stderr.isatty() and not (args.json or args.quiet) else None)
    def target(s):
        if local_torrent(s) or s.lower().startswith('magnet:'):
            if args.output:
                raise ValueError('Torrent output names come from verified metadata; use --dir')
            if info_only and local_torrent(s):
                return {'ok': True, **parse_torrent(s).summary()}
            return download_torrent(s, root, route, resolver, info_only=info_only, select=args.bt_select,
                                    no_dht=args.no_dht, bootstrap=nodes, max_peers=args.max_peers,
                                    seed_time=args.seed_time, overwrite=args.overwrite, extract=args.extract, **common)
        if args.bt_info or args.bt_select:
            raise ValueError('BitTorrent options require a .torrent file or magnet URI')
        if info_only:
            return {'ok': True, 'route': route.to_dict(), **probe_http(s, route, resolver, headers=headers, timeout=args.timeout).summary()}
        return download_http(s, root, route, resolver, filename=filename, headers=headers, connections=args.connections,
                             min_chunk_size=args.min_chunk_size, overwrite=args.overwrite, extract=args.extract, **common)
    if len(targets) == 1:
        return target(targets[0])
    def collect(s):
        try:
            return target(s)
        except (OSError, ValueError, EOFError, RuntimeError, http.client.HTTPException, zipfile.BadZipFile, tarfile.TarError) as e:
            return {'ok': False, 'error': str(e)}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        results = list(pool.map(collect, targets))
    return {'ok': all(r['ok'] for r in results), 'results': results}


def main(argv=None):
    try:
        result = run(arguments(argv))
    except KeyboardInterrupt:
        print(json.dumps({'ok': False, 'error': 'Interrupted'}))
        return 130
    except (OSError, ValueError, EOFError, RuntimeError, http.client.HTTPException, zipfile.BadZipFile, tarfile.TarError) as e:
        result = {'ok': False, 'error': str(e)}
    print(json.dumps(result, ensure_ascii=True), flush=True)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    # The torrent module shares this module's transport and filesystem guards.
    sys.modules['direct_download'] = sys.modules[__name__]
    sys.exit(main())
