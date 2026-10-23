/* Bounded, identity-scoped navigation. Selection belongs to the current pool, not a history entry. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RelayNavigation=api;})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  function snapshot(value={}){return {folder:typeof value.folder==='string'?value.folder.slice(0,128):null,view:['all','favorites','trash'].includes(value.view)?value.view:'all',category:typeof value.category==='string'?value.category.slice(0,32):'all',collection:typeof value.collection==='string'?value.collection.slice(0,64):'',sort:['newest','oldest','largest','smallest','name'].includes(value.sort)?value.sort:'newest',query:typeof value.query==='string'?value.query.slice(0,200):'',scope:value.scope==='current'?'current':'all',scroll:Number.isFinite(value.scroll)?Math.max(0,Math.min(200000,value.scroll)):0,filters:value.filters===true,recents:value.recents===true};}
  function create(){const contexts=new Map();let context='';function stack(){return contexts.get(context)||[];}return {
    setContext(key){context=typeof key==='string'?key.slice(0,400):'';if(!context)return;if(!contexts.has(context))contexts.set(context,[]);const value=contexts.get(context);contexts.delete(context);contexts.set(context,value);while(contexts.size>16)contexts.delete(contexts.keys().next().value);},
    push(value){if(!context)return;const items=stack(),next=snapshot(value);if(JSON.stringify(items.at(-1))!==JSON.stringify(next))items.push(next);if(items.length>50)items.shift();},
    pop(isAvailable=()=>true){const items=stack();while(items.length){const value=items.pop();if(!value.folder||isAvailable(value.folder))return snapshot(value);}return null;},
    hasBack(){return stack().length>0;},
    clear(){contexts.clear();context='';}
  };}
  return {create,snapshot};
});
