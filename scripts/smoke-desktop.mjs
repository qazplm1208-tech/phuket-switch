// Run with system Node 24 after compiling dist/server/index.js. All mutable
// state, including the management/proxy ports and the Electron profile, is isolated.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { backendURL, request } from '../electron/backend.mjs';

const root = path.resolve(import.meta.dirname, '..');
const get = (route) => request('/' + route);
const healthy = () => get('health').then((r) => r.app === 'phuket-switch' && r.ok, () => false);
async function until(check, description, ms = 5000) {
  const deadline = Date.now() + ms;
  do { if (await check()) return; await delay(50); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
async function listen(server, port) {
  const ready = once(server, 'listening');
  server.listen(port, '127.0.0.1');
  await ready;
}

async function unusedPort() {
  const probe = http.createServer();
  await listen(probe, 0);
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function testLifecycle() {
  assert.ok(existsSync(path.join(root, 'dist/server/index.js')), 'Build the backend first');
  backendURL.port = String(await unusedPort());
  const desktopDir = path.join(root, '.desktop');
  mkdirSync(desktopDir, { recursive: true });
  const temp = mkdtempSync(path.join(desktopDir, 'smoke-'));
  const page = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Desktop smoke</title><p>Phuket Switch</p>');
  });
  const exe = createRequire(import.meta.url)('electron');
  let independent;
  try {
    await listen(page, 0);
    const env = { ...process.env, PHUKET_SWITCH_HOME: path.join(temp, 'db'), PHUKET_SWITCH_USER_HOME: temp,
      PHUKET_SWITCH_PORT: backendURL.port, PHUKET_DEV_URL: `http://127.0.0.1:${page.address().port}` };
    delete env.ELECTRON_RUN_AS_NODE;
    async function launch(mode) {
      const child = spawn(exe, [`--user-data-dir=${path.join(temp, mode)}`, import.meta.filename, mode], {
        cwd: root, env, stdio: 'inherit',
      });
      const deadline = setTimeout(() => child.kill(), 24000);
      try { assert.equal((await once(child, 'exit'))[0], 0, `${mode} window verification failed`); }
      finally { clearTimeout(deadline); }
    }
    await launch('owned');
    await until(async () => !(await healthy()), 'owned backend shutdown');
    console.log('Owned backend stopped on quit.');
    independent = spawn(process.execPath, ['--require', './electron/backend-lifetime.cjs', 'dist/server/index.js'], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    await until(healthy, 'independent backend startup');
    await launch('reused');
    assert.equal(independent.exitCode, null);
    assert.ok(await healthy());
    console.log('Pre-existing backend remained healthy after quit.');
  } finally {
    if (independent?.connected) { const closed = once(independent, 'close'); independent.disconnect(); await closed; }
    page.closeAllConnections();
    await new Promise((resolve) => page.close(resolve));
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

async function testWindow({ app, dialog, shell, Tray }) {
  assert.match(process.env.PHUKET_SWITCH_PORT ?? '', /^\d+$/, 'Use system Node to run this smoke test');
  backendURL.port = process.env.PHUKET_SWITCH_PORT;
  let tray;
  const setTip = Tray.prototype.setToolTip;
  Tray.prototype.setToolTip = function (tip) { tray = this; return setTip.call(this, tip); };
  dialog.showErrorBox = (_title, message) => { console.error(message); app.exit(1); };
  for (const event of ['before-quit', 'will-quit', 'quit']) app.on(event, () => console.log(`Smoke: ${event}`));
  const created = once(app, 'browser-window-created');
  await import('../electron/main.mjs');
  const [, win] = await created;
  await until(() => win.isVisible() && !win.webContents.isLoadingMainFrame(), 'first window paint');
  assert.equal(win.webContents.getURL(), `${process.env.PHUKET_DEV_URL}/`);
  const run = (code) => win.webContents.executeJavaScript(code);
  assert.ok(await run("phuketDesktop.isElectron && typeof require === 'undefined'"));
  assert.deepEqual(win.getMinimumSize(), [920, 620]);
  if (process.argv.includes('reused')) { void run('phuketDesktop.quit()').catch(() => {}); return; }

  assert.ok(existsSync(path.join(process.env.PHUKET_SWITCH_HOME, 'phuket-switch.db')), 'Expected disposable backend data');
  await run("window.maxEvents = []; window.off = phuketDesktop.onMaximizeChange((v) => maxEvents.push(v)); void 0");
  await run('phuketDesktop.toggleMaximize()');
  await until(() => run('phuketDesktop.isMaximized()'), 'maximize');
  await run('phuketDesktop.toggleMaximize()');
  await until(() => run('maxEvents.length === 2'), 'maximize and unmaximize events');
  assert.deepEqual(await run('off(); maxEvents'), [true, false]);
  await run("phuketDesktop.setTheme('dark')");
  assert.equal(win.getBackgroundColor().toLowerCase(), '#121316');
  await run("phuketDesktop.setTheme('light')");
  assert.equal(win.getBackgroundColor().toLowerCase(), '#f7f8fa');
  let external = null;
  shell.openExternal = async (href) => { external = href; }; // Do not launch a real browser.
  await assert.rejects(run("phuketDesktop.openExternal('file:///invalid')"), /HTTP\(S\)/);
  await run("phuketDesktop.openExternal('http://example.invalid/help')");
  assert.equal(external, 'http://example.invalid/help');
  await run("window.open('https://example.invalid/docs'); void 0");
  assert.equal(external, 'https://example.invalid/docs');
  await run('phuketDesktop.minimize()');
  await until(() => win.isMinimized(), 'minimize');
  tray.emit('click');
  await until(() => !win.isMinimized(), 'tray restore');
  await run('phuketDesktop.close()');
  assert.ok(!win.isVisible());
  const second = spawn(process.execPath, [`--user-data-dir=${app.getPath('userData')}`, '.'], { cwd: root, windowsHide: true });
  const deadline = setTimeout(() => second.kill(), 6000);
  try { assert.equal((await once(second, 'exit'))[0], 0); }
  finally { clearTimeout(deadline); }
  await until(() => win.isVisible(), 'second launch restored window');

  // Capture the native menu instead of moving the user's mouse in the notification area.
  const menu = () => new Promise((resolve) => { tray.popUpContextMenu = resolve; tray.emit('right-click'); });
  await run("window.topics = []; phuketDesktop.onTrayChange((topic) => topics.push(topic)); void 0");
  const before = await get('fast-mode');
  (await menu()).items[2].click();
  await until(() => run("topics.includes('fast-mode')"), 'tray Fast mode notification');
  assert.deepEqual(await get('fast-mode'), { ...before, enabled: !before.enabled });
  const after = await menu();
  assert.equal(after.items[2].checked, !before.enabled);
  assert.match(after.items[3].label, /15722.*已停止/);
  const { settings } = await get('proxy/status');
  const port = await unusedPort();
  await request('/proxy/settings', { method: 'PUT', body: { ...settings, port } });
  const stopped = await menu();
  assert.ok(stopped.items[3].label.includes(`:${port}`));
  stopped.items[3].click();
  await until(() => run("topics.includes('proxy')"), 'proxy started');
  const running = await menu();
  assert.match(running.items[3].label, /运行中/);
  running.items[3].click();
  await until(async () => !(await get('proxy/status')).running, 'proxy stopped');
  console.log('Preload, window controls, theme, external URL policy, second instance, tray toggles and notifications passed.');
  const leave = (await menu()).items.at(-1);
  console.log(`Selecting ${leave.label}`);
  leave.click();
}

if (process.versions.electron) {
  const electron = await import('electron');
  testWindow(electron).catch((error) => { console.error(error); electron.app.exit(1); });
} else {
  await testLifecycle();
}
