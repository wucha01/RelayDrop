'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const tls = require('node:tls');
const { Readable } = require('node:stream');

function certificateMatches(raw, expected) {
  try {
    const cert = new crypto.X509Certificate(raw);
    return Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now()
      && /^[a-f0-9]{64}$/.test(expected) && crypto.createHash('sha256').update(cert.raw).digest('hex') === expected;
  } catch { return false; }
}
function certificatePemMatches(pem, expected) { return typeof pem === 'string' && certificateMatches(pem, expected); }

// The asynchronous Agent callback is invoked only after the pin has been checked.
// Returning a socket early would let https.request send a credential before verification.
function pinnedFetch(origin, fingerprint) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('远程连接参数无效。');
  return (address, options = {}) => new Promise((resolve, reject) => {
    let target;
    try { target = new URL(address); if (target.origin !== base.origin || target.username || target.password) throw new Error(); }
    catch { reject(new Error('已阻止离开已验证设备的请求。')); return; }
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = (settings, callback) => {
      let called = false;
      const finish = (error, socket) => { if (called) return; called = true; callback(error, socket); };
      const socket = tls.connect({ host: base.hostname, port: Number(base.port || 443), servername: '', rejectUnauthorized: false, minVersion: 'TLSv1.2' });
      socket.setTimeout(15000, () => socket.destroy(new Error('远程设备连接超时。')));
      socket.once('error', error => finish(error));
      socket.once('secureConnect', () => {
        if (!certificateMatches(socket.getPeerCertificate().raw, fingerprint)) {
          const error = new Error('远程设备证书已变化或失效，连接已阻止。'); error.code = 'IDENTITY_CHANGED'; finish(error); socket.destroy(); return;
        }
        socket.setTimeout(0); finish(null, socket);
      });
      // Deliberately return undefined: no HTTP bytes may precede the pin check.
    };
    const request = https.request(target, { method: options.method || 'GET', headers: options.headers || {}, agent, signal: options.signal }, response => {
      const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const noBody = (options.method || 'GET') === 'HEAD' || [204, 205, 304].includes(response.statusCode);
      response.once('close', () => agent.destroy());
      resolve(new Response(noBody ? null : Readable.toWeb(response), { status: response.statusCode, headers }));
      if (noBody) response.resume();
    });
    request.once('error', error => { agent.destroy(); reject(error); });
    request.setTimeout(30000, () => request.destroy(new Error('远程设备没有响应。')));
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function encryptedStore(directory, safeStorage) {
  const filename = path.join(directory, 'remote-connections.bin');
  function available() { if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据保护暂不可用，远程密钥未保存。'); }
  return {
    read() {
      if (!fs.existsSync(filename)) return { version: 1, host: null, profiles: [] };
      available(); const bytes = fs.readFileSync(filename); if (bytes.length > 128 * 1024) throw new Error('远程配置文件异常。');
      const value = JSON.parse(safeStorage.decryptString(bytes));
      if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 20) throw new Error('远程配置文件异常。');
      return value;
    },
    write(value) {
      available(); const text = JSON.stringify(value); if (Buffer.byteLength(text) > 64 * 1024) throw new Error('远程配置过大。');
      const data = safeStorage.encryptString(text), temporary = filename + '.' + crypto.randomUUID() + '.tmp';
      let fd;
      try { fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = null; fs.renameSync(temporary, filename); }
      finally { if (fd !== undefined && fd !== null) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
    }
  };
}
module.exports = { certificateMatches, certificatePemMatches, pinnedFetch, encryptedStore };
