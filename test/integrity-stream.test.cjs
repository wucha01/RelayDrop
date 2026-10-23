'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRelayServer } = require('../server.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const block of createReadStream(file)) hash.update(block);
  return hash.digest('hex');
}

test('64 MiB file survives host restart, ranged download and final saved-file readback', async () => {
  const workRoot = path.resolve(process.env.RELAY_TEST_DIR || path.join(os.tmpdir(), 'relaydrop-tests'));
  await fs.mkdir(workRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(workRoot, 'integrity-stream-'));
  const dataDir = path.join(directory, 'relay-data');
  const source = path.join(directory, 'original.bin');
  const saved = path.join(directory, 'saved.bin');
  const bytes = 64 * 1024 * 1024 + 31;
  let app, base, credential;
  async function start() {
    app = createRelayServer({ dataDir, host: '127.0.0.1', port: 0, discovery: false });
    base = 'http://127.0.0.1:' + await app.listen();
    if (credential) assert.equal(app.hostToken, credential);
    credential = app.hostToken;
  }
  async function req(route, method = 'GET', body, headers = {}) {
    return fetch(base + route, { method, body, headers: { Authorization: 'Bearer ' + credential, ...headers } });
  }
  async function json(route, method, body) {
    const response = await req(route, method, body === undefined ? undefined : JSON.stringify(body), { 'Content-Type': 'application/json' });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  try {
    const writer = await fs.open(source, 'wx');
    try {
      for (let offset = 0; offset < bytes;) {
        const block = crypto.randomBytes(Math.min(1024 * 1024, bytes - offset));
        await writer.writeFile(block); offset += block.length;
      }
      await writer.sync();
    } finally { await writer.close(); }
    const expected = await fileHash(source);
    await start();
    let transfer = await json('/api/transfers', 'POST', { name: '原图与视频-字节验证📦.bin', size: bytes, fingerprint: expected });
    const input = await fs.open(source, 'r');
    let offset = 0, restarted = false;
    try {
      while (offset < bytes) {
        const block = Buffer.alloc(Math.min(transfer.chunkSize, bytes - offset));
        assert.equal((await input.read(block, 0, block.length, offset)).bytesRead, block.length);
        const response = await req('/api/transfers/' + transfer.id, 'PUT', block, { 'X-Offset': String(offset), 'X-Chunk-SHA256': digest(block), 'Content-Type': 'application/octet-stream' });
        assert.equal(response.status, 200);
        offset += block.length;
        assert.equal((await response.json()).offset, offset);
        if (!restarted && offset >= 17 * 1024 * 1024) {
          await app.close(); app = null; await start();
          const resumed = await json('/api/transfers', 'POST', { name: '原图与视频-字节验证📦.bin', size: bytes, fingerprint: expected });
          assert.equal(resumed.id, transfer.id); assert.equal(resumed.offset, offset);
          transfer = resumed; restarted = true;
        }
      }
    } finally { await input.close(); }
    const completed = await json('/api/transfers/' + transfer.id + '/complete', 'POST');
    assert.equal(completed.sha256, expected); assert.equal(completed.size, bytes);
    const ticket = await json('/api/files/' + completed.id + '/ticket', 'POST');
    const output = await fs.open(saved, 'wx');
    try {
      const split = 13 * 1024 * 1024 + 19;
      for (const [begin, end] of [[0, split - 1], [split, bytes - 1]]) {
        const response = await req(ticket.url, 'GET', undefined, { Range: 'bytes=' + begin + '-' + end });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-range'), 'bytes ' + begin + '-' + end + '/' + bytes);
        assert.equal(response.headers.get('etag'), '"' + expected + '"');
        let received = 0;
        for await (const block of response.body) { await output.writeFile(block); received += block.length; }
        assert.equal(received, end - begin + 1);
      }
      await output.sync();
    } finally { await output.close(); }
    assert.equal((await fs.stat(saved)).size, bytes);
    assert.equal(await fileHash(saved), expected);
    assert.equal(await fileHash(source), expected);
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(path.resolve(directory)), workRoot);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
