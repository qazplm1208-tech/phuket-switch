import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { DEFAULT_GPT_FAST_CONFIG, DEFAULT_PROXY_SETTINGS, FALLBACK_PHUKET_GROUPS, isAstraModel, isOnlyAstraGroup } from '../shared/constants.js';
import type { CreateProviderRequest, SetupAstraOnlyResult } from '../shared/types.js';
import { createManagementApp, createRuntime } from './app.js';
import { cliPaths } from './configFiles.js';
import { SwitchDb } from './db.js';
import { astraDedicatedModels, missingAstraOnlyMessage, resolveAstraOnlyProvider } from './fastMode.js';

const astra = 'gpt-6.2-astra', pro = `${astra}-pro`, older = 'gpt-6-astra', sol = 'gpt-6.2-sol', terra = 'gpt-6.1-terra';
const setupRoute = '/api/fast-mode/setup-astra-only';
const catalog = (): string[] => JSON.parse(fs.readFileSync(cliPaths().catalog, 'utf8')).models.map((m: { slug: string }) => m.slug);
const port = (s: http.Server) => (s.address() as AddressInfo).port;
async function listen(handler?: http.RequestListener) {
  const s = http.createServer(handler);
  await new Promise<void>((resolve, reject) => s.once('error', reject).listen(0, '127.0.0.1', resolve));
  return s;
}
async function close(s: http.Server) {
  const closed = new Promise<void>(resolve => s.close(() => resolve())); s.closeAllConnections(); await closed;
}
async function request(origin: string, route: string, method = 'GET', body?: unknown, status = 200) {
  const r = await fetch(origin + route, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const text = await r.text(); assert.equal(r.status, status, `${method} ${route}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}
async function fixture(t: TestContext, accountFetch: typeof fetch = async () => { throw Error('offline fixture'); }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phuket-astra-only-'));
  const oldData = process.env.PHUKET_SWITCH_HOME, oldHome = process.env.PHUKET_SWITCH_USER_HOME;
  process.env.PHUKET_SWITCH_HOME = path.join(root, 'db'); process.env.PHUKET_SWITCH_USER_HOME = path.join(root, 'home');
  const runtime = createRuntime({ fetch: accountFetch }), { db, proxy } = runtime, servers: http.Server[] = [];
  t.after(async () => {
    try { await Promise.all(servers.map(close)); await runtime.close(); }
    finally {
      if (oldData === undefined) delete process.env.PHUKET_SWITCH_HOME; else process.env.PHUKET_SWITCH_HOME = oldData;
      if (oldHome === undefined) delete process.env.PHUKET_SWITCH_USER_HOME; else process.env.PHUKET_SWITCH_USER_HOME = oldHome;
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
  async function endpoint(handler: http.RequestListener) {
    const s = await listen(handler); servers.push(s); return `http://127.0.0.1:${port(s)}`;
  }
  const api = request.bind(null, await endpoint(createManagementApp(undefined, runtime)));
  const probe = await listen(), proxyPort = port(probe); await close(probe);
  db.setState('proxySettings', { ...DEFAULT_PROXY_SETTINGS, port: proxyPort });
  const add = (name: string, groupId: number, fields: Partial<CreateProviderRequest> = {}) => db.createProvider({
    name, phuketGroupId: groupId, appType: 'codex', protocol: 'openai-responses', baseUrl: 'http://127.0.0.1:1',
    model: astra, ...fields, apiKey: fields.apiKey ?? `fixture-group-${groupId}`,
  });
  return { api, add, db, proxy, endpoint, inference: request.bind(null, `http://127.0.0.1:${proxyPort}`) };
}

test('Only astra group identity and Astra model token boundaries', () => {
  for (const g of [{ id: 155 }, { phuketGroupId: 155 }, { name: 'Only astra' }, { name: 'VIP_ONLY-ASTRA downstream' }, { phuketGroupName: 'OnlyAstra' }, { name: '仅 Astra' }]) assert.ok(isOnlyAstraGroup(g));
  for (const g of [{ id: '155' }, { id: 153 }, { name: 'notonly astra' }, { name: 'only astral' }, { name: 'Pro 500' }, {}]) assert.ok(!isOnlyAstraGroup(g));
  for (const m of [astra, older, pro, `${older}-fast`, `${astra}--fast`, `${pro}--ultrafast`, '  vendor/ASTRA_pro--fast  ', 'alias:astra', 'GPT_ASTRA']) assert.ok(isAstraModel(m), m);
  for (const m of [sol, terra, 'codex-auto-review', 'claude-sonnet', 'gemini-2.5-pro', 'gpt-astral', 'disastra', '', null, undefined]) assert.ok(!isAstraModel(m), String(m));
  const g = FALLBACK_PHUKET_GROUPS.find(isOnlyAstraGroup)!;
  assert.deepEqual([g.id, g.name, g.platform, g.rate_multiplier, g.protocol], [155, 'Only astra', 'openai', 0.08, 'openai-responses']);
  assert.equal(DEFAULT_GPT_FAST_CONFIG.routeAstraToOnlyAstra, false); assert.equal(DEFAULT_GPT_FAST_CONFIG.astraOnlyProviderId, null);
});

test('Astra resolver is opt-in, prefers a valid binding then current, and exposes only distinct Astra models', async t => {
  const { add } = await fixture(t);
  const current = add('Only astra', 155), manual = add('My binding', 200), named = add('Only_Astra downstream', 201, { appType: 'gpt-native', availableModels: [pro, sol, pro], model: older });
  const wrong = add('Only astra', 202, { appType: 'claude', protocol: 'anthropic-messages' }), all = [wrong, named, manual, current];
  const enabled = { ...DEFAULT_GPT_FAST_CONFIG, routeAstraToOnlyAstra: true, astraOnlyProviderId: manual.id };
  assert.equal(resolveAstraOnlyProvider(all, current, { ...enabled, routeAstraToOnlyAstra: false }), undefined);
  assert.equal(resolveAstraOnlyProvider(all, current, enabled), manual);
  assert.equal(resolveAstraOnlyProvider(all, current, { ...enabled, astraOnlyProviderId: wrong.id }), current);
  assert.equal(resolveAstraOnlyProvider(all, manual, { ...enabled, astraOnlyProviderId: null }), named);
  assert.equal(resolveAstraOnlyProvider([wrong], null, enabled), undefined);
  assert.deepEqual(astraDedicatedModels(named), [pro, older]); assert.deepEqual(astraDedicatedModels(), []);
});

test('setup reuses the active group key, can mint or select a key, and persists non-destructive binding and takeover', async t => {
  const listed = [
    { id: 1, group_id: 49, status: 'active', key: 'ordinary-credential' },
    { id: 2, group_id: 155, status: 'inactive', key: 'inactive-credential' },
    { id: 3, group_id: 155, status: 'active', key: 'masked***' },
    { id: 4, group_id: 155, status: 'active', key: 'reusable-astra-credential' },
  ];
  const creates: unknown[] = [];
  const group = (id: number, name: string, platform = 'openai') => ({ id, name, platform, rate_multiplier: 0.08, status: 'active', models: [astra, pro, older].map(name => ({ name })) });
  const { api, add, db } = await fixture(t, async (u, init = {}) => {
    let data: unknown;
    switch (new URL(String(u)).pathname) {
      case '/api/v1/auth/me': data = { id: 7, email: 'test@example.invalid' }; break;
      case '/api/v1/user/agreement': data = { required: false }; break;
      case '/api/v1/model-plaza': data = { groups: [group(49, 'Pro 500'), group(200, 'Only_ASTRA downstream'), group(201, 'Only astra', 'gemini'), group(155, 'Only astra')] }; break;
      case '/api/v1/groups/available': case '/api/v1/groups/rates': case '/api/v1/usage/dashboard/api-keys-usage': data = []; break;
      case '/api/v1/keys':
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-account');
        if (init.method === 'POST') { const body = JSON.parse(String(init.body)); creates.push(body); data = { id: 5, group_id: body.group_id, status: 'active', key: 'minted-astra-credential' }; }
        else data = { items: listed, total: listed.length };
        break;
      default: throw Error(`Unexpected fixture URL: ${u}`);
    }
    return Response.json({ data });
  });
  const ultra = add('Pro500 ultrafast', 153), fast = { ...DEFAULT_GPT_FAST_CONFIG, ultraFastProviderId: ultra.id };
  const normal = add('Pro 500', 49, { codexFastConfig: { ...fast, respectClientServiceTier: true }, model: sol });
  db.setCurrentProvider('codex', normal.id); await api('/api/fast-mode', 'PUT', { config: fast });
  await api(setupRoute, 'POST', {}, 401);
  await api('/api/phuket/login', 'POST', { token: 'fixture-account' });
  for (const invalid of [{ phuketKeyId: 1 }, { phuketKeyId: 2 }, { apiKey: 'key', phuketKeyId: 4 }, { groupId: 201 }, { groupId: 49 }, { enableProxyTakeover: 'true' }]) await api(setupRoute, 'POST', invalid, 400);
  await api('/api/fast-mode', 'PUT', { config: { ...fast, astraOnlyProviderId: 'a'.repeat(129) } }, 400);
  assert.deepEqual(creates, []); assert.equal(db.providers().length, 2);
  const first: SetupAstraOnlyResult = await api(setupRoute, 'POST', {}), id = first.provider.id;
  assert.equal(first.provider.phuketGroupId, 155); assert.equal(first.provider.isCurrent, false); assert.equal(first.provider.rateMultiplier, 0.08);
  assert.deepEqual(first.provider.availableModels, [astra, pro, older]); assert.equal(db.provider(id).apiKey, listed[3].key); assert.ok(!JSON.stringify(first).includes(listed[3].key));
  assert.equal(first.fastMode.astraOnlyProviderId, id); assert.equal(first.fastMode.routeAstraToOnlyAstra, true); assert.equal(first.fastMode.ultraFastProviderId, ultra.id);
  assert.ok(first.proxy?.takeover.codex && first.proxy.running && first.system.applied); assert.ok(fs.readFileSync(cliPaths().codex, 'utf8').includes(first.proxy.baseUrl + '/v1'));
  assert.ok(catalog().includes(pro) && catalog().includes(`${pro}--fast`)); assert.deepEqual(creates, []);
  const reopened = new SwitchDb();
  try {
    assert.deepEqual(reopened.state('fastMode'), first.fastMode); assert.deepEqual(reopened.state('settings').defaultGptFastConfig, first.fastMode);
    const p = reopened.current('codex')!; assert.equal(p.id, normal.id); assert.equal(p.apiKey, normal.apiKey);
    assert.deepEqual(p.codexFastConfig, { ...normal.codexFastConfig, astraOnlyProviderId: id, routeAstraToOnlyAstra: true });
  } finally { reopened.close(); }
  db.updateProvider(id, { name: 'My Astra', notes: 'keep me' });
  const explicit = await api(setupRoute, 'POST', { phuketKeyId: 4, enableProxyTakeover: false });
  assert.equal(explicit.provider.id, id); assert.equal(explicit.provider.notes, 'keep me'); assert.equal(explicit.provider.name, 'My Astra');
  assert.deepEqual(creates, []); assert.equal(explicit.system.applied, false);
  const mint = await api(setupRoute, 'POST', { autoCreatePhuketKey: true }); assert.equal(mint.provider.id, id); assert.equal(db.provider(id).apiKey, 'minted-astra-credential');
  const alt = await api(setupRoute, 'POST', { groupId: 200 }); // No active key in the alternate named group.
  assert.equal(alt.provider.phuketGroupId, 200); assert.equal(db.current('codex')!.id, normal.id);
  assert.deepEqual(creates, [155, 200].map(group_id => ({ name: 'phuket-switch-only-astra', group_id })));
  await api(`/api/providers/${id}`, 'DELETE', undefined, 204); assert.equal(db.state('fastMode').astraOnlyProviderId, alt.provider.id);
  await api(`/api/providers/${alt.provider.id}`, 'DELETE', undefined, 204);
  for (const cfg of [db.state('fastMode'), db.state('settings').defaultGptFastConfig, db.current('codex')!.codexFastConfig!]) {
    assert.equal(cfg.astraOnlyProviderId, null); assert.equal(cfg.routeAstraToOnlyAstra, false); assert.equal(cfg.ultraFastProviderId, ultra.id);
  }
});

test('manual offline first setup selects a provider without writing Codex; subsequent offline setup reuses it', async t => {
  let calls = 0;
  const { api, db } = await fixture(t, async () => { calls++; throw Error('offline fixture'); });
  const manual = await api(setupRoute, 'POST', { apiKey: 'offline-astra-key', enableProxyTakeover: false });
  assert.ok(manual.provider.isCurrent); assert.equal(manual.system.applied, false); assert.equal(db.current('codex')!.apiKey, 'offline-astra-key');
  assert.equal(fs.existsSync(cliPaths().codex), false); assert.equal(db.state('proxyTakeover').codex, false);
  const before = calls, reused = await api(setupRoute, 'POST', {});
  assert.equal(calls, before); assert.equal(reused.provider.id, manual.provider.id); assert.equal(db.providers().length, 1); assert.ok(reused.proxy.takeover.codex);
});

test('live proxy and Codex catalog agree on Astra routing, UltraFast precedence, discovery and failover', async t => {
  const { api, add, db, proxy, endpoint, inference } = await fixture(t);
  const calls: string[] = [], fail = new Set<string>();
  const baseUrl = await endpoint(async (req, res) => {
    const key = req.headers.authorization?.replace(/^Bearer fixture-group-/, '') ?? '';
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: sol }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push(key); res.statusCode = fail.has(key) ? 503 : 200;
    res.end(JSON.stringify({ group: key, model: body.model, tier: body.service_tier }));
  });
  const normal = add('Pro 500', 49, { baseUrl, model: astra, availableModels: [sol, terra] }); db.setCurrentProvider('codex', normal.id);
  const dedicated = add('Only astra', 155, { baseUrl, model: older, availableModels: [pro, astra, pro, 'gpt-unrelated'], inFailoverQueue: true });
  add('Pro500 ultrafast', 153, { baseUrl, model: astra, inFailoverQueue: true });
  await api('/api/fast-mode', 'PUT', { config: { ...DEFAULT_GPT_FAST_CONFIG, speedMode: 'standard' } });
  await proxy.start();
  const run = (body: Record<string, unknown>, status = 200, path = '/v1/responses') => inference(path, 'POST', body, status);
  const discover = async (path = '/v1/models'): Promise<string[]> => (await inference(path)).data.map((m: { id: string }) => m.id);
  assert.deepEqual(await run({ model: astra }), { group: '49', model: astra, tier: 'default' }); assert.ok(!(await discover()).includes(pro));
  const setup = await api(setupRoute, 'POST', {}); assert.equal(setup.provider.id, dedicated.id); assert.equal(db.current('codex')!.id, normal.id);
  for (const path of ['/v1/responses', '/v1/chat/completions']) {
    for (const [model, tier, group, wireModel, wireTier] of [
      [astra, 'standard', '155', astra, 'default'], [`${astra}--fast`, 'ultrafast', '155', astra, 'priority'], [pro, 'priority', '155', pro, 'priority'],
      [sol, 'fast', '49', sol, 'priority'], [terra, 'standard', '49', terra, 'default'],
      [`${astra}--ultrafast`, 'priority', '153', astra, 'ultrafast'], [pro, 'ultrafast', '153', pro, 'ultrafast'],
    ]) assert.deepEqual(await run({ model, service_tier: tier }, 200, path), { group, model: wireModel, tier: wireTier });
  }
  assert.deepEqual(await run({}), { group: '155', model: astra, tier: 'default' });
  await api('/api/routes/sync-codex-catalog', 'POST');
  for (const names of [await discover(), catalog()]) {
    assert.ok(names.includes(pro) && names.includes(`${pro}--fast`)); assert.ok(!names.includes('gpt-unrelated')); assert.equal(new Set(names).size, names.length);
  }
  assert.ok(!(await discover('/claude-desktop/v1/models')).includes(pro));
  await api('/api/fast-mode', 'PUT', { config: { ...setup.fastMode, catalogSpeedVariants: false }, applyToCodex: true });
  for (const names of [await discover(), catalog()]) { assert.ok(names.includes(pro)); assert.ok(!names.includes(`${pro}--fast`)); }
  calls.length = 0; fail.add('155');
  assert.equal((await run({ model: astra })).group, '49'); assert.deepEqual(calls.splice(0), ['155', '49']);
  fail.add('49'); await run({ model: sol }, 503); assert.deepEqual(calls.splice(0), ['49']);
  fail.delete('49'); await proxy.updateSettings({ ...proxy.getStatus().settings, failoverEnabled: false });
  await run({ model: pro }, 503); assert.deepEqual(calls.splice(0), ['155']);
  await api('/api/routes', 'PUT', { rules: [{ enabled: true, sourceClient: 'codex', sourceModel: pro, targetProviderId: normal.id, targetModel: terra }] });
  assert.equal((await run({ model: pro })).model, terra); assert.deepEqual(calls.splice(0), ['49']);
  await api(`/api/providers/${dedicated.id}`, 'DELETE', undefined, 204);
  await api('/api/fast-mode', 'PUT', { config: { ...setup.fastMode, astraOnlyProviderId: 'deleted-id' } });
  const missing = await run({ model: astra }, 503); assert.deepEqual(missing.error, { code: 'ASTRA_ONLY_PROVIDER_MISSING', message: missingAstraOnlyMessage });
  assert.deepEqual(calls, []); assert.equal((await run({ model: sol })).group, '49');
});
