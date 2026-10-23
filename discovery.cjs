'use strict';
// Minimal DNS-SD responder for Android NSD. Discovery is advisory; pairing is still required.
const dgram=require('node:dgram'),os=require('node:os'),crypto=require('node:crypto');
const service='_relaydrop._tcp.local';
function name(s){return Buffer.concat(s.replace(/\.$/,'').split('.').map(x=>{const b=Buffer.from(x);return Buffer.concat([Buffer.from([b.length]),b]);}).concat(Buffer.from([0])));}
function rr(n,type,data,ttl=120){const h=Buffer.alloc(10);h.writeUInt16BE(type);h.writeUInt16BE(type===12?1:0x8001,2);h.writeUInt32BE(ttl,4);h.writeUInt16BE(data.length,8);return Buffer.concat([name(n),h,data]);}
function addresses(){return Object.entries(os.networkInterfaces()).flatMap(([iface,rows])=>(rows||[]).filter(a=>a.family==='IPv4'&&!a.internal&&!a.address.startsWith('169.254.')&&!a.mac.startsWith('0a:00:27:')&&!/virtual|vmware|virtualbox|vpn|tun|zerotier|radmin|loopback/i.test(iface)).map(a=>a.address));}
exports.startDiscovery=function(port,identity){
 const originalName=os.hostname();
 // Keep names stable and distinct when Unicode names sanitize to the same label.
 const machine=(originalName.replace(/[^a-zA-Z0-9-]/g,'').slice(0,26)||'device')+'-'+crypto.createHash('sha256').update(originalName).digest('hex').slice(0,10);
 const instance=`RelayDrop-${machine}.${service}`,host=`relaydrop-${machine}.local`;
 const channels=new Map();let closed=false;
 function packet(ip,ttl=120){const srv=Buffer.alloc(6);srv.writeUInt16BE(port,4);const hints=identity?['version=2','tls=1','id='+identity.serverId,'fp='+identity.fingerprint]:['version=1'];const txt=Buffer.concat(hints.map(value=>{const b=Buffer.from(value);return Buffer.concat([Buffer.from([b.length]),b]);}));const rows=[rr(service,12,name(instance),ttl),rr(instance,33,Buffer.concat([srv,name(host)]),ttl),rr(instance,16,txt,ttl),rr(host,1,Buffer.from(ip.split('.').map(Number)),ttl)];const header=Buffer.alloc(12);header.writeUInt16BE(0x8400,2);header.writeUInt16BE(rows.length,6);return Buffer.concat([header,...rows]);}
 // Group membership selects incoming traffic only. Explicit outgoing interfaces are
 // essential on Windows when a VPN owns the default route. Keep one socket per
 // interface so asynchronous sends cannot race with setMulticastInterface().
 function addChannel(ip){
  const sock=dgram.createSocket({type:'udp4',reuseAddr:true});
  const channel={sock,ready:false,stopped:false,lastSent:0};channels.set(ip,channel);
  channel.announce=(ttl=120)=>{if(!channel.ready||channel.stopped)return;try{sock.send(packet(ip,ttl),5353,'224.0.0.251',()=>{});}catch{}};
  channel.stop=()=>{if(channel.stopped)return;channel.announce(0);channel.stopped=true;try{sock.close();}catch{}};
  sock.on('error',()=>{channel.stop();if(channels.get(ip)===channel)channels.delete(ip);});
  sock.on('message',msg=>{if(msg.length<12||(msg.readUInt16BE(2)&0x8000)||Date.now()-channel.lastSent<400)return;const asText=msg.toString('latin1');if(asText.includes('_relaydrop')||asText.includes('relaydrop-'+machine)){channel.lastSent=Date.now();channel.announce();}});
  sock.bind(5353,()=>{if(closed||channel.stopped){try{sock.close();}catch{}return;}try{sock.addMembership('224.0.0.251',ip);sock.setMulticastInterface(ip);sock.setMulticastTTL(255);sock.setMulticastLoopback(true);channel.ready=true;channel.announce();}catch{channel.stop();if(channels.get(ip)===channel)channels.delete(ip);}});sock.unref();
 }
 function refresh(){if(closed)return;const current=new Set(addresses());for(const [ip,channel]of channels)if(!current.has(ip)){channel.stop();channels.delete(ip);}for(const ip of current)if(!channels.has(ip))addChannel(ip);else channels.get(ip).announce();}
 refresh();const timer=setInterval(refresh,60000);timer.unref();
 return ()=>{if(closed)return;closed=true;clearInterval(timer);for(const channel of channels.values())channel.stop();channels.clear();};
};
