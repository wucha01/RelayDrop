'use strict';
const tls = require('node:tls'), crypto = require('node:crypto');
const { UUID, secret, randomSecret, equalSecret, readLine, sendLine, fail } = require('./protocol.cjs');
async function createBroker(options = {}) {
  const serviceKey = secret(options.serviceKey, '服务密钥'); if (!options.key || !options.cert) throw fail('中继服务必须配置 TLS 证书和私钥。');
  const sessionSecret = crypto.randomBytes(32);
  const rooms = new Map(), sockets = new Set(), rawSockets = new Set(), failures = new Map(); let closing = false;
  const maxRooms = options.maxRooms || 128, maxConnections = options.maxConnections || 256, maxStreamsPerRoom = options.maxStreamsPerRoom || 16;
  const headerTimeout = options.headerTimeout || 15000, pendingTimeout = options.pendingTimeout || 15000, idleTimeout = options.idleTimeout || 120000;
  function reject(socket, code) { if (socket.destroyed) return; socket.end(JSON.stringify({ ok: false, code }) + '\n'); const timer = setTimeout(() => socket.destroy(), 250); timer.unref(); }
  function bad(socket, code) { const address = socket.remoteAddress || ''; const entry = failures.get(address) || { count: 0, until: Date.now() + 60000 }; if (entry.until < Date.now()) { entry.count = 0; entry.until = Date.now() + 60000; } entry.count++; if (failures.size < 512 || failures.has(address)) failures.set(address, entry); reject(socket, code); }
  function dropStream(room, stream) { if (!room.streams.delete(stream.id)) return; clearTimeout(stream.timer); stream.join.destroy(); stream.attach?.destroy(); }
  function streamClosed(room, stream, peer, hadError) {
    if (!stream.attach || hadError || !peer.readableEnded) return dropStream(room, stream);
    const other = peer === stream.join ? stream.attach : stream.join;
    // A clean FIN can arrive while the other socket still has buffered writes.
    // end() drains those bytes; destroy() would truncate the encrypted payload.
    if (!other.destroyed) other.end();
    if (stream.join.destroyed && stream.attach.destroyed) { room.streams.delete(stream.id); clearTimeout(stream.timer); }
  }
  function offline(room, control) { if (room.control !== control) return; room.control = null; for (const stream of [...room.streams.values()]) dropStream(room, stream); }
  async function handle(socket) {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.setNoDelay(true);
    const limited = failures.get(socket.remoteAddress || ''); if (limited && limited.until > Date.now() && limited.count >= 20) return reject(socket, 'RATE_LIMIT');
    try {
      const h = await readLine(socket, headerTimeout); if (closing) return reject(socket, 'CLOSING');
      if (socket.readableLength) return bad(socket, 'UNEXPECTED_DATA');
      if (h.v !== 1 || !UUID.test(h.room)) return bad(socket, 'INVALID_HEADER');
      if (h.op === 'host') {
        if (!equalSecret(h.serviceKey, serviceKey)) return bad(socket, 'UNAUTHORIZED');
        try { secret(h.hostKey, ''); secret(h.joinKey, ''); } catch { return bad(socket, 'INVALID_HEADER'); }
        let room = rooms.get(h.room); if (room?.control && !room.control.destroyed) return reject(socket, 'HOST_ALREADY_ONLINE');
        if (room && !equalSecret(h.hostKey, room.hostKey)) return bad(socket, 'ROOM_OWNER_MISMATCH');
        if (!room) { if (rooms.size >= maxRooms) return reject(socket, 'ROOM_LIMIT'); room = { hostKey: h.hostKey, joinKey: h.joinKey, control: null, streams: new Map() }; rooms.set(h.room, room); }
        room.joinKey = h.joinKey; room.control = socket; socket.once('close', () => offline(room, socket)); sendLine(socket, { ok: true });
        try { while (!closing && !socket.destroyed) { const m = await readLine(socket, 65000); if (m.op !== 'ping' || Object.keys(m).length !== 1) throw fail('控制消息无效。'); sendLine(socket, { op: 'pong' }); } } finally { offline(room, socket); socket.destroy(); }
      } else if (h.op === 'join') {
        const room = rooms.get(h.room); if (!room || !equalSecret(h.joinKey, room.joinKey)) return bad(socket, 'UNAUTHORIZED');
        if (!room.control || room.control.destroyed) return reject(socket, 'HOST_OFFLINE');
        if (room.streams.size >= maxStreamsPerRoom) return reject(socket, 'STREAM_LIMIT');
        let session; try { session = h.session === undefined ? randomSecret() : secret(h.session, '会话'); } catch { return bad(socket, 'INVALID_HEADER'); }
        const peerId = crypto.createHmac('sha256', sessionSecret).update(h.room + '\n' + (socket.remoteAddress || '') + '\n' + session).digest('hex');
        const id = crypto.randomUUID(), stream = { id, ticket: randomSecret(), join: socket, attach: null, timer: null, control: room.control };
        room.streams.set(id, stream); socket.once('close', hadError => streamClosed(room, stream, socket, hadError));
        stream.timer = setTimeout(() => { reject(socket, 'HOST_TIMEOUT'); room.streams.delete(id); }, pendingTimeout); stream.timer.unref();
        sendLine(room.control, { op: 'open', id, ticket: stream.ticket, peerId });
      } else if (h.op === 'attach') {
        const room = rooms.get(h.room), stream = room?.streams.get(h.id);
        if (!stream || stream.attach || !room.control || stream.control !== room.control || !equalSecret(h.ticket, stream.ticket)) return bad(socket, 'INVALID_TICKET');
        stream.attach = socket; stream.ticket = null; clearTimeout(stream.timer); socket.once('close', hadError => streamClosed(room, stream, socket, hadError));
        sendLine(socket, { ok: true }); sendLine(stream.join, { ok: true });
        for (const peer of [socket, stream.join]) peer.setTimeout(idleTimeout, () => dropStream(room, stream));
        socket.pipe(stream.join); stream.join.pipe(socket);
      } else return bad(socket, 'INVALID_OPERATION');
    } catch (error) { if (!socket.destroyed) bad(socket, ['HEADER_TOO_LARGE', 'TIMEOUT'].includes(error.code) ? error.code : 'INVALID_HEADER'); }
  }
  const server = tls.createServer({ key: options.key, cert: options.cert, minVersion: 'TLSv1.2', handshakeTimeout: headerTimeout, allowHalfOpen: true }, socket => { void handle(socket); });
  server.on('connection', socket => { rawSockets.add(socket); socket.on('error', () => {}); socket.once('close', () => rawSockets.delete(socket)); if (closing || rawSockets.size > maxConnections) socket.destroy(); });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, rejectPromise) => { const error = e => { server.off('listening', ready); rejectPromise(e); }; const ready = () => { server.off('error', error); resolve(); }; server.once('error', error); server.once('listening', ready); server.listen(options.port ?? 0, options.host || '127.0.0.1'); });
  let closePromise;
  return { port: server.address().port, address: server.address().address,
    stats: () => ({ rooms: rooms.size, hosts: [...rooms.values()].filter(r => r.control && !r.control.destroyed).length, streams: [...rooms.values()].reduce((n, r) => n + r.streams.size, 0), sockets: sockets.size }),
    close() { if (closePromise) return closePromise; closing = true; closePromise = new Promise(resolve => { for (const room of rooms.values()) for (const stream of [...room.streams.values()]) dropStream(room, stream); for (const s of sockets) s.destroy(); for (const s of rawSockets) s.destroy(); server.close(() => resolve()); }); return closePromise; }
  };
}
module.exports = { createBroker };
