"""Private transport for configured Phuket Switch HTTP upstreams. Stdout is a one-line startup protocol."""
import argparse
import base64
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import select
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from direct_dns import Resolver, host_name
from direct_net import DirectRoute, list_physical_routes, pick_direct_route


def authority(value):
    match = re.fullmatch(r'(?:\[([0-9A-Fa-f:.]+)\]|([^:/\s]+)):([0-9]{1,5})', value)
    if not match or not 1 <= int(match[3]) <= 65535:
        raise ValueError('Invalid CONNECT authority.')
    host = str(ipaddress.IPv6Address(match[1])) if match[1] else host_name(match[2])
    return host, int(match[3])


def emit(data):
    print(json.dumps(data, ensure_ascii=True, separators=(',', ':')), flush=True)


IDLE_TIMEOUT = 300.
WRITE_TIMEOUT = 60.
DRAIN_TIMEOUT = 15.


def _relay(client, upstream):
    peers = {client: upstream, upstream: client}
    drain_deadline = None
    while peers:
        wait = IDLE_TIMEOUT if drain_deadline is None else drain_deadline - time.monotonic()
        if wait <= 0:
            return
        ready, _, _ = select.select(list(peers), [], [], wait)
        if not ready:
            return
        for reader in ready:
            data = reader.recv(65536)
            if not data:
                peers.pop(reader).shutdown(socket.SHUT_WR)
                if drain_deadline is None:
                    drain_deadline = time.monotonic() + DRAIN_TIMEOUT
                continue
            send_timeout = WRITE_TIMEOUT
            if drain_deadline is not None:
                send_timeout = min(send_timeout, drain_deadline - time.monotonic())
                if send_timeout <= 0:
                    return
            writer = peers[reader]
            writer.settimeout(send_timeout)
            writer.sendall(data)


def bridge_server(route, resolver, token, allowed, timeout):
    expected = b'Basic ' + base64.b64encode(('bridge:' + token).encode())

    scope_key = os.environ.pop('DIRECT_BRIDGE_SCOPE_KEY', '').encode('ascii')

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        rbufsize = 0  # Don't read past the CONNECT headers into the first TLS record.
        def setup(self):
            super().setup()
            self.connection.settimeout(timeout)

        def log_message(self, *args):
            pass

        def reject(self, code):
            self.close_connection = True
            self.send_response(code)
            if code == 407:
                self.send_header('Proxy-Authenticate', 'Basic realm="phuket-direct"')
            self.send_header('Connection', 'close')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def __getattr__(self, name):
            if name.startswith('do_'):
                return lambda: self.reject(405)
            raise AttributeError(name)

        def do_CONNECT(self):
            self.close_connection = True
            creds = self.headers.get_all('Proxy-Authorization', [])
            if len(creds) != 1 or not hmac.compare_digest(creds[0].encode('latin1'), expected):
                return self.reject(407)
            try:
                host, port = authority(self.path)
            except ValueError:
                return self.reject(400)
            # A managed desktop request signs just its authority (not headers, payload or URL).
            # This also covers unsaved provider/probe URLs without interrupting other tunnels.
            fixture = route.system_route and host in ('localhost', '127.0.0.1', '::1')
            grant = self.headers.get('X-Phuket-Direct-Target', '').encode('latin1')
            signed = scope_key and hmac.compare_digest(grant, hmac.new(scope_key, self.path.encode('latin1'), 'sha256').hexdigest().encode())
            if (host, port) not in allowed and not (fixture or signed):
                return self.reject(403)
            try:
                addresses = resolver(host, port)
                deadline = time.monotonic() + timeout
                for i, address in enumerate(addresses):
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    try:
                        upstream = route.connect(address, port, min(left, max(0.1, left / (len(addresses) - i))))
                        break
                    except OSError:
                        continue
                else:
                    raise OSError('No reachable upstream.')
                if left <= 0:
                    raise TimeoutError
            except (OSError, ValueError):
                return self.reject(502)
            with upstream:
                if not self.server.track(upstream):
                    return  # Shutdown raced with route discovery or connect.
                try:
                    self.wfile.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                    _relay(self.connection, upstream)
                except OSError:
                    pass  # Closing either end also cancels a blocked stream.
                finally:
                    self.server.untrack(upstream)

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def __init__(self, *args):
            self.clients = set()
            self.clients_lock = threading.Lock()
            self.closing = False
            super().__init__(*args)

        def track(self, sock):
            with self.clients_lock:
                if self.closing:
                    return False
                self.clients.add(sock)
                return True

        def untrack(self, sock):
            with self.clients_lock:
                self.clients.discard(sock)

        def get_request(self):
            sock, addr = super().get_request()
            if not self.track(sock):
                sock.close()
                raise OSError('Bridge is closing')
            return sock, addr

        def close_request(self, request):
            self.untrack(request)
            super().close_request(request)

        def server_close(self):
            # Shutdown wakes blocked readers and writers before releasing both handles.
            with self.clients_lock:
                self.closing = True
                active, self.clients = self.clients, set()
            for sock in active:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                sock.close()
            super().server_close()

        def handle_error(self, request, client_address):
            pass  # Client aborts and shutdown during a stream are normal; don't log request headers.

    return Server(('127.0.0.1', 0), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--inspect-routes', action='store_true')
    action.add_argument('--serve', action='store_true')
    parser.add_argument('--interface', default='')
    parser.add_argument('--dns', nargs='+', default=[])
    parser.add_argument('--system-route', action='store_true')
    parser.add_argument('--timeout', type=float, default=15.)
    args = parser.parse_args()
    try:
        if args.inspect_routes:
            routes = list_physical_routes(args.dns)
            selected = pick_direct_route(args.interface, routes=routes) if routes else None
            emit({'ok': True, 'selected': selected.to_dict() if selected else None, 'adapters': [r.to_dict() for r in routes]})
            return 0
        token = os.environ.pop('DIRECT_BRIDGE_TOKEN', '')
        if not token:
            raise ValueError('DIRECT_BRIDGE_TOKEN is required.')
        if not math.isfinite(args.timeout) or not 0 < args.timeout <= 300:
            raise ValueError('Invalid timeout.')
        allowed = {authority(a) for a in json.loads(os.environ.pop('DIRECT_BRIDGE_UPSTREAMS', '["ai.pukitcore.com:443"]'))}
        route = DirectRoute(name='System') if args.system_route else pick_direct_route(args.interface, args.dns)
        resolver = Resolver(route, system_route=route.system_route, timeout=args.timeout)
        with bridge_server(route, resolver, token, allowed, args.timeout) as server:
            def on_eof():
                while sys.stdin.buffer.read(1):
                    pass
                server.shutdown()
            threading.Thread(target=on_eof, daemon=True).start()
            emit({'ok': True, 'port': server.server_port, 'route': route.to_dict()})
            server.serve_forever(poll_interval=.1)
        return 0
    except Exception:
        # Don't echo arguments, environment, or upstream error text into the startup protocol.
        message = 'DIRECT_BRIDGE_TOKEN is required.' if not args.inspect_routes and not locals().get('token') else 'Direct route unavailable; check the adapter and DNS settings.'
        emit({'ok': False, 'error': message, **({'selected': None, 'adapters': []} if args.inspect_routes else {})})
        return 1


if __name__ == '__main__':
    sys.exit(main())
