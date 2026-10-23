'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const pending = new Map();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validateIdentity(value) {
  if (!value || value.version !== 1 || !UUID.test(value.serverId) || typeof value.key !== 'string' || typeof value.cert !== 'string') throw new Error('设备身份文件损坏；已停止启动，避免静默更换设备身份。');
  const cert = new crypto.X509Certificate(value.cert), key = crypto.createPrivateKey(value.key);
  if (!cert.checkPrivateKey(key) || !cert.verify(cert.publicKey) || !cert.subject.includes('CN=RelayDrop-' + value.serverId)) throw new Error('设备证书与私钥不匹配；请恢复原身份备份。');
  if (Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now() + 300000) throw new Error('设备证书已过期或系统时间不正确，请检查时间或重新建立可信配对。');
  tls.createSecureContext({ key: value.key, cert: value.cert, minVersion: 'TLSv1.2' });
  return Object.freeze({ ...value, fingerprint: crypto.createHash('sha256').update(cert.raw).digest('hex'), expiresAt: new Date(cert.validTo).toISOString() });
}
async function generateIdentity() {
  const x509 = require('./vendor/x509.cjs');
  x509.cryptoProvider.set(crypto.webcrypto);
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 3072 };
  const keys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const serverId = crypto.randomUUID(), createdAt = new Date().toISOString();
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01' + crypto.randomBytes(18).toString('hex'), name: 'CN=RelayDrop-' + serverId,
    notBefore: new Date(Date.now() - 300000), notAfter: new Date(Date.now() + 5 * 365 * 86400000),
    signingAlgorithm: algorithm, keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], false),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'relaydrop-' + serverId + '.local' }, { type: 'dns', value: 'localhost' }, { type: 'ip', value: '127.0.0.1' }]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const key = crypto.createPrivateKey({ key: Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey)), type: 'pkcs8', format: 'der' }).export({ type: 'pkcs8', format: 'pem' });
  return { version: 1, serverId, cert: certificate.toString('pem'), key, createdAt };
}
async function loadOrCreateIdentity(dataDir) {
  const directory = path.resolve(dataDir);
  if (pending.has(directory)) return pending.get(directory);
  const task = (async () => {
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, 'tls-identity.json');
    try { return validateIdentity(JSON.parse(await fs.readFile(filename, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const value = await generateIdentity(), temporary = filename + '.' + crypto.randomUUID() + '.tmp';
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
      // Exclusive publication: a concurrent first start may win; its identity is authoritative.
      try { await fs.link(temporary, filename); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      return validateIdentity(JSON.parse(await fs.readFile(filename, 'utf8')));
    } finally { if (handle) await handle.close(); await fs.rm(temporary, { force: true }); }
  })();
  pending.set(directory, task);
  try { return await task; } finally { pending.delete(directory); }
}
function publicIdentity(identity) {
  return { protocol: 'relaydrop-tls-v1', serverId: identity.serverId, certificateFingerprint: identity.fingerprint, certificateExpiresAt: identity.expiresAt };
}
module.exports = { loadOrCreateIdentity, publicIdentity, validateIdentity };
