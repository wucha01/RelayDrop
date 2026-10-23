'use strict';
const crypto = require('node:crypto');
const MAX_FOLDERS = 5000, MAX_DEPTH = 32, MAX_PATH = 1024;
class FolderError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new FolderError(status, code, message); };
function name(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) fail(400, 'INVALID_FOLDER_NAME', '目录名称无效。');
  const result = value.normalize('NFC');
  if (!result || result.length > 128 || result.trim() !== result || /[\x00-\x1f\x7f/\\:*?"<>|]/.test(result) || /[. ]$/.test(result) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(result)) fail(400, 'INVALID_FOLDER_NAME', '目录名称需为 1–128 个字符，不能包含特殊路径字符、设备名或首尾空格。');
  return result;
}
function find(folders, id) {
  if (id === null || id === undefined) return null;
  if (typeof id !== 'string') fail(400, 'INVALID_FOLDER', '共享目录无效。');
  const result = folders.find(folder => folder.id === id);
  if (!result) fail(404, 'FOLDER_NOT_FOUND', '共享目录不存在，请刷新后重试。');
  return result;
}
function trail(folders, id, index) {
  const result = [], visited = new Set();
  while (id !== null && id !== undefined) {
    if (visited.has(id)) fail(400, 'FOLDER_CYCLE', '共享目录不能移动到自身或自己的子目录。');
    visited.add(id); const folder = index ? index.get(id) : find(folders, id);
    if (!folder) fail(404, 'FOLDER_NOT_FOUND', '共享目录不存在，请刷新后重试。');
    result.unshift(folder); id = folder.parentId;
    if (result.length > MAX_DEPTH) fail(400, 'FOLDER_DEPTH_LIMIT', '共享目录最多支持 32 层。');
  }
  if (result.map(folder => folder.name).join('/').length > MAX_PATH) fail(400, 'FOLDER_PATH_LIMIT', '共享目录完整路径不能超过 1024 个字符。');
  return result;
}
function owner(folder, device) { if (device.id !== 'host' && folder.createdBy !== device.id) fail(403, 'FOLDER_OWNER_ONLY', '只有目录创建者和文件池管理员可以更改此目录。'); }
function ensure(folders, parentId, parts, device) {
  parentId = parentId ?? null; find(folders, parentId);
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_DEPTH) fail(400, 'INVALID_FOLDER_PATH', '请选择 1–32 层目录。');
  const names = parts.map(name), draft = folders.slice(), resolved = [];
  for (const segment of names) {
    let folder = draft.find(item => (item.parentId || null) === parentId && item.name.toLowerCase() === segment.toLowerCase());
    if (!folder) {
      if (draft.length >= MAX_FOLDERS) fail(409, 'FOLDER_LIMIT', '共享目录已达到 5000 个，请先整理。');
      folder = { id: crypto.randomUUID(), parentId, name: segment, createdAt: new Date().toISOString(), createdBy: device.id }; draft.push(folder);
    }
    trail(draft, folder.id); resolved.push(folder); parentId = folder.id;
  }
  folders.splice(0, folders.length, ...draft); return { folderId: parentId, folders: resolved };
}
function update(folders, id, input, device) {
  const folder = find(folders, id); owner(folder, device);
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !['name', 'parentId'].includes(key))) fail(400, 'INVALID_FOLDER_UPDATE', '目录更改设置无效。');
  const next = { ...folder, ...('name' in input ? { name: name(input.name) } : {}), ...('parentId' in input ? { parentId: input.parentId } : {}) };
  if (next.parentId === undefined) next.parentId = null;
  find(folders, next.parentId);
  if (folders.some(item => item.id !== id && (item.parentId || null) === (next.parentId || null) && item.name.toLowerCase() === next.name.toLowerCase())) fail(409, 'FOLDER_NAME_CONFLICT', '同一目录下已存在此名称。');
  const draft = folders.map(item => item.id === id ? next : item), index = new Map(draft.map(item => [item.id, item]));
  for (const item of draft) trail(draft, item.id, index);
  Object.assign(folder, next); return folder;
}
function remove(state, id, device) {
  const folder = find(state.folders, id); owner(folder, device);
  if (state.folders.some(item => item.parentId === id) || state.files.some(item => item.folderId === id) || state.transfers.some(item => item.status !== 'complete' && item.folderId === id)) fail(409, 'FOLDER_NOT_EMPTY', '目录仍包含文件、子目录、回收站文件或未完成传输。');
  state.folders = state.folders.filter(item => item.id !== id); return { ok: true };
}
module.exports = { FolderError, name, find, trail, ensure, update, remove, MAX_FOLDERS, MAX_DEPTH, MAX_PATH };
