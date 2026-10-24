'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { RemoteHost, createRemoteTunnel } = require('../remote/client.cjs');
const protocol = require('../remote/protocol.cjs');
const { certificatePemMatches, pinnedFetch, encryptedStore } = require('./remote-security.cjs');
const { saveVerifiedFile } = require('./verified-save.cjs');
const { createSavedCopies, context: savedCopyContext } = require('./saved-copies.cjs');
const { confirmOpen } = require('./open-risk.cjs');
const { planFolder, materialize } = require('./save-folder.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const credential = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
async function boundedJson(response, maximum) { const reader = response.body?.getReader(); if (!reader) throw new Error('远程响应为空。'); const chunks = []; let total = 0; try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > maximum) { await reader.cancel(); throw new Error('远程响应过大。'); } chunks.push(Buffer.from(value)); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); } finally { reader.releaseLock(); } }

function createRemoteManager({ electron, relay, userData, savedCopies = createSavedCopies(userData), mainWindow, trusted, authorizeHost, sendMainScoped, isLocked = () => false, waitUnlocked=async()=>{}, checkedDirectory, preferredDirectory, uniqueDestination, suggestedFileName }) {
  const { BrowserWindow, session, ipcMain, dialog, safeStorage, clipboard, shell } = electron;
  const store = encryptedStore(userData, safeStorage), viewers = new Map(), closingViews = new Set(), pendingTunnels = new Set();
  let data = { version: 1, host: null, profiles: [] }, loadError = '', host, endpoint, stopped = false, busy = false, hostState = 'unconfigured', hostError = '';
  try { data = store.read(); if (data.host) hostState = 'stopped'; } catch { loadError = '远程配置无法读取，已停止远程功能。请保留原配置并检查 Windows 凭据保护。'; }
  let serial = Promise.resolve(), maintenance = false;
  const exclusive = action => { const run = serial.then(action); serial = run.catch(() => {}); return run; };
  const saveData = value => { if (loadError) throw new Error(loadError); store.write(value); data = value; };
  function state() {
    return { configured: !!data.host, state: hostState, error: loadError || hostError, enabled: !!host && !host.stopped,
      relay: data.host?.relay || '', relayFingerprint: data.host?.relayFingerprint || '', credentialSaved: !!data.host?.serviceKey,
      profiles: data.profiles.map(p => ({ id: p.invite.serverId, fingerprint: p.invite.fingerprint, relay: p.invite.relay, connected: viewers.has(p.invite.serverId) })) };
  }
  function notify() { sendMainScoped?.('relay:remote-changed', state()); }
  async function stopHost() {
    const previous = host; host = null;
    if (previous) await previous.close();
    const previousEndpoint = endpoint; endpoint = null; if (previousEndpoint) await previousEndpoint.close();
    hostState = data.host ? 'stopped' : 'unconfigured'; hostError = ''; notify();
  }
  async function startHost(guard = async () => {}) {
    if (stopped) throw new Error('程序正在退出。');
    if (loadError) throw new Error(loadError); if (!data.host) throw new Error('请先保存中继连接配置。');
    await stopHost(); await guard(); if (relay.getSharingState?.().paused) throw new Error('外部共享已暂停，请先恢复共享。'); if (stopped) throw new Error('程序正在退出。'); endpoint = await relay.openRemoteEndpoint();
    if (stopped) { await endpoint.close(); endpoint = null; throw new Error('程序正在退出。'); }
    try {
      await guard(); host = new RemoteHost({ ...data.host, localPort: endpoint.port }, { registerPeer: (port, peerId) => endpoint.registerPeer?.(port, peerId) });
      const current = host;
      host.on('status', info => { if (host !== current) return; hostState = info.state; hostError = info.error ? info.state === 'error' ? '中继拒绝连接或证书不匹配。请检查地址、凭据和指纹，再重新启用。' : '连接中继未成功，正在等待重试。请检查地址、凭据与网络。' : ''; notify(); });
      hostState = 'connecting'; notify(); host.start();
    } catch (error) { await stopHost(); throw error; }
    return state();
  }
  function hostInvite() {
    if (!data.host || !host || hostState !== 'online') throw new Error('中继尚未连接，连接成功后才能复制邀请。');
    return protocol.encodeInvite({ v: 1, relay: data.host.relay, relayFingerprint: data.host.relayFingerprint,
      room: relay.identity.id, joinKey: data.host.joinKey, serverId: relay.identity.id, fingerprint: relay.identity.fingerprint });
  }
  function profile(id) { return data.profiles.find(p => p.invite.serverId === id); }
  function rememberToken(view, token) {
    if (token !== null && !credential(token)) throw new Error('远程凭据格式无效。');
    const item = profile(view.id); if (!item || item.invite.fingerprint !== view.invite.fingerprint) throw new Error('远程身份已移除。');
    if ((item.token || null) === token) return;
    saveData({ ...data, profiles: data.profiles.map(p => p === item ? { ...p, token } : p) });
  }
  function viewFrom(event) {
    if (isLocked()) return null;
    for (const view of viewers.values()) if (!view.closed && !view.window.isDestroyed() && event.sender === view.window.webContents && event.senderFrame === view.window.webContents.mainFrame) {
      try { const url = new URL(event.senderFrame.url); if (url.origin === view.origin && ['/', '/index.html'].includes(url.pathname)) return view; } catch {}
    }
    return null;
  }
  async function samePageCredential(event, view, token) {
    if (viewFrom(event) !== view) return false;
    try { return token === await event.sender.executeJavaScriptInIsolatedWorld(1002, [{ code: "(()=>{try{return localStorage.getItem('relay-guest-token');}catch{return null;}})()" }]) && viewFrom(event) === view; } catch { return false; }
  }
  async function jsonRequest(view, route, method = 'GET', token) {
    const actual = token || profile(view.id)?.token;
    if (!credential(actual)) throw new Error('请先用文件池设备的配对码加入。');
    const response = await view.fetcher(view.origin + route, { method, headers: { Authorization: 'Bearer ' + actual }, signal: AbortSignal.timeout(30000) });
    let value; try { value = await boundedJson(response, 16 * 1024 * 1024); } catch { throw new Error('远程响应无效或过大。'); }
    if (!response.ok) throw new Error(value.error || '远程操作失败。'); return value;
  }
  function progress(view, job, status, extra = {}) {
    const event = { requestId: job.requestId, fileId: job.fileId, context:job.context, ...(job.batchId ? { batchId: job.batchId } : {}), name: job.name || '文件', status, transferred: 0, total: job.size || 0, ...extra };
    sendScoped(view,'relay:save-progress',event,job.token);
    return event;
  }
  function sendScoped(view,channel,value,token){if(view.closed||view.window.isDestroyed()||isLocked())return;void view.window.webContents.executeJavaScriptInIsolatedWorld(1002,[{code:"(()=>{try{return localStorage.getItem('relay-guest-token');}catch{return null;}})()"}]).then(current=>{if(current===token&&!view.closed&&!view.window.isDestroyed()&&!isLocked())view.window.webContents.send(channel,value);}).catch(()=>{});}
  async function saveOne(view, job, directory) {
    try {
      if (view.closed || job.controller.signal.aborted) throw Object.assign(new Error('已取消保存。'), { name: 'AbortError' });
      const state = await jsonRequest(view, '/api/state', 'GET', job.token), file = state.files.find(f => f.id === job.fileId);
      if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('文件已移除或完整性记录无效。');
      Object.assign(job, { name: file.name, size: file.size });
      const ticket = await jsonRequest(view, '/api/files/' + file.id + '/ticket', 'POST', job.token);
      const address = new URL(ticket.url, view.origin);
      if (address.origin !== view.origin || address.pathname !== '/api/files/' + file.id + '/content') throw new Error('已阻止无效的下载地址。');
      let destination, suffix = 0;
      if (!directory) {
        await waitUnlocked(job.controller.signal);if(view.closed||job.controller.signal.aborted)throw Object.assign(new Error('已取消'),{name:'AbortError'});
        progress(view, job, 'choosing');
        const answer = await dialog.showSaveDialog(view.window, { title: '保存远程文件并校验', defaultPath: path.join(await preferredDirectory(), suggestedFileName(file.name)), properties: ['showOverwriteConfirmation'] });
        if (answer.canceled || !answer.filePath) job.controller.abort();
        if (job.controller.signal.aborted || view.closed) throw Object.assign(new Error('已取消保存。'), { name: 'AbortError' });
        destination = path.join(await checkedDirectory(path.dirname(path.resolve(answer.filePath))), path.basename(answer.filePath));
      }
      for (;;) {
        if (directory) ({ destination, suffix } = await uniqueDestination(directory, file.name, suffix));
        try {
          const result = await saveVerifiedFile({ url: address.href, destination, expectedSize: file.size, expectedSha256: file.sha256,
            signal: job.controller.signal, overwrite: !directory, fetcher: view.fetcher, onProgress: event => { if (event.status !== 'completed') progress(view, job, event.status, event); } });
          view.saved.set(job.requestId, {path:result.path,token:job.token}); if (view.saved.size > 200) view.saved.delete(view.saved.keys().next().value);
          let savedCopyWarning;
          try { if (savedCopyContext(state).serverId !== view.id) throw new Error('远程身份不一致'); await savedCopies.record(state, file, result.path); } catch { savedCopyWarning = '文件已保存并校验，但本机副本记录未能保存；请从保存位置打开。'; }
          return progress(view, job, 'completed', { transferred: file.size, total: file.size, size: result.size, sha256: result.sha256, ...(savedCopyWarning ? { savedCopyWarning } : {}) });
        } catch (error) { if (directory && error.code === 'EEXIST') { suffix++; continue; } throw error; }
      }
    } catch (error) { return progress(view, job, job.controller.signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed', { error: error.name === 'AbortError' ? '已取消保存。' : /校验|SHA|大小|内容/.test(error.message || '') ? '文件完整性校验未通过，未确认保存。' : '远程保存未完成，请检查连接、可用空间和保存位置。' }); }
  }
  async function saveRequest(event,view, request, batch, folder=false) {
    if (!request || !credential(request.token) || !UUID.test(request.requestId) || !folder&&batch && (!Array.isArray(request.fileIds) || !request.fileIds.length || request.fileIds.length > 200 || request.fileIds.some(id => !UUID.test(id))) || !batch && !UUID.test(request.fileId)) throw new Error('保存请求无效。');
    if (view.jobs.size) throw new Error('请等待当前保存完成，或先取消它。');
    if(!await samePageCredential(event,view,request.token))throw new Error('页面身份已变化。');
    const state=await jsonRequest(view,'/api/state','GET',request.token),scope=savedCopyContext(state),context=scope.serverId+':'+scope.deviceId;
    if(scope.serverId!==view.id||!await samePageCredential(event,view,request.token)||view.jobs.size)throw new Error('文件池身份或任务状态已变化。');
    const folderPlan=folder?planFolder(state,request.folderId??null):null;
    rememberToken(view, request.token);
    const ids = folderPlan?folderPlan.files.map(file=>file.fileId):batch ? [...new Set(request.fileIds)] : [request.fileId], controller = new AbortController();
    const parent = { requestId: request.requestId, token:request.token,context, controller, results: [], total: ids.length }; view.jobs.set(parent.requestId, parent);
    const batchProgress = (status,error) => { const value = { requestId: parent.requestId, context,status, total: ids.length, completed: parent.results.filter(v => v.status === 'completed').length, failed: parent.results.filter(v => v.status === 'failed').length, cancelled: parent.results.filter(v => v.status === 'cancelled').length,...(error?{error}:{}) };sendScoped(view,'relay:batch-progress',value,request.token); return value; };
    const run = (async () => {
      let directory,tree;
      try{
      if (batch) {
        await waitUnlocked(controller.signal);if(view.closed||controller.signal.aborted)throw Object.assign(new Error('已取消'),{name:'AbortError'});
        batchProgress('choosing'); const answer = await dialog.showOpenDialog(view.window, { title: '选择远程文件保存文件夹', defaultPath: await preferredDirectory(), properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] });
        if (answer.canceled || !answer.filePaths?.[0]) controller.abort();
        else directory = await checkedDirectory(answer.filePaths[0]);
      }
      if(folderPlan&&!controller.signal.aborted)tree=await materialize(folderPlan,directory,{signal:controller.signal});
      for (const id of ids) {
        const job = { fileId: id, requestId: batch ? crypto.randomUUID() : request.requestId, ...(batch ? { batchId: request.requestId } : {}), controller, token: request.token,context };
        parent.activeRequestId = job.requestId;
        parent.results.push(controller.signal.aborted ? progress(view, job, 'cancelled') : await saveOne(view, job, tree?await tree.directory(folderPlan.files.find(file=>file.fileId===id).folderId):directory));
        if (batch) batchProgress('running');
      }
      if (!batch) return parent.results[0];
      return { ...batchProgress(parent.results.some(v => v.status === 'failed') ? 'failed' : controller.signal.aborted ? 'cancelled' : 'completed'), results: parent.results,...(folderPlan?{directories:tree?.directories||0}:{}) };
      }catch(error){const status=controller.signal.aborted?'cancelled':'failed';return{...batchProgress(status,status==='failed'?'批量保存未完成，请检查连接与保存位置。':undefined),results:parent.results,...(folderPlan?{directories:tree?.directories||0}:{})};}
    })();
    parent.promise = run;
    try { return await run; } finally { view.jobs.delete(parent.requestId); }
  }
  function dispose(view) {
    if (view.disposePromise) return view.disposePromise;
    view.closed = true; viewers.delete(view.id);
    const jobs = [...view.jobs.values()]; for (const job of jobs) job.controller.abort();
    view.disposePromise = (async () => {
      await view.tunnel.close();
      if (!view.window.isDestroyed()) view.window.destroy();
      await Promise.allSettled(jobs.map(job => job.promise));
      await view.session.clearStorageData().catch(() => {}); notify();
    })();
    closingViews.add(view.disposePromise); view.disposePromise.finally(() => closingViews.delete(view.disposePromise)).catch(() => {});
    return view.disposePromise;
  }
  const viewBusy = view => view.jobs.size || view.copyOperations || view.activity.uploads || view.activity.verifications;
  async function savedCopyAction(event, request, action) {
    const view = viewFrom(event);
    if (!view || stopped || maintenance || !request || typeof request !== 'object' || Array.isArray(request) || !credential(request.token)
        || Object.keys(request).some(key => !(action === 'list' ? ['fileIds', 'token'] : ['fileId', 'sha256', 'token']).includes(key))) throw new Error('远程本机副本请求无效。');
    if (action !== 'list') {
      const activated = await event.sender.executeJavaScriptInIsolatedWorld(1001, [{ code: 'navigator.userActivation.isActive' }]);
      if (!activated || viewFrom(event) !== view) throw new Error('请点击对应文件后再打开。');
    }
    view.copyOperations = (view.copyOperations || 0) + 1;
    try {
      const state = await jsonRequest(view, '/api/state', 'GET', request.token), scope = JSON.stringify(savedCopyContext(state));
      if (savedCopyContext(state).serverId !== view.id) throw new Error('远程文件池身份不一致。');
      const result = action === 'list' ? await savedCopies.list(state, request.fileIds) : await savedCopies.resolve(state, request.fileId, request.sha256);
      const current = await jsonRequest(view, '/api/state', 'GET', request.token);
      if (!await samePageCredential(event, view, request.token) || stopped || maintenance || scope !== JSON.stringify(savedCopyContext(current))) throw new Error('远程文件池页面或设备身份已变化。');
      if (action === 'list') return { files: result.files.filter(record => current.files?.some(file => file.id === record.fileId && file.sha256 === record.sha256)) };
      if (!current.files?.some(file => file.id === request.fileId && file.sha256 === request.sha256)) throw new Error('当前文件已移除或访问权限已变化。');
      if (action === 'reveal') { shell.showItemInFolder(result); return { revealed: true }; }
      if (!await confirmOpen(dialog, view.window, result)) return { opened: false, cancelled: true };
      if (!await samePageCredential(event, view, request.token) || stopped || maintenance) throw new Error('文件池页面已变化。');
      const confirmed = await jsonRequest(view, '/api/state', 'GET', request.token);
      if (scope !== JSON.stringify(savedCopyContext(confirmed))) throw new Error('设备身份已变化。');
      const verified=await savedCopies.resolve(confirmed, request.fileId, request.sha256);
      if(!await samePageCredential(event,view,request.token)||stopped||maintenance)throw new Error('文件池页面已变化。');
      if (await shell.openPath(verified)) throw new Error('无法打开本机副本，请检查默认应用或从保存位置打开。');
      return { opened: true };
    } finally { view.copyOperations--; }
  }
  async function requestDispose(view,guard=async()=>{}) {
    if (view.closed) return true;
    if (view.closingPrompt) return false;
    if (viewBusy(view)) {
      view.closingPrompt = true;
      try {
        const answer = await dialog.showMessageBox(view.window, { type: 'question', title: '断开远程文件池？', message: '仍有文件正在传输或校验。', detail: '断开会停止当前操作。文件池中已完成的文件和上传断点保留，未完成的本地保存会取消。', buttons: ['继续传输', '断开并停止任务'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return false;
      } finally { view.closingPrompt = false; }
    }
    await guard();await dispose(view); return true;
  }
  async function openInvite(input, guard = async () => {}) {
    if (stopped) throw new Error('程序正在退出。'); if (loadError) throw new Error(loadError);
    const invite = protocol.decodeInvite(input), known = profile(invite.serverId);
    if (invite.serverId === relay.identity.id) throw new Error('这是本机文件池，请使用当前窗口。');
    if (known && known.invite.fingerprint !== invite.fingerprint) throw new Error('该设备的证书已变化。请先核实原设备，再移除旧信任重新加入。');
    const existing = viewers.get(invite.serverId);
    if (existing) {
      if (protocol.encodeInvite(existing.invite) === protocol.encodeInvite(invite)) { existing.window.show(); existing.window.focus(); return { connected: true }; }
      if (viewBusy(existing)) {
        const answer = await dialog.showMessageBox(existing.window, { type: 'question', title: '更新远程连接？', message: '新的邀请将替换这台设备的旧连接。', detail: '当前尚有保存任务，切换会取消未完成保存。已经保存的文件不会删除。', buttons: ['取消', '取消任务并更新连接'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return { connected: false };
      }
      await guard();await dispose(existing);
    }
    if (viewers.size >= 4) throw new Error('最多同时打开 4 个远程文件池。');
    if (!known) {
      const answer = await dialog.showMessageBox(mainWindow(), { type: 'question', title: '确认远程文件池身份', message: '请与文件池设备核对完整证书指纹。', detail: '设备编号：' + invite.serverId + '\n中继：' + invite.relay + '\n\nSHA-256：\n' + invite.fingerprint.match(/.{1,8}/g).join(' ') + '\n\n中继只转发加密数据；文件池设备可以读取文件。确认后仍需输入该设备的配对码。', buttons: ['取消', '指纹一致，连接'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return { connected: false };
    }
    await guard(); if (stopped) throw new Error('程序正在退出。');
    const tunnel = await createRemoteTunnel(invite); let view;
    pendingTunnels.add(tunnel);
    try {
      if (stopped) throw new Error('程序正在退出。');
      const fetcher = pinnedFetch(tunnel.origin, invite.fingerprint), response = await fetcher(tunnel.origin + '/api/identity', { signal: AbortSignal.timeout(20000) });
      const identity = await boundedJson(response, 4096);
      if (!response.ok || identity.protocol !== 'relaydrop-tls-v1' || identity.serverId !== invite.serverId || identity.certificateFingerprint !== invite.fingerprint) throw new Error('远程设备身份不一致，连接已阻止。');
      if (stopped) throw new Error('程序正在退出。');
      if (!known && data.profiles.length >= 20) throw new Error('已保存 20 台远程设备，请先移除不再使用的设备。');
      const entry = { invite, token: known?.token || null };
      await guard();
      saveData({ ...data, profiles: [entry, ...data.profiles.filter(p => p.invite.serverId !== invite.serverId)] });
      const partition = 'relaydrop-remote-' + crypto.randomUUID(), remoteSession = session.fromPartition(partition);
      remoteSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' && certificatePemMatches(request.certificate.data, invite.fingerprint) ? 0 : -2));
      remoteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      remoteSession.setPermissionCheckHandler(() => false);
      remoteSession.webRequest.onBeforeRequest((details, callback) => {
        try { const u = new URL(details.url); callback({ cancel: u.origin !== tunnel.origin && !['blob:', 'data:'].includes(u.protocol) }); } catch { callback({ cancel: true }); }
      });
      remoteSession.on('will-download', (event) => { event.preventDefault(); });
      const window = new BrowserWindow({ width: 1200, height: 820, minWidth: 1000, minHeight: 700, title: '星月夜 · 远程文件池', show: false,
        icon: path.join(__dirname, 'assets/icon.png'), autoHideMenuBar: true, backgroundColor: '#f4f7f7',
        webPreferences: { preload: path.join(__dirname, 'remote-preload.cjs'), partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, backgroundThrottling: false } });
      view = { id: invite.serverId, invite, window, session: remoteSession, tunnel, origin: tunnel.origin, fetcher, closed: false, jobs: new Map(), saved: new Map(), activity: { uploads: 0, verifications: 0 } }; viewers.set(view.id, view); pendingTunnels.delete(tunnel);
      window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => { try { const u = new URL(url); if (u.origin !== view.origin || !['/', '/index.html'].includes(u.pathname)) event.preventDefault(); } catch { event.preventDefault(); } });
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.webContents.on('page-title-updated', event => event.preventDefault());
      window.once('ready-to-show', () => {if(!isLocked())window.show();});
      window.on('close', event => { if (!view.closed) { event.preventDefault(); void requestDispose(view).catch(() => {}); } });
      window.on('closed', () => { void dispose(view); });
      await window.loadURL(view.origin + '/#pool'); notify(); return { connected: true };
    } catch (error) { if (view) await dispose(view); else await tunnel.close(); throw new Error(error.code === 'IDENTITY_CHANGED' ? error.message : '无法打开远程文件池。请确认中继配置正确、文件池设备已启用远程共享并保持在线。'); } finally { pendingTunnels.delete(tunnel); }
  }
  ipcMain.handle('relay:remote-action', async (event, request) => {
    if (!trusted(event) || !request || typeof request !== 'object') throw new Error('无权操作远程设置。');
    if (typeof authorizeHost !== 'function') throw new Error('管理员身份校验不可用。');
    const owner = await authorizeHost(event), guard = () => authorizeHost(event, owner);
    if (request.action === 'state') return state();
    return exclusive(async () => {
      await guard(); if (!trusted(event) || stopped || maintenance) throw new Error('设置窗口已关闭或文件池正在维护。'); busy = true;
      try {
        switch (request.action) {
          case 'configure': {
            const input = request.config; if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['relay', 'relayFingerprint', 'serviceKey'].includes(k))) throw new Error('中继配置无效。');
            const same = data.host?.relay === input.relay;
            const config = protocol.validateHostConfig({ relay: input.relay, relayFingerprint: input.relayFingerprint || null,
              serviceKey: input.serviceKey || (same ? data.host.serviceKey : ''), room: relay.identity.id,
              hostKey: data.host?.hostKey || protocol.randomSecret(), joinKey: data.host?.joinKey || protocol.randomSecret(), localPort: 1 });
            delete config.localPort; saveData({ ...data, host: config }); await stopHost(); await guard();return state();
          }
          case 'start': return startHost(guard);
          case 'stop': await stopHost(); await guard();return state();
          case 'copy-invite': clipboard.writeText(hostInvite()); return { copied: true };
          case 'rotate': { if (!data.host) throw new Error('请先保存中继配置。'); const enabled = !!host; await stopHost(); await guard(); saveData({ ...data, host: { ...data.host, joinKey: protocol.randomSecret() } }); if (enabled) await startHost(guard); return state(); }
          case 'join': return openInvite(request.invite, guard);
          case 'reopen': { const p = profile(request.id); if (!p) throw new Error('远程设备不存在。'); return openInvite(protocol.encodeInvite(p.invite), guard); }
          case 'disconnect': { const v = viewers.get(request.id); if (v) await requestDispose(v,guard); await guard();return state(); }
          case 'forget': { const v = viewers.get(request.id); if (v && !await requestDispose(v,guard)){await guard();return state();} await guard(); saveData({ ...data, profiles: data.profiles.filter(p => p.invite.serverId !== request.id) }); return state(); }
          default: throw new Error('远程操作无效。');
        }
      } finally { busy = false; notify(); }
    });
  });
  ipcMain.on('relay:remote-bootstrap', event => { const view = viewFrom(event); event.returnValue = view ? { token: profile(view.id)?.token || null } : null; });
  ipcMain.on('relay:remote-token', (event, token) => { const view = viewFrom(event); if (view) { try { rememberToken(view, token); } catch { /* Credentials remain usable in this window; no plaintext fallback. */ } } });
  ipcMain.on('relay:remote-activity', (event, activity) => { const view = viewFrom(event); if (view && activity && typeof activity === 'object') view.activity = { uploads: Math.min(1000, Math.max(0, Number(activity.uploads) || 0)), verifications: Math.min(1000, Math.max(0, Number(activity.verifications) || 0)) }; });
  for (const [channel, batch,folder] of [['relay:remote-save', false,false], ['relay:remote-save-batch', true,false],['relay:remote-save-folder',true,true]]) ipcMain.handle(channel, (event, request) => { const view = viewFrom(event); if (!view) throw new Error('远程保存请求来源无效。'); return saveRequest(event,view, request, batch,folder); });
  ipcMain.handle('relay:remote-saved-copies', (event, request) => savedCopyAction(event, request, 'list'));
  ipcMain.handle('relay:remote-open-saved-copy', (event, request) => savedCopyAction(event, request, 'open'));
  ipcMain.handle('relay:remote-reveal-saved-copy', (event, request) => savedCopyAction(event, request, 'reveal'));
  ipcMain.handle('relay:remote-cancel', async (event, id) => { const view = viewFrom(event), job = view?.jobs.get(id) || [...(view?.jobs.values() || [])].find(j => j.activeRequestId === id); if (!job||!await samePageCredential(event,view,job.token)) return false; job.controller.abort(); return true; });
  ipcMain.handle('relay:remote-reveal', async (event, id) => {
    const view = viewFrom(event), record = view?.saved.get(id); if (!record||!await samePageCredential(event,view,record.token)) throw new Error('只能打开本次已保存文件的位置。');
    await jsonRequest(view,'/api/state','GET',record.token);const saved=record.path;
    const stat = await fs.lstat(saved).catch(() => null); if (!stat?.isFile() || stat.isSymbolicLink() || (await fs.realpath(saved)).toLowerCase() !== saved.toLowerCase()) throw new Error('文件已被移动或替换。');
    if (!await samePageCredential(event,view,record.token)) return false; shell.showItemInFolder(saved); return true;
  });
  return { state, get busy() { return busy || [...viewers.values()].some(viewBusy); },
    async suspendForMaintenance() { maintenance = true; await Promise.all([...pendingTunnels].map(t => t.close())); await serial; await Promise.all([...viewers.values()].map(dispose)); await Promise.allSettled([...closingViews]); await stopHost(); },
    replaceRelay(next) { if(stopped)throw new Error('程序正在关闭');relay=next;maintenance=false;notify(); },
    async pauseSharing() { await stopHost(); },
    lockViews() { for (const view of viewers.values()) if (!view.window.isDestroyed()) {view.window.webContents.closeDevTools();view.window.hide();} },
    async close() { stopped = true; await Promise.all([...pendingTunnels].map(t => t.close())); await Promise.all([...viewers.values()].map(dispose)); await Promise.allSettled([...closingViews]); await serial; await stopHost(); } };
}
module.exports = { createRemoteManager };
