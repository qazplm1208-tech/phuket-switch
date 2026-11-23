import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import TOML from '@iarna/toml';
import { effectiveSpeedMode, hybridBase, parseVirtualSpeedModel, resolveRequestSpeedMode } from './fastMode.js';
import { account as accountView, metadata } from './phuketViews.js';
import { buildAllFastModelMap, classifyPhuketGroup, defaultBaseUrlForApp, protocolForApp, canCreateGroupKey, isSpeedVariantCandidateModel, isUltraFastGroup, pickRecommendedModel, sortModelsNewestFirst, DEFAULT_GPT_FAST_CONFIG, DEFAULT_PROXY_SETTINGS, FALLBACK_PHUKET_GROUPS, PHUKET_GPT_BASE_URL } from '../shared/constants.js';
import type { AppType, CreateProviderRequest, GptFastConfig, ModelRouteInput, ModelRouteRule, SpeedMode } from '../shared/types.js';
import { createManagementApp, createRuntime } from './app.js';
import { CLAUDE_DESKTOP_PROFILE_ID, CLAUDE_DESKTOP_PROFILE_NAME, cliPaths } from './configFiles.js';
import { maskApiKey, SwitchDb } from './db.js';
import { isRecord, ApiError, redactRecognizable } from './common.js';
import { fetchJson, networkError, checkStatus, responseError } from './httpClient.js';
import { parseInternetSettings, parseWindowsProxyServer } from './upstreamTransport.js';
import { StreamMetrics } from './streamMetrics.js';
import { IMAGE_PROMPT_END, IMAGE_PROMPT_START } from './imagePrompt.js';

let home: string, data: string, root: string, runtime: ReturnType<typeof createRuntime>;
let remotes: http.Server[], control: http.Server, origin: string;
let upstream: (url: URL, init: RequestInit) => Response | Promise<Response>;
const oldData = process.env.PHUKET_SWITCH_HOME, oldHome = process.env.PHUKET_SWITCH_USER_HOME;
const rawKey = 'sk-941d-private-provider-credential-a580';
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
function file(name: string, value: string) { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, value); }
const read = (f: string) => fs.readFileSync(f, 'utf8');
const address = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
async function listen(s: http.Server) { await new Promise<void>((resolve, reject) => s.once('error', reject).listen(0, '127.0.0.1', resolve)); return s; }
async function close(s: http.Server) { const done = new Promise<void>(resolve => s.close(() => resolve())); s.closeAllConnections(); await done; }
async function mock(handler: http.RequestListener) { const s = await listen(http.createServer(handler)); remotes.push(s); return address(s); }
async function bodyOf(req: http.IncomingMessage) { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'phuket-switch-test-'));
  data = fs.mkdtempSync(path.join(root, 'data-')); home = fs.mkdtempSync(path.join(root, 'user-'));
  process.env.PHUKET_SWITCH_HOME = data; process.env.PHUKET_SWITCH_USER_HOME = home;
  upstream = () => { throw Error('offline fixture'); }; remotes = [];
  runtime = createRuntime({ fetch: async (u, init = {}) => upstream(new URL(String(u)), init) });
  const webRoot = path.join(root, 'web'); file(path.join(webRoot, 'index.html'), '<html>local SPA fixture</html>');
  control = await listen(http.createServer(createManagementApp(webRoot, runtime))); origin = address(control);
});
afterEach(async () => {
  try { await close(control); await runtime.close(); await Promise.all(remotes.map(close)); }
  finally { if (oldData === undefined) delete process.env.PHUKET_SWITCH_HOME; else process.env.PHUKET_SWITCH_HOME = oldData;
    if (oldHome === undefined) delete process.env.PHUKET_SWITCH_USER_HOME; else process.env.PHUKET_SWITCH_USER_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
async function api(route: string, method = 'GET', body?: unknown, status = 200) {
  const res = await fetch(origin + '/api/' + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); assert.equal(res.status, status, `${method} ${route}: ${text}`); assert.equal(res.headers.get('cache-control'), 'no-store');
  if (status === 204) { assert.equal(text, ''); return; } return JSON.parse(text);
}
const create = (appType: AppType, override: Partial<CreateProviderRequest> = {}) => api('providers', 'POST', { appType, name: `Test ${appType}`, protocol: protocolForApp(appType), baseUrl: 'https://example.invalid/v1/', apiKey: rawKey, model: appType.startsWith('claude') ? 'claude-sonnet' : protocolForApp(appType) === 'gemini-native' ? 'gemini-4-carbon' : 'gpt-6-astra', ...override }, 201);
const activate = (id: string, applyToSystem = false) => api(`providers/${id}/activate`, 'POST', { applyToSystem });
async function proxyPort() {
  const s = await listen(http.createServer()); const port = (s.address() as AddressInfo).port; await close(s);
  await api('proxy/settings', 'PUT', { ...DEFAULT_PROXY_SETTINGS, port }); return port;
}

const requiredCodexModelFields = ['slug', 'display_name', 'description', 'priority', 'visibility', 'supported_in_api', 'shell_type', 'default_reasoning_level', 'supported_reasoning_levels', 'base_instructions', 'supports_reasoning_summaries', 'default_reasoning_summary', 'support_verbosity', 'truncation_policy', 'supports_parallel_tool_calls', 'experimental_supported_tools', 'input_modalities', 'context_window', 'max_context_window', 'effective_context_window_percent', 'supports_image_detail_original', 'supports_search_tool', 'additional_speed_tiers', 'service_tiers', 'availability_nux', 'upgrade'];
function assertCodexCatalogEntry(model: any) {
  for (const field of requiredCodexModelFields) assert.ok(field in model, `missing ${field} on ${model.slug}`);
  assert.equal(typeof model.slug, 'string'); assert.equal(typeof model.display_name, 'string'); assert.equal(typeof model.description, 'string');
  assert.equal(typeof model.priority, 'number'); assert.equal(typeof model.visibility, 'string'); assert.equal(model.supported_in_api, true); assert.equal(typeof model.shell_type, 'string');
  assert.equal(typeof model.default_reasoning_level, 'string'); assert.ok(Array.isArray(model.supported_reasoning_levels)); assert.ok(model.supported_reasoning_levels.every((v: any) => typeof v.effort === 'string' && typeof v.description === 'string'));
  assert.equal(typeof model.base_instructions, 'string'); assert.equal(typeof model.supports_reasoning_summaries, 'boolean'); assert.equal(typeof model.default_reasoning_summary, 'string'); assert.equal(typeof model.support_verbosity, 'boolean');
  assert.equal(typeof model.truncation_policy, 'object'); assert.equal(typeof model.truncation_policy.mode, 'string'); assert.equal(typeof model.truncation_policy.limit, 'number'); assert.equal(typeof model.supports_parallel_tool_calls, 'boolean');
  assert.ok(Array.isArray(model.experimental_supported_tools)); assert.ok(Array.isArray(model.input_modalities)); assert.equal(typeof model.context_window, 'number'); assert.equal(typeof model.max_context_window, 'number');
  assert.equal(typeof model.effective_context_window_percent, 'number'); assert.equal(typeof model.supports_image_detail_original, 'boolean'); assert.equal(typeof model.supports_search_tool, 'boolean');
  assert.ok(Array.isArray(model.additional_speed_tiers)); assert.ok(Array.isArray(model.service_tiers)); assert.ok('availability_nux' in model); assert.ok('upgrade' in model); assert.equal('phuket_switch_route' in model, false);
}
function assertNativeSpeedTiers(model: any) {
  assertCodexCatalogEntry(model);
  assert.deepEqual(model.additional_speed_tiers, ['fast', 'ultrafast']);
  assert.deepEqual(model.service_tiers, [
    { id: 'priority', name: 'Fast', description: '普通分组 Fast 加速（service_tier=priority）' },
    { id: 'ultrafast', name: 'Ultrafast', description: 'UltraFast 极速（自动路由至 Pro500 ultrafast 分组）' },
  ]);
  assert.equal(model.default_service_tier, null);
}
const routed = (sourceClient: 'claude' | 'codex', sourceModel: string, targetProviderId: string, targetModel = sourceModel): ModelRouteInput => ({
  enabled: true, sourceClient, sourceModel, targetProviderId, targetModel,
});
async function startRouted(rules: ModelRouteInput[]) {
  await api('routes', 'PUT', { rules }); await proxyPort();
  const { baseUrl } = await api('proxy/start', 'POST');
  return (route: string, body: unknown) => fetch(baseUrl + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'local-client', authorization: 'Bearer local-client' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
}
async function responseJson(res: Response) {
  const value: unknown = await res.json(); assert.ok(isRecord(value)); return value;
}
function sendJson(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

test('routes validate and persist; auto-population is scoped, stable and preserves disabled and wildcard rules', async () => {
  assert.deepEqual(await api('routes'), []);
  const g = await create('codex', { availableModels: ['gpt-6-astra', 'gpt-new'] });
  const x = await create('gpt-native', { model: 'grok-4', availableModels: ['deepseek-v4', 'kimi-k3', 'glm-5', 'gpt-new'] });
  const c = await create('claude-desktop', { model: 'claude-sonnet', availableModels: ['claude-opus'] });
  const original = { ...routed('claude', 'gpt-new', g.id), enabled: false, note: 'keep' };
  const rules: ModelRouteRule[] = await api('routes', 'PUT', { rules: [original, routed('codex', '*', c.id, c.model)] });
  assert.ok(rules[0].id); assert.notEqual(rules[0].id, rules[1].id);
  for (const patch of [{ sourceModel: 'with space' }, { sourceModel: 'gpt-*' }, { sourceClient: 'other' }, { targetModel: '' }, { targetProviderId: 'unknown' }]) await api('routes', 'PUT', { rules: [{ ...original, ...patch }] }, 400);
  await api('routes', 'PUT', { rules: [rules[0], rules[0]] }, 400);
  await api('routes/auto-populate', 'POST', { syncCodexCatalog: 1 }, 400);
  assert.deepEqual(await api('routes'), rules);
  const a = await api('routes/auto-populate', 'POST', { sourceClient: 'claude' });
  assert.equal(a.addedCount, 5); assert.equal(a.rules.length, 7);
  assert.deepEqual(a.rules[0], rules[0]); assert.ok(a.rules.some((r: ModelRouteRule) => r.targetProviderId === x.id && r.sourceModel === 'grok-4'));
  const both = await api('routes/auto-populate', 'POST', {}); assert.equal(both.addedCount, 2);
  assert.ok(both.rules.some((r: ModelRouteRule) => r.sourceClient === 'codex' && r.targetProviderId === c.id && r.sourceModel === 'claude-opus'));
  await api('routes/auto-populate', 'POST', { sourceClient: 'all', syncCodexCatalog: true }, 409);
  const another = new SwitchDb(); try { assert.deepEqual(another.state('modelRoutes'), both.rules); } finally { another.close(); }
  await api(`providers/${c.id}`, 'DELETE', undefined, 204);
  assert.deepEqual(await api('routes'), both.rules.filter((r: ModelRouteRule) => r.targetProviderId !== c.id));
});

test('Codex catalog publishes routed models only on explicit sync during takeover', async () => {
  const p = await create('codex', { model: 'gpt-native-primary', availableModels: ['gpt-native-secondary', 'gpt-native-third'] });
  const c = await create('claude', { model: 'claude-fable-5-2', availableModels: ['claude-sonnet-5-5', 'claude-opus-5-5'] });
  const f = cliPaths();
  await api(`providers/${p.id}/activate`, 'POST', { applyToSystem: true });
  let models = JSON.parse(read(f.catalog)).models;
  assert.deepEqual(models.map((m: any) => m.slug), ['gpt-native-primary', 'gpt-native-secondary', 'gpt-native-third']);
  assert.deepEqual(models.map((m: any) => m.priority), [1, 2, 3]);
  assert.ok(!models.some((m: any) => m.slug.startsWith('claude-') || m.slug.endsWith('-fast')));
  for (const model of models) assertCodexCatalogEntry(model);
  await api('routes', 'PUT', { rules: [routed('codex', c.model, c.id)] });
  await api('routes/auto-populate', 'POST', { syncCodexCatalog: true }, 409);
  const port = await proxyPort();
  const takeover = await api('proxy/takeover', 'POST', { appType: 'codex', enable: true });
  assert.ok(takeover.system.backupId);
  assert.equal(runtime.db.state('codexIncludeRoutedModels'), false);
  models = JSON.parse(read(f.catalog)).models;
  assert.ok(!models.some((m: any) => m.slug.startsWith('claude-')));
  assert.deepEqual(models.slice(0, 3).map((m: any) => m.priority), [1, 2, 3]);
  await api('routes/sync-codex-catalog', 'POST');
  assert.equal(runtime.db.state('codexIncludeRoutedModels'), true);
  models = JSON.parse(read(f.catalog)).models;
  const routedModel = models.find((m: any) => m.slug === c.model);
  assert.ok(routedModel); assert.ok(routedModel.priority >= 1000);
  for (const model of models) assertCodexCatalogEntry(model);
  for (const model of models.slice(0, 3)) assertNativeSpeedTiers(model);
  assert.deepEqual(routedModel.additional_speed_tiers, []); assert.deepEqual(routedModel.service_tiers, []);
  assert.equal((TOML.parse(read(f.codex)).model_providers as any).custom.base_url, `http://127.0.0.1:${port}/v1`);
  await api('proxy/takeover', 'POST', { appType: 'codex', enable: false });
});

test('update checks default on for legacy settings and an explicit opt-out survives reopen and older clients', async () => {
  const { autoCheckUpdates: initial, ...legacy } = await api('settings');
  assert.equal(initial, true);
  runtime.db.setState('settings', { ...legacy, theme: 'dark' });
  assert.deepEqual(await api('settings'), { ...legacy, theme: 'dark', autoCheckUpdates: true });
  assert.equal((await api('settings', 'PUT', { ...legacy, autoCheckUpdates: false })).autoCheckUpdates, false);
  assert.equal((await api('settings', 'PUT', legacy)).autoCheckUpdates, false);
  await api('settings', 'PUT', { ...legacy, autoCheckUpdates: 'false' }, 400);
  const reopened = new SwitchDb();
  try { assert.equal(reopened.state('settings').autoCheckUpdates, false); } finally { reopened.close(); }
});

test('startup migrates only the legacy Phuket origin in saved provider and tool base URLs', () => {
  const db = runtime.db, legacy = 'https://ai.phuketcore.com', current = 'https://ai.pukitcore.com';
  const thirdParty = 'https://api.example.com/v1', lookalike = `${legacy}.evil.test/antigravity`;
  const unchanged = [thirdParty, lookalike, `${legacy}:8443/v1`, legacy.replace('https:', 'http:'), `${legacy}@evil.test/v1`, `${thirdParty}?next=${legacy}`];
  const urls = [[legacy, current], [`${legacy}/v1`, `${current}/v1`], [`${legacy.toUpperCase()}:443/antigravity/`, `${current}/antigravity/`],
    ...unchanged.map(url => [url, url])];
  const providers = urls.map(([baseUrl, expected]) => {
    const p = db.createProvider({ appType: 'codex', protocol: 'openai-responses', name: 'Saved provider', baseUrl, apiKey: rawKey, notes: legacy });
    return { ...p, baseUrl: expected };
  });
  const image = { ...db.state('imagePrompt'), apiKey: rawKey, groupName: legacy };
  const agent = { ...db.state('subagent'), apiKey: rawKey, customInstructions: legacy };
  for (const [imageUrl, expectedImage, agentUrl, expectedAgent] of [
    [`${legacy}/v1`, `${current}/v1`, `${legacy.toUpperCase()}/antigravity`, `${current}/antigravity`],
    [thirdParty, thirdParty, lookalike, lookalike],
  ]) {
    db.setState('imagePrompt', { ...image, baseUrl: imageUrl });
    db.setState('subagent', { ...agent, baseUrl: agentUrl });
    const reopened = new SwitchDb();
    try {
      for (const p of providers) assert.deepEqual(reopened.provider(p.id), p);
      assert.deepEqual(reopened.state('imagePrompt'), { ...image, baseUrl: expectedImage });
      assert.deepEqual(reopened.state('subagent'), { ...agent, baseUrl: expectedAgent });
    } finally { reopened.close(); }
  }
});

test('existing databases default to hidden routes; clearing and disabling the last route never republishes stale catalog metadata', async () => {
  const db = runtime.db, f = cliPaths();
  const legacy = new DatabaseSync(path.join(data, 'phuket-switch.db'));
  try { legacy.prepare('DELETE FROM kv_state WHERE key=?').run('codexIncludeRoutedModels'); } finally { legacy.close(); }
  const reopened = new SwitchDb(); try { assert.equal(reopened.state('codexIncludeRoutedModels'), false); } finally { reopened.close(); }
  db.setState('codexCatalogRouteSlugs', ['stale-route']);
  assert.equal((await api('routes/clear-codex-catalog', 'POST')).applied, false);
  assert.deepEqual(db.state('codexCatalogRouteSlugs'), []); assert.equal(fs.existsSync(f.catalog), false);
  const p = await create('codex', { model: undefined }), c = await create('claude', { model: 'claude-routed' });
  await activate(p.id); await proxyPort(); await api('proxy/takeover', 'POST', { appType: 'codex', enable: true });
  const populated = await api('routes/auto-populate', 'POST', { sourceClient: 'codex', syncCodexCatalog: true });
  assert.ok(populated.system.applied); assert.equal(db.state('codexIncludeRoutedModels'), true);
  assert.deepEqual(db.state('codexCatalogRouteSlugs'), [c.model]); assert.ok(read(f.catalog).includes(c.model));
  await api('routes', 'PUT', { rules: populated.rules.map((r: ModelRouteRule) => ({ ...r, enabled: false })) });
  assert.equal(db.state('codexIncludeRoutedModels'), false);
  await api('routes', 'PUT', { rules: [] }); // No remaining rule from which to recognize the old catalog entry.
  const preview = await api(`providers/${p.id}/preview-diff`), diff = preview.files.find((row: { path: string }) => row.path === f.catalog);
  assert.ok(diff.before.includes(c.model)); assert.ok(!diff.after.includes(c.model)); assert.ok(diff.after.includes('--fast'));
  await activate(p.id, true); assert.ok(!read(f.catalog).includes(c.model)); assert.ok(read(f.catalog).includes('--fast'));
  assert.deepEqual(db.state('codexCatalogRouteSlugs'), []);
});

test('Claude Code routes tools, images, instructions and JSON replies through GPT Fast, with hybrid retry and local counting', async () => {
  const calls: { body: any; path: string; headers: http.IncomingHttpHeaders }[] = [];
  const baseUrl = await mock(async (req, res) => {
    const body = await bodyOf(req); calls.push({ body, path: req.url!, headers: req.headers });
    if (body.model.endsWith('-fast')) return sendJson(res, { error: 'busy' }, 503);
    sendJson(res, { id: 'resp_123', status: 'completed', output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
      { type: 'function_call', id: 'fc_2', call_id: 'call_next', name: 'lookup', arguments: '{"n":2}' },
    ], usage: { input_tokens: 9, output_tokens: 4 } });
  });
  const p = await create('codex', { baseUrl, codexFastConfig: { ...DEFAULT_GPT_FAST_CONFIG, strategy: 'hybrid' } });
  const post = await startRouted([routed('claude', '*', p.id, 'wrong-fallback'), routed('claude', 'custom-gpt', p.id, p.model)]);
  const body = { model: 'custom-gpt', system: [{ type: 'text', text: 'policy' }, { type: 'text', text: 'style' }], max_tokens: 99, temperature: 0, top_p: 0.9,
    tools: [{ name: 'lookup', description: 'desc', input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: 'lookup' }, messages: [
      { role: 'user', content: 'prior' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'call_prev', name: 'lookup', input: { n: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_prev', content: [{ type: 'text', text: 'found' }] }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }, { type: 'text', text: 'next' }] },
    ] };
  const count = await post('/v1/messages/count_tokens', body); assert.equal(count.status, 200); assert.ok((await responseJson(count)).input_tokens > 0); assert.equal(calls.length, 0);
  const reply = await post('/v1/messages?beta=true', body); assert.equal(reply.status, 200); const msg = await responseJson(reply);
  assert.deepEqual(calls.map(c => c.body.model), ['gpt-6-astra-fast', 'gpt-6-astra']);
  assert.ok(calls.every(c => c.path === '/v1/responses' && c.headers.authorization === `Bearer ${rawKey}` && !c.headers['x-api-key'] && c.body.service_tier === 'priority'));
  const b = calls[1].body; assert.equal(b.instructions, 'policy\nstyle'); assert.equal(b.store, false); assert.equal(b.stream, false);
  assert.equal(b.temperature, 0); assert.equal(b.top_p, 0.9); assert.equal(b.max_output_tokens, 99);
  assert.deepEqual(b.tool_choice, { type: 'function', name: 'lookup' }); assert.deepEqual(b.tools, [{ type: 'function', name: 'lookup', description: 'desc', parameters: { type: 'object' } }]);
  assert.deepEqual(b.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
    { type: 'function_call', call_id: 'call_prev', name: 'lookup', arguments: '{"n":1}' },
    { type: 'function_call_output', call_id: 'call_prev', output: 'found' },
    { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' }, { type: 'input_text', text: 'next' }] },
  ]);
  assert.equal(msg.role, 'assistant'); assert.equal(msg.type, 'message'); assert.equal(msg.model, 'custom-gpt'); assert.equal(msg.stop_reason, 'tool_use');
  assert.deepEqual(msg.usage, { input_tokens: 9, output_tokens: 4 }); assert.equal(msg.content[0].thinking, 'summary');
  assert.deepEqual(msg.content.slice(1), [{ type: 'text', text: 'answer' }, { type: 'tool_use', id: 'call_next', name: 'lookup', input: { n: 2 } }]);
  const log = (await api('proxy/logs')).items[0]; assert.equal(log.fastFallback, true); assert.equal(log.protocol, 'openai-responses'); assert.equal(log.translatedFrom, 'anthropic-messages'); assert.equal(log.totalTokens, 13);
});

test('Codex routes Responses JSON to Claude, merges adjacent roles, skips built-ins and fails over before headers', async () => {
  const calls: { headers: http.IncomingHttpHeaders; path: string; body: any }[] = [];
  const baseUrl = await mock(async (req, res) => {
    calls.push({ headers: req.headers, path: req.url!, body: await bodyOf(req) });
    if (req.headers['x-api-key'] === 'primary-key') return sendJson(res, {}, 503);
    sendJson(res, { id: 'msg_x', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'answer' }, { type: 'tool_use', id: 'tool2', name: 'lookup', input: { n: 2 } }], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 7 } });
  });
  const p = await create('claude-desktop', { baseUrl, apiKey: 'primary-key' });
  const backup = await create('claude', { baseUrl, apiKey: 'backup-key', inFailoverQueue: true });
  const post = await startRouted([routed('codex', '*', p.id, 'claude-real')]);
  const msg = { model: 'alias', service_tier: 'ultrafast', instructions: 'initial', tools: [{ type: 'function', name: 'lookup' }, { type: 'web_search' }], tool_choice: 'required',
    input: [{ role: 'developer', content: [{ type: 'input_text', text: 'dev' }] }, { role: 'system', content: 'policy' },
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' }] }, { role: 'user', content: 'prior' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', call_id: 'tool1', name: 'lookup', arguments: '{"n":1}' }, { type: 'function_call_output', call_id: 'tool1', output: 'found' }, { role: 'user', content: 'continue' }],
  };
  const reply = await post('/v1/responses', msg); assert.equal(reply.status, 200); const output = await responseJson(reply);
  assert.deepEqual(calls.map(c => c.headers['x-api-key']), ['primary-key', 'backup-key']);
  for (const c of calls) {
    assert.equal(c.path, '/v1/messages'); assert.equal(c.headers['user-agent'], 'claude-cli/2.1.0 (external, cli)'); assert.equal(c.headers['anthropic-version'], '2023-06-01'); assert.equal(c.headers.authorization, undefined);
    assert.equal(c.body.model, 'claude-real'); assert.equal(c.body.system, 'initial\n\ndev\n\npolicy'); assert.equal(c.body.max_tokens, 8192); assert.equal(c.body.stream, false);
    assert.deepEqual(c.body.tools, [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }]); assert.deepEqual(c.body.tool_choice, { type: 'any' });
    assert.deepEqual(c.body.messages, [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }, { type: 'text', text: 'prior' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'tool1', name: 'lookup', input: { n: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'found' }, { type: 'text', text: 'continue' }] }]);
  }
  assert.match(output.id, /^resp_/); assert.equal(output.object, 'response'); assert.equal(output.model, 'alias'); assert.equal(output.status, 'completed'); assert.equal(output.output_text, 'answer');
  assert.deepEqual(output.output[0].summary, [{ type: 'summary_text', text: 'plan' }]); assert.equal(output.output[1].content[0].text, 'answer'); assert.equal(output.output[2].call_id, 'tool2'); assert.equal(output.output[2].arguments, '{"n":2}');
  assert.equal(output.usage.total_tokens, 10); const log = (await api('proxy/logs')).items[0]; assert.equal(log.appType, 'codex'); assert.equal(log.translatedFrom, 'openai-responses'); assert.equal(log.providerId, backup.id); assert.equal(log.failoverCount, 1);
});

test('health, empty overview, SPA navigation, local host and JSON guards', async () => {
  assert.deepEqual(await api('health'), { ok: true, app: 'phuket-switch', apiVersion: 1 });
  const overview = await api('overview'); assert.equal(overview.liveCliStates.length, 6);
  assert.deepEqual(overview.providerCounts, { claude: 0, codex: 0, 'gpt-native': 0, 'claude-desktop': 0, gemini: 0, antigravity: 0 });
  assert.deepEqual(overview.currentProviders, []); assert.equal(overview.proxy.running, false); assert.equal(overview.phuket.account, null);
  assert.deepEqual(await api('phuket/usage'), { source: 'none', dashboard: null, keyUsage: null });
  assert.equal((await api('unknown', 'GET', undefined, 404)).error.code, 'NOT_FOUND');
  assert.equal((await api('phuket/account', 'GET', undefined, 401)).error.code, 'LOGIN_REQUIRED');
  assert.match(await (await fetch(origin + '/monitor')).text(), /local SPA fixture/);
  const forbidden = await fetch(origin + '/api/health', { headers: { origin: 'https://untrusted.invalid' } }); assert.equal(forbidden.status, 403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => { http.get(origin + '/api/health', { headers: { Host: 'untrusted.invalid' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); }); assert.equal(hostStatus, 403);
  const invalid = await fetch(origin + '/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' }); assert.equal(invalid.status, 400); assert.ok(((await invalid.json()) as { error: { code: string } }).error.code);
  assert.equal(fs.existsSync(path.join(data, 'phuket-switch.db')), true); assert.deepEqual(fs.readdirSync(home), []);
});

test('provider CRUD masks keys, validates immutable fields, previews without writing and enforces one current per app', async () => {
  const p = await create('codex'), c = await create('claude'); assert.equal(p.apiKey, undefined); assert.equal(p.maskedKey, 'sk-941d...a580'); assert.equal(maskApiKey('short'), '****');
  const updated = await api(`providers/${p.id}`, 'PUT', { notes: 'primary' }); assert.equal(updated.maskedKey, p.maskedKey); assert.equal(runtime.db.provider(p.id).apiKey, rawKey);
  await api(`providers/${p.id}`, 'PUT', { isCurrent: true }, 400); await api(`providers/${p.id}`, 'PUT', { protocol: 'anthropic-messages' }, 400);
  assert.equal((await api('providers?appType=codex')).length, 1); assert.ok(!JSON.stringify(await api('providers')).includes(rawKey));
  const preview = await api(`providers/${p.id}/preview-diff`); assert.equal(preview.files.length, 3); assert.ok(preview.files.every((f: any) => f.before === null)); assert.ok(!JSON.stringify(preview).includes(rawKey));
  assert.deepEqual(await api('backups'), []); assert.deepEqual(fs.readdirSync(home), []);
  assert.equal((await activate(p.id)).system.applied, false); await activate(c.id); await api(`providers/${p.id}`, 'DELETE', undefined, 409);
  const other = await create('codex'); await activate(other.id); assert.deepEqual((await api('overview')).currentProviders.map((v: any) => v.id).sort(), [c.id, other.id].sort());
  await api(`providers/${p.id}`, 'DELETE', undefined, 204); await api(`providers/${p.id}/activate`, 'POST', {}, 404);
});

test('Codex surgical edits preserve unrelated bytes, inline comments and multiline values; rich catalog injection and undo', async () => {
  const f = cliPaths(), retained = '[mcp_servers.node_repl]\r\ncommand = "node"  # keep exact spacing\r\nargs = [\r\n "--version", # keep this array\r\n]\r\n\r\n[desktop]\r\nx = true\r\n[marketplaces."custom.shop"]\r\nsource = "store"\r\n';
  const reasoningLine = 'model_reasoning_effort  = "medium"  # managed by Codex\r\n';
  const before = reasoningLine + '# initial\r\nmodel = "old" # inline\r\nservice_tier = "flex"\r\ndoc = """keep\r\n[not.a.section]\r\nmodel = fake\r\n"""\r\n[model_providers.custom]\r\nbase_url="https://old.invalid"\r\nexperimental_bearer_token="opaque-old-credential"\r\n' + retained;
  file(f.codex, before); const template = path.join(path.dirname(f.catalog), 'cc-switch-model-catalog.json');
  const rich = { version: 4, models: [{ slug: 'gpt-6-astra', extension: 'keep', additional_speed_tiers: ['slow','fast','fast'], service_tiers: [{ id: 'flex' }, { id: 'priority' }, { id: 'priority' }] }, { slug: 'kimi-k3', detail: true }] };
  file(template, JSON.stringify(rich));
  const p = await create('codex', { codexFastConfig: { ...DEFAULT_GPT_FAST_CONFIG, strategy: 'hybrid', reasoningEffort: 'xhigh' } });
  const preview = JSON.stringify(await api(`providers/${p.id}/preview-diff`)); assert.ok(!preview.includes('opaque-old-credential')); assert.ok(!preview.includes(rawKey)); assert.equal(read(f.codex), before);
  const { system } = await activate(p.id, true); assert.equal(system.changedPaths.length, 3); assert.ok(system.backupId);
  const out = read(f.codex), table = TOML.parse(out); assert.equal(table.model, 'gpt-6-astra-fast'); assert.equal(table.service_tier, 'fast'); assert.equal(table.model_reasoning_effort, 'medium'); assert.ok(out.includes(reasoningLine)); assert.equal(table.model_provider, 'custom'); assert.ok(!Object.hasOwn(table, 'disable_response_storage')); assert.equal(table.model_catalog_json, path.basename(f.catalog));
  assert.ok(out.includes(retained)); assert.ok(out.includes('model = "gpt-6-astra-fast" # inline')); assert.ok(out.includes('model = fake'));
  assert.deepEqual((table.model_providers as any).custom, { name: p.name, base_url: 'https://example.invalid/v1', wire_api: 'responses', requires_openai_auth: false, experimental_bearer_token: rawKey });
  assert.equal(JSON.parse(read(f.auth)).OPENAI_API_KEY, rawKey);
  const catalog = JSON.parse(read(f.catalog)); assert.equal(catalog.version, 4); assert.equal(catalog.models[0].slug, 'gpt-6-astra'); assert.equal('extension' in catalog.models[0], false); assert.ok(!JSON.stringify(catalog.models).includes('custom')); assertCodexCatalogEntry(catalog.models[0]); assert.equal(read(template), JSON.stringify(rich));
  const restore = await api(`backups/${system.backupId}/restore`, 'POST'); assert.notEqual(restore.backupId, system.backupId); assert.equal(read(f.codex), before); assert.ok(!fs.existsSync(f.catalog)); assert.ok(!fs.existsSync(f.auth));
  await api(`backups/${restore.backupId}/restore`, 'POST'); assert.equal(read(f.codex), out); assert.equal(JSON.parse(read(f.auth)).OPENAI_API_KEY, rawKey);
  assert.ok(!JSON.stringify(await api('backups')).includes(rawKey));
});

test('Codex catalog repairs native and routed entries to the 26-field ModelInfo schema', async () => {
  const f = cliPaths(), p = await create('codex', { availableModels: ['codex-auto-review', 'o3', 'deepseek-v4'],
    codexFastConfig: { ...DEFAULT_GPT_FAST_CONFIG, speedMode: 'standard', enabled: false, injectCodexCatalogFast: false } }), c = await create('claude', { model: 'claude-routed' });
  file(f.catalog, JSON.stringify({ version: 4, models: [
    { slug: 'gpt-6-astra', display_name: 'GPT', experimental_supported_tools: [], default_service_tier: 'priority' },
    { slug: 'deepseek-v4', default_service_tier: 'flex', service_tiers: [{ id: 'flex', name: 'Flex', description: 'Fixture' }] },
    { slug: 'legacy-routed', display_name: 'Legacy', phuket_switch_route: true },
    { slug: 'user-entry', custom: true },
  ] }));
  await api('routes', 'PUT', { rules: [routed('codex', c.model, c.id)] });
  await activate(p.id, true);
  let models = JSON.parse(read(f.catalog)).models;
  assert.ok(models.some((m: any) => m.slug === 'gpt-6-astra'));
  assert.equal(models.some((m: any) => m.slug === c.model), false);
  assert.equal(models.some((m: any) => m.slug === 'legacy-routed'), false);
  for (const model of models) {
    if (model.slug === 'deepseek-v4') {
      assertCodexCatalogEntry(model); assert.equal(model.default_service_tier, 'flex');
      assert.deepEqual(model.additional_speed_tiers, []); assert.deepEqual(model.service_tiers.map((t: { id: string }) => t.id), ['flex']);
    } else assertNativeSpeedTiers(model);
  }
  await proxyPort();
  await api('proxy/takeover', 'POST', { appType: 'codex', enable: true });
  assert.ok(!JSON.parse(read(f.catalog)).models.some((m: any) => m.slug === c.model));
  await api('routes/sync-codex-catalog', 'POST');
  models = JSON.parse(read(f.catalog)).models;
  const routedEntry = models.find((m: any) => m.slug === c.model);
  assert.ok(routedEntry); assert.ok(routedEntry.priority >= 1000); assert.equal(models.some((m: any) => m.slug === 'legacy-routed'), false);
  for (const model of models) assertCodexCatalogEntry(model);
  await api('proxy/takeover', 'POST', { appType: 'codex', enable: false });
});
test('invalid TOML or companion JSON aborts all writes before backup or activation', async () => {
  const f = cliPaths(), p = await create('codex'); file(f.codex, '[broken\n');
  await api(`providers/${p.id}/activate`, 'POST', {}, 409); assert.equal(read(f.codex), '[broken\n');
  file(f.codex, '# preserve\n'); file(f.auth, 'invalid'); await api(`providers/${p.id}/activate`, 'POST', {}, 409);
  assert.equal(read(f.codex), '# preserve\n'); assert.equal(fs.existsSync(f.catalog), false); assert.deepEqual(await api('backups'), []); assert.equal(runtime.db.current('codex'), null);
});

test('Claude settings preserve unmanaged keys and model slots; takeover restoration includes original files', async () => {
  const f = cliPaths(); const original = { spinnerVerbs: ['Dance'], spinnerTipsOverride: true, language: 'zh-CN', enableWorkflows: true, env: { OTHER: 'keep', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'existing' } };
  file(f.claude, JSON.stringify(original)); const p = await create('claude', { claudeModelMap: { defaultModel: 'claude-x', opus: 'opus-x' } });
  const applied = (await activate(p.id, true)).system; assert.ok(applied.backupId);
  const direct = read(f.claude), live = JSON.parse(direct); assert.deepEqual(live, { ...original, env: { ...original.env, ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: rawKey, ANTHROPIC_MODEL: 'claude-x', ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-x' } });
  assert.equal((await api('overview')).liveCliStates.find((s: any) => s.appType === 'claude').providerId, p.id);
  const port = await proxyPort(); const t = await api('proxy/takeover', 'POST', { appType: 'claude', enable: true }); assert.equal(t.proxy.takeover.claude, true);
  const during = JSON.parse(read(f.claude)); assert.equal(during.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`); assert.notEqual(during.env.ANTHROPIC_AUTH_TOKEN, rawKey);
  await api('proxy/takeover', 'POST', { appType: 'claude', enable: false }); assert.equal(read(f.claude), direct);
  await api(`backups/${applied.backupId}/restore`, 'POST'); assert.equal(read(f.claude), JSON.stringify(original));
});

const desktopType = 'claude-desktop' as const;
function desktopFixture() {
  const { claudeDesktopMeta: meta, claudeDesktopProfile: profile } = cliPaths();
  const base = process.platform === 'win32' ? path.join(home, 'AppData', 'Local') : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  assert.equal(meta, path.join(base, 'Claude-3p', 'configLibrary', '_meta.json'));
  assert.equal(profile, path.join(path.dirname(meta), '00000000-0000-4000-8000-000000157220.json'));
  const id = 'cc-switch-fixture', entry = { id, name: 'CC-Switch', extra: 'keep' }, other = path.join(path.dirname(meta), `${id}.json`);
  const metaText = JSON.stringify({ appliedId: id, entries: [entry], revision: 5 }) + '\r\n';
  const oldKey = 'ccs-previous-desktop-fixture', oldUrl = 'http://127.0.0.1:15721/claude-desktop';
  const models = [{ name: 'claude-fable-5', labelOverride: 'claude-sonnet-5-5', supports1m: true }, { name: 'claude-haiku-4-5', supports1m: false }];
  const original = { desktopHome: 'custom', inferenceModelPricingEnabled: false, inferenceModelPricingMultiplier: 0.25, coworkEgressAllowedHosts: ['example.test'], builtinBrowserEnabled: false, disableDeploymentModeChooser: false,
    inferenceModels: models, inferenceGatewayApiKey: oldKey, inferenceGatewayBaseUrl: oldUrl, annotation: `migrated from ${oldKey}` };
  const otherText = JSON.stringify(original, null, 4) + '\r\n'; file(meta, metaText); file(other, otherText);
  return { meta, profile, other, metaText, otherText, entry, original, models, oldUrl, oldKey };
}
const liveDesktop = async () => (await api('overview')).liveCliStates.find((s: { appType: AppType }) => s.appType === desktopType);

test('Claude Desktop detects a stale gateway, previews a redacted migration and applies only its owned profile and metadata', async () => {
  const f = desktopFixture(), p = await create(desktopType);
  await activate(p.id); const stale = await liveDesktop();
  assert.equal(stale.detected, true); assert.deepEqual(stale.configPaths, [f.meta, f.other]); assert.equal(stale.baseUrl, f.oldUrl); assert.equal(stale.providerId, null);
  assert.equal(stale.model, f.models[0].labelOverride); assert.match(stale.warnings.join(' '), /127\.0\.0\.1:15721.*同步写入.*重启 Claude Desktop/); assert.ok(!JSON.stringify(stale).includes(f.oldKey));
  const preview = await api(`providers/${p.id}/preview-diff`); assert.deepEqual(preview.files.map((v: { path: string }) => v.path), [f.meta, f.profile]);
  assert.deepEqual(preview.warnings, []); assert.equal(preview.files[1].before, null); assert.ok(preview.files[1].after.includes('[REDACTED]'));
  for (const secret of [rawKey, f.oldKey]) assert.ok(!JSON.stringify(preview).includes(secret)); assert.equal(read(f.meta), f.metaText); assert.equal(fs.existsSync(f.profile), false);
  const { system } = await activate(p.id, true); assert.deepEqual(system.changedPaths, [f.meta, f.profile]); assert.ok(system.backupId);
  assert.deepEqual(JSON.parse(read(f.meta)), { revision: 5, entries: [f.entry, { id: CLAUDE_DESKTOP_PROFILE_ID, name: CLAUDE_DESKTOP_PROFILE_NAME }], appliedId: CLAUDE_DESKTOP_PROFILE_ID });
  const gateway = { inferenceProvider: 'gateway', inferenceCredentialKind: 'static', inferenceGatewayAuthScheme: 'bearer', inferenceGatewayApiKey: rawKey, inferenceGatewayBaseUrl: 'https://example.invalid' };
  assert.deepEqual(JSON.parse(read(f.profile)), { ...f.original, ...gateway }); assert.equal(read(f.other), f.otherText);
  const direct = await liveDesktop(); assert.deepEqual(direct.configPaths, [f.meta, f.profile]); assert.deepEqual(direct.warnings, []); assert.equal(direct.providerId, p.id);
  assert.equal((await activate(p.id, true)).system.applied, false);
  await api(`backups/${system.backupId}/restore`, 'POST'); assert.equal(read(f.meta), f.metaText); assert.equal(read(f.other), f.otherText); assert.equal(fs.existsSync(f.profile), false);
});

test('Claude Desktop rejects unsafe applied IDs, seeds a valid model list and preserves subsequent owned settings', async () => {
  const f = cliPaths(), dir = path.dirname(f.claudeDesktopMeta);
  const external = path.join(dir, '..', 'outside.json'); file(external, '{"marker":"must-not-copy"}');
  file(f.claudeDesktopMeta, '{"appliedId":"../outside","entries":[]}');
  const p = await create(desktopType, { model: 'claude-b', availableModels: ['claude-a', 'claude-b', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'], claudeModelMap: { opus: 'claude-a', sonnet: 'claude-b', haiku: 'claude-c', defaultModel: 'claude-b' } });
  assert.deepEqual((await liveDesktop()).configPaths, [f.claudeDesktopMeta, f.claudeDesktopProfile]);
  await activate(p.id, true); const profile = JSON.parse(read(f.claudeDesktopProfile));
  assert.deepEqual(profile.inferenceModels, ['claude-a', 'claude-b', 'claude-c', 'm1', 'm2', 'm3', 'm4', 'm5'].map(name => ({ name, supports1m: true })));
  assert.equal(profile.marker, undefined); assert.equal(read(external), '{"marker":"must-not-copy"}');
  assert.equal(profile.desktopHome, 'standard'); assert.equal(profile.inferenceModelPricingEnabled, true); assert.equal(profile.inferenceModelPricingMultiplier, 1); assert.deepEqual(profile.coworkEgressAllowedHosts, ['*']); assert.equal(profile.builtinBrowserEnabled, true); assert.equal(profile.disableDeploymentModeChooser, true);
  file(f.claudeDesktopProfile, JSON.stringify({ ...profile, desktopHome: 'keep-owned' }));
  file(f.claudeDesktopMeta, '{"appliedId":"other","entries":[]}'); file(path.join(dir, 'other.json'), '{"desktopHome":"foreign"}');
  await activate(p.id, true); assert.equal(JSON.parse(read(f.claudeDesktopProfile)).desktopHome, 'keep-owned');
  file(f.claudeDesktopProfile, 'malformed'); const before = read(f.claudeDesktopMeta);
  await api(`providers/${p.id}/activate`, 'POST', {}, 409); assert.equal(read(f.claudeDesktopProfile), 'malformed'); assert.equal(read(f.claudeDesktopMeta), before);
});

test('Claude Desktop takeover isolates credentials and discovery, strips the prefix, and restores the previous applied profile', async () => {
  const f = desktopFixture(), calls: { app: string; url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const upstream = (app: string) => mock(async (req, res) => {
    const body = await bodyOf(req); calls.push({ app, url: req.url!, headers: req.headers, body });
    sendJson(res, req.url?.startsWith('/v1/models') ? { data: [{ id: `${app}-upstream` }] } : { ok: true });
  });
  const desktop = await create(desktopType, { baseUrl: await upstream('desktop'), apiKey: 'desktop-upstream-key', model: 'desktop-model' });
  const cli = await create('claude', { baseUrl: await upstream('cli'), apiKey: 'cli-upstream-key', model: 'cli-model' });
  await activate(desktop.id); await activate(cli.id); await proxyPort();
  await api('routes', 'PUT', { rules: [routed('claude', '*', cli.id, cli.model)] });
  const toggle = (enable: boolean) => api('proxy/takeover', 'POST', { appType: desktopType, enable });
  const enabled = await toggle(true), root = enabled.proxy.baseUrl, gateway = `${root}/claude-desktop`;
  assert.ok(enabled.system.backupId); assert.equal(enabled.proxy.takeover[desktopType], true); assert.equal(enabled.proxy.takeover.claude, false);
  const profile = JSON.parse(read(f.profile)); assert.equal(profile.inferenceGatewayBaseUrl, gateway); assert.equal(profile.inferenceGatewayApiKey, 'phuket-switch-local'); assert.deepEqual(profile.inferenceModels, f.models);
  const preview = await api(`providers/${desktop.id}/preview-diff`); assert.equal(JSON.parse(preview.files[1].after).inferenceGatewayBaseUrl, gateway);
  const active = await liveDesktop(); assert.deepEqual(active.warnings, []); assert.equal(active.providerId, desktop.id);
  const headers = { 'content-type': 'application/json', 'user-agent': 'Claude-Desktop-Fixture', 'anthropic-version': '2023-06-01', authorization: 'Bearer local-client' };
  const unexpectedPrefix = await fetch(root + '/CLAUDE-DESKTOP/v1/messages', { method: 'POST', headers, body: '{}' }); assert.equal(unexpectedPrefix.status, 404); await unexpectedPrefix.text(); assert.equal(calls.length, 0);
  for (const path of ['/v1/messages?beta=1', '/v1/messages/count_tokens', '/v1/models?limit=10', '/v1/models/?limit=10']) {
    const response = await fetch(gateway + path, path.includes('/models') ? { headers } : { method: 'POST', headers, body: JSON.stringify({ model: desktop.model, messages: [] }) });
    assert.equal(response.status, 200); const out = await responseJson(response);
    if (path.includes('/models')) assert.deepEqual(out.data.map((m: { id: string }) => m.id), ['desktop-upstream', desktop.model]);
    const call = calls.at(-1)!; assert.equal(call.app, 'desktop'); assert.equal(call.url, path); assert.equal(call.headers['x-api-key'], 'desktop-upstream-key');
    assert.equal(call.headers['user-agent'], headers['user-agent']); assert.equal(call.headers.authorization, undefined);
    const log = (await api('proxy/logs?limit=1')).items[0]; assert.equal(log.appType, desktopType); assert.equal(log.protocol, 'anthropic-messages'); assert.equal(log.providerId, desktop.id);
  }
  const cliResponse = await fetch(root + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: cli.model }) }); await cliResponse.text();
  assert.equal(cliResponse.status, 200); assert.equal(calls.at(-1)!.app, 'cli'); assert.equal(calls.at(-1)!.headers['x-api-key'], 'cli-upstream-key');
  await api('proxy/stop', 'POST'); const stopped = await liveDesktop(); assert.match(stopped.warnings.join(' '), /已停止.*启动代理/); assert.equal(stopped.providerId, null);
  const off = await toggle(false); assert.ok(off.system.backupId); assert.equal(off.proxy.takeover[desktopType], false);
  assert.equal(read(f.meta), f.metaText); assert.equal(read(f.other), f.otherText); assert.equal(fs.existsSync(f.profile), false); assert.equal((await liveDesktop()).baseUrl, f.oldUrl);
});

test('Claude Desktop retries its own queue before shared Anthropic failover and returns Anthropic proxy errors', async () => {
  const calls: string[] = []; let status = 503;
  const endpoint = await mock((req, res) => { const key = String(req.headers['x-api-key']); calls.push(key); sendJson(res, {}, key === 'cli-queued' ? 200 : status); });
  const rootPort = await proxyPort(); await api('proxy/start', 'POST');
  const post = (body: unknown) => fetch(`http://127.0.0.1:${rootPort}/claude-desktop/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const cli = await create('claude', { apiKey: 'cli-current', baseUrl: endpoint }); await activate(cli.id);
  const none = await post({}); assert.equal(none.status, 503); assert.equal((await responseJson(none)).error.type, 'api_error'); assert.deepEqual(calls, []);
  const invalid = await post({ model: [] }); assert.equal(invalid.status, 400); assert.equal((await responseJson(invalid)).error.type, 'invalid_request_error');
  await create('claude', { apiKey: 'cli-queued', baseUrl: endpoint, priority: 0, inFailoverQueue: true });
  await create(desktopType, { apiKey: 'desktop-queued', baseUrl: endpoint, inFailoverQueue: true });
  const current = await create(desktopType, { apiKey: 'desktop-current', baseUrl: endpoint }); await activate(current.id);
  const result = await post({}); await result.text(); assert.equal(result.status, 200);
  assert.deepEqual(calls.splice(0), ['desktop-current', 'desktop-queued', 'cli-queued']);
  const log = (await api('proxy/logs')).items[0]; assert.equal(log.appType, desktopType); assert.equal(log.failoverCount, 2);
  status = 401; const denied = await post({}); assert.equal(denied.status, 401); assert.equal((await responseJson(denied)).error.type, 'api_error'); assert.deepEqual(calls, ['desktop-current']);
});

test('Phuket public and exclusive catalogs merge by numeric ID without granting unsupported adapters', async () => {
  let authenticated = false;
  upstream = (u, init) => {
    const h = new Headers(init.headers);
    assert.equal(u.searchParams.get('timezone'), 'Asia/Shanghai'); assert.equal(h.get('authorization'), authenticated ? 'Bearer user-session' : null); assert.equal(h.get('x-user-ui-request'), authenticated ? '1' : null);
    if (u.pathname.endsWith('model-plaza')) return json({ data: { groups: FALLBACK_PHUKET_GROUPS.map(g => ({ ...g, ...(g.id === 32 ? { status: 'active' } : {}), models: g.id === 65 ? [{ name: 'gpt-test', platform: 'openai', pricing: null }] : [] })) } });
    if (u.pathname.endsWith('groups/available')) return json({ data: [{ id: '65', name: 'Official', platform: 'openai', rate_multiplier: 0.3 }, { id: 200, name: 'VIP exclusive Pro 500', platform: 'openai', is_exclusive: true }, { id: 201, name: 'GLM', platform: 'zhipu' },
      { id: 34, name: 'Grok', platform: 'grok' }, { id: 134, name: 'Kimi', platform: 'kimi' }, { id: 129, name: '视频分组', platform: 'grok' }] });
    return json({ data: { 65: 0.22 } });
  };
  const publicGroups = await api('phuket/groups'); assert.equal(publicGroups.authenticated, false);
  const direct = await runtime.phuket.getMergedGroups(rawKey); assert.equal(direct.length, publicGroups.groups.length);
  authenticated = true; const groups = await runtime.phuket.getMergedGroups('user-session');
  const by = (id: number) => groups.find(g => g.id === id)!;
  assert.equal(by(65).models[0].name, 'gpt-test'); assert.equal(by(65).rate_multiplier, 0.22); assert.equal(by(200).is_exclusive, true);
  for (const id of [65,34,127,134,201]) { assert.equal(by(id).protocol, 'openai-responses'); assert.deepEqual(by(id).supportedAppTypes, ['codex','gpt-native']); }
  assert.equal(by(201).adapterCategory, 'domestic'); assert.equal(by(34).adapterCategory, 'grok'); assert.equal(by(107).protocol, 'anthropic-messages');
  assert.equal(by(32).adapterCategory, 'image_prompt'); assert.equal(by(32).protocol, null); assert.deepEqual(by(32).supportedAppTypes, []); assert.equal(canCreateGroupKey(by(32)), true);
  assert.equal(by(129).adapterCategory, 'media_coming_soon'); assert.equal(by(129).protocol, null); assert.deepEqual(by(129).supportedAppTypes, []);
  for (const id of [124, 132]) { assert.equal(by(id).adapterCategory, 'gemini'); assert.equal(by(id).protocol, 'gemini-native'); assert.deepEqual(by(id).supportedAppTypes, ['gemini','antigravity','codex']); }
  upstream = () => { throw new Error('offline'); }; assert.deepEqual((await api('phuket/groups')).groups, FALLBACK_PHUKET_GROUPS);
});

const imageExistingKey = 'sk-image-existing-fixture-key-2000';
const imageCreatedKey = 'sk-image-created-fixture-key-3000';
const imageKeyRow = (id: number, key = imageExistingKey) => ({ id, name: 'Image fixture key', group_id: 32, status: 'active', key, created_at: '2025-01-01T00:00:00Z' });
function imageAccount(listed: Record<string, unknown>[] = []) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  upstream = (url, init) => {
    const method = init.method ?? 'GET', body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === '/api/v1/auth/login') return json({ data: { token: 'image-session' } });
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer image-session'); assert.equal(headers.get('x-user-ui-request'), '1');
    if (url.pathname === '/api/v1/auth/me') return json({ data: { id: 1, email: 'image@example.test', allowed_groups: null } });
    if (url.pathname === '/api/v1/model-plaza') return json({ data: { groups: [{ id: 32, name: '生图-image', platform: 'openai', status: 'active', models: [] }] } });
    if (url.pathname === '/api/v1/groups/available' || url.pathname === '/api/v1/groups/rates') return json({ data: [] });
    if (url.pathname === '/api/v1/usage/dashboard/api-keys-usage') return json({ data: {} });
    if (url.pathname === '/api/v1/keys' && method === 'POST') return json({ data: { ...imageKeyRow(99, imageCreatedKey), name: 'phuket-switch-image' } });
    if (url.pathname === '/api/v1/keys') return json({ data: { items: listed, total: listed.length } });
    throw Error(`unexpected image fixture call: ${method} ${url.pathname}`);
  };
  return calls;
}

test('image prompt status defaults safely and rejects empty or non-image requests', async () => {
  const status = await api('image-prompt');
  assert.equal(status.config.enabled, false); assert.equal(status.liveTargets.codex.injected, false);
  assert.ok(status.previewMarkdown.includes(IMAGE_PROMPT_START)); assert.ok(status.previewMarkdown.includes(IMAGE_PROMPT_END));
  assert.ok(status.previewMarkdown.includes('/v1/images/generations'));
  await api('image-prompt/apply', 'POST', { targets: [] }, 400);
  await api('image-prompt/apply', 'POST', { targets: ['codex'], groupId: 0, apiKey: 'sk-manual-image-key' }, 400);
  await api('image-prompt/apply', 'POST', { targets: ['codex'], groupId: 65, apiKey: 'sk-manual-image-key' }, 400);
  await api('image-prompt/apply', 'POST', { targets: ['codex'], apiKey: 'sk-manual-image-key', autoCreatePhuketKey: true }, 400);
});

test('image prompt auto-acquires an active image key, preserves AGENTS.md, and redacts the key from API responses', async () => {
  const f = cliPaths(), original = '# Existing instructions\nKeep this text exactly.\n'; file(f.codexPrompt, original);
  const calls = imageAccount([imageKeyRow(41)]);
  await api('phuket/login', 'POST', { email: 'image@example.test', password: 'fixture' });
  const applied = await api('image-prompt/apply', 'POST', { targets: ['codex'], defaultModel: 'gpt-image-2.5' });
  const content = read(f.codexPrompt);
  assert.ok(content.startsWith(original)); assert.ok(content.includes(imageExistingKey)); assert.ok(content.includes('https://ai.pukitcore.com/v1/images/generations')); assert.ok(content.includes('gpt-image-2.5'));
  assert.equal(content.split(IMAGE_PROMPT_START).length - 1, 1); assert.equal(content.split(IMAGE_PROMPT_END).length - 1, 1);
  assert.equal(applied.status.config.defaultModel, 'gpt-image-2.5'); assert.equal(applied.status.liveTargets.codex.injected, true); assert.ok(applied.system.backupId);
  assert.ok((await api('backups')).some((b: any) => b.id === applied.system.backupId));
  assert.ok(!JSON.stringify(applied).includes(imageExistingKey)); assert.ok(!JSON.stringify(await api('image-prompt')).includes(imageExistingKey));
  assert.equal(calls.some(c => c.path === '/api/v1/keys' && c.method === 'POST'), false);
});

test('image prompt creates a missing image key for group 32 and writes the minted secret only to disk', async () => {
  const f = cliPaths(), calls = imageAccount();
  await api('phuket/login', 'POST', { email: 'image@example.test', password: 'fixture' });
  const applied = await api('image-prompt/apply', 'POST', { targets: ['codex'], defaultModel: 'gpt-image-2.5', autoCreatePhuketKey: true });
  const created = calls.find(c => c.path === '/api/v1/keys' && c.method === 'POST');
  assert.deepEqual(created?.body, { name: 'phuket-switch-image', group_id: 32 });
  assert.ok(read(f.codexPrompt).includes(imageCreatedKey)); assert.ok(applied.system.backupId);
  assert.ok(!JSON.stringify(applied).includes(imageCreatedKey)); assert.ok(!JSON.stringify(await api('image-prompt')).includes(imageCreatedKey));
});

test('image prompt re-apply replaces one marker block and prompt presets preserve the active image block', async () => {
  const f = cliPaths(), original = 'Original Codex policy.\n'; file(f.codexPrompt, original);
  imageAccount([imageKeyRow(42)]);
  await api('phuket/login', 'POST', { email: 'image@example.test', password: 'fixture' });
  await api('image-prompt/apply', 'POST', { targets: ['codex'], defaultModel: 'gpt-image-2.5' });
  const before = read(f.codexPrompt), prefix = before.slice(0, before.indexOf(IMAGE_PROMPT_START));
  await api('image-prompt/apply', 'POST', { targets: ['codex'], defaultModel: 'gpt-image-2.6' });
  const reapplied = read(f.codexPrompt);
  assert.equal(reapplied.slice(0, reapplied.indexOf(IMAGE_PROMPT_START)), prefix); assert.equal(reapplied.split(IMAGE_PROMPT_START).length - 1, 1); assert.equal(reapplied.split(IMAGE_PROMPT_END).length - 1, 1); assert.ok(reapplied.includes('gpt-image-2.6'));
  const preset = await api('extensions/prompts', 'POST', { appType: 'codex', name: 'Manual', content: 'Manual preset content\n' }, 201);
  await api(`extensions/prompts/${preset.id}/apply`, 'POST');
  const presetContent = read(f.codexPrompt);
  assert.ok(presetContent.startsWith('Manual preset content\n')); assert.equal(presetContent.split(IMAGE_PROMPT_START).length - 1, 1); assert.equal(presetContent.split(IMAGE_PROMPT_END).length - 1, 1); assert.ok(presetContent.includes(imageExistingKey));
});

test('image prompt remove strips only its marker block and backup restore brings it back', async () => {
  const f = cliPaths(), original = 'Keep this AGENTS content.\n'; file(f.codexPrompt, original);
  imageAccount([imageKeyRow(43)]);
  await api('phuket/login', 'POST', { email: 'image@example.test', password: 'fixture' });
  await api('image-prompt/apply', 'POST', { targets: ['codex'], defaultModel: 'gpt-image-2.5' });
  const removed = await api('image-prompt/remove', 'POST', { targets: ['codex'] });
  assert.equal(read(f.codexPrompt), original); assert.equal(removed.status.liveTargets.codex.injected, false); assert.equal(removed.status.config.enabled, false); assert.ok(removed.system.backupId);
  await api(`backups/${removed.system.backupId}/restore`, 'POST');
  assert.ok(read(f.codexPrompt).includes(IMAGE_PROMPT_START)); assert.equal((await api('image-prompt')).liveTargets.codex.injected, true);
});

test('image keys cannot be imported as direct chat providers', async () => {
  imageAccount([imageKeyRow(44)]);
  await api('phuket/login', 'POST', { email: 'image@example.test', password: 'fixture' });
  await api('phuket/keys/44/import-provider', 'POST', {}, 409);
});

test('model recommendations compare versions, avoid utility aliases, and prefer GPT flagships', async () => {
  const gpt = ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol'];
  assert.deepEqual(sortModelsNewestFirst([...gpt].reverse().concat(gpt[0])), gpt);
  assert.equal(pickRecommendedModel(['chat-latest', 'codex-auto-review', 'gpt-7-fast', ...gpt], 'openai-responses'), gpt[0]);
  for (const [older, newest] of [['grok-4.1', 'grok-4.7'], ['deepseek-v4-flash', 'deepseek-v4.1-flash'], ['kimi-k3-pro', 'kimi-k3.1-pro'], ['glm-4.9', 'glm-4.10']]) {
    assert.equal(pickRecommendedModel([older, 'chat-latest', newest], 'openai-responses'), newest);
  }
  assert.equal(pickRecommendedModel([], 'anthropic-messages'), undefined);
  assert.equal(pickRecommendedModel(['chat-latest'], 'openai-responses'), 'chat-latest');
});

test('Fast auto-fill covers all base models, preserves custom targets, and retries only real substitutions', () => {
  const map = buildAllFastModelMap(['gpt-a', 'gpt-a-fast', 'gpt-b', 'gpt-c', 'chat-latest'], {
    'gpt-a': 'old', 'gpt-b': 'custom-fast', extra: 'custom',
  });
  assert.deepEqual(map, { 'gpt-a': 'gpt-a-fast', 'gpt-b': 'custom-fast', 'gpt-c': 'gpt-c', 'chat-latest': 'chat-latest', extra: 'custom' });
  const config = { ...DEFAULT_GPT_FAST_CONFIG, strategy: 'hybrid' as const, fastModelMap: map };
  assert.equal(hybridBase('gpt-c', config), undefined);
  assert.equal(hybridBase('gpt-a', config), 'gpt-a');
  assert.equal(hybridBase('gpt-a-fast', config), 'gpt-a');
});

const accountProvider = { appType: 'codex', protocol: 'openai-responses', name: 'Daily', baseUrl: 'https://example.invalid/v1', phuketGroupId: 65 } as const;
const issuedKey = 'sk-4321-newly-issued-fixture-key-1000';
async function providerAccount() {
  const calls: string[] = [];
  const key = { id: 11, group_id: 65, status: 'active', key: rawKey };
  upstream = (url, init) => {
    if (url.pathname === '/api/v1/auth/login') return json({ data: { token: 'fixture-session' } });
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-session');
    switch (url.pathname) {
      case '/api/v1/auth/me': return json({ data: { id: 1, email: 'user@example.test' } });
      case '/api/v1/model-plaza': return json({ data: { groups: [
        { id: 65, name: 'GPT', platform: 'openai', status: 'active' },
        { id: 32, name: 'Image', platform: 'image', status: 'active' },
      ] } });
      case '/api/v1/groups/available': case '/api/v1/groups/rates': return json({ data: [] });
      case '/api/v1/keys':
        calls.push(init.method!);
        if (init.method === 'GET') return json({ data: [key, { ...key, id: 12, status: 'inactive' }] });
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(String(init.body)), { name: accountProvider.name, group_id: 65 });
        return json({ data: { ...key, id: 13, key: issuedKey } });
      default: throw Error('unexpected fixture call');
    }
  };
  await api('phuket/login', 'POST', { email: 'user@example.test', password: 'fixture' });
  return calls;
}
function assertProviderKey(view: { id: string; maskedKey?: string }, expected: string) {
  assert.equal(runtime.db.provider(view.id).apiKey, expected);
  assert.equal(view.maskedKey, maskApiKey(expected));
  assert.ok(!Object.hasOwn(view, 'apiKey') && !JSON.stringify(view).includes(expected));
}

test('provider creation resolves only an active account key for the selected group', async () => {
  const request = { ...accountProvider, phuketKeyId: 11 };
  await api('providers', 'POST', request, 401);
  const calls = await providerAccount();
  await api('providers', 'POST', { ...request, phuketGroupId: 99 }, 400);
  await api('providers', 'POST', { ...request, phuketKeyId: 12 }, 400);
  assert.deepEqual(await api('providers'), []);
  assertProviderKey(await api('providers', 'POST', request, 201), rawKey);
  assert.deepEqual(calls, ['GET', 'GET', 'GET']);
});

test('provider auto-creation issues one group key only after validating session, group and client', async () => {
  const request = { ...accountProvider, autoCreatePhuketKey: true };
  await api('providers', 'POST', request, 401);
  const calls = await providerAccount();
  for (const phuketGroupId of [undefined, 999, 32]) await api('providers', 'POST', { ...request, phuketGroupId }, 400);
  await api('providers', 'POST', { ...request, appType: 'claude', protocol: 'anthropic-messages' }, 400);
  assert.deepEqual(await api('providers'), []);
  assertProviderKey(await api('providers', 'POST', request, 201), issuedKey);
  assert.deepEqual(calls, ['POST']);
});

test('provider edits rotate or keep credentials without returning plaintext and can detach from a group', async () => {
  const calls = await providerAccount();
  const p = await create('codex', { ...accountProvider, apiKey: 'original-key', phuketGroupName: 'GPT', phuketPlatform: 'openai', rateMultiplier: 2 });
  const route = `providers/${p.id}`;
  await api(route, 'PUT', { phuketKeyId: 11, phuketGroupId: 99 }, 400);
  assert.equal(runtime.db.provider(p.id).apiKey, 'original-key');
  assertProviderKey(await api(route, 'PUT', { phuketKeyId: 11 }), rawKey);
  assertProviderKey(await api(route, 'PUT', { autoCreatePhuketKey: true }), issuedKey);
  const detached = await api(route, 'PUT', { phuketGroupId: null });
  assertProviderKey(detached, issuedKey);
  for (const field of ['phuketGroupId', 'phuketGroupName', 'phuketPlatform', 'rateMultiplier']) assert.ok(!Object.hasOwn(detached, field));
  assert.deepEqual(calls, ['GET', 'GET', 'POST']);
  const list = JSON.stringify(await api('providers'));
  assert.ok(!list.includes(rawKey) && !list.includes(issuedKey));
});

test('Gemini and Antigravity imports choose the protocol and endpoint for each supported app', async () => {
  const base = 'https://ai.pukitcore.com', ag = `${base}/antigravity`;
  const google = { id: 124, name: '0.35 Gemini', platform: 'gemini' }, gravity = { id: 800, name: '反重力', platform: ' Antigravity ' };
  const geminiGroup = classifyPhuketGroup(google), agyGroup = classifyPhuketGroup(gravity);
  assert.deepEqual(geminiGroup, { adapterCategory: 'gemini', protocol: 'gemini-native', supportedAppTypes: ['gemini', 'antigravity', 'codex'] });
  assert.deepEqual(classifyPhuketGroup({ ...google, id: 132 }), geminiGroup);
  assert.deepEqual(agyGroup, { adapterCategory: 'antigravity', protocol: 'gemini-native', supportedAppTypes: ['antigravity', 'gemini', 'claude', 'claude-desktop', 'codex'] });
  assert.deepEqual(classifyPhuketGroup({ ...gravity, name: '反重力 Gemini', platform: 'other' }), agyGroup);
  assert.equal(classifyPhuketGroup({ ...gravity, name: 'Gemini Image' }).adapterCategory, 'image_prompt');
  assert.equal(classifyPhuketGroup({ ...google, id: 129 }).adapterCategory, 'media_coming_soon');
  const models = ['gemini-9-image', 'gemini-8-flash-lite', 'gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-4-hydrogen'];
  assert.equal(pickRecommendedModel(models, 'gemini-native'), 'gemini-4-hydrogen');
  assert.equal(pickRecommendedModel(['gemini-2.5-flash', 'gemini-2.5-pro'], 'gemini-native'), 'gemini-2.5-pro');
  assert.equal(pickRecommendedModel(['gemini-4-image'], 'gemini-native'), undefined);
  upstream = u => {
    if (u.pathname.endsWith('auth/me')) return json({ data: { id: 1, email: 'gemini@example.test' } });
    if (u.pathname.endsWith('/keys')) return json({ data: [google, gravity].map(g => ({ id: g.id, status: 'active', key: rawKey, group_id: g.id })) });
    if (u.pathname.endsWith('/model-plaza')) return json({ data: { groups: [google, gravity].map(g => ({ ...g, models: models.map(name => ({ name })) })) } });
    return json({ data: [] });
  };
  await api('phuket/login', 'POST', { token: 'account-session' });
  for (const [g, routing] of [[google, geminiGroup], [gravity, agyGroup]] as const) for (const app of routing.supportedAppTypes) {
    const expectedProtocol = app === 'codex' ? 'openai-responses' : app.startsWith('claude') ? 'anthropic-messages' : 'gemini-native';
    const expectedUrl = app === 'codex' ? `${base}/v1` : g.id === gravity.id ? ag : base;
    assert.equal(protocolForApp(app), expectedProtocol); assert.equal(defaultBaseUrlForApp(app, { ...g, ...routing }), expectedUrl);
    const imported = await api(`phuket/keys/${g.id}/import-provider`, 'POST', { appType: app }, 201);
    assert.equal(imported.protocol, expectedProtocol); assert.equal(imported.baseUrl, expectedUrl); assertProviderKey(imported, rawKey);
    if (expectedProtocol === 'gemini-native') assert.equal(imported.model, 'gemini-4-hydrogen');
  }
  assert.equal(defaultBaseUrlForApp('gpt-native', { ...gravity, ...agyGroup }), `${base}/v1`);
  await api('phuket/keys/124/import-provider', 'POST', { appType: 'claude' }, 400);
  await api('providers', 'POST', { appType: 'gemini', protocol: 'openai-responses', baseUrl: base, apiKey: rawKey, name: 'Mismatch' }, 400);
  const p = runtime.db.providers('gemini')[0];
  await api('routes', 'PUT', { rules: [routed('claude', '*', p.id, models[2])] }, 400);
  const populated = await api('routes/auto-populate', 'POST', {});
  assert.ok(populated.rules.length); assert.ok(populated.rules.every((r: ModelRouteRule) => runtime.db.provider(r.targetProviderId).protocol !== 'gemini-native'));
});

const nativeLive = async (app: AppType) => (await api('overview')).liveCliStates.find((x: { appType: AppType }) => x.appType === app);
test('Gemini CLI direct sync preserves .env lines and nested settings; diff and live detection protect secrets', async () => {
  const f = cliPaths(), originalKey = 'old-env-secret', newKey = 'AIzaNewGoogleFixture0123456', annotation = 'AIzaUnstoredFixture012345';
  const env = `# ${annotation}\r\nKEEP="unchanged # value"\r\n\r\nexport GEMINI_API_KEY = '${originalKey}'  # rotate\r\nOTHER_TOKEN=unrelated-private-token\r\nGOOGLE_GEMINI_BASE_URL=http://127.0.0.1:15721/gemini\r\nGEMINI_MODEL=old\r\n`;
  const settings = { ui: { theme: 'custom' }, security: { trustedFolders: true, auth: { selectedType: 'oauth-personal', keep: 42 } } };
  file(f.geminiEnv, env); file(f.geminiSettings, JSON.stringify(settings));
  assert.match((await nativeLive('gemini')).warnings.join(' '), /127\.0\.0\.1:15721.*同步写入/);
  const p = await create('gemini', { baseUrl: 'https://gem.example/relay/v1beta/', apiKey: newKey });
  const preview = await api(`providers/${p.id}/preview-diff`);
  assert.deepEqual(preview.files.map((x: { path: string }) => x.path), [f.geminiEnv, f.geminiSettings]);
  for (const secret of [originalKey, newKey, annotation, 'unrelated-private-token']) assert.ok(!JSON.stringify(preview).includes(secret));
  assert.equal(read(f.geminiEnv), env);
  const { system } = await activate(p.id, true); assert.ok(system.backupId);
  assert.equal(read(f.geminiEnv), env.replace(`'${originalKey}'`, newKey).replace('http://127.0.0.1:15721/gemini', 'https://gem.example/relay').replace('GEMINI_MODEL=old', `GEMINI_MODEL=${p.model}`));
  assert.deepEqual(JSON.parse(read(f.geminiSettings)), { ...settings, security: { ...settings.security, auth: { keep: 42, selectedType: 'gemini-api-key' } } });
  const live = await nativeLive('gemini'); assert.equal(live.detected, true); assert.equal(live.providerId, p.id); assert.equal(live.baseUrl, 'https://gem.example/relay'); assert.equal(live.model, p.model); assert.deepEqual(live.warnings, []);
  assert.equal((await activate(p.id, true)).system.applied, false);
  await api(`backups/${system.backupId}/restore`, 'POST'); assert.equal(read(f.geminiEnv), env); assert.equal(read(f.geminiSettings), JSON.stringify(settings));
});

test('agy sync preserves user models, refreshes only owned entries and restores settings without touching the OS environment', async () => {
  const f = cliPaths(), custom = { modelName: 'gemini-api://user.example/v1beta/models/own', label: 'Personal', extra: 1 };
  const original = { permissions: { allow: ['test'] }, trustedWorkspaces: ['my-workspace'], customModelsConfig: { favorite: 'keep', customModels: { user: custom } } };
  file(f.antigravitySettings, JSON.stringify(original));
  const a = await create('antigravity', { model: 'gemini-4-carbon', availableModels: ['gemini-image', ...Array.from({ length: 30 }, (_, i) => `gemini-${i}-test`)], apiKey: 'AIzaAgyPrivateFixture01234', baseUrl: 'https://relay.example/antigravity/v1beta/' });
  const preview = await api(`providers/${a.id}/preview-diff`); assert.equal(preview.files.length, 1); assert.ok(!JSON.stringify(preview).includes('AIzaAgyPrivateFixture01234'));
  const { system } = await activate(a.id, true); assert.match(system.warnings.join(' '), /终端.*GEMINI_API_KEY/);
  const before = read(f.antigravitySettings), out = JSON.parse(before), models = out.customModelsConfig.customModels;
  assert.deepEqual(out.permissions, original.permissions); assert.deepEqual(out.trustedWorkspaces, original.trustedWorkspaces); assert.equal(out.customModelsConfig.favorite, 'keep'); assert.deepEqual(models.user, custom);
  assert.equal(out.modelProvider, 'gemini'); assert.equal(out.model, a.model); assert.equal(Object.keys(models).length, 25); assert.equal(models['gemini-image'], undefined);
  assert.deepEqual(models[a.model], { modelName: `gemini-api://relay.example/antigravity/v1beta/models/${a.model}`, label: a.model });
  assert.equal(fs.existsSync(f.geminiEnv), false); assert.ok(!before.includes('AIzaAgyPrivateFixture01234'));
  const live = await nativeLive('antigravity'); assert.equal(live.detected, true); assert.equal(live.model, a.model); assert.equal(live.providerId, a.id); assert.equal(live.baseUrl, 'https://relay.example/antigravity');
  const b = await create('antigravity', { model: 'gemini-4-hydrogen', baseUrl: 'https://second.example' });
  const switched = await activate(b.id, true); const second = JSON.parse(read(f.antigravitySettings)).customModelsConfig.customModels;
  assert.deepEqual(Object.keys(second).sort(), [b.model, 'user'].sort()); assert.deepEqual(second.user, custom);
  await api(`backups/${switched.system.backupId}/restore`, 'POST'); assert.equal(read(f.antigravitySettings), before);
  await api(`backups/${system.backupId}/restore`, 'POST'); assert.equal(read(f.antigravitySettings), JSON.stringify(original)); assert.equal((await nativeLive('antigravity')).providerId, null);
});

test('legacy proxyTakeover state merges new false flags without losing active takeovers', async () => {
  const sql = new DatabaseSync(path.join(data, 'phuket-switch.db'));
  try { sql.prepare('UPDATE kv_state SET value=? WHERE key=?').run(JSON.stringify({ claude: true, codex: false, 'gpt-native': false, 'claude-desktop': true }), 'proxyTakeover'); } finally { sql.close(); }
  assert.deepEqual((await api('proxy/status')).takeover, { claude: true, codex: false, 'gpt-native': false, 'claude-desktop': true, gemini: false, antigravity: false });
});

test('native Gemini and agy takeovers isolate endpoints and keys, stream immediately, and restore each client independently', async () => {
  const f = cliPaths(), calls: { app: string; path: string; headers: http.IncomingHttpHeaders; body: unknown }[] = [];
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const payload = { contents: [{ role: 'user', parts: [{ text: 'fixture prompt' }] }] };
  const chunk = (text: string, usageMetadata?: object) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata })}\n\n`;
  const upstreamFor = (app: string) => mock(async (req, res) => {
    const body = await bodyOf(req); calls.push({ app, path: req.url!, headers: req.headers, body });
    if (req.url?.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(chunk('first'));
      await pending; res.end(chunk('last', { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 14 })); return;
    }
    if (req.url?.includes('denied')) return sendJson(res, { error: 'private upstream detail' }, 403);
    sendJson(res, req.method === 'GET' ? { models: [{ name: `models/${app}` }] } : req.url?.includes(':countTokens') ? { totalTokens: 7 } : { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { totalTokenCount: 8 } });
  });
  const gemKey = 'AIzaGoogleGemFixture012345', agyKey = 'AIzaGoogleAgyFixture012345';
  const gem = await create('gemini', { apiKey: gemKey, baseUrl: await upstreamFor('gem') + '/v1beta/' });
  const agy = await create('antigravity', { apiKey: agyKey, baseUrl: await upstreamFor('agy') + '/antigravity/v1beta' });
  await activate(agy.id, true); const directAgy = read(f.antigravitySettings);
  await proxyPort(); const { baseUrl: proxy } = await api('proxy/start', 'POST');
  const send = (path: string, body?: object) => fetch(proxy + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'caller-key', authorization: 'Bearer caller-key' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  assert.deepEqual(await responseJson(await send('/v1beta/models')), { models: [{ name: 'models/agy' }] });
  const missing = await send('/gemini/v1beta/models'); assert.equal(missing.status, 503); assert.deepEqual((await responseJson(missing)).error, { code: 503, message: 'No active provider is available for this protocol.', status: 'UNAVAILABLE' });
  assert.equal(calls.length, 1); calls.length = 0;
  await activate(gem.id, true); const directEnv = read(f.geminiEnv), directSettings = read(f.geminiSettings);
  for (const appType of ['gemini', 'antigravity']) await api('proxy/takeover', 'POST', { appType, enable: true });
  assert.ok(read(f.geminiEnv).includes(`GOOGLE_GEMINI_BASE_URL=${proxy}/gemini`)); assert.ok(read(f.geminiEnv).includes('GEMINI_API_KEY=phuket-switch-local'));
  assert.equal(JSON.parse(read(f.antigravitySettings)).customModelsConfig.customModels[agy.model].modelName, `gemini-api://${new URL(proxy).host}/antigravity/v1beta/models/${agy.model}`);
  for (const [app, p] of [['gemini', gem], ['antigravity', agy]] as const) { const state = await nativeLive(app); assert.equal(state.providerId, p.id); assert.equal(state.baseUrl, `${proxy}/${app}`); assert.deepEqual(state.warnings, []); }
  const prefix = '/gemini/v1beta/models', agyPrefix = '/antigravity/v1beta/models';
  assert.deepEqual(await responseJson(await send(`${agyPrefix}?key=one&pageSize=2&key=caller-key`)), { models: [{ name: 'models/agy' }] });
  assert.equal((await responseJson(await send(`${prefix}/${gem.model}:generateContent?key=caller-key`, payload))).candidates[0].content.parts[0].text, 'ok');
  const log = (await api('proxy/logs?limit=1')).items[0]; assert.equal(log.appType, 'gemini'); assert.equal(log.providerId, gem.id); assert.equal(log.protocol, 'gemini-native'); assert.equal(log.model, gem.model); assert.equal(log.totalTokens, 8);
  assert.deepEqual(await responseJson(await send(`${prefix}/${gem.model}:countTokens`, payload)), { totalTokens: 7 });
  const stream = await send(`${agyPrefix}/${agy.model}:streamGenerateContent?key=caller-key&alt=sse`, payload); assert.equal(stream.status, 200);
  const reader = stream.body!.getReader(); try { assert.match(Buffer.from((await reader.read()).value!).toString(), /first/); } finally { release(); }
  let rest = ''; for (;;) { const { done, value } = await reader.read(); if (done) break; rest += Buffer.from(value).toString(); } assert.match(rest, /last/);
  const streamed = (await api('proxy/logs?limit=1')).items[0]; assert.equal(streamed.appType, 'antigravity'); assert.equal(streamed.providerId, agy.id); assert.equal(streamed.protocol, 'gemini-native'); assert.equal(streamed.model, agy.model); assert.equal(streamed.totalTokens, 14);
  assert.deepEqual(calls.map(c => [c.app, c.path]), [['agy','/antigravity/v1beta/models?pageSize=2'], ['gem', `/v1beta/models/${gem.model}:generateContent`], ['gem', `/v1beta/models/${gem.model}:countTokens`], ['agy', `/antigravity/v1beta/models/${agy.model}:streamGenerateContent?alt=sse`]]);
  for (const [i, call] of calls.entries()) { const key = call.app === 'agy' ? agyKey : gemKey; assert.equal(call.headers['x-goog-api-key'], key); assert.equal(call.headers.authorization, `Bearer ${key}`); if (i) assert.deepEqual(call.body, payload); }
  const denied = await send(`${prefix}/denied:generateContent`, payload); assert.equal(denied.status, 403); const failure = (await responseJson(denied)).error; assert.equal(failure.code, 403); assert.equal(failure.status, 'PERMISSION_DENIED'); assert.ok(!failure.message.includes('private upstream detail'));
  for (const secret of ['caller-key', gemKey, agyKey, 'fixture prompt']) assert.ok(!JSON.stringify(await api('proxy/logs')).includes(secret));
  await api('proxy/stop', 'POST'); for (const app of ['gemini','antigravity'] as const) assert.match((await nativeLive(app)).warnings.join(' '), /已停止.*同步写入/);
  await api('proxy/takeover', 'POST', { appType: 'gemini', enable: false }); assert.equal(read(f.geminiEnv), directEnv); assert.equal(read(f.geminiSettings), directSettings);
  assert.equal((await api('proxy/status')).takeover.antigravity, true);
  await api('proxy/takeover', 'POST', { appType: 'antigravity', enable: false }); assert.equal(read(f.antigravitySettings), directAgy);
});

test('Gemini failover exhausts the same app queue before other native queues and keeps Anthropic relay traffic separate', async () => {
  const calls: { key: string; path: string }[] = [];
  const relay = await mock((req, res) => {
    const key = String(req.headers['x-goog-api-key'] ?? req.headers['x-api-key']);
    calls.push({ key, path: req.url! });
    sendJson(res, { ok: true }, ['gem-first', 'gem-queued'].includes(key) ? 503 : 200);
  });
  const gem = await create('gemini', { baseUrl: relay, apiKey: 'gem-first' }); await activate(gem.id);
  const agy = await create('antigravity', { baseUrl: `${relay}/antigravity`, apiKey: 'agy-current' }); await activate(agy.id);
  await create('antigravity', { baseUrl: `${relay}/antigravity`, apiKey: 'agy-queued', priority: 0, inFailoverQueue: true });
  await create('gemini', { baseUrl: relay, apiKey: 'gem-queued', priority: 100, inFailoverQueue: true });
  const claude = await create('claude', { baseUrl: `${relay}/antigravity`, apiKey: 'claude-relay' }); await activate(claude.id);
  const post = await startRouted([]), path = '/v1beta/models/gemini-4-carbon:generateContent';
  const response = await post('/gemini' + path, { contents: [] }); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(calls.splice(0), [{ key: 'gem-first', path }, { key: 'gem-queued', path }, { key: 'agy-queued', path: '/antigravity' + path }]);
  const log = (await api('proxy/logs')).items[0]; assert.equal(log.appType, 'gemini'); assert.equal(log.failoverCount, 2);
  const message = await post('/v1/messages', { model: 'claude-sonnet', messages: [] }); assert.equal(message.status, 200); await message.text();
  assert.deepEqual(calls, [{ key: 'claude-relay', path: '/antigravity/v1/messages' }]);
});

test('Gemini discovery, local probe and chat test use native wire format and parse model names, parts and token usage', async () => {
  const key = 'AIzaNativeLabFixture012345', model = 'gemini-4-hydrogen', calls: { path: string; body: any; headers: http.IncomingHttpHeaders }[] = [];
  let fallback = false;
  const base = await mock(async (req, res) => {
    calls.push({ path: req.url!, body: await bodyOf(req), headers: req.headers });
    if (req.url === '/v1/usage') return sendJson(res, { balance: 12 });
    if (req.url === '/antigravity/v1beta/models') return fallback ? sendJson(res, {}, 404) : sendJson(res, { models: [{ name: `models/${model}` }] });
    if (req.url === '/antigravity/v1/models') return sendJson(res, { data: [{ id: model }] });
    if (req.url === `/antigravity/v1beta/models/${model}:generateContent`) return sendJson(res, { candidates: [{ content: { parts: [{ text: 'hello' }, { text: ' world' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 12 } });
    return sendJson(res, {}, 404);
  });
  upstream = (u, init) => { assert.equal(u.origin, base); return fetch(u, init); };
  const p = await create('antigravity', { apiKey: key, baseUrl: base + '/antigravity/v1beta/', model }); await activate(p.id);
  for (fallback of [false, true]) { const tested = await api(`providers/${p.id}/test`, 'POST'); assert.equal(tested.modelsOk, true); assert.deepEqual(tested.models, [model]); }
  const probe = await api('monitors/probe-local', 'POST', { providerId: p.id }); assert.equal(probe.statusCode, 404); assert.equal(calls.at(-1)!.path, '/antigravity/v1beta/models');
  fallback = false; assert.equal((await api('monitors/probe-local', 'POST', { providerId: p.id })).ok, true);
  const chat = await api('lab/chat-test', 'POST', { providerId: p.id, prompt: 'test', maxOutputTokens: 32 });
  assert.equal(chat.ok, true); assert.equal(chat.protocol, 'gemini-native'); assert.equal(chat.effectiveModel, model); assert.equal(chat.text, 'hello world'); assert.equal(chat.inputTokens, 4); assert.equal(chat.outputTokens, 6);
  assert.deepEqual(calls.at(-1)!.body, { contents: [{ role: 'user', parts: [{ text: 'test' }] }], generationConfig: { maxOutputTokens: 32 } });
  assert.equal((await api('phuket/usage')).providerId, p.id); await api('lab/speed-compare', 'POST', { providerId: p.id }, 400);
  for (const call of calls) { assert.equal(call.headers['x-goog-api-key'], key); assert.equal(call.headers.authorization, `Bearer ${key}`); }
});

test('Claude key import includes every allowed model and preselects the newest family slots', async () => {
  const available = ['claude-fable-5', 'claude-opus-4-5-20251101', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
    'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5'];
  upstream = u => {
    if (u.pathname.endsWith('auth/login')) return json({ data: { token: 'session' } });
    if (u.pathname.endsWith('auth/me')) return json({ data: { id: 1, email: 'user@example.test' } });
    if (u.pathname.endsWith('/keys')) return json({ data: [{ id: 11, key: rawKey, group_id: 107 }] });
    if (u.pathname.endsWith('model-plaza')) return json({ data: { groups: [{
      id: 107, name: 'Claude', platform: 'anthropic', models: [
        ...available.map(name => ({ name })), { name: 'claude-sonnet-7', operating_access: { allowed: false } },
      ],
    }] } });
    return json({ data: [] });
  };
  await api('phuket/login', 'POST', { email: 'user@example.test', password: 'test' });
  const imported = await api('phuket/keys/11/import-provider', 'POST', {}, 201);
  assert.deepEqual(imported.availableModels, available);
  assert.equal(imported.model, 'claude-sonnet-5-5');
  assert.deepEqual(imported.claudeModelMap, { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', defaultModel: 'claude-sonnet-5-5' });
});

test('account, keys, import, partial dashboards and monitor responses project secrets away', async () => {
  const jwt = 'validated-private-account-token', password = 'never-persist-this-password';
  const key = { id: 11, key: rawKey, name: 'Fixture key', group_id: 65, status: 'active' };
  const visited: string[] = []; let failCosts = false;
  upstream = (u, init) => {
    const r = u.pathname.slice('/api/v1/'.length); visited.push(r);
    if (r === 'auth/login') { assert.deepEqual(JSON.parse(String(init.body)), { email: 'tester@example.test', password }); return json({ data: { access_token: jwt } }); }
    const h = new Headers(init.headers); assert.equal(h.get('authorization'), `Bearer ${jwt}`); assert.equal(h.get('x-user-ui-request'), '1');
    if (r === 'auth/me') return json({ data: { id: 1, email: 'tester@example.test', token: jwt, password, allowed_groups: null } });
    if (r === 'keys' && init.method === 'POST') return json({ data: key });
    if (r === 'keys') { assert.equal(u.searchParams.get('sort_by'), 'created_at'); assert.equal(u.searchParams.get('sort_order'), 'desc'); return json({ data: { items: [key], total: 1 } }); }
    if (r === 'keys/11') return init.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ data: key });
    if (r === 'usage/dashboard/api-keys-usage') { assert.deepEqual(JSON.parse(String(init.body)), { api_key_ids: [11] }); return failCosts ? json({}, 503) : json({ data: { 11: { today_actual_cost: 2, total_actual_cost: 8 } } }); }
    if (r === 'model-plaza') return json({ data: { groups: [FALLBACK_PHUKET_GROUPS.find(g => g.id === 65)] } });
    if (r === 'groups/available' || r === 'groups/rates') return json({ data: [] });
    if (r === 'usage/dashboard/stats') return json({}, 503);
    if (r === 'usage/dashboard/trend') return json({ data: { trend: [{ date: '2025-01-01', requests: 2 }] } });
    if (r === 'usage/dashboard/models') return json({ data: { models: [{ model: 'gpt-test', requests: 2 }] } });
    if (r === 'usage') return json({ data: { items: [{ id: 1, api_key_id: 11, model: 'gpt-test', request_body: password, key: rawKey }] } });
    if (r === 'channel-monitors') return json({ data: [{ id: 1, name: 'Monitor', token: jwt, timeline: [], extra_models: [] }] });
    if (r === 'channel-monitors/1/status') return json({ data: { id: 1, name: 'Monitor', token: jwt, models: [] } });
    throw Error('unexpected fixture call');
  };
  const login = await api('phuket/login', 'POST', { email: 'tester@example.test', password }); assert.equal(login.authenticated, true);
  for (const response of [login, await api('phuket/status'), await api('phuket/account'), await api('overview')]) { assert.ok(!JSON.stringify(response).includes(jwt)); assert.ok(!JSON.stringify(response).includes(password)); }
  assert.ok(!JSON.stringify(runtime.db.state('phuketSession')).includes(password));
  const page = await api('phuket/keys?page=1&pageSize=10'); assert.equal(page.pageSize, 10); assert.equal(page.items[0].today_actual_cost, 2); assert.ok(!JSON.stringify(page).includes(rawKey));
  failCosts = true; assert.equal((await api('phuket/keys')).items[0].id, 11); failCosts = false;
  const issued = await api('phuket/keys', 'POST', { name: 'New', group_id: 65 }, 201); assert.equal(issued.key, rawKey); assert.equal(issued.item.key, undefined);
  assert.equal((await api('phuket/keys/11', 'PUT', { status: 'active' })).key_display, maskApiKey(rawKey));
  const imported = await api('phuket/keys/11/import-provider', 'POST', { appType: 'codex' }, 201); assert.equal(imported.phuketGroupId, 65); assert.equal(imported.isCurrent, false); assert.equal(runtime.db.provider(imported.id).apiKey, rawKey);
  const usage = await api('phuket/usage?from=2025-01-01&to=2025-01-02'); assert.equal(usage.source, 'dashboard'); assert.equal(usage.dashboard.stats, null); assert.equal(usage.dashboard.keyUsageFallback[0].total_actual_cost, 8); assert.equal(usage.dashboard.models[0].model, 'gpt-test'); assert.equal(usage.dashboard.recentLogs[0].request_body, undefined);
  assert.equal((await api('monitors'))[0].token, undefined); assert.deepEqual((await api('monitors/1/status')).models, []);
  await api('phuket/keys/11', 'DELETE', undefined, 204); await api('phuket/logout', 'POST', undefined, 204); assert.equal((await api('phuket/status')).authenticated, false); assert.ok(visited.includes('auth/me'));
});

test('local proxy uses separate protocols, retries only before headers, streams SSE immediately, and logs only metadata', async () => {
  const requests: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const firstEvent = 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Hello"}\r\n\r\n';
  const finalEvent = 'data: {"type":"response.completed","response":{"usage":{"total_tokens":17}}}\n\ndata: [DONE]\n\n';
  const url = await mock(async (req, res) => {
    const body = await bodyOf(req); requests.push({ path: req.url!, headers: req.headers, body });
    if (req.url?.startsWith('/v1/messages')) {
      if (req.headers['x-api-key'] === 'first-claude-key') { res.writeHead(503).end('busy'); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ text: 'ok' }] })); return;
    }
    if (body.model === 'gpt-6-astra-fast') { res.writeHead(502).end('unsupported'); return; }
    if (req.url === '/v1/responses' && body.model === 'gpt-6-astra') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(firstEvent); await gate; res.end(finalEvent); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });
  const first = await create('claude', { apiKey: 'first-claude-key', baseUrl: url + '/v1/', claudeModelMap: { sonnet: 'sonnet-first' } });
  const second = await create('claude', { apiKey: 'queued-claude-key', baseUrl: url, inFailoverQueue: true, claudeModelMap: { sonnet: 'sonnet-backup' } });
  const codex = await create('codex', { baseUrl: url + '/v1/', codexFastConfig: { ...DEFAULT_GPT_FAST_CONFIG, strategy: 'hybrid' } });
  const native = await create('gpt-native', { apiKey: 'native-key', baseUrl: url, model: 'grok-4.7', availableModels: ['kimi-k3.1-pro'] });
  await activate(first.id); await activate(codex.id); await activate(native.id); await proxyPort();
  const { baseUrl } = await api('proxy/start', 'POST');
  const post = (route: string, body: unknown, extra: Record<string, string> = {}) => fetch(baseUrl + route, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer never-forward-caller', ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  const a = await post('/v1/messages?beta=true', { model: 'claude-sonnet', messages: [{ content: 'private prompt' }] }, { 'anthropic-beta': 'sample-beta' }); assert.equal(a.status, 200); await a.text();
  assert.deepEqual(requests.map(r => r.body.model), ['sonnet-first','sonnet-backup']); assert.equal(requests[1].headers['anthropic-version'], '2023-06-01'); assert.equal(requests[1].headers['anthropic-beta'], 'sample-beta'); assert.equal(requests[1].headers.authorization, undefined); assert.equal(requests[1].headers['x-api-key'], 'queued-claude-key'); assert.equal(requests[1].path, '/v1/messages?beta=true');
  const b = await post('/v1/responses', { model: 'gpt-6-astra', input: 'private prompt', stream: true }); const reader = b.body!.getReader();
  try { assert.equal(b.status, 200); assert.equal(Buffer.from((await reader.read()).value!).toString(), firstEvent); } finally { release(); }
  let tail = ''; for (;;) { const { done, value } = await reader.read(); if (done) break; tail += Buffer.from(value).toString(); } assert.equal(tail, finalEvent);
  const pair = requests.slice(-2); assert.deepEqual(pair.map(r => r.body.model), ['gpt-6-astra-fast','gpt-6-astra']); assert.ok(pair.every(r => r.body.service_tier === 'priority' && !Object.hasOwn(r.body, 'reasoning') && r.headers.authorization === `Bearer ${rawKey}`));
  const reasoning = { summary: 'auto' };
  await (await post('/v1/responses', { model: 'gpt-6-astra', input: 'hi', reasoning })).text();
  for (const r of requests.slice(-2)) assert.deepEqual(r.body.reasoning, reasoning);
  await (await post('/v1/responses', { model: 'kimi-k3.1-pro', input: 'hi' })).text(); assert.equal(requests.at(-1)!.headers.authorization, 'Bearer native-key'); assert.equal(requests.at(-1)!.body.service_tier, undefined);
  await (await post('/v1/chat/completions', { model: 'keep', messages: [] })).text(); assert.equal(requests.at(-1)!.path, '/v1/chat/completions');
  await (await fetch(baseUrl + '/v1/models')).text(); assert.equal(requests.at(-1)!.headers.authorization, `Bearer ${rawKey}`);
  await (await post('/v1/messages/count_tokens', { model: 'sonnet', messages: [] })).text(); assert.equal(requests.at(-1)!.path, '/v1/messages/count_tokens');
  const logs = await api('proxy/logs'); assert.equal(logs.total, 7); assert.equal(logs.items.at(-1).providerId, second.id); assert.equal(logs.items.at(-1).failoverCount, 1);
  const hybrid = logs.items.find((l: any) => l.fastFallback); assert.equal(hybrid.effectiveModel, 'gpt-6-astra'); assert.equal(hybrid.totalTokens, 17); assert.equal(typeof hybrid.ttftMs, 'number');
  for (const secret of ['private prompt', rawKey, 'native-key','queued-claude-key','never-forward-caller']) assert.ok(!JSON.stringify(logs).includes(secret));
  assert.equal((await api(`proxy/logs?limit=1&cursor=${logs.items[0].id}`)).items[0].id, logs.items[1].id);
  assert.equal((await api('proxy/stop', 'POST')).running, false); await api('proxy/logs', 'DELETE', undefined, 204); assert.equal((await api('proxy/logs')).total, 0);
});

test('MCP updates preserve neighbor sections and redacted secrets; prompt apply takes an undoable backup', async () => {
  const f = cliPaths(), other = '[mcp_servers.node_repl]\ncommand = "node" # keep\n[desktop]\nx = 42\n'; file(f.codex, other); file(f.claudeMcp, '{"unrelated":true}\n');
  const stdio = { target: 'codex', name: 'test.with.dots', enabled: false, transport: { type: 'stdio', command: 'node', args: ['demo'], env: { API_TOKEN: 'opaque-env-credential', MODE: 'qa' } } };
  const item = await api('extensions/mcp', 'POST', stdio); assert.equal(item.enabled, false); assert.equal(item.transport.env.API_TOKEN, '[REDACTED]'); assert.equal(item.transport.env.MODE, 'qa');
  await api('extensions/mcp', 'POST', { ...stdio, enabled: true, transport: { ...item.transport, args: ['second'] } }); assert.ok(read(f.codex).includes('opaque-env-credential')); assert.ok(read(f.codex).includes(other));
  const h = await api('extensions/mcp', 'POST', { target: 'claude', name: 'local', transport: { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer private', Accept: 'application/json' } } }); assert.equal(h.transport.headers.Authorization, '[REDACTED]'); assert.equal(h.transport.headers.Accept, 'application/json');
  assert.equal(JSON.parse(read(f.claudeMcp)).unrelated, true); const listed = await api('extensions/mcp'); assert.equal(listed.length, 3); assert.ok(!JSON.stringify(listed).includes('opaque-env-credential'));
  await api('extensions/mcp/codex/test.with.dots', 'DELETE', undefined, 204); assert.ok(read(f.codex).includes(other)); assert.ok(!read(f.codex).includes('opaque-env-credential'));
  await api('extensions/mcp/claude/local', 'DELETE', undefined, 204); assert.deepEqual(JSON.parse(read(f.claudeMcp)).mcpServers, {});
  file(f.claudePrompt, 'original instructions\n');
  const p = await api('extensions/prompts', 'POST', { appType: 'claude', name: 'Prompt', content: 'first' }, 201); await api(`extensions/prompts/${p.id}`, 'PUT', { content: '# New instructions\n' });
  const applied = await api(`extensions/prompts/${p.id}/apply`, 'POST'); assert.ok(applied.backupId); assert.equal(read(f.claudePrompt), '# New instructions\n'); assert.equal((await api('extensions/prompts'))[0].enabled, true);
  await api(`backups/${applied.backupId}/restore`, 'POST'); assert.equal(read(f.claudePrompt), 'original instructions\n'); await api(`extensions/prompts/${p.id}`, 'DELETE', undefined, 204);
});

test('CC-Switch WAL import reads a private snapshot, translates grokbuild, never switches, and never writes the source', async () => {
  assert.equal((await api('cc-switch/detect')).detected, false);
  const dir = path.join(home, '.cc-switch'); fs.mkdirSync(dir); const cc = new DatabaseSync(path.join(dir, 'cc-switch.db'));
  try {
    cc.exec('PRAGMA journal_mode=WAL; CREATE TABLE providers(id TEXT, app_type TEXT, name TEXT, settings_config TEXT);');
    const insert = cc.prepare('INSERT INTO providers VALUES(?,?,?,?)');
    insert.run('cc', 'claude', 'Claude import', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: rawKey, ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-local' } }));
    insert.run('grok','grokbuild','Grok import',JSON.stringify({ baseUrl: 'https://grok.invalid/v1', apiKey: 'fake-grok-secret' }));
    insert.run('gem', 'gemini', 'Gemini import', JSON.stringify({ env: { GEMINI_API_KEY: 'AIzaGeminiCCFixture0001', GOOGLE_GEMINI_BASE_URL: 'https://gem.example/relay', GEMINI_MODEL: 'gemini-4-carbon' } }));
    insert.run('bad','codex','Unsupported','{}'); insert.run('other','not-supported','Ignored','{}');
    const fingerprint = () => fs.readdirSync(dir).sort().map(k => ({ k, bytes: fs.readFileSync(path.join(dir, k)).toString('base64'), time: fs.statSync(path.join(dir, k)).mtimeMs }));
    const before = fingerprint(); const detection = await api('cc-switch/detect'); assert.equal(detection.providers.length, 4); assert.ok(!JSON.stringify(detection).includes(rawKey));
    const imported = await api('cc-switch/import','POST',{ sourceIds: ['grok','cc','bad','gem'] }); assert.equal(imported.imported.length, 3); assert.equal(imported.skipped.length, 1); assert.ok(imported.imported.every((p: any) => !p.isCurrent && !('apiKey' in p)));
    const gem = imported.imported.find((p: any) => p.appType === 'gemini'); assert.equal(gem.protocol, 'gemini-native'); assert.equal(gem.baseUrl, 'https://gem.example/relay'); assert.equal(gem.model, 'gemini-4-carbon'); assertProviderKey(gem, 'AIzaGeminiCCFixture0001');
    assert.equal(fs.existsSync(cliPaths().geminiEnv), false);
    assert.equal(imported.imported.find((p: any) => p.name === 'Grok import').appType, 'gpt-native'); assert.deepEqual((await api('overview')).currentProviders, []);
    assert.equal((await api('cc-switch/import','POST',{ sourceIds: ['cc'] })).skipped.length, 1); assert.deepEqual(fingerprint(), before); assert.equal(fs.existsSync(cliPaths().claude), false);
  } finally { cc.close(); }
  file(path.join(dir, 'skills', 'fixture', 'SKILL.md'), '---\nname: "Shared skill"\ndescription: >\n  read only\n  description\n---\n# Contents\n');
  const skills = await api('extensions/skills'); assert.equal(skills[0].name, 'Shared skill'); assert.equal(skills[0].description, 'read only description');
});

test('lab uses streamed Responses and real token arrival, with protocol-aware chat, provider discovery and local probes', async () => {
  const calls: { path: string; body: any; headers: http.IncomingHttpHeaders }[] = [];
  const url = await mock(async (req, res) => {
    const body = await bodyOf(req); calls.push({ path: req.url!, body, headers: req.headers });
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'gpt-6-astra' }, { id: 'kimi-k3' }] })); return; }
    if (req.url === '/v1/messages') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content: [{ type: 'text', text: 'Claude answer' }], usage: { input_tokens: 2, output_tokens: 3 } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).write(': keepalive\n\nevent: response.created\ndata: {}\n\n');
    await new Promise(r => setTimeout(r, 18)); res.write('data: {"type":"response.output_text.delta","delta":"Lab text"}\n\n');
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n');
  });
  // Discovery and key usage use the injected client; inference below uses a real HTTP socket.
  upstream = (u, init) => { assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${rawKey}`); return u.pathname === '/v1/models' ? json({ data: [{ id: 'gpt-6-astra' }, { id: 'kimi-k3' }] }) : json({ data: { remaining: 11, usage: { today: { requests: 2, total_tokens: 64 }, total: { actual_cost: 2.2 } } } }); };
  const p = await create('codex', { baseUrl: url }); await activate(p.id);
  const testResult = await api(`providers/${p.id}/test`, 'POST'); assert.equal(testResult.usageOk, true); assert.equal(testResult.modelsCount, 2); assert.equal(testResult.usage.todayTokens, 64); assert.equal(runtime.db.provider(p.id).lastTestOk, true); assert.deepEqual(runtime.db.provider(p.id).availableModels, ['gpt-6-astra','kimi-k3']);
  const keyUsage = await api('phuket/usage'); assert.equal(keyUsage.source, 'key'); assert.equal(keyUsage.providerId, p.id); assert.equal(keyUsage.keyUsage.remaining, 11);
  const comparison = await api('lab/speed-compare', 'POST', { providerId: p.id, runs: 2, fastConfig: { ...DEFAULT_GPT_FAST_CONFIG, speedMode: 'standard', respectClientServiceTier: true, enabled: false, strategy: 'hybrid' } });
  assert.equal(comparison.samples.length, 4); assert.deepEqual(calls.map(v => v.body.model), ['gpt-6-astra','gpt-6-astra-fast','gpt-6-astra','gpt-6-astra-fast']); assert.deepEqual(calls.map(v => v.body.service_tier), ['default','priority','default','priority']);
  assert.ok(calls.every(c => !Object.hasOwn(c.body, 'reasoning')));
  for (const enabled of [false, true]) {
    await api('lab/chat-test', 'POST', { providerId: p.id, prompt: 'ping', fastConfig: { ...DEFAULT_GPT_FAST_CONFIG, speedMode: enabled ? 'fast' : 'standard', enabled, reasoningEffort: 'high' } });
    assert.equal(calls.at(-1)!.body.service_tier, enabled ? 'priority' : 'default');
    assert.ok(!Object.hasOwn(calls.at(-1)!.body, 'reasoning'));
  }
  for (const sample of comparison.samples) { assert.equal(sample.ok, true); assert.equal(sample.outputTokens, 3); assert.equal(sample.previewText, 'Lab text'); assert.ok(sample.firstTokenMs >= 10 && sample.firstTokenMs <= sample.latencyMs); assert.ok(sample.tokensPerSec > 0); }
  assert.equal(comparison.speedup, comparison.standardMedianMs / comparison.fastMedianMs); assert.ok(calls.every(c => c.body.stream === true && c.body.store === false));
  const chat = await api('lab/chat-test', 'POST', { providerId: p.id, model: 'kimi-k3', prompt: 'ping' }); assert.equal(chat.text, 'Lab text'); assert.equal(chat.outputTokens, 3); assert.equal(calls.at(-1)!.body.service_tier, undefined);
  const claude = await create('claude', { baseUrl: url + '/v1' }); const cc = await api('lab/chat-test', 'POST', { providerId: claude.id, prompt: 'ping' }); assert.equal(cc.text, 'Claude answer'); assert.equal(cc.inputTokens, 2); assert.equal(calls.at(-1)!.headers['user-agent'], 'claude-cli/2.1.0'); assert.equal(calls.at(-1)!.headers['x-api-key'], rawKey);
  const probe = await api('monitors/probe-local', 'POST', { providerId: p.id }); assert.equal(probe.ok, true); assert.equal(probe.statusCode, 200); assert.equal(calls.at(-1)!.path, '/v1/models');
});

test('clearing a legacy provider override inherits global Fast without creating a Codex reasoning setting', async () => {
  const p = await create('codex', { codexFastConfig: { ...DEFAULT_GPT_FAST_CONFIG, speedMode: undefined, enabled: false, reasoningEffort: 'max' } });
  const f = cliPaths();
  await activate(p.id, true);
  const standard = TOML.parse(read(f.codex));
  assert.equal(standard.service_tier, 'default');
  assert.ok(!Object.hasOwn(standard, 'model_reasoning_effort'));
  const updated = await api(`providers/${p.id}`, 'PUT', { codexFastConfig: null });
  assert.ok(!Object.hasOwn(updated, 'codexFastConfig'));
  await activate(p.id, true);
  const fast = TOML.parse(read(f.codex));
  assert.equal(fast.service_tier, 'fast');
  assert.ok(!Object.hasOwn(fast, 'model_reasoning_effort'));
});

test('Fast sync preserves the exact Codex reasoning preference across on/off and legacy strategies', async () => {
  const p = await create('codex'); await activate(p.id);
  const f = cliPaths();
  const reasoningLine = 'model_reasoning_effort  =  "high" # user preference\n';
  file(f.codex, reasoningLine);
  for (const [strategy, enabled, tier, model] of [['tier_only', true, 'fast','gpt-6-astra'], ['fast_suffix',true,'fast','gpt-6-astra-fast'], ['hybrid',false,'default','gpt-6-astra']] as const) {
    const cfg = { ...DEFAULT_GPT_FAST_CONFIG, speedMode: undefined, strategy, enabled, serviceTier: 'fast', reasoningEffort: 'low' };
    const changed = await api('fast-mode','PUT',{ config: cfg, applyToCodex: true }); assert.ok(changed.system.backupId);
    const live = TOML.parse(read(f.codex)); assert.equal(live.model, model); assert.equal(live.service_tier, tier); assert.equal(live.model_reasoning_effort, 'high'); assert.ok(read(f.codex).includes(reasoningLine));
    const normalized = { ...cfg, speedMode: enabled ? 'fast' : 'standard', serviceTier: enabled ? 'priority' : 'default' };
    assert.deepEqual(await api('fast-mode'), normalized); assert.deepEqual((await api('settings')).defaultGptFastConfig, normalized);
  }
  for (const entry of JSON.parse(read(f.catalog)).models) assertNativeSpeedTiers(entry);
  const port = await proxyPort(); const takeover = await api('proxy/takeover','POST',{ appType: 'codex', enable: true }); assert.ok(takeover.system.backupId); assert.equal((TOML.parse(read(f.codex)).model_providers as any).custom.base_url, `http://127.0.0.1:${port}/v1`);
  await api('proxy/takeover','POST',{ appType: 'codex', enable: false }); assert.equal(JSON.parse(read(f.auth)).OPENAI_API_KEY, rawKey);
});

test('UltraFast group identities, names, rates and chat model recommendations match the updated groups', () => {
  for (const [id, rawName, rate] of [[153, ' Pro500 ultrafast', 0.5], [154, 'Pro500 ultrafast 下游 ', 1]] as const) {
    const group = metadata({ id, name: rawName });
    assert.equal(group.name, rawName.trim()); assert.equal(isUltraFastGroup({ id }), true);
    assert.equal(isUltraFastGroup({ phuketGroupId: id }), true); assert.equal(isUltraFastGroup({ name: group.name }), true);
    const reference = FALLBACK_PHUKET_GROUPS.find(g => g.id === id)!;
    assert.equal(reference.name, group.name); assert.equal(reference.rate_multiplier, rate); assert.equal(reference.protocol, 'openai-responses');
  }
  for (const [id, rate] of [[49, 0.18], [142, 0.16], [65, 0.5], [136, 1]]) {
    const g = FALLBACK_PHUKET_GROUPS.find(g => g.id === id)!;
    assert.equal(g.rate_multiplier, rate); assert.equal(isUltraFastGroup(g), false); assert.equal(g.is_exclusive, id === 142);
  }
  assert.equal(metadata({ name: ' VIP专属分组 Pro 500 ' }).name, 'VIP专属分组 Pro 500');
  for (const name of ['ULTRA-FAST', 'Ultra_Fast', 'ultra fast']) assert.equal(isUltraFastGroup({ phuketGroupName: name }), true);
  assert.equal(isUltraFastGroup({ id: '153', name: 'Fast' }), false);
  const images = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
  assert.equal(pickRecommendedModel([...images, 'codex-auto-review', 'gpt-6.2-astra-pro'], 'openai-responses'), 'gpt-6.2-astra-pro');
  assert.equal(pickRecommendedModel(images, 'openai-responses'), undefined);
});

test('legacy speed modes and explicitly requested native tiers resolve independently', () => {
  assert.equal(effectiveSpeedMode({ enabled: false, serviceTier: 'ultrafast' }), 'standard');
  assert.equal(effectiveSpeedMode({ enabled: true, serviceTier: 'ultrafast' }), 'ultrafast');
  assert.equal(effectiveSpeedMode({ enabled: true, serviceTier: 'auto' }), 'fast');
  for (const speedMode of ['standard', 'fast', 'ultrafast'] as const) for (const respectClientServiceTier of [true, false]) {
    const cfg = { ...DEFAULT_GPT_FAST_CONFIG, enabled: false, speedMode, respectClientServiceTier };
    assert.equal(effectiveSpeedMode(cfg), speedMode);
    for (const [wire, expected] of [['standard', 'standard'], ['default', 'standard'], ['fast', 'fast'], ['priority', 'fast'], ['ultrafast', 'ultrafast']]) {
      assert.equal(resolveRequestSpeedMode(wire, cfg), expected);
    }
    for (const omitted of [undefined, null, '', 'auto']) assert.equal(resolveRequestSpeedMode(omitted, cfg), respectClientServiceTier ? 'standard' : speedMode);
  }
});

test('Codex uses the custom bearer without touching interactive auth, and still updates API-key-only auth', async () => {
  const f = cliPaths(), p = await create('codex');
  for (const doc of [{ auth_mode: 'chatgpt' }, { auth_mode: 'personal_access_token' }, { tokens: { refresh_token: 'fixture-session' } }, { access_token: 'fixture-access' }]) {
    const before = '\ufeff' + JSON.stringify(doc, null, 4) + '\r\n'; file(f.auth, before);
    const preview = await api(`providers/${p.id}/preview-diff`);
    assert.ok(preview.files.every((row: { path: string }) => row.path !== f.auth));
    const { system } = await activate(p.id, true);
    assert.ok(!system.changedPaths.includes(f.auth)); assert.equal(read(f.auth), before);
    const custom = (TOML.parse(read(f.codex)).model_providers as any).custom;
    assert.equal(custom.requires_openai_auth, false); assert.equal(custom.experimental_bearer_token, rawKey);
  }
  await proxyPort(); const takeover = await api('proxy/takeover', 'POST', { appType: 'codex', enable: true });
  const backup = runtime.db.backups(takeover.system.backupId)[0]; assert.ok(!backup.files.includes(f.auth));
  const refreshed = '{"tokens":{"refresh_token":"new-fixture-session"}}'; file(f.auth, refreshed);
  await api('proxy/takeover', 'POST', { appType: 'codex', enable: false }); assert.equal(read(f.auth), refreshed);
  file(f.auth, '{"auth_mode":"apikey","OPENAI_API_KEY":"old-key","user_setting":true}');
  await activate(p.id, true); assert.deepEqual(JSON.parse(read(f.auth)), { auth_mode: 'apikey', OPENAI_API_KEY: rawKey, user_setting: true });
  const later = await api('proxy/takeover', 'POST', { appType: 'codex', enable: true });
  assert.ok(runtime.db.backups(later.system.backupId)[0].files.includes(f.auth));
  file(f.auth, refreshed); // Desktop signed in only after takeover captured an API-key-only backup.
  await api(`backups/${later.system.backupId}/restore`, 'POST', undefined, 409);
  await api('proxy/takeover', 'POST', { appType: 'codex', enable: false }); assert.equal(read(f.auth), refreshed);
  assert.equal((TOML.parse(read(f.codex)).model_providers as any).custom.experimental_bearer_token, rawKey);
});

test('direct mode switches the effective Codex endpoint, bearer, and tier without changing the current provider', async () => {
  const f = cliPaths(), normalKey = 'fixture-normal-key', ultraKey = 'fixture-ultra-key';
  const normal = await create('codex', { name: 'Daily', phuketGroupId: 49, baseUrl: 'https://normal.example/v1', apiKey: normalKey });
  await activate(normal.id);
  const put = (speedMode: SpeedMode, ultraFastProviderId: string | null, status = 200) => api('fast-mode', 'PUT', {
    config: { ...DEFAULT_GPT_FAST_CONFIG, speedMode, enabled: false, serviceTier: 'flex', strategy: 'hybrid', ultraFastProviderId }, applyToCodex: true,
  }, status);
  const missing = await put('ultrafast', null, 409); assert.match(missing.error.message, /Pro500 ultrafast/);
  assert.equal(fs.existsSync(f.codex), false); assert.deepEqual(await api('fast-mode'), DEFAULT_GPT_FAST_CONFIG);
  const ultra = await create('codex', { name: 'Dedicated', phuketGroupId: 154, baseUrl: 'https://ultra.example/v1', apiKey: ultraKey });
  for (const [speed, tomlTier, wire, effectiveModel] of [
    ['standard', 'default', 'default', normal.model], ['fast', 'fast', 'priority', `${normal.model}-fast`],
    ['ultrafast', 'ultrafast', 'ultrafast', normal.model], ['fast', 'fast', 'priority', `${normal.model}-fast`], ['standard', 'default', 'default', normal.model],
  ] as const) {
    const { config } = await put(speed, ultra.id);
    assert.equal(config.speedMode, speed); assert.equal(config.enabled, speed !== 'standard'); assert.equal(config.serviceTier, wire);
    assert.deepEqual((await api('settings')).defaultGptFastConfig, config);
    const isUltra = speed === 'ultrafast', target = isUltra ? ultra : normal, key = isUltra ? ultraKey : normalKey;
    const live = TOML.parse(read(f.codex)), custom = (live.model_providers as any).custom;
    assert.equal(live.service_tier, tomlTier); assert.equal(live.model, effectiveModel); assert.equal(custom.name, target.name);
    assert.equal(custom.base_url, target.baseUrl); assert.equal(custom.experimental_bearer_token, key); assert.equal(JSON.parse(read(f.auth)).OPENAI_API_KEY, key);
    assert.equal(runtime.db.current('codex')?.id, normal.id);
    const preview = await api(`providers/${normal.id}/preview-diff`);
    assert.ok(preview.files.find((row: { path: string }) => row.path === f.codex).after.includes(target.baseUrl));
    assert.ok(!JSON.stringify(preview).includes(key));
  }
  await put('ultrafast', null); // Group discovery works without a stored binding as well.
  assert.equal((TOML.parse(read(f.codex)).model_providers as any).custom.experimental_bearer_token, ultraKey);
});

test('Codex takeover selects the upstream endpoint and bearer per request tier and respects omitted tiers', async () => {
  const calls: { endpoint: string; key?: string; tier: string; model: string }[] = [];
  const upstream = (endpoint: string) => mock(async (req, res) => {
    const body = await bodyOf(req);
    calls.push({ endpoint, key: req.headers.authorization, tier: body.service_tier, model: body.model });
    sendJson(res, { ok: true });
  });
  const normalKey = 'normal-proxy-key', ultraKey = 'dedicated-proxy-key';
  const normal = await create('codex', { baseUrl: await upstream('daily'), apiKey: normalKey, phuketGroupId: 49 });
  await activate(normal.id); const port = await proxyPort();
  await api('proxy/takeover', 'POST', { appType: 'codex', enable: true });
  const send = (tier?: string) => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: normal.model, input: 'test', service_tier: tier }) });
  const missing = await send('ultrafast'); assert.equal(missing.status, 503); assert.equal((await responseJson(missing)).error.code, 'ULTRAFAST_PROVIDER_MISSING');
  assert.equal(calls.length, 0);
  // This model-matched gpt-native key must not win over the normal Codex key or the explicit UltraFast binding.
  const other = await create('gpt-native', { baseUrl: await upstream('other'), phuketGroupId: 153, apiKey: 'other-key', inFailoverQueue: true });
  const ultra = await create('codex', { name: 'Pro500 ultrafast 下游', phuketGroupId: 154, baseUrl: await upstream('dedicated'), apiKey: ultraKey,
    codexFastConfig: { ...DEFAULT_GPT_FAST_CONFIG, speedMode: 'standard', strategy: 'hybrid' } });
  const preset: GptFastConfig = { ...DEFAULT_GPT_FAST_CONFIG, strategy: 'hybrid', speedMode: 'ultrafast', ultraFastProviderId: ultra.id, respectClientServiceTier: true };
  const update = (patch: Partial<GptFastConfig>) => api('fast-mode', 'PUT', { config: { ...preset, ...patch }, applyToCodex: true });
  await update({});
  const live = TOML.parse(read(cliPaths().codex)), custom = (live.model_providers as any).custom;
  assert.equal(live.service_tier, 'ultrafast'); assert.equal(custom.base_url, `http://127.0.0.1:${port}/v1`); assert.equal(custom.experimental_bearer_token, 'phuket-switch-local');
  async function check(tier: string | undefined, endpoint: string, key: string, wire: string, model = normal.model) {
    const before = calls.length, res = await send(tier); assert.equal(res.status, 200); await res.text();
    assert.deepEqual(calls.slice(before), [{ endpoint, key: `Bearer ${key}`, tier: wire, model }]);
    const log = (await api('proxy/logs?limit=1')).items[0]; assert.equal(log.serviceTier, wire);
    assert.equal(log.providerId, endpoint === 'daily' ? normal.id : endpoint === 'dedicated' ? ultra.id : other.id);
  }
  await check('priority', 'daily', normalKey, 'priority', `${normal.model}-fast`);
  await check('ultrafast', 'dedicated', ultraKey, 'ultrafast');
  await check(undefined, 'daily', normalKey, 'default');
  await update({ respectClientServiceTier: false });
  await check(undefined, 'dedicated', ultraKey, 'ultrafast');
  await check('default', 'daily', normalKey, 'default');
  await check('fast', 'daily', normalKey, 'priority', `${normal.model}-fast`);
  await update({ speedMode: 'standard', respectClientServiceTier: false });
  await check('ultrafast', 'dedicated', ultraKey, 'ultrafast');
  assert.equal(runtime.db.current('codex')?.id, normal.id);
  // A local provider preference takes precedence over the global binding, with group discovery as fallback.
  await api(`providers/${normal.id}`, 'PUT', { codexFastConfig: { ...preset, ultraFastProviderId: null, respectClientServiceTier: false } });
  await check(undefined, 'other', 'other-key', 'ultrafast');
  await activate(ultra.id); await check('default', 'dedicated', ultraKey, 'default');
  await check('ultrafast', 'dedicated', ultraKey, 'ultrafast');
});

test('UltraFast setup acquires or creates a group key, updates the saved provider, and never changes the normal selection', async () => {
  const route = 'fast-mode/setup-ultrafast', f = cliPaths();
  const normal = await create('codex', { phuketGroupId: 49 }); await activate(normal.id);
  const models = ['gpt-image-2.5-sunburst', 'gpt-6.2-astra-pro', 'codex-auto-review'];
  const group = (id: number, name: string, rate_multiplier: number) => ({ id, name, platform: 'openai', status: 'active', rate_multiplier,
    models: [...models.map(name => ({ name })), { name: 'gpt-99', operating_access: { allowed: false } }] });
  const listed = [{ id: 1, group_id: 49, status: 'active', key: rawKey }, { id: 2, group_id: 153, status: 'inactive', key: 'inactive' },
    { id: 3, group_id: 153, status: 'active', key: 'masked***' }, { id: 4, group_id: 153, status: 'active', key: 'existing-ultra-key' }];
  const creates: unknown[] = []; let lists = 0;
  upstream = (url, init) => {
    switch (url.pathname) {
      case '/api/v1/auth/me': return json({ data: { id: 7, email: 'ultra@example.test', allowed_groups: null } });
      case '/api/v1/user/agreement': return json({ data: { required: false } });
      case '/api/v1/model-plaza': return json({ data: { groups: [group(49, 'Pro 500', 0.18), group(154, 'Pro500 ultrafast 下游', 1), group(153, ' Pro500 ultrafast', 0.5)] } });
      case '/api/v1/groups/available': case '/api/v1/groups/rates': case '/api/v1/usage/dashboard/api-keys-usage': return json({ data: [] });
      case '/api/v1/keys':
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer account-fixture');
        if (init.method === 'POST') {
          const body = JSON.parse(String(init.body)); creates.push(body);
          return json({ data: { id: 5, group_id: body.group_id, status: 'active', key: 'created-ultra-key' } });
        }
        lists++; return json({ data: { items: listed, total: listed.length } });
      default: throw new Error(`Unexpected path ${url.pathname}`);
    }
  };
  await api(route, 'POST', {}, 401);
  await api(route, 'POST', { groupId: 49, apiKey: rawKey }, 400);
  await api(route, 'POST', { phuketKeyId: 4, autoCreatePhuketKey: true }, 400);
  await api(route, 'POST', { phuketKeyId: 4, apiKey: 'manual' }, 400);
  await api(route, 'POST', { apiKey: 'bad\nkey' }, 400);
  assert.equal(runtime.db.providers('codex').length, 1); assert.equal(lists, 0); assert.deepEqual(creates, []);
  await api('phuket/login', 'POST', { token: 'account-fixture' });
  const first = await api(route, 'POST', {}), id = first.provider.id;
  assert.equal(first.provider.isCurrent, false); assert.equal(first.provider.phuketGroupId, 153); assert.equal(first.provider.phuketGroupName, 'Pro500 ultrafast');
  assert.equal(first.provider.protocol, 'openai-responses'); assert.equal(first.provider.baseUrl, PHUKET_GPT_BASE_URL); assert.equal(first.provider.rateMultiplier, 0.5);
  assert.equal(first.provider.model, 'gpt-6.2-astra-pro'); assert.deepEqual(first.provider.availableModels, models);
  assertProviderKey(first.provider, 'existing-ultra-key'); assert.equal(first.system.applied, false); assert.equal(fs.existsSync(f.codex), false);
  assert.equal(first.fastMode.ultraFastProviderId, id); assert.equal(first.fastMode.speedMode, 'fast');
  assert.deepEqual((await api('settings')).defaultGptFastConfig, first.fastMode); assert.deepEqual(creates, []);
  for (const phuketKeyId of [1, 2]) await api(route, 'POST', { groupId: 153, phuketKeyId }, 400);
  await api(route, 'POST', { groupId: 153, phuketKeyId: 3 }, 409);
  const reused = await api(route, 'POST', { phuketKeyId: 4 }); assert.equal(reused.provider.id, id); assert.deepEqual(creates, []);
  const beforeExplicit = lists;
  models.push('gpt-6.3-sol');
  const rotated = await api(route, 'POST', { autoCreatePhuketKey: true, applyToCodex: true });
  assert.equal(rotated.provider.id, id); assert.equal(rotated.provider.model, 'gpt-6.3-sol'); assertProviderKey(rotated.provider, 'created-ultra-key');
  assert.equal(lists, beforeExplicit); assert.deepEqual(creates, [{ name: 'phuket-switch-ultrafast', group_id: 153 }]);
  assert.equal(JSON.parse(read(f.auth)).OPENAI_API_KEY, rawKey); assert.equal(rotated.system.applied, true);
  await api('fast-mode', 'PUT', { config: { ...rotated.fastMode, speedMode: 'ultrafast' } });
  const downstream = await api(route, 'POST', { groupId: 154, applyToCodex: true }); // No active group 154 key: auto-create.
  assert.notEqual(downstream.provider.id, id); assert.equal(downstream.provider.phuketGroupId, 154); assert.equal(downstream.provider.rateMultiplier, 1);
  assert.equal(downstream.fastMode.speedMode, 'ultrafast'); assert.equal(downstream.fastMode.ultraFastProviderId, downstream.provider.id);
  assert.deepEqual(creates.at(-1), { name: 'phuket-switch-ultrafast', group_id: 154 }); assert.equal(creates.length, 2);
  assert.equal(TOML.parse(read(f.codex)).service_tier, 'ultrafast'); assert.equal(JSON.parse(read(f.auth)).OPENAI_API_KEY, 'created-ultra-key');
  assert.equal(runtime.db.current('codex')?.id, normal.id);
  await api('phuket/logout', 'POST', undefined, 204);
  const manual = await api(route, 'POST', { groupId: 154, apiKey: 'manual-ultra-key' }); assert.equal(manual.provider.id, downstream.provider.id);
  assertProviderKey(manual.provider, 'manual-ultra-key'); assert.equal(creates.length, 2);
  await api(`providers/${id}`, 'DELETE', undefined, 204); assert.equal((await api('fast-mode')).ultraFastProviderId, manual.provider.id);
  await api(`providers/${manual.provider.id}`, 'DELETE', undefined, 204);
  assert.equal((await api('fast-mode')).ultraFastProviderId, null); assert.equal((await api('settings')).defaultGptFastConfig.ultraFastProviderId, null);
  assert.equal(runtime.db.current('codex')?.id, normal.id);
});

test('virtual candidates exclude utility, image, selected bare aliases and real or virtual suffixes', () => {
  for (const model of ['gpt-6.2-astra', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-6.2-astra-pro', 'gpt-5.5']) assert.equal(isSpeedVariantCandidateModel(model), true);
  for (const model of ['gpt-6', 'gpt-5.6', 'gpt-image-2.5-sunburst', 'codex-auto-review', 'gpt-reserve', 'gpt-6-chat-latest', 'gpt-6-astra-fast', 'gpt-6-astra--fast', 'gpt-6-astra--ultrafast', 'claude-5']) assert.equal(isSpeedVariantCandidateModel(model), false);
  assert.deepEqual(parseVirtualSpeedModel('gpt-6-astra-fast'), { baseModel: 'gpt-6-astra-fast' });
  for (const mode of ['fast', 'ultrafast']) assert.deepEqual(parseVirtualSpeedModel(`gpt-6-astra--${mode}`), { baseModel: 'gpt-6-astra', forcedMode: mode });
});

test('offline one-click setup publishes API-key-only menu variants, syncs discovery, and restores direct mode', async () => {
  const base = 'gpt-6.2-astra', exclusive = `${base}-pro`, older = 'gpt-5.5', f = cliPaths();
  const baseUrl = await mock((_req, res) => sendJson(res, { data: [{ id: base }] }));
  const pref = { ...DEFAULT_GPT_FAST_CONFIG, speedMode: 'standard' as const, catalogSpeedVariants: false };
  const normal = await create('codex', { baseUrl, phuketGroupId: 49, model: older, availableModels: [older, base], codexFastConfig: pref });
  const dedicated = await create('codex', { phuketGroupId: 153, model: base, availableModels: [exclusive, base, 'gpt-image-2.5-flare'], apiKey: 'saved-ultra-key' });
  const c = await create('claude'); await api('routes', 'PUT', { rules: [routed('codex', c.model, c.id)] });
  file(f.catalog, JSON.stringify({ models: [{ slug: base, context_window: 543210, supported_reasoning_levels: [{ effort: 'medium', description: 'Custom' }] }] }));
  await activate(normal.id, true);
  const entries = (): any[] => JSON.parse(read(f.catalog)).models;
  const aliases = () => entries().filter(e => parseVirtualSpeedModel(e.slug).forcedMode).map(e => e.slug);
  assert.deepEqual(aliases(), []); assert.deepEqual(JSON.parse(read(f.auth)), { OPENAI_API_KEY: rawKey });
  let networkCalls = 0; upstream = () => { networkCalls++; throw new Error('No Phuket login or website needed'); };
  await api('fast-mode', 'PUT', { config: pref }); const port = await proxyPort();
  const expected = [`${base}--fast`, `${base}--ultrafast`, `${older}--fast`, `${exclusive}--ultrafast`];
  const discover = async () => (await responseJson(await fetch(`http://127.0.0.1:${port}/v1/models`))).data.map((m: { id: string }) => m.id).filter((m: string) => parseVirtualSpeedModel(m).forcedMode);
  const enable = () => api('fast-mode/setup-ultrafast', 'POST', { enableCodexMenu: true });
  const setup = await enable(); assert.equal(networkCalls, 0); assert.equal(setup.provider.id, dedicated.id); assertProviderKey(setup.provider, 'saved-ultra-key');
  assert.equal(setup.proxy.running, true); assert.equal(setup.proxy.takeover.codex, true); assert.equal(setup.system.applied, true);
  assert.equal(setup.fastMode.ultraFastProviderId, dedicated.id); assert.equal(setup.fastMode.catalogSpeedVariants, true); assert.equal(setup.fastMode.speedMode, 'standard');
  assert.deepEqual((await api('settings')).defaultGptFastConfig, setup.fastMode); assert.equal(runtime.db.current('codex')?.id, normal.id);
  const checkProxyUrl = () => assert.equal((TOML.parse(read(f.codex)).model_providers as any).custom.base_url, `http://127.0.0.1:${port}/v1`);
  checkProxyUrl(); assert.deepEqual(JSON.parse(read(f.auth)), { OPENAI_API_KEY: 'phuket-switch-local' });
  assert.deepEqual(aliases(), expected); assert.deepEqual(await discover(), expected);
  const rows = entries(); assert.deepEqual(rows.map(e => e.slug), [base, expected[0], expected[1], older, expected[2], expected[3]]);
  assert.deepEqual(rows.map(e => e.priority), [1, 2, 3, 4, 5, 6]); assert.equal(runtime.db.state('codexIncludeRoutedModels'), false);
  for (const row of rows) assertCodexCatalogEntry(row);
  for (const slug of expected) {
    const { baseModel, forcedMode } = parseVirtualSpeedModel(slug), entry = rows.find(e => e.slug === slug);
    assert.equal(entry.display_name, `${baseModel} ${forcedMode === 'fast' ? '⚡ Fast' : '⚡⚡ UltraFast'}`);
    assert.equal(entry.description, forcedMode === 'fast' ? '普通分组 Fast 加速（免登录直选）' : 'Pro500 ultrafast 专属极速通道（免登录直选）');
    if (baseModel === base) { assert.equal(entry.context_window, 543210); assert.deepEqual(entry.supported_reasoning_levels, [{ effort: 'medium', description: 'Custom' }]); }
  }
  await api('routes/sync-codex-catalog', 'POST'); assert.deepEqual(aliases(), expected);
  assert.equal(entries().at(-1).slug, c.model); assert.ok(entries().at(-1).priority >= 1000);
  const savedRules = await api('routes'), originalAuth = read(f.auth), originalToml = read(f.codex);
  const cleared = await api('routes/clear-codex-catalog', 'POST');
  assert.deepEqual(cleared.changedPaths, [f.catalog]); assert.ok(cleared.backupId);
  assert.equal(runtime.db.state('codexIncludeRoutedModels'), false); assert.deepEqual(runtime.db.state('codexCatalogRouteSlugs'), []);
  assert.deepEqual(aliases(), expected); assert.deepEqual(entries(), rows); assert.deepEqual(await api('routes'), savedRules);
  assert.equal(read(f.auth), originalAuth); assert.equal(read(f.codex), originalToml); assert.equal((await api('proxy/status')).takeover.codex, true);
  assert.equal((await api('routes/clear-codex-catalog', 'POST')).applied, false);
  await api('fast-mode', 'PUT', { config: { ...setup.fastMode, catalogSpeedVariants: false }, applyToCodex: true });
  checkProxyUrl(); assert.deepEqual(aliases(), []); assert.deepEqual(await discover(), []);
  const again = await enable(); assert.ok(again.system.changedPaths.includes(f.catalog)); assert.deepEqual(aliases(), expected); assert.deepEqual(await discover(), expected); checkProxyUrl();
  assert.equal(networkCalls, 0); assert.equal(runtime.db.providers('codex').length, 2);
  await api('proxy/takeover', 'POST', { appType: 'codex', enable: false }); assert.deepEqual(aliases(), []); assert.deepEqual(await discover(), []);
  assert.equal(JSON.parse(read(f.auth)).OPENAI_API_KEY, rawKey);
});

test('authenticated one-click menu setup mints the missing group key before the first takeover catalog is written', async () => {
  const base = 'gpt-6.2-astra', exclusive = `${base}-pro`, created: unknown[] = [];
  const normal = await create('codex', { model: base }); await activate(normal.id); await proxyPort();
  upstream = (url, init) => {
    switch (url.pathname) {
      case '/api/v1/user/agreement': return json({ data: { required: false } });
      case '/api/v1/auth/me': return json({ data: { id: 9, email: 'menu@example.test' } });
      case '/api/v1/model-plaza': return json({ data: { groups: [{ id: 153, name: ' Pro500 ultrafast', platform: 'openai', status: 'active', models: [base, exclusive].map(name => ({ name })) }] } });
      case '/api/v1/groups/available': case '/api/v1/groups/rates': return json({ data: [] });
      case '/api/v1/keys':
        if (init.method === 'GET') return json({ data: { items: [], total: 0 } });
        created.push(JSON.parse(String(init.body))); return json({ data: { id: 1, group_id: 153, key: 'minted-menu-key', status: 'active' } });
      default: throw Error(`Unexpected menu setup request: ${url.pathname}`);
    }
  };
  await api('phuket/login', 'POST', { token: 'menu-fixture' });
  const setup = await api('fast-mode/setup-ultrafast', 'POST', { enableCodexMenu: true });
  assert.deepEqual(created, [{ name: 'phuket-switch-ultrafast', group_id: 153 }]); assertProviderKey(setup.provider, 'minted-menu-key');
  assert.equal(setup.fastMode.ultraFastProviderId, setup.provider.id); assert.equal(setup.proxy.takeover.codex, true); assert.equal(runtime.db.current('codex')?.id, normal.id);
  assert.deepEqual(JSON.parse(read(cliPaths().catalog)).models.map((m: { slug: string }) => m.slug), [base, `${base}--fast`, `${base}--ultrafast`, `${exclusive}--ultrafast`]);
});

test('virtual selections force the base model, wire tier and provider on Responses and Chat Completions', async () => {
  const base = 'gpt-6.2-astra', calls: unknown[] = [];
  const endpoint = (name: string) => mock(async (req, res) => {
    const body = await bodyOf(req); calls.push({ name, path: req.url, key: req.headers.authorization, model: body.model, tier: body.service_tier }); sendJson(res, { ok: true });
  });
  const normal = await create('codex', { baseUrl: await endpoint('normal'), apiKey: 'daily-key', model: base }); await activate(normal.id);
  await create('gpt-native', { baseUrl: await endpoint('model-matched'), model: base });
  const post = await startRouted([]), send = (route: string, mode: string, tier: string) => post(route, { model: `${base}--${mode}`, service_tier: tier });
  const missing = await send('/v1/responses', 'ultrafast', 'priority'); assert.equal(missing.status, 503); assert.equal((await responseJson(missing)).error.code, 'ULTRAFAST_PROVIDER_MISSING'); assert.deepEqual(calls, []);
  await create('codex', { phuketGroupId: 153, baseUrl: await endpoint('unused') });
  const ultra = await create('codex', { baseUrl: await endpoint('dedicated'), phuketGroupId: 154, apiKey: 'menu-ultra-key', model: base });
  await api('fast-mode', 'PUT', { config: { ...DEFAULT_GPT_FAST_CONFIG, speedMode: 'standard', strategy: 'hybrid', fastModelMap: { [base]: `${base}-fast` }, ultraFastProviderId: ultra.id } });
  for (const route of ['/v1/responses', '/v1/chat/completions']) for (const mode of ['fast', 'ultrafast']) {
    const fast = mode === 'fast', resp = await send(route, mode, fast ? 'ultrafast' : 'priority'); assert.equal(resp.status, 200); await resp.text();
    const wire = fast ? 'priority' : 'ultrafast';
    assert.deepEqual(calls.splice(0), [{ name: fast ? 'normal' : 'dedicated', path: route, key: `Bearer ${fast ? 'daily-key' : 'menu-ultra-key'}`, model: base, tier: wire }]);
    const log = (await api('proxy/logs?limit=1')).items[0]; assert.equal(log.model, base); assert.equal(log.effectiveModel, base); assert.equal(log.serviceTier, wire); assert.equal(log.providerId, fast ? normal.id : ultra.id);
  }
});

test('direct mode does not recycle stale virtual slugs from catalog metadata or config.toml', async () => {
  const f = cliPaths(), base = 'gpt-6.2-astra', p = await create('codex', { model: undefined });
  file(f.catalog, JSON.stringify({ models: [{ slug: base }, { slug: `${base}--fast` }, { slug: `${base}--ultrafast` }] }));
  file(f.codex, `model = "${base}--fast"\n`);
  await activate(p.id, true); assert.equal(TOML.parse(read(f.codex)).model, base);
  assert.ok(JSON.parse(read(f.catalog)).models.every((e: { slug: string }) => !parseVirtualSpeedModel(e.slug).forcedMode));
});

test('user agreement is accepted once and authenticated requests retry after HTTP 423', async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let agreementReads = 0, meCalls = 0, keyCalls = 0, accepted = false;
  upstream = (url, init) => {
    const method = init.method ?? 'GET', body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === '/api/v1/auth/login') return json({ data: { access_token: 'agreement-session' } });
    const headers = new Headers(init.headers); assert.equal(headers.get('authorization'), 'Bearer agreement-session'); assert.equal(headers.get('x-user-ui-request'), '1');
    if (url.pathname === '/api/v1/user/agreement') {
      agreementReads++;
      return json({ data: { required: agreementReads === 2 && !accepted, revision: 'agreement-revision' } });
    }
    if (url.pathname === '/api/v1/user/agreement/accept') { accepted = true; return json({ data: { accepted: true } }); }
    if (url.pathname === '/api/v1/auth/me') {
      meCalls++;
      if (meCalls === 1) return json({ code: 'USER_AGREEMENT_REQUIRED', message: 'agreement required', metadata: { revision: 'agreement-revision' } }, 423);
      return json({ data: { id: 81, email: 'agreement@example.test' } });
    }
    if (url.pathname === '/api/v1/keys') {
      keyCalls++;
      if (keyCalls === 1) return json({ code: 'USER_AGREEMENT_REQUIRED', message: 'agreement required' }, 423);
      return json({ data: { items: [], total: 0 } });
    }
    throw Error(`unexpected agreement fixture call: ${method} ${url.pathname}`);
  };
  const login = await api('phuket/login', 'POST', { email: 'agreement@example.test', password: 'fixture' });
  assert.equal(login.authenticated, true); assert.equal(accepted, true);
  const keys = await api('phuket/keys'); assert.deepEqual(keys.items, []);
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), [
    'POST /api/v1/auth/login', 'GET /api/v1/user/agreement', 'GET /api/v1/auth/me',
    'GET /api/v1/user/agreement', 'POST /api/v1/user/agreement/accept', 'GET /api/v1/auth/me',
    'GET /api/v1/keys', 'GET /api/v1/user/agreement', 'GET /api/v1/keys',
  ]);
  assert.deepEqual(calls[4].body, { revision: 'agreement-revision', accepted: true, language: 'zh' });
});

test('two-factor login returns a pending step without saving a session, then completes with the TOTP code', async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  upstream = (url, init) => {
    const method = init.method ?? 'GET', body = init.body === undefined ? undefined : JSON.parse(String(init.body)); calls.push({ method, path: url.pathname, body });
    if (url.pathname === '/api/v1/auth/login') return json({ data: { requires_2fa: true, temp_token: 'temporary-2fa-token', user_email_masked: 'u***@example.test' } });
    if (url.pathname === '/api/v1/auth/login/2fa') return json({ data: { access_token: 'two-factor-session' } });
    const headers = new Headers(init.headers); assert.equal(headers.get('authorization'), 'Bearer two-factor-session'); assert.equal(headers.get('x-user-ui-request'), '1');
    if (url.pathname === '/api/v1/user/agreement') return json({ data: { required: false } });
    if (url.pathname === '/api/v1/auth/me') return json({ data: { id: 82, email: 'twofactor@example.test' } });
    throw Error(`unexpected 2fa fixture call: ${method} ${url.pathname}`);
  };
  const pending = await api('phuket/login', 'POST', { email: 'twofactor@example.test', password: 'fixture' });
  assert.equal(pending.authenticated, false); assert.equal(pending.requires2fa, true); assert.equal(pending.tempToken, 'temporary-2fa-token'); assert.equal(pending.maskedEmail, 'u***@example.test');
  assert.equal((await api('phuket/status')).authenticated, false);
  const complete = await api('phuket/login', 'POST', { tempToken: pending.tempToken, totpCode: '123456' });
  assert.equal(complete.authenticated, true); assert.equal(complete.account.email, 'twofactor@example.test'); assert.deepEqual(calls.find(c => c.path === '/api/v1/auth/login/2fa')?.body, { temp_token: 'temporary-2fa-token', totp_code: '123456' });
});

test('Token login validates the account session and rejects provider API keys with a clear message', async () => {
  const calls: string[] = [];
  upstream = (url, init) => {
    calls.push(url.pathname);
    if (url.pathname === '/api/v1/user/agreement') return json({ data: { required: false } });
    if (url.pathname === '/api/v1/auth/me') {
      const headers = new Headers(init.headers); assert.equal(headers.get('authorization'), 'Bearer console-session'); return json({ data: { id: 83, email: 'oauth@example.test' } });
    }
    throw Error(`unexpected token fixture call: ${url.pathname}`);
  };
  const logged = await api('phuket/login', 'POST', { token: ' Bearer console-session ' });
  assert.equal(logged.authenticated, true); assert.equal(logged.account.email, 'oauth@example.test'); assert.deepEqual(calls, ['/api/v1/user/agreement', '/api/v1/auth/me']);
  const rejected = await api('phuket/login', 'POST', { token: 'sk-provider-secret' }, 400);
  assert.match(rejected.error.message, /API 密钥/); assert.match(rejected.error.message, /sk-/);
});

test('networkError classifies nested transport failures without exposing credentials', async () => {
  const secret = 'private-proxy-password-fixture';
  const failure = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(`http://user:${secret}@proxy.invalid`), { code }) });
  const cases: [unknown, string, RegExp][] = [
    [new DOMException(secret, 'TimeoutError'), 'UPSTREAM_TIMEOUT', /连接 PhuketAI 超时.*代理/],
    [new DOMException(secret, 'AbortError'), 'UPSTREAM_TIMEOUT', /超时/],
    [failure('ENOTFOUND'), 'UPSTREAM_DNS', /ai\.pukitcore\.com.*DNS.*代理/],
    [failure('EAI_AGAIN'), 'UPSTREAM_DNS', /DNS/],
    [new AggregateError([failure('ECONNREFUSED')], secret), 'UPSTREAM_REFUSED', /连接被拒绝.*代理软件/],
    [failure('ECONNRESET'), 'UPSTREAM_RESET', /连接被中断.*网络代理/],
    [failure('EPIPE'), 'UPSTREAM_RESET', /连接被中断/],
    [failure('UND_ERR_SOCKET'), 'UPSTREAM_RESET', /连接被中断/],
    [failure('CERT_HAS_EXPIRED'), 'UPSTREAM_TLS', /TLS 证书校验失败.*系统时间/],
    [failure('ERR_TLS_CERT_ALTNAME_INVALID'), 'UPSTREAM_TLS', /证书校验失败/],
    [failure('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'UPSTREAM_TLS', /证书校验失败/],
    [failure('SELF_SIGNED_CERT_IN_CHAIN'), 'UPSTREAM_TLS', /证书校验失败/],
    [failure('ENETUNREACH'), 'UPSTREAM_NETWORK', /ENETUNREACH.*代理设置/],
    [failure(secret), 'UPSTREAM_NETWORK', /网络异常.*代理设置/],
  ];
  for (const [cause, code, guidance] of cases) {
    const error = networkError(cause);
    assert.ok(error instanceof ApiError); assert.equal(error.status, 502); assert.equal(error.code, code);
    assert.match(error.message, guidance); assert.ok(!`${error.code} ${error.message}`.includes(secret));
  }
  let calls = 0;
  await assert.rejects(fetchJson('https://upstream.invalid', {}, async () => { calls++; throw failure('ENOTFOUND'); }),
    (e: unknown) => e instanceof ApiError && e.code === 'UPSTREAM_DNS' && e.status === 502);
  assert.equal(calls, 1, 'an injected sender must not be retried over the network');
  upstream = () => { throw failure('ECONNRESET'); };
  const result = await api('phuket/login', 'POST', { email: 'user@example.test', password: 'fixture' }, 502);
  assert.equal(result.error.code, 'UPSTREAM_RESET'); assert.match(result.error.message, /连接被中断/);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('Windows proxy settings honor ProxyEnable and select the proxy for the target scheme', () => {
  const table = 'http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080';
  const registry = ['HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '    ProxyEnable    REG_DWORD    0x1', `    ProxyServer    REG_SZ    ${table}`, '    ProxyOverride    REG_SZ    localhost;*.internal'].join('\r\n');
  assert.deepEqual(parseInternetSettings(registry), { server: table, bypass: 'localhost;*.internal' });
  assert.equal(parseInternetSettings(registry.replace('0x1', '0x0')), null);
  assert.equal(parseInternetSettings(`ProxyServer    REG_SZ    ${table}`), null);
  assert.equal(parseWindowsProxyServer('127.0.0.1:7892', 'https:')?.origin, 'http://127.0.0.1:7892');
  assert.equal(parseWindowsProxyServer(table, 'https:')?.origin, 'http://127.0.0.1:7891');
  assert.equal(parseWindowsProxyServer(table, 'http:')?.origin, 'http://127.0.0.1:7890');
  assert.equal(parseWindowsProxyServer('https=https://proxy.example:8443', 'https:')?.origin, 'https://proxy.example:8443');
  for (const unsupported of ['socks=127.0.0.1:1080', 'socks5://localhost:1080', 'https=bad host:7890']) assert.equal(parseWindowsProxyServer(unsupported, 'https:'), undefined);
});

test('Electron proxy resolution preserves PAC ordering, explicit environment settings and loopback bypass', async () => {
  // Load only the Node-compatible helpers, not Electron main or a backend child process.
  const { parseResolvedProxy, backendEnvironment } = await import(new URL('../electron/backend.mjs', import.meta.url).href);
  const system = 'http://127.0.0.1:7892';
  assert.equal(parseResolvedProxy('PROXY 127.0.0.1:7892; HTTPS ignored.example:8443; DIRECT'), system);
  assert.equal(parseResolvedProxy('SOCKS5 localhost:1080; HTTPS proxy.example:8443; DIRECT'), 'https://proxy.example:8443');
  for (const route of ['DIRECT', 'DIRECT; PROXY localhost:7892', 'SOCKS localhost:1080; DIRECT', 'PROXY localhost:invalid']) assert.equal(parseResolvedProxy(route), undefined);
  const original = { NO_PROXY: 'corp.test,localhost', no_proxy: 'intranet.test', KEEP: 'value' };
  const env = backendEnvironment(original, system);
  assert.equal(env.HTTP_PROXY, system); assert.equal(env.HTTPS_PROXY, system); assert.equal(env.PHUKET_SYSTEM_PROXY, system);
  assert.equal(env.NODE_USE_ENV_PROXY, '1'); assert.equal(env.KEEP, 'value'); assert.equal(env.no_proxy, env.NO_PROXY);
  assert.deepEqual(env.NO_PROXY.split(',').sort(), ['corp.test', 'intranet.test', 'localhost', '127.0.0.1', '::1'].sort());
  assert.equal(original.NO_PROXY, 'corp.test,localhost');
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const explicit = backendEnvironment({ [name]: 'http://corp.test:3128' }, system);
    assert.equal(explicit[name], 'http://corp.test:3128'); assert.equal(explicit.PHUKET_SYSTEM_PROXY, undefined);
    assert.ok(!Object.values(explicit).includes(system));
  }
  const direct = backendEnvironment({}, undefined);
  assert.equal(direct.HTTP_PROXY, undefined); assert.equal(direct.HTTPS_PROXY, undefined);
});

test('token login strips console quotes, cookie and Bearer prefixes before authenticating', async () => {
  const token = 'eyJfixture.payload.signature', observed: { path: string; bearer: string | null }[] = [];
  upstream = (url, init) => {
    observed.push({ path: url.pathname, bearer: new Headers(init.headers).get('authorization') });
    if (url.pathname.endsWith('/user/agreement')) return json({ data: { required: false } });
    if (url.pathname.endsWith('/auth/me')) return json({ data: { id: 88, email: 'paste@example.test' } });
    throw Error('unexpected token request');
  };
  for (const pasted of [`"${token}"`, `'${token}'`, '`' + token + '`', `auth_token=${token}`, `"Bearer ${token}"`, `\ufeffaccess_token='Bearer ${token}'\r\n`, `auth_token=eyJfixture.\u200bpayload.\r\nsignature`]) {
    const result = await api('phuket/login', 'POST', { token: pasted });
    assert.equal(result.authenticated, true); assert.ok(!JSON.stringify(result).includes(token));
    assert.deepEqual(observed.splice(0), ['/api/v1/user/agreement', '/api/v1/auth/me'].map(path => ({ path, bearer: `Bearer ${token}` })));
    assert.equal(runtime.db.state('phuketSession')?.token, token);
  }
  await api('phuket/login', 'POST', { token: 'auth_token="Bearer sk-not-a-session"' }, 400);
  assert.equal(observed.length, 0);
});

test('password login normalizes full-width email punctuation and preserves ordinary password spaces', async () => {
  const email = 'paste@example.test', password = '  keep these spaces  ';
  let sent: unknown, headers: Headers | undefined;
  upstream = (url, init) => {
    if (url.pathname.endsWith('/auth/login')) {
      sent = JSON.parse(String(init.body)); headers = new Headers(init.headers);
      return json({ data: { access_token: 'pasted-password-session' } });
    }
    if (url.pathname.endsWith('/user/agreement')) return json({ data: { required: false } });
    if (url.pathname.endsWith('/auth/me')) return json({ data: { id: 89, email } });
    throw Error('unexpected password request');
  };
  const result = await api('phuket/login', 'POST', { email: ' \u3000pa\u200bste＠\u3000example.test\ufeff ', password: `\ufeff${password}\u200d\r\n` });
  assert.equal(result.authenticated, true); assert.deepEqual(sent, { email, password });
  assert.equal(headers?.get('user-agent'), 'PhuketSwitch/1.0.0 (Windows; +https://ai.pukitcore.com)');
  assert.equal(headers?.get('accept'), 'application/json'); assert.equal(headers?.get('accept-language'), 'zh-CN');
  assert.ok(!JSON.stringify(result).includes(password));
});

test('2FA failures distinguish an invalid TOTP from an expired challenge without disclosing either credential', async () => {
  const tempToken = 'private-challenge-fixture', totpCode = '654321';
  for (const [code, status, expected] of [
    ['invalid_totp', 401, '动态验证码不正确或已过期，请重新输入。'],
    ['invalid_totp', 200, '动态验证码不正确或已过期，请重新输入。'],
    ['temp_token_expired', 401, '两步验证已超时，请返回重新输入邮箱和密码。'],
  ] as const) {
    let calls = 0;
    upstream = (url, init) => {
      calls++; assert.equal(url.pathname, '/api/v1/auth/login/2fa'); assert.deepEqual(JSON.parse(String(init.body)), { temp_token: tempToken, totp_code: totpCode });
      return json({ code, message: `${tempToken} ${totpCode}` }, status);
    };
    const result = await api('phuket/login', 'POST', { tempToken, totpCode }, 401);
    assert.equal(calls, 1); assert.equal(result.error.message, expected); assert.equal(runtime.db.state('phuketSession'), null);
    for (const secret of [tempToken, totpCode]) assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('login errors preserve a string reason; edge diagnostics expose only allowlisted metadata', () => {
  assert.equal(responseError(403, { error: 'forbidden_reason' }).message, 'forbidden_reason');
  assert.throws(() => checkStatus(403, { error: 'forbidden_reason' }), (e: unknown) => e instanceof ApiError && e.status === 403 && e.message === 'forbidden_reason');
  for (const [server, label] of [['cloudflare', 'Cloudflare'], ['nginx/1.25', 'nginx'], ['unknown-edge-private-fixture', '']]) {
    const e = responseError(403, {}, new Headers({ server, via: 'private-proxy-trace' }));
    if (label) assert.ok(e.message.includes(label));
    assert.match(e.message, /网页窗口登录.*Token 登录/); assert.doesNotMatch(e.message, /private|1\.25/);
  }
});

test('non-JSON 403 and 503 login responses show browser and Token login guidance without returning HTML', async () => {
  const marker = 'private-waf-page-fixture';
  for (const status of [403, 503]) {
    let calls = 0;
    upstream = () => { calls++; return new Response(`<html>${marker}</html>`, { status, headers: { 'content-type': 'text/html' } }); };
    const result = await api('phuket/login', 'POST', { email: 'user@example.test', password: 'fixture' }, status === 403 ? 403 : 502);
    assert.ok(result.error.message.includes(`HTTP ${status}`));
    assert.match(result.error.message, /网页窗口登录.*浏览器.*Token 登录/);
    assert.ok(!JSON.stringify(result).includes(marker)); assert.equal(calls, 1); assert.equal(runtime.db.state('phuketSession'), null);
  }
});

const phuketDesktopUA = 'PhuketSwitch/1.0.0 (Windows; +https://ai.pukitcore.com)';
const sessionAccount = () => accountView({ id: 38, email: 'refresh@example.test', balance: 5 });
function seedRefreshSession(remaining = 3_600_000) {
  const s = { token: 'old-access-fixture', refreshToken: 'rt_original_session_fixture', expiresAt: Date.now() + remaining, account: sessionAccount() };
  runtime.phuket.replaceSession(s); return s;
}
function assertNoSessionSecrets(result: unknown, ...secrets: string[]) {
  const text = JSON.stringify(result);
  for (const secret of secrets) assert.ok(!text.includes(secret), 'response exposed a session credential');
  assert.doesNotMatch(text, /"(?:token|accessToken|access_token|refreshToken|refresh_token)"\s*:/);
}
function gate() { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; }

test('desktop login uses the live domain and UA, parses camelCase credentials and falls back to a minimal safe profile', async () => {
  const access = 'login-access-fixture', refresh = 'rt_login_refresh_fixture', observed: string[] = [];
  let meStatus = 503;
  upstream = (url, init) => {
    assert.equal(url.origin, 'https://ai.pukitcore.com'); const h = new Headers(init.headers);
    assert.equal(h.get('user-agent'), phuketDesktopUA); observed.push(url.pathname);
    if (url.pathname.endsWith('model-plaza')) { assert.equal(h.get('authorization'), null); return json({ data: [] }); }
    if (url.pathname.endsWith('auth/login')) return json({ access_token: 'ignored-root', data: { accessToken: access, refreshToken: refresh, expiresIn: '120.9', user: { username: 'minimal', credits: '12.5', refresh_token: refresh, token: access } } });
    assert.equal(h.get('authorization'), `Bearer ${access}`);
    if (url.pathname.endsWith('user/agreement')) return json({ data: { required: false } });
    if (url.pathname.endsWith('auth/me')) return meStatus === 200 ? json({ data: { id: 38, username: 'enriched', remain_quota: '21.5' } }) : json({ message: 'temporarily unavailable' }, meStatus);
    throw Error('Unexpected account request');
  };
  await api('phuket/groups'); const before = Date.now();
  const result = await api('phuket/login', 'POST', { email: 'user@example.test', password: 'fixture' });
  assert.equal(result.authenticated, true); assert.equal(result.account.username, 'minimal'); assert.equal(result.account.balance, 12.5);
  const saved = runtime.db.state('phuketSession')!; assert.equal(saved.token, access); assert.equal(saved.refreshToken, refresh);
  assert.ok(saved.expiresAt! >= before + 120_000 && saved.expiresAt! <= Date.now() + 120_000);
  meStatus = 200; const account = await api('phuket/account'); assert.equal(account.balance, 21.5);
  assert.deepEqual(runtime.db.state('phuketSession'), { ...saved, account });
  for (const value of [result, account, await api('phuket/status'), await api('overview')]) assertNoSessionSecrets(value, access, refresh);
  assert.ok(observed.includes('/api/v1/model-plaza') && observed.includes('/api/v1/auth/login') && observed.includes('/api/v1/auth/me'));
  await api('phuket/logout', 'POST', undefined, 204); meStatus = 401;
  await api('phuket/login', 'POST', { email: 'user@example.test', password: 'fixture' }, 401);
  assert.equal(runtime.db.state('phuketSession'), null, 'user data must not override a rejected login');
});

test('near-expiry refresh is shared by polling requests before any stale credential is sent', { timeout: 6000 }, async () => {
  const old = seedRefreshSession(30_000), fresh = 'proactive-access', rotated = 'rt_rotated_refresh_fixture';
  const entered = gate(), release = gate(), calls: string[] = []; let refreshes = 0;
  upstream = async (url, init) => {
    const h = new Headers(init.headers); assert.equal(h.get('user-agent'), phuketDesktopUA);
    if (url.pathname.endsWith('auth/refresh')) {
      refreshes++; assert.equal(init.method, 'POST'); assert.equal(h.get('authorization'), null);
      assert.deepEqual(JSON.parse(String(init.body)), { refresh_token: old.refreshToken }); entered.open(); await release.wait;
      return json({ access_token: fresh, refresh_token: rotated, user: { id: 38, username: 'after-refresh', quota: 8 } });
    }
    calls.push(url.pathname); assert.equal(h.get('authorization'), `Bearer ${fresh}`);
    if (url.pathname.endsWith('/keys')) return json({ data: { items: [], total: 0 } });
    if (url.pathname.endsWith('auth/me')) return json({ data: { id: 38, email: 'enriched@example.test', balance: 9 } });
    if (url.pathname.includes('/usage')) return json({ data: [] });
    throw Error('Unexpected poll');
  };
  const before = Date.now();
  const polls = Promise.all([runtime.phuket.listKeys(old.token, 1, 10), runtime.phuket.getUsage(old.token, null)]);
  try { await entered.wait; assert.equal(refreshes, 1); assert.deepEqual(calls, []); } finally { release.open(); }
  assertNoSessionSecrets(await polls, old.token, old.refreshToken, fresh, rotated);
  const saved = runtime.db.state('phuketSession')!;
  assert.equal(saved.account.username, 'after-refresh'); assert.equal(saved.account.balance, 8);
  assert.equal(saved.token, fresh); assert.equal(saved.refreshToken, rotated); assert.ok(saved.expiresAt! >= before + 3_600_000 && saved.expiresAt! <= Date.now() + 3_600_000);
  const account = await api('phuket/account'); assert.equal(account.email, 'enriched@example.test'); assert.equal(refreshes, 1);
  const reopened = new SwitchDb(); try { assert.deepEqual(reopened.state('phuketSession'), { ...saved, account }); } finally { reopened.close(); }
});

test('concurrent 401s retry the same reads and writes exactly once, including a late 401 after rotation', { timeout: 6000 }, async () => {
  const old = seedRefreshSession(), fresh = 'reactive-access', allOld = gate(), late = gate();
  const attempts: { bearer: string | null; path: string; method?: string; body: unknown }[] = [];
  let refreshes = 0;
  upstream = async (url, init) => {
    const bearer = new Headers(init.headers).get('authorization');
    if (url.pathname.endsWith('/auth/refresh')) {
      refreshes++; assert.deepEqual(JSON.parse(String(init.body)), { refresh_token: old.refreshToken });
      return json({ data: { token: fresh, expires_in: 7200 } }); // No rotated refresh token or user.
    }
    attempts.push({ bearer, path: url.pathname + url.search, method: init.method, body: init.body });
    if (bearer === `Bearer ${old.token}`) {
      if (attempts.length === 3) allOld.open();
      await allOld.wait; if (url.pathname.endsWith('/keys')) await late.wait;
      return json({ message: 'access expired' }, 401);
    }
    assert.equal(bearer, `Bearer ${fresh}`); assert.deepEqual(runtime.db.state('phuketSession')?.account, old.account);
    if (url.pathname.endsWith('/auth/me')) return json({ data: old.account });
    if (url.pathname.endsWith('/keys/8')) return json({ data: { id: 8, name: 'edited', status: 'active' } });
    return json({ data: { items: [], total: 0 } });
  };
  const before = Date.now(), page = api('phuket/keys?page=2&pageSize=3');
  try { await Promise.all([api('phuket/account'), api('phuket/keys/8', 'PUT', { name: 'edited' })]); } finally { late.open(); }
  await page; assert.equal(refreshes, 1); assert.equal(attempts.length, 6);
  for (const { bearer, ...original } of attempts.filter(a => a.bearer === `Bearer ${old.token}`)) assert.deepEqual(attempts.find(a => a.bearer === `Bearer ${fresh}` && a.path === original.path), { bearer: `Bearer ${fresh}`, ...original });
  const saved = runtime.db.state('phuketSession')!; assert.equal(saved.refreshToken, old.refreshToken); assert.equal(saved.token, fresh);
  assert.ok(saved.expiresAt! >= before + 7_200_000 && saved.expiresAt! <= Date.now() + 7_200_000);
});

test('only a rejected refresh clears a refreshable session; errors and diffs do not expose refresh tokens', async () => {
  const old = seedRefreshSession(), otherSecret = 'rt_not_saved_but_still_secret';
  const opaque = { ...old, refreshToken: 'opaque-refresh-secret' }; runtime.phuket.replaceSession(opaque);
  let status = 503, n = 0; upstream = (url) => {
    if (url.pathname.endsWith('/auth/refresh')) { n++; return json({ message: `${old.token} ${opaque.refreshToken} ${otherSecret}` }, status); }
    return json({ message: 'access expired' }, 401);
  };
  const transient = await api('phuket/account', 'GET', undefined, 502); assert.deepEqual(runtime.db.state('phuketSession'), opaque);
  status = 401; const revoked = await api('phuket/account', 'GET', undefined, 401); assert.equal(runtime.db.state('phuketSession'), null); assert.equal(n, 2);
  for (const result of [transient, revoked, await api('phuket/status')]) assertNoSessionSecrets(result, old.token, opaque.refreshToken, otherSecret);
  assert.equal(redactRecognizable(`before ${otherSecret} after`), 'before [REDACTED] after');
  seedRefreshSession(); let retryCount = 0; upstream = url => { retryCount++; return url.pathname.endsWith('/auth/refresh') ? json({ data: { accessToken: 'fresh-but-no-access', expiresIn: 0 } }) : json({}, 401); };
  const before = Date.now(); await api('phuket/account', 'GET', undefined, 401); const saved = runtime.db.state('phuketSession')!;
  assert.equal(retryCount, 3); assert.equal(saved.refreshToken, old.refreshToken); assert.ok(saved.expiresAt! >= before + 60_000 && saved.expiresAt! <= Date.now() + 60_000);
});

test('token login accepts an optional private refresh credential only in token mode; legacy sessions remain usable', async () => {
  const token = 'browser-access-fixture', refreshToken = 'rt_browser_refresh_fixture'; let calls = 0;
  upstream = (url, init) => {
    calls++; assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    assert.ok(!JSON.stringify(init).includes(refreshToken));
    return url.pathname.endsWith('/auth/me') ? json({ data: { ...sessionAccount(), accessToken: token, refreshToken } }) : json({ data: { required: false } });
  };
  for (const invalid of [{ email: 'user@example.test', password: 'fixture', refreshToken }, { tempToken: 'temporary', totpCode: '123456', refreshToken }, { refreshToken }, { token, refreshToken: 'sk-key' }, { token, refreshToken: 'bad\nvalue' }]) await api('phuket/login', 'POST', invalid, 400);
  assert.equal(calls, 0);
  const result = await api('phuket/login', 'POST', { token, refreshToken }); assert.equal(result.authenticated, true);
  assert.equal(runtime.db.state('phuketSession')?.refreshToken, refreshToken);
  for (const response of [result, await api('phuket/status'), await api('phuket/account'), await api('overview')]) assertNoSessionSecrets(response, token, refreshToken);
  runtime.db.setState('phuketSession', { token, account: sessionAccount() });
  assert.equal((await api('phuket/account')).id, 38);
  upstream = url => { assert.ok(!url.pathname.includes('refresh')); return json({}, 401); };
  await api('phuket/keys', 'GET', undefined, 401); assert.equal(runtime.db.state('phuketSession'), null);
});

test('late refresh completion cannot resurrect a logged-out session or clear a replacement login', { timeout: 6000 }, async () => {
  for (const replace of [false, true]) {
    const old = seedRefreshSession(0), entered = gate(), release = gate();
    const replacement = { ...old, token: 'other-account-access', refreshToken: 'rt_other_live_account_token' };
    upstream = async url => { assert.ok(url.pathname.endsWith('/auth/refresh')); entered.open(); await release.wait;
      return replace ? json({}, 401) : json({ data: { access_token: 'abandoned-refresh-result' } }); };
    const pending = api('phuket/account', 'GET', undefined, replace ? 401 : 409);
    try { await entered.wait; await api('phuket/logout', 'POST', undefined, 204); if (replace) runtime.phuket.replaceSession(replacement); }
    finally { release.open(); }
    await pending; assert.deepEqual(runtime.db.state('phuketSession'), replace ? replacement : null);
  }
});

test('cookie-based sessions are validated, never returned, and cleared on an expired account response', async () => {
  let expired = false;
  upstream = (u, init) => {
    if (u.pathname.endsWith('auth/login')) return new Response(null, { status: 204, headers: { 'Set-Cookie': 'session=private-cookie-value; HttpOnly; Secure' } });
    const h = new Headers(init.headers); assert.equal(h.get('cookie'), 'session=private-cookie-value'); assert.equal(h.get('authorization'), null);
    return expired ? json({ message: 'private-cookie-value' }, 401) : json({ data: { id: 1, email: 'cookie@example.test' } });
  };
  const status = await api('phuket/login','POST',{ email: 'cookie@example.test', password: 'fixture' }); assert.equal(status.authenticated, true); assert.ok(!JSON.stringify(status).includes('private-cookie-value'));
  expired = true; const err = await api('phuket/account','GET',undefined,401); assert.ok(!JSON.stringify(err).includes('private-cookie-value')); assert.equal((await api('phuket/status')).authenticated, false);
});

test('SSE metrics handle arbitrary UTF-8 and CRLF chunk boundaries without retaining a stream', () => {
  const m = new StreamMetrics(performance.now(), 20);
  const sample = 'event: response.output_text.delta\r\ndata: {"delta":"\\u4F60"}\r\n\ndata: {"type":"response.completed","response":{"usage":{"total_tokens":3}}}\r\n\r\n';
  for (const byte of Buffer.from(sample.replace('\\u4F60', String.fromCodePoint(0x4f60)))) m.push(Uint8Array.of(byte)); m.finish();
  assert.equal(m.text, String.fromCodePoint(0x4f60)); assert.equal(m.totalTokens, 3); assert.notEqual(m.firstTokenMs, null);
});

test('a disconnect after SSE headers aborts upstream and does not replay, even on a queued provider', async () => {
  let count = 0, notify!: () => void; const aborted = new Promise<void>(r => { notify = r; });
  const baseUrl = await mock((_req, res) => { count++; res.on('close', notify); res.writeHead(200, { 'content-type': 'text/event-stream' }).write('data: {"type":"response.created"}\n\n'); });
  const p = await create('codex',{ baseUrl }); await activate(p.id); await create('gpt-native',{ baseUrl, inFailoverQueue: true }); await proxyPort();
  const proxy = await api('proxy/start','POST'), ac = new AbortController();
  const res = await fetch(proxy.baseUrl + '/v1/responses',{ method: 'POST', signal: ac.signal, headers: { 'content-type':'application/json' }, body: JSON.stringify({ model: 'gpt-6-astra', stream: true, input: 'sensitive' }) });
  const reader = res.body!.getReader(); await reader.read(); ac.abort();
  await Promise.race([aborted, new Promise<never>((_, reject) => setTimeout(() => reject(Error('Upstream was not aborted.')), 3000).unref())]);
  await api('proxy/stop','POST'); assert.equal(count, 1); const logs = await api('proxy/logs'); assert.equal(logs.items[0].statusCode, 499); assert.equal(logs.items[0].failoverCount, 0);
});

type MockPaymentCall = { route: string; method?: string; body?: unknown; data: unknown; code?: number };
// All upstream traffic is redirected to this loopback server, including login.
async function paymentFixture(expected: MockPaymentCall[]) {
  const calls: { route: string; method: string; body: unknown; bearer?: string; ui?: string | string[] }[] = [];
  const base = await mock(async (req, res) => {
    const route = req.url!.replace('/api/v1/', '');
    if (route === 'auth/login') return sendJson(res, { data: { access_token: 'test-session' } });
    if (route === 'auth/me') return sendJson(res, { data: { id: 9, email: 'user@example.test' } });
    if (route === 'user/agreement') return sendJson(res, { data: { required: false } });
    const reply = expected[calls.length];
    calls.push({ route, method: req.method!, body: await bodyOf(req), bearer: req.headers.authorization, ui: req.headers['x-user-ui-request'] });
    if (!reply) return sendJson(res, {}, 404);
    sendJson(res, { code: reply.code ?? 0, message: 'fixture', data: reply.data });
  });
  upstream = (url, init) => fetch(base + url.pathname + url.search, init);
  await api('phuket/login', 'POST', { email: 'user@example.test', password: 'fixture' });
  return () => assert.deepEqual(calls, expected.map(e => ({ route: e.route, method: e.method ?? 'GET', body: e.body ?? {}, bearer: 'Bearer test-session', ui: '1' })));
}
const tz = 'timezone=Asia%2FShanghai';
const fixtureOrder = { out_trade_no: 'order-test-42', amount: 20, pay_amount: 20.2, payment_type: 'alipay', currency: 'CNY', status: 'PENDING', qr_code: 'fixture:42', pay_url: 'https://pay.example.test/42' };

test('checkout and order creation forward verified parameters and preserve the local QR payload', async () => {
  const data = { recharge_fee_rate: 1, methods: { alipay: { payment_type: 'alipay', single_min: 10 } } };
  const req = { amount: 20, payment_type: 'alipay', order_type: 'balance' };
  const check = await paymentFixture([
    { route: 'payment/checkout-info?' + tz, data },
    { route: 'payment/orders', method: 'POST', body: { ...req, is_mobile: false, payment_source: 'hosted_redirect', return_url: 'https://ai.pukitcore.com/payment/result' }, data: { ...fixtureOrder, order_id: 42 } },
  ]);
  assert.deepEqual(await api('phuket/payment/checkout-info'), data);
  const result = await api('phuket/payment/orders', 'POST', req, 201);
  assert.equal(result.order_id, 42); assert.equal(result.pay_url, fixtureOrder.pay_url); assert.equal(result.qr_code, fixtureOrder.qr_code);
  check();
});

test('order list, detail, verify and cancel use account endpoints and remove unsafe payment URLs', async () => {
  const record = { ...fixtureOrder, id: 42 }, page = { total: 1, page: 1, page_size: 20, pages: 1 };
  const check = await paymentFixture([
    { route: 'payment/orders/my?page=1&page_size=20&status=PENDING&' + tz, data: { ...page, items: [{ ...record, pay_url: 'javascript:invalid' }] } },
    { route: 'payment/orders/42?' + tz, data: { ...record, pay_url: 'https://user:pass@pay.example.test/' } },
    { route: 'payment/orders/verify', method: 'POST', body: { out_trade_no: record.out_trade_no }, data: { ...record, status: 'PAID', pay_url: 'http://pay.example.test/' } },
    { route: 'payment/orders/43/cancel', method: 'POST', data: null },
  ]);
  const list = await api('phuket/payment/orders?status=PENDING'); assert.equal(list.total, 1); assert.equal(list.items[0].pay_url, null);
  assert.equal((await api('phuket/payment/orders/42')).pay_url, null);
  const verified = await api('phuket/payment/orders/verify', 'POST', { out_trade_no: record.out_trade_no });
  assert.equal(verified.status, 'PAID'); assert.equal(verified.pay_url, null);
  assert.deepEqual(await api('phuket/payment/orders/43/cancel', 'POST'), { ok: true });
  check();
});

test('redeem is case-sensitive, rejects upstream business errors and masks long and short history codes', async () => {
  const code = 'aBcD-private-1224';
  const check = await paymentFixture([
    { route: 'redeem', method: 'POST', body: { code }, data: { code, type: 'balance', value: 50 } },
    { route: 'redeem/history?page=2&page_size=5&' + tz, data: { items: [{ id: 1, code }, { id: 2, code: 'PIN' }] } },
    { route: 'redeem', method: 'POST', body: { code }, code: 23, data: null },
  ]);
  assert.deepEqual(await api('phuket/redeem', 'POST', { code }), { ok: true, type: 'balance', value: 50 });
  const history = await api('phuket/redeem/history?page=2&page_size=5'); assert.equal(history.items.length, 2);
  assert.ok(history.items.every((i: { code: string }) => i.code.startsWith('••••')));
  for (const raw of [code, 'PIN']) assert.ok(!JSON.stringify(history).includes(raw));
  await api('phuket/redeem', 'POST', { code }, 502); check();
});

test('payment routes reject anonymous access and invalid inputs without calling upstream', async () => {
  const req = { amount: 10, payment_type: 'alipay', order_type: 'balance' };
  await api('phuket/payment/checkout-info', 'GET', undefined, 401);
  await api('phuket/payment/orders', 'POST', req, 401);
  await api('phuket/redeem', 'POST', { code: 'test' }, 401);
  const check = await paymentFixture([]);
  for (const patch of [{ amount: 0 }, { amount: -1 }, { payment_type: ' ' }, { return_url: 'https://example.test' }]) await api('phuket/payment/orders', 'POST', { ...req, ...patch }, 400);
  await api('phuket/payment/orders/verify', 'POST', { out_trade_no: '' }, 400);
  await api('phuket/payment/orders/bad', 'GET', undefined, 400);
  await api('phuket/payment/orders/0/cancel', 'POST', undefined, 400);
  await api('phuket/payment/orders?status=bad', 'GET', undefined, 400);
  await api('phuket/redeem', 'POST', { code: ' ' }, 400);
  await api('phuket/redeem/history?page_size=101', 'GET', undefined, 400);
  check();
});

const checkReq = { keyId: 17, model: 'gpt-6.2-astra' };
const diagnosticRoute = 'diagnostics/connection', modelRoute = 'diagnostics/workbench-models?keyId=17';
const sessionToken = 'diagnostic-session-secret';
const chatSse = () => new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\r\n\r\ndata: [DONE]\r\n\r\n', { headers: { 'content-type': 'text/event-stream' } });
const responseSse = () => new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
async function diagnosticFixture(reply: typeof upstream, group = { id: 65, name: '测试 GPT', platform: 'openai', claude_code_only: false }, status = 'active', options: { liveAccount?: () => Response; quota?: number; used?: number } = {}) {
  let login = true;
  const calls: { url: URL; init: RequestInit }[] = [];
  upstream = (url, init) => {
    const p = url.pathname;
    if (p.endsWith('/auth/login')) return json({ data: { token: sessionToken } });
    if (p.endsWith('/auth/me')) {
      if (!login && options.liveAccount) return options.liveAccount();
      return json({ data: { id: 1, email: 'test@example.test', balance: 1000 } });
    }
    if (p.endsWith('/user/agreement')) return json({ data: { required: false } });
    if (p.endsWith('/keys')) return json({ data: [{ id: 17, group_id: group.id, name: `诊断 ${rawKey}`, key: rawKey, status, quota: options.quota ?? 0, quota_used: options.used ?? 0 }] });
    if (p.endsWith('/groups/available')) return json([group]);
    if (p.endsWith('/model-plaza') || p.endsWith('/groups/rates')) return json([]);
    calls.push({ url, init }); return reply(url, init);
  };
  await api('phuket/login', 'POST', { email: 'test@example.test', password: 'fixture' });
  login = false;
  return calls;
}
function noCredentials(result: unknown) {
  const text = JSON.stringify(result); assert.doesNotMatch(text, /sk-|eyJfixture|opaque-credential/); assert.ok(!text.includes(sessionToken));
}
test('diagnostic model discovery requires a session, sends account credentials and returns only chat model options', async () => {
  await api(modelRoute, 'GET', undefined, 401); await api(diagnosticRoute, 'POST', checkReq, 401);
  const calls = await diagnosticFixture(() => json({ data: { models: [checkReq.model, { id: 'deepseek-chat', label: '深度求索' }, 'Claude-opus', 'gemini-3', 'gpt-image-2', 'sora-2', 'grok-imagine-video'] } }));
  assert.deepEqual(await api(modelRoute), [{ id: checkReq.model, label: checkReq.model }, { id: 'deepseek-chat', label: '深度求索' }]);
  assert.equal(calls.length, 1); const [{ url, init }] = calls;
  assert.equal(url.href, 'https://ai.pukitcore.com/api/v1/workbench/models?kind=chat&key_id=17&timezone=Asia%2FShanghai'); assert.equal(init.method, 'GET');
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${sessionToken}`); assert.equal(new Headers(init.headers).get('x-user-ui-request'), '1');
});
test('diagnostics reject incompatible groups, inactive keys and excluded model slugs before any inference', async () => {
  for (const [platform, flag, status] of [['anthropic', false, 'active'], ['openai', true, 'active'], ['gemini', false, 'active'], ['openai', false, 'inactive']] as const) {
    const calls = await diagnosticFixture(chatSse, { id: 9, name: '测试', platform, claude_code_only: flag }, status);
    assert.equal((await api(diagnosticRoute, 'POST', checkReq, 422)).error.message, '工作台聊天室在线检测仅支持 OpenAI 接口的模型');
    await api(modelRoute, 'GET', undefined, 422); assert.equal(calls.length, 0);
  }
  const calls = await diagnosticFixture(chatSse);
  for (const model of ['claude-sonnet', 'gemini-2', 'gpt-image-1', 'sora-2']) await api(diagnosticRoute, 'POST', { ...checkReq, model }, 422);
  assert.equal(calls.length, 0);
});
test('online 503 skips local inference, preserves upstream details and redacts the report', async () => {
  const calls = await diagnosticFixture(() => json({ error: { type: 'capacity', code: 'busy', message: `无容量 ${rawKey} ${sessionToken}` } }, 503));
  const r = await api(diagnosticRoute, 'POST', checkReq);
  assert.equal(r.overallStatus, 'online_failed'); assert.equal(r.contactAdmin, true); assert.equal(r.local.status, 'skipped'); assert.equal(r.local.latencyMs, null);
  assert.equal(r.online.error.code, 'HTTP_503'); assert.match(r.diagnosticReport, /HTTP_503/); assert.match(r.diagnosticReport, /无容量/); noCredentials(r);
  assert.deepEqual(calls.map(c => c.url.pathname), ['/api/v1/workbench/chat/completions']);
});
test('online SSE then direct HTTP 502 reports exact codes with no credentials', async () => {
  const calls = await diagnosticFixture(url => url.pathname.includes('workbench') ? chatSse() : json({ error: { type: 'upstream_error', code: 'bad_gateway', message: `详情 ${rawKey} Bearer opaque-credential eyJfixture.payload.signature` } }, 502));
  const r = await api(diagnosticRoute, 'POST', checkReq);
  assert.equal(r.overallStatus, 'local_failed'); assert.equal(r.contactAdmin, false); assert.equal(r.guidance.action, 'check_network'); assert.equal(r.online.previewText, 'OK');
  assert.deepEqual(calls.map(c => c.url.pathname), ['/api/v1/workbench/chat/completions','/v1/responses']);
  assert.equal(r.local.error.code, 'HTTP_502'); assert.equal(r.local.error.httpStatus, 502); assert.equal(r.local.error.upstreamType, 'upstream_error'); assert.equal(r.local.error.upstreamCode, 'bad_gateway');
  assert.match(r.diagnosticReport, /HTTP_502/); assert.match(r.diagnosticReport, /bad_gateway/); noCredentials(r);
});
test('direct saved provider connection refusal reports underlying ECONNREFUSED', async () => {
  const socket = await listen(http.createServer()), baseUrl = address(socket) + '/v1'; await close(socket);
  const provider = await create('codex', { baseUrl });
  await diagnosticFixture((url, init) => url.pathname.includes('workbench') ? chatSse() : fetch(url, init));
  const r = await api(diagnosticRoute, 'POST', { ...checkReq, providerId: provider.id });
  assert.equal(r.overallStatus, 'local_failed'); assert.equal(r.local.error.code, 'ECONNREFUSED'); assert.equal(r.local.error.networkCode, 'ECONNREFUSED'); assert.equal(r.local.error.httpStatus, null);
  assert.match(r.diagnosticReport, /ECONNREFUSED/); assert.equal(r.local.endpoint, baseUrl + '/responses'); noCredentials(r);
});
for (const scenario of [
  { stage: 'local', status: 403, balance: 0, action: 'recharge', admin: false },
  { stage: 'local', status: 403, balance: 88.5, action: 'create_key_and_retest', admin: true },
  { stage: 'online', status: 403, balance: 88.5, quota: 10, used: 10, action: 'recharge', admin: false },
  { stage: 'online', status: 403, balance: 88.5, quota: 10, used: 9.5, action: 'create_key_and_retest', admin: true },
  { stage: 'local', status: 403, balance: null, action: 'contact_admin', admin: true },
  { stage: 'local', status: 429, action: 'new_chat_codex_deeplink', admin: false },
  { stage: 'online', status: 429, action: 'new_chat_codex_deeplink', admin: true },
  { stage: 'local', status: 503, action: 'check_network', admin: false },
  { stage: 'local', status: 500, action: 'check_network', admin: true },
]) {
  const { stage, status, balance, quota, used, action, admin } = scenario;
  test(`${stage} HTTP ${status}: ${action} (balance ${balance ?? 'unknown'})`, async () => {
    let balanceReads = 0;
    const calls = await diagnosticFixture(url => stage === 'local' && url.pathname.includes('workbench') ? chatSse() : json({ message: '通道错误' }, status), undefined, 'active', {
      quota, used, liveAccount: () => { balanceReads++; return json({ data: { id: 1, email: 'test@example.test', balance } }); },
    });
    const r = await api(diagnosticRoute, 'POST', checkReq);
    assert.equal(r.overallStatus, `${stage}_failed`); assert.equal(r[stage].error.code, `HTTP_${status}`);
    assert.equal(r.groupId, 65); assert.equal(r.guidance.action, action); assert.equal(r.contactAdmin, admin);
    assert.equal(balanceReads, status === 403 ? 1 : 0); assert.equal(calls.length, stage === 'online' ? 1 : 2);
    assert.ok(r.diagnosticReport.includes(r.guidance.title)); noCredentials(r);
    if (status === 403) {
      const b = r.guidance.balanceCheck; assert.equal(b.accountBalance, balance); assert.equal(b.checked, balance !== null);
      assert.equal(b.keyQuota, quota ?? 0); assert.equal(b.keyQuotaUsed, used ?? 0);
      assert.equal(b.sufficient, action === 'create_key_and_retest'); assert.ok(r.diagnosticReport.includes(b.summary));
      assert.equal(r.guidance.recreateGroupId, b.sufficient ? r.groupId : undefined);
    } else assert.equal(r.guidance.balanceCheck, undefined);
    if (status === 429) assert.match(r.guidance.steps.join(' '), /Codex.*深度链接.*新对话/);
    if (status === 503) assert.match(r.guidance.steps.join(' '), /本机网络/);
  });
}

test('two SSE successes use separate credentials, correct request bodies and record both timings', async () => {
  const calls = await diagnosticFixture(url => url.pathname.includes('workbench') ? chatSse() : responseSse());
  const r = await api(diagnosticRoute, 'POST', checkReq);
  assert.equal(r.overallStatus, 'passed'); assert.equal(r.contactAdmin, false); noCredentials(r);
  for (const step of [r.online, r.local]) { assert.equal(step.status, 'passed'); assert.equal(step.previewText, 'OK'); assert.equal(typeof step.firstTokenMs, 'number'); assert.ok(step.latencyMs >= step.firstTokenMs); }
  assert.deepEqual(calls.map(c => c.url.href), ['https://ai.pukitcore.com/api/v1/workbench/chat/completions', 'https://ai.pukitcore.com/v1/responses']);
  const [chat, direct] = calls.map(c => c.init), h = new Headers(chat.headers), d = new Headers(direct.headers);
  assert.equal(h.get('x-api-key-id'), '17'); assert.equal(h.get('x-user-ui-request'), '1'); assert.equal(h.get('authorization'), `Bearer ${sessionToken}`);
  assert.equal(d.get('authorization'), `Bearer ${rawKey}`); assert.equal(d.get('cookie'), null); assert.equal(d.get('x-api-key-id'), null);
  assert.deepEqual(JSON.parse(String(chat.body)), { model: checkReq.model, messages: [{ role: 'user', content: '请仅回复 OK' }], stream: true, max_tokens: 32 });
  assert.deepEqual(JSON.parse(String(direct.body)), { model: checkReq.model, input: '请仅回复 OK', stream: true, store: false, max_output_tokens: 32 });
});
test('proxy diagnostics handle stopped and running states, JSON fallback and proxy-only credentials', async () => {
  const calls = await diagnosticFixture(url => url.pathname.includes('workbench') ? json({ choices: [{ message: { content: 'OK' } }] }) : json({ output: [{ content: [{ text: 'OK' }] }] }));
  const req = { ...checkReq, localTarget: 'proxy' };
  const stopped = await api(diagnosticRoute, 'POST', req); assert.equal(stopped.local.error.code, 'PROXY_NOT_RUNNING'); assert.equal(calls.length, 1);
  const port = await proxyPort(); await api('proxy/start', 'POST');
  const running = await api(diagnosticRoute, 'POST', req); assert.equal(running.overallStatus, 'passed'); assert.equal(running.local.target, 'proxy');
  assert.equal(calls.at(-1)?.url.href, `http://127.0.0.1:${port}/v1/responses`); assert.equal(new Headers(calls.at(-1)?.init.headers).get('authorization'), 'Bearer local-diagnostics'); noCredentials(running);
});

test('current provider and Fast configuration persist across connections, and proxy logs retain the latest 1000', async () => {
  const p = await create('codex'); await activate(p.id); const second = new SwitchDb();
  try {
    assert.equal(second.current('codex')?.id, p.id); assert.deepEqual(second.state('fastMode'), DEFAULT_GPT_FAST_CONFIG);
    for (let n = 0; n < 1004; n++) second.addLog({ id: `log${n}`, createdAt: new Date(n).toISOString(), appType: 'codex', protocol: 'openai-responses', providerId: p.id, model: 'gpt-test', effectiveModel: 'gpt-test', statusCode: 200, latencyMs: 2, failoverCount: 0 });
    const page = await api('proxy/logs?limit=1000'); assert.equal(page.total, 1000); assert.equal(page.items[0].id, 'log1003'); assert.equal(page.items.at(-1).id, 'log4');
  } finally { second.close(); }
});

