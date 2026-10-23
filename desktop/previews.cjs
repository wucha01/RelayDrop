'use strict';
const fs=require('node:fs/promises'),streams=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const {pathToFileURL,fileURLToPath}=require('node:url'),{WebContentsView}=require('electron');
const {Readable}=require('node:stream');
const {imageDimensions,safeDimensions,previewKind}=require('../file-pool.cjs');
const MiB=1024*1024,signature=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
async function createThumbnail(filePath,file,signal,options={}){
 signal?.throwIfAborted();
 const kind=previewKind(file),mode=options.mode||'thumbnail',page=options.page||1,edge=mode==='detail'?1280:320,maximum=mode==='detail'?MiB:300*1024,limit=kind==='video'?512*MiB:kind==='pdf'?128*MiB:32*MiB;
 if(!['image','pdf','video'].includes(kind)||!['thumbnail','detail'].includes(mode)||!Number.isSafeInteger(page)||page<1||page>1000||kind!=='pdf'&&page!==1)throw new Error('PREVIEW_UNAVAILABLE');
 const location=await fs.realpath(filePath),stat=await fs.lstat(filePath);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.size||stat.size<1||stat.size>limit)throw new Error('PREVIEW_UNAVAILABLE');
 const hash=crypto.createHash('sha256');let length=0;
 for await(const chunk of streams.createReadStream(location,{highWaterMark:MiB,signal})){hash.update(chunk);length+=chunk.length;}
 if(length!==file.size||hash.digest('hex')!==file.sha256||signature(await fs.stat(location))!==signature(stat))throw new Error('PREVIEW_UNAVAILABLE');
 const bytes=kind==='video'?null:await fs.readFile(location,{signal});
 if(kind==='image'&&!safeDimensions(imageDimensions(bytes))||kind==='pdf'&&bytes.toString('ascii',0,5)!=='%PDF-')throw new Error('PREVIEW_UNAVAILABLE');
 const view=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'relay-preview-'+crypto.randomUUID(),backgroundThrottling:false}});
 const contents=view.webContents,vendor=path.resolve(__dirname,'../vendor'),sourceURL='relay-preview://original/'+crypto.randomBytes(24).toString('hex'),activeStreams=new Set();
 // A temporary session serves exactly one verified file at one unguessable URL.
 // No renderer receives a filesystem path, and no generic file: access is added.
 if(kind==='video')contents.session.protocol.handle('relay-preview',async request=>{
  if(request.url!==sourceURL||!['GET','HEAD'].includes(request.method)||signal?.aborted)return new Response(null,{status:404});
  if(signature(await fs.stat(location))!==signature(stat))return new Response(null,{status:409});
  let start=0,end=stat.size-1,status=200;const range=request.headers.get('range');
  if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m)return new Response(null,{status:416});start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size)return new Response(null,{status:416});status=206;}
  const headers={'Content-Type':/\.webm$/i.test(file.name)?'video/webm':'video/mp4','Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store','Access-Control-Allow-Origin':'null'};if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
  if(request.method==='HEAD')return new Response(null,{status,headers});const stream=streams.createReadStream(location,{start,end,signal});activeStreams.add(stream);stream.once('close',()=>activeStreams.delete(stream));return new Response(Readable.toWeb(stream),{status,headers});
 });
 contents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));contents.session.setPermissionCheckHandler(()=>false);
 contents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
  let allowed=/^(data:|blob:)/.test(details.url)||kind==='video'&&details.url===sourceURL&&details.resourceType==='media';
  try{if(details.url.startsWith('file:')){const local=fileURLToPath(details.url),relative=path.relative(vendor,local).replace(/\\/g,'/');allowed=['preview.html','pdf.mjs','pdf.worker.mjs'].includes(relative)||/^standard_fonts\/[a-zA-Z0-9_.-]+$/.test(relative);}}catch{allowed=false;}callback({cancel:!allowed});
 });
 contents.setWindowOpenHandler(()=>({action:'deny'}));let timer,encoded,onAbort;
 try{
  const decode=async()=>{
   await contents.loadFile(path.join(vendor,'preview.html'));const imageFormat=kind==='image'?imageDimensions(bytes).format:'';
   return contents.executeJavaScriptInIsolatedWorld(1002,[{code:`(async()=>{
    const kind=${JSON.stringify(kind)},edge=${edge},pageNumber=${page},base64=${JSON.stringify(bytes?.toString('base64')||'')};let source,documentTask,pdf,pageCount=1;
    try{
     if(kind==='pdf'){
      const lib=await import(${JSON.stringify(pathToFileURL(path.join(vendor,'pdf.mjs')).href)});lib.GlobalWorkerOptions.workerSrc=${JSON.stringify(pathToFileURL(path.join(vendor,'pdf.worker.mjs')).href)};
      documentTask=lib.getDocument({data:Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),isEvalSupported:false,disableFontFace:true,useWasm:false,useWorkerFetch:false,standardFontDataUrl:${JSON.stringify(pathToFileURL(path.join(vendor,'standard_fonts')).href+'/')},stopAtErrors:true,maxImageSize:40000000});pdf=await documentTask.promise;pageCount=pdf.numPages;if(pageCount>1000||pageNumber>pageCount)throw new Error('PREVIEW_PAGE_INVALID');
      const page=await pdf.getPage(pageNumber),initial=page.getViewport({scale:1});if(!initial.width||!initial.height||!Number.isFinite(initial.width*initial.height)||initial.width*initial.height>40000000)throw new Error('PREVIEW_UNAVAILABLE');const viewport=page.getViewport({scale:Math.min(2,edge/Math.max(initial.width,initial.height))});source=document.createElement('canvas');source.width=Math.max(1,Math.round(viewport.width));source.height=Math.max(1,Math.round(viewport.height));await page.render({canvasContext:source.getContext('2d',{alpha:false}),viewport,intent:'print',background:'rgb(255,255,255)'}).promise;
     }else if(kind==='video'){
      source=document.createElement('video');source.muted=true;source.crossOrigin='anonymous';source.preload='auto';source.src=${JSON.stringify(sourceURL)};await new Promise((resolve,reject)=>{source.onloadeddata=resolve;source.onerror=()=>reject(new Error('PREVIEW_UNAVAILABLE'));source.load();});if(!source.videoWidth||source.videoWidth*source.videoHeight>40000000)throw new Error('PREVIEW_UNAVAILABLE');if(Number.isFinite(source.duration)&&source.duration>0.2)await new Promise((resolve,reject)=>{source.onseeked=resolve;source.onerror=()=>reject(new Error('PREVIEW_UNAVAILABLE'));source.currentTime=Math.min(1,source.duration/10);});
     }else{source=new Image();await new Promise((resolve,reject)=>{source.onload=resolve;source.onerror=()=>reject(new Error('PREVIEW_UNAVAILABLE'));source.src='data:image/${imageFormat};base64,'+base64;});}
     const width=source.naturalWidth||source.videoWidth||source.width,height=source.naturalHeight||source.videoHeight||source.height;if(!width||!height||width*height>40000000)throw new Error('PREVIEW_UNAVAILABLE');const ratio=Math.min(1,edge/Math.max(width,height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));const context=canvas.getContext('2d',{alpha:false});context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(source,0,0,canvas.width,canvas.height);return{encoded:canvas.toDataURL('image/jpeg',0.82),pageCount};
    }catch(error){return {failure:String(error?.message||error),media:source?.error?.message};}finally{if(documentTask)await documentTask.destroy();if(kind==='video'&&source){source.pause();source.removeAttribute('src');source.load();}}
   })()`}]);
  };
  encoded=await Promise.race([decode(),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('PREVIEW_TIMEOUT')),20000);onAbort=()=>reject(new Error('PREVIEW_CANCELLED'));signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();})]);
 }finally{clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);for(const stream of activeStreams)stream.destroy();if(kind==='video')contents.session.protocol.unhandle('relay-preview');if(!contents.isDestroyed())contents.close({waitForBeforeUnload:false});}
 signal?.throwIfAborted();if(encoded?.failure)throw new Error(encoded.failure+' '+(encoded.media||''));if(signature(await fs.stat(location))!==signature(stat)||typeof encoded?.encoded!=='string'||!encoded.encoded.startsWith('data:image/jpeg;base64,')||encoded.encoded.length>maximum*4/3+32)throw new Error('PREVIEW_UNAVAILABLE');const jpeg=Buffer.from(encoded.encoded.slice(23),'base64'),info=imageDimensions(jpeg);if(!jpeg.length||jpeg.length>maximum||!safeDimensions(info,edge*edge)||info.width>edge||info.height>edge)throw new Error('PREVIEW_UNAVAILABLE');return{bytes:jpeg,pageCount:encoded.pageCount};
}
module.exports={createThumbnail};
