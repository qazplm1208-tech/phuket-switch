import pkg from 'electron-updater';
import semver from 'semver';

// Invalid versions are not update candidates. Never coerce an arbitrary Git tag into a version.
export function compareSemver(a, b) {
  return semver.valid(a) && semver.valid(b) ? semver.compare(a, b) : 0;
}

export function normalizeReleaseNotes(raw) {
  if (Array.isArray(raw)) return raw.map(entry => {
    const note = normalizeReleaseNotes(entry?.note);
    return note && [semver.valid(entry?.version), note].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n').slice(0, 16000);
  if (typeof raw !== 'string') return '';
  // GitHub's Atom feed can contain HTML; the renderer always displays plain text.
  return raw.replace(/\r\n?/g, '\n').replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<br\s*\/?>|<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 16000);
}

function releaseLink(raw, prefix) {
  const url = typeof raw === 'string' && URL.parse(raw);
  return url && !url.username && !url.password && !url.search && !url.hash && url.href.startsWith(prefix) ? url.href : undefined;
}

export function parseGithubRelease(payload, currentVersion, repoUrl, mode = 'portable') {
  const version = semver.valid(payload?.tag_name);
  if (!version || payload.draft || payload.prerelease || semver.prerelease(version) || compareSemver(version, currentVersion) <= 0) {
    return { status: 'not-available' };
  }
  const releases = `${repoUrl}/releases`;
  const assets = (Array.isArray(payload.assets) ? payload.assets : []).filter(asset => typeof asset?.name === 'string' && /\.exe$/i.test(asset.name)
    && releaseLink(asset.browser_download_url, `${releases}/download/`));
  const asset = assets.find(({ name }) => /\bsetup\b/i.test(name) === (mode === 'nsis')) ?? assets[0];
  return { status: 'available', latestVersion: version, releaseName: typeof payload.name === 'string' && payload.name.trim() || `v${version}`,
    releaseNotes: normalizeReleaseNotes(payload.body), releaseDate: payload.published_at || undefined,
    releaseUrl: releaseLink(payload.html_url, `${releases}/tag/`) ?? `${releases}/tag/${encodeURIComponent(payload.tag_name)}`,
    downloadUrl: asset?.browser_download_url };
}

const messages = {
  check: '无法检查更新。请检查网络或代理设置，稍后重试。',
  download: '下载或校验更新失败。请重新检查更新，或前往 GitHub Releases 下载。',
  install: '无法启动安装程序。请退出应用并从 GitHub Releases 下载安装包。',
};
const timestamp = () => new Date().toISOString();
const positive = n => Number.isFinite(n) && n > 0 ? n : 0;

export function createUpdater({ app, net, request, notify, prepareQuit, showInstallError, currentVersion, owner, repo, nativeUpdater }) {
  const mode = !app.isPackaged ? 'dev' : process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis';
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const initial = { mode, currentVersion, status: 'idle' };
  let state = initial, checking = false, quiet = false, installing = false, installErrorReported = false, timer;
  // Access the CJS getter only in installed builds: it constructs a native updater immediately.
  const { autoUpdater } = mode === 'nsis' ? (nativeUpdater ? { autoUpdater: nativeUpdater } : pkg) : {};
  function publish(next) { state = { ...initial, ...next }; notify('updater:state', state); return state; }
  function fail(operation) {
    if (operation === 'check' && quiet) return publish(initial);
    return publish({ status: 'error', error: messages[operation], checkedAt: timestamp() });
  }
  function nativeRelease(info) {
    const version = semver.valid(info?.version);
    return { latestVersion: version, releaseName: info.releaseName || `v${version}`,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes), releaseDate: info.releaseDate,
      releaseUrl: `${repoUrl}/releases/tag/v${version}`, checkedAt: timestamp() };
  }
  function installFailed() {
    if (installErrorReported) return;
    installErrorReported = true;
    // Cleanup already removed the tray and backend. Don't leave a hidden, unusable app.
    autoUpdater.autoInstallOnAppQuit = false;
    try { fail('install'); } finally {
      try { showInstallError(messages.install); } finally { app.quit(); }
    }
  }
  if (autoUpdater) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => publish({ status: 'checking' }));
    autoUpdater.on('update-available', info => publish({ ...nativeRelease(info), status: 'available' }));
    autoUpdater.on('update-not-available', () => publish({ status: 'not-available', checkedAt: timestamp() }));
    autoUpdater.on('download-progress', p => publish({ ...state, status: 'downloading', progress: {
      percent: Math.min(100, Math.round(positive(p.percent))), transferred: positive(p.transferred), total: positive(p.total), bytesPerSecond: positive(p.bytesPerSecond),
    } }));
    autoUpdater.on('update-downloaded', info => publish({ ...nativeRelease(info), status: 'downloaded' }));
    autoUpdater.on('error', () => installing ? installFailed() : fail(checking ? 'check' : 'download'));
  }

  async function check({ silent = false } = {}) {
    if (checking) { if (!silent) quiet = false; return state; }
    if (['downloading', 'downloaded'].includes(state.status) || installing) return state;
    checking = true; quiet = silent;
    try {
      if (autoUpdater) {
        await autoUpdater.checkForUpdates(); // The native events own the result, including the checked version.
      } else {
        publish({ status: 'checking' });
        const response = await net.fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': `PhuketSwitch/${currentVersion}` },
          credentials: 'omit', signal: AbortSignal.timeout(15000),
        });
        if (!response.ok && response.status !== 404) throw new Error();
        const release = parseGithubRelease(response.status === 404 ? null : await response.json(), currentVersion, repoUrl, mode);
        publish({ ...release, checkedAt: timestamp() });
      }
    } catch { fail('check'); } finally { quiet = false; checking = false; }
    return state;
  }
  async function download() {
    if (!autoUpdater || state.status !== 'available') throw new Error('当前没有可自动下载的更新。');
    publish({ ...state, status: 'downloading' });
    try { await autoUpdater.downloadUpdate(); } catch { fail('download'); }
    return state;
  }
  async function install() {
    if (!autoUpdater || state.status !== 'downloaded' || installing) throw new Error('请先完成更新下载。');
    installing = true;
    // Native errors may arrive after quitAndInstall returns. Keep the install phase until exit.
    try { await prepareQuit(); await autoUpdater.quitAndInstall(false, true); }
    catch { installFailed(); }
    return state;
  }
  function cancelStartupCheck() { clearTimeout(timer); timer = undefined; }
  function scheduleStartupCheck() {
    cancelStartupCheck();
    timer = setTimeout(async () => {
      try {
        const settings = await request('/settings');
        if (timer && state.status === 'idle' && settings.autoCheckUpdates !== false) await check({ silent: true });
      } catch { /* Settings unavailable: don't make a network request without the preference. */ }
    }, 8000);
    timer.unref?.();
  }
  return { getState: () => state, check, download, install, scheduleStartupCheck, cancelStartupCheck };
}
