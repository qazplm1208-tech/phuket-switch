"""在指定 Windows 物理网卡上建立 TCP/UDP，按原域名校验 HTTP(S) 单跳请求。"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from functools import lru_cache
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import socket
import ssl
import struct
import subprocess
import sys
import time
from urllib.parse import quote, urlsplit


# 固定只读命令，网卡名称不拼进命令行。
_QUERY = """
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$physical = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface -and -not $_.Virtual })
$routes = @(Get-NetRoute -PolicyStore ActiveStore | Where-Object { $_.DestinationPrefix -in '0.0.0.0/0','::/0' -and $_.State -ne 'Dead' })
$interfaces = @(Get-NetIPInterface -PolicyStore ActiveStore)
$ips = @(Get-NetIPAddress -PolicyStore ActiveStore | Where-Object { $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource })
$dns = @(Get-DnsClientServerAddress)
$rows = @(foreach ($a in $physical) {
    $idx = $a.InterfaceIndex
    $options = @(foreach ($r in $routes) {
        if ($r.InterfaceIndex -ne $idx -or $r.NextHop -in '','0.0.0.0','::') { continue }
        $metric = $interfaces | Where-Object { $_.InterfaceIndex -eq $idx -and $_.AddressFamily -eq $r.AddressFamily } | Select-Object -First 1 -ExpandProperty InterfaceMetric
        [pscustomobject]@{family=[int]$r.AddressFamily; metric=([long]$r.RouteMetric + [long]$metric); gateway=[string]$r.NextHop}
    })
    [pscustomobject]@{name=[string]$a.Name; description=[string]$a.InterfaceDescription; index=[int]$idx; routes=$options;
        addresses=@($ips | Where-Object InterfaceIndex -eq $idx | ForEach-Object { [string]$_.IPAddress });
        dns=@($dns | Where-Object InterfaceIndex -eq $idx | ForEach-Object { $_.ServerAddresses })}
})
ConvertTo-Json -InputObject $rows -Depth 5 -Compress
"""


def _windows_adapters():
    if sys.platform != "win32":
        raise OSError("自动绑定物理网卡需要 Windows；其他系统可显式使用 --system-route。")
    exe = (Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" /
           "WindowsPowerShell" / "v1.0" / "powershell.exe")
    encoded = base64.b64encode(_QUERY.encode("utf-16le")).decode("ascii")
    try:
        p = subprocess.run([str(exe), "-NoLogo", "-NoProfile", "-NonInteractive",
                            "-EncodedCommand", encoded], capture_output=True, timeout=30,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if p.returncode:
            raise OSError("读取 Windows 网卡、默认路由或 DNS 配置失败。")
        rows = json.loads(p.stdout.decode("utf-8-sig"))
        if not isinstance(rows, list):
            raise ValueError
        return rows
    except (ValueError, UnicodeError, subprocess.TimeoutExpired, FileNotFoundError):
        raise OSError("无法从 Windows 获取物理网卡配置。") from None


def _ip(value):
    # 数值地址避免套接字暗中触发第二次、未绑定网卡的域名解析。
    try:
        return ipaddress.ip_address(str(value))
    except ValueError:
        raise ValueError("连接目标必须是 IPv4 或 IPv6 数值地址。") from None


@dataclass(frozen=True)
class DirectRoute:
    index: int | None = None
    name: str = ""
    ipv4: str | None = None
    ipv6: str | None = None
    ipv6_link: str | None = None
    dns_servers: tuple[str, ...] = ()

    adapter_description: str = ""
    gateway: str | None = None
    metric: int | None = None

    def to_dict(self):
        return {"index": self.index, "name": self.name, "description": self.adapter_description or self.describe(),
                "ipv4": self.ipv4, "ipv6": self.ipv6, "gateway": self.gateway, "dnsServers": list(self.dns_servers),
                "metric": self.metric, "systemRoute": self.system_route}

    @property
    def system_route(self):
        return self.index is None

    @property
    def has_ipv4(self):
        return self.system_route or self.ipv4 is not None

    @property
    def has_ipv6(self):
        return self.system_route or self.ipv6 is not None

    @property
    def families(self):
        return tuple(f for f, present in ((socket.AF_INET, self.has_ipv4),
                                          (socket.AF_INET6, self.has_ipv6)) if present)

    def describe(self):
        if self.system_route:
            return "系统路由（不用应用代理，未绑定物理网卡）"
        return f"物理网卡 {self.name}（索引 {self.index}）"

    @property
    def description(self):
        return self.describe()

    def __str__(self):
        return self.describe()

    def connect(self, ip, port, timeout):
        return self._connect(ip, port, timeout, socket.SOCK_STREAM)

    def connect_udp(self, ip, port, timeout):
        return self._connect(ip, port, timeout, socket.SOCK_DGRAM)

    def _connect(self, ip, port, timeout, socktype):
        dest = _ip(ip)
        if not (1 <= port <= 65535) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("端口或连接超时无效。")
        if dest.is_unspecified or dest.is_multicast:
            raise OSError("目标不是可用的单播地址。")
        if not self.system_route and dest.is_loopback:
            raise OSError("回环地址不能通过物理网卡连接。")
        family = socket.AF_INET if dest.version == 4 else socket.AF_INET6
        numeric = str(dest).split("%", 1)[0]
        scope = 0
        if dest.version == 6 and dest.scope_id:
            try:
                scope = (int(dest.scope_id) if dest.scope_id.isdecimal()
                         else socket.if_nametoindex(dest.scope_id))
            except (ValueError, OSError):
                raise OSError("目标的 IPv6 区域编号无效。") from None
            if self.index is not None and scope != self.index:
                raise OSError("目标 IPv6 区域不属于选定的物理网卡。")
        sock = socket.socket(family, socktype)
        try:
            sock.settimeout(timeout)
            if self.index is not None:
                # Winsock 的 IPv4 接口索引用网络字节序，IPv6 使用主机字节序。
                if family == socket.AF_INET:
                    if not self.ipv4:
                        raise OSError("选定物理网卡没有可用的 IPv4 路由和地址。")
                    sock.setsockopt(socket.IPPROTO_IP, getattr(socket, "IP_UNICAST_IF", 31),
                                    struct.pack("!I", self.index))
                    sock.bind((self.ipv4, 0))
                else:
                    local = self.ipv6_link if dest.is_link_local else self.ipv6
                    if not local:
                        raise OSError("选定物理网卡没有适用的 IPv6 路由和地址。")
                    sock.setsockopt(socket.IPPROTO_IPV6, getattr(socket, "IPV6_UNICAST_IF", 31),
                                    struct.pack("=I", self.index))
                    sock.bind((local, 0, 0, self.index if dest.is_link_local else 0))
                    if dest.is_link_local:
                        scope = self.index
            sock.connect((numeric, port) if family == socket.AF_INET else (numeric, port, 0, scope))
            return sock
        except BaseException:
            sock.close()
            raise


def list_physical_routes(custom_dns: list[str] | None = None) -> list[DirectRoute]:
    if custom_dns and (len(custom_dns) > 4 or any(_ip(s).is_unspecified or _ip(s).is_multicast or _ip(s).is_loopback for s in custom_dns)):
        raise ValueError("指定的物理网卡 DNS 地址无效。")
    matches = []
    for a in _windows_adapters():
        idx, name = int(a["index"]), str(a["name"])
        metrics, gateways = {}, {}
        for r in a["routes"]:
            family, metric = int(r["family"]), int(r["metric"])
            if family not in metrics or metric < metrics[family]:
                metrics[family], gateways[family] = metric, r.get("gateway")
        addresses = [_ip(s) for s in a["addresses"]]
        unicast = [ip for ip in addresses if not (ip.is_unspecified or ip.is_loopback or ip.is_multicast)]

        def source(version, link=False):
            opts = [ip for ip in unicast if ip.version == version and ip.is_link_local == link]
            # IPv6 同时分配公网和 ULA 地址时优先公网源地址。
            opts.sort(key=lambda ip: not ip.is_global)
            return str(opts[0]).split("%", 1)[0] if opts else None

        v4 = source(4) if socket.AF_INET in metrics else None
        v6 = source(6) if socket.AF_INET6 in metrics else None
        if not (v4 or v6):
            continue
        v6_link = source(6, True)
        dns = []
        for server in custom_dns or a["dns"]:
            try:
                ip = _ip(server)
            except ValueError:
                continue
            if ip.is_loopback or ip.is_unspecified or ip.is_multicast:
                continue
            if (ip.version == 4 and v4) or (ip.version == 6 and (v6_link if ip.is_link_local else v6)):
                if str(ip) not in dns:
                    dns.append(str(ip))
        family = socket.AF_INET if v4 else socket.AF_INET6
        matches.append(DirectRoute(idx, name, v4, v6, v6_link, tuple(dns), str(a.get('description', '')), gateways[family], metrics[family]))
    return sorted(matches, key=lambda r: (not bool(r.ipv4), r.metric, r.index))


def pick_direct_route(interface_name=None, custom_dns=None, *, routes=None):
    choices = list_physical_routes(custom_dns) if routes is None else routes
    for route in choices:
        if not interface_name or str(interface_name).casefold() in (str(route.index), route.name.casefold()):
            return route
    raise OSError("没有匹配到在线、有默认网关和可用地址的物理网卡。请检查网卡名称或编号。")


@lru_cache(maxsize=1)
def _tls_context():
    ctx = ssl.create_default_context()
    ctx.set_alpn_protocols(["http/1.1"])
    return ctx


class RouteConnectError(OSError):
    """All candidate connections failed before an HTTP request could be sent."""
    route_connect_failed = True


class DirectHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, *, route, resolver, timeout):
        super().__init__(host, port, timeout=timeout)
        self.route, self.resolver = route, resolver

    def connect(self):
        candidates = self.resolver(self.host, self.port)
        deadline = time.monotonic() + self.timeout
        last_error = None
        for i, ip in enumerate(candidates):
            left = deadline - time.monotonic()
            if left <= 0:
                break
            try:
                self.sock = self.route.connect(ip, self.port, min(left, max(1, left / (len(candidates) - i))))
                self.sock.settimeout(self.timeout)
                return
            except OSError as exc:
                last_error = exc
        if last_error is not None:
            raise RouteConnectError(last_error.errno, f'Selected route could not connect: {last_error}') from last_error
        raise OSError('No reachable address for the configured API on the selected route.')


class DirectHTTPSConnection(DirectHTTPConnection):
    def connect(self):
        super().connect()
        try:
            self.sock = _tls_context().wrap_socket(self.sock, server_hostname=self.host)
        except BaseException:
            self.close()
            raise


def direct_http_request(url, method="GET", headers=None, body=None, timeout=15.0, route=None, resolver=None) -> tuple[int, dict[str, str], bytes]:
    """One HTTP hop. Do not redirect or replay a body; bound buffered responses to the MCP limit."""
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 or c == '\\' for c in url):
        raise ValueError('Invalid API URL.')
    u = urlsplit(url)
    if u.scheme not in ('https', 'http') or not u.hostname or u.username is not None or u.password is not None:
        raise ValueError('Expected an HTTP(S) URL without credentials.')
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('Invalid timeout.')
    port = u.port if u.port is not None else (443 if u.scheme == 'https' else 80)
    if not 1 <= port <= 65535:
        raise ValueError('Invalid port.')
    headers = headers or {}
    if any(k.lower() in ('host', 'proxy-authorization', 'proxy-connection') for k in headers):
        raise ValueError('Host and proxy headers are not accepted.')
    if route is None:
        route = pick_direct_route()
    if resolver is None:
        from direct_dns import Resolver
        resolver = Resolver(route, system_route=route.system_route)
    cls = DirectHTTPSConnection if u.scheme == 'https' else DirectHTTPConnection
    conn = cls(u.hostname.encode('idna').decode('ascii'), port, route=route, resolver=resolver, timeout=timeout)
    target = quote(u.path or '/', safe="/:!$&'()*+,;=@%[]~")
    if u.query:
        target += '?' + quote(u.query, safe="/:!$&'()*+,;=@%[]~?")
    connected = False
    try:
        conn.connect()
        connected = True
        conn.request(method, target, body=body, headers=headers)
        with conn.getresponse() as response:
            data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError('Upstream response too large.')
            return response.status, dict(response.getheaders()), data
    except OSError as exc:
        if connected:
            exc.route_request_started = True  # A POST may have already reached the upstream.
        raise
    finally:
        conn.close()
