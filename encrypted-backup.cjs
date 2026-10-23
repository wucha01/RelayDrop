'use strict';
// Portable backup v2. Bounded, independently authenticated AES-GCM records.
const fs = require('node:fs/promises'), crypto = require('node:crypto');
const { promisify } = require('node:util');
const pbkdf2 = promisify(crypto.pbkdf2), CHUNK = 1048576, ITERATIONS = 600000, MAGIC = Buffer.from('RDBK2GCM');
const MAX_FILE = 20 * 1024 * 1024 * 1024, MAX_MANIFEST = 16 * 1024 * 1024;
function fail(message = '密码错误或加密备份已损坏，未恢复任何文件。', code = 'BACKUP_AUTH_FAILED') { throw Object.assign(new Error(message), { code }); }
function cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('已取消，原文件池保持不变。'), { name: 'AbortError' }); }
function passwordBytes(value) {
  if (value === undefined || value === null || value === '') fail('请输入加密备份密码。', 'PASSWORD_REQUIRED');
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 1024) fail('备份密码须为 8–1024 个 UTF-8 字节。', 'INVALID_PASSWORD');
  const bytes = Buffer.from(value, 'utf8'); if (bytes.length < 8 || bytes.length > 1024) { bytes.fill(0); fail('备份密码须为 8–1024 个 UTF-8 字节。', 'INVALID_PASSWORD'); } return bytes;
}
function validHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4096) fail('加密备份头无效。', 'INVALID_BACKUP');
  let header; try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('加密备份头无效。', 'INVALID_BACKUP'); }
  const fields = ['format', 'version', 'kdf', 'iterations', 'salt', 'chunkSize'];
  if (!header || Object.keys(header).length !== fields.length || fields.some(k => !Object.hasOwn(header, k)) || header.format !== 'relaydrop-encrypted-backup' || header.version !== 2 || header.kdf !== 'PBKDF2-HMAC-SHA256' || header.iterations !== ITERATIONS || header.chunkSize !== CHUNK || typeof header.salt !== 'string') fail('不支持的加密备份参数。', 'INVALID_BACKUP');
  const salt = Buffer.from(header.salt, 'base64'); if (salt.length !== 32 || salt.toString('base64') !== header.salt) fail('加密备份盐值无效。', 'INVALID_BACKUP');
  return { header, salt };
}
async function open(bytes, password) {
  const { header, salt } = validHeader(bytes), secret = passwordBytes(password);
  try { const key = await pbkdf2(secret, salt, ITERATIONS, 32, 'sha256'); return { header, bytes, key, headerHash: crypto.createHash('sha256').update(bytes).digest('hex'), destroy() { key.fill(0); } }; }
  finally { secret.fill(0); salt.fill(0); }
}
async function create(password) {
  const bytes = Buffer.from(JSON.stringify({ format: 'relaydrop-encrypted-backup', version: 2, kdf: 'PBKDF2-HMAC-SHA256', iterations: ITERATIONS, salt: crypto.randomBytes(32).toString('base64'), chunkSize: CHUNK }) + '\n');
  return open(bytes, password);
}
function aad(context, entry, sequence, length) {
  if (entry !== 'manifest' && !/^file:[a-f0-9-]{36}$/i.test(entry)) fail('加密条目标识无效。', 'INVALID_BACKUP');
  return Buffer.from(`RelayDrop-Backup-v2\n${context.headerHash}\n${entry}\n${sequence}\n${length}\n`, 'utf8');
}
async function write(handle, bytes) { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) fail('磁盘写入失败。', 'EIO'); offset += result.bytesWritten; } }
async function exact(handle, length) { const bytes = Buffer.alloc(length); let offset = 0; while (offset < length) { const result = await handle.read(bytes, offset, length - offset); if (!result.bytesRead) fail(); offset += result.bytesRead; } return bytes; }
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
async function checkedOpen(location, maximum) {
  const before = await fs.lstat(location, { bigint: true }); if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum)) fail('加密备份文件类型或大小无效。', 'INVALID_BACKUP');
  const handle = await fs.open(location, 'r'); if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) { await handle.close(); fail(); } return { handle, before };
}
async function unchanged(handle, before, location) { if (stamp(await handle.stat({ bigint: true })) !== stamp(before) || stamp(await fs.lstat(location, { bigint: true })) !== stamp(before)) fail('备份文件在操作期间发生变化。', 'SOURCE_CHANGED'); }
async function encrypt(source, destination, context, entry, expected, options = {}) {
  const inMemory = Buffer.isBuffer(source); let input, before, output, completed = false;
  const hash = crypto.createHash('sha256'); let total = 0, sequence = 0;
  try {
    if (!inMemory) { const opened = await checkedOpen(source, MAX_FILE); input = opened.handle; before = opened.before; }
    output = await fs.open(destination, 'wx', 0o600); await write(output, MAGIC);
    async function record(bytes) {
      cancelled(options.signal); const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', context.key, nonce, { authTagLength: 16 }); cipher.setAAD(aad(context, entry, sequence++, bytes.length));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); await write(output, Buffer.concat([length, nonce, ciphertext, cipher.getAuthTag()]));
    }
    if (inMemory) { for (let offset = 0; offset < source.length; offset += CHUNK) { const bytes = source.subarray(offset, offset + CHUNK); hash.update(bytes); total += bytes.length; await record(bytes); } }
    else { const buffer = Buffer.alloc(CHUNK); for (;;) { cancelled(options.signal); const result = await input.read(buffer); if (!result.bytesRead) break; const bytes = buffer.subarray(0, result.bytesRead); hash.update(bytes); total += bytes.length; if (expected && total > expected.size) fail('原文件与校验记录不一致。', 'FILE_HASH_MISMATCH'); await record(bytes); } await unchanged(input, before, source); }
    const sha256 = hash.digest('hex'); if (expected && (total !== expected.size || sha256 !== expected.sha256)) fail('原文件与校验记录不一致。', 'FILE_HASH_MISMATCH');
    await record(Buffer.alloc(0)); await output.sync(); await output.close(); output = null;
    // Read back authenticated ciphertext before publishing the backup directory.
    await decrypt(destination, context, entry, { size: total, sha256 }, options); completed = true; return { bytes: total, sha256 };
  } finally { if (output) await output.close().catch(() => {}); if (input) await input.close(); if (!completed) await fs.unlink(destination).catch(() => {}); }
}
async function decrypt(source, context, entry, expected, options = {}, sink) {
  const maximum = entry === 'manifest' ? MAX_MANIFEST : MAX_FILE;
  const { handle, before } = await checkedOpen(source, maximum + Math.ceil(maximum / CHUNK) * 32 + 40);
  const hash = crypto.createHash('sha256'); let total = 0, sequence = 0;
  try {
    if (!(await exact(handle, 8)).equals(MAGIC)) fail();
    for (;;) {
      cancelled(options.signal); const length = (await exact(handle, 4)).readUInt32BE(); if (length > CHUNK || total + length > maximum || expected && total + length > expected.size) fail();
      const nonce = await exact(handle, 12), ciphertext = await exact(handle, length), tag = await exact(handle, 16); let bytes;
      try { const decipher = crypto.createDecipheriv('aes-256-gcm', context.key, nonce, { authTagLength: 16 }); decipher.setAAD(aad(context, entry, sequence++, length)); decipher.setAuthTag(tag); bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]); } catch { fail(); }
      if (length === 0) { const trailing = Buffer.alloc(1); if ((await handle.read(trailing)).bytesRead) fail(); break; }
      total += length; hash.update(bytes); try { if (sink) await sink(bytes); } finally { bytes.fill(0); }
    }
    const sha256 = hash.digest('hex'); if (expected && (total !== expected.size || sha256 !== expected.sha256)) fail(); await unchanged(handle, before, source); return { bytes: total, sha256 };
  } finally { await handle.close(); }
}
async function manifest(source, context, options = {}) { const chunks = []; try { await decrypt(source, context, 'manifest', null, options, bytes => { chunks.push(Buffer.from(bytes)); }); return Buffer.concat(chunks); } finally { for (const bytes of chunks) bytes.fill(0); } }
module.exports = { create, open, encrypt, decrypt, manifest, validHeader, write, CHUNK, ITERATIONS, MAX_FILE, MAX_MANIFEST };