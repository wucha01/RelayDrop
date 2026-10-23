'use strict';
const { contextBridge, ipcRenderer } = require('electron');
let externalGesture;
window.addEventListener('click', event => {
  externalGesture = undefined;
  if (!event.isTrusted || event.button !== 0) return;
  const anchor = event.target?.closest?.('a[href]');
  if (anchor) externalGesture = { url: anchor.href, at: performance.now() };
}, true);
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
function withToken(request) { let token; try { token = sessionStorage.getItem('relay-host-token') || localStorage.getItem('relay-guest-token'); } catch {} return { ...request, token }; }
contextBridge.exposeInMainWorld('relayDesktop', {
  isDesktop: true,
  lockAction: request => ipcRenderer.invoke('relay:lock-action', request),
  sharingAction: request => ipcRenderer.invoke('relay:sharing-action', request),
  openLocalLibrary: () => ipcRenderer.invoke('relay:open-local-library'),
  chooseFiles: request => ipcRenderer.invoke('relay:choose-files-upload', withToken(request)),
  getSavedCopies: request => ipcRenderer.invoke('relay:saved-copies', withToken(request)),
  openSavedCopy: request => navigator.userActivation.isActive ? ipcRenderer.invoke('relay:open-saved-copy', withToken(request)) : Promise.reject(new Error('请点击对应文件后再打开。')),
  revealSavedCopy: request => navigator.userActivation.isActive ? ipcRenderer.invoke('relay:reveal-saved-copy', withToken(request)) : Promise.reject(new Error('请点击对应文件后再打开。')),
  chooseFolder: request => ipcRenderer.invoke('relay:choose-folder-upload', withToken(request)),
  poolStorage: request => ipcRenderer.invoke('relay:pool-storage', request),
  onStorageProgress: callback => subscribe('relay:storage-progress', callback),
  remoteAction: request => ipcRenderer.invoke('relay:remote-action', request),
  onRemoteChanged: callback => subscribe('relay:remote-changed', callback),
  saveFile: (request) => ipcRenderer.invoke('relay:save-file', withToken(request)),
  saveBatch: (request) => ipcRenderer.invoke('relay:save-batch', withToken(request)),
  saveFolder: request => ipcRenderer.invoke('relay:save-folder', withToken(request)),
  cancelSave: (requestId) => ipcRenderer.invoke('relay:cancel-save', requestId),
  openExternal: (url) => {
    const gesture = externalGesture; externalGesture = undefined;
    if (!navigator.userActivation.isActive || !gesture || performance.now() - gesture.at > 1000 || gesture.url !== url) return Promise.reject(new Error('请点击对应链接后再打开。'));
    return ipcRenderer.invoke('relay:open-external', url);
  },
  chooseReceiveDirectory: () => ipcRenderer.invoke('relay:choose-directory'),
  clearReceiveDirectory: () => ipcRenderer.invoke('relay:clear-directory'),
  revealSavedFile: (requestId) => ipcRenderer.invoke('relay:reveal-saved', requestId),
  getIncomingFilesStatus: () => ipcRenderer.invoke('relay:incoming-status'),
  cancelIncomingFiles: (requestId) => ipcRenderer.invoke('relay:cancel-incoming', requestId),
  onIncomingFilesProgress: (callback) => subscribe('relay:incoming-progress', callback),
  getSettings: () => ipcRenderer.invoke('relay:get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('relay:update-settings', settings),
  reportActivity: (activity) => ipcRenderer.send('relay:activity', activity),
  onSaveProgress: (callback) => subscribe('relay:save-progress', callback),
  onBatchProgress: (callback) => subscribe('relay:batch-progress', callback),
  onSettingsChanged: (callback) => subscribe('relay:settings-changed', callback)
});
