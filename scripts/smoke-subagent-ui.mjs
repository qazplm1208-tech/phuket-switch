// Run with system Node after npm run build. Real renderer, API and Python; fixture-only providers and homes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..'), secret = 'opaque-ui-only-credential-93';
async function host() {
  const scratch = path.join(root, '.desktop'); fs.mkdirSync(scratch, { recursive: true });
  const temp = fs.mkdtempSync(path.join(scratch, 'subagent-ui-')), home = path.join(temp, 'user');
  Object.assign(process.env, { PHUKET_SWITCH_USER_HOME: home, PHUKET_SWITCH_HOME: path.join(temp, 'db'), TMP: temp, TEMP: temp, ASTRA_API_KEY: 'fixture-env-token' });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  const { createRuntime, createManagementApp } = await import('../dist/server/app.js');
  const group = { id: 124, name: '测试 Gemini 分组', platform: 'gemini', status: 'active', models: [{ name: 'gemini-2.5-pro' }, { name: 'gemini-other' }] };
  const exampleKey = { id: 18, name: '测试密钥', key: 'fixture-group-credential', status: 'active', group_id: 124 };
  const runtime = createRuntime({ fetch: async (u, init) => {
    const url = new URL(String(u)); let value = {};
    if (url.hostname === 'catalog.invalid') { assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-provider-credential'); return Response.json({ data: [] }); }
    assert.equal(url.origin, 'https://ai.pukitcore.com');
    if (url.pathname.endsWith('/model-plaza') || url.pathname.endsWith('/groups/available')) value = [group];
    if (url.pathname.endsWith('/keys')) value = { items: [exampleKey, { ...exampleKey, id: 19, status: 'inactive' }], total: 2 };
    if (url.pathname.endsWith('/auth/me')) value = { id: 221, email: 'desktop@example.invalid' };
    return Response.json({ data: value });
  } });
  runtime.db.createProvider({ name: '测试供应商', appType: 'codex', protocol: 'openai-responses', baseUrl: 'https://catalog.invalid/v1', apiKey: 'fixture-provider-credential', model: 'provider-model', availableModels: ['provider-other'] });
  const server = http.createServer(createManagementApp(undefined, runtime));
  const requests = {};
  server.prependListener('request', (req) => { const route = req.url; if (!['/api/subagent/apply','/api/subagent/preview-diff'].includes(route)) return;
    let body = ''; req.on('data', b => body += b); req.on('end', () => { requests[route] = JSON.parse(body); }); });
  let child;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const env = { ...process.env, PHUKET_UI_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}` }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(createRequire(import.meta.url)('electron'), [`--user-data-dir=${path.join(temp, 'chromium')}`, '--no-proxy-server', '--disable-background-networking', import.meta.filename], { env, stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => child.kill(), 70000); try { assert.equal((await once(child, 'exit'))[0], 0); } finally { clearTimeout(timer); }
    assert.deepEqual(requests['/api/subagent/apply'], requests['/api/subagent/preview-diff']);
    assert.equal(requests['/api/subagent/apply'].enableChunkCompaction, false);
    assert.equal(requests['/api/subagent/apply'].compactTriggerPct, 75); assert.equal(requests['/api/subagent/apply'].compactKeepRecentGroups, 0);
    assert.equal(requests['/api/subagent/apply'].apiKey, secret); assert.equal(requests['/api/subagent/apply'].model, 'my-custom:8b');
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
  const leaks = async () => { assert.ok(!await js(`document.documentElement.outerHTML.includes(${JSON.stringify(secret)})`)); };
  try {
    await page(); assert.deepEqual(await js(`[...document.querySelectorAll('.sidebar nav a')].slice(-3).map(x=>x.pathname)`), ['/lab','/subagent','/extensions']);
    await click('验证子代理'); await wait("document.querySelector('.subagent-result')?.textContent.includes('astra_wait_worker')", 'handshake');
    assert.ok(await js("document.querySelector('.subagent-result').textContent.includes('1.4.0')"));
    assert.ok(await js("document.querySelector('.subagent-metrics').textContent.includes('已开启 · 88% 兜底') && document.querySelector('.subagent-compaction').textContent.includes('239,360')"));
    await click('已有供应商'); await wait("field('默认子代理模型').value==='provider-model'", 'provider defaults'); await click('provider-other');
    await js("document.querySelector('.subagent-test-actions input').click()"); await click('验证子代理'); await wait("document.querySelector('.subagent-result')?.textContent.includes('模型列表可访问')", 'model discovery');
    await click('PhuketAI 分组'); await wait("!!btn('登录 PhuketAI')", 'guest login action'); await click('登录 PhuketAI'); await wait("!!document.querySelector('dialog[open]')", 'login dialog'); await js("document.querySelector('dialog[open] button[aria-label=关闭]').click()");
    await js(`fetch('/api/phuket/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'offline-guest-access'})}).then(r=>{if(!r.ok)throw Error('test login')})`);
    await page(); await click('PhuketAI 分组'); await wait("!!field('分组密钥')?.querySelector('option[value=\"key:18\"]')", 'group keys');
    assert.equal(await js("field('默认子代理模型').value"),'gemini-2.5-pro'); assert.ok(!await js("field('分组密钥').querySelector('option[value=\"key:19\"]')!==null"));
    await set('分组密钥','key:18'); await click('手动 / 环境变量'); await set('凭据选择','new'); await set('API 密钥', secret);
    await set('接口协议','openai-chat'); await set('接口 Base URL','http://127.0.0.1:15722'); await set('默认子代理模型','my-custom:8b'); await click('128K');
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
    await set('默认子代理模型','new-model'); await wait("document.querySelector('.subagent-harness .badge.amber')?.textContent.includes('my-custom:8b')", 'drift badge');
    for (const [width,theme] of [[920,'light'],[440,'dark']]) {
      w.setContentSize(width,700); await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await delay(100);
      assert.ok(await js("document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth+1"), 'layout overflow at '+width);
    }
    await js("document.querySelector('[aria-label=\"移除 Cursor\"]').click()"); await wait("!!btn('确认移除')", 'confirm remove'); await click('取消'); assert.equal(await js("document.querySelectorAll('.subagent-harness .badge.good').length"), 2);
    await js("document.querySelector('[aria-label=\"移除 Cursor\"]').click()"); await click('确认移除'); await wait("document.querySelectorAll('.subagent-harness .badge.good').length===1", 'single removal');
    await click('移除全部已部署'); await click('确认移除'); await wait("document.querySelectorAll('.subagent-harness .badge.good').length===0", 'all removed');
    await w.loadURL(origin+'/extensions#backups'); await wait("document.querySelector('.backup-list')?.textContent.includes('部署子代理插件与配置') && document.querySelector('.backup-list')?.textContent.includes('移除子代理配置')", 'backups');
    console.log('Renderer passed: navigation, guest/account and provider sources, custom model, 6-tool MCP 1.4.0 handshake, chunk policy controls, discovery, refresh, selection, diff/apply, safe copies, removal, backups, light/dark widths.');
  } finally { w.destroy(); }
}
if (process.versions.electron) { const electron = await import('electron'); renderer(electron).then(() => electron.app.exit(0), e => { console.error(e); electron.app.exit(1); }); }
else await host();
