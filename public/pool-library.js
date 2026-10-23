/* Local shortcuts contain identifiers only; labels always come from authorized state. */
(function(root){
  'use strict';
  const STORAGE_KEY='relay-pool-library-v1',MAX_CONTEXTS=16,MAX_PINS=12,MAX_RECENT=30,MAX_STORAGE_BYTES=256*1024;
  const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
  const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
  const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value.toLowerCase():null;
  const active=value=>isObject(value)&&!value.deletedAt&&!value.deleted&&!value.trashed;
  function create({getContextKey=()=>'',storage,now=()=>Date.now()}={}){
    let memory=null,volatile=false;
    if(storage===undefined){try{storage=root.localStorage;}catch{storage=null;}}
    function timestamp(){const value=now();return Number.isSafeInteger(value)&&value>=0?value:Date.now();}
    function contextKey(){try{const value=getContextKey();return typeof value==='string'&&value.length>0&&value.length<=256&&!/[\s\u0000-\u001f\u007f]/.test(value)?value:'';}catch{return '';}}
    function read(){
      let raw=memory;
      if(!volatile&&storage){try{raw=storage.getItem(STORAGE_KEY);}catch{/* Preferences must not stop file access. */}}
      const empty={version:1,contexts:[]};
      if(typeof raw!=='string'||raw.length>MAX_STORAGE_BYTES)return empty;
      let saved;try{saved=JSON.parse(raw);}catch{return empty;}
      if(!isObject(saved)||saved.version!==1||!Array.isArray(saved.contexts))return empty;
      const latest=timestamp()+300000,validTime=value=>Number.isSafeInteger(value)&&value>=0&&value<=latest,seen=new Set();
      function records(values,kind,limit){
        if(!Array.isArray(values))return [];
        const ids=new Set(),result=[];
        for(const value of values){
          if(!isObject(value)||!validId(value.id)||!validTime(value.updatedAt)||ids.has(value.id))continue;
          const sha256=kind==='recent'?hash(value.sha256):null;if(kind==='recent'&&!sha256)continue;
          ids.add(value.id);result.push(kind==='recent'?{id:value.id,sha256,updatedAt:value.updatedAt}:{id:value.id,updatedAt:value.updatedAt});
        }
        return result.sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,limit);
      }
      const contexts=[];
      for(const value of saved.contexts){
        if(!isObject(value)||typeof value.id!=='string'||!value.id||value.id.length>256||/[\s\u0000-\u001f\u007f]/.test(value.id)||seen.has(value.id)||!validTime(value.updatedAt))continue;
        seen.add(value.id);contexts.push({id:value.id,updatedAt:value.updatedAt,pins:records(value.pins,'pins',MAX_PINS),recent:records(value.recent,'recent',MAX_RECENT)});
      }
      return {version:1,contexts:contexts.sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,MAX_CONTEXTS)};
    }
    function write(store){
      const encoded=JSON.stringify(store);memory=encoded;
      if(!storage)return;
      try{if(volatile||storage.getItem(STORAGE_KEY)!==encoded)storage.setItem(STORAGE_KEY,encoded);volatile=false;}catch{volatile=true;}
    }
    function authorized(state){
      if(!state||!Array.isArray(state.files)||!Array.isArray(state.folders))return null;
      const files=new Map(),folders=new Map();
      for(const file of state.files)if(active(file)&&validId(file.id)&&hash(file.sha256))files.set(file.id,file);
      for(const folder of state.folders)if(active(folder)&&validId(folder.id))folders.set(folder.id,folder);
      return {files,folders};
    }
    function current(state){
      const id=contextKey(),allowed=authorized(state);if(!id||!allowed)return null;
      const store=read(),entry=store.contexts.find(value=>value.id===id)||{id,updatedAt:timestamp(),pins:[],recent:[]};
      entry.pins=entry.pins.filter(value=>allowed.folders.has(value.id));
      entry.recent=entry.recent.filter(value=>hash(allowed.files.get(value.id)?.sha256)===value.sha256);
      return {store,entry,allowed};
    }
    function commit(value,touch=false){
      if(touch)value.entry.updatedAt=timestamp();
      value.store.contexts=value.store.contexts.filter(entry=>entry.id!==value.entry.id);
      if(value.entry.pins.length||value.entry.recent.length)value.store.contexts.unshift(value.entry);
      value.store.contexts.sort((a,b)=>b.updatedAt-a.updatedAt);value.store.contexts=value.store.contexts.slice(0,MAX_CONTEXTS);write(value.store);
    }
    function snapshot(state){
      const value=current(state);if(!value)return {pins:[],recent:[]};commit(value);
      return {pins:value.entry.pins.map(item=>value.allowed.folders.get(item.id)),recent:value.entry.recent.map(item=>({file:value.allowed.files.get(item.id),openedAt:item.updatedAt}))};
    }
    function isPinned(id,state){return snapshot(state).pins.some(folder=>folder.id===id);}
    function togglePin(id,state){
      const value=current(state);if(!value||!validId(id)||!value.allowed.folders.has(id))throw new Error('这个目录已不可用，请刷新文件池。');
      const pinned=value.entry.pins.some(item=>item.id===id);
      if(pinned)value.entry.pins=value.entry.pins.filter(item=>item.id!==id);
      else{if(value.entry.pins.length>=MAX_PINS)throw new Error('最多置顶 12 个常用目录，请先取消一个。');value.entry.pins.unshift({id,updatedAt:timestamp()});}
      commit(value,true);return !pinned;
    }
    function recordOpen(file,state){
      const value=current(state),expected=hash(file?.sha256),authorizedFile=value?.allowed.files.get(file?.id);
      if(!value||!authorizedFile||!expected||hash(authorizedFile.sha256)!==expected)return false;
      value.entry.recent=value.entry.recent.filter(item=>item.id!==file.id);
      value.entry.recent.unshift({id:file.id,sha256:expected,updatedAt:timestamp()});value.entry.recent=value.entry.recent.slice(0,MAX_RECENT);commit(value,true);return true;
    }
    function clearRecent(){
      const id=contextKey();if(!id)return;
      const store=read(),entry=store.contexts.find(value=>value.id===id);if(!entry)return;
      entry.recent=[];commit({store,entry},true);
    }
    return {snapshot,togglePin,isPinned,recordOpen,clearRecent};
  }
  const api={create,STORAGE_KEY,limits:Object.freeze({contexts:MAX_CONTEXTS,pins:MAX_PINS,recent:MAX_RECENT})};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.RelayLibrary=api;
})(typeof globalThis!=='undefined'?globalThis:this);
