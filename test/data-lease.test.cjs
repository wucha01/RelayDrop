'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRelayServer, acquireDataLease } = require('../server.cjs');
const modulePath = path.resolve(__dirname, '../server.cjs');
const root = path.resolve(process.env.RELAY_TEST_DIR || path.join(os.tmpdir(), 'relaydrop-lease-tests'));

async function directory(t) {
  await fs.mkdir(root, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(root, 'case-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), root); await fs.rm(dataDir, { recursive: true, force: true }); });
  return dataDir;
}
const workerSource = `
  const {createRelayServer}=require(process.argv[1]);
  process.send({type:'ready'});
  process.once('message', async () => {
    let app;
    try {
      app=createRelayServer({dataDir:process.argv[2],host:'127.0.0.1',port:0,discovery:false});
      await app.listen();
      process.send({type:'acquired'});
      process.once('message',async()=>{await app.close();process.exit(0);});
    } catch(error) {
      if(app) await app.close();
      process.send({type:'rejected',code:error.code,message:error.message},()=>process.exit(0));
    }
  });`;
function worker(t, dataDir) {
  const child = spawn(process.execPath, ['-e', workerSource, modulePath, dataDir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '';
  child.stderr.on('data', block => { errors += block; });
  const exit = new Promise(resolve => child.once('exit', resolve));
  const timer = setTimeout(() => child.kill(), 10_000);
  child.once('exit', () => clearTimeout(timer));
  const message = type => new Promise((resolve, reject) => {
    const receive = data => { if (type === data.type || (type === 'outcome' && ['acquired', 'rejected'].includes(data.type))) { child.off('message', receive); resolve(data); } };
    child.on('message', receive); child.once('error', reject);
    child.once('exit', () => reject(new Error('Worker ended before ' + type + ': ' + errors)));
  });
  const ready = message('ready'), outcome = message('outcome');
  // Attach immediately so an unexpected subprocess exit is always observed.
  ready.catch(() => {}); outcome.catch(() => {});
  t.after(async () => { child.kill(); await exit; });
  return { child, ready, outcome, exit, go() { child.send('go'); }, async stop() { if (child.exitCode === null) child.send('stop'); await exit; } };
}

test('data lease: constructor errors release ownership without changing existing state', async t => {
  const dataDir = await directory(t);
  await fs.writeFile(path.join(dataDir, 'state.json'), '{invalid');
  assert.throws(() => createRelayServer({ dataDir, port: 0, discovery: false }), /数据损坏/);
  assert.equal(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'), '{invalid');
  await assert.rejects(fs.access(path.join(dataDir, '.relaydrop.lock')), { code: 'ENOENT' });
});

test('data lease: a rejected port bind releases the data directory for retry', async t => {
  const firstDir = await directory(t), secondDir = await directory(t);
  const first = createRelayServer({ dataDir: firstDir, host: '127.0.0.1', port: 0, discovery: false });
  const port = await first.listen();
  t.after(() => first.close());
  const rejected = createRelayServer({ dataDir: secondDir, host: '127.0.0.1', port, discovery: false });
  await assert.rejects(rejected.listen(), { code: 'EADDRINUSE' });
  await rejected.close();
  const retry = createRelayServer({ dataDir: secondDir, host: '127.0.0.1', port: 0, discovery: false });
  await retry.listen(); await retry.close(); await first.close();
});

for (const deniedCode of ['EPERM', 'EACCES']) {
  test(`data lease: unreadable recovery guard (${deniedCode}) stays busy without changing ownership`, async t => {
    const dataDir = await directory(t), guard = path.join(dataDir, '.relaydrop.lock-guard');
    const ownerName = `${process.pid}.${crypto.randomUUID()}.owner`;
    const lockPath = path.join(dataDir, '.relaydrop.lock');
    const originalLock = JSON.stringify({ pid: process.pid, instance: crypto.randomUUID() });
    await fs.mkdir(guard);
    await fs.writeFile(path.join(guard, ownerName), 'existing guard owner');
    await fs.writeFile(lockPath, originalLock);
    const originalRead = fsSync.readdirSync;
    let deniedReads = 0;
    t.mock.method(fsSync, 'readdirSync', function (directory, ...args) {
      if (directory === guard) {
        deniedReads++;
        throw Object.assign(new Error('Simulated Windows guard enumeration denial'), { code: deniedCode });
      }
      return originalRead.call(this, directory, ...args);
    });
    assert.throws(() => acquireDataLease(dataDir), { code: 'DATA_IN_USE' });
    assert.equal(deniedReads, 1, 'must reject instead of inferring a dead owner or recovering the guard');
    assert.equal(await fs.readFile(lockPath, 'utf8'), originalLock);
    assert.equal(await fs.readFile(path.join(guard, ownerName), 'utf8'), 'existing guard owner');
    assert.deepEqual((await fs.readdir(dataDir)).sort(), ['.relaydrop.lock', '.relaydrop.lock-guard'], 'the failed contender removes only its own prepared guard');
  });
}

test('data lease: independent processes cannot both recover the same dead owner', async t => {
  const dataDir = await directory(t), crashed = worker(t, dataDir);
  await crashed.ready; crashed.go(); assert.equal((await crashed.outcome).type, 'acquired');
  const deadPid = crashed.child.pid;
  crashed.child.kill('SIGKILL'); await crashed.exit;
  for (let round = 0; round < 8; round++) {
    await fs.writeFile(path.join(dataDir, '.relaydrop.lock'), JSON.stringify({ pid: deadPid, instance: crypto.randomUUID() }));
    // Cover a crash while the short recovery guard itself was held, too.
    const guard = path.join(dataDir, '.relaydrop.lock-guard');
    await fs.mkdir(guard); await fs.writeFile(path.join(guard, deadPid + '.' + crypto.randomUUID() + '.owner'), '');
    const contenders = [worker(t, dataDir), worker(t, dataDir)];
    await Promise.all(contenders.map(w => w.ready));
    contenders.forEach(w => w.go());
    const outcomes = await Promise.all(contenders.map(w => w.outcome));
    assert.equal(outcomes.filter(r => r.type === 'acquired').length, 1, 'round ' + round + ': ' + JSON.stringify(outcomes));
    assert.equal(outcomes.filter(r => r.type === 'rejected' && r.code === 'DATA_IN_USE').length, 1, 'round ' + round + ': ' + JSON.stringify(outcomes));
    await contenders[outcomes.findIndex(r => r.type === 'acquired')].stop();
    await Promise.all(contenders.map(w => w.exit));
  }
  await assert.rejects(fs.access(path.join(dataDir, '.relaydrop.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(dataDir, '.relaydrop.lock-guard')), { code: 'ENOENT' });
});
