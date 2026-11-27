import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { subagentHarnessIds as ids, type SubagentStatus, type SubagentUsageResponse } from '../shared/types.js';
import { createManagementApp, createRuntime } from './app.js';
import { subagentPaths } from './configFiles.js';
import { isRecord } from './common.js';
import { account } from './phuketViews.js';
import { IMAGE_PROMPT_END, IMAGE_PROMPT_START } from './imagePrompt.js';
import { readAstraUserEnvKey, writeAstraUserEnvKey } from './subagentEnvironment.js';
import { bundledScript } from './subagentPython.js';
import { SUBAGENT_END, SUBAGENT_START, subagentBlock } from './subagentRules.js';
import { parseToml } from './surgicalToml.js';

const name = 'gpt-astra-subagent', secret = 'opaque-unit-test-credential', previous = 'other-unrecognizable-secret';
const envs = ['PHUKET_SWITCH_USER_HOME','PHUKET_SWITCH_HOME','APPDATA','LOCALAPPDATA','ASTRA_API_KEY','PLUGIN_DATA'];
let env: Record<string, string | undefined>, root: string, home: string, origin: string, runtime: ReturnType<typeof createRuntime>, server: http.Server;
let upstream: typeof fetch;
const read = (file: string) => fs.readFileSync(file, 'utf8'), doc = (file: string) => JSON.parse(read(file));
const write = (file: string, value: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function noSecrets(value: unknown, ...keys: string[]) { for (const key of keys) assert.ok(!JSON.stringify(value).includes(key), 'secret in public response'); }
beforeEach(async () => {
  env = Object.fromEntries(envs.map(k => [k, process.env[k]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'phuket-harness-')); home = path.join(root, 'home'); fs.mkdirSync(home);
  process.env.PHUKET_SWITCH_USER_HOME = home; process.env.PHUKET_SWITCH_HOME = path.join(root, 'db');
  process.env.APPDATA = path.join(root, 'forbidden-roaming'); process.env.LOCALAPPDATA = path.join(root, 'forbidden-local'); delete process.env.ASTRA_API_KEY; delete process.env.PLUGIN_DATA;
  upstream = async () => { throw new Error('Unexpected upstream request'); };
  runtime = createRuntime({ fetch: (url, init) => upstream(url, init) });
  server = http.createServer(createManagementApp(root, runtime));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
});
afterEach(async () => {
  try {
    const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; await runtime.close();
    for (const dir of [process.env.APPDATA!, process.env.LOCALAPPDATA!]) assert.equal(fs.existsSync(dir), false);
  } finally {
    for (const k of envs) { if (env[k] !== undefined) process.env[k] = env[k]; else delete process.env[k]; }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
async function api(route: string, body?: unknown, status = 200) {
  const res = await fetch(origin + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json() as any; assert.equal(res.status, status, `${route}: ${data.error?.message ?? ''}`); return data;
}
const req = { apiKey: secret, targets: [...ids], model: 'local-model:8b', protocol: 'openai-chat', baseUrl: 'https://offline.invalid/relay/v1', reasoningEffort: 'none', defaultMode: 'readonly', allowModelOverride: false, enableChunkCompaction: true, compactTriggerPct: 75, compactKeepRecentGroups: 4, maxContextTokens: 64000, keyStorage: 'mcp-env', writeRules: true };

function seedFiles() {
  const p = subagentPaths(); const before = new Map<string, string>();
  for (const file of [p.claudeMcp, p.desktopMcp, p.desktop3pMcp, p.clineVsMcp, p.cursorMcp, p.windsurfMcp, p.geminiMcp, p.opencodeMcp]) {
    const key = file === p.opencodeMcp ? 'mcp' : 'mcpServers';
    before.set(file, JSON.stringify({ keep: [1, 2], [key]: { other: { command: 'untouched', env: { API_KEY: previous } } } }, null, 4));
  }
  before.set(p.codexMcp, `# keep this comment\r\nmodel = "user-default"\r\n[mcp_servers.other]\r\ncommand = "untouched"\r\n[mcp_servers.other.env]\r\nAPI_KEY = "${previous}"\r\n`);
  for (const file of [p.claudeRules, p.codexRules, p.geminiRules, p.windsurfRules, p.opencodeRules]) before.set(file, '# User guidelines\r\nKeep this.\r\n');
  fs.mkdirSync(path.dirname(p.pluginManifest), { recursive: true });
  for (const [file, src] of before) write(file, src); return before;
}

test('usage is read-only, projects allowlisted metadata and aggregates cumulative sessions, not worker reports', async () => {
  const data = path.join(home, '.gemini', 'antigravity', 'plugin_data', name);
  const get = async (): Promise<SubagentUsageResponse> => api('subagent/usage');
  const empty = await get(); assert.equal(empty.totals.sessionCount, 0); assert.equal(empty.totals.cacheHitRatePct, 0); assert.deepEqual(empty.workers, []); assert.ok(!fs.existsSync(data));
  const config = { ...runtime.db.state('subagent'), maxContextTokens: 128000, apiKey: secret };
  runtime.db.setState('subagent', config);
  runtime.db.createProvider({ appType: 'codex', protocol: 'openai-responses', name: 'Saved', baseUrl: 'https://fixture.invalid', apiKey: previous });
  const session = { cwd: `/project/${secret}`, mode: 'edit', reasoning_effort: 'high', model: 'sample', protocol: 'openai-responses', turns: 4, last_input_tokens: 81,
    max_context_tokens: 1000000, compactions: 1, chunk_compactions: 2, updated_at: 1710000000, total_input_tokens: 90, total_cached_tokens: 45, total_output_tokens: 15, total_reasoning_tokens: 4,
    files_changed: ['private-file-name'], input_history: [{ content: 'private-history' }], commands_run: [{ command: 'private-command' }], prompt_cache_key: 'private-cache-key' };
  const snapshot = (dir: string, id: string, v: object) => write(path.join(data, dir, id + '.json'), JSON.stringify(v));
  snapshot('sessions', 'first', { ...session, session_id: 'first' });
  snapshot('sessions', 'legacy', { ...session, session_id: 'legacy', max_context_tokens: undefined, total_input_tokens: 10, total_cached_tokens: 0, total_output_tokens: 5, total_reasoning_tokens: 2, turns: 1, updated_at: 1710000001 });
  snapshot('sessions', 'third', { ...session, session_id: 'third', protocol: 'openai-chat', total_input_tokens: 100, total_cached_tokens: 20, total_output_tokens: 20, total_reasoning_tokens: 1, turns: 2, updated_at: 1710000002 });
  const turn = { input_tokens: 90, cached_tokens: 45, output_tokens: 15, reasoning_tokens: 4, cache_hit_rate_pct: 999 };
  const w = { worker_id: 'done', worker_name: `review-${previous}`, session_id: 'first', status: 'completed', model: 'sample', api_format: 'openai-responses', steps_used: 2,
    elapsed_s: 1.25, started_at: 1710000020, finished_at: 1710000021.25, error: 'private-error', result: { final_response: 'private-result', log_file: 'private-log-path', usage: turn } };
  snapshot('workers', 'done', w);
  snapshot('workers', 'live', { ...w, worker_id: 'live', started_at: 1710000022, finished_at: null, status: 'running', worker_name: 'sk-fixtureBearer', result: null, usage: { ...turn, input_tokens: 0 } });
  snapshot('session_backups', 'unrelated', { ...session, session_id: 'unrelated' });
  snapshot('sessions', 'copied', { ...session, session_id: 'first' }); // Backup with a .json suffix must not duplicate a session.
  write(path.join(data, 'sessions', 'broken.json'), '{private-error');
  write(path.join(data, 'sessions', 'large.json'), '{"session_id":"large"}'.padEnd(16 * 1024 * 1024 + 1));
  const file = path.join(data, 'sessions', 'first.json'), before = fs.statSync(file).mtimeMs;
  const report = await get();
  noSecrets(report, secret, previous, 'sk-fixtureBearer', 'private-file-name', 'private-history', 'private-command', 'private-cache-key', 'private-error', 'private-result', 'private-log-path');
  assert.deepEqual(report.totals, { sessionCount: 3, turns: 7, inputTokens: 200, cachedTokens: 65, outputTokens: 40, reasoningTokens: 7, totalTokens: 240, cacheHitRatePct: 32.5 });
  assert.deepEqual(report.sessions.map(s => s.sessionId), ['third', 'legacy', 'first']);
  const first = report.sessions[2]; assert.equal(first.cwd, '/project/[REDACTED]'); assert.equal(first.updatedAt, new Date(1710000000000).toISOString());
  assert.deepEqual([first.lastInputTokens, first.maxContextTokens, first.compactions, first.chunkCompactions, first.filesChangedCount], [81, 1000000, 1, 2, 1]);
  assert.equal(report.sessions[1].maxContextTokens, 128000); assert.equal(report.byModel.length, 2);
  const group = report.byModel.find(r => r.protocol === 'openai-responses'); assert.ok(group);
  assert.deepEqual([group.model, group.sessionCount, group.turns, group.inputTokens, group.cachedTokens, group.cacheHitRatePct], ['sample', 2, 5, 100, 45, 45]);
  assert.deepEqual(report.workers.map(r => r.workerId), ['live', 'done']); assert.equal(report.workers[0].usage?.cacheHitRatePct, 0); assert.equal(report.workers[0].finishedAt, null);
  assert.deepEqual(report.workers[1], { workerId: 'done', workerName: 'review-[REDACTED]', sessionId: 'first', status: 'completed', model: 'sample', protocol: 'openai-responses', stepsUsed: 2,
    elapsedSeconds: 1.25, startedAt: new Date(1710000020000).toISOString(), finishedAt: new Date(1710000021250).toISOString(),
    usage: { inputTokens: 90, cachedTokens: 45, outputTokens: 15, reasoningTokens: 4, totalTokens: 105, cacheHitRatePct: 50 } });
  assert.equal(fs.statSync(file).mtimeMs, before); assert.deepEqual(runtime.db.state('subagent'), config); assert.equal(runtime.db.backups().length, 0);
});

test('usage honors PLUGIN_DATA, rejects query paths and does not follow snapshot junctions', async () => {
  const data = path.join(root, 'isolated-plugin-data'), other = path.join(root, 'scratch-tree'); process.env.PLUGIN_DATA = data;
  const empty = await api('subagent/usage'); assert.deepEqual(empty.sessions, []); assert.ok(!fs.existsSync(data));
  await api('subagent/usage?path=other', undefined, 400);
  write(path.join(other, 'sessions', 'ignored.json'), JSON.stringify({ session_id: 'ignored', total_input_tokens: 42 }));
  fs.symlinkSync(other, data, process.platform === 'win32' ? 'junction' : 'dir'); assert.deepEqual((await api('subagent/usage')).sessions, []);
  fs.unlinkSync(data); fs.mkdirSync(data); fs.symlinkSync(path.join(other, 'sessions'), path.join(data, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  write(path.join(data, 'workers', 'new.json'), JSON.stringify({ worker_id: 'new', status: 'running' }));
  const report: SubagentUsageResponse = await api('subagent/usage'); assert.equal(report.totals.sessionCount, 0); assert.deepEqual(report.sessions, []);
  assert.equal(report.workers.length, 1); assert.equal(report.workers[0].workerId, 'new'); assert.equal(report.workers[0].usage, null);
});

test('all nine adapters detect isolated profiles; preview masks both sides and has no file or SQLite side effects', async () => {
  const f = subagentPaths(); for (const file of Object.values(f)) assert.ok(file.startsWith(home + path.sep));
  const initial: SubagentStatus = await api('subagent'); assert.equal(initial.harnesses.length, 9); assert.ok(initial.harnesses.every(h => !h.installed && !h.detected));
  assert.equal(initial.config.updatedAt, null); assert.equal(initial.config.model, 'gpt-6.2-astra'); assert.equal(initial.config.maxContextTokens, 272000);
  assert.equal(initial.config.baseUrl, 'https://ai.pukitcore.com/v1');
  assert.equal(initial.config.reasoningEffort, 'max');
  const before = seedFiles(), detected: SubagentStatus = await api('subagent');
  assert.deepEqual(detected.harnesses.filter(h => h.detected).map(h => h.id), [...ids]);
  const diff = await api('subagent/preview-diff', req); noSecrets(diff, secret, previous);
  const excluded = [f.clineMcp, f.runtimeDirectDns, f.runtimeDirectNet, f.pluginDirectDns, f.pluginDirectNet];
  assert.deepEqual(new Set(diff.files.map((v: any) => v.path)), new Set(Object.values(f).filter(file => !excluded.includes(file))));
  assert.equal(JSON.parse(diff.files.find((v: any) => v.path === f.claudeMcp).after).mcpServers[name].env.ASTRA_API_KEY, '[REDACTED]');
  assert.equal(JSON.parse(diff.files.find((v: any) => v.path === f.pluginManifest).after).mcpConfig, './mcp_config.json');
  for (const [file, src] of before) assert.equal(read(file), src);
  assert.equal(fs.existsSync(f.runtime), false); assert.equal(fs.existsSync(f.pluginManifest), false); assert.equal(runtime.db.backups().length, 0);
  assert.equal(runtime.db.state('subagent').apiKey, '');
});

test('install writes native shapes, private credentials, bounded Windsurf rules and both Desktop configs; restore is byte-exact', async () => {
  const before = seedFiles(), f = subagentPaths();
  const applied = await api('subagent/apply', { ...req, customInstructions: 'x'.repeat(2000) });
  const status: SubagentStatus = applied.status; noSecrets(applied, secret, previous);
  assert.equal(status.config.keySource, 'manual'); assert.equal('apiKey' in status.config, false); assert.equal(Object.values(status.config.targets).every(Boolean), true);
  assert.deepEqual([status.config.enableChunkCompaction, status.config.compactTriggerPct, status.config.compactKeepRecentGroups], [true, 75, 4]);
  assert.ok(status.python.meetsMinimum); assert.ok(status.harnesses.every(h => h.installed && h.installedModel === req.model && h.installedProtocol === req.protocol));
  for (const h of status.harnesses) {
    const id = h.id, cfg = id === 'codex' ? parseToml(read(h.mcpPath)) : doc(h.mcpPath), servers = cfg[id === 'codex' ? 'mcp_servers' : id === 'opencode' ? 'mcp' : 'mcpServers'];
    const v = servers[name], e = v.env ?? v.environment, script = id === 'antigravity' ? f.pluginServer : f.runtime;
    assert.equal(e.ASTRA_BASE_URL, req.baseUrl); assert.equal(e.ASTRA_API_KEY, secret); assert.equal(e.ASTRA_PROTOCOL, req.protocol); assert.equal(e.ASTRA_MODEL, req.model);
    assert.equal(e.ASTRA_DEFAULT_MODE, req.defaultMode); assert.equal(e.ASTRA_ALLOW_MODEL_OVERRIDE, '0'); assert.equal(e.ASTRA_REASONING_EFFORT, 'none'); assert.equal(e.ASTRA_MAX_CONTEXT_TOKENS, '64000');
    assert.deepEqual([e.ASTRA_ALLOW_MODEL_COMPACTION, e.ASTRA_COMPACT_TRIGGER_TOKENS, e.ASTRA_COMPACT_KEEP_RECENT_GROUPS], ['1', '48000', '4']);
    assert.equal(e.ASTRA_DEFAULT_REASONING_EFFORT, req.reasoningEffort); assert.equal(e.PLUGIN_DATA, undefined);
    assert.deepEqual([e.PYTHONUTF8, e.PYTHONIOENCODING, e.PYTHONUNBUFFERED], ['1','utf-8','1']);
    if (id === 'opencode') { assert.deepEqual(v.command, [status.python.executable, '-u', script]); assert.equal(v.type, 'local'); assert.equal(v.enabled, true); }
    else { assert.deepEqual(v.args, ['-u', script]); assert.equal(v.command, status.python.executable); }
    if (id !== 'antigravity') assert.equal(servers.other.command, 'untouched');
    if (id === 'claude-code') assert.equal(v.type, 'stdio');
    if (id === 'codex') { assert.equal(v.startup_timeout_sec, 30); assert.equal(v.tool_timeout_sec, 300); assert.match(read(f.codexMcp), /# keep this comment/); }
    if (id === 'gemini-cli') assert.equal(v.timeout, 300000);
    if (id === 'cline') { assert.equal(h.mcpPath, f.clineVsMcp); assert.equal(v.disabled, false); assert.deepEqual(v.autoApprove, []); }
    if (h.supportsRules) { assert.ok(h.rulesInstalled); assert.ok(read(h.rulesPath!).includes(SUBAGENT_START)); }
    else { assert.equal(h.rulesPath, null); assert.match(h.rulesSnippet, /astra_run_task/); }
    assert.ok(h.snippet.includes('[REDACTED]'));
  }
  assert.ok(subagentBlock(read(f.windsurfRules))!.length <= 1400); assert.equal(doc(f.desktop3pMcp).mcpServers[name].env.ASTRA_MODEL, req.model);
  assert.equal(fs.existsSync(f.clineMcp), false); assert.equal(read(f.pluginServer), read(bundledScript())); assert.equal(read(f.runtime), read(bundledScript()));
  const manifest = doc(f.pluginManifest);
  assert.equal(manifest.version, '1.6.0'); assert.equal(manifest.name, name); assert.equal(manifest.mcpConfig, './mcp_config.json');
  assert.deepEqual(manifest.rules, ['./rules/AGENTS.md']); assert.deepEqual(manifest.skills, ['./skills']); assert.ok(manifest.author && manifest.keywords.includes(req.protocol));
  assert.ok(manifest.displayName.includes(req.model) && manifest.description.includes(req.protocol));
  for (const text of [read(f.pluginRules), read(f.pluginSkill)]) {
    for (const setting of [req.model, req.protocol, req.baseUrl, '64,000', req.defaultMode, req.reasoningEffort, 'overrides are disabled', 'x'.repeat(2000)]) assert.ok(text.includes(setting));
    assert.ok(!text.includes('strictly locked')); assert.match(text, /mode="chunk"/); assert.match(text, /compact_context/); assert.match(text, /75%/); noSecrets(text, secret, previous);
    assert.match(text, /max_steps=0 is unlimited/); assert.match(text, /watch_command/); assert.match(text, /end your turn immediately/);
  }
  for (const h of status.harnesses) {
    for (const tool of ['run_task','spawn_worker','wait_worker','worker_status','compact_session','list_sessions']) assert.ok(h.rulesSnippet.includes(`astra_${tool}`));
    assert.ok(h.rulesSnippet.includes('disjoint')); assert.ok(h.rulesSnippet.includes('session_id'));
    assert.match(h.rulesSnippet, /max_steps=0 is unlimited/); assert.match(h.rulesSnippet, /watch_command/);
    assert.match(h.rulesSnippet, /end your turn immediately/); assert.doesNotMatch(h.rulesSnippet, /(?:30|60)[ -]step/i);
    assert.match(h.rulesSnippet, /astra_compact_session\(session_id=\.\.\., mode="chunk"/); assert.match(h.rulesSnippet, /compact_context/); assert.match(h.rulesSnippet, /75%/);
    if (h.id !== 'antigravity') assert.ok(h.rulesSnippet.replace(/\r?\n/g, '\r\n').length <= (h.id === 'windsurf' ? 1400 : 1800));
  }
  assert.match(read(f.pluginSkill), /gpt-astra-orchestrator/);
  assert.equal(runtime.db.state('subagent').apiKey, secret); noSecrets(await api('backups'), secret, previous);
  const backup = applied.system.backupId; await api(`backups/${backup}/restore`, {});
  for (const [file, src] of before) assert.equal(read(file), src);
  for (const file of [f.runtime, f.pluginManifest, f.pluginServer, f.pluginSkill, f.clineRules]) assert.equal(fs.existsSync(file), false);
  assert.equal(runtime.db.state('subagent').apiKey, ''); assert.equal((await api('subagent')).harnesses.some((h: any) => h.installed), false);
});

test('switch and remove selected harnesses without modifying other servers, presets or a still-used runtime', async () => {
  const before = seedFiles(), f = subagentPaths(); await api('subagent/apply', req);
  const third = read(f.claudeMcp);
  const switched = await api('subagent/apply', { targets: ['codex','opencode'], keepExistingKey: true, model: 'gemini-custom', protocol: 'gemini-native' });
  assert.equal(read(f.claudeMcp), third); assert.equal(switched.status.harnesses.find((h: any) => h.id === 'codex').installedModel, 'gemini-custom');
  assert.equal(switched.status.harnesses.find((h: any) => h.id === 'claude-code').installedModel, req.model); assert.equal(subagentBlock(read(f.codexRules))!.includes('gemini-custom'), true);
  const some = await api('subagent/remove', { targets: ['codex','cursor'], removeRules: false });
  assert.equal(some.status.harnesses.find((h: any) => h.id === 'codex').installed, false); assert.equal(read(f.codexRules).includes(SUBAGENT_END), true);
  assert.ok(fs.existsSync(f.runtime)); assert.equal(doc(f.cursorMcp).mcpServers.other.env.API_KEY, previous);
  const all = await api('subagent/remove', { targets: [...ids] }); assert.ok(all.status.harnesses.every((h: any) => !h.installed && !h.rulesInstalled));
  for (const file of [f.pluginMcp, f.pluginManifest, f.pluginRules, f.pluginSkill, f.pluginServer, f.clineRules, f.runtime]) assert.equal(fs.existsSync(file), false);
  for (const file of [f.claudeRules, f.codexRules, f.geminiRules, f.windsurfRules, f.opencodeRules]) assert.equal(read(file), before.get(file));
  assert.equal(doc(f.desktop3pMcp).mcpServers.other.command, 'untouched'); assert.equal(doc(f.opencodeMcp).mcp.other.command, 'untouched');
  await api(`backups/${all.system.backupId}/restore`, {}); assert.equal(read(f.claudeMcp), third); assert.equal(read(f.runtime), read(bundledScript()));
});

test('legacy subagent rows receive compaction defaults; partial applies keep policy and clamp the runtime trigger', async () => {
  const base = runtime.db.state('subagent');
  const { enableChunkCompaction, compactTriggerPct, compactKeepRecentGroups, ...legacy } = base;
  runtime.db.setState('subagent', { ...legacy, model: 'legacy-model' } as typeof base);
  const defaults = (await api('subagent')).config;
  assert.deepEqual([defaults.enableChunkCompaction, defaults.compactTriggerPct, defaults.compactKeepRecentGroups, defaults.model], [true, 88, 2, 'legacy-model']);
  await api('subagent/apply', { ...req, enableChunkCompaction: false, compactTriggerPct: 40, compactKeepRecentGroups: 0, maxContextTokens: 5712 });
  const status: SubagentStatus = (await api('subagent/apply', { targets: ['codex'], keepExistingKey: true })).status;
  const c = runtime.db.state('subagent');
  assert.deepEqual([c.enableChunkCompaction, c.compactTriggerPct, c.compactKeepRecentGroups], [false, 40, 0]);
  for (const h of status.harnesses) {
    const cfg = h.id === 'codex' ? parseToml(read(h.mcpPath)) : doc(h.mcpPath);
    const entry = (cfg.mcp_servers ?? cfg.mcp ?? cfg.mcpServers)[name], e = entry.env ?? entry.environment;
    assert.deepEqual([e.ASTRA_ALLOW_MODEL_COMPACTION, e.ASTRA_COMPACT_TRIGGER_TOKENS, e.ASTRA_COMPACT_KEEP_RECENT_GROUPS], ['0', '5584', '0']);
    assert.doesNotMatch(h.rulesSnippet, /compact_context/); assert.match(h.rulesSnippet, /40%/);
  }
  assert.doesNotMatch(read(subagentPaths().pluginSkill), /compact_context/);
});

test('native plugin upgrade replaces the obsolete manifest key, preserves user notes, and only links enabled rules', async () => {
  const f = subagentPaths();
  write(f.pluginManifest, JSON.stringify({ name, version: '1.2.0', mcpServers: './mcp_config.json', userMetadata: 'keep' }));
  write(f.pluginRules, 'My existing rule.\n');
  await api('subagent/apply', { ...req, targets: ['antigravity'], allowModelOverride: true, customInstructions: 'Use the fixture test suite.' });
  const manifest = doc(f.pluginManifest); assert.equal(manifest.mcpServers, undefined); assert.equal(manifest.userMetadata, 'keep');
  assert.ok(read(f.pluginRules).startsWith('My existing rule.\n')); assert.ok(read(f.pluginSkill).includes('explicitly select a model'));
  assert.ok(read(f.pluginRules).includes('Use the fixture test suite.'));
  await api('subagent/apply', { targets: ['antigravity'], writeRules: false, keepExistingKey: true });
  assert.deepEqual(doc(f.pluginManifest).rules, []); assert.equal(read(f.pluginRules), 'My existing rule.\n');
});

test('Claude-3p only and standalone Cline do not create unused standard or VS Code profiles', async () => {
  const f = subagentPaths(); fs.mkdirSync(path.dirname(f.desktop3pMcp), { recursive: true });
  const result = await api('subagent/apply', { ...req, targets: ['claude-desktop','cline'] });
  assert.equal(result.status.harnesses.find((h: any) => h.id === 'claude-desktop').mcpPath, f.desktop3pMcp); assert.ok(fs.existsSync(f.desktop3pMcp));
  assert.ok(fs.existsSync(f.clineMcp)); assert.ok(!fs.existsSync(f.desktopMcp)); assert.ok(!fs.existsSync(f.clineVsMcp));
  fs.mkdirSync(path.dirname(f.clineVsMcp), { recursive: true }); await api('subagent/remove', { targets: ['cline'] });
  assert.equal(doc(f.clineMcp).mcpServers[name], undefined); assert.ok(!fs.existsSync(f.clineVsMcp)); assert.ok(!fs.existsSync(f.clineRules));
});

test('user-env mode accepts an existing key and the override prevents registry writes; switching to mcp-env is explicit', async () => {
  process.env.ASTRA_API_KEY = previous; writeAstraUserEnvKey('must-not-be-written'); assert.equal(readAstraUserEnvKey(), previous);
  const f = subagentPaths(); const result = await api('subagent/apply', { targets: ['claude-code'], keyStorage: 'user-env' });
  assert.equal(result.status.config.keySource, 'user-env'); assert.equal(result.status.userEnvHasKey, true);
  for (const route of ['preview-diff', 'apply', 'test']) {
    const custom = { baseUrl: 'https://other.invalid' };
    await api('subagent/' + route, route === 'test' ? { ...custom, testUpstream: true } : { ...custom, targets: ['cursor'], keepExistingKey: false }, 400);
  }
  assert.equal(doc(f.claudeMcp).mcpServers[name].env.ASTRA_API_KEY, process.platform === 'win32' ? undefined : previous);
  const applied = await api('subagent/apply', { targets: [...ids], keyStorage: 'user-env', apiKey: secret }); noSecrets(applied, previous, secret);
  if (process.platform === 'win32') for (const h of applied.status.harnesses) { assert.ok(!read(h.mcpPath).includes('ASTRA_API_KEY')); assert.ok(!h.snippet.includes(secret)); }
  assert.equal(readAstraUserEnvKey(), previous);
  const local = await api('subagent/apply', { targets: ['claude-code'], keyStorage: 'mcp-env', keepExistingKey: true });
  assert.equal(doc(f.claudeMcp).mcpServers[name].env.ASTRA_API_KEY, secret); noSecrets(local, previous, secret);
});

test('a partial Windows user-key rotation cannot expose the new credential to an older harness origin', async () => {
  const f = subagentPaths(); await api('subagent/apply', { ...req, targets: ['claude-code'], keyStorage: 'user-env' });
  const next = { ...req, targets: ['cursor'], baseUrl: 'https://other.invalid', apiKey: previous, keyStorage: 'user-env' };
  if (process.platform === 'win32') {
    await api('subagent/apply', next, 409); assert.equal(fs.existsSync(f.cursorMcp), false); assert.equal(runtime.db.state('subagent').apiKey, secret);
    const switched = await api('subagent/apply', { ...next, targets: ['cursor','claude-code'] }); noSecrets(switched, secret, previous);
  } else {
    await api('subagent/apply', next); assert.equal(doc(f.claudeMcp).mcpServers[name].env.ASTRA_API_KEY, secret);
  }
});

test('Windows restore checks the snapshot key against planned and untouched entries before any writes', { skip: process.platform !== 'win32' }, async () => {
  const f = subagentPaths(), from = { ...req, keyStorage: 'user-env', targets: ['cursor'] };
  await api('subagent/apply', from); process.env.ASTRA_API_KEY = secret;
  const next = { ...from, baseUrl: 'https://rotated.invalid/v1', apiKey: previous };
  const rotation = await api('subagent/apply', next); process.env.ASTRA_API_KEY = previous;
  const before = runtime.db.state('subagent'), cursor = read(f.cursorMcp), rules = read(f.runtime);
  const count = runtime.db.backups().length, restore = `backups/${rotation.system.backupId}/restore`;
  // The standalone Cline file is not the selected VS Code profile, but it also inherits the registry key.
  fs.mkdirSync(path.dirname(f.clineVsMcp), { recursive: true });
  const mcp = (url: string, key?: string) => JSON.stringify({ mcpServers: { [name]: { env: { ASTRA_BASE_URL: url, ASTRA_API_KEY: key } } } });
  write(f.clineMcp, mcp(next.baseUrl));
  const denied = await api(restore, {}, 409); noSecrets(denied, secret, previous);
  assert.equal(read(f.cursorMcp), cursor); assert.equal(read(f.runtime), rules); assert.equal(read(f.clineMcp), mcp(next.baseUrl));
  assert.deepEqual(runtime.db.state('subagent'), before); assert.equal(runtime.db.backups().length, count); assert.equal(readAstraUserEnvKey(), previous);
  write(f.clineMcp, mcp(next.baseUrl, 'explicit-per-harness')); await api(restore, {});
  assert.equal(doc(f.cursorMcp).mcpServers[name].env.ASTRA_BASE_URL, from.baseUrl); assert.equal(runtime.db.state('subagent').apiKey, secret);
});

test('restoring a keyless file cannot reuse an unrelated current or unattributed snapshot Windows key', { skip: process.platform !== 'win32' }, async () => {
  const f = subagentPaths();
  await api('subagent/apply', { ...req, keyStorage: 'user-env', targets: ['cursor'] });
  process.env.ASTRA_API_KEY = previous; // External rotation: this is not the key paired with the saved origin.
  for (const keyStorage of ['user-env', 'mcp-env']) {
    const rotation = await api('subagent/apply', { ...req, baseUrl: 'https://new.invalid', apiKey: 'next-key', keyStorage, targets: ['cursor'] });
    const before = read(f.cursorMcp), count = runtime.db.backups().length;
    if (keyStorage === 'mcp-env') process.env.ASTRA_API_KEY = 'next-key';
    await api(`backups/${rotation.system.backupId}/restore`, {}, 409);
    assert.equal(read(f.cursorMcp), before); assert.equal(runtime.db.state('subagent').apiKey, 'next-key'); assert.equal(runtime.db.backups().length, count);
    await api('subagent/apply', { ...req, keyStorage: 'user-env', targets: ['cursor'] });
  }
});

test('applying a prompt preset preserves live subagent rules alongside image rules for Claude and Codex', async () => {
  const f = subagentPaths(); await api('subagent/apply', { ...req, targets: ['claude-code','codex'] });
  const img = runtime.db.state('imagePrompt'); runtime.db.setState('imagePrompt', { ...img, apiKey: previous, enabled: true, targets: { claude: true, codex: true } });
  for (const [id, file] of [['claude', f.claudeRules], ['codex', f.codexRules]] as const) {
    const block = subagentBlock(read(file)); const preset = runtime.db.createPrompt({ name: 'Preset', appType: id, content: '# Replacement' });
    await api(`extensions/prompts/${preset.id}/apply`, {}); const text = read(file);
    assert.equal(subagentBlock(text), block); assert.ok(text.includes('# Replacement') && text.includes(IMAGE_PROMPT_START) && text.includes(IMAGE_PROMPT_END));
    noSecrets(await api('subagent/preview-diff', { ...req, targets: [id === 'claude' ? 'claude-code' : id] }), previous, secret);
  }
});

test('saved provider inheritance, real MCP handshake and optional read-only upstream model discovery', async () => {
  const p = runtime.db.createProvider({ appType: 'gemini', protocol: 'gemini-native', name: 'Native', baseUrl: 'https://fixture.invalid/relay/v1beta', model: 'gemini-sample', apiKey: secret });
  const applied = await api('subagent/apply', { targets: ['gemini-cli'], providerId: p.id, keyStorage: 'mcp-env' });
  assert.equal(applied.status.config.providerId, p.id); assert.equal(applied.status.config.keySource, 'provider'); assert.equal(applied.status.config.protocol, p.protocol);
  let calls = 0; upstream = async (u, init) => { calls++; assert.equal(String(u), 'https://fixture.invalid/relay/v1beta/models'); assert.equal(new Headers(init?.headers).get('x-goog-api-key'), secret); return json({ models: [] }); };
  const handshake = await api('subagent/test', {}); assert.equal(handshake.ok, true); assert.equal(calls, 0); assert.equal(handshake.serverVersion, '1.6.0'); assert.equal(handshake.toolsCount, 6); assert.equal(new Set(handshake.tools).size, 6);
  assert.equal(handshake.effectiveModel, p.model); assert.equal(handshake.effectiveProtocol, p.protocol); assert.ok(handshake.pythonExecutable && handshake.pythonVersion);
  const check = await api('subagent/test', { providerId: p.id, testUpstream: true }); assert.equal(check.upstreamOk, true); assert.equal(calls, 1);
  upstream = async () => json({ error: secret }, 403); const denied = await api('subagent/test', { testUpstream: true }); assert.equal(denied.ok, false); assert.equal(denied.upstreamOk, false); noSecrets(denied, secret);
  const bad = await api('subagent/test', { pythonPath: path.join(home, 'missing', 'python') }); assert.ok(!bad.ok && bad.error); assert.equal(bad.toolsCount, 0);
  await api('subagent/test', { baseUrl: 'https://other.invalid', testUpstream: true }, 400);
});

test('custom model probes use the versioned prefix, protocol header and supplied key before deployment', async () => {
  const cases = [
    ['openai-chat', 'https://ark.cn-beijing.volces.com/api/v3', '/api/v3/models', 'authorization'],
    ['openai-responses', 'https://ark.cn-beijing.volces.com/api/v3/CHAT/completions/', '/api/v3/models', 'authorization'],
    ['anthropic-messages', 'https://open.bigmodel.cn/api/paas/v4/messages', '/api/paas/v4/models', 'x-api-key'],
    ['openai-chat', 'https://relay.invalid', '/v1/models', 'authorization'],
    ['openai-responses', 'https://relay.invalid/proxy/responses', '/proxy/v1/models', 'authorization'],
    ['anthropic-messages', 'https://relay.invalid/proxy/V2beta1', '/proxy/V2beta1/models', 'x-api-key'],
    ['gemini-native', 'https://generativelanguage.googleapis.com/V1BETA/', '/v1beta/models', 'x-goog-api-key'],
  ];
  for (const [protocol, baseUrl, models, header] of cases) {
    const calls: string[] = [];
    upstream = async (u, init) => {
      calls.push(String(u)); assert.equal(new Headers(init?.headers).get(header), header === 'authorization' ? `Bearer ${secret}` : secret);
      return json(protocol === 'gemini-native' ? { models: [] } : { data: [] });
    };
    const result = await api('subagent/test', { protocol, baseUrl, apiKey: secret, testUpstream: true });
    assert.deepEqual(calls, [new URL(baseUrl).origin + models]); assert.equal(result.upstreamOk, true); noSecrets(result, secret);
  }
  assert.equal(runtime.db.state('subagent').apiKey, '');
});

test('switching a saved provider to a manual third-party endpoint writes only its new connection settings', async () => {
  const provider = runtime.db.createProvider({ appType: 'codex', protocol: 'openai-responses', name: 'Saved', baseUrl: 'https://original.invalid', apiKey: previous });
  const target = { targets: ['cursor'], keyStorage: 'mcp-env' };
  for (const [protocol, baseUrl] of [
    ['openai-chat', 'https://api.deepseek.com/v1'], ['openai-responses', 'https://relay.invalid/api/v3/responses'],
    ['anthropic-messages', 'https://relay.invalid/proxy/v2'], ['gemini-native', 'https://generativelanguage.googleapis.com/v1beta'],
  ]) {
    await api('subagent/apply', { ...target, providerId: provider.id });
    const request = { ...target, protocol, baseUrl, apiKey: secret, model: 'my-custom:8b' };
    noSecrets(await api('subagent/preview-diff', request), previous, secret);
    const { status } = await api('subagent/apply', request); noSecrets(status, previous, secret);
    const c = status.config, e = doc(subagentPaths().cursorMcp).mcpServers[name].env;
    assert.deepEqual([c.keySource, c.providerId, c.groupId, c.keyId], ['manual', null, null, null]);
    assert.deepEqual([e.ASTRA_BASE_URL, e.ASTRA_PROTOCOL, e.ASTRA_API_KEY, e.ASTRA_MODEL], [baseUrl, protocol, secret, request.model]);
  }
});

test('clearing the saved Python path tests and deploys using automatic detection', async () => {
  runtime.db.setState('subagent', { ...runtime.db.state('subagent'), pythonPath: path.join(home, 'missing', 'python') });
  const failed = await api('subagent/test', {}); assert.equal(failed.ok, false);
  const checked = await api('subagent/test', { pythonPath: '' });
  assert.equal(checked.ok, true); assert.ok(Number.isFinite(checked.handshakeLatencyMs)); assert.ok(checked.handshakeLatencyMs <= checked.latencyMs);
  const applied = await api('subagent/apply', { ...req, targets: ['cursor'], pythonPath: '' });
  assert.ok(applied.status.python.meetsMinimum); assert.equal(applied.status.config.pythonPath, undefined);
});

test('Phuket credentials reject mismatches, use the chosen key, and preview never mints remote keys', async () => {
  const group = { id: 25, name: 'Gemini', platform: 'gemini', status: 'active', models: [{ name: 'gemini-test' }] };
  const key = { id: 8, group_id: 25, name: 'existing', status: 'active', key: secret }; let created = 0;
  const conf = { targets: ['codex'], groupId: 25, keyStorage: 'mcp-env' };
  await api('subagent/apply', conf, 401);
  runtime.phuket.replaceSession({ token: 'test-access', account: account({ id: 1, email: 'a@test.invalid' }) });
  upstream = async (u, init) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith('/keys') && init?.method === 'POST') { created++; return json({ data: { ...key, id: 10, name: 'minted' } }); }
    if (url.pathname.endsWith('/keys')) return json({ data: { items: [key], total: 1 } });
    return json({ data: url.pathname.endsWith('/groups/available') || url.pathname.endsWith('/model-plaza') ? [group] : {} });
  };
  const preview = await api('subagent/preview-diff', { ...conf, autoCreatePhuketKey: true }); assert.equal(created, 0); noSecrets(preview, secret);
  await api('subagent/apply', { ...conf, groupId: 26, phuketKeyId: key.id }, 400);
  for (const select of [{ phuketKeyId: key.id }, {}, { autoCreatePhuketKey: true }]) {
    const result = await api('subagent/apply', { ...conf, ...select }); assert.equal(result.status.config.keySource, 'phuket-group'); assert.equal(result.status.config.groupId, 25);
    assert.equal(result.status.config.keyId, select.autoCreatePhuketKey ? 10 : 8); noSecrets(result, secret);
  }
  assert.equal(created, 1);
});

test('compact template length limits include CRLF, longest model name and optional custom guidance', async () => {
  const config = { ...req, model: 'a'.repeat(256), protocol: 'anthropic-messages', maxContextTokens: 1_000_000, targets: ['windsurf', 'codex'], customInstructions: 'more notes\r\n'.repeat(400) };
  const preview = await api('subagent/preview-diff', config), f = subagentPaths(); noSecrets(preview, secret);
  const after = (file: string) => preview.files.find((v: { path: string }) => v.path === file).after;
  const codexEnv = (src: string) => {
    const servers: unknown = parseToml(src).mcp_servers;
    assert.ok(isRecord(servers) && isRecord(servers[name]) && isRecord(servers[name].env));
    return servers[name].env;
  };
  for (const env of [codexEnv(after(f.codexMcp)), JSON.parse(after(f.windsurfMcp)).mcpServers[name].env]) {
    assert.equal(env.ASTRA_MAX_CONTEXT_TOKENS, '1000000'); assert.equal(env.ASTRA_COMPACT_TRIGGER_TOKENS, '750000'); assert.equal(env.ASTRA_API_KEY, '[REDACTED]');
  }
  const status: SubagentStatus = (await api('subagent/apply', config)).status;
  assert.equal(status.config.maxContextTokens, 1_000_000); assert.equal(codexEnv(read(f.codexMcp)).ASTRA_MAX_CONTEXT_TOKENS, '1000000');
  for (const h of status.harnesses.filter(h => h.id !== 'antigravity')) {
    assert.ok(h.rulesSnippet.replace(/\r?\n/g, '\r\n').length <= (h.id === 'windsurf' ? 1400 : 1800), h.name);
    if (h.id === 'cursor') assert.ok(subagentBlock(h.rulesSnippet)!.replace(/\r?\n/g, '\r\n').length <= 1740);
    assert.match(h.rulesSnippet, /compact_context\(action="set_limit", max_context_tokens=/); assert.match(h.rulesSnippet, /1,000,000/); assert.match(h.rulesSnippet, /watch_command/);
  }
});

test('invalid payloads, malformed JSON and symlinks fail without partial writes or backups', async () => {
  for (const patch of [{ targets: ['other'] }, { targets: [] }, { protocol: 'shell' }, { baseUrl: 'https://secret@x' }, { apiKey: 'one\ntwo' }, { defaultMode: 'other' }, { maxContextTokens: -5 }, { maxContextTokens: 1_000_001 }, { maxContextTokens: 9999.5 }, { enableChunkCompaction: 'false' }, { compactTriggerPct: 39 }, { compactTriggerPct: 96 }, { compactTriggerPct: 75.5 }, { compactKeepRecentGroups: -1 }, { compactKeepRecentGroups: 21 }, { compactKeepRecentGroups: 2.5 }, { customInstructions: SUBAGENT_END }, { unexpected: 1 }]) {
    await api('subagent/apply', { ...req, ...patch }, 400);
  }
  const f = subagentPaths(); write(f.cursorMcp, '{invalid secret: ' + secret); const error = await api('subagent/apply', { ...req, targets: ['codex','cursor'] }, 409); noSecrets(error, secret);
  assert.equal(fs.existsSync(f.codexMcp), false); assert.equal(fs.existsSync(f.runtime), false);
  const cc = path.join(home, '.cc-switch'); fs.mkdirSync(cc); write(path.join(cc, 'config.toml'), 'sentinel = true'); fs.symlinkSync(cc, path.dirname(f.codexMcp), process.platform === 'win32' ? 'junction' : 'dir');
  for (const route of ['preview-diff','apply']) await api('subagent/' + route, { ...req, targets: ['codex'] }, 409);
  assert.equal(read(path.join(cc, 'config.toml')), 'sentinel = true'); assert.equal(runtime.db.backups().length, 0);
});
