'use strict';
const crypto = require('node:crypto'), net = require('node:net');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/, FINGERPRINT = /^[a-f0-9]{64}$/;
const PREFIX = 'relaydrop-remote://v1/', MAX_HEADER = 8192;
function fail(message, code = 'INVALID_CONFIG') { const e = new Error(message); e.code = code; return e; }
function normalizeRelay(raw) {
  if (typeof raw !== 'string' || raw.length > 512 || /[\s\\\x00-\x1f\x7f]/.test(raw)) throw fail('请输入有效的 tls:// 中继地址。');
  let u; try { u = new URL(raw); } catch { throw fail('请输入有效的 tls:// 中继地址。'); }
  if (u.protocol !== 'tls:' || u.username || u.password || u.pathname || u.search || u.hash || !u.hostname) throw fail('中继地址仅包含 tls://主机:端口。');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(host) && (host.length > 253 || !host.split('.').every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(x)))) throw fail('中继主机名无效。');
  const port = u.port ? Number(u.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('中继端口无效。');
  return 'tls://' + (net.isIP(host) === 6 ? '[' + host.toLowerCase() + ']' : host.toLowerCase()) + ':' + port;
}
function endpoint(relay) { const u = new URL(normalizeRelay(relay)); return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) }; }
function fingerprint(value) { if (value == null || value === '') return null; if (typeof value !== 'string' || !FINGERPRINT.test(value)) throw fail('中继证书指纹必须是完整的 64 位 SHA-256。'); return value; }
function secret(value, label) { if (typeof value !== 'string' || !SECRET.test(value) || Buffer.from(value, 'base64url').length !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) throw fail(label + '必须是 32 字节随机密钥。'); return value; }
function validateInvite(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('远程邀请无效。');
  const allowed = ['v', 'relay', 'relayFingerprint', 'room', 'joinKey', 'serverId', 'fingerprint'];
  if (Object.keys(value).some(k => !allowed.includes(k)) || allowed.some(k => !(k in value))) throw fail('远程邀请字段无效。');
  if (value.v !== 1 || !UUID.test(value.room) || value.room !== value.serverId || !FINGERPRINT.test(value.fingerprint)) throw fail('远程邀请设备身份无效。');
  return Object.freeze({ v: 1, relay: normalizeRelay(value.relay), relayFingerprint: fingerprint(value.relayFingerprint), room: value.room, joinKey: secret(value.joinKey, '访问密钥'), serverId: value.serverId, fingerprint: value.fingerprint });
}
function encodeInvite(value) { return PREFIX + Buffer.from(JSON.stringify(validateInvite(value))).toString('base64url'); }
function decodeInvite(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith(PREFIX)) throw fail('请粘贴完整的远程邀请。');
  const encoded = raw.slice(PREFIX.length); if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw fail('远程邀请编码无效。');
  const bytes = Buffer.from(encoded, 'base64url'); if (bytes.toString('base64url') !== encoded) throw fail('远程邀请编码无效。');
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw fail('远程邀请内容无效。'); } return validateInvite(value);
}
function validateHostConfig(value) {
  if (!value || typeof value !== 'object' || !UUID.test(value.room) || !Number.isInteger(value.localPort) || value.localPort < 1 || value.localPort > 65535) throw fail('远程共享配置无效。');
  return { relay: normalizeRelay(value.relay), relayFingerprint: fingerprint(value.relayFingerprint), room: value.room, serviceKey: secret(value.serviceKey, '服务密钥'), hostKey: secret(value.hostKey, '主机密钥'), joinKey: secret(value.joinKey, '访问密钥'), localPort: value.localPort };
}
function randomSecret() { return crypto.randomBytes(32).toString('base64url'); }
function equalSecret(value, expected) { return typeof value === 'string' && typeof expected === 'string' && crypto.timingSafeEqual(crypto.createHash('sha256').update(value).digest(), crypto.createHash('sha256').update(expected).digest()); }
function sendLine(socket, value) { const text = JSON.stringify(value); if (Buffer.byteLength(text) > MAX_HEADER) throw fail('中继消息过大。', 'HEADER_TOO_LARGE'); socket.write(text + '\n'); }
function readLine(socket, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), timer, done = false;
    function finish(error, value) { if (done) return; done = true; clearTimeout(timer); socket.pause(); socket.off('data', data); socket.off('error', errorEvent); socket.off('end', ended); socket.off('close', ended); error ? reject(error) : resolve(value); }
    function errorEvent(error) { finish(error); } function ended() { finish(fail('中继连接已关闭。', 'CONNECTION_CLOSED')); }
    function data(chunk) {
      const index = chunk.indexOf(10), take = index < 0 ? chunk.length : index;
      if (bytes.length + take > MAX_HEADER) return finish(fail('中继消息过大。', 'HEADER_TOO_LARGE'));
      bytes = Buffer.concat([bytes, chunk.subarray(0, take)]);
      if (index >= 0) { socket.pause(); if (index + 1 < chunk.length) socket.unshift(chunk.subarray(index + 1)); let value; try { value = JSON.parse(bytes.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); } catch { return finish(fail('中继消息格式错误。', 'INVALID_HEADER')); } finish(null, value); }
    }
    if (socket.destroyed || socket.readableEnded) return finish(fail('中继连接已关闭。', 'CONNECTION_CLOSED'));
    socket.on('data', data); socket.once('error', errorEvent); socket.once('end', ended); socket.once('close', ended);
    timer = setTimeout(() => finish(fail('中继响应超时。', 'TIMEOUT')), timeout); timer.unref(); socket.resume();
  });
}
module.exports = { UUID, SECRET, FINGERPRINT, MAX_HEADER, fail, normalizeRelay, endpoint, fingerprint, secret, validateInvite, encodeInvite, decodeInvite, validateHostConfig, randomSecret, equalSecret, readLine, sendLine };
