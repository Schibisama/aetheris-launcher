const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('info'),
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  play: (opts) => ipcRenderer.invoke('play', opts),
  setSettings: (s) => ipcRenderer.invoke('settings', s),
  modsList: () => ipcRenderer.invoke('mods-list'),
  modsAdd: () => ipcRenderer.invoke('mods-add'),
  modsRemove: (n) => ipcRenderer.invoke('mods-remove', n),
  modsFolder: () => ipcRenderer.invoke('mods-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  winControl: (a) => ipcRenderer.send('win', a),
  onEvent: (cb) => ipcRenderer.on('evt', (_e, d) => cb(d)),
})
