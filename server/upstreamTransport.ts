import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError, isRecord } from './common.js';

const runFile = promisify(execFile);
const settingsKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const unbracket = (host: string) => host.replace(/^\[|\]$/g, '');
const portOf = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80');
function proxyAddress(raw?: string): URL | undefined {
  const value = raw?.trim();
  if (!value || /[\s\\]/.test(value)) return;
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (/^https?:$/.test(url.protocol) && url.hostname && url.pathname === '/' && !url.search && !url.hash) return url;
  } catch { /* Ignore invalid or unsupported proxy settings. */ }
}
export function parseWindowsProxyServer(value: string, protocol: string): URL | undefined {
  const entries = value.split(';').map(s => s.trim());
  const prefix = protocol.replace(/:$/, '').toLowerCase() + '=';
  const specific = entries.find(s => s.toLowerCase().startsWith(prefix));
  return proxyAddress(specific ? specific.slice(prefix.length) : entries.find(s => s && !s.includes('=')));
}
export function parseInternetSettings(output: string) {
  if (!/^\s*ProxyEnable\s+REG_DWORD\s+(?:0x0*1|1)\s*$/im.test(output)) return null;
  const setting = (name: string) => new RegExp(`^\\s*${name}\\s+REG_SZ[ \\t]+([^\\r\\n]+)`, 'im').exec(output)?.[1]?.trim() ?? '';
  return { server: setting('ProxyServer'), bypass: setting('ProxyOverride') };
}
let registryCache: { expires: number; value: Promise<ReturnType<typeof parseInternetSettings>> } | undefined;
function windowsSettings() {
  if (process.platform !== 'win32') return null;
  if (!registryCache || registryCache.expires <= Date.now()) {
    const value = runFile('reg.exe', ['query', settingsKey], { windowsHide: true, timeout: 1500, maxBuffer: 256 * 1024 })
      .then(({ stdout }) => parseInternetSettings(stdout), () => null);
    registryCache = { expires: Date.now() + 10_000, value };
  }
  return registryCache.value;
}
export function isLoopbackUrl(url: URL) {
  const host = unbracket(url.hostname.toLowerCase()).replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || (isIP(host) === 4 && host.startsWith('127.')) || host === '::1' || /^::ffff:7f[\da-f]{2}:/.test(host);
}
export const connectAuthority = (url: URL) => `${url.hostname}:${portOf(url)}`;
export type DirectPolicy = { kind: 'skip-proxy' } | { kind: 'bridge'; proxyUrl: URL; authorityGrant?: string };
type PolicyResolver = (url: URL, signal?: AbortSignal) => Promise<DirectPolicy | undefined>;
const resolvers = new Set<PolicyResolver>();
export function setDirectBypassResolver(resolver: PolicyResolver) {
  resolvers.add(resolver);
  return () => { resolvers.delete(resolver); };
}
function bypassesProxy(url: URL, list: string) {
  const host = unbracket(url.hostname.toLowerCase()).replace(/\.$/, '');
  if (isLoopbackUrl(url)) return true;
  return list.toLowerCase().split(/[,;\s]+/).some(entry => {
    if (!entry) return false;
    if (entry === '*' || (entry === '<local>' && !host.includes('.') && !isIP(host))) return true;
    const [, pattern, port] = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry) ?? [];
    if (!pattern || (port && port !== portOf(url))) return false;
    const suffix = unbracket(pattern).replace(/^\*?\./, '');
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}
function envProxy(url: URL) {
  const env = process.env;
  return proxyAddress((url.protocol === 'https:' && (env.https_proxy || env.HTTPS_PROXY)) || env.http_proxy || env.HTTP_PROXY);
}
function nativeEnvProxy(url: URL) {
  return process.env.NODE_USE_ENV_PROXY === '1' || /(?:^|\s)--use-env-proxy(?:\s|$)/.test([process.env.NODE_OPTIONS, ...process.execArgv].join(' ')) ? envProxy(url) : undefined;
}
// undefined: no alternate route. null: force direct rather than reusing Node's env proxy.
async function alternateRoute(url: URL): Promise<URL | null | undefined> {
  const env = envProxy(url);
  const usedEnv = !!nativeEnvProxy(url);
  if (env && env.href !== proxyAddress(process.env.PHUKET_SYSTEM_PROXY)?.href) return usedEnv ? null : env;
  // Electron's proxy is a startup snapshot. A user may since have changed ports or stopped the proxy.
  const settings = await windowsSettings();
  if (settings && bypassesProxy(url, settings.bypass)) return usedEnv ? null : undefined;
  const live = settings && parseWindowsProxyServer(settings.server, url.protocol);
  if (live && (!usedEnv || live.href !== env?.href)) return live;
  return usedEnv ? null : env;
}
export function networkTags(error: unknown): string[] {
  const tags: string[] = [], pending = [error], seen = new Set<unknown>();
  while (pending.length && seen.size < 24) {
    const e = pending.shift();
    if (!isRecord(e) || seen.has(e)) continue;
    seen.add(e);
    for (const tag of [e.name, e.code]) if (typeof tag === 'string') tags.push(tag);
    if (e.cause) pending.push(e.cause);
    if (Array.isArray(e.errors)) pending.push(...e.errors.slice(0, 12));
  }
  return tags;
}
const preDeliveryCodes = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
export function isPreDeliveryNetworkError(error: unknown): boolean {
  // Every leaf of an AggregateError must confirm the request could not have been delivered.
  let budget = 24;
  function confirmed(e: unknown): boolean {
    if (--budget < 0 || !isRecord(e)) return false;
    const known = preDeliveryCodes.has(e.code);
    if (e.code !== undefined && !known) return false;
    if (e.cause != null && !confirmed(e.cause)) return false;
    const children = Array.isArray(e.errors) && e.errors.length > 0;
    return (!children || e.errors.every(confirmed)) && (known || e.cause != null || children);
  }
  return confirmed(error);
}
function tunnel(target: URL, proxy: URL, signal: AbortSignal, authorityGrant?: string) {
  return new Promise<Socket>((resolve, reject) => {
    const authority = connectAuthority(target);
    const headers: Record<string, string> = { host: authority };
    if (authorityGrant) headers['x-phuket-direct-target'] = authorityGrant;
    if (proxy.username || proxy.password) headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    const connect = (proxy.protocol === 'https:' ? https : http).request({ hostname: unbracket(proxy.hostname), port: portOf(proxy), method: 'CONNECT', path: authority, headers, signal, agent: false });
    connect.once('error', reject);
    connect.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy(); reject(new ApiError(502, 'UPSTREAM_PROXY', res.statusCode === 407 ? '代理要求身份验证，请检查代理账号和密码。' : `代理未能建立连接（HTTP ${res.statusCode}），请检查代理设置。`)); return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    connect.end();
  });
}
async function nodeRequest(url: URL, init: RequestInit, signal: AbortSignal, proxy?: URL | null, authorityGrant?: string): Promise<Response> {
  signal.throwIfAborted();
  const secure = url.protocol === 'https:', headers = new Headers(init.headers);
  headers.delete('proxy-authorization'); headers.set('accept-encoding', 'identity');
  if (init.body != null && typeof init.body !== 'string' && !(init.body instanceof Uint8Array)) throw new TypeError('Expected a string or byte request body');
  const socket = proxy ? await tunnel(url, proxy, signal, authorityGrant) : undefined;
  try {
    signal.throwIfAborted();
    const host = unbracket(url.hostname);
    return await new Promise<Response>((resolve, reject) => {
      const req = (secure ? https : http).request(url, { method: init.method, headers: Object.fromEntries(headers), signal,
        ...(socket ? { createConnection: () => secure ? tls.connect({ socket, host, servername: isIP(host) ? undefined : host, rejectUnauthorized: true }) : socket } : { agent: false }),
      }, res => {
        const fields = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) fields.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const status = res.statusCode!, empty = init.method === 'HEAD' || [204, 205, 304].includes(status);
        if (empty) res.resume();
        resolve(new Response(empty ? null : Readable.toWeb(res), { status, headers: fields }));
      });
      req.once('error', reject); req.end(init.body ?? undefined);
    });
  } catch (e) { socket?.destroy(); throw e; }
}

// Shared bounded reader: a login retry must not buffer an arbitrary proxy/HTML response.
export async function readBodyBytes(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let length = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new ApiError(502, 'UPSTREAM_ERROR', '上游响应过大。'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally { reader.releaseLock(); }
}
const jsonMime = (response: Response) => /^(?:application|text)\/(?:[\w.+-]+\+)?json$/i.test((response.headers.get('content-type') ?? '').split(';')[0].trim());
function proxyCannotConnect(response: Response, proxy: URL) {
  if (![403, 503].includes(response.status) || jsonMime(response) || response.headers.has('cf-mitigated') || response.headers.has('www-authenticate') || response.headers.has('proxy-authenticate')) return false;
  // RFC 9209: require the configured proxy itself to report a pre-delivery failure.
  // A site's 403, a proxy policy refusal, or a browser challenge is not a connection failure.
  const lastHop = response.headers.get('proxy-status')?.split(',').at(-1);
  if (!lastHop) return false;
  const [id, ...params] = lastHop.split(';').map(s => s.trim().toLowerCase());
  return [proxy.host, proxy.hostname].includes(id.replace(/^"|"$/g, '')) && params.some(s => /^error=(?:connection_refused|connection_timeout|dns_error|destination_unavailable)$/.test(s));
}
async function directLoginAfterProxyError(url: URL, init: RequestInit, signal: AbortSignal, original: Response) {
  // Keep the original status and edge metadata, not its HTML or stale body length.
  const headers = new Headers(original.headers);
  for (const field of ['content-length', 'content-encoding', 'set-cookie']) headers.delete(field);
  const fallback = new Response(null, { status: original.status, headers });
  await original.body?.cancel();
  try {
    const direct = await nodeRequest(url, init, signal, null);
    if (direct.status === 204) return direct;
    if (!jsonMime(direct) && !direct.ok) { await direct.body?.cancel(); return fallback; }
    const bytes = await readBodyBytes(direct, 1024 * 1024);
    if (!bytes.length && direct.ok && direct.headers.has('set-cookie')) return new Response(null, { status: direct.status, headers: direct.headers });
    JSON.parse(bytes.toString('utf8'));
    return new Response(bytes, { status: direct.status, headers: direct.headers });
  } catch { signal.throwIfAborted(); return fallback; }
}

export async function adaptiveFetch(input: string | URL, init: RequestInit & { signal: AbortSignal }, send: typeof fetch = fetch, policyForRequest?: PolicyResolver): Promise<Response> {
  let url = new URL(input), retried = false;
  const { signal } = init;
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new ApiError(502, 'UPSTREAM_URL', '上游服务地址无效。');
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    signal.throwIfAborted();
    const local = isLoopbackUrl(url), resolver = policyForRequest ?? [...resolvers].at(-1);
    const policy = !local && resolver ? await resolver(url, signal) : undefined;
    signal.throwIfAborted();
    if (!policy && send !== fetch) return send(url, init);
    const bypass = bypassesProxy(url, [process.env.no_proxy, process.env.NO_PROXY].join(','));
    const loginProxy = !policy && !bypass && !retried && !redirects && init.method?.toUpperCase() === 'POST' && url.pathname === '/api/v1/auth/login' && typeof init.body === 'string' ? nativeEnvProxy(url) : undefined;
    if (policy?.kind === 'bridge') response = await nodeRequest(url, init, signal, policy.proxyUrl, policy.authorityGrant);
    else if (policy?.kind === 'skip-proxy') response = await nodeRequest(url, init, signal, null);
    else if (local && !nativeEnvProxy(url)) response = await send(url, { ...init, redirect: 'manual' });
    else if (bypass) response = await nodeRequest(url, init, signal);
    else try { response = await send(url, { ...init, redirect: 'manual' }); }
    catch (e) {
      signal.throwIfAborted();
      const mayReplay = /^(?:GET|HEAD)$/i.test(init.method ?? 'GET') || url.pathname === '/api/v1/auth/login' || isPreDeliveryNetworkError(e);
      if (retried || !mayReplay || (init.body != null && typeof init.body !== 'string')) throw e;
      const alternate = await alternateRoute(url);
      if (alternate === undefined) throw e;
      retried = true; response = await nodeRequest(url, init, signal, alternate);
    }
    if (loginProxy && !retried && proxyCannotConnect(response, loginProxy)) {
      return directLoginAfterProxyError(url, init, signal, response);
    }
    const location = response.headers.get('location');
    if (!location || ![301, 302, 303, 307, 308].includes(response.status) || init.redirect === 'manual') return response;
    await response.body?.cancel();
    const next = URL.parse(location, url.href);
    // Never forward credentials (including JSON passwords and x-api-key) to another origin.
    if (init.redirect === 'error' || redirects >= 5 || !next || next.origin !== url.origin || next.username || next.password) throw new ApiError(502, 'UPSTREAM_REDIRECT', '上游服务返回异常跳转，请检查地址或在浏览器中登录。');
    if ((response.status === 303 && init.method !== 'HEAD') || ([301, 302].includes(response.status) && init.method === 'POST')) {
      const headers = new Headers(init.headers); headers.delete('content-type'); headers.delete('content-length');
      init = { ...init, method: 'GET', body: undefined, headers };
    }
    url = next;
  }
}
