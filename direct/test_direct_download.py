"""Loopback-only HTTP fixtures. --json is exercised at the process boundary under isolated Python."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

import direct_download as dl


DIRECT = Path(__file__).resolve().parent
DATA = bytes(range(251)) * 1100
MODIFIED = 'Tue, 01 Jan 2030 10:00:00 GMT'


class LocalCLI:
    """Shared test harness, not a TestCase (no test cases imported by discovery)."""
    def setUp(self):
        super().setUp()
        temp = tempfile.TemporaryDirectory(dir=DIRECT)
        self.addCleanup(temp.cleanup)
        self.tmp = Path(temp.name)
        self.out = self.tmp / 'out'
        self.env = {k: v for k, v in os.environ.items() if not k.upper().startswith('PHUKET_DIRECT_')}
        self.env.update(dict.fromkeys(('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'), str(self.tmp)))
        self.env.update(dict.fromkeys(('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'), 'http://127.0.0.1:1'))
        self.env['NO_PROXY'] = ''

    def command(self, *args):
        return [sys.executable, '-I', '-S', '-B', '-u', str(DIRECT / 'direct_download.py'),
                '--system-route', '--json', '--timeout', '3', '-d', str(self.out), *map(str, args)]

    def cli(self, *args, ok=True, env=None):
        child = subprocess.run(self.command(*args), cwd=self.tmp, env=env or self.env, capture_output=True, timeout=15)
        self.assertEqual(child.stderr, b'')
        self.assertEqual(len(child.stdout.splitlines()), 1, child.stdout)
        result = json.loads(child.stdout)
        self.assertEqual(child.returncode == 0, ok, result)
        self.assertIs(result['ok'], ok, result)
        return result

    def serve(self, server):
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.shutdown)
        return server.server_address[1]


class Origin(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_HEAD(self):
        self.reply(False)

    def do_GET(self):
        self.reply(True)

    def reply(self, body):
        s, path = self.server, self.path.split('?')[0]
        headers = {k.lower(): v for k, v in self.headers.items()}
        with s.lock:
            s.log.append((self.command, path, headers))
        if path in s.redirects:
            code, dest = s.redirects[path]
            self.send_response(code)
            self.send_header('Location', dest)
            self.end_headers()
            return
        if not body and s.head_status != 200:
            self.send_response(s.head_status)
            self.end_headers()
            return
        if path not in s.files:
            self.send_error(404)
            return
        data = s.files[path]
        a, end = 0, len(data)
        rng = self.headers.get('Range') if not s.ignore_range else None
        if rng:
            m = re.fullmatch(r'bytes=(\d+)-(\d*)', rng)
            a, end = int(m[1]), int(m[2])+1 if m[2] else len(data)
            if not 0 <= a < end <= len(data):
                self.send_error(416)
                return
        self.send_response(206 if rng else 200)
        self.send_header('Content-Length', str(end-a))
        self.send_header('ETag', s.etag)
        self.send_header('Last-Modified', MODIFIED)
        self.send_header('Content-Type', 'application/octet-stream')
        if rng:
            self.send_header('Content-Range', f'bytes {a}-{end-1}/{len(data)}')
        if s.advertise:
            self.send_header('Accept-Ranges', 'bytes')
        if s.disposition:
            self.send_header('Content-Disposition', s.disposition)
        self.end_headers()
        if body:
            try:
                if s.hook and s.hook(self, a, end, data):
                    return
                self.wfile.write(data[a:end])
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass  # Expected for a probe or interrupted download.


class HttpTests(LocalCLI, unittest.TestCase):
    def origin(self):
        s = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        s.files, s.redirects, s.log = {'/one.bin': DATA}, {}, []
        s.etag, s.advertise, s.ignore_range, s.head_status = '"v1"', True, False, 200
        s.disposition, s.hook, s.lock = '', None, threading.Lock()
        return s, f'http://127.0.0.1:{self.serve(s)}'

    def setUp(self):
        super().setUp()
        self.s, self.base = self.origin()
        self.url = self.base+'/one.bin'

    def ranges(self):
        return [h.get('range') for m, p, h in self.s.log if m == 'GET']

    def seed_prefix(self, n, *, etag='"v1"', prefix=None):
        self.out.mkdir(exist_ok=True)
        (self.out/'one.bin.part').write_bytes(DATA[:n] if prefix is None else prefix)
        (self.out/'one.bin.part.meta.json').write_text(json.dumps(dict(url=self.url, finalUrl=self.url, totalSize=len(DATA),
                etag=etag, lastModified=MODIFIED, chunks=[[0, len(DATA)-1, n]])), encoding='utf-8')

    def assert_complete(self):
        self.assertEqual((self.out/'one.bin').read_bytes(), DATA)
        self.assertEqual(list(self.out.glob('*.part*')), [])

    def test_single_stream_whole_file_digests_and_no_clobber(self):
        sha, md5 = hashlib.sha256(DATA).hexdigest(), hashlib.md5(DATA, usedforsecurity=False).hexdigest()
        r = self.cli(self.url, '-c', '1', '--sha256', sha, '--md5', md5)
        self.assertEqual((r['sha256'], r['md5'], r['bytes']), (sha, md5, len(DATA)))
        self.assertEqual(self.ranges(), [None])
        self.assert_complete()
        self.cli(self.url, ok=False)
        for opt, size in [('--sha256', 64), ('--md5', 32)]:
            with self.subTest(opt=opt):
                r = self.cli(self.url, '-c', '1', '-f', opt, '0'*size, ok=False)
                self.assertIn('checksum mismatch', r['error'])
                self.assert_complete()  # A failed replacement did not publish bad bytes.

    def test_resume_single_range_and_remove_sidecar(self):
        self.seed_prefix(15003)
        self.cli(self.url)
        self.assertEqual(self.ranges(), ['bytes=15003-'])
        self.assertEqual(self.s.log[-1][2]['if-range'], self.s.etag)
        self.assert_complete()

    def test_changed_validator_invalidates_even_a_plausible_prefix(self):
        self.seed_prefix(9999, etag='"old"', prefix=b'X'*9999)
        self.cli('-c', '1', self.url)
        self.assertEqual(self.ranges(), [None])
        self.assert_complete()

    def test_range_ignored_restarts_single_and_parallel(self):
        self.s.ignore_range = True
        self.seed_prefix(777)
        self.cli(self.url)
        self.assertEqual(self.ranges(), ['bytes=777-'])
        self.assert_complete()
        self.s.log.clear()
        self.cli('-f', '-c', '4', '--min-chunk-size', '1000', self.url)
        self.assertIn(None, self.ranges())
        self.assertTrue(any(self.ranges()))
        self.assert_complete()

    def test_no_resume_and_orphan_part(self):
        self.seed_prefix(921)
        self.cli('-c', '1', '--no-resume', self.url)
        self.assertEqual(self.ranges(), [None])
        (self.out/'one.bin').rename(self.out/'one.bin.part')
        (self.out/'one.bin.part').write_bytes(DATA[:921])
        self.s.log.clear()
        self.cli(self.url)
        self.assertEqual(self.ranges(), ['bytes=0-920', 'bytes=921-'])
        self.assert_complete()

    def test_four_concurrent_ranges_interruption_and_resume_only_unfinished(self):
        # Block the last request and terminate the client after the other three ranges are durable.
        gate, release = threading.Barrier(4, timeout=5), threading.Event()
        chunks = dl.split_ranges(len(DATA), 4)
        def hold(handler, a, end, data):
            gate.wait()
            if a == chunks[-1][0]:
                release.wait(8)
                return True
            return False
        self.s.hook = hold
        cmd = self.command('-c', '4', '--min-chunk-size', '1024', self.url)
        child = subprocess.Popen(cmd, cwd=self.tmp, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic()+7
            completed = []
            while time.monotonic() < deadline and child.poll() is None:
                try:
                    saved = json.loads((self.out/'one.bin.part.meta.json').read_bytes())['chunks']
                    completed = [i for i, (a, b, done) in enumerate(saved) if done == b-a+1]
                    if completed == [0, 1, 2]:
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(.015)
            self.assertEqual(completed, [0, 1, 2])
            self.assertCountEqual(self.ranges(), [f'bytes={a}-{b}' for a, b, _ in chunks])
        finally:
            child.kill()
            child.communicate(timeout=5)
            release.set()
        self.assertFalse((self.out/'one.bin').exists())
        self.s.hook = None
        self.s.log.clear()
        self.cli('-c', '4', '--min-chunk-size', '1024', self.url)
        self.assertEqual(self.ranges(), [f'bytes={chunks[-1][0]}-{chunks[-1][1]}'])
        self.assert_complete()

    def test_short_response_retries_at_confirmed_offset(self):
        def short(handler, a, end, data):
            if not a:
                handler.wfile.write(data[:103])
                return True
            return False
        self.s.hook = short
        self.cli(self.url, '-c', '1', '--retries', '1')
        self.assertEqual(self.ranges(), [None, 'bytes=103-'])
        self.assert_complete()

    def test_batch_input_file_runs_two_jobs(self):
        self.s.files['/two.bin'] = b'another payload'
        gate = threading.Barrier(2, timeout=4)
        def overlap(*unused):
            gate.wait()
            return False
        self.s.hook = overlap
        inputs = self.tmp/'input.txt'
        inputs.write_text(f'# sample\n\n{self.url}\n  # comment\n{self.base}/two.bin\n', encoding='utf-8')
        r = self.cli('-i', inputs, '-j', '2', '-c', '1')
        self.assertEqual([Path(x['path']).name for x in r['results']], ['one.bin', 'two.bin'])
        self.assertEqual((self.out/'two.bin').read_bytes(), b'another payload')
        self.assert_complete()

    def test_info_head_fallback_extended_filename_and_redirect_limit(self):
        self.s.head_status = 405
        self.s.disposition = "attachment; filename=old.bin; filename*=UTF-8''%2Fdir%2Fna%C3%AFve.bin"
        self.s.redirects['/start'] = (307, '/one.bin')
        r = self.cli('--info', self.base+'/start')
        self.assertEqual((r['finalUrl'], r['totalSize'], r['etag'], r['lastModified'], r['contentType'], r['filename'], r['acceptRanges']),
                         (self.url, len(DATA), self.s.etag, MODIFIED, 'application/octet-stream', 'na\u00efve.bin', True))
        self.assertEqual(self.ranges(), ['bytes=0-0', 'bytes=0-0'])
        self.assertFalse(self.out.exists())
        for i in range(11):
            self.s.redirects[f'/{i}'] = (301, f'/{i+1}' if i < 10 else '/one.bin')
        self.cli('--info', self.base+'/0', ok=False)
        self.cli('--info', self.base+'/1')

    def test_custom_headers_and_cross_origin_secret_stripping(self):
        other, base2 = self.origin()
        self.s.redirects['/start'] = (308, '/same-origin')
        self.s.redirects['/same-origin'] = (302, base2+'/one.bin')
        self.cli('-c', '1', '-A', 'fixture-UA', '-e', self.base+'/ref', '-H', 'X-Test: demo',
                 '-H', 'Authorization: test-value', '-H', 'Cookie: a=b', '-H', 'Proxy-Authorization: unused', self.base+'/start')
        for method, path, h in self.s.log:
            self.assertEqual((h['authorization'], h['cookie'], h['referer']), ('test-value', 'a=b', self.base+'/ref'))
        for method, path, h in other.log:
            self.assertEqual((h['x-test'], h['user-agent']), ('demo', 'fixture-UA'))
            for key in ('authorization', 'proxy-authorization', 'cookie', 'referer'):
                self.assertNotIn(key, h)
        self.assert_complete()

    def test_self_check_environment_routing_and_rate(self):
        r = self.cli('--self-check')
        self.assertEqual(r, {'ok': True, 'version': '1.1.0', 'python': sys.version.split()[0],
                             'capabilities': ['physical-nic', 'skip-proxy', 'resume', 'parallel-chunks', 'batch',
                                              'torrent', 'magnet', 'dht', 'checksum', 'rate-limit', 'extract']})
        for v, n in [('500K', 512000), ('5M', 5242880), ('1.5MB', 1572864), ('1024', 1024)]:
            self.assertEqual(dl.parse_rate(v), n)
        # Deterministic token reservations at the same instant simulate competing jobs.
        with patch.object(dl.time, 'monotonic', return_value=10), patch.object(dl.time, 'sleep') as sleep:
            bucket = dl.RateLimiter('1024')
            bucket.consume(256)
            bucket.consume(512)
            bucket.consume(512)
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [.5, 1])
        cmd = self.command(self.url, '-c', '1', '--max-rate', '5M')
        cmd.remove('--system-route')
        env = {**self.env, 'PHUKET_DIRECT_MODE': 'skip-proxy', 'PHUKET_DIRECT_INTERFACE': 'offline'}
        result = subprocess.run(cmd, env=env, cwd=self.tmp, capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_complete()

    def test_zip_extraction_and_rejected_path_does_not_escape(self):
        for name, filename in [('safe', 'sub/file.txt'), ('bad', '../../evil.txt')]:
            with io.BytesIO() as stream:
                with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as z:
                    z.writestr(filename, b'test')
                self.s.files[f'/{name}.zip'] = stream.getvalue()
            self.cli('--extract', self.base+f'/{name}.zip', ok=name == 'safe')
        self.assertEqual((self.out/'safe/sub/file.txt').read_bytes(), b'test')
        self.assertFalse((self.out/'bad').exists())
        self.assertFalse((self.tmp/'evil.txt').exists())

    def test_tar_formats_and_links(self):
        self.out.mkdir()
        for suffix, mode in [('tar', ''), ('tgz', 'gz'), ('tar.gz', 'gz'), ('tar.bz2', 'bz2'), ('tar.xz', 'xz')]:
            with self.subTest(suffix=suffix):
                path = self.out / ('a.'+suffix)
                with tarfile.open(path, 'w:'+mode) as tf:
                    entry = tarfile.TarInfo('./sub/b.txt')
                    entry.size = 1
                    tf.addfile(entry, io.BytesIO(b'z'))
                dest = dl.extract_archive(path)
                self.assertEqual((dest/'sub/b.txt').read_bytes(), b'z')
                dest.rename(self.out/('done-'+suffix))
        path = self.out/'bad.tar'
        with tarfile.open(path, 'w:') as tf:
            entry = tarfile.TarInfo('bad-link')
            entry.type, entry.linkname = tarfile.SYMTYPE, '../../outside'
            tf.addfile(entry)
        with self.assertRaises(ValueError):
            dl.extract_archive(path)
        self.assertFalse((self.out/'bad').exists())


if __name__ == '__main__':
    unittest.main()
