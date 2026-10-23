'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const storage = require('../pool-storage.cjs'), { acquireDataLease, createRelayServer } = require('../server.cjs');
const { loadOrCreateIdentity } = require('../security.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const date = '2026-10-22T12:00:00.000Z';
async function fixture(t) {
  const parent = path.resolve(process.env.RELAY_TEST_DIR || os.tmpdir()), work = await fs.mkdtemp(path.join(parent, 'relay15-storage-'));
  const dataDir = path.join(work, 'pool'), destination = path.join(work, 'export'), target = path.join(work, 'target');
  await fs.mkdir(path.join(dataDir, 'files'), { recursive: true }); await fs.mkdir(path.join(dataDir, 'partials')); await fs.mkdir(destination); await fs.mkdir(path.join(target, 'files'), { recursive: true }); await fs.mkdir(path.join(target, 'partials'));
  t.after(async () => { assert.equal(path.dirname(work), parent); await fs.rm(work, { recursive: true, force: true }); });
  const folder = crypto.randomUUID(), empty = crypto.randomUUID(), peer = crypto.randomUUID();
  const state = { version: 1, hostToken: 'host-' + crypto.randomUUID(), devices: [{ id: 'host', role: 'host', name: '测试电脑', revoked: false }, { id: peer, name: '测试手机', token: 'private-peer-token', revoked: false }], folders: [{ id: folder, parentId: null, name: '高数资料', createdBy: 'host', createdAt: date }, { id: empty, parentId: folder, name: '空目录', createdBy: 'host', createdAt: date }], files: [], transfers: [], notes: [{ id: crypto.randomUUID(), text: '共享笔记', createdAt: date, senderId: 'host', targetId: null }, { id: crypto.randomUUID(), text: '私有笔记', createdAt: date, senderId: 'host', targetId: peer }], pairing: null };
  const payloads = new Map();
  for (const [name, folderId, targetId, deletedAt, bytes] of [
    ['高数资料', null, null, null, Buffer.from('与目录同名的文件')],
    ['笔记.txt', folder, null, null, Buffer.from('原文件内容\n中文')],
    ['笔记.txt', folder, null, null, Buffer.from('另一个同名文件')],
    ['空文件.txt', folder, null, null, Buffer.alloc(0)],
    ['私有.txt', null, peer, null, Buffer.from('不可分享给其他设备')],
    ['回收站.txt', folder, null, date, Buffer.from('仍在回收站')],
  ]) {
    const id = crypto.randomUUID(); payloads.set(id, bytes); const item = { id, name, folderId, targetId, size: bytes.length, sha256: hash(bytes), createdAt: date, senderId: 'host', senderName: '测试电脑' }; if (deletedAt) item.deletedAt = deletedAt; state.files.push(item); await fs.writeFile(path.join(dataDir, 'files', id), bytes);
  }
  const baseline = { version: 1, hostToken: 'other-host-token', devices: [{ id: 'host', role: 'host', name: '恢复目标', revoked: false }], folders: [], files: [], transfers: [], notes: [], pairing: null };
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(state)); await fs.writeFile(path.join(target, 'state.json'), JSON.stringify(baseline));
  return { work, dataDir, destination, target, state, baseline, payloads, folder, empty, peer };
}
async function changeManifest(directory, edit) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); edit(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(path.join(directory, 'manifest.json'), bytes); await fs.writeFile(path.join(directory, 'manifest.sha256'), hash(bytes) + '\n'); return manifest;
}
async function stateBytes(directory) { return fs.readFile(path.join(directory, 'state.json')); }
test('portable export preserves originals, duplicate names, empty directories, notes and trash without credentials', async t => {
  const c = await fixture(t), progress = [], backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination, onProgress: value => progress.push(value) });
  assert.equal(backup.files, 6); assert.equal(backup.folders, 2); assert.equal(backup.notes, 2); assert.ok(progress.length >= 6);
  const read = await storage.readBackup(backup.path), manifest = read.manifest, raw = await fs.readFile(path.join(backup.path, 'manifest.json'), 'utf8');
  assert.equal(read.manifestSha256, backup.manifestSha256); assert.equal(raw.includes(c.state.hostToken), false); assert.equal(raw.includes('private-peer-token'), false); assert.equal(raw.includes(c.peer), false);
  assert.equal(new Set(manifest.files.map(f => f.path.toLowerCase())).size, 6);
  for (const file of manifest.files) assert.deepEqual(await fs.readFile(path.join(backup.path, ...file.path.split('/'))), c.payloads.get(file.id));
  assert.ok((await fs.stat(path.join(backup.path, 'files', '共享文件', '高数资料', '空目录'))).isDirectory());
  assert.equal(manifest.files.filter(f => f.visibility === 'private').length, 1); assert.equal(manifest.files.filter(f => f.deletedAt).length, 1);
  assert.equal(manifest.files.find(f => f.name === '高数资料').path.endsWith('高数资料 (2)'), true);
});
test('restore appends verified originals and directories, retains identity, keeps private content host-only and trash hidden', async t => {
  const c = await fixture(t), before = await stateBytes(c.target), exported = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination });
  const restored = await storage.restoreBackup({ dataDir: c.target, backupDir: exported.path }); assert.equal(restored.files, 6); assert.equal(restored.folders, 3);
  const state = JSON.parse(await stateBytes(c.target)); assert.equal(state.hostToken, JSON.parse(before).hostToken); assert.deepEqual(state.devices, c.baseline.devices); assert.equal(state.files.length, 6); assert.equal(state.notes.length, 2);
  for (const file of state.files) { assert.equal(c.payloads.has(file.id), false); const bytes = await fs.readFile(path.join(c.target, 'files', file.id)); assert.equal(hash(bytes), file.sha256); assert.equal(file.senderId, 'host'); }
  const privateFile = state.files.find(f => f.name === '私有.txt'); assert.equal(privateFile.targetId, 'host'); assert.equal(privateFile.folderId, null);
  assert.equal(state.notes.find(n => n.text === '私有笔记').targetId, 'host'); assert.ok(state.files.find(f => f.name === '回收站.txt').deletedAt);
  const second = await storage.restoreBackup({ dataDir: c.target, backupDir: exported.path }); assert.equal(second.files, 6); const after = JSON.parse(await stateBytes(c.target)); assert.equal(after.files.length, 12); assert.equal(new Set(after.files.map(f => f.id)).size, 12);
});
test('corrupt backup bytes fail before any published state or files and leave original backup untouched', async t => {
  const c = await fixture(t), backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }), manifest = (await storage.readBackup(backup.path)).manifest;
  const last = manifest.files.at(-1); await fs.writeFile(path.join(backup.path, ...last.path.split('/')), Buffer.alloc(last.size, 0x33)); const before = await stateBytes(c.target);
  await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path }), { code: 'FILE_HASH_MISMATCH' });
  assert.deepEqual(await stateBytes(c.target), before); assert.deepEqual(await fs.readdir(path.join(c.target, 'files')), []); assert.equal((await fs.readdir(c.target)).some(name => name.startsWith('.restore-')), false);
  assert.equal((await fs.stat(backup.path)).isDirectory(), true);
});
test('manifest checksum corruption is rejected before restore', async t => {
  const c = await fixture(t), backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }), before = await stateBytes(c.target);
  await fs.appendFile(path.join(backup.path, 'manifest.json'), ' '); await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path }), { code: 'FILE_HASH_MISMATCH' }); assert.deepEqual(await stateBytes(c.target), before);
});
test('manifest traversal, absolute paths, aliases, payload collisions and cyclic folders are rejected even with recomputed checksum', async t => {
  const c = await fixture(t), backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }), pristine = (await storage.readBackup(backup.path)).manifest;
  const edits = [m => m.files[0].path = 'files/../../outside', m => m.files[0].path = 'C:/outside', m => m.files[0].path = 'files/a\\b', m => m.files[0].path = 'files/con.txt', m => m.files[1].path = m.files[0].path.toUpperCase().replace('FILES/', 'files/'), m => m.files[0].path = m.files[1].path.split('/').slice(0, -1).join('/'), m => m.folders[0].parentId = m.folders[1].id, m => m.files[0].visibility = 'everybody', m => m.files[0].sha256 = 'bad', ...[' ', '.', '..', 'a'.repeat(256), '\ud800.txt'].map(value => m => m.files[0].name = value), ...[' ', 'text\0'].map(value => m => m.notes[0].text = value)];
  for (const edit of edits) { const manifest = structuredClone(pristine); edit(manifest); const bytes = Buffer.from(JSON.stringify(manifest)); await fs.writeFile(path.join(backup.path, 'manifest.json'), bytes); await fs.writeFile(path.join(backup.path, 'manifest.sha256'), hash(bytes)); await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path })); assert.deepEqual(await fs.readdir(path.join(c.target, 'files')), []); }
});
test('storage maintenance refuses a live data lease and never changes the running pool', async t => {
  const c = await fixture(t), original = await stateBytes(c.dataDir), lease = acquireDataLease(c.dataDir);
  try { await assert.rejects(storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }), { code: 'DATA_IN_USE' }); await assert.rejects(storage.migrateData({ dataDir: c.dataDir, destination: c.destination }), { code: 'DATA_IN_USE' }); } finally { lease.release(); }
  assert.deepEqual(await stateBytes(c.dataDir), original); assert.deepEqual(await fs.readdir(c.destination), []);
});
test('cancelled export and restore clean only owned staging and preserve all existing bytes', async t => {
  const c = await fixture(t), controller = new AbortController();
  await assert.rejects(storage.exportBackup({ dataDir: c.dataDir, destination: c.destination, signal: controller.signal, onProgress: p => { if (p.completed === 1) controller.abort(); } }), { name: 'AbortError' }); assert.deepEqual(await fs.readdir(c.destination), []);
  const backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }), restoreController = new AbortController(), before = await stateBytes(c.target);
  await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path, signal: restoreController.signal, onProgress: p => { if (p.completed === 2) restoreController.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(await stateBytes(c.target), before); assert.deepEqual(await fs.readdir(path.join(c.target, 'files')), []);
});
test('migration preserves TLS identity, paired state and resumable partials, verifies copy and leaves old directory intact', async t => {
  const c = await fixture(t), identity = await loadOrCreateIdentity(c.dataDir), transferId = crypto.randomUUID(), partial = crypto.randomBytes(8193);
  c.state.transfers.push({ id: transferId, status: 'uploading', size: 16384, offset: partial.length, name: 'partial.bin', senderId: 'host', fingerprint: 'a'.repeat(64), targetId: null, folderId: null });
  await fs.writeFile(path.join(c.dataDir, 'state.json'), JSON.stringify(c.state)); await fs.writeFile(path.join(c.dataDir, 'partials', transferId + '.part'), partial); await fs.writeFile(path.join(c.dataDir, 'launch.json'), 'transient-launch');
  const original = await stateBytes(c.dataDir), moved = await storage.migrateData({ dataDir: c.dataDir, destination: c.destination });
  assert.notEqual(moved.dataDir, c.dataDir); assert.deepEqual(await stateBytes(moved.dataDir), original); assert.deepEqual(await stateBytes(c.dataDir), original);
  assert.deepEqual(await fs.readFile(path.join(moved.dataDir, 'partials', transferId + '.part')), partial); assert.equal((await loadOrCreateIdentity(moved.dataDir)).fingerprint, identity.fingerprint);
  assert.deepEqual(await fs.readFile(path.join(moved.dataDir, 'tls-identity.json')), await fs.readFile(path.join(c.dataDir, 'tls-identity.json')));
  assert.equal((await fs.readdir(moved.dataDir)).some(n => n.startsWith('.relaydrop.lock') || n === 'launch.json'), false);
  for (const file of c.state.files) assert.deepEqual(await fs.readFile(path.join(moved.dataDir, 'files', file.id)), c.payloads.get(file.id));
});
test('migration and export reject corrupted originals without publishing destination', async t => {
  const c = await fixture(t), first = c.state.files[0]; await fs.writeFile(path.join(c.dataDir, 'files', first.id), Buffer.alloc(first.size, 88));
  for (const action of [storage.exportBackup, storage.migrateData]) { await assert.rejects(action({ dataDir: c.dataDir, destination: c.destination }), { code: 'FILE_HASH_MISMATCH' }); assert.deepEqual(await fs.readdir(c.destination), []); }
});
test('destination inside the existing data directory is refused', async t => {
  const c = await fixture(t); for (const action of [storage.exportBackup, storage.migrateData]) await assert.rejects(action({ dataDir: c.dataDir, destination: path.join(c.dataDir, 'files') }), { code: 'UNSAFE_PATH' });
});
test('symlink or junction payload cannot escape backup directory', async t => {
  const c = await fixture(t), backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }), manifest = (await storage.readBackup(backup.path)).manifest, entry = manifest.files[0];
  const outside = path.join(c.work, 'external'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret'), c.payloads.get(entry.id));
  await fs.symlink(outside, path.join(backup.path, 'files', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); await changeManifest(backup.path, m => m.files[0].path = 'files/linked/secret');
  await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path }), { code: 'UNSAFE_PATH' }); assert.deepEqual(await fs.readdir(path.join(c.target, 'files')), []);
});
test('state modified outside the lease during export or restore causes rollback', async t => {
  const c = await fixture(t), before = await stateBytes(c.dataDir); let changed = false;
  await assert.rejects(storage.exportBackup({ dataDir: c.dataDir, destination: c.destination, onProgress: p => { if (p.completed === 1 && !changed) { changed = true; require('node:fs').appendFileSync(path.join(c.dataDir, 'state.json'), ' '); } } }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(await fs.readdir(c.destination), []); await fs.writeFile(path.join(c.dataDir, 'state.json'), before);
  const backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }); changed = false;
  await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path, onProgress: p => { if (p.completed === 1 && !changed) { changed = true; require('node:fs').appendFileSync(path.join(c.target, 'state.json'), ' '); } } }), { code: 'SOURCE_CHANGED' }); assert.deepEqual(await fs.readdir(path.join(c.target, 'files')), []);
});
test('maximum depth and 1024-character paths round-trip without an extra wrapper or overwritten contents', async t => {
  for (const names of [Array(32).fill('层'), [...Array(7).fill('a'.repeat(127)), 'b'.repeat(128)]]) {
    const c = await fixture(t); c.state.folders = []; let parentId = null;
    for (const name of names) { const folder = { id: crypto.randomUUID(), parentId, name, createdAt: date, createdBy: 'host' }; c.state.folders.push(folder); parentId = folder.id; }
    for (const file of c.state.files) if (!file.targetId) file.folderId = parentId;
    await fs.writeFile(path.join(c.dataDir, 'state.json'), JSON.stringify(c.state));
    const backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }), first = await storage.restoreBackup({ dataDir: c.target, backupDir: backup.path });
    assert.equal(first.mergedPaths, true); assert.equal(first.rootFolderId, null); assert.equal(first.folders, names.length);
    const before = JSON.parse(await stateBytes(c.target)), second = await storage.restoreBackup({ dataDir: c.target, backupDir: backup.path });
    assert.equal(second.mergedPaths, true); assert.equal(second.folders, 0); const after = JSON.parse(await stateBytes(c.target));
    assert.deepEqual(after.folders, before.folders); assert.deepEqual(after.files.slice(0, before.files.length), before.files); assert.equal(after.files.length, 12);
    for (const file of after.files) assert.equal(hash(await fs.readFile(path.join(c.target, 'files', file.id))), file.sha256);
  }
});
test('restore cancellation after publishing a payload rolls back every new file and metadata', async t => {
  const c = await fixture(t), backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }), before = await stateBytes(c.target), controller = new AbortController();
  await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path, signal: controller.signal, onProgress: p => { if (p.phase === 'publishing' && p.completed === 1) controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(await stateBytes(c.target), before); assert.deepEqual(await fs.readdir(path.join(c.target, 'files')), []); assert.equal((await fs.readdir(c.target)).some(n => n.startsWith('.restore-')), false);
});
test('metadata commit disk failure rolls back published payloads and preserves original state', async t => {
  const c = await fixture(t), backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }), before = await stateBytes(c.target), rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => { if (to === path.join(c.target, 'state.json')) throw Object.assign(new Error('disk full at metadata commit'), { code: 'ENOSPC' }); return rename(from, to); });
  await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path }), { code: 'ENOSPC' });
  assert.deepEqual(await stateBytes(c.target), before); assert.deepEqual(await fs.readdir(path.join(c.target, 'files')), []); assert.equal((await fs.readdir(c.target)).some(n => n.startsWith('.restore-')), false);
});
test('state mutation during payload publication is detected before metadata commit', async t => {
  const c = await fixture(t), backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination }); let changed = false;
  await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path, onProgress: p => { if (p.phase === 'publishing' && !changed) { changed = true; require('node:fs').appendFileSync(path.join(c.target, 'state.json'), ' '); } } }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(await fs.readdir(path.join(c.target, 'files')), []); assert.equal(changed, true);
});
test('restore respects notes quota and rejects internal dot-prefix backup directories', async t => {
  const c = await fixture(t), backup = await storage.exportBackup({ dataDir: c.dataDir, destination: c.destination });
  c.baseline.notes = Array.from({ length: 5000 }, () => ({ id: crypto.randomUUID(), text: 'existing', createdAt: date, targetId: null }));
  await fs.writeFile(path.join(c.target, 'state.json'), JSON.stringify(c.baseline)); const before = await stateBytes(c.target);
  await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: backup.path }), { code: 'NOTE_LIMIT' }); assert.deepEqual(await stateBytes(c.target), before);
  const nested = path.join(c.target, '..backup'); await fs.cp(backup.path, nested, { recursive: true });
  await assert.rejects(storage.restoreBackup({ dataDir: c.target, backupDir: nested }), { code: 'UNSAFE_PATH' }); assert.deepEqual(await fs.readdir(path.join(c.target, 'files')), []);
});
