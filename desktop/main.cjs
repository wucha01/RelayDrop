'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, session, Tray, nativeImage, shell } = require('electron');
require('electron').protocol.registerSchemesAsPrivileged([{scheme:'relay-preview',privileges:{standard:true,secure:true,stream:true,corsEnabled:true}}]);
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { createSecureRelayServer } = require('../server.cjs');
const { saveVerifiedFile } = require('./verified-save.cjs');
const { createSavedCopies, context: savedCopyContext } = require('./saved-copies.cjs');
const { createAppLock } = require('./app-lock.cjs');
const { confirmOpen } = require('./open-risk.cjs');
const { planFolder, materialize } = require('./save-folder.cjs');
const { createSettings } = require('./native-settings.cjs');
const { parseSendArguments, inspectFiles, inspectDirectory, uploadLocalFile } = require('./native-import.cjs');
const buildIdentity = require('./build-identity.cjs')(require('../package.json'));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const credential = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
const suppliedData = process.env.RELAY_DESKTOP_DATA;
const userData = suppliedData || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), buildIdentity.dataDirectoryName);
if (!path.isAbsolute(userData) || userData.toLowerCase().includes('.asar')) throw new Error('RELAY_DESKTOP_DATA 必须是可写的绝对目录。');
fs.mkdirSync(userData, { recursive: true }); app.setName(buildIdentity.productName); app.setPath('userData', userData); app.setAppUserModelId(buildIdentity.appId);
const settings = createSettings(userData);
const savedCopies = createSavedCopies(userData);
const interfaceLock = createAppLock(userData);
let interfaceLocked = interfaceLock.state().configured, privateUI, afterUnlock = null;
const unlockWaiters=new Set();let nativeDialogs=0;
for(const name of ['showOpenDialog','showSaveDialog','showMessageBox']){const original=dialog[name].bind(dialog);dialog[name]=async(...args)=>{if(interfaceLocked&&args.at(-1)?.title!=='结束传输并退出？')throw new Error('应用界面已锁定，请先解锁后继续。');nativeDialogs++;try{return await original(...args);}finally{nativeDialogs--;}};}
async function waitUnlocked(signal){if(!interfaceLocked)return;signal?.throwIfAborted();await new Promise((resolve,reject)=>{const finish=()=>{unlockWaiters.delete(finish);signal?.removeEventListener('abort',abort);resolve();};const abort=()=>{unlockWaiters.delete(finish);reject(signal.reason);};unlockWaiters.add(finish);signal?.addEventListener('abort',abort,{once:true});});}
let relay, origin, mainWindow, tray, shuttingDown = false, closePrompt = false, trayPrompt = false;
let remoteManager;
let storageBusy=false,storageController=null;
let activeDataDir=path.join(userData,'relay-data');
const dataPointer=path.join(userData,'pool-location.json');
let storageStartupError,pointerText;
try{pointerText=fs.readFileSync(dataPointer,'utf8');}catch(error){if(error.code!=='ENOENT')storageStartupError=error;}
if(pointerText!==undefined)try{const pointer=JSON.parse(pointerText);if(pointer.version!==1||typeof pointer.dataDir!=='string'||!path.isAbsolute(pointer.dataDir)||/[\x00-\x1f]/.test(pointer.dataDir))throw new Error('数据目录配置损坏');const stat=fs.lstatSync(pointer.dataDir);if(!stat.isDirectory()||stat.isSymbolicLink()||!fs.existsSync(path.join(pointer.dataDir,'state.json'))||!fs.existsSync(path.join(pointer.dataDir,'tls-identity.json')))throw new Error('文件池目录不完整');activeDataDir=pointer.dataDir;}catch(error){storageStartupError=new Error('已迁移的文件池目录不可用；请重新连接磁盘或检查位置配置。程序不会自动改用旧文件池。'+(error.code?'（'+error.code+'）':''));}
let rendererActivity = { uploads: 0, verifications: 0 }, activeRequests = 0;
const recentTransfers = new Map();
const seenCompleted = new Set(), pendingNotifications = new Set();
let notificationTimer, lastNotification = 0;
let activeSave = null, queue = [], quitting = null;
const savedFiles = new Map(), incomingJobs = new Map();
let incomingQueue = [], activeIncoming = null;
const startupBackground = process.argv.includes('--background') && !process.argv.includes('--send');

function allowedDocument(url) {
  try { const target = new URL(url); return target.origin === origin && ['/', '/index.html'].includes(target.pathname); } catch { return false; }
}
function trusted(event) {
  return !interfaceLocked && mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame && allowedDocument(event.senderFrame.url);
}
async function pageCredential(event) {
  if (!trusted(event)) throw new Error('应用界面已锁定或页面来源无效。');
  const token = await event.sender.executeJavaScriptInIsolatedWorld(1002, [{code:"(()=>{try{return sessionStorage.getItem('relay-host-token')||localStorage.getItem('relay-guest-token');}catch{return null;}})()"}]);
  if (!credential(token) || !trusted(event)) throw new Error('请使用本机管理员身份操作。'); return token;
}
async function authorizeHost(event, expected) {
  const token = await pageCredential(event); if (expected && expected !== token) throw new Error('管理员身份已变化，请重试。');
  // Maintenance intentionally stops HTTP. The native host capability remains
  // valid so that the owner can inspect/cancel that operation while it is down.
  if(storageBusy&&token===relay.hostToken&&await samePageCredential(event,token))return token;
  const current = await api('/api/state', 'GET', undefined, token);
  if (current.device?.id !== 'host' || !await samePageCredential(event, token)) throw new Error('此功能仅供本机管理员使用。'); return token;
}
function sendScoped(channel, value, token = relay?.hostToken) {
  if (!mainWindow || mainWindow.isDestroyed() || interfaceLocked) return;
  const window = mainWindow;
  void window.webContents.executeJavaScriptInIsolatedWorld(1002,[{code:"(()=>{try{return sessionStorage.getItem('relay-host-token')||localStorage.getItem('relay-guest-token');}catch{return null;}})()"}]).then(current=>{if(current===token&&!interfaceLocked&&!window.isDestroyed()&&allowedDocument(window.webContents.getURL()))window.webContents.send(channel,value);}).catch(()=>{});
}
async function samePageCredential(event, token) {
  if (!trusted(event)) return false;
  try { return token === await event.sender.executeJavaScriptInIsolatedWorld(1002, [{ code: "(()=>{try{return sessionStorage.getItem('relay-host-token')||localStorage.getItem('relay-guest-token');}catch{return null;}})()" }]) && trusted(event); } catch { return false; }
}
function suggestedFileName(name) {
  let cleaned = String(name || '文件').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '') || '文件';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(cleaned)) cleaned = '_' + cleaned;
  const originalExtension = path.extname(cleaned), extension = originalExtension.slice(0, 32).replace(/[\ud800-\udbff]$/, '');
  const base = cleaned.slice(0, cleaned.length - originalExtension.length).slice(0, 200 - extension.length).replace(/[\ud800-\udbff]$/, '');
  return (base || '文件') + extension;
}
function emit(job, status, extra = {}) {
  const event = { requestId: job.requestId, fileId: job.fileId, context: job.context || relay.identity.id + ':host', ...(job.batchId ? { batchId: job.batchId } : {}), name: job.name || '文件', status, transferred: 0, total: job.size || 0, ...extra };
  job.lastEvent = event;
  sendScoped('relay:save-progress', event, job.token);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(status === 'saving' || status === 'verifying' ? (event.total ? Math.min(1, event.transferred / event.total) : 0) : -1);
  return event;
}
async function api(route, method = 'GET', json, token = relay.hostToken) {
  const response = await fetch(origin + route, { method, headers: { Authorization: 'Bearer ' + token, ...(json===undefined?{}:{'Content-Type':'application/json'}) }, body:json===undefined?undefined:JSON.stringify(json), redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('中转站文件不可用，请刷新后重试。');
  return response.json();
}
async function metadata(job) {
  if (job.fileId === 'installer') {
    const response = await fetch(origin + '/RelayDrop-Android.apk', { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15000) });
    const size = Number(response.headers.get('content-length')), etag = response.headers.get('etag');
    if (!response.ok || !Number.isSafeInteger(size) || size < 0 || !/^"[a-f0-9]{64}"$/i.test(etag || '')) throw new Error('安卓安装包缺少有效的校验记录。');
    return { name: 'RelayDrop-Android.apk', size, sha256: etag.slice(1, -1), url: origin + '/RelayDrop-Android.apk' };
  }
  const state = await api('/api/state', 'GET', undefined, job.token), file = state.files.find(f => f.id === job.fileId);
  if (!file || !Number.isSafeInteger(file.size) || !/^[a-f0-9]{64}$/i.test(file.sha256 || '') || file.sha256.length !== 64) throw new Error('文件已经移除或完整性记录无效。');
  const ticket = await api('/api/files/' + encodeURIComponent(file.id) + '/ticket', 'POST', undefined, job.token);
  const target = new URL(ticket.url, origin);
  if (target.origin !== origin || target.pathname !== '/api/files/' + file.id + '/content') throw new Error('下载地址无效。');
  return { name: file.name, size: file.size, sha256: file.sha256, url: target.href, copyState: state, copyFile: file };
}
function enqueue(fileId, requestId = crypto.randomUUID(), token = relay.hostToken, context = relay.identity.id + ':host') {
  if (shuttingDown || storageBusy) return Promise.resolve({ status: 'cancelled', requestId, fileId, error: '程序正在关闭。' });
  if ((fileId !== 'installer' && (typeof fileId !== 'string' || !UUID.test(fileId))) || typeof requestId !== 'string' || !UUID.test(requestId)) return Promise.reject(new Error('文件请求无效。'));
  return schedule({ kind: 'file', fileId, requestId, token, context, controller: new AbortController() });
}
function enqueueBatch(fileIds, requestId = crypto.randomUUID(), token = relay.hostToken, context = relay.identity.id + ':host', folderPlan = null) {
  if (!Array.isArray(fileIds) || !folderPlan&&!fileIds.length || fileIds.length > (folderPlan?2000:200) || !fileIds.every(id => typeof id === 'string' && UUID.test(id)) || typeof requestId !== 'string' || !UUID.test(requestId)) return Promise.reject(new Error('批量保存文件无效或超过数量限制。'));
  if (shuttingDown || storageBusy) return Promise.reject(new Error('程序正在关闭或文件池维护中。'));
  const ids = [...new Set(fileIds)];
  return schedule({ kind: 'batch', requestId, token, context, folderPlan, controller: new AbortController(), children: ids.map(fileId => ({ fileId, requestId: crypto.randomUUID(), batchId: requestId, token, context, controller: new AbortController() })), results: [] });
}
function batchEvent(job, status, error) {
  const result = { requestId: job.requestId, context: job.context || relay.identity.id + ':host', status, total: job.children.length, completed: job.results.filter(r => r.status === 'completed').length, failed: job.results.filter(r => r.status === 'failed').length, cancelled: job.results.filter(r => r.status === 'cancelled').length, ...(error ? { error } : {}) };
  sendScoped('relay:batch-progress', result, job.token);
  return result;
}
function schedule(job) {
  const existing = [activeSave, ...queue].find(j => j && j.requestId === job.requestId);
  if (existing) {
    if (existing.token !== job.token || existing.kind !== job.kind || (job.kind === 'file' && existing.fileId !== job.fileId)
      || (job.kind === 'batch' && (existing.folderPlan?.folderId!==job.folderPlan?.folderId || !!existing.folderPlan!==!!job.folderPlan || existing.children.map(child => child.fileId).join(',') !== job.children.map(child => child.fileId).join(',')))) return Promise.reject(new Error('请求编号已被使用。'));
    return existing.promise;
  }
  if (queue.length >= 50) return Promise.reject(new Error('保存队列已满，请等待当前文件完成。'));
  job.promise = new Promise(resolve => { job.resolve = resolve; }); queue.push(job);
  if (job.kind === 'batch') batchEvent(job, 'queued'); else emit(job, 'queued');
  void pump(); return job.promise;
}
function checkCancelled(job) { if (job.controller.signal.aborted || shuttingDown) throw Object.assign(new Error('已取消保存'), { name: 'AbortError' }); }
async function checkedDirectory(directory) {
  const real = await fsp.realpath(path.resolve(directory));
  if (!(await fsp.stat(real)).isDirectory()) throw new Error('请选择有效的保存文件夹。');
  const forbidden = [path.resolve(app.getAppPath()), path.resolve(userData), path.resolve(activeDataDir)];
  if (forbidden.some(root => real.toLowerCase() === root.toLowerCase() || real.toLowerCase().startsWith(root.toLowerCase() + path.sep))) throw new Error('请选择应用程序和中转数据目录以外的保存位置。');
  return real;
}
async function uniqueDestination(directory, name, start = 0) {
  const safe = suggestedFileName(name), extension = path.extname(safe), base = safe.slice(0, safe.length - extension.length);
  for (let suffix = start; suffix < 10000; suffix++) {
    const destination = path.join(directory, suffix ? base + ' (' + (suffix + 1) + ')' + extension : safe);
    try { await fsp.lstat(destination); } catch (error) { if (error.code === 'ENOENT') return { destination, suffix }; throw error; }
  }
  throw new Error('同名文件过多，请选择其他文件夹。');
}
async function preferredDirectory() {
  const directory = settings.get().lastSaveDirectory || app.getPath('downloads');
  try { return await checkedDirectory(directory); } catch { return app.getPath('downloads'); }
}
async function fixedDirectory() {
  const directory = settings.get().receiveDirectory;
  if (!directory) throw new Error('请先选择固定接收文件夹。');
  let real;
  try { real = await checkedDirectory(directory); } catch { throw new Error('固定接收文件夹不可用，请在设置中重新选择。'); }
  if (real.toLowerCase() !== path.resolve(directory).toLowerCase()) throw new Error('固定接收文件夹已被替换，请重新选择。');
  return real;
}
function rememberDirectory(directory) { settings.update({ lastSaveDirectory: directory }); notifySettings(); }
async function saveOne(job, directory) {
  try {
    const file = await metadata(job); Object.assign(job, file);
    checkCancelled(job); let destination, suffix = 0;
    if (!directory && settings.get().saveMode === 'fixed') directory = await fixedDirectory();
    if (!directory) {
      await waitUnlocked(job.controller.signal);checkCancelled(job);
      emit(job, 'choosing');
      const selection = await dialog.showSaveDialog(mainWindow, { title: '保存并校验文件', defaultPath: path.join(await preferredDirectory(), suggestedFileName(file.name)), properties: ['showOverwriteConfirmation'] });
      if (selection.canceled || !selection.filePath) throw Object.assign(new Error('已取消保存'), { name: 'AbortError' });
      checkCancelled(job); const selected = path.resolve(selection.filePath);
      const selectedDirectory = await checkedDirectory(path.dirname(selected));
      destination = path.join(selectedDirectory, path.basename(selected)); rememberDirectory(selectedDirectory);
    }
    for (;;) {
      checkCancelled(job);
      if (directory) ({ destination, suffix } = await uniqueDestination(directory, file.name, suffix));
      try {
        const result = await saveVerifiedFile({ url: file.url, destination, expectedSize: file.size, expectedSha256: file.sha256, overwrite: !directory,
          signal: job.controller.signal, onProgress: event => { if (event.status !== 'completed') emit(job, event.status, event); } });
        savedFiles.set(job.requestId, {path:result.path,token:job.token}); if (savedFiles.size > 500) savedFiles.delete(savedFiles.keys().next().value);
        let savedCopyWarning;
        if (file.copyFile) try { await savedCopies.record(file.copyState, file.copyFile, result.path); } catch { savedCopyWarning = '文件已保存并校验，但本机副本记录未能保存；请从保存位置打开。'; }
        return emit(job, 'completed', { transferred: file.size, total: file.size, size: result.size, sha256: result.sha256, ...(savedCopyWarning ? { savedCopyWarning } : {}) });
      } catch (error) { if (directory && error.code === 'EEXIST') { suffix++; continue; } throw error; }
    }
  } catch (error) {
    const status = job.controller.signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed';
    const message = error.code === 'ENOSPC' ? '目标磁盘空间不足，未完成文件已清理。' : status==='cancelled'?'已取消保存。':/校验|SHA|大小|内容/.test(error.message||'')?'文件完整性校验未通过，未确认保存。':'保存未完成，请检查文件、连接和保存位置。';
    return emit(job, status, { error: message });
  }
}
function finishBatch(job, error) {
  for (const child of job.children.slice(job.results.length)) job.results.push(emit(child, 'cancelled', { error: error || '已取消余下保存。' }));
  const status = error || job.results.some(r => r.status === 'failed') ? 'failed' : job.controller.signal.aborted || job.results.some(r => r.status === 'cancelled') ? 'cancelled' : 'completed';
  return { ...batchEvent(job, status, error), results: job.results, ...(job.folderPlan?{directories:job.directoryTree?.directories||0}:{}) };
}
async function saveBatch(job) {
  try {
    checkCancelled(job); let directory;
    if (settings.get().saveMode === 'fixed') directory = await fixedDirectory();
    else {
      await waitUnlocked(job.controller.signal);checkCancelled(job);
      batchEvent(job, 'choosing');
      const selection = await dialog.showOpenDialog(mainWindow, { title: '选择批量保存文件夹', defaultPath: await preferredDirectory(), properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] });
      if (selection.canceled || !selection.filePaths?.[0]) { job.controller.abort(); return finishBatch(job); }
      checkCancelled(job); directory = await checkedDirectory(selection.filePaths[0]); rememberDirectory(directory);
    }
    if(job.folderPlan){const current=await api('/api/state','GET',undefined,job.token);planFolder(current,job.folderPlan.folderId);job.directoryTree=await materialize(job.folderPlan,directory,{signal:job.controller.signal});}
    for (const child of job.children) {
      if (job.controller.signal.aborted || shuttingDown) break;
      job.activeChild = child; emit(child, 'queued'); batchEvent(job, 'running');
      const childDirectory=job.directoryTree?await job.directoryTree.directory(job.folderPlan.files.find(file=>file.fileId===child.fileId).folderId):directory;
      job.results.push(await saveOne(child, childDirectory)); job.activeChild = null; batchEvent(job, 'running');
    }
    return finishBatch(job);
  } catch (error) { if(error.name==='AbortError')job.controller.abort();return finishBatch(job, error.name === 'AbortError' ? undefined : '批量保存未完成，请检查文件、连接和保存位置。'); }
  finally { job.activeChild = null; }
}
async function pump() {
  if (interfaceLocked || activeSave || shuttingDown || storageBusy || !queue.length) return;
  const job = queue.shift(); activeSave = job;
  try { job.resolve(job.kind === 'batch' ? await saveBatch(job) : await saveOne(job)); }
  finally { activeSave = null; void pump(); }
}
function cancel(requestId) {
  if (typeof requestId !== 'string') return false;
  if (activeSave?.requestId === requestId) { activeSave.controller.abort(); activeSave.activeChild?.controller.abort(); return true; }
  if (activeSave?.activeChild?.requestId === requestId) { activeSave.activeChild.controller.abort(); return true; }
  const index = queue.findIndex(j => j.requestId === requestId);
  if (index < 0) return false;
  const [job] = queue.splice(index, 1); job.controller.abort(); job.resolve(job.kind === 'batch' ? finishBatch(job) : emit(job, 'cancelled')); return true;
}
async function startRelay() {
  if(storageStartupError)throw storageStartupError;
  const suppliedPort = process.env.RELAY_DESKTOP_PORT;
  const firstPort = suppliedPort === undefined ? 8765 : Number(suppliedPort);
  if (!Number.isInteger(firstPort) || firstPort < 0 || firstPort > 65535) throw new Error('桌面服务端口无效。');
  const ports = suppliedPort === undefined ? Array.from({ length: 11 }, (_, i) => 8765 + i) : [firstPort];
  for (const port of ports) {
    const candidate = await createSecureRelayServer({ dataDir: activeDataDir, host: process.env.RELAY_DESKTOP_HOST === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0', port, createThumbnail: require('./previews.cjs').createThumbnail });
    try { const actual = await candidate.listen(); relay = candidate; origin = 'http://127.0.0.1:' + actual; break; }
    catch (error) { await candidate.close().catch(() => {}); if (error.code !== 'EADDRINUSE' || port === ports.at(-1)) throw error; }
  }
  try {
  for (const file of (await api('/api/state')).files) seenCompleted.add(file.id);
  relay.server.on('request', (request, response) => {
    if (!/^(PUT|POST|DELETE)$/.test(request.method || '')) return;
    const transfer = (request.url || '').split('?')[0].match(/^\/api\/transfers\/([a-f0-9-]+)(\/complete)?$/i);
    if (!transfer) return;
    activeRequests++; let done = false;
    if (request.method === 'PUT') recentTransfers.set(transfer[1], Date.now());
    const finish = () => {
      if (done) return; done = true; activeRequests--;
      if (response.writableFinished && response.statusCode >= 200 && response.statusCode < 300 && (transfer[2] || request.method === 'DELETE')) {
        recentTransfers.delete(transfer[1]);
        if (transfer[2]) queueNotification(transfer[1]);
      }
    };
    response.once('finish', finish); response.once('close', finish);
  });
  }catch(error){const failed=relay;relay=null;await failed?.close().catch(()=>{});throw error;}
}
function queueNotification(fileId) {
  if (shuttingDown || seenCompleted.has(fileId)) return;
  pendingNotifications.add(fileId);
  if (!notificationTimer) {
    notificationTimer = setTimeout(() => { notificationTimer = undefined; void showReceivedNotification(); }, Math.max(1500, 10000 - (Date.now() - lastNotification)));
    notificationTimer.unref();
  }
}
async function showReceivedNotification() {
  const ids = [...pendingNotifications]; pendingNotifications.clear();
  if (shuttingDown || !ids.length) return;
  try {
    const state = await api('/api/state'), files = state.files.filter(file => ids.includes(file.id) && !seenCompleted.has(file.id));
    ids.forEach(id => seenCompleted.add(id));
    const received = files.filter(file => file.senderId !== 'host' && (!file.targetId || file.targetId === 'host'));
    if (interfaceLocked || !received.length || !tray || tray.isDestroyed() || !mainWindow || mainWindow.isDestroyed() || (mainWindow.isVisible() && !mainWindow.isMinimized())) return;
    tray.displayBalloon({ iconType: 'info', title: received.length === 1 ? '收到新文件' : '收到 ' + received.length + ' 个文件', content: received.length === 1 ? String(received[0].name).slice(0, 160) + '\n已完成完整性校验，点击打开中转站。' : '文件已完成完整性校验，点击打开中转站。', noSound: true });
    lastNotification = Date.now();
  } catch { /* Notifications do not change transfer success or stop sharing. */ }
}
function focusWindow() { if(interfaceLocked){privateUI?.show('lock',{title:'互联 · 界面已锁定'});return;} if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } }
function showLocalLibrary(){if(interfaceLocked){afterUnlock=()=>privateUI.show('library',{title:'本机已保存文件'});focusWindow();return;}privateUI.show('library',{title:'本机已保存文件'});}
function lockInterface(){if(nativeDialogs)throw new Error('请先关闭文件选择或确认窗口，再锁定界面。');if(!interfaceLock.state().configured){privateUI.show('settings',{title:'设置本机界面锁'});return {locked:false,needsPassword:true};}interfaceLocked=true;privateUI.lock();mainWindow?.webContents.closeDevTools();mainWindow?.hide();remoteManager?.lockViews();privateUI.show('lock',{title:'互联 · 界面已锁定'});updateTrayMenu();return {locked:true};}
function initializePrivateUI(){
 privateUI=require('./private-windows.cjs').createPrivateWindows({electron:require('electron'),state:async kind=>{if(kind==='library'&&interfaceLocked)throw new Error('界面已锁定。');return {...interfaceLock.state(),locked:interfaceLocked};},action:async(kind,request,window)=>{
  if(kind==='lock'){if(request.action!=='unlock')throw new Error('请求无效。');interfaceLock.verify(request.password);interfaceLocked=false;for(const finish of [...unlockWaiters])finish();updateTrayMenu();focusWindow();void pump();void pumpIncoming();const next=afterUnlock;afterUnlock=null;next?.();return{unlocked:true,close:true};}
  if(interfaceLocked)throw new Error('界面已锁定。');
  if(kind==='settings'){if(request.action==='configure'){if(request.password!==request.confirmPassword)throw new Error('两次密码不一致。');return interfaceLock.configure(request.password,request.currentPassword);}if(request.action==='disable')return interfaceLock.disable(request.currentPassword);throw new Error('设置操作无效。');}
  if(kind==='library'){if(request.action==='list')return savedCopies.listOffline({query:request.query,offset:request.offset,limit:request.limit});if(!['open','reveal'].includes(request.action))throw new Error('本机文件操作无效。');let file=await savedCopies.resolveOffline(request.receiptId);if(interfaceLocked)throw new Error('界面已锁定。');if(request.action==='reveal'){shell.showItemInFolder(file);return{revealed:true};}if(!await confirmOpen(dialog,window,file))return{opened:false,cancelled:true};file=await savedCopies.resolveOffline(request.receiptId);if(interfaceLocked)throw new Error('界面已锁定。');if(await shell.openPath(file))throw new Error('无法打开副本，请检查默认应用。');return{opened:true};}
  throw new Error('本机界面操作无效。');
 }});
}
function installedDesktop() { return process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE && fs.existsSync(path.join(path.dirname(process.execPath), '.relaydrop-installed')); }
function loginOptions() { return { path: process.execPath, args: ['--background'] }; }
function currentSettings() {
  const value = settings.get(), installed = installedDesktop();
  let launchAtLogin = false;
  if (installed) { try { launchAtLogin = app.getLoginItemSettings(loginOptions()).openAtLogin; } catch { } }
  return { closeToTray: value.closeToTray, trayAvailable: !!tray && !tray.isDestroyed(), saveMode: value.saveMode, receiveDirectory: value.receiveDirectory,
    lastSaveDirectory: value.lastSaveDirectory, launchAtLogin, launchAtLoginAvailable: installed, sendToAvailable: installed };
}
function notifySettings() {
  sendScoped('relay:settings-changed', currentSettings());
  updateTrayMenu();
}
function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 ' + buildIdentity.productName, click: focusWindow },
    { label: '本机已保存文件（离线可用）', click: showLocalLibrary },
    { label: '锁定应用界面', enabled:!interfaceLocked, click:()=>{try{lockInterface();}catch(error){dialog.showErrorBox('暂时无法锁定',error.message);}} },
    { label: relay?.getSharingState?.().paused?'恢复外部共享':'暂停外部共享', enabled:!interfaceLocked, click:()=>{void(async()=>{const paused=!relay.getSharingState().paused;await relay.setSharingPaused(paused);if(paused)await remoteManager?.pauseSharing();updateTrayMenu();})().catch(error=>dialog.showErrorBox('共享状态未更新',error.message));} },
    { label: '关闭窗口后继续共享', type: 'checkbox', enabled:!interfaceLocked, checked: settings.get().closeToTray, click: item => {
      try { settings.update({ closeToTray: item.checked }); notifySettings(); }
      catch (error) { dialog.showErrorBox('无法保存设置', error.message); updateTrayMenu(); }
    } },
    { type: 'separator' }, { label: '退出并停止共享', click: () => { void requestClose(); } }
  ]));
}
function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
    if (icon.isEmpty()) throw new Error('托盘图标不可用');
    tray = new Tray(icon); tray.setToolTip(buildIdentity.productName + ' · 正在共享');
    tray.on('click', focusWindow); tray.on('double-click', focusWindow); tray.on('balloon-click', focusWindow); updateTrayMenu();
  } catch { try { tray?.destroy(); } catch { } tray = null; }
}
async function handleWindowClose() {
  if (!settings.get().closeToTray || !tray || tray.isDestroyed()) return requestClose();
  if (trayPrompt || shuttingDown) return;
  if (!settings.get().trayHintShown) {
    trayPrompt = true;
    try {
      const answer = await dialog.showMessageBox(mainWindow, { type: 'info', title: 'RelayDrop 将继续在后台接收', message: '关闭窗口后，手机和平板仍可连接这台电脑。', detail: '点击任务栏通知区域中的 RelayDrop 图标可重新打开。右键图标选择「退出并停止共享」可完全退出；也可在设置中关闭后台共享。', buttons: ['知道了，留在后台', '本次退出'], defaultId: 0, cancelId: 0, noLink: true });
      settings.update({ trayHintShown: true });
      if (answer.response === 1) return requestClose();
    } finally { trayPrompt = false; }
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}
async function requestClose() {
  if (shuttingDown || closePrompt) return;
  if(storageBusy){dialog.showErrorBox('文件池正在维护','请等待备份或迁移完成；也可在文件池管理中取消操作。');return;}
  closePrompt = true;
  try {
    for (const [id, time] of recentTransfers) if (Date.now() - time >= 1500) recentTransfers.delete(id);
    const busy = remoteManager?.busy || activeIncoming || incomingQueue.length || activeSave || queue.length || rendererActivity.uploads || rendererActivity.verifications || activeRequests || recentTransfers.size;
    if (busy && mainWindow && !mainWindow.isDestroyed()) {
      focusWindow();
      const result = await dialog.showMessageBox(mainWindow, { type: 'question', title: '结束传输并退出？', message: '仍有文件正在传输、保存或校验。', detail: '退出会停止当前操作。中转站内已完成的文件和上传断点会保留，尚未完成的本地保存会取消。', buttons: ['继续使用', '停止并退出'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response !== 1) return;
    }
    await shutdown();
  } finally { closePrompt = false; }
}
async function shutdown() {
  if (quitting) return quitting;
  shuttingDown = true;
  clearTimeout(notificationTimer); pendingNotifications.clear();
  for (const pending of incomingQueue.splice(0)) { pending.controller.abort(); finishIncoming(pending, 'cancelled'); }
  activeIncoming?.controller.abort();
  quitting = (async () => {
    queue.splice(0).forEach(job => { job.controller.abort(); job.resolve(job.kind === 'batch' ? finishBatch(job) : emit(job, 'cancelled')); });
    const job = activeSave; job?.controller.abort(); job?.activeChild?.controller.abort();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    const timeout = setTimeout(() => app.exit(0), 8000); timeout.unref();
    try {
      const pending = [job?.promise, activeIncoming?.promise].filter(Boolean);
      if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise(resolve => setTimeout(resolve, 3500))]);
      if (tray && !tray.isDestroyed()) tray.destroy(); tray = null;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      if (remoteManager) await remoteManager.close();
      if (relay) { relay.server.closeAllConnections(); await relay.close(); }
    } finally { clearTimeout(timeout); app.exit(0); }
  })();
  return quitting;
}
function createWindow() {
  const desktopSession = session.fromPartition('persist:relaydrop-desktop');
  const trustedContents = contents => mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents && allowedDocument(contents.getURL());
  desktopSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(
    permission === 'clipboard-sanitized-write' && !!trustedContents(contents) && details.isMainFrame !== false && allowedDocument(details.requestingUrl || contents.getURL())));
  desktopSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (permission !== 'clipboard-sanitized-write' || !trustedContents(contents)) return false;
    try { return new URL(requestingOrigin).origin === origin; } catch { return false; }
  });
  desktopSession.on('will-download', (event, item, contents) => {
    const url = item.getURL(); event.preventDefault();
    if (!trustedContents(contents)) return;
    const schedule = fileId => { void (async()=>{if(interfaceLocked)return;const event={sender:contents,senderFrame:contents.mainFrame};const token=await pageCredential(event),current=await api('/api/state','GET',undefined,token);return enqueue(fileId,crypto.randomUUID(),token,current.security.serverId+':'+current.device.id);})().catch(error => dialog.showErrorBox('无法保存文件', error.message)); };
    try {
      const parsed = new URL(url); if (parsed.origin !== origin) return;
      if (parsed.pathname === '/RelayDrop-Android.apk') { schedule('installer'); return; }
      const match = parsed.pathname.match(/^\/api\/files\/([a-f0-9-]+)\/content$/i);
      if (match && UUID.test(match[1])) schedule(match[1]);
    } catch { }
  });
  mainWindow = new BrowserWindow({ width: 1200, height: 820, minWidth: 1100, minHeight: 760, title: buildIdentity.productName + ' 中转站', show: false,
    backgroundColor: '#f4f7f7', icon: path.join(__dirname, 'assets', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, backgroundThrottling: false, partition: 'persist:relaydrop-desktop', devTools: !app.isPackaged } });
  mainWindow.removeMenu(); Menu.setApplicationMenu(null);
  mainWindow.once('ready-to-show', () => { if (interfaceLocked) privateUI?.show('lock',{title:'互联 · 界面已锁定'}); else if (!startupBackground || !tray || tray.isDestroyed() || incomingQueue.length) focusWindow(); });
  mainWindow.on('close', event => { if (!shuttingDown) { event.preventDefault(); void handleWindowClose().catch(error => dialog.showErrorBox('无法关闭窗口', error.message)); } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!allowedDocument(url)) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('will-prevent-unload', event => event.preventDefault());
  mainWindow.webContents.on('page-title-updated', event => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', () => { rendererActivity = { uploads: 0, verifications: 0 }; });
  void mainWindow.loadURL(origin + '/#host=' + relay.hostToken).catch(error => { dialog.showErrorBox('无法打开中转站界面', error.message); void shutdown(); });
}

function incomingEvent(job, status, extra = {}) {
  job.event = { requestId: job.requestId, context: job.context || relay.identity.id + ':host', status, name: job.name || '', total: job.paths.length, completed: job.completed, skipped:job.skipped||0, failed: job.failed, cancelled: job.cancelled, transferred: 0, size: 0, ...extra };
  sendScoped('relay:incoming-progress',job.event,job.token);
  return job.event;
}
function finishIncoming(job, status, error) {
  job.cancelled = Math.max(0, job.paths.length - job.completed - (job.skipped||0) - job.failed);
  return incomingEvent(job, status, error ? { error } : {});
}
function receiveArguments(argv) {
  if (shuttingDown || storageBusy) return;
  let paths;
  try { paths = parseSendArguments(argv); } catch (error) { if (app.isReady()) dialog.showErrorBox('无法发送所选文件', error.message); return; }
  if (!paths.length) return;
  if (incomingQueue.length >= 10) { dialog.showErrorBox('发送队列已满', '请等待当前系统发送任务完成后重试。'); return; }
  const job = { requestId: crypto.randomUUID(), paths, completed: 0, failed: 0, cancelled: 0, controller: new AbortController() };
  incomingJobs.set(job.requestId, job);
  if (incomingJobs.size > 30) { const old = [...incomingJobs].find(([, item]) => ['completed', 'failed', 'cancelled'].includes(item.event?.status)); if (old) incomingJobs.delete(old[0]); }
  incomingQueue.push(job); incomingEvent(job, 'queued'); void pumpIncoming();
}
async function runIncoming(job) {
  try {
    abortIncoming(job);
    const state = await api('/api/state', 'GET', undefined, job.token);
    const files = job.files || await inspectFiles(job.paths, [userData, activeDataDir, app.getAppPath()], state.limits?.maxFileSize);
    await waitUnlocked(job.controller.signal);abortIncoming(job); focusWindow(); incomingEvent(job, 'confirming');
    if (job.parentId && !state.folders?.some(folder => folder.id === job.parentId)) throw new Error('目标目录已不存在，请重新选择目录后发送。');
    const targetPath = require('../shared-folders.cjs').trail(state.folders || [], job.parentId || null).map(folder => folder.name).join(' / ');
    const detail = '目标目录：共享文件池' + (targetPath ? ' / ' + targetPath : '') + '\n\n' + files.slice(0, 8).map(file => file.path).join('\n') + (files.length > 8 ? '\n……另外 ' + (files.length - 8) + ' 个文件' : '');
    const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: '发送资源管理器中的文件', message: '将 ' + files.length + ' 个文件'+(job.directories?'和 '+job.directories.length+' 个目录':'')+'上传到这台电脑的共享文件池？',
      detail: '上传后，已配对的手机和平板可以下载。原文件会保留。\n\n' + detail, buttons: ['取消', '确认发送'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) job.controller.abort();
    abortIncoming(job);
    if(job.directories){incomingEvent(job,'organizing');const folderIds=new Map();for(const parts of job.directories){abortIncoming(job);const result=await api('/api/folders/ensure','POST',{parentId:job.parentId,path:parts},job.token);folderIds.set(JSON.stringify(parts),result.folderId);}for(const file of files)file.folderId=folderIds.get(JSON.stringify(file.relativeDirectories));}
    let lastError;
    for (const file of files) {
      if (job.controller.signal.aborted || shuttingDown) break;
      job.name = file.name;
      try {
        const uploaded=await uploadLocalFile(file,{origin,token:job.token||relay.hostToken,signal:job.controller.signal,onProgress:event=>incomingEvent(job,event.status,event),onDuplicate:async(item,matches)=>{if(job.duplicateDecision)return job.duplicateDecision;await waitUnlocked(job.controller.signal);abortIncoming(job);incomingEvent(job,'duplicate');const answer=await dialog.showMessageBox(mainWindow,{type:'question',title:'文件池已有相同文件',message:item.name+' 已有完整副本',detail:'同一接收范围和共享目录已有 '+matches[0].name+'。跳过可节省传输；仍然上传会保存独立副本。',buttons:['跳过上传','仍然上传','取消剩余任务'],defaultId:0,cancelId:2,noLink:true,checkboxLabel:'对本批次的重复文件使用相同选择',checkboxChecked:false});if(answer.response===2){job.controller.abort();return 'cancel';}const choice=answer.response===1?'upload':'skip';if(answer.checkboxChecked)job.duplicateDecision=choice;return choice;}});
        if(uploaded.skipped)job.skipped=(job.skipped||0)+1;else job.completed++;
      } catch (error) {
        if (job.controller.signal.aborted || error.name === 'AbortError') break;
        job.failed++; lastError = error.message;
      }
    }
    const status = job.controller.signal.aborted || shuttingDown ? 'cancelled' : job.failed ? 'failed' : 'completed';
    return finishIncoming(job, status, lastError);
  } catch (error) {
    return finishIncoming(job, job.controller.signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed', error.message);
  }
}
function abortIncoming(job) { if (job.controller.signal.aborted || shuttingDown) throw Object.assign(new Error('已取消发送'), { name: 'AbortError' }); }
async function pumpIncoming() {
  if (interfaceLocked || !relay || !mainWindow || mainWindow.isDestroyed() || activeIncoming || shuttingDown || storageBusy || !incomingQueue.length) return;
  const job = incomingQueue.shift(); activeIncoming = job;
  try { job.promise = runIncoming(job); await job.promise; }
  finally { activeIncoming = null; void pumpIncoming(); }
}



async function chooseFolderUpload(event,request){
  if(!trusted(event)||!request||typeof request!=='object'||!credential(request.token)||request.folderId!==null&&request.folderId!==undefined&&(typeof request.folderId!=='string'||!UUID.test(request.folderId)))throw new Error('目录请求无效。');
  if(storageBusy||shuttingDown)throw new Error('文件池维护中，请稍后再试。');
  if(!await samePageCredential(event,request.token))throw new Error('页面身份已变化。');
  await api('/api/state','GET',undefined,request.token);if(!await samePageCredential(event,request.token))throw new Error('页面身份已变化。');
  const selection=await dialog.showOpenDialog(mainWindow,{title:'选择要发送的整个文件夹',properties:['openDirectory','dontAddToRecent']});
  if(selection.canceled||!selection.filePaths?.[0])return {cancelled:true};
  if(!await samePageCredential(event,request.token)||storageBusy||shuttingDown)throw new Error('文件池页面已关闭、身份变化或正在维护。');
  const current=await api('/api/state','GET',undefined,request.token);if(request.folderId&&!current.folders?.some(f=>f.id===request.folderId))throw new Error('目标目录已不存在。');
  const scan=await inspectDirectory(selection.filePaths[0],[userData,activeDataDir,app.getAppPath()],current.limits?.maxFileSize);
  const parentTrail=require('../shared-folders.cjs').trail(current.folders||[],request.folderId||null).map(f=>f.name);
  for(const parts of scan.directories){const combined=[...parentTrail,...parts];if(combined.length>32||combined.join('/').length>1024)throw new Error('目标目录过深，完整目录路径超过32层或1024字符；请选择更靠近根目录的位置。');}
  if(!await samePageCredential(event,request.token)||storageBusy||shuttingDown)throw new Error('文件池页面已关闭、身份变化或正在维护。');
  if(incomingQueue.length>=10)throw new Error('发送队列已满。');
  const job={requestId:crypto.randomUUID(),token:request.token,context:current.security.serverId+':'+current.device.id,paths:scan.files.map(f=>f.path),files:scan.files,directories:scan.directories,parentId:request.folderId||null,completed:0,skipped:0,failed:0,cancelled:0,controller:new AbortController()};
  incomingJobs.set(job.requestId,job);incomingQueue.push(job);incomingEvent(job,'queued');void pumpIncoming();return {requestId:job.requestId};
}

async function chooseFilesUpload(event, request) {
  if (!trusted(event) || !request || typeof request !== 'object' || Array.isArray(request) || !credential(request.token) || Object.keys(request).some(key => !['folderId', 'targetId', 'token'].includes(key))
      || request.folderId != null && (typeof request.folderId !== 'string' || !UUID.test(request.folderId)) || request.targetId != null) throw new Error('快捷添加仅支持有效的共享目录。');
  if (storageBusy || shuttingDown) throw new Error('文件池维护中，请稍后再试。');
  if (!await samePageCredential(event, request.token)) throw new Error('文件池登录状态已变化，请重试。');
  const before = await api('/api/state', 'GET', undefined, request.token), scope = JSON.stringify(savedCopyContext(before));
  if(!await samePageCredential(event,request.token))throw new Error('页面身份已变化。');
  if (request.folderId && !before.folders?.some(folder => folder.id === request.folderId)) throw new Error('目标目录已不存在。');
  const selection = await dialog.showOpenDialog(mainWindow, { title: '添加文件到当前目录', properties: ['openFile', 'multiSelections', 'dontAddToRecent'] });
  if (selection.canceled || !selection.filePaths?.length) return { cancelled: true };
  if (!await samePageCredential(event, request.token) || storageBusy || shuttingDown) throw new Error('文件池页面已关闭、登录状态变化或正在维护。');
  const current = await api('/api/state', 'GET', undefined, request.token);
  if (JSON.stringify(savedCopyContext(current)) !== scope) throw new Error('文件池身份已变化，请重新选择。');
  if (request.folderId && !current.folders?.some(folder => folder.id === request.folderId)) throw new Error('目标目录已不存在。');
  const paths = parseSendArguments(['--send', ...selection.filePaths]);
  const files = (await inspectFiles(paths, [userData, activeDataDir, app.getAppPath()], current.limits?.maxFileSize)).map(file => ({ ...file, folderId: request.folderId || null }));
  if (!await samePageCredential(event, request.token) || storageBusy || shuttingDown) throw new Error('文件池页面已关闭、登录状态变化或正在维护。');
  if (incomingQueue.length >= 10) throw new Error('发送队列已满。');
  const job = { requestId: crypto.randomUUID(), token: request.token, context:current.security.serverId+':'+current.device.id, paths, files, parentId: request.folderId || null, completed: 0, skipped: 0, failed: 0, cancelled: 0, controller: new AbortController() };
  incomingJobs.set(job.requestId, job);
  if (incomingJobs.size > 30) { const old = [...incomingJobs].find(([, item]) => ['completed', 'failed', 'cancelled'].includes(item.event?.status)); if (old) incomingJobs.delete(old[0]); }
  incomingQueue.push(job); incomingEvent(job, 'queued'); void pumpIncoming(); return { requestId: job.requestId };
}

async function savedCopyAction(event, request, action) {
  if (!trusted(event) || !request || typeof request !== 'object' || Array.isArray(request) || !credential(request.token) || Object.keys(request).some(key => !(action === 'list' ? ['fileIds', 'token'] : ['fileId', 'sha256', 'token']).includes(key))) throw new Error('本机副本请求无效。');
  if (storageBusy || shuttingDown) throw new Error('文件池正在维护或关闭。');
  if (action !== 'list') {
    const activated = await event.sender.executeJavaScriptInIsolatedWorld(1001, [{ code: 'navigator.userActivation.isActive' }]);
    if (!activated || !trusted(event)) throw new Error('请点击对应文件后再打开。');
  }
  activeRequests++;
  try {
    const state = await api('/api/state', 'GET', undefined, request.token), scope = JSON.stringify(savedCopyContext(state));
    const result = action === 'list' ? await savedCopies.list(state, request.fileIds) : await savedCopies.resolve(state, request.fileId, request.sha256);
    const current = await api('/api/state', 'GET', undefined, request.token);
    if (!await samePageCredential(event, request.token) || storageBusy || shuttingDown || scope !== JSON.stringify(savedCopyContext(current))) throw new Error('文件池页面或设备身份已变化。');
    if (action === 'list') return { files: result.files.filter(record => current.files?.some(file => file.id === record.fileId && file.sha256 === record.sha256)) };
    if (!current.files?.some(file => file.id === request.fileId && file.sha256 === request.sha256)) throw new Error('当前文件已移除或访问权限已变化。');
    if (action === 'reveal') { shell.showItemInFolder(result); return { revealed: true }; }
    if (!await confirmOpen(dialog, mainWindow, result)) return { opened:false, cancelled:true };
    const confirmed = await api('/api/state','GET',undefined,request.token);
    if (!await samePageCredential(event,request.token) || scope !== JSON.stringify(savedCopyContext(confirmed))) throw new Error('页面或设备身份已变化。');
    const verified = await savedCopies.resolve(confirmed,request.fileId,request.sha256);
    if(!await samePageCredential(event,request.token)||storageBusy||shuttingDown)throw new Error('页面或设备身份已变化。');
    const error = await shell.openPath(verified);
    if (error) throw new Error('无法打开本机副本，请检查默认应用或从保存位置打开。');
    return { opened: true };
  } finally { activeRequests--; }
}


let lastStorageResult=null;
function storageState(){return {dataDir:activeDataDir,busy:storageBusy,lastResult:lastStorageResult};}
function storageProgress(value){sendScoped('relay:storage-progress',value);}
function localWorkBusy(){return activeIncoming||incomingQueue.length||activeSave||queue.length||rendererActivity.uploads||rendererActivity.verifications||activeRequests||remoteManager?.busy;}
async function writeDataPointer(directory){
 const temporary=dataPointer+'.'+crypto.randomUUID()+'.tmp';let handle;
 try{handle=await fsp.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify({version:1,dataDir:directory}));await handle.sync();await handle.close();handle=null;await fsp.rename(temporary,dataPointer);}finally{await handle?.close().catch(()=>{});await fsp.unlink(temporary).catch(()=>{});}
}
async function storageAction(event,request){
 if(!trusted(event)||!request||typeof request!=='object'||!['state','open','backup','restore','migrate','cancel'].includes(request.action))throw new Error('文件池管理请求无效。');
 const owner=await authorizeHost(event),guard=()=>authorizeHost(event,owner);
 const sourceWindow=mainWindow,sourceFrame=event.senderFrame,sourceOrigin=origin;
 const sameSource=()=>{if(interfaceLocked||shuttingDown||mainWindow!==sourceWindow||sourceWindow.isDestroyed()||event.sender!==sourceWindow.webContents||sourceFrame!==sourceWindow.webContents.mainFrame)return false;try{const url=new URL(sourceFrame.url);return url.origin===sourceOrigin&&['/','/index.html'].includes(url.pathname);}catch{return false;}};
 const refreshAfterMaintenance=async()=>{if(!sameSource())return;let current;try{current=await event.sender.executeJavaScriptInIsolatedWorld(1002,[{code:"(()=>{try{return sessionStorage.getItem('relay-host-token')||localStorage.getItem('relay-guest-token');}catch{return null;}})()"}]);}catch{return;}if(current===owner&&sameSource())await sourceWindow.loadURL(origin+'/#host='+relay.hostToken);};
 if(request.action==='state')return storageState();
 if(request.action==='cancel'){storageController?.abort();return {cancelRequested:!!storageController};}
 if(request.action==='open'){const stat=await fsp.lstat(activeDataDir),real=await fsp.realpath(activeDataDir);if(!stat.isDirectory()||stat.isSymbolicLink()||real.toLowerCase()!==path.resolve(activeDataDir).toLowerCase())throw new Error('文件池目录已被移动或替换，请检查存储位置。');await guard();const error=await shell.openPath(real);if(error)throw new Error(error);return storageState();}
 if(storageBusy||shuttingDown||localWorkBusy())throw new Error('仍有传输、保存或校验任务，请全部结束后再管理文件池。');
 const action=request.action,title={backup:'备份文件池',restore:'恢复文件池备份',migrate:'迁移文件池'}[action];
 const selection=await dialog.showOpenDialog(mainWindow,{title:action==='restore'?'选择 RelayDrop 备份目录':title+'：选择目标父目录',defaultPath:app.getPath('documents'),properties:['openDirectory','createDirectory','dontAddToRecent']});
 if(selection.canceled||!selection.filePaths?.[0])return {cancelled:true};
 await guard();
 if(!trusted(event)||shuttingDown||storageBusy||localWorkBusy())throw new Error('文件池状态已变化，请结束当前任务后重试。');
 const destination=await checkedDirectory(selection.filePaths[0]);
 await guard();
 let password;
 if(action==='backup'&&request.encrypted===true)password=await privateUI.prompt({title:'设置加密备份密码',confirm:true,parent:mainWindow});
 if(action==='restore'){try{await require('../pool-storage.cjs').readBackup(destination);}catch(error){if(error.code!=='PASSWORD_REQUIRED')throw new Error('备份目录不完整、不可读或校验未通过，请重新选择完整备份目录。');await guard();password=await privateUI.prompt({title:'输入加密备份密码',confirm:false,parent:mainWindow});}}
 await guard();
 const detail=action==='restore'?'备份将追加导入当前文件池，不覆盖已有资料或设备身份。备份中的共享文件会向当前已配对设备共享；私人文件只对本机管理员可见。':action==='migrate'?'复制并校验到新目录后才切换位置；原数据目录完整保留。请勿手动同时运行两个副本。':'会创建一个包含原文件名、共享目录层级和校验清单的备份目录。备份中包含本机管理的私人文件，请保存在自己控制的位置。';
 const answer=await dialog.showMessageBox(mainWindow,{type:'question',title,message:title+'会短暂停止设备连接',detail:detail+'\n\n目标：'+destination+'\n\n完成后局域网共享自动恢复；远程共享需要重新启用。',buttons:['取消',title],defaultId:0,cancelId:0,noLink:true});
 if(answer.response!==1)return {cancelled:true};
 await guard();
 if(!trusted(event)||shuttingDown||storageBusy||localWorkBusy())throw new Error('仍有任务在执行，请稍后重试。');
 storageBusy=true;storageController=new AbortController();lastStorageResult=null;storageProgress({phase:'stopping',completed:0,total:1,bytes:0});
 const original=activeDataDir,oldIdentity=relay.identity.id;let result,error,started=false,closedForStorage=false;
 try{
  await remoteManager?.suspendForMaintenance();relay.server.closeAllConnections();closedForStorage=true;await relay.close();
  storageController.signal.throwIfAborted();
  const core=require('../pool-storage.cjs'),common={dataDir:original,onProgress:storageProgress,signal:storageController.signal,...(password?{password}:{})};
  result=action==='backup'?await core.exportBackup({...common,destination}):action==='restore'?await core.restoreBackup({...common,backupDir:destination}):await core.migrateData({...common,destination});
  activeDataDir=action==='migrate'?result.dataDir:original;
  await startRelay();started=true;
  if(relay.identity.id!==oldIdentity)throw new Error('设备身份校验失败，正在恢复原目录。');
  if(action==='migrate')await writeDataPointer(activeDataDir);
  lastStorageResult={action,success:true,path:result.path||result.dataDir||original,files:result.files||0,mergedPaths:!!result.mergedPaths};
 }catch(failure){
  error=failure;
  if(started){relay.server.closeAllConnections();await relay.close().catch(()=>{});}
  activeDataDir=original;
  try{if(closedForStorage)await startRelay();started=true;}catch(restartError){started=false;error=new Error(failure.message+'；恢复原文件池启动失败：'+restartError.message);}
  if(result&&action!=='migrate'){
   const warning=(action==='restore'?'备份内容已经导入并校验，请勿再次导入。':'备份已经生成并校验。')+(started?'共享服务现已恢复。':'共享服务未能启动，请保留数据并重新启动程序。')+' 启动详情：'+error.message;
   lastStorageResult={action,success:true,operationCommitted:true,path:result.path||original,files:result.files||0,mergedPaths:!!result.mergedPaths,warning};error=new Error(warning);
  }else lastStorageResult={action,success:false,error:failure.name==='AbortError'?'操作已取消；原文件池已保留。':error.message};
 }finally{
  password=undefined;storageBusy=false;storageController=null;
  if(started){remoteManager?.replaceRelay(relay);storageProgress({phase:error?'failed':'completed',...lastStorageResult});setTimeout(()=>{void refreshAfterMaintenance().catch(()=>{});},400);}
  else{storageProgress({phase:'failed',...lastStorageResult});dialog.showErrorBox('文件池未能恢复运行',error?.message||'请保留原数据目录后重新启动。');}
 }
 if(error)throw error;return {...storageState(),result};
}

let initialSendFiles = [], initialSendError;
try { initialSendFiles = parseSendArguments(process.argv); } catch (error) { initialSendError = error.message; }
// Electron may reorder argv and add Chromium switches to second-instance events.
// Preserve the already validated OS selection as structured lock data, then validate again.
if (!app.requestSingleInstanceLock({ sendFiles: initialSendFiles, sendError: initialSendError })) { app.quit(); }
else {
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    focusWindow();
    if (Array.isArray(additionalData?.sendFiles) && additionalData.sendFiles.length) receiveArguments(['--send', ...additionalData.sendFiles]);
    else if (additionalData?.sendError) dialog.showErrorBox('无法发送所选文件', '所选路径无效，请重新从资源管理器选择本机普通文件。');
  });
  app.on('activate', focusWindow);
  app.on('before-quit', event => { if (!shuttingDown) { event.preventDefault(); void requestClose(); } });
  app.on('window-all-closed', () => { if (!shuttingDown) void shutdown(); });
  ipcMain.handle('relay:choose-folder-upload',chooseFolderUpload);
  ipcMain.handle('relay:choose-files-upload', chooseFilesUpload);
  ipcMain.handle('relay:saved-copies', (event, request) => savedCopyAction(event, request, 'list'));
  ipcMain.handle('relay:open-saved-copy', (event, request) => savedCopyAction(event, request, 'open'));
  ipcMain.handle('relay:reveal-saved-copy', (event, request) => savedCopyAction(event, request, 'reveal'));
  ipcMain.handle('relay:pool-storage',storageAction);
  ipcMain.handle('relay:save-file', async (event, request) => {
    if (!trusted(event)) throw new Error('无权访问桌面保存功能。');
    if (!request || typeof request !== 'object' || !credential(request.token)) throw new Error('文件请求无效。');
    if(!await samePageCredential(event,request.token))throw new Error('页面身份已变化。');const current=await api('/api/state','GET',undefined,request.token);
    if(!await samePageCredential(event,request.token))throw new Error('页面身份已变化。');
    return enqueue(request.fileId, request.requestId, request.token,current.security.serverId+':'+current.device.id);
  });
  ipcMain.handle('relay:save-batch', async (event, request) => {
    if (!trusted(event)) throw new Error('无权访问桌面保存功能。');
    if (!request || typeof request !== 'object' || !credential(request.token)) throw new Error('批量请求无效。');
    if(!await samePageCredential(event,request.token))throw new Error('页面身份已变化。');const current=await api('/api/state','GET',undefined,request.token);
    if(!await samePageCredential(event,request.token))throw new Error('页面身份已变化。');
    return enqueueBatch(request.fileIds, request.requestId, request.token,current.security.serverId+':'+current.device.id);
  });
  ipcMain.handle('relay:save-folder',async(event,request)=>{
    if(!trusted(event)||!request||!credential(request.token)||!await samePageCredential(event,request.token))throw new Error('目录保存请求无效。');
    const current=await api('/api/state','GET',undefined,request.token),plan=planFolder(current,request.folderId??null);
    if(!await samePageCredential(event,request.token))throw new Error('页面身份已变化。');
    return enqueueBatch(plan.files.map(file=>file.fileId),request.requestId,request.token,current.security.serverId+':'+current.device.id,plan);
  });
  ipcMain.handle('relay:get-settings', async event => { await authorizeHost(event); return currentSettings(); });
  ipcMain.handle('relay:update-settings', async (event, patch) => {
    const owner=await authorizeHost(event);
    if (!trusted(event) || !patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
      || Object.keys(patch).some(key => !['closeToTray', 'saveMode', 'launchAtLogin'].includes(key))
      || Object.hasOwn(patch, 'closeToTray') && typeof patch.closeToTray !== 'boolean'
      || Object.hasOwn(patch, 'saveMode') && !['ask', 'fixed'].includes(patch.saveMode)
      || Object.hasOwn(patch, 'launchAtLogin') && typeof patch.launchAtLogin !== 'boolean') throw new Error('桌面设置无效。');
    if (patch.saveMode === 'fixed') await fixedDirectory();
    await authorizeHost(event,owner);
    if (Object.hasOwn(patch, 'launchAtLogin')) {
      if (!installedDesktop()) throw new Error('开机启动需要安装版；便携版不会注册临时程序路径。');
      app.setLoginItemSettings({ ...loginOptions(), openAtLogin: patch.launchAtLogin, name: buildIdentity.productName });
      if (app.getLoginItemSettings(loginOptions()).openAtLogin !== patch.launchAtLogin) throw new Error('Windows 没有应用开机启动设置，请检查系统启动应用设置。');
    }
    const persisted = { ...patch }; delete persisted.launchAtLogin;
    if (Object.keys(persisted).length) settings.update(persisted);
    notifySettings(); return currentSettings();
  });
  ipcMain.handle('relay:choose-directory', async event => {
    const owner=await authorizeHost(event);
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择固定接收文件夹', defaultPath: settings.get().receiveDirectory || await preferredDirectory(), properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] });
    if (result.canceled || !result.filePaths?.[0]) {await authorizeHost(event,owner);return currentSettings();}
    const directory = await checkedDirectory(result.filePaths[0]);
    await authorizeHost(event,owner);
    settings.update({ receiveDirectory: directory, lastSaveDirectory: directory }); notifySettings(); return currentSettings();
  });
  ipcMain.handle('relay:clear-directory', async event => {
    await authorizeHost(event);
    settings.update({ receiveDirectory: null, saveMode: 'ask' }); notifySettings(); return currentSettings();
  });
  ipcMain.handle('relay:reveal-saved', async (event, requestId) => {
    if (!trusted(event) || typeof requestId !== 'string' || !UUID.test(requestId) || !savedFiles.has(requestId)) throw new Error('只能打开本次已保存文件所在的位置。');
    const record=savedFiles.get(requestId),token=await pageCredential(event);if(token!==(record.token||relay.hostToken))throw new Error('保存记录不属于当前设备。');await api('/api/state','GET',undefined,token);
    const saved = record.path, stat = await fsp.lstat(saved).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || (await fsp.realpath(saved)).toLowerCase() !== saved.toLowerCase()) throw new Error('保存文件已被移动、删除或替换。');
    if (!await samePageCredential(event,token)) throw new Error('文件页面已关闭。');
    shell.showItemInFolder(saved); return true;
  });
  ipcMain.handle('relay:incoming-status', async event => {
    const token=await pageCredential(event);await api('/api/state','GET',undefined,token);if(!await samePageCredential(event,token))throw new Error('页面身份已变化。');
    return [...incomingJobs.values()].filter(job=>(job.token||relay.hostToken)===token).map(job => job.event);
  });
  ipcMain.handle('relay:cancel-incoming', async (event, requestId) => {
    if (!trusted(event) || typeof requestId !== 'string' || !UUID.test(requestId)) return false;
    const job = incomingJobs.get(requestId);
    if (!job || ['completed', 'cancelled', 'failed'].includes(job.event.status)) return false;
    if(!await samePageCredential(event,job.token||relay.hostToken))return false;
    job.controller.abort();
    const queued = incomingQueue.indexOf(job);
    if (queued >= 0) { incomingQueue.splice(queued, 1); finishIncoming(job, 'cancelled'); }
    return true;
  });
  ipcMain.handle('relay:open-external', async (event, value) => {
    if (!trusted(event) || typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f-\x9f\\]/.test(value)) throw new Error('链接无效。');
    let url; try { url = new URL(value); } catch { throw new Error('链接无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('仅支持不含账号密码的网页链接。');
    const activated = await event.sender.executeJavaScriptInIsolatedWorld(1001, [{ code: 'navigator.userActivation.isActive' }]);
    if (!activated || !trusted(event)) throw new Error('请点击链接后再打开。');
    await shell.openExternal(url.href); return true;
  });
  ipcMain.handle('relay:cancel-save', async (event, requestId) => {const job=[activeSave,...queue].find(job=>job&&(job.requestId===requestId||job.activeChild?.requestId===requestId));return !!job&&await samePageCredential(event,job.token||relay.hostToken)&&cancel(requestId);});
  ipcMain.on('relay:activity', (event, activity) => {
    if (!trusted(event) || !activity || typeof activity !== 'object') return;
    rendererActivity = { uploads: Math.min(1000, Math.max(0, Number(activity.uploads) || 0)), verifications: Math.min(1000, Math.max(0, Number(activity.verifications) || 0)) };
  });
  ipcMain.handle('relay:lock-action',async(event,request)=>{if(!request||!['state','configure','lock'].includes(request.action))throw new Error('界面锁操作无效。');await authorizeHost(event);if(request.action==='state')return{...interfaceLock.state(),locked:interfaceLocked};if(request.action==='configure'){privateUI.show('settings',{title:'本机界面锁'});return{opened:true};}return lockInterface();});
  ipcMain.handle('relay:sharing-action',async(event,request)=>{const owner=await authorizeHost(event);if(!request||!['state','pause','resume'].includes(request.action))throw new Error('共享操作无效。');if(request.action==='state')return relay.getSharingState();await authorizeHost(event,owner);await relay.setSharingPaused(request.action==='pause');if(request.action==='pause')await remoteManager?.pauseSharing();updateTrayMenu();return relay.getSharingState();});
  ipcMain.handle('relay:open-local-library',async event=>{if(!mainWindow||event.sender!==mainWindow.webContents||event.senderFrame!==mainWindow.webContents.mainFrame||!allowedDocument(event.senderFrame.url))throw new Error('本机入口来源无效。');if(interfaceLocked){showLocalLibrary();return{locked:true};}try{await authorizeHost(event);}catch{if(interfaceLock.state().configured){afterUnlock=()=>privateUI.show('library',{title:'本机已保存文件'});lockInterface();return{locked:true};}const answer=await dialog.showMessageBox(mainWindow,{type:'question',title:'打开这台电脑保存的文件',message:'本机文件包含这台 Windows 账号保存的副本。',detail:'此页面只在本机显示，不向当前文件池分享。建议设置界面锁保护入口。',buttons:['取消','打开本机文件'],defaultId:0,cancelId:0,noLink:true});if(answer.response!==1)return{cancelled:true};}showLocalLibrary();return{opened:true};});
  app.whenReady().then(async () => { initializePrivateUI();await startRelay(); remoteManager = require('./remote-manager.cjs').createRemoteManager({ electron: require('electron'), relay, userData, savedCopies, mainWindow: () => mainWindow, trusted, authorizeHost,sendMainScoped:sendScoped,isLocked:()=>interfaceLocked,waitUnlocked, checkedDirectory, preferredDirectory, uniqueDestination, suggestedFileName }); createWindow(); createTray(); receiveArguments(process.argv); void pumpIncoming(); }).catch(error => {
    dialog.showErrorBox('RelayDrop 启动失败', error.code === 'EADDRINUSE' ? '端口 8765–8775 均被占用，请关闭其他中转程序后重试。' : error.message || '无法启动本地中转站。');
    void shutdown();
  });
}
