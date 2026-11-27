// Run with system Node after npm run build. Real renderer, API and Python; fixture-only providers and homes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..'), secret = 'opaque-ui-only-credential-93', customBase = 'https://api.deepseek.com/v1';
const fixtureProxyPort = 31847;
function seedAstraUsage(data, home) {
  const stamp = Date.now() / 1000, model = 'fixture-astra', sessionId = 'fixture-session';
  const snapshot = (dir, id, value) => {
    fs.mkdirSync(path.join(data, dir), { recursive: true });
    fs.writeFileSync(path.join(data, dir, `${id}.json`), JSON.stringify(value));
  };
  snapshot('sessions', sessionId, { session_id: sessionId, cwd: home, mode: 'readonly', reasoning_effort: 'high', model,
    protocol: 'openai-responses', turns: 4, last_input_tokens: 125000, max_context_tokens: 1000000, compactions: 1, chunk_compactions: 2,
    total_input_tokens: 200000, total_cached_tokens: 50000, total_output_tokens: 3500, total_reasoning_tokens: 350, updated_at: stamp });
  snapshot('workers', 'fixture-worker', { worker_id: 'fixture-worker', worker_name: 'fixture-review', session_id: sessionId,
    status: 'completed', model, api_format: 'openai-responses', steps_used: 3, elapsed_s: 2.5, started_at: stamp - 2.5, finished_at: stamp,
    usage: { input_tokens: 900, cached_tokens: 450, output_tokens: 100, reasoning_tokens: 20 } });
}
function seedProxyUsage(db) {
  const base = { createdAt: new Date().toISOString(), appType: 'codex', protocol: 'openai-responses', providerId: null,
    model: 'requested-model', effectiveModel: 'proxy-model', statusCode: 200, latencyMs: 100, failoverCount: 0 };
  db.addLog({ ...base, id: 'legacy', model: 'legacy-model', effectiveModel: '', statusCode: 502, totalTokens: 77 });
  db.addLog({ ...base, id: 'without-cache', inputTokens: 80, outputTokens: 10 });
  db.addLog({ ...base, id: 'reported', translatedFrom: 'anthropic-messages', inputTokens: 120, cachedTokens: 60, outputTokens: 20, ttftMs: 8 });
  db.addLog({ ...base, id: 'miss', translatedFrom: 'anthropic-messages', inputTokens: 40, cachedTokens: 0, outputTokens: 5 });
}
function accountUsageFixture(url, reads) {
  const start = url.searchParams.get('start_date'), end = url.searchParams.get('end_date');
  const days = 1 + (Date.parse(end) - Date.parse(start)) / 86400000;
  const sample = { requests: 12, input_tokens: 300, cache_read_tokens: 100, cache_creation_tokens: 10, output_tokens: 60, actual_cost: 3.25 };
  switch (url.pathname) {
    case '/api/v1/usage/dashboard/stats': return { total_requests: 42, today_requests: 12, total_tokens: 460, today_tokens: 120,
      total_input_tokens: 300, total_cache_read_tokens: 100, total_actual_cost: 12.5, today_actual_cost: 3.25 };
    case '/api/v1/usage/dashboard/trend': return { trend: [{ ...sample, date: start }] };
    case '/api/v1/usage/dashboard/models':
      reads.set(days, (reads.get(days) ?? 0) + 1);
      return { models: [{ ...sample, model: `account-${days}d` }] };
    case '/api/v1/usage': return { items: [18, 19].map(id => ({ id, api_key_id: id, model: 'account-call', input_tokens: 25,
      output_tokens: 10, duration_ms: 60, actual_cost: 0.12, created_at: `${end}T12:00:00Z` })) };
    default: return {};
  }
}
async function host() {
  const scratch = path.join(root, '.desktop'); fs.mkdirSync(scratch, { recursive: true });
  const temp = fs.mkdtempSync(path.join(scratch, 'subagent-ui-'));
  try { await exercise(temp); }
  finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); }
}
async function exercise(temp) {
  const home = path.join(temp, 'user'), data = path.join(temp, 'plugin-data');
  Object.assign(process.env, { PHUKET_SWITCH_USER_HOME: home, PHUKET_SWITCH_HOME: path.join(temp, 'db'), PLUGIN_DATA: data,
    TMP: temp, TEMP: temp, TMPDIR: temp, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', ASTRA_API_KEY: 'fixture-env-token' });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  seedAstraUsage(data, home);
  const usageReads = new Map();
  const { createRuntime, createManagementApp } = await import('../dist/server/app.js');
  // Gemini is deliberately first: native group defaults must not depend on catalog order.
  const group = { id: 124, name: '测试 Gemini 分组', platform: 'gemini', status: 'active', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-9-image', 'gemini-8-flash-lite', 'gemini-other'].map(name => ({ name })) };
  const groups = [group, { id: 106, name: '受限 Claude', platform: 'anthropic', status: 'active', operating_access: { allowed: false } },
    { id: 107, name: 'Claude', platform: 'anthropic', status: 'active' }, { id: 65, name: 'GPT', platform: 'openai', status: 'active' },
    { id: 800, name: '反重力', platform: 'antigravity', status: 'active' }, { id: 127, name: 'DeepSeek', platform: 'deepseek', status: 'active' }];
  const exampleKey = { id: 18, name: '测试密钥', key: 'fixture-group-credential', status: 'active', group_id: 124 };
  const keys = [exampleKey, { ...exampleKey, id: 19, status: 'inactive' }];
  const runtime = createRuntime({ directBypass: { systemRoute: true }, fetch: async (u, init) => {
    const url = new URL(String(u)); let value = {};
    if (url.hostname === 'catalog.invalid') { assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-provider-credential'); return Response.json({ data: [] }); }
    if (url.href === customBase + '/models') { assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`); return Response.json({ data: [] }); }
    assert.equal(url.origin, 'https://ai.pukitcore.com');
    value = accountUsageFixture(url, usageReads);
    if (url.pathname.endsWith('/model-plaza') || url.pathname.endsWith('/groups/available')) value = groups;
    if (url.pathname.endsWith('/keys')) {
      if (init.method === 'POST') {
        const { name, group_id } = JSON.parse(init.body); assert.equal(group_id, group.id);
        const id = 18 + keys.length;
        value = { id, name, group_id, key: `fixture-issued-${id}`, status: 'active' };
        keys.unshift({ ...value, key: '****' }); // Only the issue response contains the full new key.
      } else value = { items: keys, total: keys.length };
    }
    if (url.pathname.endsWith('/auth/me')) value = { id: 221, email: 'desktop@example.invalid', balance: 82.5, total_recharged: 95 };
    return Response.json({ data: value });
  } });
  runtime.db.createProvider({ name: '测试供应商', appType: 'codex', protocol: 'openai-responses', baseUrl: 'https://catalog.invalid/v1', apiKey: 'fixture-provider-credential', model: 'provider-model', availableModels: ['provider-other'] });
  const server = http.createServer(createManagementApp(undefined, runtime));
  runtime.db.setState('proxySettings', { ...runtime.db.state('proxySettings'), port: fixtureProxyPort });
  const requests = {}, tests = []; let lastPath = '(no requests)';
  server.prependListener('request', req => { const route = req.url; lastPath = route.split('?')[0]; if (!['/api/subagent/apply','/api/subagent/preview-diff','/api/subagent/test'].includes(route)) return;
    let body = ''; req.on('data', b => body += b); req.on('end', () => { const data = JSON.parse(body); if (route === '/api/subagent/test') tests.push(data); else requests[route] = data; }); });
  let child;
  try {
    seedProxyUsage(runtime.db);
    await runtime.directBypass.updateConfig({ interfaceName: 'Fixture Ethernet' }); // Saved adapter is offline in this fixture.
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const env = { ...process.env, PHUKET_UI_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}` }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(createRequire(import.meta.url)('electron'), [`--user-data-dir=${path.join(temp, 'chromium')}`, '--no-proxy-server', '--disable-background-networking', import.meta.filename], { env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => { console.error('UI smoke timed out; last request:', lastPath); child.kill(); }, 90000);
    try { assert.equal((await once(child, 'exit'))[0], 0); } finally { clearTimeout(timer); }
    assert.ok(usageReads.get(1) >= 1 && usageReads.get(7) >= 1 && usageReads.get(30) >= 2, 'dated dashboards and manual refresh reached the upstream');
    assert.deepEqual(requests['/api/subagent/apply'], requests['/api/subagent/preview-diff']);
    assert.equal(requests['/api/subagent/apply'].enableChunkCompaction, false);
    assert.equal(requests['/api/subagent/apply'].compactTriggerPct, 75); assert.equal(requests['/api/subagent/apply'].compactKeepRecentGroups, 0);
    const applied = requests['/api/subagent/apply'], customTests = tests.filter(t => t.baseUrl === customBase);
    assert.equal(applied.apiKey, secret); assert.equal(applied.model, 'my-custom:8b'); assert.equal(applied.baseUrl, customBase);
    assert.deepEqual(customTests.map(t => t.testUpstream), [false, true, true]);
    assert.ok(!Object.hasOwn(customTests[0], 'apiKey')); assert.ok(customTests.slice(1).every(t => t.apiKey === secret));
    for (const r of [applied, ...customTests]) for (const field of ['providerId','groupId','phuketKeyId','autoCreatePhuketKey','keepExistingKey']) assert.ok(!Object.hasOwn(r, field));
    assert.equal(runtime.db.state('subagent').keySource, 'manual');
    const imported = runtime.db.providers().filter(p => p.phuketGroupId === group.id);
    assert.equal(imported.length, 4);
    for (const [name, app, key] of [['CLI form', 'claude', exampleKey.key], [exampleKey.name, 'claude', exampleKey.key],
      ['Desktop form', 'claude-desktop', 'fixture-issued-20'], ['Desktop issued', 'claude-desktop', 'fixture-issued-21']]) {
      const p = imported.find(p => p.name === name); assert.ok(p, name); assert.equal(p.appType, app); assert.equal(p.apiKey, key);
      assert.equal(p.protocol, 'anthropic-messages'); assert.equal(p.baseUrl, 'https://ai.pukitcore.com'); assert.equal(p.model, 'gemini-2.5-pro');
      assert.deepEqual(p.claudeModelMap, { opus: p.model, sonnet: p.model, defaultModel: p.model, haiku: 'gemini-2.5-flash' });
    }
    assert.deepEqual(runtime.db.state('directBypass'), { enabled: false, mode: 'skip-proxy', interfaceName: 'Fixture Ethernet',
      dnsServers: ['192.0.2.53', '2001:db8::53'], applyToSubagent: false });
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.close();
  }
}
async function renderer({ app, BrowserWindow, session }) {
  const origin = process.env.PHUKET_UI_TEST_ORIGIN; assert.ok(origin && process.env.PHUKET_SWITCH_USER_HOME);
  await app.whenReady(); session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(origin + '/') }));
  const w = new BrowserWindow({ show: false, width: 1060, height: 820, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const errors = [];
  w.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  w.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`));
  const js = code => w.webContents.executeJavaScript(code), wait = async (code, what) => { for (let i=0;i<240;i++) { if (await js(code)) return; await delay(40); } throw Error('UI timeout: ' + what); };
  async function page() {
    await w.loadURL(origin + '/subagent'); await wait("document.querySelectorAll('.subagent-harness').length === 9", 'nine targets');
    await js(`addEventListener('error', e => console.error('Page error:', e.message));
      addEventListener('unhandledrejection', e => console.error('Unhandled rejection:', e.reason));
      window.btn = (s, parent=document) => [...parent.querySelectorAll('button')].find(x=>x.textContent.trim()===s);
      window.field = name => [...document.querySelectorAll('.field')].find(l=>l.querySelector('span')?.textContent===name)?.querySelector('input,select,textarea');
      window.setValue = (el,v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,v);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); };
      window.setField = (name,v) => setValue(field(name),v);
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async s=>{window.copied=s}}});void 0`);
  }
  const click = name => js(`btn(${JSON.stringify(name)}).click()`), set = (name,v) => js(`setField(${JSON.stringify(name)},${JSON.stringify(v)})`);
  const leaks = async () => { assert.ok(!await js(`[document.documentElement.outerHTML, JSON.stringify(localStorage), JSON.stringify(sessionStorage)].some(s => s.includes(${JSON.stringify(secret)}))`)); };
  const probe = async () => {
    await js("document.querySelector('.subagent-test-actions input').click()"); await click('验证子代理');
    await wait("document.querySelector('.subagent-result')?.textContent.includes('模型列表可访问')", 'model discovery');
  };
  async function geminiGroupFlows() {
    for (const [client, id] of [['Codex',65], ['Gemini',124], ['反重力',800], ['Grok · 国产',127], ['Claude Desktop',107], ['Claude',107]]) {
      await click(client); await click('添加配置');
      await wait(`field('配置来源')?.value==='${id}'`, `${client} native group`);
      if (client !== 'Claude') await click('取消');
    }
    await set('配置来源', '124');
    await wait("field('客户端')?.value==='claude' && field('API 密钥')?.value==='key:18'", 'Gemini group keeps Claude client and uses existing key');
    assert.deepEqual(await js("[...field('客户端').options].map(o=>o.value)"), ['gemini','antigravity','claude','claude-desktop','codex']);
    assert.equal(await js("field('端点地址 · Anthropic').value"), 'https://ai.pukitcore.com');
    await set('Haiku', 'gemini-other'); await click('自动填充全部');
    assert.deepEqual(await js("['默认模型','Opus','Sonnet','Haiku'].map(label=>field(label).value)"), ['gemini-2.5-pro','gemini-2.5-pro','gemini-2.5-pro','gemini-2.5-flash']);
    await set('供应商名称', 'CLI form'); await click('保存配置');
    await wait("document.querySelector('.provider-list')?.textContent.includes('CLI form')", 'saved CLI form');
    await click('从分组添加'); await wait("!!btn('我的密钥')", 'group tabs'); await click('我的密钥');
    const importKey = "document.querySelector('tbody tr button[aria-label=导入到供应商]')";
    await wait(`${importKey}?.disabled===false`, 'import existing key'); await js(`${importKey}.click()`);
    await wait("fetch('/api/providers?appType=claude').then(r=>r.json()).then(ps=>ps.some(p=>p.name==='测试密钥'))", 'existing key imported for Claude');

    await click('Claude Desktop'); await click('从分组添加');
    const card = "[...document.querySelectorAll('.group-card')].find(c=>c.querySelector('h3').textContent==='测试 Gemini 分组')";
    await wait(`${card}?.textContent.includes('多协议')`, 'Gemini multi-protocol card');
    await js(`btn('添加为供应商', ${card}).click()`);
    await wait("field('配置来源')?.value==='124' && field('客户端')?.value==='claude-desktop' && field('API 密钥')?.value==='key:18'", 'Gemini card keeps Desktop selection');
    await set('API 密钥', 'auto'); await set('供应商名称', 'Desktop form'); await click('保存配置');
    await wait("document.querySelector('.provider-list')?.textContent.includes('Desktop form')", 'saved Desktop form with auto-created key');
    await click('从分组添加'); await wait(`!!(${card})`, 'Gemini card reloaded');
    await js(`btn('用此分组新建密钥', ${card}).click()`); await wait("field('绑定分组')?.value==='124'", 'new key for Gemini group');
    await set('名称', 'Desktop issued'); await click('创建密钥');
    await wait("!!document.querySelector('.issued')", 'one-time key available'); await click('导入到供应商');
    await wait("btn('已导入')?.disabled===true", 'new key imported for Claude Desktop');
  }
  async function usagePage() {
    const metrics = () => js("[...document.querySelectorAll('.usage-view .metric strong')].map(el => el.textContent)");
    const cells = n => js(`[...document.querySelectorAll('.usage-view table')[${n}].tBodies[0].rows].map(r => [...r.cells].map(c => c.textContent))`);
    const nav = path => js(`document.querySelector('.sidebar a[href="${path}"]').click()`);
    await nav('/usage');
    await wait("btn('PhuketAI 账户')?.ariaSelected==='true' && document.querySelector('.usage-view')?.textContent.includes('测试密钥')", 'account tab and active key name');
    assert.deepEqual(await metrics(), ['82.5 credits','3.25 credits','12.5 credits','12','120','100']);
    assert.deepEqual((await cells(1)).map(row => row[2]), ['测试密钥','#19']);
    assert.ok(await js("document.querySelector('.usage-view .metrics').textContent.includes('占输入 25%')"));
    for (const [days, name] of [[7,'近 7 天'],[1,'今天'],[30,'近 30 天']]) {
      await click(name);
      await wait(`!!document.querySelector('[aria-label="${name}消耗与请求趋势"] svg') && !!document.querySelector('progress[aria-label="account-${days}d 费用占比"]')`, name + ' dashboard');
    }
    await js("document.querySelector('[aria-label=刷新账户用量]').click()");
    await wait("!document.querySelector('[aria-label=刷新账户用量]').disabled", 'refreshed dashboard');
    await click('本地代理');
    await wait("location.hash==='#proxy' && document.querySelector('.usage-view tbody')?.textContent.includes('legacy-model')", 'proxy usage');
    assert.deepEqual(await metrics(), ['4','75%','352','37.5%','100 ms']);
    assert.ok(await js("['已上报 2 次','8 ms'].every(detail => document.querySelector('.usage-view .metrics').textContent.includes(detail))"));
    assert.ok((await cells(0)).some(r => r[0] === 'proxy-model' && r[1] === 'Claude Code'));
    const requests = await cells(1);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.find(r => r[2] === 'legacy-model').slice(3,8), ['502','—','—','—','77']);
    await click('子代理');
    await wait("location.hash==='#subagent' && document.querySelector('.usage-view')?.textContent.includes('fixture-review')", 'session and worker usage');
    assert.deepEqual(await metrics(), ['1','200,000','25%','3,500','203,500']);
    assert.deepEqual((await cells(0))[0].slice(-2), ['3,500含推理 350','203,500']);
    const [session] = await cells(1), [worker] = await cells(2);
    assert.deepEqual(session.slice(0,2), ['fixture-session','fixture-astra']);
    assert.ok(session[5].includes('125,000 / 1,000,000') && session[5].includes('12.5%'));
    assert.deepEqual(worker.slice(0,7), ['fixture-review','已完成','fixture-astra','3','2.5 s','1,000','50%']);
    assert.ok(await js("document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth+1"), 'usage tables stay inside the page');
    await click('前往子代理配置'); await wait("!!btn('查看用量')", 'subagent config'); await click('查看用量');
    await wait("location.pathname==='/usage' && location.hash==='#subagent' && btn('子代理')?.ariaSelected==='true'", 'subagent usage shortcut');
    await nav('/groups'); await wait("!!btn('账户与用量')", 'group tabs'); await click('账户与用量');
    await wait("!!btn('查看完整用量与调用明细')", 'account overview shortcut'); await click('查看完整用量与调用明细');
    await wait("location.pathname==='/usage' && location.hash==='#phuket' && btn('PhuketAI 账户')?.ariaSelected==='true'", 'account usage shortcut');
  }
  async function downloadPage() {
    assert.equal(await js("fetch('/api/direct-download').then(r=>r.status)"), 200);
    await click('详细设置'); await wait("!!btn('前往配置')", 'download settings shortcut');
    await js("window.downloadErrors=[]; addEventListener('error',e=>downloadErrors.push(e.message)); addEventListener('unhandledrejection',e=>downloadErrors.push(String(e.reason))); void 0");
    await click('前往配置');
    await wait("location.pathname==='/extensions' && location.hash==='#direct-download' && btn('AI 直连下载')?.getAttribute('aria-selected')==='true' && document.querySelectorAll('.direct-download input[type=checkbox]').length===7", 'direct download tab');
    assert.ok(await js("btn('写入脚本与规则').disabled && field('并行连接数（1–16）').value==='4' && field('重试次数（0–20）').value==='5'"));
    assert.equal(await js("btn('物理网卡直连（绕过代理 + TUN）').getAttribute('aria-pressed')"), 'true');
    await wait("!!field('物理网卡')?.querySelector('option[value=\"Fixture Ethernet\"]')", 'saved offline download adapter');
    await click('仅跳过系统代理'); await click('选择已检测客户端');
    await wait("!btn('写入脚本与规则').disabled", 'detected download targets');
    const downloadTarget = name => `document.querySelector('.direct-download input[aria-label="选择 ${name}"]')`;
    assert.ok(await js(`${downloadTarget('Codex')}.checked`));
    if (!await js(`${downloadTarget('Claude Code')}.checked`)) await js(`${downloadTarget('Claude Code')}.click()`);
    assert.equal(await js("document.querySelectorAll('.direct-download input:checked').length"), 2);
    await set('并行连接数（1–16）','17'); assert.ok(await js("btn('预览变更').disabled"));
    await set('并行连接数（1–16）','6'); await click('预览变更');
    await wait("document.querySelector('dialog[open] .diff-grid') && document.querySelector('.download-diff').textContent.includes('direct_download.py')", 'download file diffs');
    assert.equal(await js("fetch('/api/direct-download').then(r=>r.json()).then(s=>s.scriptInstalled)"), false);
    await click('确认并写入'); await wait("!document.querySelector('dialog[open]') && document.querySelector('.direct-download').textContent.includes('已部署脚本') && !btn('移除所选').disabled && !!btn('移除全部')", 'deployed downloader');
    const paths = await js("fetch('/api/direct-download').then(r=>r.json()).then(s=>[s.scriptPath,s.cmdPath])");
    for (const [i,label] of ['复制Python 脚本路径','复制Windows 启动器路径'].entries()) {
      await js(`document.querySelector('[aria-label="${label}"]').click()`); assert.equal(await js('window.copied'), paths[i]);
    }
    await js("[...document.querySelectorAll('.direct-download summary')].find(s=>s.textContent.startsWith('AI 规则预览')).click()");
    await click('复制 AI 规则'); assert.ok(await js("window.copied.includes('--system-route -c 6')"));
    await set('探测地址（可选）',' '+origin+'/api/health '); await click('自检并探测');
    await wait("document.querySelector('.direct-download .subagent-result')?.textContent.includes('探测成功')", 'loopback download metadata probe');
    assert.ok(await js("['System','/api/health','并行分片','DHT'].every(s=>document.querySelector('.direct-download .subagent-result').textContent.includes(s))"));
    for (const [width,theme] of [[920,'light'],[440,'dark']]) {
      w.setContentSize(width,700); await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await delay(100);
      assert.ok(await js("[...document.querySelectorAll('.direct-download, .direct-download .setting-row')].every(el=>el.scrollWidth<=el.clientWidth+1)"), 'download panel overflow at '+width);
    }
    await js(`${downloadTarget('Codex')}.click()`); await js(`${downloadTarget('Cline')}.click()`);
    await click('移除所选'); await wait("!!btn('确认移除')", 'selected download targets');
    const selected = await js("document.querySelector('.dialog-copy').textContent");
    assert.match(selected, /Claude Code/); assert.doesNotMatch(selected, /Codex|Cline/); await click('确认移除');
    await wait("!document.querySelector('dialog[open]') && document.querySelectorAll('.direct-download .setting-row .badge.good').length===1 && !btn('移除全部').disabled", 'partial download removal');
    assert.ok(await js("fetch('/api/direct-download').then(r=>r.json()).then(s=>s.scriptInstalled && s.liveTargets.codex.injected && !s.liveTargets['claude-code'].injected)"));
    await js(`${downloadTarget('Codex')}.click()`); assert.ok(await js("btn('移除所选').disabled"));
    await click('移除全部'); await wait("!!btn('确认移除')", 'all download targets');
    const all = await js("document.querySelector('.dialog-copy').textContent");
    assert.match(all, /Codex/); assert.doesNotMatch(all, /Claude Code|Cline/); await click('确认移除');
    await wait("!document.querySelector('dialog[open]') && document.querySelector('.direct-download .badge')?.textContent==='未部署' && btn('移除所选').disabled && !btn('移除全部')", 'last download rule and shared scripts removed');
    assert.deepEqual(await js('window.downloadErrors'), []);
  }
  try {
    await page(); assert.deepEqual(await js(`[...document.querySelectorAll('.sidebar nav a')].slice(-3).map(x=>x.pathname)`), ['/lab','/subagent','/extensions']);
    await click('验证子代理'); await wait("document.querySelector('.subagent-result')?.textContent.includes('astra_wait_worker')", 'handshake');
    const { SUBAGENT_VERSION } = await import('../dist/shared/constants.js');
    assert.ok(await js(`document.querySelector('.subagent-result').textContent.includes(${JSON.stringify(SUBAGENT_VERSION)})`));
    assert.ok(await js("document.querySelector('.subagent-metrics').textContent.includes('已开启 · 88% 兜底') && document.querySelector('.subagent-compaction').textContent.includes('239,360')"));
    const localPreset = `http://127.0.0.1:${fixtureProxyPort}`;
    await wait(`field('接口 Base URL')?.placeholder===${JSON.stringify(localPreset)}`, 'configured local proxy port');
    await click('本地代理'); assert.equal(await js("field('接口 Base URL').value"), localPreset);
    await click('已有供应商'); await wait("field('默认子代理模型').value==='provider-model'", 'provider defaults'); await click('provider-other');
    await probe();
    await set('接口 Base URL','https://catalog.invalid:443/relay/v3'); assert.ok(!await js("field('新地址 API 密钥')"));
    await set('接口 Base URL','https://ark.cn-beijing.volces.com/api/v3/chat/completions/');
    assert.ok(await js("field('新地址 API 密钥')?.type==='password' && field('新地址 API 密钥').closest('.subagent-endpoint').textContent.includes('实际请求：https://ark.cn-beijing.volces.com/api/v3/responses')"));
    await set('新地址 API 密钥','first-origin-only'); await click('DeepSeek');
    assert.ok(await js("field('新地址 API 密钥').value==='' && field('默认子代理模型').value==='provider-other' && field('接口协议').value==='openai-chat'"));
    await set('新地址 API 密钥','invalid key'); assert.ok(await js("btn('预览变更 Diff').disabled && document.querySelector('.subagent-test-actions input').disabled"));
    await set('新地址 API 密钥', secret); await click('验证子代理'); await wait("document.querySelector('.subagent-result')?.textContent.includes('未探测')", 'local-only test'); await probe();
    await click('PhuketAI 分组'); await wait("!!btn('登录 PhuketAI')", 'guest login action'); await click('登录 PhuketAI'); await wait("!!document.querySelector('dialog[open]')", 'login dialog'); await js("document.querySelector('dialog[open] button[aria-label=关闭]').click()");
    await js("document.querySelector('.sidebar a[href=\"/usage\"]').click()");
    await wait("document.querySelector('.usage-view .empty')?.textContent.includes('登录 PhuketAI 查看账户与调用明细')", 'guest usage login gate');
    await js(`fetch('/api/phuket/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'offline-guest-access'})}).then(r=>{if(!r.ok)throw Error('test login')})`);
    await page(); await set('凭据选择','env'); await set('接口 Base URL', customBase);
    assert.ok(await js("field('新地址 API 密钥')?.type==='password' && btn('预览变更 Diff').disabled"));
    await set('凭据选择','new'); await set('API 密钥', secret); await js("document.querySelector('[aria-label=\"显示API 密钥\"]').click()");
    assert.ok(await js(`field('API 密钥').type==='text' && field('API 密钥').value===${JSON.stringify(secret)}`));
    await js("document.querySelector('[aria-label=\"隐藏API 密钥\"]').click()"); await leaks();
    await click('PhuketAI 分组'); await wait("!!field('分组密钥')?.querySelector('option[value=\"key:18\"]')", 'group keys');
    assert.equal(await js("field('默认子代理模型').value"),'gemini-2.5-pro'); assert.ok(!await js("field('分组密钥').querySelector('option[value=\"key:19\"]')!==null"));
    await set('分组密钥','key:18'); await set('默认子代理模型','my-custom:8b'); await click('DeepSeek');
    assert.ok(await js(`field('接口 Base URL').value===${JSON.stringify(customBase)} && field('接口协议').value==='openai-chat' && field('默认子代理模型').value==='my-custom:8b' && field('新地址 API 密钥').value===''`));
    await set('新地址 API 密钥', secret); await js("document.querySelector('[aria-label=\"显示新地址 API 密钥\"]').click()");
    assert.equal(await js("field('新地址 API 密钥').type"), 'text'); await js("document.querySelector('[aria-label=\"隐藏新地址 API 密钥\"]').click()");
    await probe(); await click('勾选已检测'); await click('1M');
    const context = '上下文上限（词元）';
    assert.equal(await js(`field(${JSON.stringify(context)}).value`), '1000000');
    assert.ok(await js("!btn('预览变更 Diff').disabled && document.querySelector('.subagent-compaction').textContent.includes('880,000')"));
    await set(context,'1000001');
    assert.ok(await js("btn('预览变更 Diff').disabled && document.querySelector('.subagent-footer-state').textContent.includes('1,000,000')"));
    await click('128K');
    await click('75%'); await set('分块保留最近交互组','0');
    await js("document.querySelector('[role=switch][aria-label=允许模型自主分块压缩]').click()");
    assert.ok(await js("document.querySelector('.subagent-compaction').textContent.includes('96,000')"));
    await js("document.querySelector('.subagent-fields summary').click()"); await set('密钥存储方式','mcp-env'); await set('默认执行模式','readonly');
    await js("document.querySelector('[aria-label=刷新子代理状态]').click()"); await wait("!document.querySelector('[aria-label=刷新子代理状态]').disabled", 'refresh'); assert.equal(await js("field('默认子代理模型').value"),'my-custom:8b');
    await click('全选'); assert.equal(await js("document.querySelectorAll('.subagent-harness input:checked').length"),9); await click('清空'); await click('勾选已检测'); await js("document.querySelector('input[aria-label=\"选择 Codex\"]').click()");
    await set('自动兜底触发阈值（%）','96'); assert.ok(await js("btn('预览变更 Diff').disabled && document.querySelector('.subagent-footer-state').textContent.includes('40 至 95')"));
    await click('75%'); await set('分块保留最近交互组','21'); assert.ok(await js("btn('预览变更 Diff').disabled && document.querySelector('.subagent-footer-state').textContent.includes('0 至 20')"));
    await set('分块保留最近交互组','0');
    await click('预览变更 Diff'); await wait("!!document.querySelector('dialog[open] .diff-grid')", 'diff dialog'); await leaks();
    await js("document.querySelector('.modal-body').scrollTop=120");
    assert.ok(await js(`(() => { const body=document.querySelector('.modal-body'), foot=body.querySelector('.subagent-modal-foot'), a=body.getBoundingClientRect(), b=foot.getBoundingClientRect();
      return body.scrollTop>0 && Math.abs(a.bottom-b.bottom)<=1 && Math.abs(a.left-b.left)<=1 && Math.abs(body.clientWidth-b.width)<=1 && getComputedStyle(foot).zIndex==='3' && getComputedStyle(foot).backgroundColor!=='rgba(0, 0, 0, 0)'; })()`), 'sticky diff footer seals the scrollport');
    await click('确认并写入'); await wait("!document.querySelector('dialog[open]') && document.querySelectorAll('.subagent-harness .badge.good').length === 2", 'applied snapshot');
    assert.ok(await js("document.querySelector('.subagent-metrics').textContent.includes('仅自动压缩 · 75%') && field('分块保留最近交互组').value==='0'"));
    await js("document.querySelector('[aria-label=\"Codex 配置片段\"]').click()"); await wait("!!document.querySelector('.subagent-snippet')", 'snippet dialog'); await leaks();
    await js("document.querySelector('[aria-label=\"复制MCP 配置\"]').click()"); assert.ok(await js(`window.copied.includes('[REDACTED]') && !window.copied.includes(${JSON.stringify(secret)})`));
    await js("document.querySelector('[aria-label=\"复制分工规则\"]').click()"); assert.ok(await js("window.copied.includes('astra_run_task')")); await js("document.querySelector('dialog button[aria-label=关闭]').click()");
    assert.equal(await js("field('凭据选择').value"), 'saved');
    await set('凭据选择','new'); assert.ok(await js("field('API 密钥').value==='' && field('API 密钥').type==='password'")); await set('凭据选择','saved');
    await click('OpenRouter'); assert.equal(await js("field('新地址 API 密钥')?.value"), '');
    await set('密钥存储方式','user-env'); await js("document.querySelector('input[aria-label=\"选择 Codex\"]').click()");
    await set('新地址 API 密钥', 'new-origin-only'); await click('改用独立 MCP 密钥存储（mcp-env）');
    assert.ok(await js("field('密钥存储方式').value==='mcp-env' && field('新地址 API 密钥').value==='new-origin-only'"));
    await set('默认子代理模型','new-model'); await wait("document.querySelector('.subagent-harness .badge.amber')?.textContent.includes('my-custom:8b')", 'drift badge');
    for (const [width,theme] of [[920,'light'],[440,'dark']]) {
      w.setContentSize(width,700); await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await delay(100);
      assert.ok(await js("document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth+1"), 'layout overflow at '+width);
    }
    await js("document.querySelector('[aria-label=\"移除 Cursor\"]').click()"); await wait("!!btn('确认移除')", 'confirm remove'); await click('取消'); assert.equal(await js("document.querySelectorAll('.subagent-harness .badge.good').length"), 2);
    await js("document.querySelector('input[aria-label=\"选择 Windsurf\"]').click()");
    await js("document.querySelector('[aria-label=\"移除 Cursor\"]').click()"); await click('确认移除'); await wait("document.querySelectorAll('.subagent-harness .badge.good').length===1", 'single removal');
    assert.deepEqual(await js("[...document.querySelectorAll('.subagent-harness input:checked')].map(el=>el.ariaLabel)"), ['选择 Windsurf']);
    assert.ok(await js("field('默认子代理模型').value==='new-model' && field('接口 Base URL').value==='https://openrouter.ai/api/v1' && field('接口协议').value==='openai-chat' && field('新地址 API 密钥').value==='new-origin-only'"));
    await click('移除全部已部署'); await click('确认移除'); await wait("document.querySelectorAll('.subagent-harness .badge.good').length===0", 'all removed');
    await usagePage();
    await js("document.querySelector('.sidebar a[href=\"/proxy\"]').click()");
    await wait("document.querySelector('.direct-shortcut .badge')?.textContent==='未启用'", 'direct shortcut');
    await click('详细设置');
    await wait("location.hash==='#preferences' && field('物理网卡')?.value==='Fixture Ethernet'", 'offline adapter');
    assert.ok(await js("field('物理网卡').selectedOptions[0].textContent.includes('未检测到')"));
    const dnsField = 'DNS 服务器（可选）';
    await set(dnsField, 'invalid.invalid'); await click('保存网卡与 DNS');
    await wait("document.querySelector('.toast-stack').textContent.includes('DNS 服务器必须是 IPv4 或 IPv6 地址')", 'DNS validation');
    await set(dnsField, ' 192.0.2.53,  2001:db8::53 ');
    await js("document.querySelector('[aria-label=\"同步用于子代理（Astra MCP）\"]').click()");
    await wait("document.querySelector('[aria-label=\"同步用于子代理（Astra MCP）\"]').getAttribute('aria-checked')==='false'", 'subagent sync preference');
    await click('刷新网卡'); await wait("!btn('刷新网卡').disabled", 'adapter refresh');
    assert.equal(await js(`field(${JSON.stringify(dnsField)}).value`), ' 192.0.2.53,  2001:db8::53 ');
    await click('保存网卡与 DNS'); await wait(`field(${JSON.stringify(dnsField)}).value==='192.0.2.53, 2001:db8::53'`, 'DNS save');
    for (const [width,theme] of [[920,'light'],[440,'dark']]) {
      w.setContentSize(width,700); await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await delay(100);
      assert.ok(await js("[...document.querySelectorAll('.direct-bypass, .direct-bypass .setting-row')].every(el=>el.scrollWidth<=el.clientWidth+1)"), 'direct panel overflow at '+width);
    }
    await click('仅跳过系统代理'); await wait("btn('仅跳过系统代理').getAttribute('aria-pressed')==='true'", 'skip-proxy mode');
    await js("document.querySelector('[aria-label=启用绕过代理直连]').click()");
    await wait("document.querySelector('.direct-bypass .badge')?.textContent==='绕过系统代理'", 'enabled direct badge');
    await set('测试地址（可选）', ' '+origin+'/api/health '); await click('测试直连');
    await wait("document.querySelector('.direct-bypass').textContent.includes('HTTP 200 · ') && document.querySelector('.direct-bypass').textContent.includes('未使用直连')", 'loopback probe result');
    await js("document.querySelector('.sidebar a[href=\"/proxy\"]').click()");
    await wait("document.querySelector('.direct-shortcut .badge')?.textContent==='绕过系统代理'", 'shortcut reflects enabled mode');
    await js("document.querySelector('.direct-shortcut [role=switch]').click()");
    await wait("document.querySelector('.direct-shortcut .badge')?.textContent==='未启用'", 'quick disable');
    await downloadPage();
    await js("document.querySelector('.sidebar a[href=\"/\"]').click()");
    await wait("!!document.querySelector('.provider button[aria-label=编辑]')", 'fixture provider');
    await js("document.querySelector('.provider button[aria-label=编辑]').click()");
    const providerUrl = url => js(`setValue(document.querySelector('dialog input[type=url]'),${JSON.stringify(url)})`);
    await providerUrl('https://CATALOG.invalid:443/other'); assert.ok(await js("!field('API 密钥').required"));
    await providerUrl('https://changed.invalid/v1'); await click('保存配置');
    assert.ok(await js("field('API 密钥').validity.valueMissing && document.querySelector('dialog').textContent.includes('不能保留当前密钥')"));
    await set('API 密钥','for-changed-origin'); await providerUrl('https://another.invalid/v1');
    assert.ok(await js("field('API 密钥').validity.valueMissing")); await click('取消');
    await click('跨协议路由'); await wait("btn('一键填充全部跨协议路由')?.disabled===false", 'route population available');
    await click('一键填充全部跨协议路由'); await wait("!!document.querySelector('.route-table tbody tr')", 'populate routes without Codex takeover');
    await geminiGroupFlows();
    await w.loadURL(origin+'/extensions#backups'); await wait("document.querySelector('.backup-list')?.textContent.includes('部署子代理插件与配置') && document.querySelector('.backup-list')?.textContent.includes('移除子代理配置')", 'backups');
    assert.ok(await js("['部署 AI 直连下载脚本与规则','移除 AI 直连下载规则'].every(s=>document.querySelector('.backup-list').textContent.includes(s)) && [...document.querySelectorAll('.backup-list .badge')].filter(b=>b.textContent==='AI 直连下载').length===3"));
    assert.deepEqual(errors, [], 'renderer console and page errors');
    console.log('Renderer passed: all three usage tabs, account periods and refresh, proxy cache reporting, Astra sessions and workers, 1M context validation, no renderer errors; native group defaults, Gemini group Claude forms and key imports, provider and subagent origin-key guards, configured proxy preset, read-only discovery, redacted diff/apply, MCP handshake, chunk policy, draft-preserving removal, shared bypass settings, downloader apply/probe/selected and all removal, backups, route population without takeover, light/dark widths.');
  } finally { w.destroy(); }
}
if (process.versions.electron) { const electron = await import('electron'); renderer(electron).then(() => electron.app.exit(0), e => { console.error(e); electron.app.exit(1); }); }
else await host();
