'use strict';
// Native-only, stopped-store operations. Never expose filesystem paths through HTTP.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const encrypted = require('./encrypted-backup.cjs');
const MiB = 1024 * 1024, MAX_FILE = 20 * 1024 * MiB, MAX_MANIFEST = 16 * MiB;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
function fail(message, code = 'INVALID_BACKUP') { throw Object.assign(new Error(message), { code }); }
function cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('已取消，原文件池保持不变。'), { name: 'AbortError' }); }
function emit(options, phase, completed, total, bytes = 0) { cancelled(options.signal); options.onProgress?.({ phase, completed, total, bytes }); }
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const iso = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function name(value, maximum = 128) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value.length > maximum || value !== value.trim() || value !== value.normalize('NFC') || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) || /^[. ]+$/.test(value) || /[. ]$/.test(value) || WINDOWS_DEVICE.test(value)) fail('备份包含不安全的目录名称。');
  return value;
}
function originalName(value) { if (typeof value !== 'string' || !value.trim() || value.length > 255 || !value.isWellFormed() || /[\x00-\x1f\x7f/\\]/.test(value) || value === '.' || value === '..') fail('备份包含无效文件名。'); return value; }
function safeName(value) {
  let result = String(value || '文件').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').trim().replace(/[. ]+$/g, '') || '文件';
  if (WINDOWS_DEVICE.test(result) || result === '.' || result === '..') result = '_' + result;
  const ext = path.extname(result).slice(0, 24), stem = result.slice(0, result.length - path.extname(result).length).slice(0, 120 - ext.length).replace(/[\ud800-\udbff]$/, '');
  return (stem || '文件') + ext;
}
function inside(root, target, allowRoot = false) {
  const relative = path.relative(root, target);
  if ((!allowRoot && !relative) || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('路径超出选定目录。', 'UNSAFE_PATH');
  return target;
}
async function rootDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('请选择有效的绝对目录。', 'UNSAFE_PATH');
  const stat = await fsp.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('请选择普通文件夹，不支持链接目录。', 'UNSAFE_PATH');
  return fsp.realpath(value);
}
function payloadPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('files/') || value.includes('\\')) fail('备份文件路径无效。');
  const segments = value.split('/'); if (segments.length > 40) fail('备份文件路径层级过深。');
  segments.forEach(segment => name(segment, 255)); return segments;
}
async function checkedPath(root, relative, expectFile = true) {
  const segments = typeof relative === 'string' ? relative.split('/') : relative;
  let location = root;
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i] || ['.', '..'].includes(segments[i]) || /[\\/]/.test(segments[i])) fail('无效文件路径。', 'UNSAFE_PATH');
    location = inside(root, path.join(location, segments[i]));
    const stat = await fsp.lstat(location);
    if (stat.isSymbolicLink() || (i < segments.length - 1 ? !stat.isDirectory() : expectFile ? !stat.isFile() : !stat.isDirectory())) fail('备份中包含链接或不支持的文件类型。', 'UNSAFE_PATH');
  }
  return location;
}
function identity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':'); }
async function hashFile(location, signal) {
  cancelled(signal); const before = await fsp.lstat(location, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail('不支持链接或特殊文件。', 'UNSAFE_PATH');
  const handle = await fsp.open(location, 'r');
  try {
    if (identity(await handle.stat({ bigint: true })) !== identity(before)) fail('文件在打开时发生变化。', 'SOURCE_CHANGED');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024); let bytes = 0;
    for (;;) { cancelled(signal); const chunk = await handle.read(buffer, 0, buffer.length, null); if (!chunk.bytesRead) break; bytes += chunk.bytesRead; hash.update(buffer.subarray(0, chunk.bytesRead)); }
    if (identity(await handle.stat({ bigint: true })) !== identity(before) || identity(await fsp.lstat(location, { bigint: true })) !== identity(before)) fail('文件在校验期间发生变化。', 'SOURCE_CHANGED');
    return { bytes, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
async function copyChecked(source, destination, expected, options) {
  cancelled(options.signal); const before = await fsp.lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail('不支持链接或特殊文件。', 'UNSAFE_PATH');
  const sourceHandle = await fsp.open(source, 'r'); let destinationHandle;
  try {
    if (identity(await sourceHandle.stat({ bigint: true })) !== identity(before)) fail('原件发生变化。', 'SOURCE_CHANGED');
    destinationHandle = await fsp.open(destination, 'wx', 0o600);
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024); let bytes = 0;
    for (;;) {
      cancelled(options.signal); const result = await sourceHandle.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break;
      const chunk = buffer.subarray(0, result.bytesRead); hash.update(chunk); bytes += chunk.length;
      if (expected && bytes > expected.size) fail('原文件大小与校验清单不一致。', 'FILE_HASH_MISMATCH');
      let offset = 0; while (offset < chunk.length) { const written = await destinationHandle.write(chunk, offset, chunk.length - offset, null); if (!written.bytesWritten) fail('无法继续写入备份。', 'EIO'); offset += written.bytesWritten; }
    }
    await destinationHandle.sync(); await destinationHandle.close(); destinationHandle = null;
    const sha256 = hash.digest('hex');
    if (identity(await sourceHandle.stat({ bigint: true })) !== identity(before) || identity(await fsp.lstat(source, { bigint: true })) !== identity(before)) fail('原件在复制期间发生变化。', 'SOURCE_CHANGED');
    if (expected && (bytes !== expected.size || sha256 !== expected.sha256)) fail('原文件与记录不一致，操作未完成。', 'FILE_HASH_MISMATCH');
    const saved = await hashFile(destination, options.signal);
    if (saved.bytes !== bytes || saved.sha256 !== sha256) fail('保存后读回校验失败。', 'FILE_HASH_MISMATCH');
    return { bytes, sha256 };
  } finally { if (destinationHandle) await destinationHandle.close().catch(() => {}); await sourceHandle.close(); }
}
async function writeExclusive(location, bytes) {
  const handle = await fsp.open(location, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function removeOwned(parent, target) {
  inside(parent, target); const stat = await fsp.lstat(target).catch(() => null);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('临时目录类型发生变化，已保留现场。', 'UNSAFE_PATH');
  await fsp.rm(target, { recursive: true, force: true });
}
function folderMap(folders) {
  if (!Array.isArray(folders) || folders.length > 5000) fail('目录数量超出上限。');
  const map = new Map(), siblings = new Set();
  for (const folder of folders) {
    if (!folder || !UUID.test(folder.id || '') || map.has(folder.id) || !(folder.parentId === null || UUID.test(folder.parentId || ''))) fail('目录编号无效或重复。');
    name(folder.name); const key = (folder.parentId || '') + '/' + folder.name.toLowerCase(); if (siblings.has(key)) fail('目录中存在同名冲突。'); siblings.add(key); map.set(folder.id, folder);
  }
  for (const folder of folders) {
    const seen = new Set(), names = []; let current = folder;
    while (current) {
      if (seen.has(current.id) || seen.size >= 32) fail('目录存在循环或层级过深。'); seen.add(current.id); names.unshift(current.name);
      if (current.parentId === null) break; current = map.get(current.parentId); if (!current) fail('目录的父级不存在。');
    }
    if (names.join('/').length > 1024) fail('目录路径过长。');
  }
  return map;
}
function validateManifest(value) {
  if (!value || value.format !== 'relaydrop-pool-backup' || value.version !== 1 || !iso(value.createdAt) || !value.source || typeof value.source.name !== 'string' || value.source.name.length > 256) fail('无法识别的备份格式。');
  const folders = folderMap(value.folders);
  if (!Array.isArray(value.files) || value.files.length > 50000 || !Array.isArray(value.notes) || value.notes.length > 50000) fail('备份条目数量超出上限。');
  const ids = new Set(), paths = new Set(); let totalBytes = 0;
  for (const file of value.files) {
    if (!file || !UUID.test(file.id || '') || ids.has(file.id)) fail('文件编号无效或重复。'); ids.add(file.id);
    originalName(file.name); payloadPath(file.path); const key = file.path.toLowerCase(); if (paths.has(key)) fail('备份文件路径重复。'); paths.add(key);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE || !SHA.test(file.sha256 || '') || !iso(file.createdAt) || !Number.isSafeInteger(file.lastModified) || file.lastModified < 0 || typeof file.mime !== 'string' || file.mime.length > 200) fail('文件大小、日期或校验信息无效。');
    if (!['shared', 'private'].includes(file.visibility) || !(file.folderId === null || folders.has(file.folderId)) || file.visibility === 'private' && file.folderId !== null || !(file.deletedAt === null || iso(file.deletedAt))) fail('文件目录或可见范围无效。');
    totalBytes += file.size; if (!Number.isSafeInteger(totalBytes)) fail('备份总大小无效。');
  }
  for (const key of paths) { const parts = key.split('/'); while (parts.length > 1) { parts.pop(); if (paths.has(parts.join('/'))) fail('备份文件与目录路径冲突。'); } }
  for (const note of value.notes) {
    if (!note || !UUID.test(note.id || '') || ids.has(note.id) || typeof note.text !== 'string' || !note.text.trim() || note.text.includes('\0') || note.text.length > 20000 || !iso(note.createdAt) || !['shared', 'private'].includes(note.visibility)) fail('备份文字记录无效。'); ids.add(note.id);
  }
  return { manifest: value, folders, totalBytes };
}
async function loadState(dataDir) {
  const stateFile = await checkedPath(dataDir, 'state.json'), bytes = await fsp.readFile(stateFile);
  let state; try { state = JSON.parse(bytes); } catch { fail('当前文件池状态损坏，未修改原件。', 'INVALID_STATE'); }
  if (state.version !== 1 || typeof state.hostToken !== 'string' || !Array.isArray(state.devices) || !Array.isArray(state.files) || !Array.isArray(state.notes) || !Array.isArray(state.transfers)) fail('当前文件池格式无法识别。', 'INVALID_STATE');
  folderMap(state.folders || []); await checkedPath(dataDir, 'files', false);
  return { state, original: bytes };
}
async function withStore(dataDir, action) {
  const root = await rootDirectory(dataDir), acquire = require('./server.cjs').acquireDataLease;
  if (typeof acquire !== 'function') fail('文件池维护模块版本不匹配。', 'VERSION_MISMATCH');
  const lease = acquire(root); try { return await action(root, await loadState(root)); } finally { lease.release(); }
}
async function destinationDirectory(destination, source) {
  const root = await rootDirectory(destination);
  const relative = path.relative(source, root);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) fail('备份或迁移目标不能位于当前文件池内部。', 'UNSAFE_PATH');
  return root;
}
function folderParts(id, folders) { const result = []; while (id) { const folder = folders.get(id); if (!folder) fail('文件引用的目录不存在。'); result.unshift(folder.name); id = folder.parentId; } return result; }
function uniquePayload(relative, used) {
  const directory = path.posix.dirname(relative), base = path.posix.basename(relative), ext = path.posix.extname(base), stem = base.slice(0, base.length - ext.length); let value = relative, index = 2;
  while (used.has(value.toLowerCase())) value = directory + '/' + stem + ' (' + index++ + ')' + ext;
  used.add(value.toLowerCase()); return value;
}
async function exportBackup(options) {
  return withStore(options.dataDir, async (root, { state, original }) => {
    const parent = await destinationDirectory(options.destination, root), label = 'RelayDrop-Backup-' + stamp() + '-' + crypto.randomBytes(3).toString('hex'), output = inside(parent, path.join(parent, label)), stage = inside(parent, path.join(parent, '.' + label + '.partial'));
    const encryption = options.password !== undefined && options.password !== null ? await encrypted.create(options.password) : null;
    let published = false;
    try {
      await fsp.mkdir(stage, { mode: 0o700 });
      const folders = (state.folders || []).map(folder => ({ id: folder.id, parentId: folder.parentId ?? null, name: folder.name })), map = folderMap(folders), used = new Set();
      const manifest = { format: 'relaydrop-pool-backup', version: 1, createdAt: new Date().toISOString(), source: { name: String(state.devices.find(d => d.id === 'host')?.name || 'RelayDrop').slice(0, 256) }, folders, files: [], notes: [] };
      // Preserve empty directories in the readable export as well as the manifest.
      await fsp.mkdir(path.join(stage, 'files'), { recursive: true });
      for (const folder of encryption ? [] : folders) {
        const relative = ['files', '共享文件', ...folderParts(folder.id, map)].join('/'); used.add(relative.toLowerCase());
        await fsp.mkdir(inside(stage, path.join(stage, ...relative.split('/'))), { recursive: true });
      }
      let completed = 0, totalBytes = 0; emit(options, 'exporting', 0, state.files.length);
      for (const file of state.files) {
        cancelled(options.signal); if (!UUID.test(file.id || '') || !SHA.test(file.sha256 || '') || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE) fail('当前文件池有无效完整性记录。', 'INVALID_STATE');
        const visibility = file.targetId ? 'private' : 'shared', folderId = visibility === 'shared' ? file.folderId || null : null;
        const parts = file.deletedAt ? ['files', '回收站', file.id] : visibility === 'private' ? ['files', '定向文件', file.id] : ['files', '共享文件', ...folderParts(folderId, map)];
        const relative = uniquePayload([...parts, safeName(file.name)].join('/'), used); payloadPath(relative);
        const source = await checkedPath(root, ['files', file.id]), target = inside(stage, encryption ? path.join(stage, 'files', file.id + '.rdenc') : path.join(stage, ...relative.split('/'))); await fsp.mkdir(path.dirname(target), { recursive: true });
        if (encryption) await encrypted.encrypt(source, target, encryption, 'file:' + file.id, { size: file.size, sha256: file.sha256 }, options);
        else await copyChecked(source, target, { size: file.size, sha256: file.sha256 }, options);
        manifest.files.push({ id: file.id, path: relative, name: originalName(file.name), folderId, size: file.size, sha256: file.sha256, mime: typeof file.mime === 'string' ? file.mime : 'application/octet-stream', createdAt: file.createdAt, lastModified: Number.isSafeInteger(file.lastModified) && file.lastModified >= 0 ? file.lastModified : 0, visibility, deletedAt: file.deletedAt || null });
        totalBytes += file.size; emit(options, 'exporting', ++completed, state.files.length, totalBytes);
      }
      manifest.notes = state.notes.map(note => ({ id: note.id, text: note.text, createdAt: note.createdAt, visibility: note.targetId ? 'private' : 'shared' }));
      validateManifest(manifest); const encoded = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'); if (encoded.length > MAX_MANIFEST) fail('备份清单过大。');
      if (!(await fsp.readFile(path.join(root, 'state.json'))).equals(original)) fail('文件池状态在备份期间发生变化。', 'SOURCE_CHANGED');
      if (encryption) { await encrypted.encrypt(encoded, path.join(stage, 'manifest.rdenc'), encryption, 'manifest', null, options); await writeExclusive(path.join(stage, 'encrypted-backup.json'), encryption.bytes); }
      else { await writeExclusive(path.join(stage, 'manifest.json'), encoded); await writeExclusive(path.join(stage, 'manifest.sha256'), digest(encoded) + '\n'); }
      cancelled(options.signal);
      await fsp.rename(stage, output); published = true;
      return { path: output, files: manifest.files.length, folders: folders.length, notes: manifest.notes.length, bytes: totalBytes, manifestSha256: digest(encoded) };
    } finally { encryption?.destroy(); if (!published) await removeOwned(parent, stage); }
  });
}
async function readBackup(backupDir, options = {}) {
  const encryptedRoot = await rootDirectory(backupDir);
  if (await fsp.lstat(path.join(encryptedRoot, 'encrypted-backup.json')).catch(() => null)) {
    const headerPath = await checkedPath(encryptedRoot, 'encrypted-backup.json');
    if ((await fsp.stat(headerPath)).size > 4096) fail('加密备份头过大。');
    const header = await fsp.readFile(headerPath), context = await encrypted.open(header, options.password);
    let bytes;
    try { bytes = await encrypted.manifest(await checkedPath(encryptedRoot, 'manifest.rdenc'), context, options); let manifest; try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('加密清单不是有效 JSON。'); } return { root: encryptedRoot, ...validateManifest(manifest), manifestSha256: digest(bytes), encrypted: true, encryptionHeader: header }; }
    finally { context.destroy(); bytes?.fill(0); }
  }
  if (options.password !== undefined && options.password !== null) fail('已选择加密恢复，但此目录没有加密备份头；请核对备份，未导入任何文件。', 'BACKUP_ENCRYPTION_REQUIRED');
  const root = await rootDirectory(backupDir), manifestPath = await checkedPath(root, 'manifest.json'), checksumPath = await checkedPath(root, 'manifest.sha256');
  if ((await fsp.stat(manifestPath)).size > MAX_MANIFEST || (await fsp.stat(checksumPath)).size > 128) fail('备份清单大小超出上限。');
  const bytes = await fsp.readFile(manifestPath), checksum = (await fsp.readFile(checksumPath, 'utf8')).trim();
  if (!SHA.test(checksum) || digest(bytes) !== checksum) fail('备份清单校验失败，未恢复任何文件。', 'FILE_HASH_MISMATCH');
  let manifest; try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('备份清单不是有效 UTF-8 JSON。'); }
  const result = validateManifest(manifest); return { root, ...result, manifestSha256: checksum };
}
function planRestoreFolders(existing, incoming) {
  const now = new Date().toISOString(), mappedFolders = new Map();
  let rootFolderId = crypto.randomUUID(), additions = [{ id: rootFolderId, parentId: null, name: '恢复的文件池-' + stamp() + '-' + crypto.randomBytes(3).toString('hex'), createdAt: now, createdBy: 'host' }];
  for (const folder of incoming) mappedFolders.set(folder.id, crypto.randomUUID());
  for (const folder of incoming) additions.push({ id: mappedFolders.get(folder.id), parentId: folder.parentId ? mappedFolders.get(folder.parentId) : rootFolderId, name: folder.name, createdAt: now, createdBy: 'host' });
  try { folderMap([...existing, ...additions]); return { mappedFolders, rootFolderId, additions, mergedPaths: false }; } catch (error) { if (error.code !== 'INVALID_BACKUP') throw error; }
  // A valid maximum-depth/path tree cannot fit below an extra wrapper. Merge
  // folder metadata by original path instead; every payload still gets a new ID.
  rootFolderId = null; additions = []; mappedFolders.clear();
  const sourceMap = folderMap(incoming), bySibling = new Map(existing.map(f => [(f.parentId || '') + '/' + f.name.toLowerCase(), f]));
  function mapFolder(folder) {
    if (mappedFolders.has(folder.id)) return mappedFolders.get(folder.id);
    const parentId = folder.parentId ? mapFolder(sourceMap.get(folder.parentId)) : null, key = (parentId || '') + '/' + folder.name.toLowerCase();
    let target = bySibling.get(key);
    if (!target) { target = { id: crypto.randomUUID(), parentId, name: folder.name, createdAt: now, createdBy: 'host' }; bySibling.set(key, target); additions.push(target); }
    mappedFolders.set(folder.id, target.id); return target.id;
  }
  for (const folder of incoming) mapFolder(folder);
  folderMap([...existing, ...additions]);
  return { mappedFolders, rootFolderId, additions, mergedPaths: true };
}
async function restoreBackup(options) {
  const backup = await readBackup(options.backupDir, options);
  const context = backup.encrypted ? await encrypted.open(backup.encryptionHeader, options.password) : null;
  try { return await withStore(options.dataDir, async (root, { state, original }) => {
    const relativeBackup = path.relative(root, backup.root);
    if (!relativeBackup || relativeBackup !== '..' && !relativeBackup.startsWith('..' + path.sep) && !path.isAbsolute(relativeBackup)) fail('不能从当前文件池内部恢复备份。', 'UNSAFE_PATH');
    if (state.notes.length + backup.manifest.notes.length > 5000) fail('恢复后的文字记录超过 5000 条上限，请先导出整理。', 'NOTE_LIMIT');
    const stage = inside(root, path.join(root, '.restore-' + crypto.randomUUID())); await fsp.mkdir(stage, { mode: 0o700 });
    const published = []; let committed = false;
    try {
      const existing = state.folders || [], { mappedFolders, rootFolderId, additions, mergedPaths } = planRestoreFolders(existing, backup.manifest.folders);
      folderMap([...existing, ...additions]);
      const files = []; let totalBytes = 0; emit(options, 'verifying', 0, backup.manifest.files.length);
      for (const entry of backup.manifest.files) {
        const id = crypto.randomUUID(), source = await checkedPath(backup.root, context ? ['files', entry.id + '.rdenc'] : payloadPath(entry.path)), temporary = path.join(stage, id);
        if (context) await encrypted.decrypt(source, context, 'file:' + entry.id, { size: entry.size, sha256: entry.sha256 }, options);
        else await copyChecked(source, temporary, { size: entry.size, sha256: entry.sha256 }, options);
        files.push({ id, name: entry.name, size: entry.size, sha256: entry.sha256, mime: entry.mime, lastModified: entry.lastModified, createdAt: entry.createdAt, senderId: 'host', senderName: state.devices.find(d => d.id === 'host')?.name || '这台电脑', targetId: entry.visibility === 'private' ? 'host' : null, folderId: entry.visibility === 'private' ? null : entry.folderId ? mappedFolders.get(entry.folderId) : rootFolderId, ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {}) });
        totalBytes += entry.size; emit(options, 'verifying', files.length, backup.manifest.files.length, totalBytes);
      }
      const notes = backup.manifest.notes.map(entry => ({ id: crypto.randomUUID(), text: entry.text, createdAt: entry.createdAt, senderId: 'host', senderName: state.devices.find(d => d.id === 'host')?.name || '这台电脑', targetId: entry.visibility === 'private' ? 'host' : null }));
      if (!(await fsp.readFile(path.join(root, 'state.json'))).equals(original)) fail('文件池状态在恢复期间发生变化。', 'SOURCE_CHANGED');
      cancelled(options.signal);
      for (const file of files) {
        const target = inside(root, path.join(root, 'files', file.id));
        if (context) {
          const entry = backup.manifest.files[files.indexOf(file)], source = await checkedPath(backup.root, ['files', entry.id + '.rdenc']);
          const output = await fsp.open(target, 'wx', 0o600); published.push(target);
          try { await encrypted.decrypt(source, context, 'file:' + entry.id, { size: entry.size, sha256: entry.sha256 }, options, bytes => encrypted.write(output, bytes)); await output.sync(); } finally { await output.close(); }
        } else { await fsp.copyFile(path.join(stage, file.id), target, fs.constants.COPYFILE_EXCL); published.push(target); }
        const handle = await fsp.open(target, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        const verified = await hashFile(target, options.signal); if (verified.bytes !== file.size || verified.sha256 !== file.sha256) fail('恢复文件落盘校验失败。', 'FILE_HASH_MISMATCH');
        emit(options, 'publishing', published.length, files.length, totalBytes);
      }
      const next = { ...state, folders: [...existing, ...additions], files: [...state.files, ...files], notes: [...state.notes, ...notes] };
      const stateTemporary = path.join(stage, 'state.json'); await writeExclusive(stateTemporary, JSON.stringify(next)); cancelled(options.signal);
      if (!(await fsp.readFile(path.join(root, 'state.json'))).equals(original)) fail('文件池状态在恢复期间发生变化。', 'SOURCE_CHANGED');
      await fsp.rename(stateTemporary, path.join(root, 'state.json')); committed = true;
      return { files: files.length, folders: additions.length, notes: notes.length, rootFolderId, mergedPaths, bytes: totalBytes };
    } finally {
      if (!committed) for (const file of published) { inside(root, file); await fsp.unlink(file).catch(() => {}); }
      if (committed) await removeOwned(root, stage).catch(() => {}); else await removeOwned(root, stage);
    }
  }); } finally { context?.destroy(); }
}
async function walkFiles(root, relative = '') {
  const result = [];
  for (const name of (await fsp.readdir(path.join(root, relative))).sort()) {
    if (!relative && (name.startsWith('.relaydrop.lock') || name === 'launch.json' || name.startsWith('.restore-'))) continue;
    const child = relative ? relative + '/' + name : name, location = inside(root, path.join(root, ...child.split('/'))), stat = await fsp.lstat(location);
    if (stat.isSymbolicLink()) fail('文件池包含链接，无法安全迁移。', 'UNSAFE_PATH');
    if (stat.isDirectory()) result.push(...await walkFiles(root, child)); else if (stat.isFile()) result.push(child); else fail('文件池包含特殊文件。', 'UNSAFE_PATH');
  }
  return result;
}
async function migrateData(options) {
  return withStore(options.dataDir, async (root, { state }) => {
    const parent = await destinationDirectory(options.destination, root), label = 'RelayDropData-' + stamp() + '-' + crypto.randomBytes(3).toString('hex'), output = inside(parent, path.join(parent, label)), stage = inside(parent, path.join(parent, '.' + label + '.partial'));
    await fsp.mkdir(stage, { mode: 0o700 }); let published = false;
    try {
      const sources = await walkFiles(root), expected = new Map();
      for (const file of state.files) { if (!UUID.test(file.id || '') || !SHA.test(file.sha256 || '') || !Number.isSafeInteger(file.size) || file.size < 0) fail('文件池完整性记录无效。'); expected.set('files/' + file.id, { size: file.size, sha256: file.sha256 }); }
      for (const relative of expected.keys()) if (!sources.includes(relative)) fail('文件池原件缺失，未迁移。', 'FILE_HASH_MISMATCH');
      const records = new Map(); let completed = 0, bytes = 0; emit(options, 'migrating', 0, sources.length);
      for (const relative of sources) {
        const source = await checkedPath(root, relative), target = inside(stage, path.join(stage, ...relative.split('/'))); await fsp.mkdir(path.dirname(target), { recursive: true });
        const copied = await copyChecked(source, target, expected.get(relative), options); records.set(relative, copied); bytes += copied.bytes; emit(options, 'migrating', ++completed, sources.length, bytes);
      }
      if (JSON.stringify(await walkFiles(root)) !== JSON.stringify(sources)) fail('文件池内容在迁移时发生变化。', 'SOURCE_CHANGED');
      for (const relative of sources) { const current = await hashFile(await checkedPath(root, relative), options.signal), previous = records.get(relative); if (current.sha256 !== previous.sha256 || current.bytes !== previous.bytes) fail('迁移期间原数据发生变化。', 'SOURCE_CHANGED'); }
      await fsp.mkdir(path.join(stage, 'files'), { recursive: true }); await fsp.mkdir(path.join(stage, 'partials'), { recursive: true });
      cancelled(options.signal); await fsp.rename(stage, output); published = true;
      return { dataDir: output, files: state.files.length, bytes };
    } finally { if (!published) await removeOwned(parent, stage); }
  });
}
module.exports = { exportBackup, restoreBackup, migrateData, readBackup, validateManifest, hashFile, safeName, MAX_MANIFEST };
