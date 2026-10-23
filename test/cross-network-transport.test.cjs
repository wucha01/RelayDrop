'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),https=require('node:https');
const {createSecureRelayServer}=require('../server.cjs'),{loadOrCreateIdentity}=require('../security.cjs');
const {createBroker}=require('../remote/broker.cjs'),{RemoteHost,createRemoteTunnel}=require('../remote/client.cjs'),{randomSecret}=require('../remote/protocol.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function online(host){const end=Date.now()+12000;while(host.status.state!=='online'){if(Date.now()>end)throw new Error('Local test host did not register: '+host.status.state);await new Promise(r=>setTimeout(r,25));}}
async function fixture(t){
  const base=path.resolve(process.env.RELAY_TEST_DIR||os.tmpdir()),dir=await fs.mkdtemp(path.join(base,'relay14-integrated-'));let pool,broker,host,tunnel;
  t.after(async()=>{await tunnel?.close();await host?.close();await broker?.close();if(pool){pool.server.closeAllConnections();await pool.close();}assert.equal(path.dirname(dir),base);await fs.rm(dir,{recursive:true,force:true});});
  const relayIdentity=await loadOrCreateIdentity(path.join(dir,'broker'));pool=await createSecureRelayServer({dataDir:path.join(dir,'pool'),host:'127.0.0.1',port:0,discovery:false});const localPort=await pool.listen(),endpoint=await pool.openRemoteEndpoint(),identity=await loadOrCreateIdentity(path.join(dir,'pool'));
  const serviceKey=randomSecret(),hostKey=randomSecret(),joinKey=randomSecret();broker=await createBroker({key:relayIdentity.key,cert:relayIdentity.cert,serviceKey});
  const config={relay:'tls://127.0.0.1:'+broker.port,relayFingerprint:relayIdentity.fingerprint,room:identity.serverId,serviceKey,hostKey,joinKey,localPort:endpoint.port};
  host=new RemoteHost(config);host.start();await online(host);
  const invite={v:1,relay:config.relay,relayFingerprint:config.relayFingerprint,room:config.room,joinKey,serverId:identity.serverId,fingerprint:identity.fingerprint};tunnel=await createRemoteTunnel(invite);
  const local=async(route,method='GET',body)=>{const r=await fetch('http://127.0.0.1:'+localPort+route,{method,headers:{Authorization:'Bearer '+pool.hostToken,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
  function request(route,{method='GET',credential,body,headers={}}={}){return new Promise((resolve,reject)=>{
    const bytes=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    const req=https.request({hostname:'127.0.0.1',port:tunnel.port,path:route,method,ca:identity.cert,servername:'localhost',agent:false,timeout:5000,headers:{...(credential?{Authorization:'Bearer '+credential}:{}),...(bytes?{'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json','Content-Length':bytes.length}:{}),...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>{const raw=Buffer.concat(chunks);let data;try{data=JSON.parse(raw)}catch{}resolve({status:res.statusCode,data,raw,headers:res.headers});});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));req.end(bytes);
  });}
  async function pair(name){const s=await local('/api/state'),r=await request('/api/pair',{method:'POST',body:{name,code:s.data.pairing.code}});assert.equal(r.status,201);return r.data;}
  return {dir,pool,broker,identity,local,request,pair,async reconnect(){await tunnel.close();await host.close();host=new RemoteHost(config);host.start();await online(host);tunnel=await createRemoteTunnel(invite);},async stopHost(){await host.close();}};
}
test('integrated remote transport: chunked resume after host disconnect preserves exact multi-megabyte original',async t=>{
  const c=await fixture(t),paired=await c.pair('Remote phone'),credential=paired.token,bytes=crypto.randomBytes(2*1024*1024+97),fingerprint=sha(bytes);
  const start=await c.request('/api/transfers',{method:'POST',credential,body:{name:'original.bin',size:bytes.length,fingerprint}});assert.equal(start.status,201);const route='/api/transfers/'+start.data.id,chunkSize=1024*1024;
  const first=bytes.subarray(0,chunkSize);assert.equal((await c.request(route,{method:'PUT',credential,headers:{'X-Offset':'0','X-Chunk-SHA256':sha(first)},body:first})).status,200);
  await c.reconnect();const checkpoint=await c.request(route,{credential});assert.equal(checkpoint.status,200);assert.equal(checkpoint.data.offset,chunkSize);
  for(let offset=chunkSize;offset<bytes.length;offset+=chunkSize){const chunk=bytes.subarray(offset,offset+chunkSize);assert.equal((await c.request(route,{method:'PUT',credential,headers:{'X-Offset':String(offset),'X-Chunk-SHA256':sha(chunk)},body:chunk})).status,200);}
  const complete=await c.request(route+'/complete',{method:'POST',credential,body:{}});assert.equal(complete.status,200);assert.equal(complete.data.sha256,fingerprint);
  const download=await c.request('/api/files/'+complete.data.id+'/content',{credential});assert.equal(download.status,200);assert.equal(sha(download.raw),fingerprint);assert.deepEqual(download.raw,bytes);
  const local=(await c.local('/api/state')).data;assert.equal(local.files.length,1);assert.equal(local.files[0].id,complete.data.id);assert.equal(sha(await fs.readFile(path.join(c.dir,'pool/files',complete.data.id))),fingerprint);
});
test('integrated remote transport: corrupted chunks cannot publish and revoked peers cannot fetch files',async t=>{
  const c=await fixture(t),paired=await c.pair('Remote tablet'),credential=paired.token,bytes=Buffer.from('原件内容 intact'),fingerprint=sha(bytes);
  const transfer=await c.request('/api/transfers',{method:'POST',credential,body:{name:'original.txt',size:bytes.length,fingerprint}}),route='/api/transfers/'+transfer.data.id;
  const rejected=await c.request(route,{method:'PUT',credential,headers:{'X-Offset':'0','X-Chunk-SHA256':'0'.repeat(64)},body:bytes});assert.equal(rejected.status,422);assert.equal((await c.local('/api/state')).data.files.length,0);
  assert.equal((await c.request(route,{method:'PUT',credential,headers:{'X-Offset':'0','X-Chunk-SHA256':fingerprint},body:bytes})).status,200);
  const file=(await c.request(route+'/complete',{method:'POST',credential,body:{}})).data;
  const preview=await c.request('/api/files/'+file.id+'/text',{credential});assert.equal(preview.status,200);assert.deepEqual(preview.raw,bytes);
  assert.equal((await c.request('/api/state',{credential:c.pool.hostToken})).status,401);
  await c.local('/api/devices/'+paired.device.id+'/revoke','POST',{});
  assert.equal((await c.request('/api/files/'+file.id+'/content',{credential})).status,401);
});
test('integrated remote transport: shared pool needs online host and does not duplicate notes after reconnect',async t=>{
  const c=await fixture(t),paired=await c.pair('Remote client'),credential=paired.token,body={text:'One shared note',clientId:crypto.randomUUID()};
  const one=await c.request('/api/notes',{method:'POST',credential,body});assert.equal(one.status,201);
  await c.reconnect();const two=await c.request('/api/notes',{method:'POST',credential,body});assert.equal(two.status,200);assert.equal(one.data.id,two.data.id);
  assert.equal((await c.local('/api/state')).data.notes.length,1);
  await c.stopHost();await assert.rejects(c.request('/api/state',{credential}));
  assert.equal((await c.local('/api/state')).data.notes.length,1);
});
