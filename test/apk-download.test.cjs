'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createRelayServer}=require('../server.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('APK GET and HEAD expose a strong SHA-256 ETag matching the downloadable installer',async t=>{
 // Exercise byte integrity independently of a developer's signed APK.
 const apk=Buffer.concat([Buffer.from('PK\x03\x04'),crypto.randomBytes(8192)]);
 const root=path.resolve(process.env.RELAY_TEST_DIR||path.join(os.tmpdir(),'relaydrop-apk-tests'));await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));
 const androidApkPath=path.join(dataDir,'installer-fixture.bin');await fs.writeFile(androidApkPath,apk);
 const app=createRelayServer({dataDir,androidApkPath,host:'127.0.0.1',port:0,discovery:false});
 t.after(async()=>{await app.close();assert.equal(path.dirname(dataDir),root);await fs.rm(dataDir,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 const port=await app.listen(),url=`http://127.0.0.1:${port}/RelayDrop-Android.apk`;
 const get=await fetch(url);assert.equal(get.status,200);assert.equal(get.headers.get('content-type'),'application/vnd.android.package-archive');
 const bytes=Buffer.from(await get.arrayBuffer()),expected='"'+hash(apk)+'"';
 assert.match(get.headers.get('etag'),/^"[a-f0-9]{64}"$/);assert.equal(get.headers.get('etag'),expected);assert.equal(get.headers.get('etag'),'"'+hash(bytes)+'"');assert.deepEqual(bytes,apk);assert.equal(get.headers.get('content-length'),String(apk.length));
 const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('etag'),expected);assert.equal(head.headers.get('content-length'),String(apk.length));assert.equal((await head.arrayBuffer()).byteLength,0);
});

test('source checkout without an APK serves the UI and reports no installer',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'relaydrop-no-apk-'));
 const app=createRelayServer({dataDir,androidApkPath:path.join(dataDir,'missing.apk'),host:'127.0.0.1',port:0,discovery:false});
 t.after(async()=>{await app.close();await fs.rm(dataDir,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 const port=await app.listen(),base=`http://127.0.0.1:${port}`;
 assert.equal((await fetch(base+'/')).status,200);
 assert.equal((await fetch(base+'/RelayDrop-Android.apk')).status,404);
 const saved=JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'));
 const response=await fetch(base+'/api/state',{headers:{Authorization:'Bearer '+saved.hostToken}});
 assert.equal(response.status,200);assert.equal((await response.json()).capabilities.androidInstaller,false);
});
