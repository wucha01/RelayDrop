'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function safeName(value) {
  let name=String(value||'目录').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/g,'').slice(0,128).replace(/[\ud800-\udbff]$/,'');
  if(!name||name==='.'||name==='..')name='目录';
  if(/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))name='_'+name;
  return name;
}
function planFolder(state,folderId=null) {
  if(folderId!==null&&(typeof folderId!=='string'||!UUID.test(folderId)))throw new Error('共享目录无效。');
  if(!Array.isArray(state?.folders)||!Array.isArray(state?.files)||state.folders.length>5000)throw new Error('共享目录信息无效。');
  const index=new Map();for(const folder of state.folders){if(!folder||!UUID.test(folder.id)||index.has(folder.id)||folder.parentId!=null&&!UUID.test(folder.parentId)||typeof folder.name!=='string')throw new Error('共享目录信息无效。');index.set(folder.id,folder);}
  if(folderId&&!index.has(folderId))throw new Error('共享目录已移除，请刷新后重试。');
  const descendants=new Set([folderId]),directories=[];
  for(const folder of index.values()){
    let current=folder,depth=0,within=false;const seen=new Set();
    while(current){if(seen.has(current.id)||++depth>32)throw new Error('共享目录层级无效。');seen.add(current.id);if(current.id===folderId)within=true;if(current.parentId==null){current=null;break;}current=index.get(current.parentId);if(!current)throw new Error('共享目录层级不完整。');}
    if(folderId===null||within){descendants.add(folder.id);if(folder.id!==folderId)directories.push({...folder});}
  }
  // Parent-first ordering also handles servers returning folders in arbitrary order.
  const ordered=[],pending=directories.slice(),ready=new Set([folderId]);
  while(pending.length){const at=pending.findIndex(folder=>ready.has(folder.parentId??null));if(at<0)throw new Error('共享目录层级无效。');const [folder]=pending.splice(at,1);ordered.push(folder);ready.add(folder.id);}
  const files=state.files.filter(file=>!file.targetId&&descendants.has(file.folderId??null));
  if(files.length>2000||files.some(file=>!UUID.test(file.id)))throw new Error('整目录保存最多支持 2000 个文件，请分目录保存。');
  return {folderId,name:folderId?index.get(folderId).name:'共享文件池',directories:ordered,files:files.map(file=>({fileId:file.id,folderId:file.folderId??null}))};
}
async function materialize(plan,parent,{signal}={}){
  const check=()=>signal?.throwIfAborted();check();
  const base=await fs.realpath(parent),parentStat=await fs.lstat(parent);
  if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||base.toLowerCase()!==path.resolve(parent).toLowerCase())throw new Error('保存目录已被替换。');
  const identities=new Map(),paths=new Map();
  async function remember(directory){const real=await fs.realpath(directory),stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||real.toLowerCase()!==directory.toLowerCase())throw new Error('保存目录已被替换。');identities.set(directory,{dev:stat.dev,ino:stat.ino});}
  await remember(base);
  async function verify(directory){check();const identity=identities.get(directory),stat=await fs.lstat(directory),real=await fs.realpath(directory);if(!identity||!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==identity.dev||stat.ino!==identity.ino||real.toLowerCase()!==directory.toLowerCase())throw new Error('保存目录已被移动或替换。');}
  async function make(parentPath,name){await verify(parentPath);const safe=safeName(name);for(let n=0;n<10000;n++){check();const directory=path.join(parentPath,safe+(n?' ('+(n+1)+')':''));try{await fs.mkdir(directory);await remember(directory);return directory;}catch(error){if(error.code!=='EEXIST')throw error;}}throw new Error('同名目录过多。');}
  const root=await make(base,plan.name);paths.set(plan.folderId,root);
  for(const folder of plan.directories)paths.set(folder.id,await make(paths.get(folder.parentId??null),folder.name));
  return {root,directories:paths.size,async directory(folderId){const directory=paths.get(folderId);if(!directory)throw new Error('保存目录不存在。');for(const [candidate]of identities)if(directory===candidate||directory.startsWith(candidate+path.sep))await verify(candidate);return directory;}};
}
module.exports={planFolder,materialize,safeName};
