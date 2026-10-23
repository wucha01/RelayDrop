'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),https=require('node:https'),net=require('node:net'),crypto=require('node:crypto');
const {createSecureRelayServer,createRelayServer}=require('../server.cjs');
const {loadOrCreateIdentity}=require('../security.cjs');
async function fixture(t){
  const base=path.resolve(process.env.RELAY_TEST_DIR||os.tmpdir()),dir=await fs.mkdtemp(path.join(base,'relay14-endpoint-'));
  const app=await createSecureRelayServer({dataDir:dir,host:'127.0.0.1',port:0,discovery:false});
  const localPort=await app.listen(),identity=await loadOrCreateIdentity(dir);
  t.after(async()=>{app.server.closeAllConnections();await app.close();assert.equal(path.dirname(dir),base);await fs.rm(dir,{recursive:true,force:true});});
  const local=async(route,method='GET',body)=>{const r=await fetch('http://127.0.0.1:'+localPort+route,{method,headers:{Authorization:'Bearer '+app.hostToken,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
  async function call(port,route='/api/identity',{method='GET',headers={},body,ca=identity.cert}={}){
    return new Promise((resolve,reject)=>{const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));const req=https.request({host:'127.0.0.1',port,path:route,method,ca,servername:'localhost',agent:false,timeout:3000,headers:{Host:'127.0.0.1:43123',...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.once('end',()=>{const raw=Buffer.concat(chunks);let data;try{data=JSON.parse(raw)}catch{}resolve({status:res.statusCode,data,raw});});});req.once('error',reject);req.once('timeout',()=>req.destroy(new Error('timeout')));req.end(bytes);});
  }
  return {app,identity,local,call};
}
test('remote endpoint preserves identity and isolates virtual Host handling from LAN',async t=>{
  const c=await fixture(t),endpoint=await c.app.openRemoteEndpoint();
  const remote=await c.call(endpoint.port);assert.equal(remote.status,200);assert.equal(remote.data.serverId,c.identity.serverId);assert.equal(remote.data.certificateFingerprint,c.identity.fingerprint);
  assert.equal((await c.call(c.app.securePort)).status,403);
  assert.equal((await c.call(c.app.securePort,'/api/identity',{headers:{Host:'127.0.0.1:'+c.app.securePort}})).status,200);
  assert.equal((await c.call(endpoint.port,'/api/state')).status,401);
});
test('remote endpoint never accepts host administrator credentials and enforces guest pairing/revocation',async t=>{
  const c=await fixture(t),endpoint=await c.app.openRemoteEndpoint();
  assert.equal((await c.call(endpoint.port,'/api/state',{headers:{Authorization:'Bearer '+c.app.hostToken}})).status,401);
  const state=await c.local('/api/state');
  const pair=await c.call(endpoint.port,'/api/pair',{method:'POST',body:{name:'Remote phone',code:state.data.pairing.code}});assert.equal(pair.status,201);
  const headers={Authorization:'Bearer '+pair.data.token};
  assert.equal((await c.call(endpoint.port,'/api/state',{headers})).data.device.role,'guest');
  assert.equal((await c.call(endpoint.port,'/api/pairing/rotate',{method:'POST',body:{},headers})).status,403);
  await c.local('/api/devices/'+pair.data.device.id+'/revoke','POST',{});
  assert.equal((await c.call(endpoint.port,'/api/state',{headers})).status,401);
});
test('remote endpoint rejects hostile authorities, cross-origin requests and untrusted TLS',async t=>{
  const c=await fixture(t),endpoint=await c.app.openRemoteEndpoint();
  for(const Host of ['evil.example:43123','192.168.1.1:43123','localhost:43123','127.0.0.1:0'])assert.equal((await c.call(endpoint.port,'/api/identity',{headers:{Host}})).status,403);
  assert.equal((await c.call(endpoint.port,'/api/identity',{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await c.call(endpoint.port,'/api/identity',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await c.call(endpoint.port,'/api/identity',{headers:{Origin:'https://127.0.0.1:43123'}})).status,200);
  await assert.rejects(c.call(endpoint.port,'/api/identity',{ca:[]}));
});
test('remote marking cannot be supplied through forwarded request headers',async t=>{
  const c=await fixture(t);
  assert.equal((await c.call(c.app.securePort,'/api/identity',{headers:{'X-Relay-Remote':'true','Forwarded':'host=127.0.0.1:43123','X-Forwarded-Host':'127.0.0.1:43123'}})).status,403);
});
test('remote endpoint is singleton, closes unfinished TLS sockets, and can be reopened without changing identity',async t=>{
  const c=await fixture(t),[a,b]=await Promise.all([c.app.openRemoteEndpoint(),c.app.openRemoteEndpoint()]);assert.equal(a,b);
  const socket=net.connect({host:'127.0.0.1',port:a.port});socket.on('error',()=>{});await new Promise(resolve=>socket.once('connect',resolve));const ended=new Promise(resolve=>socket.once('close',resolve));
  await a.close();await ended;
  await assert.rejects(c.call(a.port));const next=await c.app.openRemoteEndpoint();assert.notEqual(next,a);assert.equal((await c.call(next.port)).data.certificateFingerprint,c.identity.fingerprint);
  await c.app.close();await assert.rejects(c.call(next.port));await assert.rejects(c.app.openRemoteEndpoint());
});
test('remote endpoint provides the same lossless file pool through paired credentials',async t=>{
  const c=await fixture(t),endpoint=await c.app.openRemoteEndpoint(),state=await c.local('/api/state');
  const pair=await c.call(endpoint.port,'/api/pair',{method:'POST',body:{name:'Tablet',code:state.data.pairing.code}}),headers={Authorization:'Bearer '+pair.data.token};
  const bytes=Buffer.alloc(0),fingerprint=crypto.createHash('sha256').update(bytes).digest('hex');
  const transfer=await c.call(endpoint.port,'/api/transfers',{method:'POST',headers,body:{name:'empty.txt',size:0,fingerprint}});assert.equal(transfer.status,201);
  const complete=await c.call(endpoint.port,'/api/transfers/'+transfer.data.id+'/complete',{method:'POST',headers,body:{}});assert.equal(complete.status,200);assert.equal(complete.data.sha256,fingerprint);
  assert.equal((await c.local('/api/state')).data.files[0].sha256,fingerprint);
  const note=await c.call(endpoint.port,'/api/notes',{method:'POST',headers,body:{text:'Remote clipboard',clientId:crypto.randomUUID()}});assert.equal(note.status,201);
  assert.equal((await c.local('/api/state')).data.notes[0].text,'Remote clipboard');
});
