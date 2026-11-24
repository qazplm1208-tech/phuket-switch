import base64
import http.client
import io
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import direct_bridge as bridge
import direct_dns as dns
import direct_net as net


class RouteTests(unittest.TestCase):
    def test_dns_wire_codec_and_truncated_udp_retries_same_bound_server(self):
        ident, host = 0x1234, 'relay.example'
        question = b'\x05relay\x07example\0' + struct.pack('!HH', 1, 1)
        query = struct.pack('!6H', ident, 0x0100, 1, 0, 0, 0) + question
        truncated = struct.pack('!6H', ident, 0x8380, 1, 0, 0, 0) + question
        answer = (struct.pack('!6H', ident, 0x8180, 1, 1, 0, 0) + question + b'\xc0\x0c'
                  + struct.pack('!HHIH', 1, 1, 45, 4) + socket.inet_aton('192.0.2.80'))
        route = MagicMock()
        udp = route.connect_udp.return_value.__enter__.return_value
        tcp = route.connect.return_value.__enter__.return_value
        udp.recv.return_value = truncated
        tcp.recv.side_effect = [struct.pack('!H', len(answer)), answer[:15], answer[15:]]
        with patch.object(dns.secrets, 'randbits', return_value=ident):
            self.assertEqual(dns._query(route, '192.0.2.53', host, 1, 1.5), (['192.0.2.80'], host, 45))
        route.connect_udp.assert_called_once_with('192.0.2.53', 53, 1.5)
        route.connect.assert_called_once_with('192.0.2.53', 53, 1.5)
        udp.send.assert_called_once_with(query)
        tcp.sendall.assert_called_once_with(struct.pack('!H', len(query)) + query)
        with self.assertRaises(ValueError):
            dns._parse(answer, ident + 1, host, 1)
        with self.assertRaises(ValueError):
            dns._name(b'\xc0\x00', 0)

    def test_read_only_powershell_json_route_selection_and_filtering(self):
        def row(idx, metric, family, ip):
            return dict(name=f'nic{idx}', description=f'adapter {idx}', index=idx, addresses=[ip, '127.0.0.1'],
                        routes=[dict(family=int(family), metric=metric, gateway='192.0.2.1' if family == socket.AF_INET else 'fe80::1')],
                        dns=['127.0.0.1', 'invalid', '192.0.2.53', '2001:db8::53'])
        rows = [row(2, 1, socket.AF_INET6, '2001:db8::2'), row(7, 70, socket.AF_INET, '192.0.2.7'),
                row(6, 4, socket.AF_INET, '192.0.2.6'), row(5, 4, socket.AF_INET, '192.0.2.5'),
                row(8, 1, socket.AF_INET, '127.0.0.1'), {**row(9, 0, socket.AF_INET, '192.0.2.9'), 'routes': []}]
        completed = subprocess.CompletedProcess([], 0, json.dumps(rows).encode())
        with patch.object(net.sys, 'platform', 'win32'), patch.object(net.subprocess, 'run', return_value=completed) as ps:
            routes = net.list_physical_routes()
            self.assertEqual([r.index for r in routes], [5, 6, 7, 2])
            self.assertEqual(routes[0].to_dict(), dict(name='nic5', description='adapter 5', index=5, ipv4='192.0.2.5', ipv6=None,
                                                       gateway='192.0.2.1', dnsServers=['192.0.2.53'], metric=4, systemRoute=False))
            self.assertEqual(net.pick_direct_route('NIC7', ['192.0.2.54']).dns_servers, ('192.0.2.54',))
            self.assertEqual(net.pick_direct_route('2', routes=routes).ipv6, '2001:db8::2')
            with self.assertRaises(OSError):
                net.pick_direct_route('unavailable', routes=routes)
        command = base64.b64decode(ps.call_args.args[0][-1]).decode('utf-16le')
        for condition in ['Get-NetAdapter -Physical', "Status -eq 'Up'", 'HardwareInterface', '-not $_.Virtual', '-PolicyStore ActiveStore', "State -ne 'Dead'"]:
            self.assertIn(condition, command)
        self.assertNotIn('NIC7', command)

    def test_inspect_error_is_a_single_json_record(self):
        with patch.object(bridge.sys, 'argv', ['bridge', '--inspect-routes']), patch.object(net.sys, 'platform', 'unsupported'), patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertNotEqual(bridge.main(), 0)
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        result = json.loads(lines[0]); self.assertFalse(result['ok']); self.assertIsNone(result['selected']); self.assertEqual(result['adapters'], [])

    def test_authority(self):
        for raw, parsed in [('RELAY.EXAMPLE:443', ('relay.example', 443)), ('127.0.0.1:1', ('127.0.0.1', 1)), ('[::1]:65535', ('::1', 65535))]:
            self.assertEqual(bridge.authority(raw), parsed)
        for bad in ['host:0', 'host:65536', 'host', 'a@b:80', '::1:80', 'bad/path:443']:
            with self.assertRaises(ValueError):
                bridge.authority(bad)


class LiveBridgeTests(unittest.TestCase):
    def setUp(self):
        self.cmd = [sys.executable, '-I', '-S', '-B', '-u', str(Path(bridge.__file__).resolve()), '--serve', '--system-route', '--timeout', '0.5']
        self.token = secrets.token_hex(32)
        self.env = {k: v for k, v in os.environ.items() if not k.upper().startswith('DIRECT_BRIDGE_')}

    def start(self):
        child = subprocess.Popen(self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={**self.env, 'DIRECT_BRIDGE_TOKEN': self.token})
        def cleanup():
            if child.poll() is None:
                child.kill()
            child.wait(5)
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()
        self.addCleanup(cleanup)
        startup, ready = [], threading.Event()
        def read_startup():
            startup.append(child.stdout.readline()); ready.set()
        threading.Thread(target=read_startup, daemon=True).start()
        self.assertTrue(ready.wait(5), 'no startup record')
        self.assertNotIn(self.token.encode(), startup[0]); data = json.loads(startup[0]); self.assertTrue(data['ok']); self.assertTrue(data['route']['systemRoute'])
        return child, data['port']

    def test_token_required_and_bad_or_missing_connect_auth_rejected(self):
        missing = subprocess.run(self.cmd, env=self.env, input=b'', capture_output=True, timeout=5)
        self.assertNotEqual(missing.returncode, 0); self.assertFalse(json.loads(missing.stdout)['ok']); self.assertEqual(missing.stderr, b'')
        child, port = self.start()
        for method, target, auth, expected in [('CONNECT', 'localhost:1', {}, 407), ('CONNECT', 'localhost:1', {'Proxy-Authorization': 'Basic wrong'}, 407),
                                              ('GET', '/', {}, 405), ('CONNECT', 'not-configured.invalid:80', {'Proxy-Authorization': self.auth()}, 403)]:
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
            try:
                conn.request(method, target, headers=auth)
                with conn.getresponse() as res:
                    self.assertEqual(res.status, expected)
                    if expected == 407:
                        self.assertEqual(res.getheader('Proxy-Authenticate'), 'Basic realm="phuket-direct"')
            finally:
                conn.close()
        child.stdin.close(); self.assertEqual(child.wait(5), 0); self.assertEqual(child.stderr.read(), b'')

    def auth(self):
        return 'Basic ' + base64.b64encode(('bridge:' + self.token).encode()).decode()

    def test_incremental_sse_survives_idle_and_stdin_eof_closes_open_tunnel(self):
        resume, finish = threading.Event(), threading.Event()
        class Source(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                self.wfile.write(b'data: first\n\n'); self.wfile.flush()
                if resume.wait(5):
                    self.wfile.write(b'data: second\n\n'); self.wfile.flush()
                finish.wait(5)
            def log_message(self, *args):
                pass
        src = ThreadingHTTPServer(('127.0.0.1', 0), Source)
        threading.Thread(target=src.serve_forever, daemon=True).start()
        self.addCleanup(src.server_close); self.addCleanup(src.shutdown); self.addCleanup(finish.set); self.addCleanup(resume.set)
        child, port = self.start()
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=4)
        self.addCleanup(conn.close)
        conn.set_tunnel('localhost', src.server_port, {'Proxy-Authorization': self.auth()}); conn.request('GET', '/events')
        with conn.getresponse() as res:
            self.assertEqual(res.status, 200); self.assertEqual(res.readline(), b'data: first\n'); self.assertEqual(res.readline(), b'\n')
            time.sleep(.7)  # Longer than the configured handshake timeout.
            resume.set(); self.assertEqual(res.readline(), b'data: second\n'); self.assertEqual(res.readline(), b'\n')
            child.stdin.close(); self.assertEqual(child.wait(5), 0); self.assertEqual(res.read(), b'')
        self.assertEqual(child.stdout.read(), b''); self.assertEqual(child.stderr.read(), b'')


if __name__ == '__main__':
    unittest.main()
