'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const defaults = { version: 2, closeToTray: true, trayHintShown: false, saveMode: 'ask', receiveDirectory: null, lastSaveDirectory: null };
function validated(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('桌面设置无效。');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (['closeToTray', 'trayHintShown'].includes(key) && typeof value === 'boolean') result[key] = value;
    else if (key === 'saveMode' && ['ask', 'fixed'].includes(value)) result[key] = value;
    else if (['receiveDirectory', 'lastSaveDirectory'].includes(key) && (value === null || typeof value === 'string' && path.isAbsolute(value) && value.length <= 32760 && !/[\x00-\x1f]/.test(value))) result[key] = value;
    else throw new Error('桌面设置无效。');
  }
  return result;
}
function createSettings(directory) {
  const filename = path.join(directory, 'desktop-settings.json');
  let value = { ...defaults };
  try {
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    for (const key of Object.keys(defaults).filter(key => key !== 'version')) {
      if (Object.hasOwn(parsed, key)) {
        try { Object.assign(value, validated({ [key]: parsed[key] })); } catch { /* Ignore unsupported or damaged persisted fields. */ }
      }
    }
    if (!value.receiveDirectory) value.saveMode = 'ask';
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return {
    get: () => ({ ...value }),
    update(patch) {
      const next = { ...value, ...validated(patch), version: 2 };
      if (next.saveMode === 'fixed' && !next.receiveDirectory) throw new Error('请先选择固定接收文件夹。');
      const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
      let fd;
      try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(next, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, filename); value = next;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch { }
      }
      return { ...value };
    }
  };
}
module.exports = { createSettings };
