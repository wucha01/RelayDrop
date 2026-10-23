'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function createAppLock(directory, { now = Date.now } = {}) {
  const filename = path.join(directory, 'interface-lock.json'); let record = null, error = '', attempts = 0, retryAt = 0;
  try {
    const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('invalid lock');
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.salt || '') || !/^[a-f0-9]{128}$/.test(value.digest || '')) throw new Error('invalid lock');
    record = value;
  } catch (failure) { if (failure.code !== 'ENOENT') error = '界面锁配置损坏。已保持锁定，请保留数据并恢复 interface-lock.json。'; }
  function state() { return { configured: !!record || !!error, error, retryAfterMs: Math.max(0, retryAt - now()) }; }
  function valid(value) { return typeof value === 'string' && value.length >= 6 && value.length <= 256 && Buffer.byteLength(value, 'utf8') <= 1024; }
  function derive(password, salt) { return crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
  function verify(password) {
    if (error) throw new Error(error); if (!record) return true;
    if (retryAt > now()) throw new Error('尝试过于频繁，请稍后再试。');
    const accepted = typeof password === 'string' && password.length <= 256 && crypto.timingSafeEqual(derive(password, record.salt), Buffer.from(record.digest, 'hex'));
    if (!accepted) { attempts++; if (attempts >= 3) retryAt = now() + Math.min(30000, 1000 * 2 ** Math.min(attempts - 3, 5)); throw new Error('密码不正确。'); }
    attempts = 0; retryAt = 0; return true;
  }
  function configure(password, currentPassword) {
    if (error) throw new Error(error); if (record) verify(currentPassword);
    if (!valid(password)) throw new Error('请设置 6–256 个字符的密码。');
    const salt = crypto.randomBytes(16).toString('hex'), next = { version: 1, salt, digest: derive(password, salt).toString('hex') };
    const temporary = filename + '.' + crypto.randomUUID() + '.tmp'; let fd;
    try { fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, filename); record = next; }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
    return state();
  }
  function disable(password) { if (error) throw new Error(error); verify(password); if (record) fs.unlinkSync(filename); record = null; return state(); }
  return { state, verify, configure, disable };
}
module.exports = { createAppLock };
