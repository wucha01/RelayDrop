'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function abortCheck(signal) { if (signal?.aborted) throw Object.assign(new Error('已取消发送'), { name: 'AbortError' }); }
function identity(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function sameIdentity(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function parseSendArguments(argv) {
  const marker = argv.indexOf('--send');
  if (marker < 0) return [];
  const values = argv.slice(marker + 1);
  if (!values.length || values.length > 200) throw new Error('一次可从资源管理器发送 1–200 个文件。');
  for (const value of values) {
    // Only drive-qualified OS file arguments. No URLs, UNC/device paths, ADS,
    // switches, shell expansion or renderer-supplied paths are accepted.
    if (typeof value !== 'string' || !/^[a-z]:[\\/]/i.test(value) || value.length > 32760 || /[\x00-\x1f\x7f"*?<>|]/.test(value) || value.slice(2).includes(':')
      || value.split(/[\\/]/).some(part => /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error('仅支持本机普通文件，不能发送链接、网络路径或特殊设备路径。');
  }
  return [...new Set(values.map(value => path.resolve(value)))];
}
async function inspectFiles(files, forbiddenRoots = [], maxFileSize = 20 * 1024 ** 3) {
  const roots = await Promise.all(forbiddenRoots.map(async root => (await fs.realpath(root).catch(() => path.resolve(root))).toLowerCase()));
  const accepted = [];
  for (const source of files) {
    const resolved = await fs.realpath(source), lowered = resolved.toLowerCase(), stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || roots.some(root => lowered === root || lowered.startsWith(root + path.sep))) throw new Error('不能发送文件夹、符号链接或 RelayDrop 内部数据文件。');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxFileSize) throw new Error('文件超过中转站的单文件大小限制。');
    const name = path.basename(resolved);
    if (!name || name.length > 255 || !name.isWellFormed() || /[\x00-\x1f\x7f/\\]/.test(name)) throw new Error('文件名无效。');
    accepted.push({ path: resolved, name, size: stat.size, identity: identity(stat) });
  }
  return accepted;
}
async function inspectDirectory(directory, forbiddenRoots = [], maxFileSize = 20 * 1024 ** 3) {
  const selected=await fs.lstat(directory);if(selected.isSymbolicLink()||!selected.isDirectory())throw new Error('请选择本机普通目录，不能选择符号链接或目录联接。');
  const root = await fs.realpath(directory), files = [], directories = [], roots = await Promise.all(forbiddenRoots.map(async value => (await fs.realpath(value).catch(() => path.resolve(value))).toLowerCase()));
  if (roots.some(value => root.toLowerCase() === value || root.toLowerCase().startsWith(value + path.sep))) throw new Error('不能发送 RelayDrop 内部数据目录。');
  let nodes = 0;
  async function visit(current, parts) {
    const stat = await fs.lstat(current), real = await fs.realpath(current);
    if (stat.isSymbolicLink() || real.toLowerCase() !== path.resolve(current).toLowerCase() || !stat.isDirectory()) throw new Error('目录包含符号链接、联接或特殊路径，请移除后再试。');
    if (++nodes > 2000 || parts.length > 32 || parts.join('/').length > 1024) throw new Error('目录最多支持 2000 个节点、32 层、1024 字符路径。');
    const folderName = require('../shared-folders.cjs').name;
    for (const part of parts) folderName(part);
    directories.push(parts);
    for (const child of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current,child.name);
      if (child.isSymbolicLink()) throw new Error('目录含符号链接，不会读取链接目标。');
      if (child.isDirectory()) await visit(candidate,[...parts,child.name]);
      else if (child.isFile()) {
        if (++nodes > 2000 || files.length >= 300) throw new Error('一次最多发送 300 个文件、2000 个节点。');
        const [file] = await inspectFiles([candidate],forbiddenRoots,maxFileSize);files.push({...file,relativeDirectories:parts});
      } else throw new Error('目录包含不支持的特殊文件。');
    }
  }
  await visit(root,[path.basename(root)]);return {files,directories};
}
async function uploadLocalFile(file, { origin, token, signal, onProgress = () => {}, onDuplicate }) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('本地上传地址无效。');
  let handle, transferId, complete = false, lastProgress = 0;
  const progress = (status, transferred, force = false) => { if (force || Date.now() - lastProgress >= 100) { lastProgress = Date.now(); onProgress({ status, transferred, size: file.size, name: file.name }); } };
  async function request(route, { method = 'GET', json, body, headers = {}, detached = false } = {}) {
    const response = await fetch(origin + route, { method, redirect: 'error', signal: detached ? AbortSignal.timeout(10000) : signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
      headers: { Authorization: 'Bearer ' + token, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: json === undefined ? body : JSON.stringify(json) });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || '本地中转站没有接收文件。');
    return data;
  }
  try {
    abortCheck(signal);
    const pathStat = await fs.lstat(file.path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || !sameIdentity(file.identity, identity(pathStat))) throw new Error('文件在确认前已发生变化，请重新选择。');
    handle = await fs.open(file.path, 'r');
    if (!sameIdentity(file.identity, identity(await handle.stat()))) throw new Error('文件已被替换，请重新选择。');
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0; progress('hashing', 0, true);
    while (offset < file.size) {
      abortCheck(signal);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset);
      if (!bytesRead) throw new Error('源文件提前结束，未开始发送。');
      digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead; progress('hashing', offset);
    }
    const sha256 = digest.digest('hex');
    if (!sameIdentity(file.identity, identity(await handle.stat()))) throw new Error('校验期间源文件已变化，请重新选择。');
    const folderId = file.folderId || null;
    if (onDuplicate) {
      const existing = await request('/api/files/duplicates', { method:'POST', json:{sha256,size:file.size,targetId:null,folderId} });
      if (existing.matches?.length) {
        const choice = await onDuplicate(file,existing.matches);abortCheck(signal);
        if(choice==='skip')return {skipped:true,id:existing.matches[0].id,size:file.size,sha256};
        if(choice!=='upload')throw Object.assign(new Error('已取消发送'),{name:'AbortError'});
      }
    }
    const transfer = await request('/api/transfers', { method: 'POST', json: { name: file.name, size: file.size, fingerprint: sha256, lastModified: file.identity.mtimeMs, targetId: null, folderId } });
    if (!UUID.test(transfer.id || '') || !Number.isSafeInteger(transfer.offset) || transfer.offset < 0 || transfer.offset > file.size || !Number.isSafeInteger(transfer.chunkSize) || transfer.chunkSize < 1 || transfer.chunkSize > buffer.length) throw new Error('中转站返回了无效的传输记录。');
    transferId = transfer.id; offset = transfer.offset; progress('uploading', offset, true);
    while (offset < file.size) {
      abortCheck(signal); const count = Math.min(transfer.chunkSize, file.size - offset);
      let filled = 0;
      while (filled < count) { const { bytesRead } = await handle.read(buffer, filled, count - filled, offset + filled); if (!bytesRead) throw new Error('源文件读取不完整。'); filled += bytesRead; }
      const bytes = buffer.subarray(0, count);
      const next = await request('/api/transfers/' + transferId, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Offset': String(offset), 'X-Chunk-SHA256': crypto.createHash('sha256').update(bytes).digest('hex') } });
      if (next.offset !== offset + count) throw new Error('中转站返回了无效的传输进度。');
      offset = next.offset; progress('uploading', offset);
    }
    abortCheck(signal);
    if (!sameIdentity(file.identity, identity(await handle.stat()))) throw new Error('发送期间源文件已变化，未确认上传成功。');
    progress('verifying', file.size, true);
    const result = await request('/api/transfers/' + transferId + '/complete', { method: 'POST', json: {} });
    if (result.id !== transferId || result.size !== file.size || result.sha256?.toLowerCase() !== sha256) throw new Error('中转站返回的完整性结果不一致，未确认上传成功。');
    complete = true; return { id: transferId, size: file.size, sha256 };
  } finally {
    await handle?.close().catch(() => {});
    if (signal?.aborted && transferId && !complete) await request('/api/transfers/' + transferId, { method: 'DELETE', detached: true }).catch(() => {});
  }
}
module.exports = { parseSendArguments, inspectFiles, inspectDirectory, uploadLocalFile };
