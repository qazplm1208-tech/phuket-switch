import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { APP_VERSION, GITHUB_REPO_OWNER as owner, GITHUB_REPO_NAME as repo, GITHUB_REPO_URL as repoUrl } from '../shared/constants.js';

const { compareSemver, normalizeReleaseNotes, parseGithubRelease, createUpdater } = await import(new URL('../electron/updater.mjs', import.meta.url).href);
const version = '1.0.0';
const asset = (name: string) => ({ name, browser_download_url: `${repoUrl}/releases/download/v1.0.1/${name}` });
const setup = asset('Phuket.Switch.Setup.1.0.1.exe'), portable = asset('Phuket.Switch.1.0.1.exe');
const release = { tag_name: 'v1.0.1', name: 'Maintenance', published_at: '2026-11-24T00:00:00Z', body: 'First\r\nSecond',
  html_url: `${repoUrl}/releases/tag/v1.0.1`, assets: [asset('latest.yml'), setup, portable] };
const opts = { owner, repo, currentVersion: version, app: { isPackaged: false }, request: async () => ({}),
  notify() {}, prepareQuit: async () => {}, net: { fetch: async () => Response.json(release) } };

test('stable release configuration agrees with the lockfile, updater feed and Windows identity', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, manifest.version); assert.equal(lock.packages[''].version, APP_VERSION);
  assert.equal(manifest.homepage, repoUrl); assert.equal(manifest.repository.url, repoUrl + '.git');
  assert.equal(manifest.build.appId, 'com.phuketcore.switch');
  assert.deepEqual(manifest.build.publish, [{ provider: 'github', owner, repo, releaseType: 'release' }]);
});

test('semver precedence handles v-prefix, numeric components, build metadata and prereleases', () => {
  assert.equal(compareSemver('v1.10.0', '1.2.3'), 1); assert.equal(compareSemver('v1.0.0+build.1', version), 0);
  assert.equal(compareSemver('1.0.0-rc.11', '1.0.0-rc.2'), 1); assert.equal(compareSemver('1.0.0-rc.1', version), -1);
  assert.equal(compareSemver('0.9.1', version), -1); assert.equal(compareSemver('other-tag', version), 0);
});

test('release notes normalize GitHub Markdown, Atom HTML and native changelog arrays to bounded text', () => {
  assert.equal(normalizeReleaseNotes(release.body), 'First\nSecond'); assert.equal(normalizeReleaseNotes(null), '');
  assert.equal(normalizeReleaseNotes([{ version: '1.0.2', note: '<ul><li>A &amp; B</li></ul>' }, { note: 'Fix' }, null]), '1.0.2\n• A & B\n\nFix');
  assert.ok(normalizeReleaseNotes('a'.repeat(50000)).length <= 16000);
});

test('GitHub release parsing ignores missing, old, equal, draft and prerelease tags', () => {
  for (const value of [null, {}, { tag_name: 'v0.9.9' }, { tag_name: 'v1.0.0' }, { ...release, prerelease: true }, { ...release, draft: true },
    { tag_name: 'v3.0.0-beta.1' }, { tag_name: 'release-latest' }]) assert.equal(parseGithubRelease(value, version, repoUrl).status, 'not-available');
  assert.deepEqual(parseGithubRelease(release, version, repoUrl), { status: 'available', latestVersion: '1.0.1', releaseName: 'Maintenance',
    releaseDate: release.published_at, releaseNotes: 'First\nSecond', releaseUrl: release.html_url, downloadUrl: portable.browser_download_url });
  assert.equal(parseGithubRelease({ ...release, assets: [portable, setup] }, version, repoUrl, 'nsis').downloadUrl, setup.browser_download_url);
  assert.equal(parseGithubRelease({ ...release, assets: [setup] }, version, repoUrl).downloadUrl, setup.browser_download_url);
  const unsafe = parseGithubRelease({ ...release, html_url: 'https://example.invalid/tag', assets: [{ ...portable, browser_download_url: 'file:///bad.exe' }] }, version, repoUrl);
  assert.equal(unsafe.downloadUrl, undefined); assert.equal(unsafe.releaseUrl, release.html_url);
});

test('manual portable and dev checks use public GitHub metadata, handle 404 and never install', async t => {
  const previous = process.env.PORTABLE_EXECUTABLE_DIR;
  process.env.PORTABLE_EXECUTABLE_DIR = 'fixture';
  t.after(() => { if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR; else process.env.PORTABLE_EXECUTABLE_DIR = previous; });
  for (const isPackaged of [true, false]) {
    let status = 200;
    const u = createUpdater({ ...opts, app: { isPackaged }, net: { fetch: async (url: string, init: RequestInit) => {
      assert.equal(url, `https://api.github.com/repos/${owner}/${repo}/releases/latest`);
      assert.deepEqual(init.headers, { Accept: 'application/vnd.github+json', 'User-Agent': 'PhuketSwitch/1.0.0' });
      assert.ok(init.signal); assert.equal(init.credentials, 'omit'); return Response.json(release, { status });
    } } });
    assert.equal(u.getState().mode, isPackaged ? 'portable' : 'dev');
    assert.equal((await u.check()).downloadUrl, portable.browser_download_url);
    await assert.rejects(u.install(), /先完成/); await assert.rejects(u.download(), /没有可自动下载/);
    status = 404; assert.equal((await u.check()).status, 'not-available'); assert.ok(u.getState().checkedAt);
    status = 403; assert.equal((await u.check()).status, 'error'); assert.equal((await u.check({ silent: true })).status, 'idle');
  }
});

test('startup waits 8 seconds, respects opt-out and settings failures, and stays idle on offline errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let auto = false, availableSettings = true, reads = 0, calls = 0; const statuses: string[] = [];
  const u = createUpdater({ ...opts, request: async (path: string) => { assert.equal(path, '/settings'); reads++; if (!availableSettings) throw Error(); return { autoCheckUpdates: auto }; },
    net: { fetch: async () => { calls++; throw Error('fixture-secret'); } }, notify: (channel: string, s: { status: string }) => { assert.equal(channel, 'updater:state'); statuses.push(s.status); } });
  u.scheduleStartupCheck(); t.mock.timers.tick(7999); assert.equal(reads, 0);
  t.mock.timers.tick(1); await nextTurn(); assert.equal(reads, 1); assert.equal(calls, 0);
  auto = true; availableSettings = false; u.scheduleStartupCheck(); t.mock.timers.tick(8000); await nextTurn(); assert.equal(calls, 0);
  availableSettings = true; u.scheduleStartupCheck(); t.mock.timers.tick(8000); await nextTurn();
  assert.equal(calls, 1); assert.deepEqual(statuses, ['checking', 'idle']); assert.equal(u.getState().error, undefined);
  u.scheduleStartupCheck(); u.cancelStartupCheck(); t.mock.timers.tick(8000); assert.equal(reads, 3);
});

test('packaged windows ignore PHUKET_DEV_URL; dev windows accept only local HTTP(S) origins', async () => {
  const { backendURL, selectUiURL } = await import(new URL('../electron/backend.mjs', import.meta.url).href);
  for (const value of ['https://remote.invalid', 'file:///local', 'http://localhost:5173', undefined]) assert.equal(selectUiURL(true, value).href, backendURL.href);
  assert.equal(selectUiURL(false, undefined).href, backendURL.href);
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:5173/ui', 'https://[::1]:3000/']) assert.equal(selectUiURL(false, url).href, url);
  for (const value of ['https://remote.invalid', 'http://localhost.example', 'http://user@localhost:80', 'file:///local', 'not a URL']) assert.throws(() => selectUiURL(false, value), /loopback/);
});

test('tray speed actions apply the freshly read Codex preset both during and outside takeover', async () => {
  const { createTray } = await import(new URL('../electron/tray.mjs', import.meta.url).href);
  type Item = { type?: string; enabled?: boolean; click?(): void };
  class Tray extends EventEmitter {
    menu: Item[] = []; setToolTip() {} isDestroyed() { return false; } popUpContextMenu(menu: Item[]) { this.menu = menu; }
  }
  const Menu = { buildFromTemplate: (items: Item[]) => items }, nativeImage = { createFromPath: () => ({ resize() {} }) };
  for (const codex of [true, false]) {
    const preset = { speedMode: 'standard', enabled: false, serviceTier: 'default', catalogSpeedVariants: false };
    const writes: unknown[] = [], changed: string[] = [];
    const tray = createTray({ Menu, nativeImage, Tray, showWindow() {}, quit() {}, notify: (topic: string) => changed.push(topic),
      dialog: { showMessageBox: assert.fail }, request: async (route: string, options?: { body: unknown }) => {
        if (route === '/proxy/status') return { running: true, settings: { port: 15722 }, takeover: { codex } };
        assert.equal(route, '/fast-mode'); if (options) writes.push(options); return { ...preset };
      } }) as Tray;
    tray.emit('right-click'); await nextTurn(); preset.catalogSpeedVariants = true;
    const button = tray.menu.filter(row => row.type === 'radio')[1]; assert.ok(button.enabled); button.click!(); await nextTurn();
    assert.deepEqual(writes, [{ method: 'PUT', body: { config: { ...preset, speedMode: 'fast', enabled: true, serviceTier: 'priority' }, applyToCodex: true } }]);
    assert.deepEqual(changed, ['fast-mode']);
  }
});

test('install failures after cleanup are reported without secrets and quit once, including late native errors', async t => {
  const previous = process.env.PORTABLE_EXECUTABLE_DIR; delete process.env.PORTABLE_EXECUTABLE_DIR;
  t.after(() => { if (previous !== undefined) process.env.PORTABLE_EXECUTABLE_DIR = previous; });
  for (const kind of ['throw', 'reject', 'event']) {
    const order: string[] = [], secret = 'installer-private-detail'; let dialog = '';
    const native = Object.assign(new EventEmitter(), { autoInstallOnAppQuit: true, quitAndInstall() {
      order.push('install'); if (kind === 'throw') throw Error(secret); if (kind === 'reject') return Promise.reject(Error(secret));
    } });
    const u = createUpdater({ ...opts, app: { isPackaged: true, quit() { assert.equal(native.autoInstallOnAppQuit, false); order.push('quit'); } }, nativeUpdater: native,
      prepareQuit: async () => { order.push('cleanup'); }, showInstallError(msg: string) { dialog = msg; order.push('dialog'); },
      notify(_: string, s: { status: string }) { if (s.status === 'error') order.push('notify'); } });
    native.emit('update-downloaded', { version: '1.0.1' }); await u.install();
    if (kind === 'event') assert.deepEqual(order, ['cleanup', 'install']);
    native.emit('error', Error(secret)); native.emit('error', Error(secret));
    assert.equal(u.getState().status, 'error'); assert.equal(u.getState().error, dialog); assert.ok(dialog && !dialog.includes(secret));
    assert.deepEqual(order, ['cleanup', 'install', 'notify', 'dialog', 'quit']);
  }
});

test('NSIS native events drive download state and installation waits for cleanup', async t => {
  const previous = process.env.PORTABLE_EXECUTABLE_DIR; delete process.env.PORTABLE_EXECUTABLE_DIR;
  t.after(() => { if (previous !== undefined) process.env.PORTABLE_EXECUTABLE_DIR = previous; });
  const native = Object.assign(new EventEmitter(), { autoDownload: true, autoInstallOnAppQuit: false, allowPrerelease: true,
    checkForUpdates: t.mock.fn(async () => {}), downloadUpdate: t.mock.fn(async () => {}), quitAndInstall: t.mock.fn() });
  let finishCleanup!: () => void;
  const states: string[] = [], cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  const u = createUpdater({ ...opts, app: { isPackaged: true }, nativeUpdater: native, prepareQuit: () => cleanup,
    notify: (_: string, s: { status: string }) => states.push(s.status) });
  assert.deepEqual([native.autoDownload, native.autoInstallOnAppQuit, native.allowPrerelease], [false, true, false]);
  assert.equal(u.getState().mode, 'nsis'); await assert.rejects(u.install());
  native.checkForUpdates.mock.mockImplementation(async () => { native.emit('checking-for-update'); native.emit('update-not-available'); });
  assert.equal((await u.check()).status, 'not-available');
  native.checkForUpdates.mock.mockImplementation(async () => { native.emit('error', Error('fixture-secret')); throw Error('fixture-secret'); });
  assert.equal((await u.check({ silent: true })).status, 'idle'); assert.equal((await u.check()).status, 'error'); assert.ok(!JSON.stringify(u.getState()).includes('fixture-secret'));
  const info = { version: '1.0.1', releaseName: 'Patch', releaseNotes: '<p>Fix</p>' };
  native.checkForUpdates.mock.mockImplementation(async () => { native.emit('checking-for-update'); native.emit('update-available', info); });
  assert.equal((await u.check()).status, 'available'); assert.equal(native.downloadUpdate.mock.callCount(), 0);
  native.downloadUpdate.mock.mockImplementation(async () => { native.emit('download-progress', { percent: 42, transferred: 42, total: 100, bytesPerSecond: 3 }); });
  await u.download(); assert.equal(u.getState().progress.percent, 42); assert.equal((await u.check()).status, 'downloading');
  await assert.rejects(u.install()); native.emit('update-downloaded', info); assert.equal((await u.check()).status, 'downloaded');
  const installing = u.install(); await assert.rejects(u.install()); assert.equal(native.quitAndInstall.mock.callCount(), 0);
  finishCleanup(); await installing; assert.deepEqual(native.quitAndInstall.mock.calls[0].arguments, [false, true]);
  assert.ok(states.includes('downloading') && states.includes('downloaded')); assert.equal(u.getState().releaseNotes, 'Fix');
});
