import { dialog, Menu, nativeImage, Tray } from 'electron';

const speeds = [
  ['standard', 'default', '速度：标准（普通分组）'],
  ['fast', 'priority', '⚡ 速度：Fast（普通分组加速）'],
  ['ultrafast', 'ultrafast', '⚡⚡ 速度：UltraFast（Pro500 ultrafast）'],
];

export function createTray({ iconPath, request, showWindow, quit, notify, updater, openUpdates }) {
  const tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('Phuket Switch');
  tray.on('click', showWindow);

  let pending = Promise.resolve(), openSequence = 0;
  function change(topic, write) {
    pending = pending.then(write).then(() => notify(topic)).catch((error) => {
      if (!tray.isDestroyed()) void dialog.showMessageBox({ type: 'error', title: 'Phuket Switch',
        message: '无法更改托盘设置。', detail: error.message });
    });
  }

  // Build a new menu on every open: the web UI (or an independent backend) may
  // have changed either setting since the last click. Never show a stale checkmark.
  tray.on('right-click', async () => {
    const sequence = ++openSequence;
    await pending;
    const [fast, proxy] = await Promise.all([
      request('/fast-mode').catch(() => null), request('/proxy/status').catch(() => null),
    ]);
    if (tray.isDestroyed() || sequence !== openSequence) return;
    const mode = fast?.speedMode ?? (!fast?.enabled ? 'standard' : fast.serviceTier === 'ultrafast' ? 'ultrafast' : 'fast');
    const port = proxy?.settings.port ?? 15722;
    const status = !proxy ? '状态未知' : proxy.running ? '运行中（停止）' : '已停止（启动）';
    const update = updater?.getState();
    const updateLabel = update?.status === 'downloaded' ? `重启安装更新 v${update.latestVersion}`
      : update?.status === 'available' ? `发现新版本 v${update.latestVersion}` : update?.status === 'downloading' ? '查看下载进度' : '检查更新';
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      { type: 'separator' },
      ...speeds.map(([speedMode, serviceTier, label]) => ({
        label, type: 'radio', enabled: !!fast && !!proxy, checked: mode === speedMode,
        click: () => change('fast-mode', async () => {
          // Both the preset and takeover state may have changed while the menu was open.
          const [current, proxy] = await Promise.all([request('/fast-mode'), request('/proxy/status')]);
          const next = { ...current, speedMode, enabled: speedMode !== 'standard', serviceTier };
          await request('/fast-mode', { method: 'PUT', body: { config: next, applyToCodex: !proxy?.takeover?.codex } });
        }),
      })),
      { type: 'separator' },
      { label: `本地代理 (:${port}) · ${status}`, enabled: !!proxy,
        click: () => change('proxy', () => request(proxy.running ? '/proxy/stop' : '/proxy/start', { method: 'POST' })) },
      { type: 'separator' },
      ...(openUpdates ? [{ label: updateLabel, click: openUpdates }] : []),
      { label: '退出 Phuket Switch', click: quit },
    ]));
  });
  return tray;
}
