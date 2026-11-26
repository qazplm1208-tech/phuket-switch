"""用所选网卡解析域名；DNS 结果只在当前进程中保存。"""

import ipaddress
import secrets
import socket
import struct
import time


def host_name(value):
    value = value.rstrip(".")
    if not value or "%" in value:
        raise ValueError("主机名为空或包含不支持的区域标记。")
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        pass
    try:
        name = value.encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise ValueError("域名格式无效。") from None
    labels = name.split(".")
    if len(name) > 253 or any(not (0 < len(s) <= 63 and s[0].isalnum() and s[-1].isalnum()
                               and all(c.isalnum() or c == "-" for c in s)) for s in labels):
        raise ValueError("域名格式无效。")
    return name


def _name(data, pos):
    labels, seen, end, length = [], set(), None, 0
    while pos < len(data) and pos not in seen and len(seen) < 128:
        seen.add(pos)
        size = data[pos]
        pos += 1
        if size == 0:
            return ".".join(labels).lower(), pos if end is None else end
        if size & 0xC0 == 0xC0:
            if pos >= len(data):
                break
            if end is None:
                end = pos + 1
            pos = ((size & 0x3F) << 8) | data[pos]
        elif size <= 63 and pos + size <= len(data):
            label = data[pos:pos + size].decode("ascii")
            if "." in label or not label.isprintable():
                break
            labels.append(label)
            length += size + 1
            if length > 254:
                break
            pos += size
        else:
            break
    raise ValueError("无效的 DNS 名称。")


def _read_exact(stream, length):
    data = bytearray()
    while len(data) < length:
        part = stream.recv(length - len(data))
        if not part:
            raise OSError("DNS 连接提前关闭。")
        data.extend(part)
    return bytes(data)


class _NameNotFound(OSError):
    """NXDOMAIN applies to the name, not just the requested record type."""


def _parse(packet, ident, host, kind):
    token, flags, questions, answers, _, _ = struct.unpack_from("!6H", packet)
    if token != ident or flags & 0x7800 or not flags & 0x8000 or questions != 1:
        raise ValueError("DNS 应答与查询不匹配。")
    name, at = _name(packet, 12)
    if name != host or struct.unpack_from("!HH", packet, at) != (kind, 1):
        raise ValueError("DNS 应答域名或类型不匹配。")
    if flags & 0x0200:
        return None
    if (flags & 15) not in (0, 3):
        raise OSError("DNS 服务器未能完成查询。")
    if (flags & 15) == 3:
        raise _NameNotFound(f'NXDOMAIN: {host}')
    at += 4
    aliases, values = {}, {}
    for _ in range(answers):
        owner, at = _name(packet, at)
        typ, cls, ttl, size = struct.unpack_from("!HHIH", packet, at)
        at += 10
        stop = at + size
        if stop > len(packet):
            raise ValueError("DNS 记录不完整。")
        if cls == 1 and typ == 5:
            alias, next_byte = _name(packet, at)
            if next_byte != stop:
                raise ValueError("DNS 别名长度无效。")
            aliases[owner] = (host_name(alias), ttl)
        if cls == 1 and typ == kind and size == (4 if kind == 1 else 16):
            values.setdefault(owner, []).append((str(ipaddress.ip_address(packet[at:stop])), ttl))
        at = stop
    ttl, seen = 120, set()
    while host in aliases:
        if host in seen or len(seen) >= 12:
            raise ValueError("DNS 别名形成循环。")
        seen.add(host)
        host, alias_ttl = aliases[host]
        ttl = min(ttl, alias_ttl)
    entries = values.get(host, ())
    return [ip for ip, _ in entries], host, min([ttl] + [t for _, t in entries])


def _query(route, server, host, kind, timeout):
    ident = secrets.randbits(16)
    q = struct.pack("!6H", ident, 0x0100, 1, 0, 0, 0)
    q += b"".join(bytes([len(label)]) + label.encode("ascii") for label in host.split("."))
    q += b"\x00" + struct.pack("!HH", kind, 1)
    with route.connect_udp(server, 53, timeout) as sock:
        sock.send(q)
        result = _parse(sock.recv(65535), ident, host, kind)
    if result is not None:
        return result
    # 应答截断时，只通过原网卡向同一服务器重试 TCP。
    with route.connect(server, 53, timeout) as sock:
        sock.sendall(struct.pack("!H", len(q)) + q)
        size = struct.unpack("!H", _read_exact(sock, 2))[0]
        result = _parse(_read_exact(sock, size), ident, host, kind)
    if result is None:
        raise OSError("DNS 的 TCP 应答仍被截断。")
    return result


class Resolver:
    def __init__(self, route, *, system_route=False, servers=(), pins=None, timeout=3):
        self.route = route
        self.system_dns = system_route and not servers
        self.servers = tuple(dict.fromkeys(servers or getattr(route, "dns_servers", ())))
        self.pins = pins or {}
        self.timeout = min(float(timeout), 3)
        self.cache = {}

    def _records(self, host, kind):
        last_error = None
        for server in self.servers:
            name, seen, ttl = host, set(), 120
            try:
                while name not in seen and len(seen) < 12:
                    seen.add(name)
                    items, alias, expires = _query(self.route, server, name, kind, self.timeout)
                    ttl = min(ttl, expires)
                    if items:
                        return items, ttl
                    if name == alias:
                        return [], 0  # NODATA: definitive for this record type.
                    name = alias
            except _NameNotFound:
                raise
            except (OSError, ValueError, struct.error) as exc:
                last_error = exc
        if isinstance(last_error, OSError):
            raise last_error
        return [], 0

    def __call__(self, host, port):
        name = host_name(host)
        if name in self.pins:
            return self.pins[name]
        try:
            return [str(ipaddress.ip_address(name))]
        except ValueError:
            pass
        if self.system_dns:
            try:
                return list(dict.fromkeys(x[4][0] for x in socket.getaddrinfo(name, port, type=socket.SOCK_STREAM)))
            except OSError:
                raise OSError(f"系统 DNS 无法解析 {name}。") from None
        if not self.servers:
            raise OSError("物理网卡没有提供可用 DNS；请用 --dns 指定服务器，或 --resolve 指定该域名的 IP。")
        cached = self.cache.get(name)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        last_error = None
        items, ttls = [], []
        for kind, family in ((1, socket.AF_INET), (28, socket.AF_INET6)):
            if family not in self.route.families:
                continue
            try:
                found, ttl = self._records(name, kind)
            except _NameNotFound:
                raise
            except OSError as exc:
                last_error = exc
                continue
            if found:
                items.extend(found)
                ttls.append(ttl)
        if not items:
            if last_error is not None:
                raise last_error
            raise OSError(f"通过所选网卡未解析到 {name} 的可用地址。可用 --dns 指定服务器，或 --resolve 指定该域名的 IP。")
        ips = tuple(dict.fromkeys(items))
        self.cache[name] = (time.monotonic() + min(ttls), ips)
        return ips
