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
async function host() {
  const scratch = path.join(root, '.desktop'); fs.mkdirSync(scratch, { recursive: true });
  const temp = fs.mkdtempSync(path.join(scratch, 'subagent-ui-')), home = path.join(temp, 'user');
  Object.assign(process.env, { PHUKET_SWITCH_USER_HOME: home, PHUKET_SWITCH_HOME: path.join(temp, 'db'), TMP: temp, TEMP: temp, ASTRA_API_KEY: 'fixture-env-token' });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  const { createRuntime, createManagementApp } = await import('../dist/server/app.js');
  const group = { id: 124, name: '测试 Gemini 分组', platform: 'gemini', status: 'active', models: [{ name: 'gemini-2.5-pro' }, { name: 'gemini-other' }] };
  const exampleKey = { id: 18, name: '测试密钥', key: 'fixture-group-credential', status: 'active', group_id: 124 };
  const runtime = createRuntime({ directBypass: { systemRoute: true }, fetch: async (u, init) => {
    const url = new URL(String(u)); let value = {};
    if (url.hostname === 'catalog.invalid') { assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-provider-credential'); return Response.json({ data: [] }); }
    if (url.href === customBase + '/models') { assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`); return Response.json({ data: [] }); }
    assert.equal(url.origin, 'https://ai.pukitcore.com');
    if (url.pathname.endsWith('/model-plaza') || url.pathname.endsWith('/groups/available')) value = [group];
    if (url.pathname.endsWith('/keys')) value = { items: [exampleKey, { ...exampleKey, id: 19, status: 'inactive' }], total: 2 };
    if (url.pathname.endsWith('/auth/me')) value = { id: 221, email: 'desktop@example.invalid' };
    return Response.json({ data: value });
  } });
  runtime.db.createProvider({ name: '测试供应商', appType: 'codex', protocol: 'openai-responses', baseUrl: 'https://catalog.invalid/v1', apiKey: 'fixture-provider-credential', model: 'provider-model', availableModels: ['provider-other'] });
  const server = http.createServer(createManagementApp(undefined, runtime));
  const requests = {}, tests = [];
  server.prependListener('request', req => { const route = req.url; if (!['/api/subagent/apply','/api/subagent/preview-diff','/api/subagent/test'].includes(route)) return;
    let body = ''; req.on('data', b => body += b); req.on('end', () => { const data = JSON.parse(body); if (route === '/api/subagent/test') tests.push(data); else requests[route] = data; }); });
  let child;
  try {
    await runtime.directBypass.updateConfig({ interfaceName: 'Fixture Ethernet' }); // Saved adapter is offline in this fixture.
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const env = { ...process.env, PHUKET_UI_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}` }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(createRequire(import.meta.url)('electron'), [`--user-data-dir=${path.join(temp, 'chromium')}`, '--no-proxy-server', '--disable-background-networking', import.meta.filename], { env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => child.kill(), 70000); try { assert.equal((await once(child, 'exit'))[0], 0); } finally { clearTimeout(timer); }
    assert.deepEqual(requests['/api/subagent/apply'], requests['/api/subagent/preview-diff']);
    assert.equal(requests['/api/subagent/apply'].enableChunkCompaction, false);
    assert.equal(requests['/api/subagent/apply'].compactTriggerPct, 75); assert.equal(requests['/api/subagent/apply'].compactKeepRecentGroups, 0);
    const applied = requests['/api/subagent/apply'], customTests = tests.filter(t => t.baseUrl === customBase);
    assert.equal(applied.apiKey, secret); assert.equal(applied.model, 'my-custom:8b'); assert.equal(applied.baseUrl, customBase);
    assert.deepEqual(customTests.map(t => t.testUpstream), [false, true, true]);
    assert.ok(!Object.hasOwn(customTests[0], 'apiKey')); assert.ok(customTests.slice(1).every(t => t.apiKey === secret));
    for (const r of [applied, ...customTests]) for (const field of ['providerId','groupId','phuketKeyId','autoCreatePhuketKey','keepExistingKey']) assert.ok(!Object.hasOwn(r, field));
    assert.equal(runtime.db.state('subagent').keySource, 'manual');
    assert.deepEqual(runtime.db.state('directBypass'), { enabled: false, mode: 'skip-proxy', interfaceName: 'Fixture Ethernet',
      dnsServers: ['192.0.2.53', '2001:db8::53'], applyToSubagent: false });
  } finally {
    if (child && child.exitCode === null && !child.killed) child.kill();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}
async function renderer({ app, BrowserWindow, session }) {
  const origin = process.env.PHUKET_UI_TEST_ORIGIN; assert.ok(origin && process.env.PHUKET_SWITCH_USER_HOME);
  await app.whenReady(); session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(origin + '/') }));
  const w = new BrowserWindow({ show: false, width: 1060, height: 820, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const js = code => w.webContents.executeJavaScript(code), wait = async (code, what) => { for (let i=0;i<240;i++) { if (await js(code)) return; await delay(40); } throw Error('UI timeout: ' + what); };
  async function page() {
    await w.loadURL(origin + '/subagent'); await wait("document.querySelectorAll('.subagent-harness').length === 9", 'nine targets');
    await js(`window.btn = (s, parent=document) => [...parent.querySelectorAll('button')].find(x=>x.textContent.trim()===s);
      window.field = name => [...document.querySelectorAll('.field')].find(l=>l.querySelector('span')?.textContent===name)?.querySelector('input,select,textarea');
      window.setField = (name,v) => { const el=field(name); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,v);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); };
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async s=>{window.copied=s}}});void 0`);
  }
  const click = name => js(`btn(${JSON.stringify(name)}).click()`), set = (name,v) => js(`setField(${JSON.stringify(name)},${JSON.stringify(v)})`);
  const leaks = async () => { assert.ok(!await js(`[document.documentElement.outerHTML, JSON.stringify(localStorage), JSON.stringify(sessionStorage)].some(s => s.includes(${JSON.stringify(secret)}))`)); };
  const probe = async () => {
    await js("document.querySelector('.subagent-test-actions input').click()"); await click('验证子代理');
    await wait("document.querySelector('.subagent-result')?.textContent.includes('模型列表可访问')", 'model discovery');
  };
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
    await set('并行连接数（1–16）','17'); assert.ok(await js("btn('预览变更').disabled"));
    await set('并行连接数（1–16）','6'); await click('预览变更');
    await wait("document.querySelector('dialog[open] .diff-grid') && document.querySelector('.download-diff').textContent.includes('direct_download.py')", 'download file diffs');
    assert.equal(await js("fetch('/api/direct-download').then(r=>r.json()).then(s=>s.scriptInstalled)"), false);
    await click('确认并写入'); await wait("!document.querySelector('dialog[open]') && document.querySelector('.direct-download').textContent.includes('已部署脚本') && !btn('移除规则与脚本').disabled", 'deployed downloader');
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
    await click('移除规则与脚本'); await wait("!!btn('确认移除')", 'download removal confirmation'); await click('确认移除');
    await wait("!document.querySelector('dialog[open]') && document.querySelector('.direct-download .badge')?.textContent==='未部署' && btn('移除规则与脚本').disabled", 'download rules and scripts removed');
    assert.deepEqual(await js('window.downloadErrors'), []);
  }
  try {
    await page(); assert.deepEqual(await js(`[...document.querySelectorAll('.sidebar nav a')].slice(-3).map(x=>x.pathname)`), ['/lab','/subagent','/extensions']);
    await click('验证子代理'); await wait("document.querySelector('.subagent-result')?.textContent.includes('astra_wait_worker')", 'handshake');
    assert.ok(await js("document.querySelector('.subagent-result').textContent.includes('1.4.0')"));
    assert.ok(await js("document.querySelector('.subagent-metrics').textContent.includes('已开启 · 88% 兜底') && document.querySelector('.subagent-compaction').textContent.includes('239,360')"));
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
    await probe(); await click('128K');
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
    await js("document.querySelector('[aria-label=\"移除 Cursor\"]').click()"); await click('确认移除'); await wait("document.querySelectorAll('.subagent-harness .badge.good').length===1", 'single removal');
    await click('移除全部已部署'); await click('确认移除'); await wait("document.querySelectorAll('.subagent-harness .badge.good').length===0", 'all removed');
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
    await w.loadURL(origin+'/extensions#backups'); await wait("document.querySelector('.backup-list')?.textContent.includes('部署子代理插件与配置') && document.querySelector('.backup-list')?.textContent.includes('移除子代理配置')", 'backups');
    assert.ok(await js("['部署 AI 直连下载脚本与规则','移除 AI 直连下载规则'].every(s=>document.querySelector('.backup-list').textContent.includes(s)) && [...document.querySelectorAll('.backup-list .badge')].filter(b=>b.textContent==='AI 直连下载').length===2"));
    console.log('Renderer passed: inline origin keys, presets, endpoint preview, read-only discovery, redacted diff/apply, independent MCP storage, navigation, provider/group/manual sources, custom model, MCP handshake, chunk policy, refresh, selection, safe copies, removal, backups, direct download API/tab/diff/apply/loopback probe/removal, light/dark widths.');
  } finally { w.destroy(); }
}
if (process.versions.electron) { const electron = await import('electron'); renderer(electron).then(() => electron.app.exit(0), e => { console.error(e); electron.app.exit(1); }); }
else await host();
