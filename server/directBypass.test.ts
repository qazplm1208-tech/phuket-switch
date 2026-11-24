import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, test } from 'node:test';
import { createManagementApp, createRuntime } from './app.js';
import { subagentPaths } from './configFiles.js';
import { SwitchDb } from './db.js';
import { bundledDirectFile } from './directFiles.js';
import { adaptiveFetch, isLoopbackUrl, setDirectBypassResolver } from './upstreamTransport.js';

const defaults = { enabled: false, mode: 'physical-nic', interfaceName: '', dnsServers: [], applyToSubagent: true };
const route = '/api/network/direct-bypass';
const envKeys = ['PHUKET_SWITCH_HOME', 'PHUKET_SWITCH_USER_HOME', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'];
let oldEnv: NodeJS.ProcessEnv, root: string, runtime: ReturnType<typeof createRuntime>, management: string, servers: http.Server[];
const read = (f: string) => fs.readFileSync(f, 'utf8');
const deadline = () => AbortSignal.timeout(5000);
async function listen(listener: http.RequestListener, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    // A non-loopback local address lets the real OS resolve the fixture without public DNS.
    if (req.socket.remoteAddress !== host) { req.socket.destroy(); return; }
    listener(req, res);
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://${host}:${port}` };
}
function localAddress() {
  const nic = Object.values(os.networkInterfaces()).flat().find(v => v && !v.internal && v.family === 'IPv4');
  assert.ok(nic, 'live network test needs a local non-loopback IPv4 address');
  return nic.address;
}
async function api(method: string, body?: unknown, suffix = '', status = 200, resource = route) {
  const res = await fetch(management + resource + suffix, { method, signal: AbortSignal.timeout(12000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  assert.equal(res.status, status); return await res.json() as any;
}
beforeEach(async () => {
  oldEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'phuket-direct-')); servers = [];
  process.env.PHUKET_SWITCH_USER_HOME = path.join(root, 'home'); process.env.PHUKET_SWITCH_HOME = path.join(root, 'db');
  fs.mkdirSync(process.env.PHUKET_SWITCH_USER_HOME); for (const key of envKeys.slice(2)) delete process.env[key];
  runtime = createRuntime({ directBypass: { systemRoute: true } }); management = (await listen(createManagementApp(root, runtime))).url;
});
afterEach(async () => {
  try {
    await runtime.close();
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  } finally {
    for (const k of envKeys) { if (oldEnv[k] === undefined) delete process.env[k]; else process.env[k] = oldEnv[k]; }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('direct-bypass GET and partial PUT validate and persist across a database reopen', async () => {
  const initial = await api('GET'); assert.deepEqual(initial.config, defaults); assert.equal(initial.bridgeRunning, false);
  for (const patch of [{ mode: 'system-route' }, { interfaceName: 'x'.repeat(129) }, { interfaceName: 'x\ny' }, { dnsServers: ['dns.invalid'] },
    { dnsServers: Array(5).fill('192.0.2.1') }, { enabled: 'true' }, { token: 'unexpected' }]) await api('PUT', patch, '', 400);
  for (const url of ['ftp://bad.example', 'http://a:b@relay.invalid', 'http://@relay.invalid', 'http://', 'http://host:99999']) await api('POST', { url }, '/probe', 400);
  assert.deepEqual((await api('GET')).config, defaults);
  const patch = { enabled: true, mode: 'skip-proxy', interfaceName: 'Ethernet', dnsServers: ['192.0.2.53', '2001:db8::53'] };
  assert.deepEqual((await api('PUT', patch)).config, { ...defaults, ...patch });
  const saved = await api('PUT', { applyToSubagent: false }); assert.equal(saved.bridgeRunning, false);
  const other = new SwitchDb(); try { assert.deepEqual(other.state('directBypass'), { ...defaults, ...patch, applyToSubagent: false }); } finally { other.close(); }
});

test('skip-proxy bypasses an actual env HTTP proxy; disabled control uses the proxy', async () => {
  const target = await listen((_req, res) => res.end('source'), localAddress());
  let hits = 0;
  const proxy = await listen((_req, res) => { hits++; res.end('via proxy'); });
  proxy.server.on('connect', (_req, socket) => {
    hits++; socket.on('error', () => {}); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia proxy'));
  });
  Object.assign(process.env, { HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1' });
  const restore = http.setGlobalProxyFromEnv(process.env);
  try {
    assert.equal(await (await adaptiveFetch(target.url, { signal: deadline() })).text(), 'via proxy'); assert.equal(hits, 1);
    await api('PUT', { enabled: true, mode: 'skip-proxy' });
    assert.equal(await (await adaptiveFetch(target.url, { signal: deadline() })).text(), 'source'); assert.equal(hits, 1);
    const probe = await api('POST', { url: target.url }, '/probe'); assert.equal(probe.bypassUsed, true); assert.equal(probe.mode, 'skip-proxy'); assert.equal(hits, 1);
  } finally { restore(); }
});

test('live authenticated system-route bridge carries a byte POST and incremental SSE, and probes without leaking credentials', async () => {
  let release!: () => void, posts = 0, redirects = 0;
  const nextEvent = new Promise<void>(resolve => { release = resolve; });
  const target = await listen(async (req, res) => {
    if (req.url === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); await nextEvent; res.end('data: second\n\n'); return; }
    if (req.url === '/echo') {
      posts++; const chunks = []; for await (const chunk of req) chunks.push(chunk);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ method: req.method, headers: req.headers, data: Buffer.concat(chunks).toString() })); return;
    }
    if (req.url === '/redirect') { redirects++; res.writeHead(302, { Location: '/never' }); }
    else res.writeHead(req.url === '/overload' ? 503 : 401);
    res.end();
  }, localAddress());
  const status = await api('PUT', { enabled: true }); assert.equal(status.bridgeRunning, true); assert.equal(status.selected.systemRoute, true);
  const policy = await runtime.directBypass.resolvePolicy(new URL(target.url)); assert.ok(policy?.kind === 'bridge');
  const secret = policy.proxyUrl.password; assert.match(secret, /^[a-f\d]{64}$/); assert.equal(JSON.stringify(status).includes(secret), false);
  // A bad credential for the same live bridge must fail, even though the target is independently reachable.
  const bad = new URL(policy.proxyUrl); bad.password = 'wrong';
  const unregister = setDirectBypassResolver(async () => ({ ...policy, proxyUrl: bad }));
  try { await assert.rejects(adaptiveFetch(target.url + '/echo', { signal: deadline() }), { code: 'UPSTREAM_PROXY' }); assert.equal(posts, 0); } finally { unregister(); }
  const payload = JSON.stringify({ model: 'fixture', n: 3 });
  const res = await adaptiveFetch(target.url + '/echo', { method: 'POST', body: Buffer.from(payload), headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, signal: deadline() });
  const echo = await res.json() as any; assert.equal(posts, 1); assert.equal(echo.method, 'POST'); assert.equal(echo.data, payload); assert.equal(echo.headers.authorization, 'Bearer fixture');
  assert.equal(echo.headers['proxy-authorization'], undefined); assert.equal(echo.headers['x-phuket-direct-target'], undefined);
  try {
    const stream = await adaptiveFetch(target.url + '/events', { signal: deadline() }), reader = stream.body!.getReader();
    assert.equal(Buffer.from((await reader.read()).value!).toString(), 'data: first\n\n'); release();
    assert.equal(Buffer.from((await reader.read()).value!).toString(), 'data: second\n\n'); assert.equal((await reader.read()).done, true);
  } finally { release(); }
  for (const [suffix, code] of [['/unauthenticated', 401], ['/redirect', 302], ['/overload', 503]] as const) {
    const probe = await api('POST', { url: target.url + suffix }, '/probe'); assert.equal(probe.statusCode, code); assert.equal(probe.ok, code < 500);
    assert.equal(probe.bypassUsed, true); assert.equal(probe.mode, 'physical-nic'); assert.equal(probe.route.systemRoute, true);
    assert.ok(Number.isFinite(Date.parse(probe.testedAt)) && probe.latencyMs >= 0); assert.equal(JSON.stringify(probe).includes(secret), false);
  }
  assert.equal(redirects, 1); assert.equal((await api('PUT', { enabled: false })).bridgeRunning, false);
});

test('loopback requests skip physical policy, use the native fetch connection pool, and report bypassUsed=false', async () => {
  await api('PUT', { enabled: true });
  for (const host of ['localhost', 'test.localhost.', '127.99.0.1', '[::1]', '[::ffff:127.11.22.33]']) {
    const url = new URL(`http://${host}`); assert.equal(isLoopbackUrl(url), true); assert.equal(await runtime.directBypass.resolvePolicy(url), undefined);
  }
  for (const host of ['localhost.example', '127.example', '[::ffff:8000:1]']) assert.equal(isLoopbackUrl(new URL(`http://${host}`)), false);
  const peers = new Set<number>(), target = await listen((req, res) => { peers.add(req.socket.remotePort!); res.writeHead(404); res.end('local'); });
  const unregister = setDirectBypassResolver(async () => { throw Error('a loopback request invoked the resolver'); });
  try {
    for (let i = 0; i < 6; i++) assert.equal(await (await adaptiveFetch(target.url, { signal: deadline() })).text(), 'local');
    assert.ok(peers.size < 6, 'expected pooled connections');
    const probe = await api('POST', { url: target.url }, '/probe'); assert.equal(probe.statusCode, 404); assert.equal(probe.bypassUsed, false); assert.equal(probe.route, null);
  } finally { unregister(); }
});

test('configuration changes serialize; unavailable physical transport fails closed and a later sync recovers', async () => {
  const manager = runtime.directBypass, config = runtime.db.state('subagent');
  runtime.db.setState('subagent', { ...config, pythonPath: 'unavailable-interpreter' });
  const status = await manager.updateConfig({ enabled: true }); assert.equal(status.config.enabled, true); assert.equal(status.bridgeRunning, false); assert.ok(status.error);
  const target = new URL('https://fixture.invalid'); let sends = 0;
  await assert.rejects(adaptiveFetch(target, { signal: deadline() }, async () => { sends++; return new Response(); }), { code: 'DIRECT_BYPASS_UNAVAILABLE', status: 502 }); assert.equal(sends, 0);
  const probe = await api('POST', { url: target.href }, '/probe'); assert.equal(probe.ok, false); assert.equal(probe.statusCode, null); assert.equal(probe.bypassUsed, false);
  runtime.db.setState('subagent', config); assert.equal((await manager.syncFromConfig()).bridgeRunning, true);
  const [first, last] = await Promise.all([manager.updateConfig({ interfaceName: 'new' }), manager.updateConfig({ mode: 'skip-proxy' })]);
  assert.equal(first.bridgeRunning, true); assert.equal(last.bridgeRunning, false); assert.equal(last.config.interfaceName, 'new');
});

test('only explicit subagent Apply writes direct env and sibling files, and removal respects a shared runtime', async () => {
  const f = subagentPaths(), helpers = [f.runtimeDirectDns, f.runtimeDirectNet, f.pluginDirectDns, f.pluginDirectNet];
  const req = { targets: ['cursor', 'claude-code', 'antigravity'], keyStorage: 'mcp-env', apiKey: 'fixture-install-key', baseUrl: 'https://relay.invalid' };
  const post = (action: string, body: unknown) => api('POST', body, '/' + action, 200, '/api/subagent');
  await post('apply', req); const previous = read(f.cursorMcp);
  await api('PUT', { enabled: true, mode: 'physical-nic', interfaceName: 'test-adapter', dnsServers: ['192.0.2.2', '2001:db8::53'] });
  assert.equal(read(f.cursorMcp), previous); assert.ok(helpers.every(file => !fs.existsSync(file)));
  const diff = await post('preview-diff', req); assert.ok(helpers.every(file => diff.files.some((entry: { path: string }) => entry.path === file)));
  assert.ok(helpers.every(file => !fs.existsSync(file))); await post('apply', req);
  for (const file of [f.cursorMcp, f.claudeMcp, f.pluginMcp]) {
    const env = JSON.parse(read(file)).mcpServers['gpt-astra-subagent'].env;
    assert.deepEqual([env.ASTRA_DIRECT_BYPASS, env.ASTRA_DIRECT_INTERFACE, env.ASTRA_DIRECT_DNS], ['physical-nic', 'test-adapter', '192.0.2.2,2001:db8::53']);
    assert.equal(env.DIRECT_BRIDGE_TOKEN, undefined);
  }
  for (const file of helpers) assert.equal(read(file), read(bundledDirectFile(file.endsWith('direct_dns.py') ? 'direct_dns.py' : 'direct_net.py')));
  const installed = read(f.cursorMcp); await api('PUT', { applyToSubagent: false }); assert.equal(read(f.cursorMcp), installed);
  await post('apply', { ...req, targets: ['cursor'] }); assert.equal(read(f.cursorMcp).includes('ASTRA_DIRECT_'), false);
  await post('remove', { targets: ['cursor', 'antigravity'] }); assert.ok(fs.existsSync(f.runtimeDirectDns)); assert.ok(fs.existsSync(f.runtimeDirectNet)); assert.ok(!fs.existsSync(f.pluginDirectDns) && !fs.existsSync(f.pluginDirectNet));
  await post('remove', { targets: ['claude-code'] }); assert.ok(helpers.every(file => !fs.existsSync(file)));
});
