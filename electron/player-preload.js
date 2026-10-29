'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('player', {
  getState: () => ipcRenderer.invoke('player:get-state'),
  toggleClean: () => ipcRenderer.invoke('player:toggle-clean'),
  setClean: (value) => ipcRenderer.invoke('player:set-clean', value),
  reload: () => ipcRenderer.invoke('player:reload'),
  retry: () => ipcRenderer.invoke('player:retry'),
  togglePlay: () => ipcRenderer.invoke('player:toggle-play'),
  toggleMute: () => ipcRenderer.invoke('player:toggle-mute'),
  refreshQuality: () => ipcRenderer.invoke('player:refresh-quality'),
  setQuality: (id) => ipcRenderer.invoke('player:set-quality', id),
  showQualityMenu: (position) => ipcRenderer.invoke('player:show-quality-menu', position),
  showMoreMenu: (position) => ipcRenderer.invoke('player:show-more-menu', position),
  toggleEnhance: () => ipcRenderer.invoke('player:toggle-enhance'),
  togglePin: () => ipcRenderer.invoke('player:toggle-pin'),
  toggleFullscreen: () => ipcRenderer.invoke('player:toggle-fullscreen'),
  copyUrl: () => ipcRenderer.invoke('player:copy-url'),
  openExternal: () => ipcRenderer.invoke('player:open-external'),
  close: () => ipcRenderer.invoke('player:close'),
  home: () => ipcRenderer.invoke('player:home'),
  devtools: () => ipcRenderer.invoke('player:devtools'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('player:state', listener);
    return () => ipcRenderer.removeListener('player:state', listener);
  },
  onToast: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('player:toast', listener);
    return () => ipcRenderer.removeListener('player:toast', listener);
  },
});
