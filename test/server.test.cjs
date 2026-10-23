'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const { createRelayServer } = require('../server.cjs');

const workRoot = path.resolve(process.env.RELAY_TEST_DIR || path.join(os.tmpdir(), 'relaydrop-tests'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fingerprint(data, modified = 1710000000000) {
  return hash(data);
}
async function fixture(t, options = {}) {
  await fs.mkdir(workRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(workRoot, 'relay-'));
  const dataDir = path.join(root, 'data');
  let app = createRelayServer({ dataDir, host: '127.0.0.1', port: 0, chunkSize: 65536, maxFileSize: 64 * 1024 * 1024, ...options });
  let port = await app.listen();
  const ctx = {
    root, dataDir,
    async rawHost(host) {
      return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port, path: '/api/state', headers: { Host: host, Authorization: 'Bearer ' + app.hostToken } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject); request.end();
      });
    },
    get app() { return app; },
    startPartialJson(route, json, token) {
      const body = Buffer.from(JSON.stringify(json));
      let request;
      const response = new Promise((resolve, reject) => {
        request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': body.length } }, result => {
          result.resume(); result.on('end', () => resolve(result.statusCode));
        });
        request.on('error', reject); request.write(body.subarray(0, 1));
      });
      return { finish: () => { request.end(body.subarray(1)); return response; } };
    },
    get hostToken() { return app.hostToken; },
    async restart() {
      await app.close();
      app = createRelayServer({ dataDir, host: '127.0.0.1', port: 0, chunkSize: 65536, maxFileSize: 64 * 1024 * 1024, ...options });
      port = await app.listen();
    },
    async req(route, { token = app.hostToken, method = 'GET', json, body, headers = {} } = {}) {
      const h = { ...headers };
      if (token) h.Authorization = 'Bearer ' + token;
      if (json !== undefined) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
      const res = await fetch('http://127.0.0.1:' + port + route, { method, body, headers: h });
      const bytes = Buffer.from(await res.arrayBuffer());
      let data;
      try { data = JSON.parse(bytes.toString()); } catch { data = null; }
      return { status: res.status, headers: res.headers, bytes, data };
    },
    async state(token) {
      const res = await this.req('/api/state', { token });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      return res.data;
    },
    async pair(name) {
      const state = await this.state();
      const res = await this.req('/api/pair', { token: null, method: 'POST', json: { code: state.pairing.code, name } });
      assert.ok([200, 201].includes(res.status), JSON.stringify(res.data));
      return res.data;
    },
    async begin(data, name, token, targetId = null) {
      const res = await this.req('/api/transfers', { token, method: 'POST', json: { name, size: data.length, lastModified: 1710000000000, fingerprint: fingerprint(data), targetId } });
      assert.ok([200, 201].includes(res.status), JSON.stringify(res.data));
      return res.data;
    },
    async put(id, chunk, offset, token, checksum = hash(chunk)) {
      return this.req('/api/transfers/' + id, { token, method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream', 'X-Offset': String(offset), 'X-Chunk-SHA256': checksum } });
    },
    async upload(data, name = 'test.bin', token, targetId = null) {
      const tx = await this.begin(data, name, token, targetId);
      for (let offset = tx.offset; offset < data.length;) {
        const chunk = data.subarray(offset, offset + tx.chunkSize);
        const res = await this.put(tx.id, chunk, offset, token);
        assert.equal(res.status, 200, JSON.stringify(res.data));
        assert.equal(res.data.offset, offset + chunk.length);
        offset = res.data.offset;
      }
      const completed = await this.req('/api/transfers/' + tx.id + '/complete', { token, method: 'POST' });
      assert.ok([200, 201].includes(completed.status), JSON.stringify(completed.data));
      assert.equal(completed.data.sha256, hash(data));
      assert.equal(completed.data.size, data.length);
      return { file: completed.data, tx };
    },
    async ticket(fileId, token) {
      const res = await this.req('/api/files/' + fileId + '/ticket', { token, method: 'POST' });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.ok(res.data.url.includes('ticket='));
      return res.data.url;
    }
  };
  t.after(async () => { await app.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(workRoot)); await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  return ctx;
}
const denied = status => assert.ok([401, 403, 404].includes(status), 'expected access denial, got ' + status);

test('pairing, host-only controls, credential secrecy, and hostile Origin/Host', async t => {
  const c = await fixture(t);
  assert.equal((await c.req('/api/health', { token: null })).data.ok, true);
  denied((await c.req('/api/state', { token: null })).status);
  denied((await c.req('/api/state', { token: 'invalid-token' })).status);
  const guest = await c.pair('手机 测试📱');
  assert.equal(guest.device.role, 'guest');
  const state = await c.state(guest.token);
  assert.equal(state.device.name, '手机 测试📱');
  assert.equal(state.pairing, null);
  assert.ok(!JSON.stringify(state).includes(guest.token));
  assert.ok(!JSON.stringify(state).includes(c.hostToken));
  denied((await c.req('/api/pairing/rotate', { token: guest.token, method: 'POST' })).status);
  denied((await c.req('/api/devices/host/revoke', { token: guest.token, method: 'POST' })).status);
  const oldCode = (await c.state()).pairing.code;
  const rotated = await c.req('/api/pairing/rotate', { method: 'POST' });
  assert.equal(rotated.status, 200);
  assert.match(rotated.data.code, /^\d{6}$/);
  if (oldCode !== rotated.data.code) denied((await c.req('/api/pair', { token: null, method: 'POST', json: { code: oldCode, name: 'old' } })).status);
  assert.equal((await c.req('/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.ok([400, 403].includes(await c.rawHost('evil.example')));
});

test('batch files: empty, Unicode names, chunk boundaries, duplicate names, and exact content', async t => {
  const c = await fixture(t);
  const guest = await c.pair('发送端');
  const cases = [
    ['空文件.txt', Buffer.alloc(0)],
    ['课程资料 中文📚.txt', Buffer.from('你好\nHello\n🙂\u0000END')],
    ['same.bin', crypto.randomBytes(65536)],
    ['same.bin', crypto.randomBytes(65537)],
    ['three-chunks.bin', crypto.randomBytes(2 * 65536 + 17)]
  ];
  const ids = new Set();
  for (const [name, data] of cases) {
    const { file, tx } = await c.upload(data, name, guest.token);
    assert.ok(!ids.has(file.id)); ids.add(file.id);
    assert.equal(file.name, name);
    const again = await c.req('/api/transfers/' + tx.id + '/complete', { token: guest.token, method: 'POST' });
    assert.equal(again.status, 200);
    assert.equal(again.data.id, file.id);
    const url = await c.ticket(file.id, guest.token);
    const result = await c.req(url, { token: null });
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, data);
    assert.match(result.headers.get('content-disposition'), /^attachment/i);
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(result.headers.get('etag'));
  }
  assert.equal((await c.state()).files.length, cases.length);
});

test('chunk checksum, offsets, duplicate concurrent writes, and incomplete completion are safe', async t => {
  const c = await fixture(t);
  const data = crypto.randomBytes(65536 + 23);
  const tx = await c.begin(data, 'chunks.bin');
  const first = data.subarray(0, 65536);
  assert.equal((await c.put(tx.id, first, 0, undefined, '0'.repeat(64))).status, 422);
  assert.equal((await c.req('/api/transfers/' + tx.id)).data.offset, 0);
  const wrong = await c.put(tx.id, first, 1);
  assert.equal(wrong.status, 409); assert.equal(wrong.data.offset, 0);
  const concurrent = await Promise.all([c.put(tx.id, first, 0), c.put(tx.id, first, 0)]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  assert.equal((await c.req('/api/transfers/' + tx.id)).data.offset, first.length);
  const incomplete = await c.req('/api/transfers/' + tx.id + '/complete', { method: 'POST' });
  assert.ok([400, 409, 422].includes(incomplete.status));
  assert.equal((await c.state()).files.length, 0);
  const overflow = await c.put(tx.id, Buffer.alloc(24), first.length);
  assert.ok([400, 409, 413, 422].includes(overflow.status));
  assert.equal((await c.req('/api/transfers/' + tx.id)).data.offset, first.length);
  assert.equal((await c.put(tx.id, data.subarray(first.length), first.length)).status, 200);
  const final = await c.req('/api/transfers/' + tx.id + '/complete', { method: 'POST' });
  assert.equal(final.status, 200); assert.equal(final.data.sha256, hash(data));
});

test('target and ownership isolation applies to files, transfers, notes and destructive operations', async t => {
  const c = await fixture(t);
  const a = await c.pair('A'); const b = await c.pair('B'); const outsider = await c.pair('C');
  const { file } = await c.upload(Buffer.from('private'), 'private.txt', a.token, b.device.id);
  const pending = await c.begin(Buffer.from('pending'), 'pending.txt', a.token, b.device.id);
  const note = await c.req('/api/notes', { token: a.token, method: 'POST', json: { text: 'private note', targetId: b.device.id } });
  assert.ok([200, 201].includes(note.status));
  for (const token of [a.token, b.token, c.hostToken]) {
    const state = await c.state(token);
    assert.ok(state.files.some(f => f.id === file.id));
    assert.ok(state.notes.some(n => n.id === note.data.id));
  }
  const hidden = await c.state(outsider.token);
  assert.ok(!hidden.files.some(f => f.id === file.id));
  assert.ok(!hidden.notes.some(n => n.id === note.data.id));
  assert.ok(!hidden.transfers.some(tx => tx.id === pending.id));
  denied((await c.req('/api/transfers/' + pending.id, { token: b.token })).status);
  denied((await c.req('/api/transfers/' + pending.id, { token: outsider.token, method: 'DELETE' })).status);
  denied((await c.req('/api/files/' + file.id + '/ticket', { token: outsider.token, method: 'POST' })).status);
  denied((await c.req('/api/files/' + file.id, { token: b.token, method: 'DELETE' })).status);
  denied((await c.req('/api/notes/' + note.data.id, { token: b.token, method: 'DELETE' })).status);
  const shared = await c.upload(Buffer.from('shared'), 'shared.txt', a.token);
  assert.ok((await c.state(outsider.token)).files.some(f => f.id === shared.file.id));
  assert.equal((await c.req('/api/transfers/' + pending.id, { token: a.token, method: 'DELETE' })).status, 200);
  assert.equal((await c.req('/api/files/' + file.id, { token: a.token, method: 'DELETE' })).status, 200);
  assert.equal((await c.req('/api/notes/' + note.data.id, { token: a.token, method: 'DELETE' })).status, 200);
});

test('durable offsets and device credentials survive server restart; resume matches the original transfer', async t => {
  const c = await fixture(t);
  const guest = await c.pair('可恢复手机');
  const data = crypto.randomBytes(65536 + 37);
  const tx = await c.begin(data, 'resume.bin', guest.token);
  assert.equal((await c.put(tx.id, data.subarray(0, 65536), 0, guest.token)).status, 200);
  const hostToken = c.hostToken;
  await c.restart();
  assert.equal(c.hostToken, hostToken);
  assert.equal((await c.state(guest.token)).device.id, guest.device.id);
  const resumed = await c.begin(data, 'resume.bin', guest.token);
  assert.equal(resumed.id, tx.id); assert.equal(resumed.offset, 65536);
  const final = await c.upload(data, 'resume.bin', guest.token);
  assert.equal(final.file.sha256, hash(data));
  assert.equal((await c.state()).files.length, 1);
});

test('ticketed downloads support ranges and stop working after device revocation', async t => {
  const c = await fixture(t);
  const guest = await c.pair('下载端');
  const data = Buffer.from('0123456789abcdefghij');
  const { file } = await c.upload(data, 'range.txt', undefined, guest.device.id);
  const url = await c.ticket(file.id, guest.token);
  for (const [range, expected] of [['bytes=0-3', data.subarray(0, 4)], ['bytes=10-', data.subarray(10)], ['bytes=-5', data.subarray(-5)], ['bytes=18-999', data.subarray(18)]]) {
    const result = await c.req(url, { token: null, headers: { Range: range } });
    assert.equal(result.status, 206, range);
    assert.deepEqual(result.bytes, expected);
    assert.match(result.headers.get('content-range'), /^bytes \d+-\d+\/20$/);
  }
  const invalid = await c.req(url, { token: null, headers: { Range: 'bytes=100-200' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */20');
  denied((await c.req('/api/files/' + file.id + '/content', { token: null })).status);
  const second = await c.upload(Buffer.from('other'), 'other.txt');
  denied((await c.req(url.replace(file.id, second.file.id), { token: null })).status);
  assert.equal((await c.req('/api/devices/' + guest.device.id + '/revoke', { method: 'POST' })).status, 200);
  denied((await c.req(url, { token: null })).status);
  denied((await c.req('/api/state', { token: guest.token })).status);
});

test('notes round-trip as literal text; limits and unknown targets are enforced', async t => {
  const c = await fixture(t);
  const text = '<script>alert(1)</script>\n你好🙂\nhttps://example.com/?x=<b>&a=1';
  const added = await c.req('/api/notes', { method: 'POST', json: { text, targetId: null } });
  assert.ok([200, 201].includes(added.status));
  assert.equal(added.data.text, text);
  assert.equal((await c.state()).notes.find(n => n.id === added.data.id).text, text);
  assert.ok([200, 201].includes((await c.req('/api/notes', { method: 'POST', json: { text: 'a'.repeat(20000) } })).status));
  assert.ok([400, 413, 422].includes((await c.req('/api/notes', { method: 'POST', json: { text: 'a'.repeat(20001) } })).status));
  assert.ok([400, 404, 422].includes((await c.req('/api/notes', { method: 'POST', json: { text: 'x', targetId: 'missing-device' } })).status));
});

test('static routes and adversarial file names cannot escape storage or expose application state', async t => {
  const c = await fixture(t);
  for (const route of ['/CONTRACT.md', '/server.cjs', '/data/launch.json', '/%2e%2e%2fCONTRACT.md', '/..%5cCONTRACT.md']) {
    const result = await c.req(route, { token: null });
    assert.ok([400, 403, 404].includes(result.status), route + ': ' + result.status);
    assert.ok(!result.bytes.includes(Buffer.from(c.hostToken)));
  }
  const data = Buffer.from('path test');
  const res = await c.req('/api/transfers', { method: 'POST', json: { name: '../escape.txt', size: data.length, lastModified: 1710000000000, fingerprint: fingerprint(data), targetId: null } });
  if ([200, 201].includes(res.status)) {
    assert.equal((await c.put(res.data.id, data, 0)).status, 200);
    assert.equal((await c.req('/api/transfers/' + res.data.id + '/complete', { method: 'POST' })).status, 200);
  } else assert.ok([400, 422].includes(res.status));
  await assert.rejects(fs.access(path.join(c.root, 'escape.txt')));
  const over = await c.req('/api/transfers', { method: 'POST', json: { name: 'too-big.bin', size: 65 * 1024 * 1024, lastModified: 0, fingerprint: 'a'.repeat(64), targetId: null } });
  assert.ok([400, 413, 422].includes(over.status));
});

test('pairing brute force is rate limited', async t => {
  const c = await fixture(t);
  const code = (await c.state()).pairing.code;
  const wrongCode = code === '000000' ? '111111' : '000000';
  let limited = false;
  for (let i = 0; i < 40; i++) {
    const result = await c.req('/api/pair', { token: null, method: 'POST', json: { code: wrongCode, name: 'attempt' } });
    if (result.status === 429) { limited = true; break; }
    assert.ok([400, 401, 403].includes(result.status));
  }
  assert.ok(limited, '40 failed pairing attempts must trigger a rate limit');
});



test('revocation during an in-flight request prevents a late note mutation', async t => {
  const c = await fixture(t);
  const guest = await c.pair('慢请求设备');
  const partial = c.startPartialJson('/api/notes', { text: 'must not be stored after revoke', targetId: null }, guest.token);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await c.req('/api/devices/' + guest.device.id + '/revoke', { method: 'POST' })).status, 200);
  denied(await partial.finish());
  assert.equal((await c.state()).notes.length, 0);
});
