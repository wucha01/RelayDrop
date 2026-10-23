'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const { createRelayServer } = require('../server.cjs');
const pool = require('../file-pool.cjs');
const folderTools = require('../shared-folders.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAUACgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAMG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8ArgLMMAAAAAAAAAA//9k=', 'base64');
async function fixture(t, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'relay15-pool-'));
  let app, origin;
  const start = async () => { app = createRelayServer({ dataDir: directory, host: '127.0.0.1', port: 0, discovery: false, ...options }); origin = `http://127.0.0.1:${await app.listen()}`; };
  await start();
  t.after(async () => { await app.close(); assert.equal(path.dirname(directory), os.tmpdir()); await fsp.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const c = { directory, get app() { return app; }, get origin() { return origin; }, async restart() { await app.close(); await start(); } };
  c.req = async (route, { token = app.hostToken, method = 'GET', json, body, headers = {} } = {}) => {
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const response = await fetch(origin + route, { method, headers, body }); const bytes = Buffer.from(await response.arrayBuffer()); let data;
    try { data = JSON.parse(bytes); } catch {}
    return { status: response.status, headers: response.headers, bytes, data };
  };
  c.state = async token => (await c.req('/api/state', { token })).data;
  c.pair = async name => (await c.req('/api/pair', { method: 'POST', token: null, json: { name, code: (await c.state()).pairing.code } })).data;
  c.folder = async (parts, token, parentId = null) => { const r = await c.req('/api/folders/ensure', { method: 'POST', token, json: { parentId, path: parts } }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
  c.begin = async (name, bytes, token, targetId = null, folderId = null) => c.req('/api/transfers', { method: 'POST', token, json: { name, size: bytes.length, fingerprint: sha(bytes), targetId, folderId } });
  c.upload = async (name, bytes, token, targetId = null, folderId = null) => {
    const started = await c.begin(name, bytes, token, targetId, folderId); assert.equal(started.status, 201, JSON.stringify(started.data));
    const id = started.data.id;
    for (let offset = 0; offset < bytes.length; offset += started.data.chunkSize) {
      const block = bytes.subarray(offset, offset + started.data.chunkSize), r = await c.req('/api/transfers/' + id, { token, method: 'PUT', body: block, headers: { 'X-Offset': String(offset), 'X-Chunk-SHA256': sha(block) } }); assert.equal(r.status, 200);
    }
    const done = await c.req(`/api/transfers/${id}/complete`, { token, method: 'POST', json: {} }); assert.equal(done.status, 200, JSON.stringify(done.data)); return done.data;
  };
  c.duplicates = (bytes, token, targetId = null, folderId = null) => c.req('/api/files/duplicates', { token, method: 'POST', json: { sha256: sha(bytes), size: bytes.length, targetId, folderId } });
  return c;
}

test('shared tree: phone, tablet and host share folder identity while personal collections stay private', async t => {
  const c = await fixture(t), a = await c.pair('手机'), b = await c.pair('平板');
  const tree = await c.folder(['高数资料', '第一章'], a.token), empty = await c.folder(['空目录'], a.token, tree.folderId);
  const file = await c.upload('讲义.txt', Buffer.from('完整资料'), a.token, null, tree.folderId);
  await c.req('/api/collections', { token: a.token, method: 'POST', json: { name: '私人收藏' } });
  for (const credential of [c.app.hostToken, a.token, b.token]) { const state = await c.state(credential); assert.equal(state.folders.length, 3); assert.equal(state.files.find(f => f.id === file.id).folderId, tree.folderId); }
  assert.deepEqual((await c.state(b.token)).collections, []);
  await c.restart(); const state = await c.state(a.token); assert.ok(state.folders.some(f => f.id === empty.folderId)); assert.equal(state.files[0].sha256, file.sha256);
  const repeated = await c.folder(['高数资料', '第一章'], b.token); assert.equal(repeated.folderId, tree.folderId); assert.equal((await c.state()).folders.length, 3);
});

test('shared tree: path validation, NFC and casefold uniqueness, depth and count limits are atomic', async t => {
  const c = await fixture(t);
  for (const bad of ['..', '.', '../escape', 'a\\b', 'CON.txt', 'LPT1', ' bad', 'bad ', 'bad.', 'bad:stream', 'bad\0', 'x'.repeat(129)]) {
    const r = await c.req('/api/folders/ensure', { method: 'POST', json: { path: ['never-created', bad] } }); assert.equal(r.status, 400, bad); assert.equal((await c.state()).folders.length, 0);
  }
  const first = await c.folder(['Caf\u0065\u0301']), second = await c.folder(['CAFÉ']); assert.equal(first.folderId, second.folderId);
  const deep = await c.folder(Array.from({ length: 32 }, (_, i) => '层' + i));
  assert.equal((await c.req('/api/folders/ensure', { method: 'POST', json: { parentId: deep.folderId, path: ['too-deep'] } })).status, 400);
  const pure = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), parentId: null, name: String(i), createdBy: 'host' }));
  assert.throws(() => folderTools.ensure(pure, null, ['one-more'], { id: 'host' }), { code: 'FOLDER_LIMIT' }); assert.equal(pure.length, 5000);
});

test('shared tree: only creators or host mutate folders; cycles, duplicate siblings and nonempty removal fail', async t => {
  const c = await fixture(t), a = await c.pair('creator'), b = await c.pair('reader'), tree = await c.folder(['parent', 'child'], a.token);
  const parent = tree.folders[0].id, child = tree.folderId;
  assert.equal((await c.req('/api/folders/' + parent, { token: b.token, method: 'PATCH', json: { name: 'changed' } })).status, 403);
  assert.equal((await c.req('/api/folders/' + parent, { token: a.token, method: 'PATCH', json: { parentId: child } })).status, 400);
  assert.equal((await c.req('/api/folders/' + parent, { method: 'DELETE' })).status, 409);
  const other = await c.folder(['other']);
  assert.equal((await c.req('/api/folders/' + parent, { method: 'PATCH', json: { name: 'OTHER' } })).status, 409);
  assert.equal((await c.req('/api/folders/' + child, { token: a.token, method: 'PATCH', json: { parentId: other.folderId, name: 'moved' } })).status, 200);
  assert.equal((await c.req('/api/folders/' + parent, { token: a.token, method: 'DELETE' })).status, 200);
});

test('shared tree: folder scope travels with resume, file move, trash and restore; directed files remain root-only', async t => {
  const c = await fixture(t), a = await c.pair('sender'), b = await c.pair('other'), folder = await c.folder(['资料'], a.token), bytes = Buffer.from('same payload');
  const first = await c.begin('resume.txt', bytes, a.token, null, folder.folderId), repeat = await c.begin('resume.txt', bytes, a.token, null, folder.folderId), elsewhere = await c.begin('resume.txt', bytes, a.token);
  assert.equal(repeat.data.id, first.data.id); assert.notEqual(elsewhere.data.id, first.data.id);
  assert.equal((await c.begin('private.txt', bytes, a.token, b.device.id, folder.folderId)).status, 400);
  assert.equal((await c.req('/api/folders/' + folder.folderId, { token: a.token, method: 'DELETE' })).status, 409);
  const file = await c.upload('lesson.txt', bytes, a.token);
  assert.equal((await c.req(`/api/files/${file.id}/location`, { token: b.token, method: 'PATCH', json: { folderId: folder.folderId } })).status, 403);
  assert.equal((await c.req(`/api/files/${file.id}/location`, { token: a.token, method: 'PATCH', json: { folderId: folder.folderId, name: '新名.txt' } })).status, 200);
  await c.req('/api/files/' + file.id, { token: a.token, method: 'DELETE' }); await c.req(`/api/files/${file.id}/restore`, { token: a.token, method: 'POST', json: {} });
  const restored = (await c.state(a.token)).files.find(f => f.id === file.id); assert.equal(restored.folderId, folder.folderId); assert.equal(restored.name, '新名.txt'); assert.equal(restored.sha256, sha(bytes));
});

test('duplicate detection: only exact visible destination scope is returned; hidden private metadata never leaks', async t => {
  const c = await fixture(t), a = await c.pair('sender'), b = await c.pair('receiver'), stranger = await c.pair('stranger'), bytes = Buffer.from('duplicate-content');
  const folder = await c.folder(['shared']);
  const privateFile = await c.upload('private-name.txt', bytes, a.token, b.device.id), shared = await c.upload('public-name.txt', bytes, a.token), nested = await c.upload('nested.txt', bytes, a.token, null, folder.folderId);
  assert.deepEqual((await c.duplicates(bytes, stranger.token, b.device.id)).data.matches, []);
  assert.deepEqual((await c.duplicates(bytes, a.token, b.device.id)).data.matches.map(f => f.id), [privateFile.id]);
  assert.deepEqual((await c.duplicates(bytes, stranger.token)).data.matches.map(f => f.id), [shared.id]);
  assert.deepEqual((await c.duplicates(bytes, stranger.token, null, folder.folderId)).data.matches.map(f => f.id), [nested.id]);
  assert.equal((await c.state(stranger.token)).storage.dataDir, undefined); assert.equal((await c.state()).storage.dataDir, c.directory);
  await c.req('/api/files/' + shared.id, { token: a.token, method: 'DELETE' }); assert.deepEqual((await c.duplicates(bytes, stranger.token)).data.matches, []);
});

test('duplicate detection: stale or damaged originals are never offered as skipped-upload matches', async t => {
  const c = await fixture(t), bytes = Buffer.from('original'), file = await c.upload('original.txt', bytes);
  assert.equal((await c.duplicates(bytes)).data.matches.length, 1);
  const location = path.join(c.directory, 'files', file.id), before = await fsp.stat(location);
  await fsp.writeFile(location, Buffer.from('modified')); await fsp.utimes(location, before.atime, before.mtime);
  assert.deepEqual((await c.duplicates(bytes)).data.matches, []);
  await fsp.unlink(location); assert.deepEqual((await c.duplicates(bytes)).data.matches, []);
});

test('duplicate detection: revocation during shared source verification blocks only the revoked caller', async t => {
  const c = await fixture(t), a = await c.pair('revoked'), b = await c.pair('retained'), bytes = Buffer.from('shared-content'), file = await c.upload('shared.txt', bytes);
  const location = path.join(c.directory, 'files', file.id), original = fs.createReadStream;
  let release, entered; const gate = new Promise(resolve => release = resolve), began = new Promise(resolve => entered = resolve);
  fs.createReadStream = function (target, ...args) { const stream = original.call(this, target, ...args); if (path.resolve(target) !== location) return stream; return (async function* () { entered(); await gate; yield* stream; })(); };
  try {
    const first = c.duplicates(bytes, a.token), second = c.duplicates(bytes, b.token); await began;
    await c.req(`/api/devices/${a.device.id}/revoke`, { method: 'POST', json: {} }); release();
    assert.equal((await first).status, 401); assert.equal((await second).data.matches[0].id, file.id);
  } finally { release(); fs.createReadStream = original; }
});

test('preview upgrade: image, PDF and video use separate source limits and detail/page cache keys', async t => {
  assert.equal(pool.previewKind({ name: 'big.jpg', size: 33 * 1024 ** 2 }), null);
  assert.equal(pool.previewKind({ name: 'big.pdf', size: 128 * 1024 ** 2 }), 'pdf');
  assert.equal(pool.previewKind({ name: 'big.pdf', size: 128 * 1024 ** 2 + 1 }), null);
  assert.equal(pool.previewKind({ name: 'big.mp4', size: 512 * 1024 ** 2 }), 'video');
  assert.equal(pool.previewKind({ name: 'big.mp4', size: 512 * 1024 ** 2 + 1 }), null);
  const calls = [], c = await fixture(t, { createThumbnail: async (_path, _file, _signal, variant) => { calls.push(variant); return { bytes: jpeg, pageCount: 3 }; } });
  const file = await c.upload('pages.pdf', Buffer.from('%PDF-test-fixture'));
  const thumb = await c.req(`/api/files/${file.id}/preview`), page2 = await c.req(`/api/files/${file.id}/preview?mode=detail&page=2`);
  assert.equal(thumb.status, 200); assert.equal(page2.status, 200); assert.equal(page2.headers.get('x-preview-pages'), '3'); assert.equal(page2.headers.get('x-preview-page'), '2');
  await c.req(`/api/files/${file.id}/preview?mode=detail&page=2`); assert.equal(calls.length, 2);
  assert.deepEqual(calls, [{ mode: 'thumbnail', page: 1, edge: 320 }, { mode: 'detail', page: 2, edge: 1280 }]);
  assert.equal((await c.req(`/api/files/${file.id}/preview?page=1001`)).status, 400); assert.equal((await c.req(`/api/files/${file.id}/preview?mode=detail&page=4`)).status, 415);
});

test('preview upgrade: corrupt source is blocked before decoding; malformed output and oversize detail are rejected', async t => {
  let calls = 0; const c = await fixture(t, { createThumbnail: async () => { calls++; return { bytes: Buffer.concat([jpeg, Buffer.alloc(1024 ** 2)]), pageCount: 1 }; } });
  const file = await c.upload('photo.jpg', jpeg);
  assert.equal((await c.req(`/api/files/${file.id}/preview?mode=detail`)).status, 415); assert.equal(calls, 1);
  await fsp.writeFile(path.join(c.directory, 'files', file.id), Buffer.alloc(jpeg.length));
  assert.equal((await c.req(`/api/files/${file.id}/preview?mode=detail`)).status, 422); assert.equal(calls, 1);
});

test('preview upgrade: renaming the source during decoding invalidates the prior format result', async t => {
  let entered, release; const began = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const c = await fixture(t, { createThumbnail: async () => { entered(); await gate; return { bytes: jpeg, pageCount: 2 }; } });
  const file = await c.upload('document.pdf', Buffer.from('%PDF-fixture')), request = c.req(`/api/files/${file.id}/preview?mode=detail&page=1`);
  await began; await c.req(`/api/files/${file.id}/location`, { method: 'PATCH', json: { folderId: null, name: 'renamed.jpg' } }); release();
  assert.equal((await request).status, 404);
});

test('preview upgrade: closing the last viewer cancels decoding without changing the original', async t => {
  let entered, cancelled; const began = new Promise(r => entered = r), aborted = new Promise(r => cancelled = r);
  const c = await fixture(t, { createThumbnail: async (_path, _file, signal) => { entered(); await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { cancelled(); reject(new Error('cancelled')); }, { once: true }); }); } });
  const file = await c.upload('photo.jpg', jpeg), controller = new AbortController();
  const request = fetch(c.origin + `/api/files/${file.id}/preview`, { headers: { Authorization: 'Bearer ' + c.app.hostToken }, signal: controller.signal }).catch(() => {});
  await began; controller.abort(); await request;
  let timer; try { await Promise.race([aborted, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('decode was not cancelled')), 3000); })]); } finally { clearTimeout(timer); }
  assert.deepEqual(await fsp.readFile(path.join(c.directory, 'files', file.id)), jpeg);
});

test('media tickets: explicit purpose, byte ranges, own-ticket disposal and device revocation preserve authorization', async t => {
  const c = await fixture(t), a = await c.pair('viewer'), b = await c.pair('other'), bytes = Buffer.from('0123456789'), file = await c.upload('clip.mp4', bytes);
  const download = (await c.req(`/api/files/${file.id}/ticket`, { token: a.token, method: 'POST', json: {} })).data;
  assert.equal((await c.req(download.url.replace('/content?', '/media?'), { token: null })).status, 401);
  const create = async () => (await c.req(`/api/files/${file.id}/ticket`, { token: a.token, method: 'POST', json: { purpose: 'media' } })).data;
  let ticket = await create(); const range = await c.req(ticket.url, { token: null, headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206); assert.equal(range.bytes.toString(), '2345'); assert.equal(range.headers.get('content-type'), 'video/mp4'); assert.equal(range.headers.get('content-disposition'), 'inline');
  assert.equal((await c.req(ticket.url.replace('/media?', '/content?'), { token: null })).status, 401);
  assert.equal((await c.req(`/api/files/${file.id}/ticket`, { token: b.token, method: 'DELETE', json: { ticket: ticket.ticket } })).status, 403);
  assert.equal((await c.req(`/api/files/${file.id}/ticket`, { token: a.token, method: 'DELETE', json: { ticket: ticket.ticket } })).status, 200);
  assert.equal((await c.req(ticket.url, { token: null })).status, 401);
  ticket = await create(); await c.req(`/api/devices/${a.device.id}/revoke`, { method: 'POST', json: {} }); assert.equal((await c.req(ticket.url, { token: null })).status, 401);
});

test('media tickets: private files, active formats and corrupted originals cannot become inline previews', async t => {
  const c = await fixture(t), a = await c.pair('sender'), b = await c.pair('stranger'), bytes = Buffer.from('original');
  const privateFile = await c.upload('private.mp4', bytes, a.token, 'host');
  assert.equal((await c.req(`/api/files/${privateFile.id}/ticket`, { token: b.token, method: 'POST', json: { purpose: 'media' } })).status, 404);
  for (const name of ['active.svg', 'script.html', 'source.pdf']) { const file = await c.upload(name, bytes); assert.equal((await c.req(`/api/files/${file.id}/ticket`, { method: 'POST', json: { purpose: 'media' } })).status, 415); }
  const file = await c.upload('movie.mp4', bytes), ticket = (await c.req(`/api/files/${file.id}/ticket`, { method: 'POST', json: { purpose: 'media' } })).data;
  await fsp.writeFile(path.join(c.directory, 'files', file.id), Buffer.from('modified'));
  assert.equal((await c.req(ticket.url, { token: null })).status, 422);
});

test('shared tree storage fault: failed ensure cannot leak uncommitted folders or persist later', async t => {
  const c = await fixture(t), original = fs.renameSync; let injected = false;
  fs.renameSync = function (from, to) { if (!injected && path.resolve(to) === path.join(c.directory, 'state.json')) { injected = true; throw Object.assign(new Error('injected'), { code: 'ENOSPC' }); } return original.apply(this, arguments); };
  let result; try { result = await c.req('/api/folders/ensure', { method: 'POST', json: { path: ['not-committed'] } }); } finally { fs.renameSync = original; }
  assert.equal(injected, true); assert.equal(result.status, 507); assert.deepEqual((await c.state()).folders, []);
  await c.folder(['accepted']); const state = JSON.parse(await fsp.readFile(path.join(c.directory, 'state.json'), 'utf8')); assert.deepEqual(state.folders.map(f => f.name), ['accepted']);
});

test('shared tree revocation: a slow request cannot create directories after device permission is revoked', async t => {
  const c = await fixture(t), a = await c.pair('late'), body = JSON.stringify({ path: ['late-folder'] }); let request;
  const response = new Promise((resolve, reject) => { request = http.request(c.origin + '/api/folders/ensure', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); request.on('error', reject); request.write(body.slice(0, 1)); });
  await new Promise(resolve => setTimeout(resolve, 40)); await c.req(`/api/devices/${a.device.id}/revoke`, { method: 'POST', json: {} }); request.end(body.slice(1));
  assert.equal(await response, 401); assert.deepEqual((await c.state()).folders, []);
});
