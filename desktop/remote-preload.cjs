'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Only the dedicated, authenticated remote window receives this preload.
const initial = ipcRenderer.sendSync('relay:remote-bootstrap');
if (initial?.token) { try { localStorage.setItem('relay-guest-token', initial.token); } catch {} }
let last = initial?.token || null;
setInterval(() => {
  let token; try { token = localStorage.getItem('relay-guest-token'); } catch { return; }
  if (token !== last && (token === null || /^[A-Za-z0-9_-]{16,256}$/.test(token))) { last = token; ipcRenderer.send('relay:remote-token', token); }
}, 1500);
function subscribe(channel, callback) { const listener = (_event, value) => callback(value); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); }
function withToken(request) { let token; try { token = localStorage.getItem('relay-guest-token'); } catch {} return { ...request, token }; }
contextBridge.exposeInMainWorld('relayDesktop', {
  isDesktop: true, isRemote: true,
  getSavedCopies: request => ipcRenderer.invoke('relay:remote-saved-copies', withToken(request)),
  openSavedCopy: request => navigator.userActivation.isActive ? ipcRenderer.invoke('relay:remote-open-saved-copy', withToken(request)) : Promise.reject(new Error('请点击对应文件后再打开。')),
  revealSavedCopy: request => navigator.userActivation.isActive ? ipcRenderer.invoke('relay:remote-reveal-saved-copy', withToken(request)) : Promise.reject(new Error('请点击对应文件后再打开。')),
  reportActivity: activity => ipcRenderer.send('relay:remote-activity', activity),
  saveFile: request => ipcRenderer.invoke('relay:remote-save', withToken(request)),
  saveBatch: request => ipcRenderer.invoke('relay:remote-save-batch', withToken(request)),
  saveFolder: request => ipcRenderer.invoke('relay:remote-save-folder', withToken(request)),
  cancelSave: id => ipcRenderer.invoke('relay:remote-cancel', id),
  revealSavedFile: id => ipcRenderer.invoke('relay:remote-reveal', id),
  onSaveProgress: callback => subscribe('relay:save-progress', callback),
  onBatchProgress: callback => subscribe('relay:batch-progress', callback)
});
