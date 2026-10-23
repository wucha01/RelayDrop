'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRelayServer } = require('../server.cjs');
const pool = require('../file-pool.cjs');
const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAUACgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAMG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8ArgLMMAAAAAAAAAA//9k=', 'base64');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
async function fixture(t, createThumbnail = async () => jpeg) {
  const work = path.resolve(process.env.RELAY_TEST_DIR || path.join(os.tmpdir(), 'relaydrop-tests')); await fs.mkdir(work, { recursive:true });
  const dataDir = await fs.mkdtemp(path.join(work, 'pool-'));
  const app = createRelayServer({ dataDir, host:'127.0.0.1', port:0, discovery:false, createThumbnail });
  const port = await app.listen(); t.after(() => app.close());
  async function req(route, token = app.hostToken, method = 'GET', data) {
    const headers = token ? { Authorization:'Bearer '+token } : {};
    let body;
    if (data !== undefined) { body = JSON.stringify(data); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method,headers,body });
    const bytes = Buffer.from(await res.arrayBuffer()); let json; try { json = JSON.parse(bytes); } catch {}
    return { status:res.status, headers:res.headers, bytes, json };
  }
  async function pair(name) { const state = (await req('/api/state')).json; return (await req('/api/pair',null,'POST',{ name,code:state.pairing.code })).json; }
  async function upload(name, token = app.hostToken, targetId = null, bytes = jpeg) {
    const begun = await req('/api/transfers',token,'POST',{name,size:bytes.length,fingerprint:hash(bytes),targetId}); assert.equal(begun.status,201);
    const id = begun.json.id;
    if (bytes.length) { const res = await fetch(`http://127.0.0.1:${port}/api/transfers/${id}`,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream','X-Offset':'0','X-Chunk-SHA256':hash(bytes)},body:bytes});assert.equal(res.status,200);await res.arrayBuffer(); }
    const done = await req(`/api/transfers/${id}/complete`,token,'POST',{});assert.equal(done.status,200);return done.json;
  }
  return {app,req,pair,upload,dataDir};
}
test('file pool categories, case insensitive suffixes and bounded safe image dimensions', () => {
  for (const [name,want] of Object.entries({'相册.JPG':'image','readme.TXT':'text','notes.md':'text','论文.PDF':'document','毕业.mp4':'video','录音.flac':'audio','备份.tar.gz':'archive','程序.apk':'other','no-extension':'other','a.txt.exe':'other'})) assert.equal(pool.category(name),want);
  assert.deepEqual(pool.imageDimensions(jpeg),{format:'jpeg',width:40,height:20});
  assert.equal(pool.imageDimensions(Buffer.from('<svg onload="evil()"/>')),null);
  assert.equal(pool.safeDimensions({width:100_000,height:100_000}),false);
  assert.equal(pool.safeDimensions({width:0,height:2}),false);
  assert.equal(pool.previewable({name:'a.svg',size:32}),false);
  assert.equal(pool.previewable({name:'a.jpg',size:pool.MAX_PREVIEW_SOURCE+1}),false);
  assert.equal(pool.previewable({name:'a.png',size:0}),false);
});
test('three concurrently connected devices see shared pool and retain private file isolation', async t => {
  const f=await fixture(t), phone=await f.pair('安卓手机'), tablet=await f.pair('安卓平板');
  const [picture,text,doc]=await Promise.all([f.upload('手机照片.jpg',phone.token),f.upload('平板笔记.txt',tablet.token,null,Buffer.from('中文文字')),f.upload('电脑文档.pdf')]);
  const privateFile=await f.upload('仅电脑.jpg',phone.token,'host');
  const states=await Promise.all([f.req('/api/state'),f.req('/api/state',phone.token),f.req('/api/state',tablet.token)]);
  for(const r of states){assert.equal(r.status,200);for(const id of[picture.id,text.id,doc.id])assert.ok(r.json.files.some(x=>x.id===id));assert.equal(r.json.devices.length,3);}
  assert.ok(!states[2].json.files.some(x=>x.id===privateFile.id));
  assert.equal(states[0].json.files.find(x=>x.id===text.id).category,'text');
  assert.equal((await f.req(`/api/files/${picture.id}/preview`,tablet.token)).status,200);
  assert.equal((await f.req(`/api/files/${privateFile.id}/preview`,tablet.token)).status,404);
});
test('previews require bearer auth, are small JPEG and never alter original file or use content tickets',async t=>{
  const f=await fixture(t),file=await f.upload('原图.jpg');
  const response=await f.req(`/api/files/${file.id}/preview`);assert.equal(response.status,200);assert.deepEqual(response.bytes,jpeg);assert.equal(response.headers.get('content-type'),'image/jpeg');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal(hash(await fs.readFile(path.join(f.dataDir,'files',file.id))),file.sha256);
  assert.equal((await f.req(`/api/files/${file.id}/preview`,null)).status,401);
  const ticket=(await f.req(`/api/files/${file.id}/ticket`,undefined,'POST',{})).json.url.split('?')[1];
  assert.equal((await f.req(`/api/files/${file.id}/preview?${ticket}`,null)).status,401);
  assert.equal((await f.req(`/api/files/${file.id}/preview`,undefined,'HEAD')).bytes.length,0);
});
test('preview generation coalesces concurrent requests, caches and invalidates source changes',async t=>{
  let calls=0;const f=await fixture(t,async()=>{calls++;await new Promise(r=>setTimeout(r,20));return jpeg;});
  const file=await f.upload('照片.jpg');const results=await Promise.all(Array.from({length:8},()=>f.req(`/api/files/${file.id}/preview`)));
  assert.ok(results.every(r=>r.status===200));assert.equal(calls,1);
  await f.req(`/api/files/${file.id}/preview`);assert.equal(calls,1);
  const location=path.join(f.dataDir,'files',file.id);await fs.utimes(location,new Date(),new Date(Date.now()+1000));
  await f.req(`/api/files/${file.id}/preview`);assert.equal(calls,2);
  await f.req(`/api/files/${file.id}`,undefined,'DELETE');assert.equal((await f.req(`/api/files/${file.id}/preview`)).status,404);
});
test('revoking a device during decode blocks its preview response and later cached requests',async t=>{
  let begin,release;const entered=new Promise(r=>begin=r),gate=new Promise(r=>release=r);
  const f=await fixture(t,async()=>{begin();await gate;return jpeg;});const guest=await f.pair('待撤销手机'),file=await f.upload('照片.jpg');
  const request=f.req(`/api/files/${file.id}/preview`,guest.token);await entered;
  await f.req(`/api/devices/${guest.device.id}/revoke`,undefined,'POST',{});release();
  assert.equal((await request).status,401);assert.equal((await f.req(`/api/files/${file.id}/preview`,guest.token)).status,401);
});
test('deleting a file during thumbnail generation does not publish its preview',async t=>{
  let begin,release;const entered=new Promise(r=>begin=r),gate=new Promise(r=>release=r);
  const f=await fixture(t,async()=>{begin();await gate;return jpeg;}),file=await f.upload('照片.jpg');
  const request=f.req(`/api/files/${file.id}/preview`);await entered;
  assert.equal((await f.req(`/api/files/${file.id}`,undefined,'DELETE')).status,200);release();assert.equal((await request).status,404);
});
test('unsupported images or invalid thumbnail output fail safely without breaking originals',async t=>{
  const f=await fixture(t,async()=>Buffer.from('<html>unsafe</html>'));
  for(const name of['photo.jpg','vector.svg','picture.gif','empty.txt']){const file=await f.upload(name);assert.equal((await f.req(`/api/files/${file.id}/preview`)).status,415);assert.deepEqual((await f.req(`/api/files/${file.id}/content`)).bytes,jpeg);}
});
test('older Node-only mode exposes categories with preview disabled, not false success',async t=>{
  const f=await fixture(t,null),file=await f.upload('照片.jpg');assert.equal(file.category,'image');assert.equal(file.previewable,false);assert.equal((await f.req(`/api/files/${file.id}/preview`)).status,415);
});

test('preview work is bounded, serialised and does not block the shared pool', async t => {
  let release, entered, active = 0, maximum = 0;
  const gate = new Promise(r => release = r), started = new Promise(r => entered = r);
  const f = await fixture(t, async () => { active++; maximum = Math.max(maximum, active); entered(); await gate; active--; return jpeg; });
  const files = [];
  for (let i = 0; i < 20; i++) files.push(await f.upload('queue-' + i + '.jpg'));
  const requests = files.map(file => f.req(`/api/files/${file.id}/preview`));
  try {
    await started;
    const busy = await Promise.any(requests.map(request => request.then(result => { if (result.status === 429) return result; throw new Error('Expected at least one bounded rejection'); })));
    assert.equal(busy.json.code, 'PREVIEW_BUSY');
    assert.equal((await f.req('/api/state')).json.files.length, 20);
  } finally { release(); }
  const results = await Promise.all(requests);
  assert.ok(results.some(result => result.status === 200));
  assert.ok(results.every(result => [200, 429].includes(result.status)));
  assert.equal(maximum, 1);
  assert.equal((await f.req(`/api/files/${files[19].id}/preview`)).status, 200);
});

test('shutdown cancels active preview and skips queued decoders', async t => {
  let entered, calls = 0;
  const began = new Promise(r => entered = r);
  const f = await fixture(t, async (_location, _file, signal) => {
    calls++; entered();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return jpeg;
  });
  const first = await f.upload('active.jpg'), second = await f.upload('queued.jpg');
  const requests = [f.req(`/api/files/${first.id}/preview`), f.req(`/api/files/${second.id}/preview`)];
  await began;
  await f.app.close();
  const results = await Promise.all(requests);
  assert.ok(results.every(result => result.status === 503));
  assert.equal(calls, 1);
});
