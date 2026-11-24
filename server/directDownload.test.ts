import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { directDownloadTargets as ids, type DirectDownloadDiffPreview, type DirectDownloadStatus, type DirectDownloadTestResult } from '../shared/types.js';
import { createManagementApp, createRuntime } from './app.js';
import { cliPaths, directDownloadPaths, managedText, subagentPaths } from './configFiles.js';
import { DIRECT_DOWNLOAD_END as end, DIRECT_DOWNLOAD_START as start, directDownloadBlock } from './directDownloadRules.js';
import { bundledDirectFile } from './directFiles.js';
import { IMAGE_PROMPT_START, IMAGE_PROMPT_END } from './imagePrompt.js';
import { SUBAGENT_END, SUBAGENT_START } from './subagentRules.js';

let runtime: ReturnType<typeof createRuntime>, root: string, home: string, base: string, servers: http.Server[], saved: NodeJS.ProcessEnv;
const read = (p: string) => fs.readFileSync(p, 'utf8');
function write(p: string, contents: string) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, contents); }
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  servers.push(server); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'phuket-dl-')); home = path.join(root, 'user home'); fs.mkdirSync(home);
  saved = { PHUKET_SWITCH_HOME: process.env.PHUKET_SWITCH_HOME, PHUKET_SWITCH_USER_HOME: process.env.PHUKET_SWITCH_USER_HOME };
  Object.assign(process.env, { PHUKET_SWITCH_HOME: path.join(root, 'db'), PHUKET_SWITCH_USER_HOME: home });
  servers = []; runtime = createRuntime(); base = (await listen(createManagementApp(root, runtime))) + '/api/';
});
afterEach(async () => {
  try {
    await runtime.close();
    await Promise.all(servers.map(s => new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); })));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
async function api(resource: string, body?: unknown, code = 200) {
  const r = await fetch(base+resource, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(16000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await r.json() as any; assert.equal(r.status, code, JSON.stringify(data.error)); return data;
}
const dd = (suffix = '', body?: unknown, code = 200) => api('direct-download'+suffix, body, code);
const req = { targets: ids, mode: 'physical-nic', interfaceName: 'Office Ethernet', dnsServers: ['192.0.2.53','2001:db8::53'],
  connections: 8, retries: 2, maxRate: '2.5MB', resume: false, customInstructions: 'Report the SHA-256.' };

test('defaults, target detection, summarized preview and validation have no persistent side effects', async () => {
  const before: DirectDownloadStatus = await dd(), f = directDownloadPaths();
  assert.deepEqual(before.config, { enabled: false, mode: 'physical-nic', interfaceName: '', dnsServers: [], connections: 4, retries: 5,
    maxRate: '', resume: true, enableTorrent: true, targets: Object.fromEntries(ids.map(id => [id, false])) });
  assert.equal(runtime.db.state('directBypass').enabled, false);
  assert.match(before.previewMarkdown, /--physical-nic\b/);
  assert.ok(before.python.meetsMinimum); assert.equal(before.scriptInstalled, false); assert.equal(before.runtimeDir, f.dir); assert.equal(before.scriptPath, f.script); assert.equal(before.cmdPath, f.cmd);
  assert.deepEqual(Object.keys(before.liveTargets), ids); assert.ok(Object.values(before.liveTargets).every(t => !t.detected && !t.exists && !t.injected));
  const secret = 'fixture-manual-value'; runtime.db.setState('imagePrompt', { ...runtime.db.state('imagePrompt'), apiKey: secret });
  const src = `User notes\r\n${IMAGE_PROMPT_START}\r\n${secret}\r\n${IMAGE_PROMPT_END}\r\n`;
  write(cliPaths().codexPrompt, src);
  const preview: DirectDownloadDiffPreview = await dd('/preview-diff', req);
  assert.equal(preview.files.length, 12); assert.deepEqual(preview.warnings, []); assert.ok(!JSON.stringify(preview).includes(secret));
  for (const k of ['script', 'torrent', 'dns', 'net'] as const) {
    const file = preview.files.find(v => v.path === f[k])!;
    const data = fs.readFileSync(bundledDirectFile(path.basename(f[k]) as 'direct_download.py'));
    assert.equal(file.before, null); assert.ok(file.after?.includes(`${data.length} bytes; SHA-256 ${createHash('sha256').update(data).digest('hex')}`));
  }
  assert.match(preview.files.find(v => v.path === f.cmd)!.after!, /^@echo off/);
  for (const token of ['-c 8', '--retries 2', '--max-rate 2.5MB', '--no-resume', '--physical-nic', '--interface="Office Ethernet"', '--dns 192.0.2.53,2001:db8::53', '--bt-info', '--bt-select', req.customInstructions]) assert.ok(preview.previewMarkdown.includes(token), token);
  for (const patch of [{ targets: [] }, { targets: ['cursor'] }, { targets: ['codex','codex'] }, { dnsServers: ['invalid'] }, { dnsServers: Array(5).fill('::1') }, { interfaceName: 'x\ny' },
    { interfaceName: 'x'.repeat(129) }, { connections: 17 }, { connections: 1.5 }, { retries: -1 }, { retries: 21 }, { maxRate: '-1M' }, { maxRate: '10P' }, { mode: 'auto' },
    { customInstructions: start }, { customInstructions: 'a'.repeat(2001) }, { scriptPath: 'other.py' }]) await dd('/apply', { ...req, ...patch }, 400);
  await dd('/remove', { targets: [] }, 400);
  for (const url of ['http://@127.0.0.1', 'http://a:b@127.0.0.1', 'file:///local', 'http://']) await dd('/test', { url }, 400);
  const after: DirectDownloadStatus = await dd(); assert.deepEqual(after.config, before.config); assert.ok(after.liveTargets.codex.detected && after.liveTargets.codex.exists);
  assert.equal(after.liveTargets.codex.injected, false); assert.deepEqual(fs.readdirSync(home), ['.codex']); assert.equal(read(cliPaths().codexPrompt), src); assert.deepEqual(runtime.db.backups(), []);
  assert.throws(() => managedText(f.dir), /not a managed/); assert.throws(() => managedText(path.join(f.dir,'arbitrary.py')), /not a managed/);
});

test('apply deploys five exact runtime files and preserves notes and other marker blocks for all seven targets', async () => {
  const before: DirectDownloadStatus = await dd(), f = directDownloadPaths();
  const original = `Personal $& notes\r\n${SUBAGENT_START}\r\nsub\r\n${SUBAGENT_END}\r\n${IMAGE_PROMPT_START}\r\nimg\r\n${IMAGE_PROMPT_END}\r\n`;
  for (const t of Object.values(before.liveTargets)) write(t.path, original);
  const { status, system } = await dd('/apply', req); assert.equal(system.applied, true); assert.equal(system.changedPaths.length, 12);
  assert.equal(runtime.db.backups(system.backupId)[0].reason, 'Apply direct downloader'); assert.ok(status.scriptInstalled && status.config.enabled);
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['direct_dns.py','direct_download.py','direct_net.py','direct_torrent.py','phuket-dl.cmd']);
  for (const name of ['direct_download.py','direct_torrent.py','direct_net.py','direct_dns.py'] as const) assert.deepEqual(fs.readFileSync(path.join(f.dir,name)), fs.readFileSync(bundledDirectFile(name)));
  assert.ok(read(f.cmd).includes(`"${status.python.executable}" -I -S -B -u "%~dp0direct_download.py" %*`));
  for (const id of ids) {
    const t = status.liveTargets[id], src = read(t.path);
    assert.ok(t.injected && status.config.targets[id]); assert.equal(t.id, id); assert.ok(src.startsWith(original));
    assert.equal(src.split(start).length, 2); assert.equal(directDownloadBlock(src)?.replaceAll('\r\n','\n'), status.previewMarkdown);
  }
  const repeat = await dd('/apply', req); assert.equal(repeat.system.applied, false); assert.equal(repeat.status.config.updatedAt, status.config.updatedAt);
  const refreshed = await dd('/apply', { targets: ['codex'], enableTorrent: false, mode: 'skip-proxy' });
  assert.ok(!refreshed.status.previewMarkdown.includes('magnet:')); assert.ok(!read(cliPaths().codexPrompt).includes('--bt-info'));
  assert.ok(read(cliPaths().claudePrompt).includes('--bt-info')); assert.ok(read(cliPaths().codexPrompt).includes('--system-route'));
});

test('applying Codex and Claude presets preserves all active managed instructions', async () => {
  runtime.db.setState('imagePrompt', { ...runtime.db.state('imagePrompt'), apiKey: 'test-value', enabled: true, targets: { claude: true, codex: true } });
  const sub = `${SUBAGENT_START}\nkeep $&\n${SUBAGENT_END}`;
  for (const file of [cliPaths().codexPrompt, cliPaths().claudePrompt]) write(file, sub+'\n');
  await dd('/apply', { targets: ['codex','claude-code'] });
  for (const [id,file] of [['codex',cliPaths().codexPrompt],['claude',cliPaths().claudePrompt]] as const) {
    const block = directDownloadBlock(read(file)), preset = runtime.db.createPrompt({ appType: id, name: 'preset', content: 'New prompt\n' });
    await api(`extensions/prompts/${preset.id}/apply`, {});
    const text = read(file); assert.equal(directDownloadBlock(text), block); assert.ok(text.includes(sub) && text.includes(IMAGE_PROMPT_START) && text.startsWith('New prompt'));
  }
});

test('restoring a backup restores original bytes, missing files and the previous DB config', async () => {
  const before: DirectDownloadStatus = await dd(), f = directDownloadPaths();
  const original = '\uFEFFnotes with CRLF\r\n'; write(cliPaths().codexPrompt, original); write(f.cmd, 'old launcher\r\n');
  const applied = await dd('/apply', { ...req, targets: ['codex','cline'] });
  const undo = await api(`backups/${applied.system.backupId}/restore`, {}); assert.ok(undo.applied);
  assert.deepEqual(runtime.db.state('directDownload'), before.config); assert.equal(read(cliPaths().codexPrompt), original); assert.equal(read(f.cmd), 'old launcher\r\n');
  assert.deepEqual(fs.readdirSync(f.dir), ['phuket-dl.cmd']); assert.equal(fs.existsSync(f.clineRules), false);
  await api(`backups/${undo.backupId}/restore`, {}); assert.deepEqual(runtime.db.state('directDownload'), applied.status.config); assert.ok((await dd()).scriptInstalled);
});

test('remove is surgical and consults live unselected markers before removing shared files', async () => {
  const f = directDownloadPaths(), cli = cliPaths(); write(cli.codexPrompt, 'user notes\n');
  const applied = await dd('/apply', { targets: ['codex','cline'] }); const block = directDownloadBlock(read(f.clineRules))!;
  write(subagentPaths().geminiRules, 'outside\n'+block+'\n'); // Simulate an existing injection not recorded in the database.
  const one = await dd('/remove', { targets: ['codex','cline'] }); assert.ok(one.status.config.enabled && one.status.config.targets['gemini-cli'] && one.status.scriptInstalled);
  assert.equal(read(cli.codexPrompt), 'user notes\n'); assert.equal(fs.existsSync(f.clineRules), false);
  const keep = await dd('/remove', { targets: ['gemini-cli'], removeScripts: false }); assert.equal(keep.status.config.enabled, false); assert.ok(keep.status.scriptInstalled);
  assert.equal(read(subagentPaths().geminiRules), 'outside\n'); write(path.join(f.dir,'keep.txt'), 'not managed');
  const last = await dd('/remove', { targets: ['cline'] }); assert.equal(last.status.scriptInstalled, false); assert.deepEqual(fs.readdirSync(f.dir), ['keep.txt']);
  assert.equal(runtime.db.backups(last.system.backupId)[0].reason, 'Remove direct downloader'); assert.notEqual(last.system.backupId, applied.system.backupId);
  await api(`backups/${last.system.backupId}/restore`, {}); assert.ok((await dd()).scriptInstalled);
  write(f.clineRules, 'my own note\n'); await dd('/apply', { targets: ['cline'] }); await dd('/remove', { targets: ['cline'] }); assert.equal(read(f.clineRules), 'my own note\n');
});

test('ambiguous markers, Windsurf overflow and missing Python fail before deployment', async () => {
  const sub = subagentPaths(), f = directDownloadPaths(), baseConfig = runtime.db.state('directDownload');
  for (const text of [start, end+'\n'+start, start+start+end]) {
    write(sub.codexRules, text); await dd('/apply', req, 409); assert.equal(read(sub.codexRules), text);
  }
  write(sub.codexRules, 'ok'); write(sub.windsurfRules, 'x'.repeat(11990)); await dd('/preview-diff', req, 409); await dd('/apply', req, 409);
  write(sub.windsurfRules, 'ok'); runtime.db.setState('subagent', { ...runtime.db.state('subagent'), pythonPath: path.join(home,'missing','python') });
  assert.ok((await dd('/preview-diff', req)).warnings.length); await dd('/apply', req, 400); const check = await dd('/test', {}); assert.equal(check.ok, false); assert.ok(check.error);
  assert.equal(fs.existsSync(f.dir), false); assert.deepEqual(runtime.db.backups(), []); assert.deepEqual(runtime.db.state('directDownload'), baseConfig);
});

test('real isolated Python self-check and read-only loopback HTTP probe run against the bundled and deployed scripts', async () => {
  const bundled: DirectDownloadTestResult = await dd('/test', {});
  assert.ok(bundled.ok && bundled.pythonExecutable && bundled.pythonVersion); assert.equal(bundled.scriptVersion,'1.1.0'); assert.ok(bundled.capabilities.includes('magnet')); assert.equal(bundled.probe, undefined);
  assert.deepEqual(fs.readdirSync(home), []);
  const seen: string[] = []; const url = await listen((q,r) => {
    seen.push(`${q.method} ${q.url} ${q.headers.range ?? ''}`);
    if (q.url === '/start') { r.writeHead(302, { location: '/file.bin' }).end(); return; }
    if (q.method === 'HEAD') { r.writeHead(405).end(); return; }
    r.writeHead(206, { 'content-range': 'bytes 0-0/456', 'content-type': 'application/octet-stream', 'content-length': 1 }).end('x');
  });
  await dd('/apply', { mode: 'physical-nic', interfaceName: 'not a real adapter', targets: ['codex'] });
  const probe: DirectDownloadTestResult = await dd('/test', { url: url+'/start' });
  assert.equal(probe.ok, true, probe.error); assert.equal(probe.probe?.route?.systemRoute, true);
  assert.deepEqual([probe.probe?.url, probe.probe?.finalUrl, probe.probe?.filename, probe.probe?.totalSize, probe.probe?.contentType, probe.probe?.acceptRanges],
    [url+'/start', url+'/file.bin', 'file.bin', 456, 'application/octet-stream', true]);
  assert.deepEqual(seen, ['HEAD /start ', 'HEAD /file.bin ', 'GET /start bytes=0-0', 'GET /file.bin bytes=0-0']);
  const f = directDownloadPaths(); assert.equal(fs.existsSync(path.join(f.dir,'file.bin')), false); assert.equal(fs.existsSync(path.join(f.dir,'__pycache__')), false);
  // Prove the deployed script was selected, not a silently successful fallback to the bundled copy.
  write(f.script, read(f.script).replace("VERSION = '1.1.0'", "VERSION = '1.0.9'")); assert.equal((await dd('/test', {})).scriptVersion, '1.0.9');
  fs.unlinkSync(f.torrent); const broken = await dd('/test', {}); assert.equal(broken.ok, false); assert.ok(broken.error);
});

test('follow-bypass renders the effective route and the subagent env hook changes only on explicit subagent Apply', async () => {
  const follow = { mode: 'follow-bypass', targets: ['codex'] };
  assert.match((await dd('/preview-diff', follow)).previewMarkdown, /--system-route\b/);
  runtime.db.setState('directBypass', { enabled: true, applyToSubagent: false, mode: 'physical-nic', interfaceName: 'Fixture NIC', dnsServers: ['192.0.2.1'] });
  const preview = await dd('/preview-diff', follow); assert.ok(preview.previewMarkdown.includes('--interface="Fixture NIC"') && preview.previewMarkdown.includes('--dns 192.0.2.1'));
  const sub = subagentPaths(), f = directDownloadPaths(); const params = { targets: ['claude-code'], apiKey: 'fixture-only', keyStorage: 'mcp-env' };
  const mcp = () => JSON.parse(read(sub.claudeMcp)).mcpServers['gpt-astra-subagent'].env;
  await api('subagent/apply', params); assert.equal(mcp().ASTRA_DIRECT_DOWNLOAD_SCRIPT, undefined);
  await dd('/apply', follow); assert.equal(mcp().ASTRA_DIRECT_DOWNLOAD_SCRIPT, undefined);
  await api('subagent/apply', params); assert.equal(mcp().ASTRA_DIRECT_DOWNLOAD_SCRIPT, f.script);
  await dd('/remove', { targets: ['codex'] }); assert.equal(mcp().ASTRA_DIRECT_DOWNLOAD_SCRIPT, f.script);
  await api('subagent/apply', params); assert.equal(mcp().ASTRA_DIRECT_DOWNLOAD_SCRIPT, undefined);
});
