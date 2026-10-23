'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Library=require('../public/pool-library.js');
const H='a'.repeat(64),OTHER='b'.repeat(64);
function fixture(){
  const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};
  let key='pool-A:device-A',time=1000;
  const library=Library.create({storage,getContextKey:()=>key,now:()=>++time});
  const state={folders:[{id:'course',name:'课程资料',parentId:null},{id:'math',name:'高数',parentId:'course'}],files:[{id:'file-A',name:'课件.pdf',sha256:H,size:100,folderId:'math'}]};
  return {library,state,data,storage,key:Library.STORAGE_KEY,setContext:value=>{key=value},store:()=>JSON.parse(data.get(Library.STORAGE_KEY)||'null')};
}
test('pool library pins resolve current names and moved paths without persisting labels',()=>{
  const f=fixture();assert.equal(f.library.togglePin('math',f.state),true);assert.equal(f.library.isPinned('math',f.state),true);
  f.state.folders[1].name='新高数目录';f.state.folders[1].parentId=null;
  assert.equal(f.library.snapshot(f.state).pins[0],f.state.folders[1]);assert.equal(f.library.snapshot(f.state).pins[0].name,'新高数目录');
  assert.doesNotMatch(f.data.get(f.key),/高数|课程|parentId|name/);assert.equal(f.library.togglePin('math',f.state),false);assert.deepEqual(f.library.snapshot(f.state).pins,[]);
});
test('pool library isolates pools and devices and restores only their own records',()=>{
  const f=fixture();f.library.togglePin('math',f.state);f.library.recordOpen(f.state.files[0],f.state);
  for(const key of ['pool-B:device-A','pool-A:device-B']){f.setContext(key);assert.deepEqual(f.library.snapshot(f.state),{pins:[],recent:[]});}
  f.setContext('pool-A:device-A');assert.equal(f.library.snapshot(f.state).pins[0].id,'math');assert.equal(f.library.snapshot(f.state).recent[0].file.id,'file-A');
});
test('pool library prunes revoked, deleted and trashed objects and never replays stale hashes',()=>{
  const f=fixture();const file=f.state.files[0];f.library.togglePin('math',f.state);f.library.recordOpen(file,f.state);
  assert.equal(f.library.recordOpen({...file,sha256:OTHER},f.state),false);f.state.files[0]={...file,sha256:OTHER};assert.deepEqual(f.library.snapshot(f.state).recent,[]);
  assert.equal(f.library.recordOpen(f.state.files[0],f.state),true);f.state.files[0].deletedAt='2026-10-23T00:00:00Z';f.state.folders=f.state.folders.filter(folder=>folder.id!=='math');
  assert.deepEqual(f.library.snapshot(f.state),{pins:[],recent:[]});assert.throws(()=>f.library.togglePin('math',f.state),/不可用/);
  delete f.state.files[0].deletedAt;f.library.recordOpen(f.state.files[0],f.state);f.state.files=[];assert.deepEqual(f.library.snapshot(f.state).recent,[]);
  f.state.files=[file];assert.deepEqual(f.library.snapshot(f.state).recent,[],'revoked record does not reappear after re-authorization');
});
test('pool library treats incomplete loading state as unavailable without erasing records',()=>{
  const f=fixture();f.library.togglePin('math',f.state);f.library.recordOpen(f.state.files[0],f.state);const before=f.data.get(f.key);
  for(const state of [null,{}, {files:[]},{folders:[]},{files:null,folders:[]}])assert.deepEqual(f.library.snapshot(state),{pins:[],recent:[]});
  assert.equal(f.data.get(f.key),before);assert.equal(f.library.snapshot(f.state).recent.length,1);
  f.setContext('');assert.deepEqual(f.library.snapshot(f.state),{pins:[],recent:[]});assert.equal(f.library.recordOpen(f.state.files[0],f.state),false);f.library.clearRecent();assert.equal(f.data.get(f.key),before);
});
test('pool library clear history affects only the active context, not pins or original files',()=>{
  const f=fixture();f.library.togglePin('math',f.state);f.library.recordOpen(f.state.files[0],f.state);f.setContext('pool-B:device-A');f.library.recordOpen(f.state.files[0],f.state);const originals=JSON.stringify(f.state);
  f.setContext('pool-A:device-A');f.library.clearRecent();assert.equal(f.library.snapshot(f.state).recent.length,0);assert.equal(f.library.snapshot(f.state).pins.length,1);assert.equal(JSON.stringify(f.state),originals);
  f.setContext('pool-B:device-A');assert.equal(f.library.snapshot(f.state).recent.length,1);
});
test('pool library bounds pins and recent records and moves a reopened file to the front',()=>{
  const f=fixture();f.state.folders=Array.from({length:13},(_,i)=>({id:'folder-'+i,name:'Folder '+i}));f.state.files=Array.from({length:35},(_,i)=>({id:'file-'+i,name:'File '+i,sha256:H}));
  for(const folder of f.state.folders.slice(0,12))f.library.togglePin(folder.id,f.state);
  assert.throws(()=>f.library.togglePin('folder-12',f.state),/最多置顶 12/);f.library.togglePin('folder-0',f.state);f.library.togglePin('folder-12',f.state);assert.equal(f.library.snapshot(f.state).pins.length,12);
  for(const file of f.state.files)f.library.recordOpen(file,f.state);
  assert.deepEqual(f.library.snapshot(f.state).recent.map(item=>item.file.id),f.state.files.slice(5).reverse().map(file=>file.id));
  f.library.recordOpen(f.state.files[10],f.state);assert.equal(f.library.snapshot(f.state).recent[0].file.id,'file-10');assert.equal(f.library.snapshot(f.state).recent.length,30);
});
test('pool library retains at most sixteen recently used contexts',()=>{
  const f=fixture();for(let i=0;i<20;i++){f.setContext('pool-'+i+':device-A');f.library.recordOpen(f.state.files[0],f.state);}
  assert.equal(f.store().contexts.length,16);assert.equal(f.store().contexts[0].id,'pool-19:device-A');assert.equal(f.store().contexts.at(-1).id,'pool-4:device-A');
  f.setContext('pool-0:device-A');assert.deepEqual(f.library.snapshot(f.state).recent,[]);f.setContext('pool-4:device-A');f.library.recordOpen(f.state.files[0],f.state);assert.equal(f.store().contexts[0].id,'pool-4:device-A');
});
test('pool library sanitizes tampered storage, duplicate records and prototype-shaped keys',()=>{
  const f=fixture();f.data.set(f.key,JSON.stringify({version:1,password:'secret-token',contexts:[{id:'pool-A:device-A',updatedAt:900,name:'Hidden title',pins:[{id:'math',updatedAt:800,name:'Hidden name'},{id:'math',updatedAt:900},{id:'no-access',updatedAt:500},{id:'invalid space',updatedAt:700}],recent:[{id:'file-A',sha256:H,updatedAt:800,token:'credential'},{id:'file-A',sha256:H,updatedAt:900},{id:'file-B',sha256:H,updatedAt:900},{id:'file-X',sha256:'oops',updatedAt:900}]}]}));
  const view=f.library.snapshot(f.state);assert.equal(view.pins.length,1);assert.equal(view.recent.length,1);assert.doesNotMatch(f.data.get(f.key),/secret|Hidden|credential|token|password|name|no-access|invalid space|file-B|file-X/);
  f.setContext('__proto__');f.library.recordOpen(f.state.files[0],f.state);assert.equal(f.library.snapshot(f.state).recent.length,1);assert.equal({}.recent,undefined);
});
test('pool library fails closed for malformed, oversized and unsupported stored state',()=>{
  for(const value of ['{broken','null','[]','"text"',JSON.stringify({version:2,contexts:[]}),JSON.stringify({version:1,contexts:'oops'}),' '.repeat(256*1024+1)]){
    const f=fixture();f.data.set(f.key,value);assert.deepEqual(f.library.snapshot(f.state),{pins:[],recent:[]});assert.equal(f.library.recordOpen(f.state.files[0],f.state),true);
  }
});
test('pool library storage denial or quota failure does not interrupt in-session shortcuts',()=>{
  let stored=null;const storage={getItem:()=>stored,setItem:()=>{throw Error('QuotaExceededError')}};
  const state={folders:[{id:'math'}],files:[{id:'file-A',sha256:H}]};const library=Library.create({storage,getContextKey:()=> 'pool:device',now:()=>1000});
  assert.equal(library.togglePin('math',state),true);assert.equal(library.recordOpen(state.files[0],state),true);assert.equal(library.snapshot(state).pins.length,1);assert.equal(library.snapshot(state).recent.length,1);
  storage.setItem=(_key,value)=>{stored=value};library.recordOpen(state.files[0],state);assert.ok(stored);assert.equal(library.snapshot(state).recent.length,1);
  const denied=Library.create({getContextKey:()=> 'pool:device',storage:{getItem(){throw Error('Denied')},setItem(){throw Error('Denied')}}});assert.equal(denied.recordOpen(state.files[0],state),true);assert.equal(denied.snapshot(state).recent.length,1);
});
test('pool library accepts only authorized valid hashes and stores no filenames or credentials',()=>{
  const f=fixture();f.state.files[0].name='<script>secret-name</script>';f.state.files[0].token='do-not-store-token';f.state.files[0].sha256=H.toUpperCase();assert.equal(f.library.recordOpen(f.state.files[0],f.state),true);
  assert.equal(f.library.recordOpen({id:'not-authorized',sha256:H},f.state),false);assert.equal(f.library.recordOpen({id:'file-A',sha256:'malformed'},f.state),false);assert.equal(f.store().contexts[0].recent[0].sha256,H);assert.doesNotMatch(f.data.get(f.key),/secret-name|do-not-store-token|script|Bearer/);
});
test('pool library UMD export works without browser storage access',()=>{
  const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/pool-library.js'),'utf8'),context);
  assert.equal(typeof context.RelayLibrary.create,'function');const library=context.RelayLibrary.create({getContextKey:()=> 'pool:device'});assert.equal(library.recordOpen({id:'file-A',sha256:H},{files:[{id:'file-A',sha256:H}],folders:[]}),true);assert.equal(library.snapshot({files:[{id:'file-A',sha256:H}],folders:[]}).recent.length,1);
});
test('pool library instances observe the latest shared storage without stale in-memory overwrite',()=>{
  const f=fixture(),other=Library.create({storage:f.storage,getContextKey:()=> 'pool-A:device-A',now:()=>2000});
  f.library.togglePin('math',f.state);assert.equal(other.snapshot(f.state).pins.length,1);other.recordOpen(f.state.files[0],f.state);
  f.library.togglePin('course',f.state);assert.equal(other.snapshot(f.state).pins.length,2);assert.equal(other.snapshot(f.state).recent.length,1);
  other.clearRecent();assert.equal(f.library.snapshot(f.state).recent.length,0);assert.equal(f.library.snapshot(f.state).pins.length,2);
});
test('pool library rejects future and malformed timestamps and clamps oversized stored collections',()=>{
  const f=fixture();f.state.folders=Array.from({length:20},(_,i)=>({id:'folder-'+i}));f.state.files=Array.from({length:40},(_,i)=>({id:'file-'+i,sha256:H}));
  f.data.set(f.key,JSON.stringify({version:1,contexts:[{id:'pool-A:device-A',updatedAt:900,pins:[...f.state.folders.map((folder,i)=>({id:folder.id,updatedAt:500+i})),{id:'math',updatedAt:Number.MAX_SAFE_INTEGER}],recent:[...f.state.files.map((file,i)=>({id:file.id,sha256:H,updatedAt:500+i})),{id:'file-A',sha256:H,updatedAt:'now'}]},{id:'future:device',updatedAt:Number.MAX_SAFE_INTEGER,pins:[],recent:[]}]}));
  const view=f.library.snapshot(f.state);assert.equal(view.pins.length,12);assert.equal(view.recent.length,30);assert.equal(f.store().contexts.length,1);assert.equal(view.recent[0].file.id,'file-39');
});
