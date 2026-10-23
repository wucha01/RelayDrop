'use strict';
const tls = require('node:tls'), net = require('node:net'), crypto = require('node:crypto'), { EventEmitter } = require('node:events');
const { endpoint, validateHostConfig, validateInvite, decodeInvite, UUID, SECRET, readLine, sendLine, fail } = require('./protocol.cjs');
function connectTls(config, onSocket = () => {}) {
  return new Promise((resolve, reject) => {
    const { host, port } = endpoint(config.relay), pin = config.relayFingerprint;
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2', rejectUnauthorized: !pin, allowHalfOpen: true });
    onSocket(socket); socket.on('error', () => {}); socket.setNoDelay(true); let done = false;
    const timer = setTimeout(() => finish(fail('中继连接超时。', 'TIMEOUT')), 15000); timer.unref();
    function finish(error) { if (done) return; done = true; clearTimeout(timer); socket.off('error', onError); socket.off('close', onClose); if (error) { socket.destroy(); reject(error); } else { socket.pause(); resolve(socket); } }
    function onError(error) { finish(error); } function onClose() { finish(fail('中继连接已关闭。', 'CONNECTION_CLOSED')); }
    socket.once('error', onError); socket.once('close', onClose);
    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate(); if (!cert.raw) throw fail('中继没有提供设备证书。', 'CERT_PIN_MISMATCH');
        const parsed = new crypto.X509Certificate(cert.raw);
        if (Date.parse(parsed.validFrom) > Date.now() || Date.parse(parsed.validTo) <= Date.now()) throw fail('中继证书已过期或系统时间不正确。', 'CERT_DATE_INVALID');
        if (pin && crypto.createHash('sha256').update(cert.raw).digest('hex') !== pin) throw fail('中继证书指纹不匹配，已停止连接。', 'CERT_PIN_MISMATCH');
        if (!pin && !socket.authorized) throw fail('中继证书不受信任。', 'CERT_UNTRUSTED');
        finish();
      } catch (error) { finish(error); }
    });
  });
}
function checkAck(value) { if (value.ok !== true) throw fail('中继拒绝连接：' + (typeof value.code === 'string' && /^[A-Z_]{1,40}$/.test(value.code) ? value.code : 'INVALID_RESPONSE'), value.code || 'INVALID_RESPONSE'); }
function isPermanent(error) { return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNAUTHORIZED|ROOM_OWNER_MISMATCH|HOST_ALREADY_ONLINE|INVALID_CONFIG/.test(error.code || ''); }
function tracked(set, socket) { set.add(socket); socket.on('error', () => {}); socket.once('close', () => set.delete(socket)); return socket; }
function bridge(a, b) {
  const abort = () => { a.destroy(); b.destroy(); };
  a.on('error', abort); b.on('error', abort);
  for (const peer of [a, b]) peer.setTimeout(120000, abort);
  // Preserve the final queued bytes on a normal FIN; errors abort immediately.
  a.once('close', hadError => { if (hadError || !a.readableEnded) b.destroy(); else b.end(); });
  b.once('close', hadError => { if (hadError || !b.readableEnded) a.destroy(); else a.end(); });
  a.pipe(b); b.pipe(a);
}
class RemoteHost extends EventEmitter {
  constructor(config, options = {}) { super(); this.options = options; this.config = validateHostConfig(config); this.status = Object.freeze({ state: 'stopped' }); this.sockets = new Set(); this.stopped = true; this.running = false; this.control = null; this.generation = 0; this.streams = 0; }
  update(state, error) { this.status = Object.freeze({ state, ...(error ? { error } : {}) }); this.emit('status', this.status); }
  start() { if (this.running) return this; this.stopped = false; this.running = true; this.run = this.loop().finally(() => { this.running = false; }); return this; }
  async loop() {
    let attempt = 0;
    while (!this.stopped) {
      const generation = ++this.generation; let control, heartbeat, connectedAt = 0;
      this.update(attempt ? 'retrying' : 'connecting');
      try {
        control = await connectTls(this.config, s => tracked(this.sockets, s)); if (this.stopped) { control.destroy(); break; } this.control = control;
        sendLine(control, { v: 1, op: 'host', room: this.config.room, serviceKey: this.config.serviceKey, hostKey: this.config.hostKey, joinKey: this.config.joinKey }); checkAck(await readLine(control));
        if (this.stopped) break; connectedAt = Date.now(); this.update('online');
        heartbeat = setInterval(() => { if (!control.destroyed) sendLine(control, { op: 'ping' }); }, 20000); heartbeat.unref();
        while (!this.stopped && !control.destroyed) {
          const message = await readLine(control, 65000);
          if (message.op === 'pong') continue;
          if (message.op !== 'open' || !UUID.test(message.id) || !SECRET.test(message.ticket) || message.peerId !== undefined && !/^[a-f0-9]{64}$/.test(message.peerId)) throw fail('中继控制消息无效。', 'INVALID_RESPONSE');
          if (this.streams >= 16) continue;
          this.streams++; void this.attach(message, generation).finally(() => this.streams--);
        }
      } catch (error) {
        if (!this.stopped && isPermanent(error)) { this.update('error', error.message); this.stopped = true; }
        else if (!this.stopped) this.update('retrying', '连接中断，正在等待自动重连。');
      } finally {
        clearInterval(heartbeat); if (this.control === control) this.control = null; for (const socket of this.sockets) socket.destroy(); this.generation++;
      }
      if (this.stopped) break;
      if (connectedAt && Date.now() - connectedAt > 60000) attempt = 0;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5));
      await new Promise(resolve => { const timer = setTimeout(resolve, delay); timer.unref(); this.wake = () => { clearTimeout(timer); resolve(); }; }); this.wake = null;
    }
  }
  async attach(message, generation) {
    let local, remote;
    try {
      if (this.stopped || this.generation !== generation) return;
      local = tracked(this.sockets, net.connect({ host: '127.0.0.1', port: this.config.localPort, allowHalfOpen: true })); local.pause();
      await new Promise((resolve, reject) => { const timer = setTimeout(() => { local.destroy(); reject(fail('本机文件池连接超时。', 'TIMEOUT')); }, 10000); timer.unref(); const done = e => { clearTimeout(timer); local.off('connect', connected); local.off('error', done); local.off('close', closed); e ? reject(e) : resolve(); }; const connected = () => done(); const closed = () => done(fail('本机文件池连接已关闭。')); local.once('connect', connected); local.once('error', done); local.once('close', closed); });
      if (message.peerId && this.options.registerPeer) this.options.registerPeer(local.localPort, message.peerId);
      remote = await connectTls(this.config, s => tracked(this.sockets, s));
      if (this.stopped || this.generation !== generation) throw fail('远程共享已停止。');
      sendLine(remote, { v: 1, op: 'attach', room: this.config.room, id: message.id, ticket: message.ticket }); checkAck(await readLine(remote));
      if (this.stopped || this.generation !== generation) throw fail('远程共享已停止。');
      bridge(local, remote);
      await new Promise(resolve => { if (remote.destroyed) resolve(); else remote.once('close', resolve); });
    } catch { local?.destroy(); remote?.destroy(); }
  }
  async close() { this.stopped = true; this.generation++; this.wake?.(); for (const socket of this.sockets) socket.destroy(); await this.run; this.update('stopped'); }
}
async function createRemoteTunnel(value, options = {}) {
  // Transport only: the caller must verify the inner server certificate and serverId
  // from the invitation before sending any file-pool pairing/authentication data.
  const invite = typeof value === 'string' ? decodeInvite(value) : validateInvite(value);
  const sockets = new Set(), session = crypto.randomBytes(32).toString('base64url'); let closing = false, active = 0, closePromise;
  const server = net.createServer({ allowHalfOpen: true }, local => {
    tracked(sockets, local); local.pause(); if (closing || active >= 16) return local.destroy(); active++; local.once('close', () => active--);
    void (async () => { let remote; try { remote = await connectTls(invite, s => tracked(sockets, s)); if (closing || local.destroyed) throw fail('连接已关闭。'); sendLine(remote, { v: 1, op: 'join', room: invite.room, joinKey: invite.joinKey, session }); checkAck(await readLine(remote, 20000)); if (closing || local.destroyed) throw fail('连接已关闭。'); bridge(local, remote); } catch (error) { local.destroy(); remote?.destroy(); options.onError?.({ code: error.code || 'CONNECTION_FAILED', message: isPermanent(error) ? error.message : '远程文件池暂不可用，请确认主机和中继服务在线。' }); } })();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const port = server.address().port;
  return { port, origin: 'https://127.0.0.1:' + port, close() { if (closePromise) return closePromise; closing = true; closePromise = new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }); return closePromise; } };
}
module.exports = { RemoteHost, createRemoteTunnel, connectTls };
