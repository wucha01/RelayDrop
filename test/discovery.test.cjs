'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const source=fs.readFileSync(path.join(__dirname,'..','discovery.cjs'),'utf8');
function readName(buf,start){let labels=[],at=start;while(buf[at]){const len=buf[at++];labels.push(buf.toString('utf8',at,at+len));at+=len;}return {name:labels.join('.'),end:at+1};}
function decode(buf){const records=[];let at=12;for(let i=0;i<buf.readUInt16BE(6);i++){const n=readName(buf,at);at=n.end;const type=buf.readUInt16BE(at),ttl=buf.readUInt32BE(at+4),len=buf.readUInt16BE(at+8),start=at+10;const row={name:n.name,type,ttl};if(type===1)row.address=[...buf.subarray(start,start+len)].join('.');if(type===12)row.target=readName(buf,start).name;if(type===33){row.port=buf.readUInt16BE(start+4);row.target=readName(buf,start+6).name;}records.push(row);at=start+len;}return records;}
function nic(address,mac='ab:cd:00:00:00:01'){return [{address,mac,internal:false,family:'IPv4'}];}
async function fixture(hostname,interfaces){
 const sockets=[],sent=[],exports={};let current=interfaces,tick;
 const dgram={createSocket(){const socket=new EventEmitter();socket.closed=false;socket.bind=(_port,fn)=>queueMicrotask(fn);socket.unref=()=>{};socket.addMembership=()=>{};socket.setMulticastInterface=ip=>socket.ip=ip;socket.setMulticastTTL=ttl=>socket.ttl=ttl;socket.setMulticastLoopback=()=>{};socket.send=(buf,port,group,cb)=>{sent.push({ip:socket.ip,ttl:socket.ttl,port,group,records:decode(buf)});cb?.();};socket.close=()=>{socket.closed=true;};sockets.push(socket);return socket;}};
 vm.runInNewContext(source,{require:id=>id==='node:dgram'?dgram:id==='node:os'?{hostname:()=>hostname,networkInterfaces:()=>current}:require(id),exports,Buffer,Date,setInterval:fn=>{tick=fn;return {unref(){}};},clearInterval:()=>{tick=null;}});
 const stop=exports.startDiscovery(8765);await new Promise(setImmediate);
 return {sockets,sent,stop,async change(next){current=next;tick();await new Promise(setImmediate);}};
}
test('discovery publishes the reachable address through each physical interface, excluding VPN and VM adapters',async()=>{
 const f=await fixture('Desktop',{WLAN:nic('192.168.1.5'),Ethernet:nic('10.0.0.7'),singbox_tun:nic('172.19.0.1'),VirtualBox:nic('192.168.56.1'),Loopback:[{address:'127.0.0.1',family:'IPv4',internal:true,mac:''}]});
 try{assert.deepEqual(f.sent.map(x=>x.ip).sort(),['10.0.0.7','192.168.1.5']);for(const packet of f.sent){assert.equal(packet.ttl,255);assert.equal(packet.group,'224.0.0.251');assert.equal(packet.port,5353);assert.deepEqual(packet.records.filter(x=>x.type===1).map(x=>x.address),[packet.ip]);assert.equal(packet.records.find(x=>x.type===33).port,8765);}}finally{f.stop();}
});
test('discovery retains distinct stable DNS names for different non-ASCII device names',async()=>{
 const a=await fixture('我的电脑甲',{WLAN:nic('192.168.1.5')});const b=await fixture('我的电脑乙',{WLAN:nic('192.168.1.6')});const c=await fixture('我的电脑甲',{WLAN:nic('192.168.1.8')});
 try{const host=f=>f.sent[0].records.find(x=>x.type===33).target;assert.notEqual(host(a),host(b));assert.equal(host(a),host(c));for(const label of host(a).split('.'))assert.ok(Buffer.byteLength(label)<=63);}finally{a.stop();b.stop();c.stop();}
});
test('discovery updates address advertisements when Wi-Fi changes and stops cleanly',async()=>{
 const f=await fixture('Desktop',{WLAN:nic('192.168.1.5')});await f.change({WLAN:nic('192.168.8.5')});
 assert.ok(f.sockets[0].closed);assert.ok(f.sent.some(x=>x.ip==='192.168.1.5'&&x.records.every(r=>r.ttl===0)));assert.ok(f.sent.some(x=>x.ip==='192.168.8.5'&&x.records.some(r=>r.type===1&&r.address==='192.168.8.5')));f.stop();f.stop();assert.ok(f.sockets.every(x=>x.closed));
});
