'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), tls = require('node:tls'), https = require('node:https'), net = require('node:net');
const { loadOrCreateIdentity } = require('../security.cjs');
const { createBroker } = require('../remote/broker.cjs');
const { RemoteHost, createRemoteTunnel, connectTls } = require('../remote/client.cjs');
const P = require('../remote/protocol.cjs');
let dir, identity;
test.before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-remote-test-')); identity = await loadOrCreateIdentity(dir); });
test.after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 5000) { const deadline = Date.now() + timeout; while (!fn()) { if (Date.now() >= deadline) throw Error('Condition timed out'); await sleep(20); } }
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function fixture(t, options = {}) {
  const serviceKey = P.randomSecret(), room = crypto.randomUUID(), joinKey = P.randomSecret(), hostKey = P.randomSecret();
  const broker = await createBroker({ key: identity.key, cert: identity.cert, serviceKey, ...options });
  const config = { relay: 'tls://127.0.0.1:' + broker.port, relayFingerprint: identity.fingerprint, room, serviceKey, joinKey, hostKey, localPort: 1 };
  const invite = P.validateInvite({ v: 1, relay: config.relay, relayFingerprint: config.relayFingerprint, room, serverId: room, joinKey, fingerprint: identity.fingerprint });
  const resources = []; t.after(async () => { for (const resource of resources.reverse()) await resource.close(); await broker.close(); });
  async function handshake(message) { const socket = await connectTls(config); socket.on('error', () => {}); resources.push({ close: () => socket.destroy() }); P.sendLine(socket, { v: 1, room, ...message }); return { socket, answer: await P.readLine(socket) }; }
  return { broker, config, invite, resources, handshake };
}
async function serving(t, options = {}) {
  const f = await fixture(t, options), connections = new Set();
  const server = https.createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' }, (req, res) => {
    if (req.url === '/slow') { const bytes = Buffer.alloc(12 * 1024 * 1024 + 137, 91); bytes.write('TAIL COMPLETE', bytes.length - 13); res.writeHead(200, { 'Content-Length': bytes.length, Connection: 'close' }); res.end(bytes); }
    else if (req.url === '/large') { res.writeHead(200, { 'Content-Length': 2 * 1024 * 1024 }); res.end(Buffer.alloc(2 * 1024 * 1024, 73)); }
    else if (req.url === '/hold') { res.writeHead(200); res.write('ready'); }
    else { res.writeHead(200); req.pipe(res); }
  });
  server.on('connection', s => { connections.add(s); s.on('error', () => {}); s.once('close', () => connections.delete(s)); }); server.on('tlsClientError', () => {});
  const port = await listen(server); f.resources.push({ close: () => new Promise(resolve => { for (const s of connections) s.destroy(); server.close(resolve); }) });
  const host = new RemoteHost({ ...f.config, localPort: port }); f.resources.push(host); host.start(); await until(() => host.status.state === 'online');
  const tunnel = await createRemoteTunnel(f.invite); f.resources.push(tunnel); return { ...f, server, host, tunnel };
}
function request(port, payload = Buffer.alloc(0), pathname = '/', options = {}) {
  return new Promise((resolve, reject) => { const req = https.request({ hostname: '127.0.0.1', port, method: 'POST', path: pathname, ca: identity.cert, agent: false, timeout: 8000, ...options }, res => { const chunks = []; res.on('error', reject); res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ bytes: Buffer.concat(chunks), status: res.statusCode, fingerprint: crypto.createHash('sha256').update(req.socket.getPeerCertificate().raw).digest('hex') })); }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('Request timed out'))); req.end(payload); });
}

test('remote invitation strictly validates schema, canonical secrets, scheme, identity and URL', () => {
  const room = crypto.randomUUID(), value = { v: 1, relay: 'tls://Example.COM', relayFingerprint: null, room, serverId: room, joinKey: P.randomSecret(), fingerprint: 'a'.repeat(64) };
  const encoded = P.encodeInvite(value); assert.equal(P.decodeInvite(encoded).relay, 'tls://example.com:443'); assert.equal(P.decodeInvite(encoded).joinKey, value.joinKey);
  for (const patch of [{ serviceKey: P.randomSecret() }, { v: 2 }, { serverId: crypto.randomUUID() }, { joinKey: 'x'.repeat(43) }, { fingerprint: 'A'.repeat(64) }, { relay: 'http://example.com' }, { relay: 'tls://user:secret@example.com:443' }, { relay: 'tls://example.com:443/path' }, { relay: 'tls://example.com:443#secret' }]) assert.throws(() => P.validateInvite({ ...value, ...patch }));
  assert.throws(() => P.decodeInvite(encoded + '=')); assert.throws(() => P.decodeInvite(encoded + '\n')); assert.equal(P.normalizeRelay('tls://[::1]:9443'), 'tls://[::1]:9443'); assert.ok(!encoded.includes('serviceKey'));
});

test('outer TLS refuses untrusted CA and wrong full fingerprint before credentials', async t => {
  const f = await fixture(t); await assert.rejects(connectTls({ ...f.config, relayFingerprint: null })); await assert.rejects(connectTls({ ...f.config, relayFingerprint: 'a'.repeat(64) }), e => e.code === 'CERT_PIN_MISMATCH');
  assert.equal(f.broker.stats().hosts, 0); const socket = await connectTls(f.config); socket.destroy();
});

test('wrong outer pin sends zero application bytes to the substituted broker', async t => {
  let received = 0; const connections = new Set(); const server = tls.createServer({ key: identity.key, cert: identity.cert }, socket => { socket.on('data', b => received += b.length); socket.on('error', () => {}); });
  server.on('connection', s => { connections.add(s); s.on('error', () => {}); s.once('close', () => connections.delete(s)); }); server.on('tlsClientError', () => {}); const port = await listen(server);
  t.after(() => new Promise(resolve => { for (const s of connections) s.destroy(); server.close(resolve); })); await assert.rejects(connectTls({ relay: 'tls://127.0.0.1:' + port, relayFingerprint: 'f'.repeat(64) }), e => e.code === 'CERT_PIN_MISMATCH'); await sleep(30); assert.equal(received, 0);
});

test('broker refuses unauthorized host and unknown join without registering rooms', async t => {
  const f = await fixture(t); assert.equal((await f.handshake({ op: 'host', serviceKey: P.randomSecret(), hostKey: f.config.hostKey, joinKey: f.config.joinKey })).answer.code, 'UNAUTHORIZED'); assert.equal((await f.handshake({ op: 'join', joinKey: f.invite.joinKey })).answer.code, 'UNAUTHORIZED'); assert.equal(f.broker.stats().rooms, 0);
});

test('nested TLS preserves endpoint identity and exact binary bytes both directions', async t => {
  const f = await serving(t), bytes = crypto.randomBytes(4 * 1024 * 1024 + 71); const response = await request(f.tunnel.port, bytes); assert.equal(response.status, 200); assert.equal(response.fingerprint, identity.fingerprint); assert.deepEqual(response.bytes, bytes); assert.deepEqual((await request(f.tunnel.port)).bytes, Buffer.alloc(0));
});

test('large response final bytes survive connection shutdown and backpressure', async t => {
  const f = await serving(t); for (let i = 0; i < 3; i++) { const response = await request(f.tunnel.port, Buffer.alloc(0), '/large'); assert.equal(response.bytes.length, 2 * 1024 * 1024); assert.ok(response.bytes.equals(Buffer.alloc(response.bytes.length, 73))); }
});

test('12 MiB slow receiver retains the final encrypted bytes after normal FIN', async t => {
  const f = await serving(t); const bytes = await new Promise((resolve, reject) => {
    const req = https.get({ hostname: '127.0.0.1', port: f.tunnel.port, path: '/slow', ca: identity.cert, agent: false, timeout: 15000 }, res => {
      const chunks = []; res.on('error', reject); res.on('data', chunk => { chunks.push(chunk); res.pause(); setTimeout(() => res.resume(), 2); }); res.on('end', () => resolve(Buffer.concat(chunks))); res.pause(); setTimeout(() => res.resume(), 250);
    }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('Slow receiver timeout')));
  });
  const expected = Buffer.alloc(12 * 1024 * 1024 + 137, 91); expected.write('TAIL COMPLETE', expected.length - 13); assert.deepEqual(bytes, expected); await until(() => f.broker.stats().streams === 0);
});

test('parallel encrypted client tunnels keep payloads independent', async t => {
  const f = await serving(t); const expected = Array.from({ length: 8 }, (_, i) => Buffer.alloc(32768 + i, i)); const result = await Promise.all(expected.map(bytes => request(f.tunnel.port, bytes))); result.forEach((r, i) => assert.deepEqual(r.bytes, expected[i]));
});

test('wrong invitation access key cannot reach the inner file server', async t => {
  const f = await serving(t); let calls = 0; f.server.on('request', () => calls++); const wrong = await createRemoteTunnel({ ...f.invite, joinKey: P.randomSecret() }); f.resources.push(wrong); await assert.rejects(request(wrong.port, Buffer.from('secret'))); assert.equal(calls, 0);
});

test('duplicate live host and owner replacement are refused', async t => {
  const f = await serving(t); const h = { op: 'host', serviceKey: f.config.serviceKey, hostKey: f.config.hostKey, joinKey: f.config.joinKey };
  assert.equal((await f.handshake(h)).answer.code, 'HOST_ALREADY_ONLINE'); await f.host.close(); await until(() => f.broker.stats().hosts === 0);
  assert.equal((await f.handshake({ ...h, hostKey: P.randomSecret() })).answer.code, 'ROOM_OWNER_MISMATCH'); assert.equal((await f.handshake({ op: 'join', joinKey: f.invite.joinKey })).answer.code, 'HOST_OFFLINE');
});

test('host stop closes active streams and same identity can reconnect', async t => {
  const f = await serving(t); const first = await request(f.tunnel.port, Buffer.from('before')); assert.equal(first.bytes.toString(), 'before'); await f.host.close(); await until(() => f.broker.stats().hosts === 0 && f.broker.stats().streams === 0); await assert.rejects(request(f.tunnel.port)); f.host.start(); await until(() => f.host.status.state === 'online'); assert.equal((await request(f.tunnel.port, Buffer.from('after'))).bytes.toString(), 'after');
});

test('attachment tickets are one-use and bound to pending room/session', async t => {
  const f = await fixture(t); const control = await f.handshake({ op: 'host', serviceKey: f.config.serviceKey, hostKey: f.config.hostKey, joinKey: f.config.joinKey }); assert.equal(control.answer.ok, true);
  const join = await connectTls(f.config); f.resources.push({ close: () => join.destroy() }); P.sendLine(join, { v: 1, op: 'join', room: f.config.room, joinKey: f.config.joinKey }); const open = await P.readLine(control.socket); assert.equal(open.op, 'open');
  assert.equal((await f.handshake({ op: 'attach', id: open.id, ticket: P.randomSecret() })).answer.code, 'INVALID_TICKET'); const attached = await f.handshake({ op: 'attach', id: open.id, ticket: open.ticket }); assert.equal(attached.answer.ok, true); assert.equal((await P.readLine(join)).ok, true);
  assert.equal((await f.handshake({ op: 'attach', id: open.id, ticket: open.ticket })).answer.code, 'INVALID_TICKET');
});

test('stale pending tickets expire and control disconnect closes waiting clients', async t => {
  const f = await fixture(t, { pendingTimeout: 150 }); const control = await f.handshake({ op: 'host', serviceKey: f.config.serviceKey, hostKey: f.config.hostKey, joinKey: f.config.joinKey });
  const join = await connectTls(f.config); f.resources.push({ close: () => join.destroy() }); P.sendLine(join, { v: 1, op: 'join', room: f.config.room, joinKey: f.config.joinKey }); const open = await P.readLine(control.socket); assert.equal((await P.readLine(join)).code, 'HOST_TIMEOUT'); assert.equal((await f.handshake({ op: 'attach', id: open.id, ticket: open.ticket })).answer.code, 'INVALID_TICKET'); assert.equal(f.broker.stats().streams, 0);
});

test('bounded handshake rejects oversized and pipelined bytes', async t => {
  const f = await fixture(t); const over = await connectTls(f.config); f.resources.push({ close: () => over.destroy() }); over.write('x'.repeat(P.MAX_HEADER + 1)); assert.equal((await P.readLine(over)).code, 'HEADER_TOO_LARGE');
  const pipelined = await connectTls(f.config); f.resources.push({ close: () => pipelined.destroy() }); pipelined.write(JSON.stringify({ v: 1, op: 'host', room: f.config.room, serviceKey: f.config.serviceKey, hostKey: f.config.hostKey, joinKey: f.config.joinKey }) + '\nnot-a-command'); assert.equal((await P.readLine(pipelined)).code, 'UNEXPECTED_DATA'); assert.equal(f.broker.stats().rooms, 0);
});

test('room and pending-stream quotas prevent unbounded registrations', async t => {
  const f = await fixture(t, { maxRooms: 1, maxStreamsPerRoom: 1 }); const h = { op: 'host', serviceKey: f.config.serviceKey, hostKey: f.config.hostKey, joinKey: f.config.joinKey }; const control = await f.handshake(h);
  assert.equal((await f.handshake({ ...h, room: crypto.randomUUID() })).answer.code, 'ROOM_LIMIT'); const join = await connectTls(f.config); f.resources.push({ close: () => join.destroy() }); P.sendLine(join, { v: 1, op: 'join', room: f.config.room, joinKey: f.config.joinKey }); await P.readLine(control.socket); assert.equal((await f.handshake({ op: 'join', joinKey: f.config.joinKey })).answer.code, 'STREAM_LIMIT');
});

test('host service credential errors stop retrying and close is prompt', async t => {
  const f = await fixture(t), host = new RemoteHost({ ...f.config, serviceKey: P.randomSecret() }); f.resources.push(host); host.start(); await until(() => host.status.state === 'error'); assert.match(host.status.error, /UNAUTHORIZED/); const start = Date.now(); await host.close(); assert.ok(Date.now() - start < 1000); assert.equal(host.status.state, 'stopped');
});

test('network failure retries and stop cancels the backoff timer', async t => {
  const f = await fixture(t); await f.broker.close(); const host = new RemoteHost(f.config); f.resources.push(host); host.start(); await until(() => host.status.state === 'retrying'); const start = Date.now(); await host.close(); assert.ok(Date.now() - start < 1000); assert.equal(host.status.state, 'stopped');
});

test('local tunnel stays loopback-only and closing it releases active peers', async t => {
  const f = await serving(t); assert.match(f.tunnel.origin, /^https:\/\/127\.0\.0\.1:\d+$/); await f.tunnel.close(); await assert.rejects(request(f.tunnel.port));
});
