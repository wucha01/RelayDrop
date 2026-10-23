'use strict';

// File-pool HTTP is local; optional remote tunnels carry pinned TLS unchanged.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const pool = require('./file-pool.cjs');
const folders = require('./shared-folders.cjs');

const VERSION = require('./package.json').version;
const MiB = 1024 * 1024;
const now = () => new Date().toISOString();
const token = () => crypto.randomBytes(32).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const publicDevice = d => ({ id: d.id, name: d.name, role: d.role, revoked: !!d.revoked, lastSeen: d.lastSeen });
class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
function fail(status, code, message, extra) { throw new HttpError(status, code, message, extra); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function sendJson(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, maximum) {
  return new Promise((resolve, reject) => {
    const length = req.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) {
      req.resume(); reject(new HttpError(413, 'BODY_TOO_LARGE', '发送内容超过允许大小。')); return;
    }
    const chunks = []; let total = 0, ended = false;
    const done = (error, data) => {
      if (ended) return; ended = true;
      req.removeListener('data', onData); req.removeListener('end', onEnd);
      req.removeListener('aborted', onAbort); req.removeListener('error', onError);
      if (error) { req.resume(); reject(error); } else resolve(data);
    };
    const onData = chunk => {
      total += chunk.length;
      if (total > maximum) done(new HttpError(413, 'BODY_TOO_LARGE', '发送内容超过允许大小。'));
      else chunks.push(chunk);
    };
    const onEnd = () => done(null, Buffer.concat(chunks, total));
    const onAbort = () => done(new HttpError(400, 'REQUEST_ABORTED', '传输已中断，请重新连接后继续。'));
    const onError = () => done(new HttpError(400, 'REQUEST_FAILED', '接收数据失败，请重试。'));
    req.on('data', onData); req.once('end', onEnd); req.once('aborted', onAbort); req.once('error', onError);
  });
}
async function readJson(req, maximum = 96 * 1024) {
  if (req.headers['content-type'] && !/^application\/json(?:;|$)/i.test(req.headers['content-type'])) fail(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
  const body = await readBody(req, maximum);
  if (!body.length) return {};
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { fail(400, 'INVALID_JSON', '请求数据不是有效 JSON。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'INVALID_JSON', '请求必须是 JSON 对象。');
  return data;
}
async function fileHash(filePath) {
  const digest = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(filePath)) digest.update(block);
  return digest.digest('hex');
}
function localAddresses() {
  const addresses = new Set(['127.0.0.1', 'localhost', '[::1]', os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`]);
  for (const net of Object.values(os.networkInterfaces())) for (const info of net || []) {
    if (info.family === 'IPv4') addresses.add(info.address);
    else if (info.family === 'IPv6' && !info.address.includes('%')) addresses.add(`[${info.address.toLowerCase()}]`);
  }
  return addresses;
}
function lanUrls(port, secure = false) {
  const result = [];
  for (const [iface, net] of Object.entries(os.networkInterfaces())) for (const info of net || []) {
    if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) {
      let score = /wlan|wi-fi|wireless/i.test(iface) ? 100 : 50;
      if (/virtual|vmware|virtualbox|vpn|tun|zerotier|radmin|loopback/i.test(iface)) score -= 200;
      if (info.mac.startsWith('0a:00:27:')) score -= 200;
      result.push({url:`${secure ? 'https' : 'http'}://${info.address}:${port}`,score});
    }
  }
  return [...new Set(result.sort((a,b)=>b.score-a.score).map(row=>row.url))];
}
function attachment(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii || 'download'}"; filename*=UTF-8''${utf8}`;
}

function acquireDataLease(dataDir) {
  const lockPath = path.join(dataDir, '.relaydrop.lock');
  const value = JSON.stringify({ pid: process.pid, instance: crypto.randomUUID(), createdAt: now() });
  const guardPath = path.join(dataDir, '.relaydrop.lock-guard');
  const busy = () => Object.assign(new Error('此数据目录已由另一个中转站使用，请打开现有中转站；若刚刚异常退出，请稍后重试。'), { code: 'DATA_IN_USE' });
  const isAlive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  };
  // Publish a nonempty directory atomically. Recovery removes only the dead
  // owner's unique file; rmdir can never remove a replacement nonempty guard.
  const guardName = `${process.pid}.${crypto.randomUUID()}.owner`;
  const preparedGuard = `${guardPath}.${guardName}`;
  fs.mkdirSync(preparedGuard); fs.writeFileSync(path.join(preparedGuard, guardName), '');
  let guarded = false;
  try {
    for (let attempt = 0; attempt < 4 && !guarded; attempt++) {
      try { fs.renameSync(preparedGuard, guardPath); guarded = true; }
      catch (error) {
        if (!fs.existsSync(guardPath)) {
          if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) continue;
          throw error;
        }
        let names;
        try { names = fs.readdirSync(guardPath); } catch (readError) {
          if (readError.code === 'ENOENT') continue;
          // Windows can deny enumeration while another process removes or
          // replaces the guard. Without reading its owner, never recover it.
          if (['EPERM', 'EACCES'].includes(readError.code)) throw busy();
          throw readError;
        }
        for (const name of names) {
          const match = /^(\d+)\.[\da-f-]+\.owner$/.exec(name);
          if (!match || isAlive(Number(match[1]))) throw busy();
        }
        for (const name of names) try { fs.unlinkSync(path.join(guardPath, name)); } catch (removeError) { if (!['ENOENT', 'EPERM', 'EACCES'].includes(removeError.code)) throw removeError; }
        try { fs.rmdirSync(guardPath); } catch (removeError) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(removeError.code)) throw removeError; }
      }
    }
    if (!guarded) throw busy();
  for (let attempt = 0; attempt < 4; attempt++) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      const lease = { held: true, release() {
        if (!lease.held) return; lease.held = false; process.removeListener('exit', lease.release);
        try { if (fs.readFileSync(lockPath, 'utf8') === value) fs.unlinkSync(lockPath); } catch {}
      } };
      process.once('exit', lease.release); return lease;
    } catch (error) {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); fs.unlinkSync(lockPath); } catch {} }
      if (error.code !== 'EEXIST') throw error;
      let previous, owner, age;
      try { previous = fs.readFileSync(lockPath, 'utf8'); age = Date.now() - fs.statSync(lockPath).mtimeMs; owner = JSON.parse(previous); }
      catch (readError) { if (readError.code === 'ENOENT') continue; }
      let alive = false;
      if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
        alive = isAlive(owner.pid);
      } else alive = !Number.isFinite(age) || age < 30_000;
      if (alive) throw busy();
      // All acquisitions hold the guard, so no new owner can appear during removal.
      try { if (fs.readFileSync(lockPath, 'utf8') === previous) fs.unlinkSync(lockPath); } catch (removeError) { if (removeError.code !== 'ENOENT') throw removeError; }
    }
  }
  throw busy();
  } finally {
    const directory = guarded ? guardPath : preparedGuard;
    try { fs.unlinkSync(path.join(directory, guardName)); } catch {}
    try { fs.rmdirSync(directory); } catch {}
  }
}
function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(snapshot, key)) delete target[key];
  for (const [key, value] of Object.entries(snapshot)) {
    if (Array.isArray(value)) {
      const current = Array.isArray(target[key]) ? target[key] : [];
      const byId = new Map(current.filter(v => v && typeof v === 'object' && v.id).map(v => [v.id, v]));
      const restored = value.map(v => {
        if (v && typeof v === 'object' && !Array.isArray(v)) { const existing = byId.get(v.id) || {}; restoreObject(existing, v); return existing; }
        return v;
      });
      current.splice(0, current.length, ...restored); target[key] = current;
    } else if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      restoreObject(target[key], value);
    } else target[key] = value;
  }
}
function createRelayServer(options = {}) {
  let dataDir = path.resolve(options.dataDir || process.env.RELAY_DATA || path.join(__dirname, 'data'));
  fs.mkdirSync(dataDir, { recursive: true }); dataDir = fs.realpathSync(dataDir);
  const lease = acquireDataLease(dataDir);
  try { return createLeasedRelayServer({ ...options, dataDir }, lease); }
  catch (error) { lease.release(); throw error; }
}
async function createSecureRelayServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.RELAY_DATA || path.join(__dirname, 'data'));
  const tlsIdentity = await require('./security.cjs').loadOrCreateIdentity(dataDir);
  return createRelayServer({ ...options, dataDir, tlsIdentity });
}
function createLeasedRelayServer(options, lease) {
  const dataDir = path.resolve(options.dataDir || process.env.RELAY_DATA || path.join(__dirname, 'data'));
  const androidApkPath = path.resolve(options.androidApkPath || path.join(__dirname, 'RelayDrop-Android.apk'));
  const hasAndroidInstaller = () => { try { return fs.statSync(androidApkPath).isFile(); } catch { return false; } };
  const identity = options.tlsIdentity || null;
  // Only the dedicated loopback TLS listener can mark a tunneled request.
  // Never infer this privilege from Host, Forwarded or another HTTP header.
  const remoteRequests = new WeakSet(), requestScope = new AsyncLocalStorage(), activities = new Set(), trustedRemotePeers = new WeakMap();
  let remoteEndpoint = null, remoteOpening = null;
  const bindHost = options.host ?? process.env.RELAY_HOST ?? (identity ? '0.0.0.0' : '127.0.0.1');
  if (!identity && !['127.0.0.1', '::1', 'localhost'].includes(bindHost)) throw new Error('局域网连接必须使用加密中转站；明文接口仅允许本机访问。');
  const configuredPort = options.port ?? Number(process.env.PORT || 8765);
  const chunkSize = options.chunkSize ?? MiB;
  const maxFileSize = options.maxFileSize ?? 20 * 1024 * MiB;
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) throw new Error('PORT 必须介于 0 和 65535 之间。');
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 16 * MiB) throw new Error('Invalid chunkSize');
  const partialDir = path.join(dataDir, 'partials'), fileDir = path.join(dataDir, 'files');
  const statePath = path.join(dataDir, 'state.json');
  fs.mkdirSync(partialDir, { recursive: true }); fs.mkdirSync(fileDir, { recursive: true });
  let state;
  if (fs.existsSync(statePath)) {
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
    catch { throw new Error(`中转站数据损坏，已停止启动以保护现有文件。请备份并检查 ${statePath}`); }
    if (state.version !== 1 || !state.hostToken || !Array.isArray(state.devices) || !Array.isArray(state.transfers) || !Array.isArray(state.files) || !Array.isArray(state.notes)) throw new Error('无法识别的数据格式，现有数据未被修改。');
  } else {
    state = { version: 1, hostToken: token(), devices: [{ id: 'host', name: '这台电脑', role: 'host', lastSeen: now(), revoked: false }], transfers: [], files: [], notes: [], pairing: null };
  }
  if (state.folders === undefined) state.folders = [];
  if (!Array.isArray(state.folders)) throw new Error('共享目录记录损坏，已停止启动以保护现有文件。');
  const hostToken = state.hostToken;
  let committedState = JSON.stringify(state);
  const partPath = id => path.join(partialDir, `${id}.part`);
  const readyPath = id => path.join(fileDir, id);
  function persist() {
    const temporary = `${statePath}.${process.pid}.tmp`;
    const candidate = JSON.stringify(state);
    try {
      const descriptor = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(descriptor, candidate); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, statePath); committedState = candidate;
    } catch (error) {
      // Preserve references held by concurrent transfers and authenticated requests.
      restoreObject(state, JSON.parse(committedState));
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }
  async function discardFiles(paths, mutation) {
    const moved = [];
    try {
      for (const source of paths) {
        const tombstone = source + '.deleted';
        try { await fsp.rename(source, tombstone); moved.push([source, tombstone]); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      mutation(); persist();
    } catch (error) {
      for (const [source, tombstone] of moved.reverse()) await fsp.rename(tombstone, source).catch(() => {});
      throw error;
    }
    // The deletion is committed. Failed cleanup remains recoverable on next start.
    for (const [, tombstone] of moved) await fsp.rm(tombstone, { force: true }).catch(() => {});
  }
  // Recover a deletion interrupted before its metadata commit, or finish its cleanup.
  const pendingIds = new Set(state.transfers.filter(t => t.status !== 'complete').map(t => t.id));
  const readyIds = new Set([...state.files.map(f => f.id), ...pendingIds]);
  for (const [directory, ids] of [[partialDir, pendingIds], [fileDir, readyIds]]) {
    for (const name of fs.readdirSync(directory)) if (name.endsWith('.deleted')) {
      const originalName = name.slice(0, -8), id = directory === partialDir ? originalName.replace(/\.part$/, '') : originalName;
      const source = path.join(directory, name), original = path.join(directory, originalName);
      if (ids.has(id) && !fs.existsSync(original)) fs.renameSync(source, original); else fs.unlinkSync(source);
    }
  }
  function rotatePairing() {
    state.pairing = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    persist(); return state.pairing;
  }
  // The actual partial-file length is authoritative after a power loss or crash.
  for (const transfer of state.transfers) {
    if (transfer.status === 'complete') continue;
    if (fs.existsSync(partPath(transfer.id))) {
      transfer.offset = fs.statSync(partPath(transfer.id)).size;
      if (transfer.offset > transfer.size) throw new Error('部分传输文件大小异常，已停止启动以保护数据。');
    } else if (fs.existsSync(readyPath(transfer.id))) transfer.offset = transfer.size;
    else { fs.writeFileSync(partPath(transfer.id), Buffer.alloc(0)); transfer.offset = 0; }
    transfer.status = 'uploading';
  }
  if (!state.pairing || Date.parse(state.pairing.expiresAt) <= Date.now()) rotatePairing(); else persist();

  let actualPort = configuredPort, securePort = configuredPort, closing = false, lastPersistedSeen = Date.now();
  const locks = new Map(), tickets = new Map(), attempts = new Map();
  const previews = new Map(), previewJobs = new Map(), previewAbort = new AbortController();
  const verifiedSources = new Map(), verificationJobs = new Map();
  let previewBytes = 0, previewTail = Promise.resolve();
  function invalidatePreview(id) { for (const [key, cached] of previews) if (key.startsWith(id + ':')) { previewBytes -= cached.bytes.length; previews.delete(key); } verifiedSources.delete(id); }
  const sourceStamp = (file, stat) => JSON.stringify([file.sha256, file.name, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev]);
  async function verifySource(file) {
    const location = readyPath(file.id), stat = await fsp.stat(location);
    if (!stat.isFile() || stat.size !== file.size) fail(422, 'FILE_HASH_MISMATCH', '文件大小已变化，未提供预览或重复文件匹配。');
    const identity = sourceStamp(file, stat), cached = verifiedSources.get(file.id);
    if (cached?.identity === identity && Date.now() - cached.at < 300_000) return identity;
    const key = file.id + ':' + identity;
    if (verificationJobs.has(key)) return verificationJobs.get(key);
    if (verificationJobs.size >= 16) fail(429, 'VERIFY_BUSY', '正在校验其他文件，请稍后重试。');
    const job = (async () => {
      const digest = await fileHash(location), latest = await fsp.stat(location);
      if (!latest.isFile() || sourceStamp(file, latest) !== identity || digest !== file.sha256) fail(422, 'FILE_HASH_MISMATCH', '原件完整性校验失败，未提供预览或重复文件匹配。');
      while (verifiedSources.size >= 128) verifiedSources.delete(verifiedSources.keys().next().value);
      verifiedSources.set(file.id, { identity, at: Date.now() }); return identity;
    })();
    verificationJobs.set(key, job);
    try { return await job; } finally { verificationJobs.delete(key); }
  }
  const preferences = (device, create = false) => {
    if (create) { state.preferences ||= {}; state.preferences[device.id] ||= { collections: [], files: {} }; }
    return state.preferences?.[device.id] || { collections: [], files: {} };
  };
  const fileView = (file, device) => ({ ...pool.view(file, typeof options.createThumbnail === 'function'), favorite: !!(device && preferences(device).files?.[file.id]?.favorite), collection: (device && preferences(device).files?.[file.id]?.collection) || null });
  async function thumbnail(file, variant, signal) {
    if (!pool.previewable(file) || typeof options.createThumbnail !== 'function') fail(415, 'PREVIEW_UNAVAILABLE', '此文件暂不支持缩略图，可保存原文件后查看。');
    const location = readyPath(file.id);
    let identity;
    try { identity = await verifySource(file); } catch (error) { if (error.code === 'VERIFY_BUSY') fail(429, 'PREVIEW_BUSY', '正在生成其他预览，请稍后重试。'); throw error; }
    const cacheKey = `${file.id}:${variant.mode}:${variant.page}`;
    const cached = previews.get(cacheKey);
    if (cached?.identity === identity) { previews.delete(cacheKey); previews.set(cacheKey, cached); return cached; }
    if (cached) { previewBytes -= cached.bytes.length; previews.delete(cacheKey); }
    const jobKey = cacheKey + ':' + identity;
    let entry = previewJobs.get(jobKey);
    if (!entry) {
      if (previewJobs.size >= 16) fail(429, 'PREVIEW_BUSY', '正在生成其他预览，请稍后重试。');
      const controller = new AbortController();
      entry = { controller, users: 0, settled: false, promise: null };
      const combined = AbortSignal.any([previewAbort.signal, controller.signal]);
      const job = previewTail.catch(() => {}).then(async () => {
        if (closing) fail(503, 'SERVER_CLOSING', '中转站正在关闭。');
        combined.throwIfAborted(); let result;
        try { result = await options.createThumbnail(location, { ...file }, combined, variant); }
        catch { if (closing) fail(503, 'SERVER_CLOSING', '中转站正在关闭。'); fail(415, 'PREVIEW_UNAVAILABLE', '此页、格式或尺寸暂不支持预览，原文件仍可正常保存。'); }
        combined.throwIfAborted();
        const bytes = Buffer.isBuffer(result) ? result : result?.bytes, pageCount = Buffer.isBuffer(result) ? 1 : result?.pageCount;
        const dimensions = Buffer.isBuffer(bytes) && pool.imageDimensions(bytes), maximum = variant.mode === 'detail' ? pool.MAX_DETAIL_BYTES : pool.MAX_PREVIEW_BYTES;
        if (!Buffer.isBuffer(bytes) || bytes.length > maximum || dimensions?.format !== 'jpeg' || !pool.safeDimensions(dimensions, variant.edge ** 2) || dimensions.width > variant.edge || dimensions.height > variant.edge || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100_000 || variant.page > pageCount) fail(415, 'PREVIEW_UNAVAILABLE', '无法生成有效的预览页面。');
        const latest = await fsp.stat(location).catch(() => null);
        if (!latest || sourceStamp(file, latest) !== identity || !state.files.some(f => f.id === file.id && !f.deletedAt)) fail(404, 'FILE_MISSING', '预览期间文件已变化或被移除。');
        while (previews.size && (previews.size >= 64 || previewBytes + bytes.length > 16 * MiB)) { const key = previews.keys().next().value; previewBytes -= previews.get(key).bytes.length; previews.delete(key); }
        const output = { identity, bytes, pageCount }; previews.set(cacheKey, output); previewBytes += bytes.length; return output;
      });
      entry.promise = job.finally(() => { entry.settled = true; previewJobs.delete(jobKey); });
      previewTail = entry.promise.catch(() => {}); previewJobs.set(jobKey, entry);
    }
    entry.users++; let onAbort;
    try {
      if (!signal) return await entry.promise;
      return await Promise.race([entry.promise, new Promise((_resolve, reject) => { onAbort = () => reject(new HttpError(499, 'PREVIEW_CANCELLED', '预览已关闭。')); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); })]);
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort); if (--entry.users === 0 && !entry.settled) entry.controller.abort(); }
  }
  let globalFailures = [];
  async function locked(id, operation) {
    const previous = locks.get(id) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const current = previous.catch(() => {}).then(() => gate);
    locks.set(id, current);
    await previous.catch(() => {});
    try { return await operation(); }
    finally { release(); if (locks.get(id) === current) locks.delete(id); }
  }
  function externalRequest(req) { return remoteRequests.has(req) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); }
  function trackDevice(req, device) { const entry = requestScope.getStore(); if (entry?.req === req) entry.deviceId = device.id; }
  function interruptActivities(predicate, paused = false) { for (const entry of [...activities]) if (predicate(entry)) { entry.controller.abort(); if (entry.res.headersSent) { if (!entry.res.destroyed) entry.res.destroy(); if (!entry.req.destroyed) entry.req.destroy(); } else { sendJson(entry.res, paused ? 503 : 401, { code: paused ? 'SHARING_PAUSED' : 'AUTH_REVOKED', error: paused ? '文件池主人已暂停共享。' : '设备连接已撤销。' }); entry.req.resume(); } } }
  function getSharingState() { return { paused: state.sharingPaused === true }; }
  function setSharingPaused(paused) {
    if (typeof paused !== 'boolean') fail(400, 'INVALID_SHARING_STATE', '共享暂停设置无效。');
    state.sharingPaused = paused; persist();
    if (paused) { if (stopDiscovery) { stopDiscovery(); stopDiscovery = null; } tickets.clear(); interruptActivities(entry => entry.external, true); }
    else if (listening && options.discovery !== false && bindHost !== '127.0.0.1' && !stopDiscovery) { try { stopDiscovery = require('./discovery.cjs').startDiscovery(secureServer ? securePort : actualPort, identity); } catch {} }
    return getSharingState();
  }
  function authorize(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) fail(401, 'AUTH_REQUIRED', '请先配对设备。');
    const credential = auth.slice(7);
    let device;
    if (safeEqual(credential, hostToken) && !remoteRequests.has(req)) device = state.devices.find(d => d.id === 'host');
    else {
      const digest = hash(credential);
      device = state.devices.find(d => d.role === 'guest' && !d.revoked && safeEqual(d.tokenHash, digest));
    }
    if (!device || device.revoked) fail(401, 'AUTH_REVOKED', '设备连接已失效，请重新配对。');
    trackDevice(req, device);
    device.lastSeen = now();
    if (Date.now() - lastPersistedSeen > 30_000) { persist(); lastPersistedSeen = Date.now(); }
    return device;
  }
  function hostOnly(device) { if (device.id !== 'host') fail(403, 'HOST_ONLY', '只有电脑管理员可以执行此操作。'); }
  function assertStillAuthorized(device) { const current = state.devices.find(d => d.id === device.id); if (!current || current.revoked) fail(401, 'AUTH_REVOKED', '设备连接已撤销。'); const entry = requestScope.getStore(); if (entry?.controller.signal.aborted) fail(401, 'AUTH_REVOKED', '请求授权已停止。'); if (state.sharingPaused && entry?.external) fail(503, 'SHARING_PAUSED', '文件池主人已暂停共享。'); }
  function visible(item, device) { return device.id === 'host' || !item.targetId || item.targetId === device.id || item.senderId === device.id; }
  function findFile(id, device, includeTrash = false) {
    const file = state.files.find(f => f.id === id);
    if (!file || (!includeTrash && file.deletedAt) || !visible(file, device)) fail(404, 'FILE_NOT_FOUND', '文件不存在或你无权访问。');
    return file;
  }
  function findTransfer(id, device) {
    const transfer = state.transfers.find(t => t.id === id);
    if (!transfer || (device.id !== 'host' && transfer.senderId !== device.id)) fail(404, 'TRANSFER_NOT_FOUND', '传输任务不存在或你无权访问。');
    return transfer;
  }
  function ownerOnly(item, device) { if (device.id !== 'host' && item.senderId !== device.id) fail(403, 'OWNER_ONLY', '只有发送者和电脑管理员可以删除。'); }
  function validateTarget(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !state.devices.some(d => d.id === value && !d.revoked)) fail(400, 'INVALID_TARGET', '接收设备不存在或已被移除。');
    return value;
  }
  function validateFolder(value, targetId = null) {
    const folderId = value ?? null;
    if (targetId !== null && folderId !== null) fail(400, 'PRIVATE_FOLDER_NOT_ALLOWED', '定向文件不能放入共享目录。');
    folders.find(state.folders, folderId); return folderId;
  }
  function validateFileName(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || !name.isWellFormed() || /[\x00-\x1f\x7f/\\]/.test(name) || name === '.' || name === '..') fail(400, 'INVALID_FILENAME', '文件名无效，不能包含路径、控制字符或不完整的 Unicode 字符。');
    return name;
  }
  function transferView(t) { return { id: t.id, name: t.name, size: t.size, offset: t.offset, status: t.status, fingerprint: t.fingerprint, senderId: t.senderId, targetId: t.targetId, folderId: t.folderId || null, createdAt: t.createdAt, chunkSize }; }
  function guardRequest(req) {
    const authority = req.headers.host;
    if (!authority || authority.includes('@') || authority.includes('/') || authority.includes('\\')) fail(403, 'INVALID_HOST', '不允许此访问地址。');
    let address;
    const secure = !!req.socket.encrypted;
    try { address = new URL(`${secure ? 'https' : 'http'}://${authority}`); } catch { fail(403, 'INVALID_HOST', '不允许此访问地址。'); }
    const port = Number(address.port || (secure ? 443 : 80));
    if (remoteRequests.has(req)) {
      if (!secure || address.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) fail(403, 'INVALID_HOST', '远程连接地址无效。');
    } else if (!localAddresses().has(address.hostname.toLowerCase()) || port !== (secure ? securePort : actualPort)) fail(403, 'INVALID_HOST', '请使用中转站显示的局域网地址。');
    if (req.headers.origin && req.headers.origin !== address.origin) fail(403, 'INVALID_ORIGIN', '拒绝来自其他网页的请求。');
    if (req.url.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'CROSS_SITE_REQUEST', '拒绝来自其他网页的请求。');
  }

  async function route(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    guardRequest(req);
    if (closing) fail(503, 'SHUTTING_DOWN', '中转站正在关闭，请稍后重试。');
    if (state.sharingPaused && externalRequest(req)) fail(503, 'SHARING_PAUSED', '文件池主人已暂停共享。');
    const url = new URL(req.url, `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`);
    const pathname = url.pathname, method = req.method;
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (pathname === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true, name: 'RelayDrop', version: VERSION });
    if (pathname === '/api/identity' && method === 'GET') {
      if (!identity) fail(503, 'TLS_UNAVAILABLE', '此开发服务没有设备证书。');
      return sendJson(res, 200, require('./security.cjs').publicIdentity(identity));
    }

    if (pathname === '/api/pair' && method === 'POST') {
      const input = await readJson(req, 4096);
      const remote = remoteRequests.has(req) ? 'tunnel:' + (trustedRemotePeers.get(req.socket) || 'connection:' + req.socket.remotePort) : req.socket.remoteAddress || 'unknown', cutoff = Date.now() - 10 * 60_000;
      for (const [key, values] of attempts) { const recent = values.filter(t => t > cutoff); if (recent.length) attempts.set(key, recent); else attempts.delete(key); }
      const failures = (attempts.get(remote) || []).filter(t => t > cutoff);
      globalFailures = globalFailures.filter(t => t > cutoff);
      if (failures.length >= 10 || globalFailures.length >= 100) { res.setHeader('Retry-After', '600'); fail(429, 'PAIR_RATE_LIMIT', '配对尝试过多，请 10 分钟后重试。'); }
      if (typeof input.code !== 'string' || !safeEqual(input.code, state.pairing.code) || Date.parse(state.pairing.expiresAt) <= Date.now()) {
        failures.push(Date.now()); attempts.set(remote, failures); globalFailures.push(Date.now());
        fail(403, 'INVALID_PAIR_CODE', '配对码错误或已过期，请在电脑端刷新配对码。');
      }
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) fail(400, 'INVALID_DEVICE_NAME', '设备名称需为 1–60 个字符。');
      if (state.devices.filter(d => !d.revoked).length >= 64) fail(409, 'DEVICE_LIMIT', '已达到 64 台设备上限，请先移除不使用的设备。');
      const credential = token();
      const device = { id: crypto.randomUUID(), name, role: 'guest', tokenHash: hash(credential), revoked: false, createdAt: now(), lastSeen: now() };
      state.devices.push(device); persist(); attempts.delete(remote);
      return sendJson(res, 201, { token: credential, device: publicDevice(device) });
    }

    const contentMatch = pathname.match(/^\/api\/files\/([a-zA-Z0-9-]+)\/(content|media)$/);
    if (contentMatch && (method === 'GET' || method === 'HEAD')) {
      const id = contentMatch[1], media = contentMatch[2] === 'media'; let device;
      const ticketValue = url.searchParams.get('ticket');
      if (ticketValue) {
        const ticket = tickets.get(hash(ticketValue));
        if (!ticket || ticket.fileId !== id || ticket.expiresAt <= Date.now() || (ticket.purpose === 'media') !== media) fail(401, 'INVALID_TICKET', '查看链接已过期或用途不符，请重新打开。');
        device = state.devices.find(d => d.id === ticket.deviceId && !d.revoked);
        if (!device) fail(401, 'AUTH_REVOKED', '设备连接已撤销。');
      } else { if (media) fail(401, 'MEDIA_TICKET_REQUIRED', '请先确认播放并申请临时媒体链接。'); device = authorize(req); }
      trackDevice(req, device);
      const file = findFile(id, device), location = readyPath(id);
      const mediaType = media && pool.mediaType(file);
      if (media && !mediaType) fail(415, 'MEDIA_UNAVAILABLE', '此格式暂不支持在线播放。');
      if (media) await verifySource(file);
      let stat;
      try { stat = await fsp.stat(location); } catch { fail(404, 'FILE_MISSING', '文件已不在中转站中。'); }
      assertStillAuthorized(device); findFile(id, device);
      const etag = `"${file.sha256}"`;
      const headers = { 'Content-Type': media ? mediaType : 'application/octet-stream', 'Content-Disposition': media ? 'inline' : attachment(file.name), 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': new Date(file.createdAt).toUTCString(), 'Cache-Control': 'private, no-store', ...(media ? { 'Content-Security-Policy': "default-src 'none'; sandbox" } : {}) };
      let start = 0, end = stat.size - 1, status = 200;
      if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag || req.headers['if-range'] === headers['Last-Modified'])) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        let invalid = !range || (!range[1] && !range[2]) || stat.size === 0;
        if (!invalid) {
          if (!range[1]) { const suffix = Number(range[2]); invalid = !Number.isSafeInteger(suffix) || suffix <= 0; start = Math.max(0, stat.size - suffix); }
          else { start = Number(range[1]); if (range[2]) end = Number(range[2]); }
          invalid ||= !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= stat.size || start > end;
        }
        if (invalid) return sendJson(res, 416, { error: '下载范围无效。', code: 'INVALID_RANGE' }, { ...headers, 'Content-Range': `bytes */${stat.size}` });
        end = Math.min(end, stat.size - 1); status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = Math.max(0, end - start + 1);
      res.writeHead(status, headers);
      if (method === 'HEAD' || stat.size === 0) { res.end(); return; }
      try { await pipeline(fs.createReadStream(location, { start, end }), res); }
      catch (error) { if (!res.destroyed) res.destroy(error); }
      return;
    }

    if (pathname.startsWith('/api/')) {
      const device = authorize(req);
      if (pathname === '/api/state' && method === 'GET') {
        const devices = state.devices.filter(d => device.id === 'host' || !d.revoked).map(publicDevice);
        return sendJson(res, 200, {
          device: publicDevice(device), devices,
          files: state.files.filter(f => !f.deletedAt && visible(f, device)).map(f => fileView(f, device)).reverse(),
          trash: state.files.filter(f => f.deletedAt && (device.id === 'host' || f.senderId === device.id)).map(f => fileView(f, device)).reverse(),
          collections: preferences(device).collections,
          folders: state.folders,
          storage: { activeBytes: state.files.filter(f => !f.deletedAt && visible(f, device)).reduce((n, f) => n + f.size, 0), trashBytes: state.files.filter(f => f.deletedAt && (device.id === 'host' || f.senderId === device.id)).reduce((n, f) => n + f.size, 0), scope: device.id === 'host' ? 'host' : 'visible', ...(device.id === 'host' ? { dataDir, ...await fsp.statfs(dataDir).then(stat => ({ availableBytes: stat.bavail * stat.bsize })).catch(() => ({})) } : {}) },
          transfers: state.transfers.filter(t => t.status !== 'complete' && (device.id === 'host' || t.senderId === device.id)).map(transferView).reverse(),
          notes: state.notes.filter(n => visible(n, device)).slice().reverse(),
          network: { urls: identity ? lanUrls(securePort, true) : [], hostname: os.hostname(), port: identity ? securePort : actualPort, platform: process.platform },
          sharing: getSharingState(),
          security: { sharingPaused: state.sharingPaused === true, tlsEnabled: !!identity, serverId: identity?.serverId || null, certificateFingerprint: identity?.fingerprint || null, certificateExpiresAt: identity?.expiresAt || null, transport: req.socket.encrypted ? 'tls' : 'loopback' },
          capabilities: { androidInstaller: hasAndroidInstaller(), fileOrganization: true, sharedFolders: true, duplicateDetection: true, mediaPreview: true, pagedPreview: typeof options.createThumbnail === 'function', trash: true, textPreview: true, richPreview: typeof options.createThumbnail === 'function' },
          pairing: device.id === 'host' ? state.pairing : null,
          limits: { chunkSize, maxFileSize }, bluetooth: { available: process.platform === 'win32' && fs.existsSync(path.join(__dirname, 'bluetooth.cjs')) },
        });
      }
      if (pathname === '/api/folders/ensure' && method === 'POST') {
        const input = await readJson(req, 8192); assertStillAuthorized(device);
        if (Object.keys(input).some(key => !['parentId', 'path'].includes(key))) fail(400, 'INVALID_FOLDER_PATH', '共享目录参数无效。');
        const result = folders.ensure(state.folders, input.parentId, input.path, device); persist(); return sendJson(res, 200, result);
      }
      const folderMatch = pathname.match(/^\/api\/folders\/([a-zA-Z0-9-]+)$/);
      if (folderMatch && ['PATCH', 'DELETE'].includes(method)) {
        const input = await readJson(req, 2048); assertStillAuthorized(device);
        const result = method === 'PATCH' ? folders.update(state.folders, folderMatch[1], input, device) : folders.remove(state, folderMatch[1], device);
        persist(); return sendJson(res, 200, result);
      }
      if (pathname === '/api/files/duplicates' && method === 'POST') {
        const input = await readJson(req, 2048); assertStillAuthorized(device);
        if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxFileSize || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sha256)) fail(400, 'INVALID_DUPLICATE_QUERY', '重复文件查询需要完整 SHA-256 和有效大小。');
        const targetId = validateTarget(input.targetId), folderId = validateFolder(input.folderId, targetId), sha256 = input.sha256.toLowerCase();
        const candidates = state.files.filter(file => !file.deletedAt && visible(file, device) && (file.targetId || null) === targetId && (file.folderId || null) === folderId && file.sha256 === sha256 && file.size === input.size).slice(0, 20);
        const matches = [];
        for (const file of candidates) {
          try { await verifySource(file); } catch (error) { if (error.code === 'FILE_HASH_MISMATCH' || error.code === 'ENOENT') continue; throw error; }
          assertStillAuthorized(device);
          if (state.files.includes(file) && !file.deletedAt && visible(file, device) && (file.targetId || null) === targetId && (file.folderId || null) === folderId) matches.push(fileView(file, device));
        }
        assertStillAuthorized(device); return sendJson(res, 200, { matches });
      }
      const locationMatch = pathname.match(/^\/api\/files\/([a-zA-Z0-9-]+)\/location$/);
      if (locationMatch && method === 'PATCH') {
        const input = await readJson(req, 2048); assertStillAuthorized(device);
        if (!Object.hasOwn(input, 'folderId') || Object.keys(input).some(key => !['folderId', 'name'].includes(key))) fail(400, 'INVALID_FILE_LOCATION', '文件位置设置无效。');
        const file = findFile(locationMatch[1], device); ownerOnly(file, device);
        if (file.targetId) fail(400, 'PRIVATE_FOLDER_NOT_ALLOWED', '定向文件不能放入共享目录或通过共享目录更名。');
        const folderId = validateFolder(input.folderId), name = input.name === undefined ? file.name : validateFileName(input.name);
        file.folderId = folderId; file.name = name; persist(); invalidatePreview(file.id);
        return sendJson(res, 200, fileView(file, device));
      }
      if (pathname === '/api/collections' && method === 'POST') {
        const input = await readJson(req, 1024), name = typeof input.name === 'string' ? input.name.trim() : '';
        assertStillAuthorized(device);
        if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) fail(400, 'INVALID_COLLECTION', '文件夹名称需为 1–64 个字符。');
        const prefs = preferences(device, true);
        if (!prefs.collections.includes(name)) { if (prefs.collections.length >= 100) fail(409, 'COLLECTION_LIMIT', '最多可建立 100 个文件夹。'); prefs.collections.push(name); persist(); }
        return sendJson(res, 200, { name });
      }
      if (pathname.startsWith('/api/collections/') && method === 'DELETE') {
        let name; try { name = decodeURIComponent(pathname.slice('/api/collections/'.length)); } catch { fail(400, 'INVALID_COLLECTION', '文件夹名称无效。'); }
        const prefs = preferences(device, true); prefs.collections = prefs.collections.filter(n => n !== name);
        for (const value of Object.values(prefs.files)) if (value.collection === name) value.collection = null;
        persist(); return sendJson(res, 200, { ok: true });
      }
      const textMatch = pathname.match(/^\/api\/files\/([a-zA-Z0-9-]+)\/text$/);
      if (textMatch && (method === 'GET' || method === 'HEAD')) {
        const file = findFile(textMatch[1], device);
        if (pool.previewKind(file) !== 'text') fail(415, 'TEXT_PREVIEW_UNAVAILABLE', '仅支持不超过 256 KiB 的文本文件预览。');
        const handle = await fsp.open(readyPath(file.id), 'r'); let bytes;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size !== file.size) fail(422, 'FILE_HASH_MISMATCH', '文本文件大小已变化。');
          const buffer = Buffer.alloc(file.size + 1); let total = 0;
          while (total < buffer.length) { const read = await handle.read(buffer, total, buffer.length - total, total); if (!read.bytesRead) break; total += read.bytesRead; }
          bytes = buffer.subarray(0, total);
        } finally { await handle.close(); }
        if (bytes.length !== file.size || hash(bytes) !== file.sha256) fail(422, 'FILE_HASH_MISMATCH', '文本完整性校验失败，未显示预览。');
        let text; try { text = pool.decodeText(bytes); } catch { fail(415, 'TEXT_ENCODING_UNSUPPORTED', '文本编码暂不支持；请保存后查看。支持 UTF-8 和带 BOM 的 UTF-16。'); }
        assertStillAuthorized(device); findFile(file.id, device);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        res.end(method === 'HEAD' ? undefined : text); return;
      }
      const previewMatch = pathname.match(/^\/api\/files\/([a-zA-Z0-9-]+)\/preview$/);
      if (previewMatch && (method === 'GET' || method === 'HEAD')) {
        const file = findFile(previewMatch[1], device);
        const mode = url.searchParams.get('mode') || 'thumbnail', rawPage = url.searchParams.get('page') || '1', page = Number(rawPage);
        if (!['thumbnail', 'detail'].includes(mode) || !/^\d+$/.test(rawPage) || !Number.isSafeInteger(page) || page < 1 || page > 1000 || (pool.previewKind(file) !== 'pdf' && page !== 1)) fail(400, 'INVALID_PREVIEW_PAGE', '预览模式或页码无效，最多可查看前 1000 页。');
        const controller = new AbortController(), onClose = () => { if (!res.writableEnded) controller.abort(); }; res.once('close', onClose);
        let result;
        try { result = await thumbnail(file, { mode, page, edge: mode === 'detail' ? 1280 : 320 }, AbortSignal.any([controller.signal, requestScope.getStore().controller.signal])); }
        finally { res.off('close', onClose); }
        const { bytes, pageCount } = result;
        assertStillAuthorized(device); findFile(file.id, device);
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Preview-Page': String(page), 'X-Preview-Pages': String(pageCount) });
        res.end(method === 'HEAD' ? undefined : bytes); return;
      }
      if (pathname === '/api/sharing' && method === 'POST') { hostOnly(device); const input = await readJson(req, 1024); if (Object.keys(input).some(key => key !== 'paused')) fail(400, 'INVALID_SHARING_STATE', '共享暂停设置无效。'); return sendJson(res, 200, setSharingPaused(input.paused)); }
      if (pathname === '/api/pairing/reset-limits' && method === 'POST') { hostOnly(device); await readJson(req, 1024); attempts.clear(); globalFailures = []; return sendJson(res, 200, { ok: true, pairing: rotatePairing() }); }
      if (pathname === '/api/pairing/rotate' && method === 'POST') { hostOnly(device); await readJson(req, 1024); return sendJson(res, 200, rotatePairing()); }
      const revokeMatch = pathname.match(/^\/api\/devices\/([a-zA-Z0-9-]+)\/revoke$/);
      if (revokeMatch && method === 'POST') {
        hostOnly(device); await readJson(req, 1024);
        const target = state.devices.find(d => d.id === revokeMatch[1] && d.id !== 'host');
        if (!target) fail(404, 'DEVICE_NOT_FOUND', '设备不存在。');
        target.revoked = true; target.revokedAt = now(); persist();
        for (const [key, item] of tickets) if (item.deviceId === target.id) tickets.delete(key);
        interruptActivities(entry => entry.deviceId === target.id);
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/transfers' && method === 'POST') {
        const input = await readJson(req, 8192);
        assertStillAuthorized(device);
        const name = validateFileName(input.name);
        if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxFileSize) fail(400, 'INVALID_FILE_SIZE', `文件大小须介于 0 和 ${maxFileSize} 字节之间。`);
        if (typeof input.fingerprint !== 'string' || input.fingerprint.length !== 64 || !/^[a-f0-9]{64}$/i.test(input.fingerprint)) fail(400, 'INVALID_FINGERPRINT', '文件识别信息无效，必须提供完整文件的 SHA-256。');
        const targetId = validateTarget(input.targetId), folderId = validateFolder(input.folderId, targetId);
        const fingerprint = input.fingerprint.toLowerCase();
        const existing = state.transfers.find(t => t.status !== 'complete' && t.senderId === device.id && t.fingerprint === fingerprint && t.name === name && t.size === input.size && t.targetId === targetId && (t.folderId || null) === folderId);
        if (existing) return sendJson(res, 200, transferView(existing));
        if (state.transfers.filter(t => t.status !== 'complete').length >= 1000) fail(409, 'TRANSFER_LIMIT', '待完成传输过多，请先取消不需要的任务。');
        const id = crypto.randomUUID();
        const transfer = { id, name, size: input.size, lastModified: Number.isFinite(input.lastModified) ? input.lastModified : 0, fingerprint, senderId: device.id, senderName: device.name, targetId, folderId, offset: 0, status: 'uploading', createdAt: now() };
        // Empty-file creation and registration are one synchronous critical section.
        fs.writeFileSync(partPath(id), Buffer.alloc(0), { flag: 'wx' });
        state.transfers.push(transfer);
        try { persist(); } catch (error) { try { fs.unlinkSync(partPath(id)); } catch {} throw error; }
        return sendJson(res, 201, transferView(transfer));
      }
      const transferMatch = pathname.match(/^\/api\/transfers\/([a-zA-Z0-9-]+)(\/complete)?$/);
      if (transferMatch) {
        const id = transferMatch[1];
        if (method === 'GET' && !transferMatch[2]) return sendJson(res, 200, transferView(findTransfer(id, device)));
        if (method === 'PUT' && !transferMatch[2]) {
          findTransfer(id, device);
          const offsetHeader = req.headers['x-offset'], digestHeader = req.headers['x-chunk-sha256'];
          if (typeof offsetHeader !== 'string' || !/^\d+$/.test(offsetHeader) || !Number.isSafeInteger(Number(offsetHeader))) fail(400, 'INVALID_OFFSET', '分块偏移无效。');
          if (typeof digestHeader !== 'string' || !/^[a-f0-9]{64}$/i.test(digestHeader)) fail(400, 'CHECKSUM_REQUIRED', '每个分块都需要 SHA-256 校验值。');
          const data = await readBody(req, chunkSize);
          if (!data.length) fail(400, 'EMPTY_CHUNK', '不能上传空数据块。');
          if (!safeEqual(hash(data), digestHeader.toLowerCase())) fail(422, 'CHECKSUM_MISMATCH', '分块校验失败，请重试。');
          return locked(id, async () => {
            assertStillAuthorized(device);
            const transfer = findTransfer(id, device);
            if (transfer.status === 'complete') fail(409, 'ALREADY_COMPLETE', '文件已完成上传。', { offset: transfer.offset });
            if (Number(offsetHeader) !== transfer.offset) fail(409, 'OFFSET_MISMATCH', '传输位置已更新，请同步后继续。', { offset: transfer.offset });
            if (transfer.offset + data.length > transfer.size) fail(400, 'SIZE_EXCEEDED', '数据超过文件声明大小。');
            let handle;
            try {
              handle = await fsp.open(partPath(id), 'r+');
              let written = 0;
              while (written < data.length) {
                const result = await handle.write(data, written, data.length - written, transfer.offset + written);
                if (result.bytesWritten === 0) throw Object.assign(new Error('Cannot write'), { code: 'EIO' });
                written += result.bytesWritten;
              }
              await handle.sync();
              assertStillAuthorized(device);
              transfer.offset += data.length; persist();
            } catch (error) {
              // A failed disk write must not advertise partially written bytes as a valid chunk.
              if (handle && transfer.offset === Number(offsetHeader)) await handle.truncate(transfer.offset).catch(() => {});
              throw error;
            } finally { if (handle) await handle.close(); }
            return sendJson(res, 200, { id, offset: transfer.offset });
          });
        }
        if (method === 'POST' && transferMatch[2]) {
          await readJson(req, 1024);
          return locked(id, async () => {
            assertStillAuthorized(device);
            const transfer = findTransfer(id, device);
            const published = transfer.status === 'complete' ? findFile(id, device) : null;
            if (transfer.offset !== transfer.size) fail(409, 'INCOMPLETE_UPLOAD', '文件尚未上传完整。', { offset: transfer.offset });
            const partial = partPath(id), ready = readyPath(id);
            const source = !published && fs.existsSync(partial) ? partial : ready;
            const stat = await fsp.stat(source);
            if (stat.size !== transfer.size) fail(409, 'SIZE_MISMATCH', '磁盘文件大小不一致，请重新上传。', { offset: stat.size });
            const sha256 = await fileHash(source);
            assertStillAuthorized(device);
            const expected = typeof transfer.fingerprint === 'string' ? transfer.fingerprint.toLowerCase() : '';
            if (expected.length !== 64 || !/^[a-f0-9]{64}$/.test(expected) || !safeEqual(sha256, expected)) {
              fail(422, 'FILE_HASH_MISMATCH', published ? '已保存文件与原文件校验不一致，请删除中转站副本后重新上传。' : '完整文件校验失败，文件未发布。请取消此任务后重新上传原文件。', { expectedSha256: expected, actualSha256: sha256, offset: transfer.offset });
            }
            if (published) {
              if (!safeEqual(String(published.sha256 || '').toLowerCase(), sha256)) fail(422, 'FILE_HASH_MISMATCH', '已完成文件的校验记录不一致，请删除中转站副本后重新上传。', { expectedSha256: expected, actualSha256: sha256 });
              return sendJson(res, 200, fileView(published, device));
            }
            if (source !== ready) await fsp.rename(source, ready);
            assertStillAuthorized(device);
            const file = { id, name: transfer.name, size: transfer.size, sha256, createdAt: now(), senderId: transfer.senderId, senderName: transfer.senderName, targetId: transfer.targetId, folderId: transfer.folderId || null };
            transfer.status = 'complete'; state.files.push(file); persist();
            return sendJson(res, 200, fileView(file, device));
          });
        }
        if (method === 'DELETE' && !transferMatch[2]) return locked(id, async () => {
          assertStillAuthorized(device);
          const transfer = findTransfer(id, device);
          if (transfer.status === 'complete') fail(409, 'ALREADY_COMPLETE', '文件已经上传完成，请在文件列表中删除。');
          await discardFiles([partPath(id), readyPath(id)], () => { state.transfers = state.transfers.filter(t => t.id !== id); });
          return sendJson(res, 200, { ok: true });
        });
      }
      const trashMatch = pathname.match(/^\/api\/files\/([a-zA-Z0-9-]+)\/(restore|permanent)$/);
      if (trashMatch && ((trashMatch[2] === 'restore' && method === 'POST') || (trashMatch[2] === 'permanent' && method === 'DELETE'))) {
        if (method === 'POST') await readJson(req, 1024);
        return locked(trashMatch[1], async () => {
          assertStillAuthorized(device); const file = findFile(trashMatch[1], device, true); ownerOnly(file, device);
          if (!file.deletedAt) fail(409, 'NOT_IN_TRASH', '文件不在回收站中。');
          if (trashMatch[2] === 'restore') { delete file.deletedAt; delete file.deletedBy; persist(); return sendJson(res, 200, fileView(file, device)); }
          await discardFiles([readyPath(file.id)], () => {
            state.files = state.files.filter(f => f.id !== file.id); state.transfers = state.transfers.filter(t => t.id !== file.id);
            for (const prefs of Object.values(state.preferences || {})) delete prefs.files?.[file.id];
          });
          invalidatePreview(file.id); return sendJson(res, 200, { ok: true });
        });
      }
      const fileMatch = pathname.match(/^\/api\/files\/([a-zA-Z0-9-]+)(\/ticket)?$/);
      if (fileMatch) {
        const id = fileMatch[1];
        if (method === 'POST' && fileMatch[2]) {
          const input = await readJson(req, 1024); assertStillAuthorized(device); const file = findFile(id, device);
          const purpose = input.purpose === undefined ? 'download' : input.purpose;
          if (!['download', 'media'].includes(purpose)) fail(400, 'INVALID_TICKET_PURPOSE', '查看链接用途无效。');
          if (purpose === 'media' && !pool.mediaType(file)) fail(415, 'MEDIA_UNAVAILABLE', '此格式暂不支持在线播放。');
          for (const [key, item] of tickets) if (item.expiresAt <= Date.now()) tickets.delete(key);
          if (tickets.size >= 10_000) fail(429, 'TICKET_LIMIT', '下载请求过多，请稍后再试。');
          const secret = token(), expiresAt = Date.now() + (purpose === 'media' ? 5 : 10) * 60_000;
          tickets.set(hash(secret), { fileId: id, deviceId: device.id, expiresAt, purpose });
          return sendJson(res, 200, { url: `/api/files/${id}/${purpose === 'media' ? 'media' : 'content'}?ticket=${encodeURIComponent(secret)}`, expiresAt: new Date(expiresAt).toISOString(), ...(purpose === 'media' ? { ticket: secret } : {}) });
        }
        if (method === 'DELETE' && fileMatch[2]) {
          const input = await readJson(req, 1024); assertStillAuthorized(device);
          if (typeof input.ticket !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(input.ticket)) fail(400, 'INVALID_TICKET', '临时查看链接无效。');
          const key = hash(input.ticket), ticket = tickets.get(key);
          if (ticket && (ticket.deviceId !== device.id || ticket.fileId !== id)) fail(403, 'TICKET_OWNER_ONLY', '只能关闭本设备申请的查看链接。');
          tickets.delete(key); return sendJson(res, 200, { ok: true });
        }
        if (method === 'DELETE' && !fileMatch[2]) return locked(id, async () => {
          assertStillAuthorized(device); const file = findFile(id, device); ownerOnly(file, device);
          file.deletedAt = now(); file.deletedBy = device.id; persist();
          for (const [key, item] of tickets) if (item.fileId === id) tickets.delete(key);
          invalidatePreview(id);
          return sendJson(res, 200, { ok: true });
        });
        if (method === 'PATCH' && !fileMatch[2]) {
          const input = await readJson(req, 2048), keys = Object.keys(input);
          assertStillAuthorized(device);
          if (!keys.length || keys.some(key => !['favorite', 'collection'].includes(key)) || ('favorite' in input && typeof input.favorite !== 'boolean') || ('collection' in input && input.collection !== null && typeof input.collection !== 'string')) fail(400, 'INVALID_FILE_PREFERENCE', '文件整理设置无效。');
          const file = findFile(id, device), prefs = preferences(device, true);
          if (input.collection !== undefined && input.collection !== null && !prefs.collections.includes(input.collection)) fail(400, 'COLLECTION_NOT_FOUND', '请先建立文件夹。');
          prefs.files[id] = { ...prefs.files[id], ...input }; persist(); return sendJson(res, 200, fileView(file, device));
        }
      }
      if (pathname === '/api/notes' && method === 'POST') {
        const input = await readJson(req, 96 * 1024);
        assertStillAuthorized(device);
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20_000 || input.text.includes('\u0000')) fail(400, 'INVALID_NOTE', '文字内容需为 1–20000 个字符。');
        const targetId = validateTarget(input.targetId), clientId = input.clientId;
        if (clientId !== undefined && (typeof clientId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(clientId))) fail(400, 'INVALID_CLIENT_ID', '任务编号无效。');
        if (clientId) {
          const previous = state.notes.find(n => n.senderId === device.id && n.clientId === clientId);
          if (previous) { if (previous.text !== input.text || previous.targetId !== targetId) fail(409, 'CLIENT_ID_CONFLICT', '任务编号已用于不同的文字或接收设备。'); return sendJson(res, 200, previous); }
        }
        if (state.notes.length >= 5000) fail(409, 'NOTE_LIMIT', '文字收件箱已满，请删除不需要的内容。');
        const note = { id: crypto.randomUUID(), text: input.text, createdAt: now(), senderId: device.id, senderName: device.name, targetId, ...(clientId ? { clientId } : {}) };
        state.notes.push(note); persist(); return sendJson(res, 201, note);
      }
      const noteMatch = pathname.match(/^\/api\/notes\/([a-zA-Z0-9-]+)$/);
      if (noteMatch && method === 'DELETE') {
        const note = state.notes.find(n => n.id === noteMatch[1] && visible(n, device));
        if (!note) fail(404, 'NOTE_NOT_FOUND', '文字内容不存在或你无权访问。');
        ownerOnly(note, device); state.notes = state.notes.filter(n => n.id !== note.id); persist(); return sendJson(res, 200, { ok: true });
      }
      const bluetoothMatch = pathname.match(/^\/api\/bluetooth\/(send|receive|settings)$/);
      if (bluetoothMatch && method === 'POST') {
        hostOnly(device); await readJson(req, 1024);
        if (process.platform !== 'win32' || !fs.existsSync(path.join(__dirname, 'bluetooth.cjs'))) fail(501, 'BLUETOOTH_UNAVAILABLE', '此设备无法打开 Windows 蓝牙工具。');
        const result = await require('./bluetooth.cjs').launch(bluetoothMatch[1]);
        return sendJson(res, 200, { ok: true, message: typeof result === 'string' ? result : result?.message || '已打开系统蓝牙工具，请在系统窗口中继续。' });
      }
      fail(404, 'NOT_FOUND', '接口不存在。');
    }

    if (method !== 'GET' && method !== 'HEAD') fail(405, 'METHOD_NOT_ALLOWED', '不支持此请求方式。');
    const staticFiles = {
      '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
      '/sha256.js': ['sha256.js', 'text/javascript; charset=utf-8'], '/qr.js': ['qr.js', 'text/javascript; charset=utf-8'],
      '/pool-convenience.js': ['pool-convenience.js', 'text/javascript; charset=utf-8'], '/convenience.css': ['convenience.css', 'text/css; charset=utf-8'],
      '/pool.js': ['pool.js', 'text/javascript; charset=utf-8'], '/pool-library.js': ['pool-library.js', 'text/javascript; charset=utf-8'], '/pool-navigation.js': ['pool-navigation.js', 'text/javascript; charset=utf-8'],
      '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/icon.svg': ['icon.svg', 'image/svg+xml'],
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
      '/RelayDrop-Android.apk': ['../RelayDrop-Android.apk', 'application/vnd.android.package-archive'],
    };
    const entry = staticFiles[pathname];
    if (!entry) fail(404, 'NOT_FOUND', '页面不存在。');
    const location = pathname === '/RelayDrop-Android.apk' ? androidApkPath : path.join(__dirname, 'public', entry[0]);
    let stat;
    try { stat = await fsp.stat(location); } catch { fail(404, 'NOT_FOUND', '页面资源尚未安装。'); }
    if (!stat.isFile()) fail(404, 'NOT_FOUND', '页面资源尚未安装。');
    // The Android save flow verifies every downloaded byte against a strong SHA-256 ETag.
    // Hash only the installer here; ordinary page assets do not use the download flow.
    if (pathname === '/RelayDrop-Android.apk') {
      res.setHeader('ETag', `"${await fileHash(location)}"`);
      res.setHeader('Content-Disposition', attachment('RelayDrop-Android.apk'));
    }
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
    if (method === 'HEAD') { res.end(); return; }
    try { await pipeline(fs.createReadStream(location), res); } catch { if (!res.destroyed) res.destroy(); }
  }

  const server = http.createServer((req, res) => {
    const activity = { req, res, external: externalRequest(req), deviceId: null, controller: new AbortController() }; activities.add(activity);
    const cleanup = () => { activities.delete(activity); if (!res.writableEnded) activity.controller.abort(); }; res.once('finish', cleanup); res.once('close', cleanup);
    requestScope.run(activity, () => route(req, res)).catch(error => {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      if (error instanceof HttpError || error instanceof folders.FolderError) sendJson(res, error.status, { error: error.message, code: error.code, ...error.extra });
      else if (error.code === 'ENOSPC' || error.code === 'EDQUOT') sendJson(res, 507, { error: '电脑磁盘空间不足。释放空间后可继续上传。', code: 'DISK_FULL' });
      else if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EBUSY') sendJson(res, 503, { error: '文件被占用或无写入权限，请稍后重试。', code: 'STORAGE_UNAVAILABLE' });
      else if (error.code === 'ENOENT') sendJson(res, 404, { error: '文件已被移走或删除，请刷新后重试。', code: 'FILE_MISSING' });
      else { console.error(`[RelayDrop] 请求失败: ${error.code || error.name || 'Error'}`); sendJson(res, 500, { error: '操作未完成，请重试。若持续发生，请检查电脑端运行窗口。', code: 'INTERNAL_ERROR' }); }
      req.resume();
    });
  });
  const secureServer = identity ? https.createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' }, (req, res) => server.emit('request', req, res)) : null;
  function configureListener(listener) {
    listener.requestTimeout = 120_000;
    listener.headersTimeout = 15_000;
    listener.keepAliveTimeout = 5_000;
    listener.maxHeadersCount = 50;
    listener.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  }
  for (const listener of [server, secureServer].filter(Boolean)) configureListener(listener);
  async function openRemoteEndpoint() {
    if (!identity || !listening || closing || !lease.held) throw new Error('请先启动安全文件池。');
    if (remoteEndpoint) return remoteEndpoint;
    if (remoteOpening) return remoteOpening;
    remoteOpening = (async () => {
      const listener = https.createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' }, (req, res) => {
        remoteRequests.add(req); server.emit('request', req, res);
      });
      configureListener(listener);
      const sockets = new Set(), registeredPeers = new Map();
      listener.maxConnections = 64;
      listener.on('connection', socket => { const peerPort = socket.remotePort; sockets.add(socket); socket.once('close', () => { sockets.delete(socket); registeredPeers.delete(peerPort); }); });
      listener.on('secureConnection', socket => { const peer = registeredPeers.get(socket.remotePort); if (peer) trustedRemotePeers.set(socket, peer); });
      const endpoint = { port: 0, close: null, registerPeer(localPort, peerId) { if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535 || !/^[a-f0-9]{64}$/.test(peerId)) throw new Error('无效可信隧道会话。'); if (registeredPeers.size >= 64 && !registeredPeers.has(localPort)) throw new Error('可信隧道会话数量超限。'); registeredPeers.set(localPort, peerId); }, destroyConnections() { for (const socket of sockets) socket.destroy(); } };
      let closePromise;
      endpoint.close = () => closePromise ||= (async () => {
        if (remoteEndpoint === endpoint) remoteEndpoint = null;
        endpoint.destroyConnections();
        if (listener.listening) await new Promise(resolve => listener.close(resolve));
      })();
      try {
        await new Promise((resolve, reject) => {
          const onError = error => { listener.off('listening', onListen); reject(error); };
          const onListen = () => { listener.off('error', onError); resolve(); };
          listener.once('error', onError); listener.once('listening', onListen); listener.listen(0, '127.0.0.1');
        });
        if (closing || !lease.held) throw new Error('文件池正在关闭。');
        endpoint.port = listener.address().port; remoteEndpoint = endpoint;
        return endpoint;
      } catch (error) { await endpoint.close(); throw error; }
    })();
    try { return await remoteOpening; } finally { remoteOpening = null; }
  }
  // Existing desktop lifecycle callers close the facade's connections; include encrypted peers.
  const closeHttpConnections = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => { closeHttpConnections(); secureServer?.closeAllConnections(); remoteEndpoint?.destroyConnections(); };
  let listening = false, stopDiscovery = null;
  async function listen() {
    if (listening) return actualPort;
    if (closing || !lease.held) throw new Error('此中转站实例已经关闭。');
    const listenOn = (listener, port, host) => new Promise((resolve, reject) => {
      const onError = error => { listener.off('listening', onListen); reject(error); };
      const onListen = () => { listener.off('error', onError); resolve(); };
      listener.once('error', onError); listener.once('listening', onListen); listener.listen(port, host);
    });
    try {
      if (secureServer) { await listenOn(secureServer, configuredPort, bindHost); securePort = secureServer.address().port; }
      await listenOn(server, secureServer ? 0 : configuredPort, secureServer ? '127.0.0.1' : bindHost);
    } catch (error) {
      closing = true;
      for (const listener of [server, secureServer].filter(Boolean)) if (listener.listening) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
      lease.release(); throw error;
    }
    actualPort = server.address().port; listening = true;
    if (!state.sharingPaused && options.discovery !== false && bindHost !== '127.0.0.1') {
      try { stopDiscovery = require('./discovery.cjs').startDiscovery(secureServer ? securePort : actualPort, identity); } catch {}
    }
    try { fs.writeFileSync(path.join(dataDir, 'launch.json'), JSON.stringify({ url: `http://127.0.0.1:${actualPort}/#host=${hostToken}`, port: actualPort, pid: process.pid }), { mode: 0o600 }); }
    catch (error) { await close(); throw error; }
    return actualPort;
  }
  async function close() {
    if (!lease.held) return;
    closing = true;
    previewAbort.abort();
    interruptActivities(entry => entry.external);
    if (stopDiscovery) { stopDiscovery(); stopDiscovery = null; }
    try {
      if (remoteOpening) await remoteOpening.catch(() => {});
      if (remoteEndpoint) await remoteEndpoint.close();
      if (listening) await Promise.all([server, secureServer].filter(Boolean).map(listener => new Promise(resolve => { listener.close(resolve); listener.closeIdleConnections(); })));
      await Promise.allSettled([...locks.values(), ...[...previewJobs.values()].map(job => job.promise), ...verificationJobs.values()]); previews.clear(); verifiedSources.clear(); previewBytes = 0; persist(); listening = false;
    } finally { lease.release(); }
  }
  return { server, secureServer, listen, close, openRemoteEndpoint, setSharingPaused, getSharingState, hostToken, dataDir, get securePort() { return secureServer ? securePort : null; }, identity: identity ? { id: identity.serverId, fingerprint: identity.fingerprint, expiresAt: identity.expiresAt } : null };
}

module.exports = { createRelayServer, createSecureRelayServer, acquireDataLease };
if (require.main === module) {
  createSecureRelayServer().then(async relay => {
    await relay.listen(); const port = relay.securePort;
    console.log(`RelayDrop ${VERSION} 已启动，端口 ${port}。`);
    console.log('通过启动脚本打开管理页面；手机和平板请扫描管理页面的二维码。');
    console.log(`传输文件保存在：${path.join(relay.dataDir, 'files')}`);
    for (const url of lanUrls(port, true)) console.log(`局域网入口：${url}`);
    const shutdown = () => { relay.close().then(() => process.exit(0)).catch(() => process.exit(1)); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  }).catch(error => {
    if (error.code === 'EADDRINUSE') console.error('RelayDrop 启动失败：端口已被占用，可能已经启动。请使用启动脚本重新打开。');
    else console.error(`RelayDrop 启动失败：${error.code || error.message}`);
    process.exitCode = 1;
  });
}
