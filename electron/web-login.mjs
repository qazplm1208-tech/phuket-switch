const origin = 'https://ai.pukitcore.com';
const loginUrl = `${origin}/login`;
const title = '网页登录 PhuketAI';

function httpsURL(value) {
  const target = typeof value === 'string' && URL.parse(value);
  return target && target.protocol === 'https:' && !target.username && !target.password ? target : null;
}

// The remote window gets no preload, renderer IPC, or pre-existing browser session.
export function createWebLogin(BrowserWindow, icon) {
  let active;
  function open(parent) {
    if (active) {
      if (!active.win.isDestroyed()) { if (active.win.isMinimized()) active.win.restore(); active.win.focus(); }
      return active.promise;
    }
    const win = new BrowserWindow({ parent, width: 540, height: 740, show: true, title, icon, autoHideMenuBar: true,
      webPreferences: { partition: 'phuket-web-login', contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
    });
    const wc = win.webContents, partition = wc.session;
    const { promise, resolve, reject } = Promise.withResolvers();
    let timer, reading = false, finishing = false, cancelled = false, generation = 0;
    const listeners = [];
    function listen(emitter, event, fn) { emitter.on(event, fn); listeners.push(() => emitter.removeListener(event, fn)); }
    function stopPolling() { clearInterval(timer); timer = undefined; }
    function finish(result, error) {
      if (result?.cancelled) cancelled = true;
      if (finishing) return promise;
      finishing = true; stopPolling();
      for (const remove of listeners) remove();
      if (!win.isDestroyed()) win.destroy(); // Stop page scripts before clearing the partition.
      void (async () => {
        try {
          await partition.clearStorageData();
          if (cancelled) resolve({ cancelled: true }); else if (error) reject(error); else resolve(result);
        } catch { if (cancelled) resolve({ cancelled: true }); else reject(new Error('无法清除网页登录会话，请重试。')); }
        finally { active = undefined; }
      })();
      return promise;
    }
    const cancel = () => finish({ cancelled: true });
    const official = () => !finishing && !wc.isDestroyed() && httpsURL(wc.getURL())?.origin === origin;
    async function checkToken() {
      if (reading || !official()) return;
      const document = generation;
      reading = true;
      try {
        // Check inside the document too: navigation can commit between getURL and script execution.
        const values = await wc.executeJavaScript(`location.origin === ${JSON.stringify(origin)} ? { token: localStorage.getItem('auth_token'), refresh: localStorage.getItem('refresh_token') } : null`);
        if (document !== generation || !official() || typeof values?.token !== 'string' || /[\r\n]/.test(values.token)) return;
        const token = values.token.trim();
        if (token.length < 20 || token.length > 16384 || /^sk-/i.test(token)) return;
        const refreshToken = typeof values.refresh === 'string' && !/[\r\n]/.test(values.refresh) ? values.refresh.trim() : '';
        finish({ token, ...(refreshToken && refreshToken.length <= 16384 && !/^sk-/i.test(refreshToken) ? { refreshToken } : {}) });
      } catch { /* Loading pages and disabled storage may not yet expose a session. */ }
      finally { reading = false; }
    }
    function onPage() {
      if (finishing || wc.isDestroyed()) return;
      const url = httpsURL(wc.getURL());
      if (url) win.setTitle(`${title} · ${url.host}`);
      if (!official()) { stopPolling(); return; }
      timer ??= setInterval(() => void checkToken(), 600);
      void checkToken();
    }
    const failed = () => finish(undefined, new Error('无法加载网页登录页面，请检查网络或代理设置后重试。'));
    function load(url) { void win.loadURL(url).catch(e => { if (e.code !== 'ERR_ABORTED' && !finishing) failed(); }); }
    active = { win, promise, cancel };
    listen(win, 'closed', cancel); listen(parent, 'closed', cancel);
    listen(wc, 'render-process-gone', failed);
    listen(win, 'page-title-updated', event => event.preventDefault());
    listen(wc, 'will-attach-webview', event => event.preventDefault());
    listen(partition, 'will-download', event => event.preventDefault());
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) listen(wc, event, e => { if (!httpsURL(e.url)) e.preventDefault(); });
    listen(wc, 'did-start-navigation', e => { if (e.isMainFrame) { generation++; stopPolling(); } });
    for (const event of ['did-finish-load', 'did-navigate', 'did-navigate-in-page']) listen(wc, event, onPage);
    listen(wc, 'did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) failed(); });
    wc.setWindowOpenHandler(({ url }) => {
      const target = httpsURL(url);
      if (target && !finishing) load(target.href);
      return { action: 'deny' };
    });
    void partition.clearStorageData().then(() => { if (!finishing) load(loginUrl); }, () => { if (!finishing) failed(); });
    return promise;
  }
  return { open, cancel: () => active?.cancel() };
}
