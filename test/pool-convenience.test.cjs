'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,summary,folderSnapshot}=require('../public/pool-convenience.js');
test('Folder save scope includes descendants and empty folders but excludes directed and unrelated originals',()=>{
 const state={folders:[{id:'a',name:'课程',parentId:null},{id:'b',name:'空目录',parentId:'a'},{id:'c',name:'作业',parentId:'a'},{id:'d',name:'其他',parentId:null}],files:[{id:'1',size:10,folderId:'a'},{id:'2',size:20,folderId:'c'},{id:'3',size:30,folderId:'d'},{id:'private',size:40,targetId:'peer',folderId:null}]};
 const selected=folderSnapshot(state,'a');assert.deepEqual(selected.files.map(f=>f.id),['1','2']);assert.deepEqual(selected.folders.map(f=>f.id),['a','b','c']);assert.equal(selected.totalBytes,30);assert.throws(()=>folderSnapshot(state,'removed'),/不可用/);assert.deepEqual(folderSnapshot(state,null).files.map(f=>f.id),['1','2','3']);
});
test('Pool task feedback rejects other device contexts and strips sensitive fields',()=>{
 const items=normalize('android',[{id:'a',context:'host:peer1',name:'private',status:'done'},{id:'b',context:'host:peer2',name:'report',status:'saving',kind:'save',doneBytes:20,totalBytes:40,path:'C:/private',token:'secret',uri:'content://private'}],'host:peer2');assert.equal(items.length,1);assert.equal(items[0].percent,50);assert.equal(items[0].kind,'save');assert.doesNotMatch(JSON.stringify(items),/secret|content:|C:\/private|host:peer1/);
});
test('Task counters distinguish waiting, paused, failed and verified completion',()=>{
 const tasks=normalize('browser',[{localId:1,state:'uploading',size:100,offset:35},{localId:2,state:'error',error:'network'},{localId:3,state:'paused'},{localId:4,state:'done',result:{id:'original'}}],'pool:host');assert.deepEqual(summary(tasks),{active:1,paused:1,failed:1,completed:1});assert.equal(tasks[3].fileId,'original');assert.equal(tasks[0].percent,35);
});
