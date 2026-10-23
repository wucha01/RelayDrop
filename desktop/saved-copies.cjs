'use strict';
// Only native verified-save callers may register a destination. No renderer IPC
// accepts a path, identity, or receipt to register here.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORDS = 3000;
const MAX_BYTES = 4 * 1024 * 1024;
function context(state) {
  const serverId = state?.security?.serverId, deviceId = state?.device?.id;
  if (!UUID.test(serverId || '') || !(deviceId === 'host' || UUID.test(deviceId || ''))) throw new Error('无法确认当前文件池和设备身份。');
  return { serverId, deviceId };
}
function metadata(file) {
  if (!UUID.test(file?.id || '') || !HASH.test(file?.sha256 || '') || !Number.isSafeInteger(file?.size) || file.size < 0 || file.size > 20 * 1024 ** 3) throw new Error('文件完整性记录无效。');
  return { fileId: file.id, sha256: file.sha256, size: file.size };
}
function key(value) { return [value.serverId, value.deviceId, value.fileId, value.sha256].join(':'); }
function identity(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs }; }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
async function inspect(destination) {
  const stat = await fsp.lstat(destination);
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await fsp.realpath(destination), path.resolve(destination))) throw Object.assign(new Error('本机副本已被替换。'), { code: 'COPY_CHANGED' });
  return identity(stat);
}
async function verifyStable(record) {
  const before = await inspect(record.path);
  if (before.size !== record.size) throw Object.assign(new Error('本机副本内容已变化。'), { code: 'COPY_CHANGED' });
  let handle;
  try {
    handle = await fsp.open(record.path, 'r');
    if (!same(before, identity(await handle.stat()))) throw Object.assign(new Error('本机副本已被替换。'), { code: 'COPY_CHANGED' });
    const hash = crypto.createHash('sha256'); let size = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      size += bytes.length;
      if (size > record.size) throw Object.assign(new Error('本机副本内容已变化。'), { code: 'COPY_CHANGED' });
      hash.update(bytes);
    }
    if (size !== record.size || hash.digest('hex') !== record.sha256 || !same(before, identity(await handle.stat())) || !same(before, await inspect(record.path))) throw Object.assign(new Error('本机副本内容已变化。'), { code: 'COPY_CHANGED' });
    return before;
  } finally { await handle?.close().catch(() => {}); }
}
function createSavedCopies(directory, { now = Date.now } = {}) {
  const filename = path.join(directory, 'saved-copies.json'), cache = new Map(), checking = new Map();
  let records = [], loadError = null, serial = Promise.resolve();
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('invalid receipt file');
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (value?.version !== 1 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw new Error('invalid receipts');
    const seen = new Set();
    records = value.records.map(record => {
      context({ security: { serverId: record?.serverId }, device: { id: record?.deviceId } });
      metadata({ id: record?.fileId, sha256: record?.sha256, size: record?.size });
      if (typeof record.path !== 'string' || !path.isAbsolute(record.path) || record.path.length > 32760 || /[\x00-\x1f]/.test(record.path) || !Number.isSafeInteger(record.savedAt) || record.savedAt < 0 || seen.has(key(record))) throw new Error('invalid receipt');
      seen.add(key(record));
      return { serverId: record.serverId, deviceId: record.deviceId, fileId: record.fileId, sha256: record.sha256, size: record.size, path: record.path, savedAt: record.savedAt, ...(typeof record.name === 'string' && record.name.length <= 255 ? { name: record.name } : {}) };
    });
  } catch (error) { if (error.code !== 'ENOENT') { records = []; loadError = new Error('本机保存记录无法读取；原文件不会删除，请重新保存或检查数据目录。'); } }
  function available() { if (loadError) throw loadError; }
  const exclusive = action => { const run = serial.then(action); serial = run.catch(() => {}); return run; };
  async function persist(next) {
    const temporary = filename + '.' + crypto.randomUUID() + '.tmp'; let handle;
    try {
      handle = await fsp.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ version: 1, records: next })); await handle.sync(); await handle.close(); handle = null;
      await fsp.rename(temporary, filename); records = next;
    } finally { await handle?.close().catch(() => {}); await fsp.unlink(temporary).catch(() => {}); }
  }
  function find(state, id, sha256) {
    available(); const scope = context(state);
    const file = state.files?.find(item => item.id === id && (!sha256 || item.sha256 === sha256));
    if (!file) return null;
    const current = { ...scope, ...metadata(file) };
    return records.find(item => key(item) === key(current) && item.size === current.size) || null;
  }
  async function checked(record) {
    const checkKey = JSON.stringify([key(record), record.path]);
    let pending = checking.get(checkKey);
    if (!pending) { pending = verifyStable(record); checking.set(checkKey, pending); }
    try { return await pending; } finally { if (checking.get(checkKey) === pending) checking.delete(checkKey); }
  }
  async function status(record, force = false) {
    let current;
    try {
      current = await inspect(record.path); const cached = cache.get(key(record));
      if (current.size !== record.size) throw Object.assign(new Error('changed'), { code: 'COPY_CHANGED' });
      if (!force && cached && cached.path === record.path && same(current, cached.identity)) return cached.status;
      cache.set(key(record), { path: record.path, identity: await checked(record), status: 'saved' });
      return 'saved';
    } catch (error) {
      cache.delete(key(record));
      // A stable damaged large file must not be fully re-read on every UI poll.
      // Opening always bypasses this cache; any stat change triggers a new hash.
      if (error.code === 'COPY_CHANGED' && current && same(current, await inspect(record.path).catch(() => null))) cache.set(key(record), { path: record.path, identity: current, status: 'changed' });
      return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : error.code === 'COPY_CHANGED' ? 'changed' : 'unavailable';
    }
  }
  async function offlineStatus(record) {
    try {
      const current=await inspect(record.path),cached=cache.get(key(record));
      if(current.size!==record.size)return 'changed';
      if(cached&&cached.path===record.path&&same(current,cached.identity))return cached.status;
      // Listing up to 2000 saved originals must not eagerly read terabytes.
      // This label is deliberately not a fresh integrity claim; opening hashes.
      return 'unverified';
    }catch(error){return ['ENOENT','ENOTDIR'].includes(error.code)?'missing':error.code==='COPY_CHANGED'?'changed':'unavailable';}
  }
  return {
    record(state, file, destination) {
      return exclusive(async () => {
        available();
        if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.length > 32760 || /[\x00-\x1f]/.test(destination)) throw new Error('本机副本保存路径无效。');
        const record = { ...context(state), ...metadata(file), path: path.resolve(destination), savedAt: now(), name: String(file.name || path.basename(destination)).slice(0,255) };
        if (!state.files?.some(item => item.id === file.id && item.sha256 === file.sha256 && item.size === file.size)) throw new Error('该文件不属于当前授权文件池。');
        const verified = await checked(record);
        const candidates = [...records.filter(item => !(item.serverId === record.serverId && item.deviceId === record.deviceId && item.fileId === record.fileId)), record].slice(-MAX_RECORDS), next = [];
        let bytes = Buffer.byteLength('{"version":1,"records":[]}');
        for (let i = candidates.length - 1; i >= 0; i--) {
          const length = Buffer.byteLength(JSON.stringify(candidates[i])) + (next.length ? 1 : 0);
          if (bytes + length > MAX_BYTES) break;
          bytes += length; next.push(candidates[i]);
        }
        next.reverse();
        await persist(next);
        const retained = new Set(next.map(key)); for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id);
        cache.set(key(record), { path: record.path, identity: verified, status: 'saved' });
      });
    },
    async list(state, ids) {
      available(); context(state);
      if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('一次最多查询 200 个有效文件。');
      const files = [];
      for (const id of new Set(ids)) {
        const record = find(state, id); if (!record) continue;
        files.push({ fileId: id, sha256: record.sha256, status: await status(record), savedAt: record.savedAt });
      }
      return { files };
    },
    async listOffline({ query = '', offset = 0, limit = 100 } = {}) {
      available(); if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('本机文件查询无效。');
      const all = records.slice(-2000).reverse().filter(record => !query || (record.name || path.basename(record.path)).toLocaleLowerCase().includes(query.toLocaleLowerCase()) || record.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      const files = [];
      for (const record of all.slice(offset, offset + limit)) files.push({ receiptId: crypto.createHash('sha256').update(key(record)).digest('hex'), name: record.name || path.basename(record.path), path: record.path, size: record.size, savedAt: record.savedAt, sha256: record.sha256, status: await offlineStatus(record) });
      return { files, total: all.length, more: offset + files.length < all.length };
    },
    async resolveOffline(receiptId) {
      available(); if (!HASH.test(receiptId || '')) throw new Error('本机副本编号无效。');
      const record = records.slice(-2000).find(item => crypto.createHash('sha256').update(key(item)).digest('hex') === receiptId);
      if (!record) throw new Error('本机副本记录不存在。');
      if (await status(record, true) !== 'saved') throw new Error('本机副本已移动、变化或暂不可读，已阻止打开。');
      return record.path;
    },
    async resolve(state, id, sha256) {
      if (!UUID.test(id || '') || !HASH.test(sha256 || '')) throw new Error('本机副本请求无效。');
      const record = find(state, id, sha256);
      if (!record) throw new Error('当前文件没有可用的本机保存记录。');
      const value = await status(record, true);
      if (value !== 'saved') throw new Error(value === 'missing' ? '本机副本已被移动或删除，请重新保存。' : value === 'changed' ? '本机副本已变化，已阻止打开；请重新保存原件。' : '无法读取本机副本，请检查磁盘和访问权限。');
      return record.path;
    }
  };
}
module.exports = { createSavedCopies, context };
