const { contextBridge, ipcRenderer } = require('electron');

// Never pass the Electron event (or its sender) across the isolated bridge.
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback');
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

contextBridge.exposeInMainWorld('phuketDesktop', {
  isElectron: true,
  appVersion: require('../package.json').version,
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  updater: {
    getState: () => ipcRenderer.invoke('updater:getState'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onStateChange: (cb) => subscribe('updater:state', cb),
  },
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChange: (cb) => subscribe('window:maximized', cb),
  setTheme: (theme) => ipcRenderer.invoke('window:setTheme', theme),
  webLogin: () => ipcRenderer.invoke('auth:webLogin'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  onTrayChange: (cb) => subscribe('tray:changed', cb),
  quit: () => ipcRenderer.invoke('app:quit'),
});
