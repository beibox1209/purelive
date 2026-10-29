'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('purelive', {
  getState: () => ipcRenderer.invoke('library:get-state'),
  addRoom: (payload) => ipcRenderer.invoke('library:add-room', payload),
  updateRoom: (id, patch) => ipcRenderer.invoke('library:update-room', id, patch),
  removeRoom: (id) => ipcRenderer.invoke('library:remove-room', id),
  toggleFavorite: (id) => ipcRenderer.invoke('library:toggle-favorite', id),
  openRoom: (id) => ipcRenderer.invoke('library:open-room', id),
  openExternal: (url) => ipcRenderer.invoke('library:open-external', url),
  copy: (text) => ipcRenderer.invoke('library:copy', text),
  paste: () => ipcRenderer.invoke('library:paste'),
  openDataFolder: () => ipcRenderer.invoke('library:open-data-folder'),
  setSetting: (patch) => ipcRenderer.invoke('library:set-setting', patch),
  getAccounts: () => ipcRenderer.invoke('library:get-accounts'),
  loginAccount: (id) => ipcRenderer.invoke('library:login-account', id),
  logoutAccount: (id) => ipcRenderer.invoke('library:logout-account', id),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('library:state', listener);
    return () => ipcRenderer.removeListener('library:state', listener);
  },
  onPlayerActive: (callback) => {
    const listener = (_event, active) => callback(active);
    ipcRenderer.on('library:player-active', listener);
    return () => ipcRenderer.removeListener('library:player-active', listener);
  },
});
