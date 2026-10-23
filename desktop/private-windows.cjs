'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
function createPrivateWindows({ electron, state, action, onClosed = () => {} }) {
  const { BrowserWindow, ipcMain } = electron, windows = new Map(), location = pathToFileURL(path.join(__dirname, 'ui/private.html')).href;
  function from(event) {
    const item = windows.get(event.sender.id);
    if (!item || item.window.isDestroyed() || event.senderFrame !== item.window.webContents.mainFrame || event.senderFrame.url !== location) throw new Error('本机界面请求来源无效。');
    return item;
  }
  ipcMain.handle('relay:private-state', async event => { const item = from(event); return { kind: item.kind, title: item.title, confirm:item.confirm, ...await state(item.kind) }; });
  ipcMain.handle('relay:private-action', async (event, request) => {
    const item = from(event); if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('本机界面请求无效。');
    if(item.kind==='library'&&['open','reveal'].includes(request.action)){const active=await event.sender.executeJavaScriptInIsolatedWorld(1001,[{code:'navigator.userActivation.isActive'}]);if(!active||from(event)!==item)throw new Error('请点击对应文件后再打开。');}
    if (item.kind === 'password') {
      if (typeof request.password !== 'string' || Buffer.byteLength(request.password, 'utf8') < 8 || Buffer.byteLength(request.password, 'utf8') > 1024 || item.confirm && request.password !== request.confirmPassword) throw new Error(item.confirm ? '请输入至少 8 字节的密码，并保证两次相同。' : '请输入有效的备份密码。');
      item.resolve(request.password); item.resolve = null; item.reject = null; item.window.close(); return { accepted: true };
    }
    const result = await action(item.kind, request, item.window);
    from(event); if (result?.close) item.window.close(); return result;
  });
  function show(kind, options = {}) {
    const existing = [...windows.values()].find(item => item.kind === kind && kind !== 'password' && !item.window.isDestroyed());
    if (existing) { existing.window.show(); existing.window.focus(); return existing.window; }
    const window = new BrowserWindow({ width: kind === 'library' ? 880 : 480, height: kind === 'library' ? 720 : 620, minWidth: 420, minHeight: 450, title: options.title || '互联 · 本机', show: false, autoHideMenuBar: true, backgroundColor: '#f4f7f7', icon: path.join(__dirname, 'assets/icon.png'), ...(options.parent ? { parent: options.parent, modal: kind === 'password' } : {}), webPreferences: { preload: path.join(__dirname,'private-preload.cjs'), partition: 'relay-private-' + crypto.randomUUID(), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false, webviewTag: false, navigateOnDragDrop: false } });
    const item = { kind, title: options.title || '', confirm: options.confirm === true, window, resolve: options.resolve, reject: options.reject }; windows.set(window.webContents.id, item);
    window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', (event,url) => { if (url !== location) event.preventDefault(); }); window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false)); window.webContents.session.setPermissionCheckHandler(()=>false);
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => { const allowed = [location, pathToFileURL(path.join(__dirname,'ui/private.js')).href, pathToFileURL(path.join(__dirname,'ui/private.css')).href]; callback({cancel:!allowed.includes(details.url)}); });
    const windowId=window.webContents.id;window.once('ready-to-show',()=>window.show());window.once('closed',()=>{windows.delete(windowId);item.reject?.(new Error('已取消'));onClosed(kind);}); void window.loadURL(location); return window;
  }
  return { show, prompt(options) { return new Promise((resolve,reject)=>show('password',{...options,resolve,reject})); }, close(kind) { for (const item of [...windows.values()]) if (!kind || item.kind === kind) item.window.close(); }, lock() { for (const item of [...windows.values()]) if (item.kind !== 'lock') item.window.close(); } };
}
module.exports={createPrivateWindows};
