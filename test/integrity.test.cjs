'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const android=process.env.RELAY_BOUNDARY_ANDROID==='1';
const {createRelayServer}=android?require(process.env.RELAY_JVM_ADAPTER):require('../server.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const root=path.resolve(process.env.RELAY_TEST_DIR||path.join(os.tmpdir(),'relaydrop-integrity-tests'));

async function fixture(t){
 await fsp.mkdir(root,{recursive:true});const directory=await fsp.mkdtemp(path.join(root,'case-')),dataDir=path.join(directory,'data'),stateDir=android?path.join(dataDir,'relaydrop'):dataDir;
 let app,port;const options={dataDir,host:'127.0.0.1',port:0,discovery:false};
 async function start(){app=createRelayServer(options);port=await app.listen();}
 await start();t.after(async()=>{if(app)await app.close();assert.equal(path.dirname(path.resolve(directory)),root);await fsp.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 const c={dataDir,stateDir,part:id=>path.join(stateDir,'partials',id+'.part'),ready:id=>path.join(stateDir,'files',id)};
 c.restart=async beforeStart=>{const credential=app.hostToken;await app.close();app=null;if(beforeStart)await beforeStart();await start();assert.equal(app.hostToken,credential);await c.state();};
 c.req=async(route,{method='GET',json,body,headers={}}={})=>{headers.Authorization='Bearer '+app.hostToken;if(json!==undefined){body=JSON.stringify(json);headers['Content-Type']='application/json';}const r=await fetch(`http://127.0.0.1:${port}${route}`,{method,body,headers});let data;try{data=await r.json();}catch{}return{status:r.status,data};};
 c.state=async()=>{const r=await c.req('/api/state');assert.equal(r.status,200);return r.data;};
 c.disk=async()=>JSON.parse(await fsp.readFile(path.join(stateDir,'state.json'),'utf8'));
 c.begin=async(bytes,name='integrity.bin',fingerprint=hash(bytes))=>{const r=await c.req('/api/transfers',{method:'POST',json:{name,size:bytes.length,fingerprint,lastModified:1,targetId:null}});assert.ok([200,201].includes(r.status),JSON.stringify(r.data));return r.data;};
 c.put=async(id,bytes,offset)=>{const r=await c.req('/api/transfers/'+id,{method:'PUT',body:bytes,headers:{'Content-Type':'application/octet-stream','X-Offset':String(offset),'X-Chunk-SHA256':hash(bytes)}});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 c.fill=async(bytes,name,fingerprint)=>{const tx=await c.begin(bytes,name,fingerprint);for(let p=tx.offset;p<bytes.length;p+=tx.chunkSize)await c.put(tx.id,bytes.subarray(p,p+tx.chunkSize),p);return tx;};
 c.complete=id=>c.req('/api/transfers/'+id+'/complete',{method:'POST'});
 c.failNextMetadataWrite=async action=>{if(android){await fsp.writeFile(path.join(stateDir,'.fail-next-write'),'test');return action();}const original=fs.renameSync;let injected=false;fs.renameSync=function(from,to){if(!injected&&path.resolve(to)===path.join(stateDir,'state.json')){injected=true;throw Object.assign(new Error('Injected metadata ENOSPC'),{code:'ENOSPC'});}return original.apply(this,arguments);};try{return await action();}finally{fs.renameSync=original;assert.ok(injected);}};
 await c.state();return c;
}
async function corruptMiddle(file,bytes){const altered=Buffer.from(bytes),index=Math.floor(bytes.length/2);altered[index]^=0x40;const handle=await fsp.open(file,'r+');try{await handle.write(altered.subarray(index,index+1),0,1,index);await handle.sync();}finally{await handle.close();}assert.equal((await fsp.stat(file)).size,bytes.length);return altered;}
function mismatch(result,expected,actual){assert.equal(result.status,422,JSON.stringify(result.data));assert.equal(result.data.code,'FILE_HASH_MISMATCH');assert.equal(result.data.expectedSha256,expected);assert.equal(result.data.actualSha256,actual);}

test('integrity: fingerprints require exactly 64 hexadecimal characters and a string value',async t=>{
 const c=await fixture(t),valid=hash(Buffer.alloc(0));
 for(const fingerprint of [null,0,{},[],valid.slice(1),valid+'0','g'.repeat(64),' '+valid,valid+'\n',valid+'\r\n']){
  const r=await c.req('/api/transfers',{method:'POST',json:{name:'invalid.bin',size:0,fingerprint}});assert.equal(r.status,400,JSON.stringify(fingerprint));assert.equal(r.data.code,'INVALID_FINGERPRINT');
 }
 assert.equal((await c.state()).transfers.length,0);assert.equal((await c.disk()).files.length,0);
});

test('integrity: uppercase full hashes normalize, survive restart, and verify normal and empty files',async t=>{
 const c=await fixture(t);
 for(const bytes of [Buffer.alloc(0),crypto.randomBytes(131089)]){
  const tx=await c.fill(bytes,bytes.length?'original.bin':'empty.bin',hash(bytes).toUpperCase());assert.equal(tx.fingerprint,hash(bytes));
  await c.restart();const resumed=await c.req('/api/transfers/'+tx.id);assert.equal(resumed.data.fingerprint,hash(bytes));assert.equal(resumed.data.offset,bytes.length);
  for(let repeat=0;repeat<2;repeat++){const done=await c.complete(tx.id);assert.equal(done.status,200);assert.equal(done.data.sha256,hash(bytes));}
 }
 assert.equal((await c.state()).files.length,2);
});

test('integrity: same-size on-disk corruption is never published, including retry and restart',async t=>{
 const c=await fixture(t),bytes=crypto.randomBytes(2*1024*1024+17),tx=await c.fill(bytes,'original.bin'),altered=await corruptMiddle(c.part(tx.id),bytes);
 for(let retry=0;retry<3;retry++){
  if(retry===2)await c.restart();mismatch(await c.complete(tx.id),hash(bytes),hash(altered));
  assert.equal((await c.state()).files.length,0);assert.equal((await c.disk()).files.length,0);await assert.rejects(fsp.access(c.ready(tx.id)),{code:'ENOENT'});
 }
 const pending=await c.req('/api/transfers/'+tx.id);assert.equal(pending.data.offset,bytes.length);assert.equal(pending.data.fingerprint,hash(bytes));
 assert.equal((await c.req('/api/transfers/'+tx.id,{method:'DELETE'})).status,200);
 const replacement=await c.fill(bytes,'original.bin');assert.notEqual(replacement.id,tx.id);assert.equal((await c.complete(replacement.id)).data.sha256,hash(bytes));
});

test('integrity: completed retries recheck saved bytes and reject inconsistent legacy metadata',async t=>{
 const c=await fixture(t),bytes=crypto.randomBytes(4096),tx=await c.fill(bytes);assert.equal((await c.complete(tx.id)).status,200);
 const altered=await corruptMiddle(c.ready(tx.id),bytes);mismatch(await c.complete(tx.id),hash(bytes),hash(altered));
 await fsp.writeFile(c.ready(tx.id),bytes);assert.equal((await c.complete(tx.id)).status,200);
 await c.restart(async()=>{const disk=await c.disk();disk.files.find(f=>f.id===tx.id).sha256='0'.repeat(64);await fsp.writeFile(path.join(c.stateDir,'state.json'),JSON.stringify(disk));});
 mismatch(await c.complete(tx.id),hash(bytes),hash(bytes));
});

test('integrity: a renamed file after metadata failure is verified again before recovery commits',async t=>{
 const c=await fixture(t),bytes=crypto.randomBytes(8193),tx=await c.fill(bytes);const failed=await c.failNextMetadataWrite(()=>c.complete(tx.id));assert.ok(failed.status>=500);assert.equal((await c.state()).files.length,0);
 const altered=await corruptMiddle(c.ready(tx.id),bytes);mismatch(await c.complete(tx.id),hash(bytes),hash(altered));assert.equal((await c.disk()).files.length,0);
 await c.restart();mismatch(await c.complete(tx.id),hash(bytes),hash(altered));assert.equal((await c.state()).files.length,0);
 await fsp.writeFile(c.ready(tx.id),bytes);const recovered=await c.complete(tx.id);assert.equal(recovered.status,200);assert.equal(recovered.data.sha256,hash(bytes));assert.equal((await c.disk()).files.length,1);
});
