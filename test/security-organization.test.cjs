'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), https = require('node:https'), http = require('node:http'), tls = require('node:tls');
const { createSecureRelayServer, createRelayServer } = require('../server.cjs');
const { loadOrCreateIdentity } = require('../security.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay13-'));
  const app = await createSecureRelayServer({ dataDir: dir, host: '127.0.0.1', port: 0, discovery: false });
  const port = await app.listen(), origin = 'http://127.0.0.1:' + port;
  t.after(async () => { app.server.closeAllConnections(); await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  async function api(route, credential = app.hostToken, method = 'GET', body) {
    const response = await fetch(origin + route, { method, headers: { ...(credential ? { Authorization: 'Bearer ' + credential } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); return { status: response.status, data };
  }
  async function pair(name) { const s = await api('/api/state'); const response = await api('/api/pair', null, 'POST', { name, code: s.data.pairing.code }); assert.equal(response.status, 201); return response.data.token; }
  async function upload(name, bytes, credential = app.hostToken, targetId = null) {
    const start = await api('/api/transfers', credential, 'POST', { name, size: bytes.length, fingerprint: sha(bytes), targetId }); assert.equal(start.status, 201);
    if (bytes.length) { const sent = await fetch(origin + '/api/transfers/' + start.data.id, { method: 'PUT', headers: { Authorization: 'Bearer ' + credential, 'X-Offset': '0', 'X-Chunk-Sha256': sha(bytes) }, body: bytes }); assert.equal(sent.status, 200); await sent.arrayBuffer(); }
    const done = await api('/api/transfers/' + start.data.id + '/complete', credential, 'POST', {}); assert.equal(done.status, 200); return done.data;
  }
  return { dir, app, origin, api, pair, upload };
}
function httpsRequest(port, ca, route = '/api/identity', headers = {}) {
  return new Promise((resolve, reject) => { const request = https.get({ hostname: '127.0.0.1', port, path: route, ca, headers, agent: false, timeout: 3000 }, response => { const parts = []; response.on('data', b => parts.push(b)); response.on('end', () => resolve({ status: response.statusCode, data: Buffer.concat(parts).toString(), fingerprint: sha(response.socket?.getPeerCertificate()?.raw || request.socket.getPeerCertificate().raw), protocol: request.socket.getProtocol() })); }); request.on('error', reject); request.on('timeout', () => request.destroy(new Error('timeout'))); });
}
test('TLS: stable signed device identity persists and exposes no private key', async t => {
  const c = await fixture(t), a = await loadOrCreateIdentity(c.dir), b = await loadOrCreateIdentity(c.dir);
  assert.equal(a.fingerprint, b.fingerprint); assert.equal(a.serverId, b.serverId);
  const response = await httpsRequest(c.app.securePort, a.cert); assert.equal(response.status, 200);
  const identity = JSON.parse(response.data); assert.equal(identity.protocol, 'relaydrop-tls-v1'); assert.equal(identity.serverId, a.serverId); assert.equal(identity.certificateFingerprint, response.fingerprint); assert.match(response.protocol, /^TLSv1\.[23]$/); assert.ok(!response.data.includes('PRIVATE'));
  assert.equal(c.app.server.address().address, '127.0.0.1'); assert.notEqual(c.app.securePort, Number(new URL(c.origin).port));
  const state = await c.api('/api/state'); assert.equal(state.data.security.tlsEnabled, true); assert.equal(state.data.security.transport, 'loopback'); assert.ok(state.data.network.urls.every(url => url.startsWith('https://')));
});
test('TLS: untrusted certificate, plaintext, TLS 1.1 and hostile Origin are refused', async t => {
  const c = await fixture(t), identity = await loadOrCreateIdentity(c.dir);
  await assert.rejects(httpsRequest(c.app.securePort, undefined));
  await assert.rejects(new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port: c.app.securePort, path: '/api/health', timeout: 1500 }, resolve); r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); }));
  await assert.rejects(new Promise((resolve, reject) => { const socket = tls.connect({ host: '127.0.0.1', port: c.app.securePort, ca: identity.cert, minVersion: 'TLSv1', maxVersion: 'TLSv1.1' }, () => { socket.destroy(); resolve(); }); socket.on('error', reject); }));
  const denied = await httpsRequest(c.app.securePort, identity.cert, '/api/state', { Authorization: 'Bearer ' + c.app.hostToken, Origin: 'http://127.0.0.1:' + c.app.securePort }); assert.equal(denied.status, 403);
  const valid = await httpsRequest(c.app.securePort, identity.cert, '/api/state', { Authorization: 'Bearer ' + c.app.hostToken, Origin: 'https://127.0.0.1:' + c.app.securePort }); assert.equal(valid.status, 200); assert.equal(JSON.parse(valid.data).security.transport, 'tls');
});
test('TLS: corrupt identity fails closed rather than silently regenerating', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay13identity-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await loadOrCreateIdentity(dir); const bad = { ...first, key: 'broken' }; await fs.writeFile(path.join(dir, 'tls-identity.json'), JSON.stringify(bad));
  await assert.rejects(loadOrCreateIdentity(dir)); assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'tls-identity.json'), 'utf8')).key, 'broken');
  assert.throws(() => createRelayServer({ dataDir: path.join(dir, 'insecure'), host: '0.0.0.0', port: 0 }), /必须使用加密/);
});
test('organization: favorites and folders are private to each device and survive reload', async t => {
  const c = await fixture(t), a = await c.pair('phone'), b = await c.pair('tablet'), file = await c.upload('lesson.txt', Buffer.from('class'));
  assert.equal((await c.api('/api/collections', a, 'POST', { name: '课程' })).status, 200);
  assert.equal((await c.api('/api/files/' + file.id, a, 'PATCH', { favorite: true, collection: '课程' })).status, 200);
  const own = (await c.api('/api/state', a)).data, other = (await c.api('/api/state', b)).data;
  assert.equal(own.files[0].favorite, true); assert.equal(own.files[0].collection, '课程'); assert.deepEqual(other.collections, []); assert.equal(other.files[0].favorite, false);
  assert.equal((await c.api('/api/files/' + file.id, a, 'PATCH', { collection: 'missing' })).status, 400);
  assert.equal((await c.api('/api/files/' + file.id, a, 'PATCH', { sha256: 'changed' })).status, 400);
  await c.api('/api/collections/' + encodeURIComponent('课程'), a, 'DELETE'); const after = (await c.api('/api/state', a)).data; assert.equal(after.files[0].collection, null); assert.equal(after.files[0].favorite, true);
  const stored = JSON.parse(await fs.readFile(path.join(c.dir, 'state.json'), 'utf8')); assert.ok(Object.values(stored.preferences).some(p => p.files[file.id]?.favorite));
});
test('trash: soft delete, authorization, restore and permanent removal preserve originals until purge', async t => {
  const c = await fixture(t), a = await c.pair('sender'), b = await c.pair('other'), bytes = Buffer.from('keep original'), file = await c.upload('keep.txt', bytes, a);
  assert.equal((await c.api('/api/files/' + file.id, b, 'DELETE')).status, 403);
  assert.equal((await c.api('/api/files/' + file.id + '/permanent', a, 'DELETE')).status, 409);
  await c.api('/api/files/' + file.id, a, 'DELETE'); const s = (await c.api('/api/state', a)).data;
  assert.equal(s.files.length, 0); assert.equal(s.trash.length, 1); assert.equal(s.storage.trashBytes, bytes.length); assert.equal((await c.api('/api/state', b)).data.trash.length, 0);
  assert.deepEqual(await fs.readFile(path.join(c.dir, 'files', file.id)), bytes);
  assert.equal((await fetch(c.origin + '/api/files/' + file.id + '/content', { headers: { Authorization: 'Bearer ' + a } })).status, 404);
  assert.equal((await c.api('/api/files/' + file.id + '/restore', b, 'POST', {})).status, 403);
  await c.api('/api/files/' + file.id + '/restore', a, 'POST', {}); assert.equal((await c.api('/api/state', a)).data.files[0].sha256, sha(bytes));
  await c.api('/api/files/' + file.id, a, 'DELETE'); await c.api('/api/files/' + file.id + '/permanent', a, 'DELETE');
  await assert.rejects(fs.stat(path.join(c.dir, 'files', file.id)), { code: 'ENOENT' }); assert.equal((await c.api('/api/state', a)).data.trash.length, 0);
});
test('text preview: UTF-8, UTF-16 and literal markup, with integrity and size boundaries', async t => {
  const c = await fixture(t);
  for (const [name, bytes, expected] of [['a.md', Buffer.from('<script>not executed</script> 中文'), '<script>not executed</script> 中文'], ['b.txt', Buffer.concat([Buffer.from([255,254]), Buffer.from('课程', 'utf16le')]), '课程'], ['empty.txt', Buffer.alloc(0), '']]) {
    const file = await c.upload(name, bytes); const r = await fetch(c.origin + '/api/files/' + file.id + '/text', { headers: { Authorization: 'Bearer ' + c.app.hostToken } }); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^text\/plain/); assert.equal(await r.text(), expected);
    if (bytes.length) { await fs.writeFile(path.join(c.dir, 'files', file.id), Buffer.alloc(bytes.length, 0)); const changed = await fetch(c.origin + '/api/files/' + file.id + '/text', { headers: { Authorization: 'Bearer ' + c.app.hostToken } }); assert.equal(changed.status, 422); }
  }
  const bad = await c.upload('bad.txt', Buffer.from([255, 255, 0])); assert.equal((await fetch(c.origin + '/api/files/' + bad.id + '/text', { headers: { Authorization: 'Bearer ' + c.app.hostToken } })).status, 415);
  const big = await c.upload('large.txt', Buffer.alloc(256 * 1024 + 1, 65)); assert.equal(big.previewKind, null); assert.equal((await fetch(c.origin + '/api/files/' + big.id + '/text', { headers: { Authorization: 'Bearer ' + c.app.hostToken } })).status, 415);
});
test('persistent note jobs: client ID is idempotent and rejects conflicting text/target', async t => {
  const c = await fixture(t), a = await c.pair('sender'), clientId = crypto.randomUUID(), body = { text: 'share once', clientId };
  const first = await c.api('/api/notes', a, 'POST', body), second = await c.api('/api/notes', a, 'POST', body);
  assert.equal(first.status, 201); assert.equal(second.status, 200); assert.equal(first.data.id, second.data.id);
  assert.equal((await c.api('/api/notes', a, 'POST', { ...body, text: 'changed' })).status, 409);
  assert.equal((await c.api('/api/state', a)).data.notes.length, 1);
});
test('revocation during a slow organization request blocks both metadata writes', async t => {
  const c = await fixture(t), file = await c.upload('race.txt', Buffer.from('race'));
  for (const spec of [{ route: '/api/collections', method: 'POST', body: { name: 'late' } }, { route: '/api/files/' + file.id, method: 'PATCH', body: { favorite: true } }]) {
    const credential = await c.pair('slow'), device = (await c.api('/api/state', credential)).data.device;
    const body = JSON.stringify(spec.body); let request;
    const finished = new Promise((resolve, reject) => {
      request = http.request(c.origin + spec.route, { method: spec.method, headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); request.on('error', reject); request.write(body.slice(0, 1));
    });
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal((await c.api('/api/devices/' + device.id + '/revoke', c.app.hostToken, 'POST', {})).status, 200);
    request.end(body.slice(1)); assert.equal(await finished, 401);
    const state = JSON.parse(await fs.readFile(path.join(c.dir, 'state.json'), 'utf8')); assert.equal(state.preferences?.[device.id], undefined);
  }
});
