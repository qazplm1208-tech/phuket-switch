import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell } from 'electron';
import path from 'node:path';
import { backendURL, ensureBackend, parseResolvedProxy, request, stopOwnedBackend } from './backend.mjs';
import { createTray } from './tray.mjs';
import { createUpdater } from './updater.mjs';
import { createWebLogin } from './web-login.mjs';

const __dirname = import.meta.dirname;
const iconPath = path.join(__dirname, 'icon.png');
const webLogin = createWebLogin(BrowserWindow, iconPath);
let mainWindow = null, tray = null, uiOrigin, windowReady = false, isQuitting = false;
let updater, cleanup, cleanupComplete = false, quitAfterCleanup;

function prepareQuit() {
  if (!cleanup) {
    isQuitting = true;
    updater?.cancelStartupCheck();
    tray?.destroy(); tray = null;
    cleanup = Promise.allSettled([webLogin.cancel(), stopOwnedBackend()]).then(() => { cleanupComplete = true; });
  }
  return cleanup;
}

function webURL(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\\\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function quit() { isQuitting = true; app.quit(); }

function showWindow() {
  if (!windowReady || isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(channel, value) {
  const contents = mainWindow?.webContents;
  if (contents && !contents.isDestroyed() && webURL(contents.getURL())?.origin === uiOrigin) contents.send(channel, value);
}

function registerIPC() {
  function handle(channel, handler) {
    ipcMain.handle(channel, (event, ...args) => {
      const contents = mainWindow?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame ||
          webURL(event.senderFrame?.url)?.origin !== uiOrigin) throw new Error('Untrusted desktop IPC sender');
      return handler(mainWindow, ...args);
    });
  }
  handle('window:minimize', (win) => win.minimize());
  handle('window:toggleMaximize', (win) => {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  handle('window:close', (win) => win.close());
  handle('window:isMaximized', (win) => win.isMaximized());
  handle('window:setTheme', (win, theme) => win.setBackgroundColor(theme === 'dark' ? '#121316' : '#F7F8FA'));
  handle('app:openExternal', (_win, value) => {
    const url = webURL(value);
    if (!url) throw new Error('Only HTTP(S) URLs are allowed');
    return shell.openExternal(url.href);
  });
  handle('auth:webLogin', win => isQuitting ? { cancelled: true } : webLogin.open(win));
  handle('app:getVersion', () => app.getVersion());
  handle('updater:getState', () => updater.getState());
  handle('updater:check', () => updater.check());
  handle('updater:download', () => updater.download());
  handle('updater:install', () => updater.install());
  handle('app:quit', quit);
}

function createWindow() {
  const win = new BrowserWindow({
    title: 'Phuket Switch', width: 1140, height: 760, minWidth: 920, minHeight: 620,
    frame: false, backgroundColor: '#F7F8FA', show: false, autoHideMenuBar: true, icon: iconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow = win;
  win.once('ready-to-show', () => { windowReady = true; showWindow(); });
  win.on('maximize', () => notify('window:maximized', true));
  win.on('unmaximize', () => notify('window:maximized', false));
  win.on('close', (event) => { if (!isQuitting) { event.preventDefault(); win.hide(); } });
  win.once('closed', () => { mainWindow = null; windowReady = false; });
  const contents = win.webContents;
  for (const navigation of ['will-navigate', 'will-redirect']) {
    contents.on(navigation, (event) => { if (webURL(event.url)?.origin !== uiOrigin) event.preventDefault(); });
  }
  contents.setWindowOpenHandler(({ url }) => {
    const target = webURL(url);
    if (target?.protocol === 'https:') void shell.openExternal(target.href).catch(console.error);
    return { action: 'deny' };
  });
  return win;
}

app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>;localhost;127.0.0.1;[::1]');

async function resolvePhuketProxy() {
  let timer;
  try {
    const result = await Promise.race([session.defaultSession.resolveProxy('https://ai.pukitcore.com'),
      new Promise(resolve => { timer = setTimeout(resolve, 2000, 'DIRECT'); })]);
    return parseResolvedProxy(result);
  } catch { return undefined; } finally { clearTimeout(timer); }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.phuketcore.switch');
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', event => {
    if (!cleanupComplete) {
      event.preventDefault();
      quitAfterCleanup ??= prepareQuit().then(() => app.quit());
    }
  });
  app.whenReady().then(async () => {
    const ui = webURL(process.env.PHUKET_DEV_URL || backendURL.origin);
    if (!ui) throw new Error('PHUKET_DEV_URL must be an HTTP(S) URL.');
    uiOrigin = ui.origin;
    await ensureBackend(() => isQuitting, await resolvePhuketProxy());
    if (isQuitting) return;
    Menu.setApplicationMenu(null);
    updater = createUpdater({ app, net, request, notify, prepareQuit, currentVersion: app.getVersion(), owner: 'qazplm1208-tech', repo: 'phuket-switch' });
    registerIPC();
    const win = createWindow();
    tray = createTray({ iconPath, request, showWindow, quit, updater, notify: topic => notify('tray:changed', topic),
      openUpdates: () => {
        showWindow(); notify('tray:changed', 'updates');
        if (['idle', 'not-available', 'error'].includes(updater.getState().status)) void updater.check();
      } });
    await win.loadURL(ui.href);
    if (!isQuitting) updater.scheduleStartupCheck();
  }).catch((error) => {
    if (!isQuitting) { dialog.showErrorBox('Phuket Switch', error.message); quit(); }
  });
}
