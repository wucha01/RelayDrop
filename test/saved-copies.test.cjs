'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createSavedCopies } = require('../desktop/saved-copies.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t, content = 'verified original') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relaydrop-saved-copies-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'user-original.txt'), bytes = Buffer.from(content);
  await fs.writeFile(destination, bytes);
  const file = { id: crypto.randomUUID(), name: 'user-original.txt', size: bytes.length, sha256: digest(bytes) };
  const state = { security: { serverId: crypto.randomUUID() }, device: { id: 'host' }, files: [file] };
  const copies = createSavedCopies(directory, { now: () => 1700000000000 });
  return { directory, destination, file, state, copies };
}
test('saved copies: verified receipt survives a fresh native store without exposing a path', async t => {
  const f = await fixture(t); await f.copies.record(f.state, f.file, f.destination);
  const reopened = createSavedCopies(f.directory), result = await reopened.list(f.state, [f.file.id, f.file.id]);
  assert.deepEqual(result, { files: [{ fileId: f.file.id, sha256: f.file.sha256, status: 'saved', savedAt: 1700000000000 }] });
  assert.equal(await reopened.resolve(f.state, f.file.id, f.file.sha256), f.destination);
});
test('saved copies: same id and hash are isolated across device and pool identity', async t => {
  const f = await fixture(t); await f.copies.record(f.state, f.file, f.destination);
  for (const state of [{ ...f.state, device: { id: crypto.randomUUID() } }, { ...f.state, security: { serverId: crypto.randomUUID() } }]) {
    assert.deepEqual(await f.copies.list(state, [f.file.id]), { files: [] });
    await assert.rejects(f.copies.resolve(state, f.file.id, f.file.sha256), /没有可用/);
  }
});
test('saved copies: revoked, removed or rehashed files cannot resolve historical receipts', async t => {
  const f = await fixture(t); await f.copies.record(f.state, f.file, f.destination);
  for (const state of [{ ...f.state, files: [] }, { ...f.state, files: [{ ...f.file, sha256: digest('new') }] }]) {
    assert.deepEqual(await f.copies.list(state, [f.file.id]), { files: [] });
    await assert.rejects(f.copies.resolve(state, f.file.id, f.file.sha256), /没有可用/);
  }
});
test('saved copies: same-size tampering with restored mtime is blocked on open', async t => {
  const f = await fixture(t); await f.copies.record(f.state, f.file, f.destination);
  const stat = await fs.stat(f.destination);
  await fs.writeFile(f.destination, Buffer.alloc(f.file.size, 'x')); await fs.utimes(f.destination, stat.atime, stat.mtime);
  await assert.rejects(f.copies.resolve(f.state, f.file.id, f.file.sha256), /副本已变化/);
  assert.equal((await f.copies.list(f.state, [f.file.id])).files[0].status, 'changed');
});
test('saved copies: fresh process hashes replacement bytes even if size is unchanged', async t => {
  const f = await fixture(t); await f.copies.record(f.state, f.file, f.destination);
  await fs.unlink(f.destination); await fs.writeFile(f.destination, Buffer.alloc(f.file.size, 'y'));
  assert.equal((await createSavedCopies(f.directory).list(f.state, [f.file.id])).files[0].status, 'changed');
});
test('saved copies: stable damaged bytes are not rehashed on every status poll, but opening always checks again', async t => {
  const f = await fixture(t); await f.copies.record(f.state, f.file, f.destination);
  await fs.writeFile(f.destination, Buffer.alloc(f.file.size, 'z'));
  const originalOpen = fs.open; let opens = 0;
  fs.open = async (...args) => { if (args[0] === f.destination && args[1] === 'r') opens++; return originalOpen(...args); };
  t.after(() => { fs.open = originalOpen; });
  assert.equal((await f.copies.list(f.state, [f.file.id])).files[0].status, 'changed');
  const firstOpens = opens; assert.equal(firstOpens, 1);
  assert.equal((await f.copies.list(f.state, [f.file.id])).files[0].status, 'changed'); assert.equal(opens, firstOpens);
  await assert.rejects(f.copies.resolve(f.state, f.file.id, f.file.sha256), /副本已变化/); assert.equal(opens, firstOpens + 1);
});
test('saved copies: moved and deleted files have an explicit missing state and are never recreated', async t => {
  const f = await fixture(t); await f.copies.record(f.state, f.file, f.destination);
  const moved = f.destination + '.moved'; await fs.rename(f.destination, moved);
  assert.equal((await f.copies.list(f.state, [f.file.id])).files[0].status, 'missing');
  await assert.rejects(f.copies.resolve(f.state, f.file.id, f.file.sha256), /移动或删除/);
  assert.equal(digest(await fs.readFile(moved)), f.file.sha256);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});
test('saved copies: directory junction replacement cannot redirect a previously saved receipt', async t => {
  const f = await fixture(t), originalDir = path.join(f.directory, 'chosen'), elsewhere = path.join(f.directory, 'elsewhere');
  await fs.mkdir(originalDir); await fs.mkdir(elsewhere);
  const destination = path.join(originalDir, 'same.txt'); await fs.copyFile(f.destination, destination); await fs.copyFile(f.destination, path.join(elsewhere, 'same.txt'));
  await f.copies.record(f.state, f.file, destination); await fs.rename(originalDir, originalDir + '.old');
  await fs.symlink(elsewhere, originalDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.copies.list(f.state, [f.file.id])).files[0].status, 'changed');
  await assert.rejects(f.copies.resolve(f.state, f.file.id, f.file.sha256), /副本已变化/);
});
test('saved copies: registration rejects unverified bytes and unauthorized file ids', async t => {
  const f = await fixture(t);
  await assert.rejects(f.copies.record({ ...f.state, files: [] }, f.file, f.destination), /不属于/);
  await fs.writeFile(f.destination, 'tampered'); await assert.rejects(f.copies.record(f.state, f.file, f.destination), /已变化/);
  assert.deepEqual(await f.copies.list(f.state, [f.file.id]), { files: [] });
});
test('saved copies: damaged persisted records fail closed without deleting originals or rewriting the journal', async t => {
  const f = await fixture(t), journal = path.join(f.directory, 'saved-copies.json');
  const malformed = '{"version":1,"records": [{"path":"arbitrary"}]}'; await fs.writeFile(journal, malformed);
  const copies = createSavedCopies(f.directory);
  await assert.rejects(copies.list(f.state, [f.file.id]), /保存记录无法读取/);
  await assert.rejects(copies.record(f.state, f.file, f.destination), /保存记录无法读取/);
  assert.equal(await fs.readFile(journal, 'utf8'), malformed); assert.equal(digest(await fs.readFile(f.destination)), f.file.sha256);
});
test('saved copies: request bounds and complete scope identity are enforced', async t => {
  const f = await fixture(t);
  await assert.rejects(f.copies.list(f.state, Array(201).fill(f.file.id)), /最多查询/);
  await assert.rejects(f.copies.list(f.state, ['../secret']), /有效文件/);
  await assert.rejects(f.copies.list({ ...f.state, device: null }, [f.file.id]), /设备身份/);
  await assert.rejects(f.copies.record(f.state, f.file, '../renderer-controlled'), /保存路径无效/);
  await assert.rejects(f.copies.resolve(f.state, f.file.id, 'bogus'), /请求无效/);
});
test('saved copies: concurrent native completions are serialized without losing either receipt', async t => {
  const f = await fixture(t), second = { ...f.file, id: crypto.randomUUID() };
  const state = { ...f.state, files: [f.file, second] };
  await Promise.all([f.copies.record(state, f.file, f.destination), f.copies.record(state, second, f.destination)]);
  assert.equal((await createSavedCopies(f.directory).list(state, state.files.map(file => file.id))).files.length, 2);
});
test('saved copies: re-saving a file replaces its own receipt and leaves the earlier copy untouched', async t => {
  const f = await fixture(t), second = path.join(f.directory, 'second.txt'); await f.copies.record(f.state, f.file, f.destination);
  await fs.copyFile(f.destination, second); await f.copies.record(f.state, f.file, second);
  assert.equal(await createSavedCopies(f.directory).resolve(f.state, f.file.id, f.file.sha256), second);
  assert.equal(digest(await fs.readFile(f.destination)), f.file.sha256);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'saved-copies.json'), 'utf8')).records.length, 1);
});
test('saved copies: long-path journals stay within their own read limit by evicting oldest receipts only', async t => {
  const f = await fixture(t), journal = path.join(f.directory, 'saved-copies.json'), records = [];
  const template = { serverId: f.state.security.serverId, deviceId: 'host', fileId: crypto.randomUUID(), sha256: f.file.sha256, size: f.file.size, path: path.join(f.directory, 'a'.repeat(1800)), savedAt: 1 };
  const perRecord = Buffer.byteLength(JSON.stringify(template)) + 1, limit = 4 * 1024 * 1024;
  const count = Math.floor((limit - 250) / perRecord);
  for (let i = 0; i < count; i++) records.push({ ...template, fileId: crypto.randomUUID() });
  let data = JSON.stringify({ version: 1, records });
  records[records.length - 1].path += 'b'.repeat(limit - 100 - Buffer.byteLength(data));
  data = JSON.stringify({ version: 1, records }); assert.equal(Buffer.byteLength(data), limit - 100);
  await fs.writeFile(journal, data);
  const copies = createSavedCopies(f.directory); await copies.record(f.state, f.file, f.destination);
  const updated = await fs.readFile(journal); assert.ok(updated.length <= limit);
  const persisted = JSON.parse(updated); assert.equal(persisted.records.at(-1).fileId, f.file.id);
  assert.ok(!persisted.records.some(record => record.fileId === records[0].fileId));
  assert.equal((await createSavedCopies(f.directory).list(f.state, [f.file.id])).files[0].status, 'saved');
  assert.equal(digest(await fs.readFile(f.destination)), f.file.sha256);
});
