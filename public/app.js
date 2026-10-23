/* RelayDrop — browser client. No cloud dependencies. */
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const icons = {
    transfer:'<path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/>',
    note:'<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6"/>',
    devices:'<rect x="2" y="4" width="14" height="11" rx="2"/><path d="M6 19h6m-3-4v4"/><rect x="16" y="9" width="6" height="12" rx="1.5"/>',
    bluetooth:'<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
    upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
    download:'<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    shield:'<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7v.1"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    refresh:'<path d="M20 7v5h-5M4 17v-5h5M5.5 7A8 8 0 0 1 19 6l1 6M4 12l1 6a8 8 0 0 0 13.5-1"/>',
    copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    pause:'<path d="M8 5v14M16 5v14"/>',
    play:'<path d="m8 4 12 8-12 8z"/>',
    check:'<path d="m5 12 5 5L20 7"/>',
    trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
    file:'<path d="M5 3h9l5 5v13H5zM14 3v6h5"/>',
    phone:'<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
    laptop:'<rect x="4" y="3" width="16" height="13" rx="2"/><path d="m4 16-2 4h20l-2-4"/>',
    external:'<path d="M14 3h7v7M21 3 11 13M10 3H3v18h18v-7"/>',
    inbox:'<path d="m4 3-2 11v7h20v-7L20 3zM2 14h6l2 3h4l2-3h6"/>',
    star:'<path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2L2.9 9.6l6.3-.9z"/>',
    folder:'<path d="M3 6h7l2 2h9v12H3zM3 6V4h7l2 2"/>',
    restore:'<path d="M4 4v6h6M4 10a8 8 0 1 1 0 7M12 7v5l3 2"/>'
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
  document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  const escape = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const storage = {
    get(key, session = false) { try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; } },
    set(key, value, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, value); } catch {} },
    remove(key, session = false) { try { (session ? sessionStorage : localStorage).removeItem(key); } catch {} }
  };
  const fragment = new URLSearchParams(location.hash.slice(1));
  const hostToken = fragment.get('host');
  const initialCode = fragment.get('code');
  if (hostToken) { storage.set('relay-host-token', hostToken, true); history.replaceState({}, '', location.pathname + location.search + '#pool'); }
  if (initialCode) { $('pair-code').value = initialCode.replace(/\D/g, '').slice(0, 6); history.replaceState({}, '', location.pathname + location.search); }
  let token = hostToken || storage.get('relay-host-token', true) || storage.get('relay-guest-token');
  let state = null;
  let activeTab = ['pool','transfer','notes','devices','bluetooth'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'pool';
  let polling = false, stopped = false, connected = true;
  let lastRender = '', lastQr = '', selectedAddress = '', fileQuery = '';
  let fileListSignature = '', noteListSignature = '';
  const selectedFiles = new Set();
  let downloadingBatch = false;
  let searchScope='all',batchRunning=false,batchPlan=null,batchStopRequested=false,batchReport=null;
  let tasks = [], sequence = 0;
  const queueRows = new Map(), completedSelections = new Map();
  let pendingResumeSignature = '';
  let confirmResolve = null;
  let detailFile = null, localVerification = null;
  const desktop = typeof window.relayDesktop?.saveFile === 'function' ? window.relayDesktop : null;
  const nativeSaves = new Map(), nativeSaveRows = new Map();
  let detailNativeRequest = null, desktopBatchStopped = false, desktopBatchRequest = null, lastActivity = '';
  let fileCategory='all',nativeBatch=null,desktopSettings=null;
  let poolView='all',fileCollection='',fileSort='newest',collectionFile=null;
  const nativeIncoming=new Map(),pendingFileChanges=new Set();
  const androidBackground=/RelayDropAndroid\/\d+\.\d+(?:\D|$)/.test(navigator.userAgent);
  $('file-list').classList.toggle('native-copy-layout',!!desktop||androidBackground);
  const pool=window.RelayPool?.create({getToken:()=>token,getContextKey:()=>poolContextKey(),onSave:async id=>{if(desktop){const result=await startNativeSave(id);if(result.status==='cancelled')return {canceled:true};if(result.status!=='completed')throw new Error('保存未完成，请在保存任务中查看原因。');return;}if(!await downloadFile(id))throw new Error('未能提交保存请求，请重试。');},onFavorite:async id=>{const file=state?.files?.find(f=>f.id===id);if(!file||!poolOrganized())throw new Error('文件已不可用，请刷新后重试。');if(pendingFileChanges.has(id))throw new Error('正在更新此文件，请稍后重试。');pendingFileChanges.add(id);try{await api('/api/files/'+encodeURIComponent(id),{method:'PATCH',body:{favorite:!file.favorite}});await refresh(true);return state?.files?.find(f=>f.id===id);}finally{pendingFileChanges.delete(id);}},canFavorite:()=>poolOrganized(),onOpen:file=>{library?.recordOpen(file,state);renderLibrary();},onInfo:id=>{const file=state?.files?.find(f=>f.id===id);if(file){$('preview-dialog').close();showFileDetails(file);}}});
  const API_TIMEOUT = 90000;

  let currentFolder=null,folderAction=null,folderBusy=false;
  const library=window.RelayLibrary?.create({getContextKey:()=>state?poolContextKey():''});
  let viewContext='',poolScroll=0,restoreScrollPending=false,viewSaveTimer=null;
  function poolContextKey(){const id=state?.security?.serverId||state?.network?.serverId;return id?String(id)+':'+String(state?.device?.id||'guest'):location.origin+':'+String(state?.device?.id||'guest');}
  function readViewStore(){try{const parsed=JSON.parse(storage.get('relay-pool-views-v1')||'{}');return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}}
  function savePoolView(){if(!state||!viewContext)return;const views=readViewStore();views[viewContext]={updated:Date.now(),folder:currentFolder,view:poolView,category:fileCategory,collection:fileCollection,sort:fileSort,query:fileQuery.slice(0,200),scope:searchScope,scroll:poolScroll,filters:filterPanelOpen,recents:recentsExpanded};const recent=Object.entries(views).filter(([key,value])=>key.length<400&&value&&Number.isFinite(value.updated)).sort((a,b)=>b[1].updated-a[1].updated).slice(0,16);storage.set('relay-pool-views-v1',JSON.stringify(Object.fromEntries(recent)));}
  function restorePoolView(){const key=poolContextKey();if(viewContext===key)return;viewContext=key;navigation.setContext(key);resetLocalCopies();selectedFiles.clear();if(batchRunning)batchStopRequested=true;const saved=readViewStore()[key]||{};filterPanelOpen=saved.filters===true;recentsExpanded=saved.recents===true;currentFolder=state.folders?.some(f=>f.id===saved.folder)?saved.folder:null;poolView=['all','favorites','trash'].includes(saved.view)?saved.view:'all';fileCategory=(window.RelayPool?.categories||[]).some(c=>c[0]===saved.category)?saved.category:'all';fileSort=['newest','oldest','largest','smallest','name'].includes(saved.sort)?saved.sort:'newest';fileCollection=typeof saved.collection==='string'?saved.collection.slice(0,64):'';fileQuery=typeof saved.query==='string'?saved.query.slice(0,200):'';searchScope=saved.scope==='current'?'current':'all';$('file-search-scope').value=searchScope;poolScroll=Number.isFinite(saved.scroll)?Math.max(0,Math.min(200000,saved.scroll)):0;$('file-search').value=fileQuery;$('file-sort').value=fileSort;restoreScrollPending=true;fileListSignature='';}
  function restorePoolScroll(){if(activeTab!=='pool'||!state)return;const target=poolScroll;requestAnimationFrame(()=>requestAnimationFrame(()=>{if(activeTab==='pool'){window.scrollTo(0,target);restoreScrollPending=false;}}));}
  window.addEventListener('scroll',()=>{if(activeTab!=='pool'||!state||restoreScrollPending)return;poolScroll=Math.max(0,window.scrollY);clearTimeout(viewSaveTimer);viewSaveTimer=setTimeout(savePoolView,200);},{passive:true});
  window.addEventListener('pagehide',()=>{clearTimeout(viewSaveTimer);savePoolView();});
  const folderBar=document.createElement('div');folderBar.id='shared-folders';folderBar.className='shared-folders';folderBar.hidden=true;
  folderBar.innerHTML='<div class="shared-folder-heading"><nav id="folder-breadcrumb" aria-label="共享目录路径"></nav><button id="new-shared-folder" class="button secondary small-button">新建共享目录</button></div><p class="micro">目录层级由所有已配对设备共享；私人分类和收藏仍只属于此设备。</p><div id="shared-folder-list" class="shared-folder-list"></div>';
  $('pool-management').before(folderBar);
  const folderSend=document.createElement('div');folderSend.className='folder-send';folderSend.innerHTML='<label for="upload-folder">放入共享目录</label><select id="upload-folder"></select><button id="choose-folder" class="button secondary small-button">发送整个文件夹</button><input id="folder-input" type="file" webkitdirectory multiple hidden><p id="folder-send-hint" class="micro">保留文件夹层级。指定设备的文件保存在根区，接收权限不会改变。</p>';
  document.querySelector('.send-card').appendChild(folderSend);
  const folderDialog=document.createElement('dialog');folderDialog.id='shared-folder-dialog';folderDialog.innerHTML='<form id="shared-folder-form"><div class="dialog-top"><h2 id="shared-folder-title"></h2><button type="button" class="icon-button" data-close="shared-folder-dialog" aria-label="关闭">✕</button></div><p id="shared-folder-description" class="micro"></p><label for="shared-folder-name">名称</label><input id="shared-folder-name" maxlength="128" autocomplete="off"><label for="shared-folder-parent">所在目录</label><select id="shared-folder-parent"></select><p id="shared-folder-error" class="field-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary" data-close="shared-folder-dialog">取消</button><button id="shared-folder-submit" class="button primary" type="submit">保存</button></div></form>';document.body.appendChild(folderDialog);
  function sharedFolders(){return state?.capabilities?.sharedFolders===true&&Array.isArray(state.folders);}
  function folderPath(id){const result=[],seen=new Set();while(id){if(seen.has(id))break;seen.add(id);const item=state?.folders?.find(f=>f.id===id);if(!item)break;result.unshift(item);id=item.parentId;}return result;}
  function folderOptions(){return '<option value="">共享根目录</option>'+(state?.folders||[]).map(f=>({id:f.id,path:folderPath(f.id).map(x=>x.name).join(' / ')})).sort((a,b)=>a.path.localeCompare(b.path,'zh-CN')).map(f=>'<option value="'+escape(f.id)+'">'+escape(f.path)+'</option>').join('');}
  function renderFolders(){
    const enabled=sharedFolders();folderBar.hidden=!enabled||poolView!=='all';folderSend.hidden=!enabled;
    if(!enabled)return;
    if(currentFolder&&!state.folders.some(f=>f.id===currentFolder))currentFolder=null;
    const options=folderOptions(),old=$('upload-folder').value,pinnedIds=new Set((library?.snapshot(state).pins||[]).map(f=>f.id));
    if($('upload-folder').innerHTML!==options){$('upload-folder').innerHTML=options;$('upload-folder').value=state.folders.some(f=>f.id===old)?old:(currentFolder||'');}
    const directed=!!$('file-target').value;$('upload-folder').disabled=directed;$('choose-folder').disabled=directed||folderBusy;
    $('folder-send-hint').textContent=directed?'指定设备的文件保存在根区，整文件夹请选择共享空间。':desktop?.chooseFolder?'整文件夹最多 300 个文件；保留子目录和空目录。':androidBackground?'通过系统目录选择器发送，保留子目录和空目录。':'保留最多 300 个文件的目录层级；此浏览器的目录选择器不会提供空目录。';
    $('folder-breadcrumb').innerHTML='<button class="text-button" data-enter-folder="">共享根目录</button>'+folderPath(currentFolder).map(f=>'<span>/</span><button class="text-button" data-enter-folder="'+escape(f.id)+'">'+escape(f.name)+'</button>').join('')+(currentFolder?'<button class="text-button" data-toggle-pin-folder="'+escape(currentFolder)+'" aria-pressed="'+!!pinnedIds.has(currentFolder)+'">'+(pinnedIds.has(currentFolder)?'★ 取消常用':'☆ 加入常用')+'</button>':'');
    $('shared-folder-list').innerHTML=state.folders.filter(f=>(f.parentId||null)===currentFolder).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true})).map(f=>{const manage=isHost()||f.createdBy===state.device.id;return '<div class="shared-folder"><button class="shared-folder-open" title="'+escape(f.name)+'" aria-label="打开目录 '+escape(f.name)+'" data-enter-folder="'+escape(f.id)+'">'+icon('folder')+'<span>'+escape(f.name)+'</span></button>'+'<button class="icon-button pin-folder '+(pinnedIds.has(f.id)?'active':'')+'" data-toggle-pin-folder="'+escape(f.id)+'" aria-pressed="'+!!pinnedIds.has(f.id)+'" title="'+(pinnedIds.has(f.id)?'取消常用目录':'加入常用目录')+'" aria-label="'+(pinnedIds.has(f.id)?'取消常用目录':'加入常用目录')+'">'+icon('star')+'</button>'+(manage?'<button class="icon-button" data-edit-folder="'+escape(f.id)+'" title="重命名或移动目录" aria-label="重命名或移动目录">'+icon('info')+'</button><button class="icon-button danger" data-remove-folder="'+escape(f.id)+'" title="删除空目录" aria-label="删除空目录">'+icon('trash')+'</button>':'')+'</div>';}).join('');
  }
  function editFolder(mode,id){
    folderAction={mode,id};const file=mode==='file'?state.files.find(f=>f.id===id):null,folder=mode==='edit'?state.folders.find(f=>f.id===id):null;
    if(mode==='file'&&pendingFileChanges.has(id)){toast('正在整理此文件，请稍后重试。','info');return;}
    if(mode==='file'&&(!file||file.targetId)){toast('定向文件不能放入共享目录，接收权限保持不变。','info');return;}
    $('shared-folder-title').textContent=mode==='new'?'新建共享目录':mode==='file'?'移动或重命名文件':'整理共享目录';$('shared-folder-description').textContent='更改会同步到其他已配对设备。文件内容与接收范围保持不变。';
    $('shared-folder-name').value=file?.name||folder?.name||'';$('shared-folder-name').maxLength=mode==='file'?255:128;$('shared-folder-parent').innerHTML=folderOptions();$('shared-folder-parent').value=file?.folderId||folder?.parentId||(mode==='new'?currentFolder:'')||'';$('shared-folder-error').hidden=true;$('shared-folder-submit').disabled=false;folderDialog.showModal();
  }
  $('shared-folder-form').addEventListener('submit',async event=>{event.preventDefault();const action=folderAction;if(!action)return;if(action.mode==='file'&&pendingFileChanges.has(action.id)){toast('正在整理此文件，请稍后重试。','info');return;}const lockedFile=action.mode==='file'?action.id:null;if(lockedFile)pendingFileChanges.add(lockedFile);$('shared-folder-submit').disabled=true;$('shared-folder-error').hidden=true;try{const name=$('shared-folder-name').value,parentId=$('shared-folder-parent').value||null;if(action.mode==='new')await api('/api/folders/ensure',{method:'POST',body:{parentId,path:[name]}});else if(action.mode==='edit')await api('/api/folders/'+action.id,{method:'PATCH',body:{name,parentId}});else await api('/api/files/'+action.id+'/location',{method:'PATCH',body:{name,folderId:parentId}});folderDialog.close();await refresh(true);toast('共享目录已更新');}catch(error){$('shared-folder-error').textContent=error.message;$('shared-folder-error').hidden=false;}finally{if(lockedFile)pendingFileChanges.delete(lockedFile);$('shared-folder-submit').disabled=false;}});
  $('new-shared-folder').addEventListener('click',()=>editFolder('new'));
  $('file-target').addEventListener('change',renderFolders);
  document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;const d=button.dataset;if(Object.hasOwn(d,'enterFolder')){navigateFolder(d.enterFolder||null);}if(d.editFolder)editFolder('edit',d.editFolder);if(d.moveFile)editFolder('file',d.moveFile);if(d.removeFolder){if(!await confirm('删除这个空目录？','只有不含文件、子目录、回收站文件和未完成任务的目录可以删除。','删除空目录'))return;try{await api('/api/folders/'+d.removeFolder,{method:'DELETE'});await refresh(true);}catch(error){toast(error.message,'error');}}});
  async function addDirectoryFiles(files){
    if(!state||!sharedFolders()||$('file-target').value)return;
    if(files.length>300){toast('一次最多发送 300 个文件，请分批选择。','error');return;}
    folderBusy=true;renderFolders();try{
      const paths=files.map(file=>{const parts=String(file.webkitRelativePath||file.name).split('/');if(parts.length<2||parts.length>33||parts.join('/').length>1024)throw new Error('文件夹层级或路径超出限制');return{file,parts:parts.slice(0,-1)};});
      const parentId=$('upload-folder').value||null,resolved=new Map();
      for(const {parts}of paths){const key=JSON.stringify(parts);if(!resolved.has(key)){const result=await api('/api/folders/ensure',{method:'POST',body:{parentId,path:parts}});resolved.set(key,result.folderId);}}
      for(const item of paths)addFiles([item.file],resolved.get(JSON.stringify(item.parts)),false);
      await refresh(true);goTab('transfer');renderQueue();pump();toast('已加入 '+files.length+' 个文件，目录层级已保留');
    }catch(error){toast(error.message||'目录未能加入','error');}finally{folderBusy=false;renderFolders();}
  }
  $('folder-input').addEventListener('change',event=>{const files=[...event.target.files];event.target.value='';if(files.length)void addDirectoryFiles(files);});
  $('choose-folder').addEventListener('click',async()=>{const folderId=$('upload-folder').value||null;if($('file-target').value)return;if(desktop?.chooseFolder){try{await desktop.chooseFolder({folderId});}catch(error){toast(error.message||'目录未能加入','error');}}else if(androidBackground){location.href='relaydrop://choose-folder?folderId='+encodeURIComponent(folderId||'')+'&target=';}else $('folder-input').click();});


    // Local navigation shortcuts and explicit, per-item organizing actions.
  const shortcuts=document.createElement('section');shortcuts.className='pool-shortcuts';
  shortcuts.innerHTML='<div class="shortcut-heading"><h3>常用目录</h3><span class="micro">仅此设备 · 最多 12 个</span></div><div id="pool-pins" class="pool-pins"></div><details class="recent-details" open><summary>最近打开 <span id="recent-file-count" class="number-pill">0</span></summary><div class="recent-heading"><span class="micro">仅记录主动预览，最多 30 项；PDF 和媒体沿用阅读进度。</span><button id="clear-recent-files" class="text-button">清空记录</button></div><div id="pool-recents" class="pool-recents"></div></details>';
  document.querySelector('.files-card').before(shortcuts);
  const searchTools=document.createElement('div');searchTools.className='search-scope-controls';searchTools.innerHTML='<label for="file-search-scope">搜索范围</label><select id="file-search-scope"><option value="all">整个文件池</option><option value="current">当前目录及子目录</option></select><button id="clear-file-search" class="text-button" hidden>清除搜索</button><p id="file-search-summary" class="micro" role="status" hidden></p>';
  document.querySelector('.pool-overview').before(searchTools);
  const folderResults=document.createElement('div');folderResults.id='folder-search-results';folderResults.className='folder-search-results';folderResults.hidden=true;$('file-category-filters').after(folderResults);
  const batchTools=document.createElement('div');batchTools.className='batch-tools';batchTools.innerHTML='<button id="batch-move" class="button secondary small-button" hidden>移动</button><button id="batch-favorite" class="button secondary small-button" hidden>收藏 / 取消</button><button id="batch-collection" class="button secondary small-button" hidden>私人分类</button><button id="batch-trash" class="button secondary small-button danger" hidden>移入回收站</button>';document.querySelector('.file-selection-bar').appendChild(batchTools);
  const batchPanel=document.createElement('section');batchPanel.id='batch-report';batchPanel.className='batch-report';batchPanel.hidden=true;batchPanel.innerHTML='<div class="shortcut-heading"><h3>整理结果</h3><button id="batch-stop" class="text-button danger">停止剩余项</button><button id="batch-clear-report" class="text-button">收起结果</button></div><p id="batch-progress-text" role="status" aria-live="polite"></p><ul id="batch-result-list"></ul>';$('file-list').before(batchPanel);
  const batchDialog=document.createElement('dialog');batchDialog.id='batch-dialog';batchDialog.setAttribute('aria-labelledby','batch-title');batchDialog.innerHTML='<form id="batch-form"><div class="dialog-top"><h2 id="batch-title">批量整理</h2><button type="button" class="icon-button" id="batch-close" aria-label="关闭">✕</button></div><p class="micro">逐项执行，可停止剩余任务；已完成操作不会回退。文件内容和接收范围保持不变。</p><div id="batch-folder-field"><label for="batch-folder">移动到共享目录</label><select id="batch-folder"></select></div><div id="batch-favorite-field"><label for="batch-favorite-mode">收藏操作</label><select id="batch-favorite-mode"><option value="true">加入收藏</option><option value="false">取消收藏</option></select></div><div id="batch-collection-field"><label for="batch-collection-name">私人分类</label><input id="batch-collection-name" maxlength="64" list="batch-collection-options" autocomplete="off" placeholder="选择或新建分类；留空可清除分类"><datalist id="batch-collection-options"></datalist></div><p id="batch-summary"></p><ul id="batch-preview-list"></ul><p id="batch-error" class="field-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" id="batch-cancel" class="button secondary">取消</button><button id="batch-confirm" type="submit" class="button primary">确认执行</button></div></form>';document.body.appendChild(batchDialog);
  const batchLabels={move:'移动到共享目录',favorite:'更改收藏',collection:'设置私人分类',trash:'移入回收站'};
  function pathLabel(file){return (file.targetId?'定向文件':'共享根目录')+(file.folderId?' / '+folderPath(file.folderId).map(f=>f.name).join(' / '):'')+' / '+file.name;}
  function inFolderTree(id,parent){return !parent||(id===parent)||folderPath(id).some(f=>f.id===parent);}
  function renderLibrary(){
    const data=library?.snapshot(state)||{pins:[],recent:[]};
    const pins=data.pins.map(f=>'<span class="pin-chip"><button class="text-button" data-pin-open="'+escape(f.id)+'" title="'+escape(folderPath(f.id).map(x=>x.name).join(' / '))+'">'+icon('folder')+escape(f.name)+'</button><button class="icon-button" data-toggle-pin-folder="'+escape(f.id)+'" title="取消常用目录" aria-label="取消常用目录 '+escape(f.name)+'">×</button></span>').join('')||'<span class="micro">点目录星标即可固定</span>';
    if($('pool-pins').innerHTML!==pins)$('pool-pins').innerHTML=pins;
    const recents=(recentsExpanded?data.recent:data.recent.slice(0,3)).map(({file,openedAt})=>'<button class="recent-file" data-recent-open="'+escape(file.id)+'" title="'+escape(pathLabel(file))+'"><span>'+escape(file.name)+'</span><small>'+escape(folderPath(file.folderId).map(f=>f.name).join(' / ')|| (file.targetId?'定向文件':'共享根目录'))+' · '+escape(date(openedAt,true))+'</small></button>').join('')||'<span class="micro">暂无记录</span>';
    if($('pool-recents').innerHTML!==recents)$('pool-recents').innerHTML=recents;
    $('recent-file-count').textContent=data.recent.length;$('clear-recent-files').disabled=!data.recent.length;
    $('more-recent-files').hidden=data.recent.length<=3;$('more-recent-files').textContent=recentsExpanded?'收起记录':'更多记录（'+data.recent.length+'）';$('more-recent-files').setAttribute('aria-expanded',String(recentsExpanded));renderBatchReport();
  }
  function renderSearch(files){
    const query=fileQuery.trim().toLocaleLowerCase();$('clear-file-search').hidden=!fileQuery;$('file-search-summary').hidden=!query;
    const folders=query&&sharedFolders()&&poolView==='all'?(state.folders||[]).filter(f=>(searchScope!=='current'||inFolderTree(f.id,currentFolder))&&folderPath(f.id).map(x=>x.name).join(' / ').toLocaleLowerCase().includes(query)):[];
    $('file-search-summary').textContent=(searchScope==='current'?'当前目录及子目录':'整个文件池')+' · '+files.length+' 个文件'+(folders.length?' · '+folders.length+' 个目录':'')+(poolView!=='all'||fileCollection||fileCategory!=='all'?' · 已应用当前筛选':'');
    const markup=folders.map(f=>'<button class="search-folder-result" data-search-folder="'+escape(f.id)+'">'+icon('folder')+'<span>'+escape('共享根目录 / '+folderPath(f.id).map(x=>x.name).join(' / '))+'</span></button>').join('');folderResults.hidden=!folders.length;if(folderResults.innerHTML!==markup)folderResults.innerHTML=markup;
  }
  function navigateFolder(id,locateId=null,remember=true){
    if(!state||id&&!state.folders?.some(f=>f.id===id)){toast('目录已不可用，请刷新文件池。','info');return;}
    if(remember)navigation.push(capturePoolScene());currentFolder=id||null;poolView='all';fileQuery='';fileCategory='all';fileCollection='';$('file-search').value='';poolScroll=0;restoreScrollPending=true;$('upload-folder').value=currentFolder||'';renderFiles();savePoolView();goTab('pool');
    if(locateId)requestAnimationFrame(()=>requestAnimationFrame(()=>{const row=[...$('file-list').querySelectorAll('[data-file-id]')].find(el=>el.dataset.fileId===locateId);if(row){row.classList.add('located');row.tabIndex=-1;row.focus({preventScroll:true});row.scrollIntoView({block:'center'});setTimeout(()=>row.classList.remove('located'),2200);}}));
  }
  function batchReason(file,mode,ignoreBusy=false){
    if(!file)return '文件已不可用或访问权限已撤销';
    if(!ignoreBusy&&pendingFileChanges.has(file.id))return '此文件有其他整理操作尚未完成';
    if(['favorite','collection'].includes(mode)&&!poolOrganized())return '此中转站不支持私人整理';
    if(['move','trash'].includes(mode)&&!(isHost()||file.senderId===state?.device?.id))return '只有发送者或中转站主机可以处理';
    if(mode==='move'&&file.targetId)return '定向文件不能移入共享目录';
    if(mode==='move'&&!sharedFolders())return '此中转站不支持共享目录';
    if(mode==='trash'&&!hasTrash())return '此中转站不支持回收站';
    return '';
  }
  function openBatch(mode){
    if(!state||batchRunning||!selectedFiles.size)return;
    if(selectedFiles.size>100){toast('一次最多整理 100 个文件，请分批选择。','info');return;}
    const visible=new Set([...document.querySelectorAll('[data-select-file]')].map(el=>el.dataset.selectFile));
    const items=[...selectedFiles].map(id=>{const file=state.files.find(f=>f.id===id);return {id,name:file?.name||'已不可用文件',path:file?pathLabel(file):'',reason:batchReason(file,mode),hidden:!visible.has(id)};});
    batchPlan={mode,context:poolContextKey(),items};$('batch-title').textContent='批量'+batchLabels[mode];$('batch-folder-field').hidden=mode!=='move';$('batch-favorite-field').hidden=mode!=='favorite';$('batch-collection-field').hidden=mode!=='collection';$('batch-folder').innerHTML=folderOptions();$('batch-folder').value=currentFolder||'';$('batch-favorite-mode').value='true';$('batch-collection-name').value=fileCollection;$('batch-collection-options').innerHTML=(state.collections||[]).map(name=>'<option value="'+escape(name)+'"></option>').join('');
    const eligible=items.filter(x=>!x.reason).length,hidden=items.filter(x=>x.hidden).length;
    $('batch-summary').textContent='已选 '+items.length+' 项 · 可执行 '+eligible+' 项 · 跳过 '+(items.length-eligible)+' 项'+(hidden?'；其中 '+hidden+' 项不在当前列表，请核对后继续。':'');
    $('batch-preview-list').innerHTML=items.map(x=>'<li data-batch-file="'+escape(x.id)+'"><strong>'+escape(x.name)+'</strong><small>原位置：'+escape(x.path)+'</small><span>'+(x.reason?'将跳过：'+escape(x.reason):'将'+batchLabels[mode])+(x.hidden?' · 不在当前列表':'')+'</span></li>').join('');$('batch-error').hidden=true;$('batch-confirm').disabled=!eligible;batchDialog.showModal();
  }
  function renderBatchReport(){
    const visible=!!batchReport&&!!state&&batchReport.context===poolContextKey();batchPanel.hidden=!visible;if(!visible){$('batch-result-list').textContent='';$('batch-progress-text').textContent='';return;}
    const items=batchReport.items,count=status=>items.filter(x=>x.status===status).length;
    $('batch-progress-text').textContent=(batchRunning?'正在'+batchLabels[batchReport.mode]:'整理结束')+' · 成功 '+count('success')+' · 失败 '+count('failed')+' · 跳过 '+count('skipped')+' · 未执行 '+count('pending')+(batchStopRequested&&batchRunning?' · 当前项完成后停止':'');
    $('batch-stop').hidden=!batchRunning;$('batch-stop').disabled=batchStopRequested;$('batch-clear-report').hidden=batchRunning;
    const names={success:'成功',failed:'失败',skipped:'跳过',pending:'未执行',running:'处理中'};
    $('batch-result-list').innerHTML=items.map(x=>'<li data-batch-file="'+escape(x.id)+'" data-status="'+x.status+'"><strong>'+escape(x.name)+'</strong><small>原位置：'+escape(x.path)+'</small><span>'+names[x.status]+(x.message?'：'+escape(x.message):'')+'</span></li>').join('');
  }
  async function executeBatch(event){
    event.preventDefault();if(batchRunning||!batchPlan)return;const plan=batchPlan;
    if(!state||plan.context!==poolContextKey()){batchDialog.close();toast('连接已切换，请重新选择文件。','info');return;}
    const batchToken=token,folderId=$('batch-folder').value||null,collection=$('batch-collection-name').value.trim(),favorite=$('batch-favorite-mode').value==='true';
    if(plan.mode==='collection'&&(collection.length>64||/[\x00-\x1f\x7f]/.test(collection))){$('batch-error').textContent='私人分类名称最多 64 个字符，不能含控制字符。';$('batch-error').hidden=false;return;}
    batchRunning=true;batchStopRequested=false;batchReport={mode:plan.mode,context:plan.context,items:plan.items.map(item=>({...item,status:item.reason?'skipped':'pending',message:item.reason}))};batchPlan=null;batchDialog.close();
    const locks=[];for(const item of batchReport.items){if(item.status==='skipped')continue;const reason=batchReason(state.files.find(f=>f.id===item.id),plan.mode);if(reason){item.status='skipped';item.message=reason;}else{pendingFileChanges.add(item.id);locks.push(item.id);}}
    reportDesktopActivity();updateSelection();renderBatchReport();
    try{
      if(plan.mode==='collection'&&collection&&!state.collections?.includes(collection))await api('/api/collections',{method:'POST',body:{name:collection}});
      for(const item of batchReport.items){
        if(item.status!=='pending')continue;if(batchStopRequested||!state||token!==batchToken||poolContextKey()!==plan.context){batchStopRequested=true;break;}
        const reason=batchReason(state.files.find(f=>f.id===item.id),plan.mode,true);if(reason){item.status='skipped';item.message=reason;continue;}
        item.status='running';renderBatchReport();
        try{
          const base='/api/files/'+encodeURIComponent(item.id);
          if(plan.mode==='move')await api(base+'/location',{method:'PATCH',body:{folderId}});
          else if(plan.mode==='trash')await api(base,{method:'DELETE'});
          else await api(base,{method:'PATCH',body:plan.mode==='favorite'?{favorite}:{collection:collection||null}});
          item.status='success';if(state&&token===batchToken&&poolContextKey()===plan.context)selectedFiles.delete(item.id);
        }catch(error){item.status='failed';item.message=error.network?'请求结果未确认，请刷新核对后再重试。':error.message||'未能确认结果，请刷新后核对';if(error.network||error.status===401)batchStopRequested=true;if(error.status===401&&state&&token===batchToken&&poolContextKey()===plan.context)logout('连接凭证已失效，请重新配对。');}
        renderBatchReport();
      }
    }catch(error){for(const item of batchReport.items)if(item.status==='pending'){item.status='failed';item.message=error.message||'准备操作失败';}}
    finally{
      for(const id of locks)pendingFileChanges.delete(id);batchRunning=false;reportDesktopActivity();
      if(state&&poolContextKey()===plan.context){await refresh(true);fileListSignature='';renderFiles();}
      renderBatchReport();updateSelection();
    }
  }
  for(const mode of Object.keys(batchLabels))$('batch-'+mode).addEventListener('click',()=>openBatch(mode));
  $('batch-form').addEventListener('submit',executeBatch);for(const id of ['batch-cancel','batch-close'])$(id).addEventListener('click',()=>batchDialog.close());batchDialog.addEventListener('close',()=>{batchPlan=null;});
  $('batch-stop').addEventListener('click',()=>{batchStopRequested=true;renderBatchReport();});$('batch-clear-report').addEventListener('click',()=>{if(!batchRunning){batchReport=null;renderBatchReport();}});
  $('file-search-scope').addEventListener('change',event=>{searchScope=event.target.value;renderFiles();});$('clear-file-search').addEventListener('click',()=>{fileQuery='';$('file-search').value='';renderFiles();$('file-search').focus();});
  $('clear-recent-files').addEventListener('click',()=>{library?.clearRecent();renderLibrary();});
  document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;const d=button.dataset;
    if(d.togglePinFolder){try{const pinned=library?.togglePin(d.togglePinFolder,state);renderFolders();renderLibrary();toast(pinned?'已加入常用目录':'已取消常用目录');}catch(error){toast(error.message,'info');}}
    if(d.pinOpen||d.searchFolder)navigateFolder(d.pinOpen||d.searchFolder);
    if(d.locateFile){const file=state?.files?.find(f=>f.id===d.locateFile);if(file)navigateFolder(file.folderId||null,file.id);}
    if(d.recentOpen){const file=state?.files?.find(f=>f.id===d.recentOpen);if(file){navigateFolder(file.folderId||null);pool?.open(file.id);}else{renderLibrary();toast('这个文件已不可用。','info');}}
  });

  // Everyday file-pool navigation and native saved-copy receipts.
  const navigation=window.RelayNavigation.create();
  let filterPanelOpen=false,recentsExpanded=false,poolPickerContext=null;
  let localCopies=new Map(),localCopiesContext='',localCopiesGeneration=0,localCopiesBusy=false,localCopiesAt=0,localCopiesSignature='';
  const filterPanel=document.createElement('div');filterPanel.id='pool-filter-panel';filterPanel.hidden=true;
  const fileHeading=document.querySelector('.file-heading');fileHeading.id='pool-toolbar';
  const filterToggle=document.createElement('button');filterToggle.id='pool-filter-toggle';filterToggle.className='button secondary small-button';filterToggle.textContent='筛选 / 排序';filterToggle.setAttribute('aria-controls','pool-filter-panel');filterToggle.setAttribute('aria-expanded','false');
  document.querySelector('.file-tools').appendChild(filterToggle);
  fileHeading.after(searchTools);searchTools.after(folderBar);folderBar.after(filterPanel);
  for(const node of [document.querySelector('.pool-overview'),$('pool-management'),$('pool-view-hint'),$('file-category-filters')])filterPanel.appendChild(node);
  filterPanel.after(folderResults);
  const folderNavigation=document.createElement('div');folderNavigation.className='pool-navigation';folderNavigation.innerHTML='<button id="pool-back" class="text-button" type="button" title="恢复上一个目录、搜索和滚动位置">← 返回</button><button id="pool-up" class="text-button" type="button">上一级</button>';
  $('folder-breadcrumb').before(folderNavigation);
  document.querySelector('.file-selection-bar').id='pool-selection-bar';
  const moreRecent=document.createElement('button');moreRecent.id='more-recent-files';moreRecent.className='text-button';moreRecent.hidden=true;$('pool-recents').after(moreRecent);
  const poolInput=document.createElement('input');poolInput.id='pool-file-input';poolInput.type='file';poolInput.multiple=true;poolInput.hidden=true;document.body.appendChild(poolInput);
  function capturePoolScene(){return {folder:currentFolder,view:poolView,category:fileCategory,collection:fileCollection,sort:fileSort,query:fileQuery,scope:searchScope,scroll:activeTab==='pool'&&!restoreScrollPending?window.scrollY:poolScroll,filters:filterPanelOpen,recents:recentsExpanded};}
  function applyFilterPanel(){const alwaysOpen=!!desktop||androidBackground;const open=alwaysOpen||filterPanelOpen;filterPanel.hidden=!open;filterToggle.hidden=alwaysOpen;filterToggle.setAttribute('aria-expanded',String(open));const filtered=poolView!=='all'||fileCategory!=='all'||!!fileCollection;filterToggle.textContent=(filtered?'筛选中':'筛选 / 排序')+(open?' ▴':' ▾');}
  function updatePoolNavigation(){if(!$('pool-back'))return;$('pool-back').disabled=!navigation.hasBack()&&!currentFolder;$('pool-up').disabled=!currentFolder;const path=folderPath(currentFolder).map(f=>f.name).join(' / ')||'共享根目录';$('pool-add-files').title='添加文件到 '+path;applyFilterPanel();}
  function restoreScene(saved){currentFolder=saved.folder;poolView=saved.view;fileCategory=saved.category;fileCollection=saved.collection;fileSort=saved.sort;fileQuery=saved.query;searchScope=saved.scope;poolScroll=saved.scroll;filterPanelOpen=saved.filters;recentsExpanded=saved.recents;$('file-search').value=fileQuery;$('file-sort').value=fileSort;$('file-search-scope').value=searchScope;$('upload-folder').value=currentFolder||'';restoreScrollPending=true;fileListSignature='';renderFiles();goTab('pool');savePoolView();}
  function backInPool(){if(!state)return false;const saved=navigation.pop(id=>state.folders?.some(f=>f.id===id));if(saved){restoreScene(saved);return true;}if(currentFolder){const folder=state.folders?.find(f=>f.id===currentFolder);navigateFolder(folder?.parentId||null,null,false);return true;}return false;}
  $('pool-back').addEventListener('click',backInPool);
  $('pool-up').addEventListener('click',()=>{const folder=state?.folders?.find(f=>f.id===currentFolder);if(folder)navigateFolder(folder.parentId||null);});
  filterToggle.addEventListener('click',()=>{if(desktop||androidBackground)return;filterPanelOpen=!filterPanelOpen;applyFilterPanel();savePoolView();});
  moreRecent.addEventListener('click',()=>{recentsExpanded=!recentsExpanded;renderLibrary();savePoolView();});
  window.RelayPoolUI=Object.freeze({handleBack(){if(!state)return false;const dialog=[...document.querySelectorAll('dialog[open]')].at(-1);if(dialog){dialog.close();return true;}if(activeTab!=='pool'){goTab('pool');return true;}if(selectedFiles.size){$('clear-file-selection').click();return true;}if(backInPool())return true;if(fileQuery){fileQuery='';$('file-search').value='';renderFiles();return true;}return false;}});
  function resetLocalCopies(){localCopies=new Map();localCopiesContext=state?poolContextKey():'';localCopiesGeneration++;localCopiesBusy=false;localCopiesAt=0;localCopiesSignature='';}
  function renderLocalCopies(){
    for(const row of $('file-list').querySelectorAll('[data-file-id]')){const file=state?.files?.find(f=>f.id===row.dataset.fileId),box=row.querySelector('.file-local-copy');if(!box)continue;const receipt=file&&localCopiesContext===poolContextKey()?localCopies.get(file.id):null;const valid=receipt&&receipt.sha256===file.sha256?.toLowerCase();
      const labels={saved:'本机已保存',missing:'本机副本已移除',changed:'本机副本已变化',unavailable:'本机副本暂不可用'};
      let markup='';if(valid){markup='<span class="local-copy-status" data-local-status="'+escape(file.id)+'" data-status="'+receipt.status+'">'+labels[receipt.status]+'</span>';if(receipt.status==='saved'){markup+='<button class="text-button" data-open-local="'+escape(file.id)+'">直接打开</button>';if(desktop?.revealSavedCopy)markup+='<button class="text-button" data-reveal-local="'+escape(file.id)+'">位置</button>';if(androidBackground)markup+='<button class="text-button" data-share-local="'+escape(file.id)+'">分享</button>';}}
      if(box.innerHTML!==markup)box.innerHTML=markup;box.hidden=!markup;
    }
  }
  async function refreshLocalCopies(force=false){
    if(!state||activeTab!=='pool'||document.hidden||poolView==='trash')return;const provider=desktop?.getSavedCopies?desktop:window.relaySavedCopies;if(!provider)return;
    const context=poolContextKey();if(localCopiesContext!==context)resetLocalCopies();
    const visible=[...$('file-list').querySelectorAll('[data-file-id]')].map(row=>state.files.find(f=>f.id===row.dataset.fileId)).filter(f=>f&&/^[a-f0-9]{64}$/i.test(f.sha256||''));const signature=visible.map(f=>f.id+':'+f.sha256).join('|');
    if(localCopiesBusy||(!force&&signature===localCopiesSignature&&Date.now()-localCopiesAt<8000))return;
    const generation=localCopiesGeneration,currentToken=token;localCopiesBusy=true;
    try{for(let i=0;i<visible.length;i+=100){const files=visible.slice(i,i+100);const result=desktop?.getSavedCopies?await provider.getSavedCopies({fileIds:files.map(f=>f.id)}):await provider.list({context,files:files.map(f=>({id:f.id,sha256:f.sha256}))});if(!state||context!==poolContextKey()||currentToken!==token||generation!==localCopiesGeneration)return;if(result.context&&result.context!==context)throw new Error('连接已切换');for(const file of files)localCopies.delete(file.id);for(const item of result.files||[]){const id=item.fileId||item.id,file=files.find(f=>f.id===id);if(file&&item.sha256?.toLowerCase()===file.sha256.toLowerCase()&&['saved','missing','changed','unavailable'].includes(item.status))localCopies.set(id,{...item,sha256:item.sha256.toLowerCase()});}}
      localCopiesAt=Date.now();localCopiesSignature=signature;renderLocalCopies();
    }catch{if(generation===localCopiesGeneration){for(const file of visible)localCopies.delete(file.id);renderLocalCopies();}}
    finally{if(generation===localCopiesGeneration)localCopiesBusy=false;}
  }
  async function actOnLocalCopy(id,action,button){const file=state?.files?.find(f=>f.id===id),receipt=localCopies.get(id);if(!file||receipt?.status!=='saved'||receipt.sha256!==file.sha256?.toLowerCase())return;const context=poolContextKey();
    if(androidBackground){location.href='relaydrop://'+(action==='share'?'share-saved':'open-saved')+'?fileId='+encodeURIComponent(id)+'&sha256='+encodeURIComponent(file.sha256);return;}
    const method=action==='reveal'?desktop?.revealSavedCopy:desktop?.openSavedCopy;if(!method)return;button.disabled=true;try{await method({fileId:id,sha256:file.sha256});if(action==='open'&&state&&poolContextKey()===context){library?.recordOpen(file,state);renderLibrary();}}catch(error){if(state&&poolContextKey()===context){localCopies.delete(id);renderLocalCopies();void refreshLocalCopies(true);}toast(error.message||'本机副本无法打开，请重新保存。','error');}finally{if(button.isConnected)button.disabled=false;}
  }
  document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;const d=button.dataset;if(d.openLocal)void actOnLocalCopy(d.openLocal,'open',button);if(d.revealLocal)void actOnLocalCopy(d.revealLocal,'reveal',button);if(d.shareLocal)void actOnLocalCopy(d.shareLocal,'share',button);if(d.fileNamePreview){const file=state?.files?.find(f=>f.id===d.fileNamePreview);if(file){if(window.RelayPool?.previewable(file))pool?.open(file.id);else showFileDetails(file);}}});
  for(const event of ['relay-saved-copies-ready','relay-saved-copies-changed'])window.addEventListener(event,()=>{localCopiesAt=0;void refreshLocalCopies(true);});
  window.addEventListener('focus',()=>{localCopiesAt=0;void refreshLocalCopies(true);});
  setInterval(()=>void refreshLocalCopies(),8000);
  function addFilesToCurrentFolder(){if(!state)return;const captured={context:poolContextKey(),folderId:currentFolder,targetId:null};poolPickerContext=captured;
    if(desktop?.chooseFiles){Promise.resolve(desktop.chooseFiles({folderId:captured.folderId,targetId:null})).then(result=>{if(result?.requestId&&state&&poolContextKey()===captured.context)toast('已加入后台发送，进度会显示在文件池中');}).catch(error=>toast(error.message||'未能添加文件','error'));return;}
    if(androidBackground){location.href='relaydrop://choose-files?target=&folderId='+encodeURIComponent(captured.folderId||'');return;}
    poolInput.click();
  }
  poolInput.addEventListener('change',event=>{const files=[...event.target.files],captured=poolPickerContext;event.target.value='';poolPickerContext=null;if(!files.length)return;if(!state||!captured||captured.context!==poolContextKey()||(captured.folderId&&!state.folders?.some(f=>f.id===captured.folderId))){toast('连接或目录已变化，请重新添加文件。','error');return;}const added=addFiles(files,captured.folderId,false,null);renderQueue();pump();if(added)toast('已加入 '+added+' 个文件，发送到当前共享目录');});
  poolInput.addEventListener('cancel',()=>{poolPickerContext=null;});
  let longPress=null,suppressFileClick=null;
  function cancelLongPress(){if(longPress)clearTimeout(longPress.timer);longPress=null;}
  function toggleFileSelection(id){if(!state?.files?.some(f=>f.id===id)||poolView==='trash')return;if(selectedFiles.has(id))selectedFiles.delete(id);else selectedFiles.add(id);const input=[...$('file-list').querySelectorAll('[data-select-file]')].find(el=>el.dataset.selectFile===id);if(input){input.checked=selectedFiles.has(id);input.closest('.file-row').classList.toggle('selected',input.checked);}updateSelection();}
  $('file-list').addEventListener('pointerdown',event=>{cancelLongPress();if(!['touch','pen'].includes(event.pointerType)||!event.isPrimary||event.button!==0||poolView==='trash')return;const main=event.target.closest('.file-main'),blocked=event.target.closest('input,a,button:not([data-file-name-preview]):not([data-preview-file])');if(!main||blocked)return;const row=main.closest('[data-file-id]'),id=row.dataset.fileId;longPress={id,pointer:event.pointerId,x:event.clientX,y:event.clientY,timer:setTimeout(()=>{if(!longPress||!row.isConnected)return;if(!selectedFiles.has(id))toggleFileSelection(id);suppressFileClick={id,until:Date.now()+1000};cancelLongPress();},500)};},{passive:true});
  $('file-list').addEventListener('pointermove',event=>{if(longPress&&event.pointerId===longPress.pointer&&Math.hypot(event.clientX-longPress.x,event.clientY-longPress.y)>10)cancelLongPress();},{passive:true});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])$('file-list').addEventListener(name,cancelLongPress,{passive:true});
  window.addEventListener('scroll',cancelLongPress,{passive:true});
  window.addEventListener('blur',cancelLongPress);document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelLongPress();});
  $('file-list').addEventListener('contextmenu',event=>{if(suppressFileClick&&suppressFileClick.until>Date.now())event.preventDefault();});
  $('file-list').addEventListener('click',event=>{const main=event.target.closest('.file-main');if(!main)return;const id=main.closest('[data-file-id]').dataset.fileId;if(suppressFileClick?.id===id&&suppressFileClick.until>Date.now()){suppressFileClick=null;event.preventDefault();event.stopImmediatePropagation();return;}if(selectedFiles.size&&!event.target.closest('input,a,button:not([data-file-name-preview]):not([data-preview-file])')){event.preventDefault();event.stopImmediatePropagation();toggleFileSelection(id);}},true);

  function nativeSaveFinished(task){return ['completed','cancelled','failed'].includes(task.status);}
  function reportDesktopActivity(){
    if(!desktop?.reportActivity)return;
    const activity={uploads:tasks.filter(t=>!['done','cancelled'].includes(t.state)).length+(batchRunning?1:0),verifications:localVerification?1:0};
    const signature=JSON.stringify(activity);if(signature===lastActivity)return;lastActivity=signature;
    try{Promise.resolve(desktop.reportActivity(activity)).catch(()=>{});}catch{}
  }
  function nativeSaveMessage(task){
    if(task.cancelRequested&&!nativeSaveFinished(task))return '正在取消，请等待保存任务结束…';
    switch(task.status){
      case 'queued':return '等待保存';
      case 'choosing':return '请在系统窗口选择保存位置';
      case 'saving':return `正在保存 · ${size(task.transferred||0)} / ${size(task.total||0)}`;
      case 'verifying':return '正在读取保存副本，核对大小与完整 SHA-256';
      case 'completed':return '已保存并校验 · 大小与完整 SHA-256 均一致';
      case 'cancelled':return '已取消 · 本次未确认保存副本的完整性';
      case 'failed':return `${task.error||'保存或校验失败'} · 本次未校验通过`;
      default:return '正在处理';
    }
  }
  function renderNativeSaves(){
    if(!desktop)return;
    const all=[...nativeSaves.values()].filter(t=>!t.context||t.context===poolContextKey()),incoming=[...nativeIncoming.values()].filter(t=>!t.context||t.context===poolContextKey()),active=Math.max(all.filter(t=>!nativeSaveFinished(t)).length,nativeBatch&&!nativeSaveFinished(nativeBatch)?1:0)+incoming.filter(t=>!nativeSaveFinished(t)).length;
    $('desktop-download-card').hidden=!all.length&&!nativeBatch&&!nativeIncoming.size;$('desktop-download-count').textContent=active?`${active} 个进行中`:`${all.length+incoming.length} 个任务`;renderIncoming();
    $('desktop-save-status').hidden=!active;$('desktop-save-status').textContent=`文件任务 ${active}`;
    $('desktop-cancel-batch').hidden=!downloadingBatch;$('desktop-cancel-batch').disabled=desktopBatchStopped;
    $('desktop-clear-saves').disabled=!all.some(nativeSaveFinished)&&!(nativeBatch&&nativeSaveFinished(nativeBatch))&&![...nativeIncoming.values()].some(nativeSaveFinished);
    $('desktop-batch-status').hidden=!nativeBatch;if(nativeBatch){$('desktop-batch-status').textContent=batchMessage(nativeBatch);$('desktop-batch-status').dataset.state=nativeBatch.status;}
    for(const [id,row] of nativeSaveRows)if(!nativeSaves.has(id)){row.remove();nativeSaveRows.delete(id);}
    for(const task of all){
      let row=nativeSaveRows.get(task.requestId);
      if(!row){row=document.createElement('div');row.className='queue-item native-save-item';row.dataset.saveRequest=task.requestId;row.tabIndex=-1;
        row.innerHTML=`${fileIcon(task.name)}<div class="queue-detail"><div class="queue-filename"></div><div class="native-save-message" role="status"></div><div class="native-save-path" hidden></div><progress max="100" value="0" aria-label="保存与校验进度"></progress></div><div class="queue-actions"><button class="icon-button danger" data-cancel-save="${escape(task.requestId)}" title="取消保存" aria-label="取消保存">${icon('close')}</button></div>`;
        nativeSaveRows.set(task.requestId,row);$('desktop-download-list').appendChild(row);
      }
      const finished=nativeSaveFinished(task),percent=task.status==='completed'?100:task.total?Math.min(100,Math.floor((task.transferred||0)/task.total*100)):0;
      row.dataset.state=task.status;row.querySelector('.queue-filename').textContent=task.name;row.querySelector('.queue-filename').title=task.name;
      row.querySelector('.native-save-message').textContent=nativeSaveMessage(task);
      const path=row.querySelector('.native-save-path');path.hidden=task.status!=='completed'||!task.path;path.textContent=task.path||'';path.title=task.path||'';
      const progress=row.querySelector('progress');progress.hidden=finished;if(['queued','choosing','verifying'].includes(task.status))progress.removeAttribute('value');else progress.value=percent;
      const cancel=row.querySelector('[data-cancel-save]');if(finished&&document.activeElement===cancel)row.focus({preventScroll:true});cancel.hidden=finished;cancel.disabled=!!task.cancelRequested;
      if(task.status==='completed'&&desktop.revealSavedFile&&!row.querySelector('[data-reveal-save]')){const reveal=document.createElement('button');reveal.className='text-button saved-file-location';reveal.dataset.revealSave=task.requestId;reveal.textContent='打开位置';row.querySelector('.queue-actions').appendChild(reveal);}
      if(detailNativeRequest===task.requestId&&detailFile){
        const localState=task.status==='completed'?'passed':task.status==='failed'?'error':task.status==='cancelled'?'cancelled':'running';
        setLocalVerification(localState,nativeSaveMessage(task),percent);$('cancel-file-verify').disabled=!!task.cancelRequested&&!finished;
      }
    }
  }
  function acceptNativeSaveProgress(event){
    if(event?.context&&state&&event.context!==poolContextKey())return;
    if(!event||typeof event.requestId!=='string'||!['queued','choosing','saving','verifying','completed','cancelled','failed'].includes(event.status))return;
    let task=nativeSaves.get(event.requestId);
    if(!task){const expected=state?.files?.find(f=>f.id===event.fileId)||nativeBatch?.files?.find(f=>f.id===event.fileId);task={requestId:event.requestId,fileId:event.fileId,batchId:event.batchId,name:expected?.name||event.name||'下载文件',expected:expected?{...expected}:null,announce:!event.batchId};nativeSaves.set(task.requestId,task);}
    if(nativeSaveFinished(task))return;
    Object.assign(task,{context:event.context||task.context||(state?poolContextKey():''),status:event.status,transferred:event.transferred??task.transferred??0,total:event.total??task.total??task.expected?.size??0});
    if(event.error||event.message)task.error=String(event.error||event.message);
    if(event.status==='completed'){
      const validHash=typeof event.sha256==='string'&&/^[a-f0-9]{64}$/i.test(event.sha256),validSize=Number.isSafeInteger(event.size)&&event.size>=0;
      if(!validHash||!validSize||(task.expected&&(event.sha256.toLowerCase()!==task.expected.sha256?.toLowerCase()||event.size!==task.expected.size))){task.status='failed';task.error='保存副本的校验结果不一致，请重新保存';}
      else {task.sha256=event.sha256.toLowerCase();task.size=event.size;task.path=typeof event.path==='string'?event.path:'';}
    }
    renderNativeSaves();
    if(task.status==='completed'){localCopiesAt=0;void refreshLocalCopies(true);if(event.savedCopyWarning)toast('文件已保存并校验，但未能记录本机标记：'+event.savedCopyWarning,'info',6500);}
    if(nativeSaveFinished(task)&&task.announce){toast(`${task.name}：${nativeSaveMessage(task)}`,task.status==='completed'?'success':task.status==='failed'?'error':'info',6500);}
  }
  function startNativeSave(fileId,{announce=true,details=false,batch=false}={}){
    let task=[...nativeSaves.values()].find(t=>t.fileId===fileId&&!nativeSaveFinished(t));
    if(task){if(details)detailNativeRequest=task.requestId;if(batch)desktopBatchRequest=task.requestId;renderNativeSaves();return task.promise||Promise.resolve({status:'cancelled'});}
    const expected=state?.files?.find(f=>f.id===fileId);
    if(!expected)return Promise.resolve({status:'failed'});
    const requestId=crypto.randomUUID();task={requestId,fileId,context:poolContextKey(),name:expected.name,expected:{...expected},status:'queued',total:expected.size,transferred:0,announce};nativeSaves.set(requestId,task);
    if(details)detailNativeRequest=requestId;if(batch)desktopBatchRequest=requestId;renderNativeSaves();
    task.promise=Promise.resolve().then(()=>desktop.saveFile({fileId,requestId})).then(result=>{
      acceptNativeSaveProgress({...result,requestId,fileId,status:['completed','cancelled','failed'].includes(result?.status)?result.status:'failed'});
      return {status:task.status};
    }).catch(error=>{acceptNativeSaveProgress({requestId,fileId,status:'failed',error:error.message||'无法保存文件'});return {status:'failed'};});
    return task.promise;
  }
  async function cancelNativeSave(requestId){
    const task=nativeSaves.get(requestId);if(!task||nativeSaveFinished(task)||task.cancelRequested)return;
    task.cancelRequested=true;renderNativeSaves();
    try{await desktop.cancelSave(requestId);}catch(error){task.cancelRequested=false;renderNativeSaves();toast(error.message||'暂时无法取消，请重试','error');}
  }
  function batchMessage(batch){
    if(desktopBatchStopped&&!nativeSaveFinished(batch))return '正在取消批量保存，请等待当前任务结束…';
    if(batch.status==='queued')return `批量保存 ${batch.total} 个文件 · 等待开始`;
    if(batch.status==='choosing')return `请在系统窗口选择文件夹，统一保存 ${batch.total} 个文件。`;
    const count=`已保存并校验 ${batch.completed||0} / ${batch.total} 个${batch.failed?'，失败 '+batch.failed+' 个':''}${batch.cancelled?'，取消 '+batch.cancelled+' 个':''}`;
    return nativeSaveFinished(batch)?`${batch.status==='failed'?'批量保存未完成 · ':''}${count}。${batch.error||''}`:`${count} · 逐个核对保存副本`;
  }
  function acceptBatchProgress(event){
    if(!nativeBatch||event?.requestId!==nativeBatch.requestId||!['queued','choosing','running','completed','cancelled','failed'].includes(event.status)||nativeSaveFinished(nativeBatch))return;
    Object.assign(nativeBatch,{status:event.status,completed:Number(event.completed)||0,failed:Number(event.failed)||0,cancelled:Number(event.cancelled)||0});
    if(event.error)nativeBatch.error=String(event.error);
    const rejected=[...nativeSaves.values()].filter(t=>t.batchId===nativeBatch.requestId&&t.status==='failed').length;
    if(nativeSaveFinished(nativeBatch)&&rejected>nativeBatch.failed){nativeBatch.completed=Math.max(0,nativeBatch.completed-(rejected-nativeBatch.failed));nativeBatch.failed=rejected;nativeBatch.status='failed';}
    renderNativeSaves();
  }
  async function saveBatchOnDesktop(ids){
    const requestId=crypto.randomUUID();nativeBatch={requestId,context:poolContextKey(),status:'queued',total:ids.length,completed:0,failed:0,cancelled:0,files:(state?.files||[]).filter(f=>ids.includes(f.id)).map(f=>({...f}))};
    downloadingBatch=true;desktopBatchStopped=false;desktopBatchRequest=requestId;updateSelection();renderNativeSaves();
    try{const result=await desktop.saveBatch({fileIds:ids,requestId});acceptBatchProgress({...result,requestId});if(!nativeSaveFinished(nativeBatch))throw new Error('未收到完整的批量保存结果');toast(batchMessage(nativeBatch),nativeBatch.status==='failed'?'error':nativeBatch.completed?'success':'info',6500);}
    catch(error){nativeBatch.status='failed';nativeBatch.error=error.message||'批量保存未完成，请重试';toast(nativeBatch.error,'error');}
    finally{downloadingBatch=false;desktopBatchRequest=null;updateSelection();renderNativeSaves();}
  }
  function applyDesktopSettings(settings){
    if(!settings||typeof settings.closeToTray!=='boolean')return;desktopSettings=settings;$('desktop-settings-card').hidden=false;$('close-to-tray').checked=settings.closeToTray;$('close-to-tray').disabled=settings.trayAvailable===false;
    const description=settings.trayAvailable===false?'系统托盘暂不可用，关闭窗口会退出并停止共享。文件和文字会保留。':settings.closeToTray?'关闭窗口后继续共享。点击系统托盘图标可打开窗口，从托盘菜单「退出」可停止共享。文件和文字会保留。':'关闭窗口会退出应用并停止共享。文件和文字会保留，下次打开可继续使用。';
    $('desktop-close-description').textContent=description;$('desktop-exit-help').querySelector('p').textContent=description+' 退出时如有进行中的任务，会提醒你。';
    $('desktop-save-settings').hidden=!desktop.chooseReceiveDirectory;
    $('desktop-save-mode').value=settings.saveMode==='fixed'?'fixed':'ask';
    $('desktop-save-directory').textContent=settings.receiveDirectory?'固定文件夹：'+settings.receiveDirectory:settings.lastSaveDirectory?'最近保存到：'+settings.lastSaveDirectory:'未设置固定文件夹';
    $('clear-receive-directory').hidden=!settings.receiveDirectory;
    $('desktop-login-setting').hidden=typeof settings.launchAtLoginAvailable!=='boolean';$('launch-at-login').checked=!!settings.launchAtLogin;$('launch-at-login').disabled=settings.launchAtLoginAvailable!==true;
    $('desktop-login-setting').title=settings.launchAtLoginAvailable===false?'此运行方式不支持登录后自动启动':'';
    $('desktop-sendto-description').hidden=typeof settings.sendToAvailable!=='boolean';$('desktop-sendto-description').textContent=settings.sendToAvailable?'可在 Windows 文件右键菜单「发送到」中选择 RelayDrop，确认后加入本机共享文件池。':'此运行方式未启用 Windows 右键「发送到」入口。';
  }

  function acceptIncomingProgress(event){if(!event||typeof event.requestId!=='string'||event.context&&state&&event.context!==poolContextKey())return;nativeIncoming.set(event.requestId,{context:event.context||(state?poolContextKey():''),...nativeIncoming.get(event.requestId),...event});while(nativeIncoming.size>30)nativeIncoming.delete(nativeIncoming.keys().next().value);renderNativeSaves();if(['completed','failed','cancelled'].includes(event.status))refresh(true);}
  function renderIncoming(){const entries=[...nativeIncoming.values()].filter(t=>!t.context||t.context===poolContextKey());$('desktop-incoming-status').hidden=!entries.length;
    const labels={organizing:'正在建立共享目录',duplicate:'文件池已有相同内容，请在系统窗口选择',queued:'等待处理',confirming:'等待你确认发送到共享文件池',hashing:'正在校验原文件',uploading:'正在发送到共享文件池',verifying:'正在核对中转站副本',completed:'已发送到共享文件池',cancelled:'已取消',failed:'发送未全部完成'};
    $('desktop-incoming-status').innerHTML=entries.map(item=>'<div class="incoming-task"><div><p>本机发送 · '+escape(item.name||'文件')+'</p><p>'+escape(labels[item.status]||'正在处理')+' · 成功 '+Number(item.completed||0)+' / '+Number(item.total||0)+(item.skipped?' · 已跳过重复 '+Number(item.skipped):'')+(item.failed?' · 失败 '+Number(item.failed):'')+(item.cancelled?' · 取消 '+Number(item.cancelled):'')+(item.error?' · '+escape(item.error):'')+'</p></div>'+(!nativeSaveFinished(item)?'<button class="text-button" data-cancel-incoming="'+escape(item.requestId)+'">取消发送</button>':'')+'</div>').join('');
  }
  function renderSecurity(){const security=state?.security||{},transport=security.transport||(location.protocol==='https:'?'tls':'http'),status=$('security-status');
    status.textContent=transport==='tls'?'HTTPS 加密连接':transport==='loopback'?'本机连接': 'HTTP 未加密连接';status.dataset.level=transport==='http'?'warning':'secure';
    $('security-description').textContent=transport==='tls'?'文件与文字通过 HTTPS 加密传输。首次连接仍需核对中转站证书指纹，确认连接的是你的设备。':transport==='loopback'?(security.tlsEnabled?'此窗口通过本机连接访问中转站；其他设备使用下方的 HTTPS 地址加入，并在首次连接时核对证书指纹。':'此窗口通过本机连接访问中转站。其他设备的连接是否加密，请以加入地址和连接状态为准。'):'当前连接使用 HTTP，文件与文字在传输中没有加密。请仅在信任的网络使用；支持 HTTPS 的中转站应通过 HTTPS 地址重新加入。';
    const fingerprint=typeof security.certificateFingerprint==='string'?security.certificateFingerprint:'';$('certificate-details').hidden=!fingerprint;$('certificate-fingerprint').textContent=fingerprint;
    $('background-transfer-note').textContent=androidBackground?'安卓客户端可通过「后台发送文件」交给原生队列，并在系统通知中查看进度。系统电量或后台限制仍可能暂停任务；普通网页上传请保持页面在前台。':desktop?.isRemote?'关闭此远程窗口会断开连接。任务完成前请保持此窗口和文件池设备运行。':desktop?'关闭窗口后的共享行为由桌面设置控制。任务完成前请保持中转站运行。':'网页上传请保持页面打开并在前台；切到后台或锁屏后，系统可能暂停传输。';
    $('pairing-network-note').textContent=security.tlsEnabled?'局域网模式无需互联网；远程模式需要可用中继。请使用加密连接并核对设备指纹，文件池设备需要保持运行。':'局域网模式无需互联网。当前地址使用 HTTP，请仅在可信局域网使用；远程模式需要加密连接和可用中继。';
  }

  function size(bytes) { if (bytes < 1024) return `${bytes} B`; const units=['KB','MB','GB','TB']; let n=bytes/1024,i=0; while(n>=1024&&i<units.length-1){n/=1024;i++;}return `${n>=100?n.toFixed(0):n.toFixed(1)} ${units[i]}`; }
  function date(value, brief=false) { const d=new Date(value); if(!Number.isFinite(d.getTime()))return '—';const today=new Date();const same=d.toDateString()===today.toDateString();return `${same?'今天':d.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'})}${brief?' ': ' · '}${d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}`; }
  function timeAgo(value) { const secs=(Date.now()-new Date(value).getTime())/1000;if(!Number.isFinite(secs))return '等待连接';if(secs<20)return '最近在线';if(secs<60)return `${Math.max(1,Math.floor(secs))} 秒前在线`;if(secs<3600)return `${Math.floor(secs/60)} 分钟前在线`;return `${date(value)} 在线`; }
  function toast(message, type='success', duration=4500) { const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=message;$('toast-stack').appendChild(el);while($('toast-stack').children.length>3)$('toast-stack').firstElementChild.remove();setTimeout(()=>el.remove(),duration); }
  function setConnected(ok) {connected=ok;$('offline-banner').hidden=ok||!state;const pill=$('connection-pill');pill.innerHTML=`<span class="status-dot" style="${ok?'':'background:#d0a35b'}"></span><span>${ok?(desktop?.isRemote?'远程已连接':'局域网已连接'):'等待重连'}</span>`;}
  function showPair() {$('loading-screen').hidden=true;$('pair-screen').hidden=false;$('app-shell').hidden=true;$('offline-banner').hidden=true;const n=storage.get('relay-device-name');$('device-name').value=n||(/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)?'我的手机 / 平板':'我的设备');}
  function logout(message) {batchStopRequested=true;batchPlan=null;batchDialog.close();folderDialog.close();$('collection-dialog').close();folderAction=null;collectionFile=null;document.getElementById('batch-preview-list').textContent='';token=null;storage.remove('relay-host-token',true);storage.remove('relay-guest-token');state=null;viewContext='';navigation.clear();resetLocalCopies();cancelLongPress();poolPickerContext=null;poolScroll=0;renderLibrary();pool?.reset();cancelLocalVerification();$('file-dialog').close();tasks.forEach(t=>{if(!['done','cancelled'].includes(t.state)){t.state='cancelled';t.controller?.abort();}});tasks=[];completedSelections.clear();selectedFiles.clear();lastRender='';fileListSignature='';noteListSignature='';renderQueue();showPair();if(message){$('pair-error').textContent=message;$('pair-error').hidden=false;}}
  async function api(path, options={}) {
    const {method='GET', body, headers={}, signal, noAuth=false, timeout=API_TIMEOUT}=options;
    const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
    const timer=setTimeout(()=>controller.abort(),timeout);
    const h={...headers};if(token&&!noAuth)h.Authorization=`Bearer ${token}`;
    let payload=body;if(body!==undefined&&!(body instanceof ArrayBuffer)&&!ArrayBuffer.isView(body)&&!(body instanceof Blob)){h['Content-Type']='application/json';payload=JSON.stringify(body);}
    try {const response=await fetch(path,{method,body:payload,headers:h,signal:controller.signal,cache:'no-store'});let data=null;try{data=await response.json();}catch{}if(!response.ok){const error=new Error(data?.error||`请求未完成（${response.status}）`);error.status=response.status;error.code=data?.code;error.offset=data?.offset;throw error;}return data;}catch(error){if(error.name==='AbortError'&&!signal?.aborted){const timeoutError=new Error('连接超时，请检查网络后重试');timeoutError.network=true;throw timeoutError;}if(error instanceof TypeError){error.network=true;error.message='连接不到中转站，请检查 Wi-Fi 或热点连接';}throw error;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async function refresh(force=false) {
    if(!token||polling||stopped)return;
    polling=true;const refreshToken=token;
    try {const next=await api('/api/state',{timeout:10000});if(token!==refreshToken)return;state=next;restorePoolView();setConnected(true);$('loading-screen').hidden=true;$('pair-screen').hidden=true;$('app-shell').hidden=false;const {lastSeen:ignoredSeen,...snapshotDevice}=next.device;const snapshot=JSON.stringify({...next,device:snapshotDevice,devices:(next.devices||[]).map(({lastSeen,...d})=>({...d,online:Date.now()-new Date(lastSeen).getTime()<20000}))});if(force||snapshot!==lastRender){lastRender=snapshot;renderState();if(restoreScrollPending)restorePoolScroll();}else renderExpiry();}
    catch(error){if(token!==refreshToken)return;if(error.status===401||error.status===403){logout('连接凭证已失效，请使用新的配对码重新加入。');}else{setConnected(false);if(!state){showPair();$('pair-error').textContent='暂时无法连接中转站，请检查网络或稍后重试。';$('pair-error').hidden=false;}}}
    finally{polling=false;if(token&&token!==refreshToken)refresh(true);}
  }
  function goTab(name) {if(!['pool','transfer','notes','devices','bluetooth'].includes(name))return;const previous=activeTab;if(previous==='pool'&&previous!==name&&state&&!restoreScrollPending){poolScroll=window.scrollY;savePoolView();}activeTab=name;document.body.classList.toggle('pool-selecting',name==='pool'&&selectedFiles.size>0);document.querySelectorAll('.page').forEach(p=>{p.hidden=p.id!==`page-${name}`;});document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===name);b.setAttribute('aria-current',b.dataset.tab===name?'page':'false');});$('breadcrumb-current').textContent={pool:'文件池',transfer:'文件传送',notes:'文字收件箱',devices:'我的设备',bluetooth:'蓝牙传送'}[name];history.replaceState({},'',location.pathname+location.search+'#'+name);if(name==='devices')renderPairing();if(name==='pool'&&(previous!==name||restoreScrollPending)){restoreScrollPending=true;restorePoolScroll();void refreshLocalCopies();}else if(previous!==name)window.scrollTo(0,0);}
  function isHost(){return state?.device?.role==='host';}
  function isAndroidHost(){return state?.network?.platform==='android';}
  function devices(){const all=(state?.devices||[]).filter(d=>!d.revoked);if(state?.device&&!all.some(d=>d.id===state.device.id))all.unshift(state.device);return all;}
  function deviceName(id){if(!id)return '共享空间';return devices().find(d=>d.id===id)?.name||(id==='host'?'中转站设备':'已移除的设备');}
  function targetName(id){return id?`定向给 ${deviceName(id)} · 发送者与主机可见`:'所有已配对设备';}
  function deviceIcon(d){return d.role==='host'&&!isAndroidHost()?'laptop':'phone';}
  function online(d){return d.id===state?.device?.id||d.role==='host'||Date.now()-new Date(d.lastSeen).getTime()<20000;}
  function renderState(){
    if(!state)return;renderStorage();
    $('identity-name').textContent=state.device.name;$('identity-avatar').textContent=state.device.name.slice(0,1);
    const list=devices();$('connected-count').textContent=list.length;$('device-count').textContent=list.length;
    for(const id of ['file-target','note-target']){const el=$(id),old=el.value;el.innerHTML='<option value="">共享空间 · 所有已配对设备</option>'+list.filter(d=>d.id!==state.device.id).map(d=>`<option value="${escape(d.id)}">${escape(d.name)}${d.role==='host'?' · 中转站':''}</option>`).join('');el.value=[...el.options].some(o=>o.value===old)?old:'';}
    $('quick-devices').innerHTML=list.slice(0,3).map(d=>`<div class="quick-device"><span class="device-symbol">${icon(deviceIcon(d))}</span><div class="quick-device-info"><strong>${escape(d.name)}${d.id===state.device.id?' <span class="device-current">此设备</span>':''}</strong><small>${d.role==='host'?'中转站 · 保持运行':escape(timeAgo(d.lastSeen))}</small></div><span class="status-dot" style="${online(d)?'':'background:#c5d0cb'}"></span></div>`).join('');
    if(list.length===1)$('quick-devices').innerHTML+='<p class="micro" style="padding:8px 0">下一台设备，等你加入。</p>';
    $('show-pairing').textContent=isHost()?'＋ 连接新设备':'查看设备';
    $('host-pairing-panel').hidden=!isHost();$('quick-pairing').hidden=!isHost();$('guest-device-tip').hidden=isHost();
    $('android-install-card').hidden=isAndroidHost()||!!desktop?.isRemote||state?.capabilities?.androidInstaller!==true;
    $('device-list').innerHTML=list.map(d=>`<div class="device-row"><span class="device-symbol">${icon(deviceIcon(d))}</span><div class="device-info"><h3>${escape(d.name)}${d.id===state.device.id?'<span class="device-current">此设备</span>':''}</h3><small>${d.role==='host'?'中转站设备 · 文件与文字保存在这里':escape(timeAgo(d.lastSeen))}</small></div><span class="device-online ${online(d)?'':'offline'}"><span class="status-dot"></span>${online(d)?'已连接':'暂离'}</span>${isHost()&&d.role!=='host'?`<button class="button secondary small-button" data-revoke="${escape(d.id)}">移除</button>`:''}</div>`).join('');
    const btAvailable=isHost()&&state.bluetooth?.available&&!isAndroidHost();
    $('bluetooth-actions').hidden=!btAvailable;
    if(isAndroidHost()){
      document.querySelector('.bluetooth-hero h2').textContent='在安卓应用中开启蓝牙直传';
      document.querySelector('.bluetooth-hero p').textContent='回到 RelayDrop 安卓应用首页，打开「蓝牙直传」，在手机和平板之间直接传输。也可以在相册或文件管理器中使用系统「分享 → 蓝牙」。';
    }
    renderFiles();renderNotes();renderPairing();renderSecurity();renderQueue();goTab(activeTab);
  }
  function renderPairing(){
    if(!state||!isHost()||!state.pairing)return;
    const urls=state.network?.urls||[];const address=$('network-address');const options=urls.map(u=>`<option value="${escape(u)}">${escape(u)}</option>`).join('');if(address.innerHTML!==options){address.innerHTML=options;if(urls.includes(selectedAddress))address.value=selectedAddress;}
    selectedAddress=address.value||urls[0]||'';
    const code=state.pairing.code||'';$('quick-code').textContent=code;$('large-code').textContent=code;
    const qrUrl=selectedAddress?selectedAddress.replace(/\/$/,'')+'/#code='+encodeURIComponent(code):'';
    if(lastQr!==qrUrl){lastQr=qrUrl;try{const svg=qrUrl&&globalThis.RelayQR?RelayQR.svg(qrUrl):'';$('large-qr').innerHTML=svg||'<span class="micro">使用连接地址</span>';$('quick-qr').innerHTML=svg||icon('devices');}catch{$('large-qr').textContent='请使用连接地址';$('quick-qr').innerHTML=icon('devices');}}
    renderExpiry();
  }
  function renderExpiry(){if(!state?.pairing)return;const remaining=Math.max(0,Math.ceil((new Date(state.pairing.expiresAt).getTime()-Date.now())/60000));$('pair-expiry').textContent=remaining?`约 ${remaining} 分钟后过期 · 配对后无需每次输入`:'配对码已过期，请点击「换一个」';}
  function fileType(name){const ext=(name.split('.').pop()||'').toLowerCase();if(/^(png|jpg|jpeg|webp|gif|heic|avif|bmp|svg)$/.test(ext))return['image','IMG'];if(/^(mp4|mov|mkv|webm|avi|mp3|wav|m4a)$/.test(ext))return['video',ext.toUpperCase().slice(0,4)];if(/^(pdf|docx?|pptx?|xlsx?)$/.test(ext))return['document',ext.toUpperCase().slice(0,4)];if(/^(zip|rar|7z|tar|gz)$/.test(ext))return['archive','ZIP'];if(/^(txt|md|csv|json|js|py|html|css)$/.test(ext))return['text',ext.toUpperCase().slice(0,4)];return['',ext===name.toLowerCase()?'FILE':ext.toUpperCase().slice(0,4)];}
  function fileIcon(name){const[type,label]=fileType(name);return `<span class="file-icon ${type}">${escape(label)}</span>`;}
  function empty(title,description,symbol='inbox',small=false){return `<div class="empty-state ${small?'small':''}"><span class="empty-symbol">${icon(symbol)}</span><h3>${escape(title)}</h3><p>${escape(description)}</p></div>`;}
  function poolOrganized(){return state?.capabilities?.fileOrganization===true&&Array.isArray(state.collections);}
  function hasTrash(){return state?.capabilities?.trash===true&&Array.isArray(state.trash);}
  function collectionOptions(includeAll=false){return (includeAll?'<option value="">全部私人分类</option>':'<option value="">未归类</option>')+(state?.collections||[]).map(name=>'<option value="'+escape(name)+'">'+escape(name)+'</option>').join('');}
  function renderPoolControls(){
    renderFolders();updatePoolNavigation();
    const organized=poolOrganized(),trash=hasTrash();$('pool-management').hidden=!organized&&!trash;
    document.querySelector('[data-pool-view="favorites"]').hidden=!organized;document.querySelector('[data-pool-view="trash"]').hidden=!trash;
    document.querySelector('.collection-controls').hidden=!organized||poolView==='trash';
    if((poolView==='trash'&&!trash)||(poolView==='favorites'&&!organized))poolView='all';
    if(fileCollection&&!state?.collections?.includes(fileCollection))fileCollection='';
    const options=collectionOptions(true);if($('file-collection').innerHTML!==options)$('file-collection').innerHTML=options;$('file-collection').value=fileCollection;
    $('delete-collection').hidden=!fileCollection;$('trash-count').textContent=state?.trash?.length||0;
    for(const b of document.querySelectorAll('[data-pool-view]')){b.classList.toggle('active',b.dataset.poolView===poolView);b.setAttribute('aria-pressed',b.dataset.poolView===poolView?'true':'false');}
    const hint=$('pool-view-hint');hint.hidden=!organized&&poolView!=='trash';hint.textContent=poolView==='trash'?'这里保留你有权管理的已删除文件。恢复会回到原接收范围；永久删除无法撤销，回收站仍占用存储。':'收藏和私人分类仅属于当前设备，用于整理这个中转站的文件，不会改变文件的接收权限。';
    const stats=state?.storage,active=Number.isFinite(stats?.activeBytes)?stats.activeBytes:(state?.files||[]).reduce((n,f)=>n+f.size,0),deleted=Number.isFinite(stats?.trashBytes)?stats.trashBytes:(state?.trash||[]).reduce((n,f)=>n+f.size,0);
    $('pool-storage').textContent=(stats?.scope==='host'?'中转站存储':'当前可见文件')+' · '+size(active)+(trash?' · 回收站 '+size(deleted):'')+(Number.isFinite(stats?.availableBytes)?' · 可用 '+size(stats.availableBytes):'');
  }
  function renderFiles(){
    renderPoolControls();renderLibrary();const active=state?.files||[],all=poolView==='trash'?(state?.trash||[]):active;
    const query=fileQuery.trim().toLocaleLowerCase();
    const matching=all.filter(f=>(query?(searchScope!=='current'||inFolderTree(f.folderId,currentFolder)):(poolView!=='all'||!sharedFolders()||(f.folderId||null)===currentFolder))&&f.name.toLocaleLowerCase().includes(query)&&(poolView!=='favorites'||f.favorite)&&(poolView==='trash'||!fileCollection||f.collection===fileCollection));
    const categories=window.RelayPool?.categories||[['all','全部']],classify=f=>window.RelayPool?.category(f)||'other';
    const filters=categories.map(([key,label])=>'<button class="category-filter '+(fileCategory===key?'active':'')+'" data-file-category="'+key+'" aria-pressed="'+(fileCategory===key)+'">'+label+'<span>'+(key==='all'?matching.length:matching.filter(f=>classify(f)===key).length)+'</span></button>').join('');
    if($('file-category-filters').innerHTML!==filters)$('file-category-filters').innerHTML=filters;
    const compare={newest:(a,b)=>new Date(b.createdAt)-new Date(a.createdAt),oldest:(a,b)=>new Date(a.createdAt)-new Date(b.createdAt),largest:(a,b)=>b.size-a.size,smallest:(a,b)=>a.size-b.size,name:(a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'})};
    const files=matching.filter(f=>fileCategory==='all'||classify(f)===fileCategory).sort((a,b)=>(compare[fileSort]||compare.newest)(a,b)||a.id.localeCompare(b.id));$('file-count').textContent=files.length;pool?.sync(files);renderSearch(files);
    for(const id of selectedFiles)if(poolView==='trash'||!active.some(f=>f.id===id))selectedFiles.delete(id);
    document.querySelector('.file-selection-bar').hidden=poolView==='trash';
    const signature=JSON.stringify([state?.device?.id,isHost(),fileQuery,searchScope,state?.folders,fileCategory,poolView,currentFolder,fileCollection,fileSort,poolOrganized(),hasTrash(),files.map(f=>[f,f.senderName||deviceName(f.senderId),targetName(f.targetId),date(f.createdAt,true)])]);
    if(signature===fileListSignature){updateSelection();renderLocalCopies();void refreshLocalCopies();return;}fileListSignature=signature;
    $('file-list').innerHTML=files.length?files.map(f=>{
      const trashed=poolView==='trash',managed=isHost()||f.senderId===state.device.id,kind=window.RelayPool?.previewKind(f);
      const preview=!trashed&&window.RelayPool?.previewable(f)?'<button class="file-preview" data-preview-file="'+escape(f.id)+'" aria-label="预览 '+escape(f.name)+'"><img alt="" hidden><span class="preview-placeholder">'+(kind==='text'?'TXT':kind==='pdf'?'PDF':kind==='video'?icon('play'):icon('file'))+'</span></button>':fileIcon(f.name);
      const checkbox=trashed?'':'<input class="file-checkbox" type="checkbox" data-select-file="'+escape(f.id)+'" aria-label="选择 '+escape(f.name)+'" '+(selectedFiles.has(f.id)?'checked':'')+'>';
      const tags=(f.favorite?'<span class="file-tag">★ 收藏</span>':'')+(f.collection?'<span class="file-tag">'+escape(f.collection)+'</span>':'');
      let actions=trashed?'<button class="icon-button" data-restore-file="'+escape(f.id)+'" title="恢复文件" aria-label="恢复文件">'+icon('restore')+'</button><button class="icon-button danger" data-permanent-file="'+escape(f.id)+'" title="永久删除" aria-label="永久删除">'+icon('trash')+'</button>':
        '<button class="icon-button" data-download="'+escape(f.id)+'" title="'+(desktop?'保存并校验':'下载')+' '+escape(f.name)+'" aria-label="'+(desktop?'保存并校验':'下载')+' '+escape(f.name)+'">'+icon('download')+'</button><button class="icon-button" data-file-info="'+escape(f.id)+'" title="文件详情" aria-label="文件详情">'+icon('info')+'</button>'+
        (poolOrganized()?'<button class="icon-button favorite-button '+(f.favorite?'active':'')+'" data-favorite-file="'+escape(f.id)+'" aria-pressed="'+!!f.favorite+'" title="'+(f.favorite?'取消收藏':'收藏')+'" aria-label="'+(f.favorite?'取消收藏':'收藏')+'">'+icon('star')+'</button><button class="icon-button" data-collection-file="'+escape(f.id)+'" title="私人分类" aria-label="私人分类">'+icon('folder')+'</button>':'')+
        (managed&&sharedFolders()&&!f.targetId?'<button class="icon-button" data-move-file="'+escape(f.id)+'" title="移动或重命名" aria-label="移动或重命名">'+icon('folder')+'</button>':'')+(managed?'<button class="icon-button danger" data-delete-file="'+escape(f.id)+'" title="'+(hasTrash()?'移入回收站':'删除中转站副本')+'" aria-label="'+(hasTrash()?'移入回收站':'删除中转站副本')+'">'+icon('trash')+'</button>':'');
      return '<div class="file-row '+(selectedFiles.has(f.id)?'selected':'')+'" data-file-id="'+escape(f.id)+'"><div class="file-main">'+checkbox+preview+'<div>'+(!trashed?'<button class="file-name file-name-button" data-file-name-preview="'+escape(f.id)+'" title="'+escape(f.name)+'">'+escape(f.name)+'</button>':'<div class="file-name" title="'+escape(f.name)+'">'+escape(f.name)+'</div>')+'<div class="file-location"><span>'+escape(pathLabel(f))+'</span>'+(!trashed?'<button class="text-button" data-locate-file="'+escape(f.id)+'">定位</button>':'')+'</div><div class="file-size">'+size(f.size)+' · '+(trashed?'已移入回收站':'已保存到中转站')+'</div><div class="file-local-copy" hidden></div>'+(tags?'<div class="file-tags">'+tags+'</div>':'')+'</div></div><div class="file-origin"><strong>'+escape(f.senderName||deviceName(f.senderId))+'</strong><small>'+escape(targetName(f.targetId))+'</small></div><div class="file-date">'+escape(date(trashed?f.deletedAt||f.createdAt:f.createdAt,true))+'</div><div class="file-actions">'+actions+'</div></div>';
    }).join(''):empty(fileQuery?'没有找到这个文件':poolView==='trash'?'回收站是空的':poolView==='favorites'?'还没有收藏文件':fileCollection?'这个分类是空的':fileCategory!=='all'?'这个类别还没有文件':'这里等待第一份文件',fileQuery?'试试其他关键词，或切换到全部文件。':poolView==='trash'?'删除的文件会在这里保留，永久删除前可以恢复。':poolView==='favorites'?'点击文件旁的星标，常用文件会出现在这里。':fileCollection?'点击文件旁的私人分类按钮，把它整理到这里。':'点击「添加文件」直接放入当前共享目录，或让另一台设备上传。');
    pool?.mount($('file-list'));updateSelection();renderLocalCopies();void refreshLocalCopies();
  }
  function updateSelection(){const shown=[...document.querySelectorAll('[data-select-file]')],shownIds=new Set(shown.map(el=>el.dataset.selectFile));const checked=shown.filter(el=>selectedFiles.has(el.dataset.selectFile)).length,hidden=[...selectedFiles].filter(id=>!shownIds.has(id)).length;$('select-all-files').checked=shown.length>0&&checked===shown.length;$('select-all-files').indeterminate=checked>0&&checked<shown.length;$('select-all-files').disabled=!shown.length;$('selected-file-count').textContent=selectedFiles.size?'已选择 '+selectedFiles.size+' 个文件'+(hidden?'，其中 '+hidden+' 项不在当前列表':''):(desktop||androidBackground?'选择文件可批量保存并校验':'选择文件可批量下载');$('clear-file-selection').hidden=!selectedFiles.size;$('download-selected').hidden=!selectedFiles.size;$('download-selected').disabled=downloadingBatch||batchRunning;for(const mode of Object.keys(batchLabels)){const button=$('batch-'+mode);button.hidden=!selectedFiles.size||(mode==='move'&&!sharedFolders())||(mode==='trash'&&!hasTrash())||(['favorite','collection'].includes(mode)&&!poolOrganized());button.disabled=batchRunning;}$('pool-selection-bar').dataset.active=String(selectedFiles.size>0);document.body.classList.toggle('pool-selecting',activeTab==='pool'&&selectedFiles.size>0);savePoolView();}
  function renderNotes(){const notes=[...(state?.notes||[])].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));$('note-count').textContent=notes.length;
    const signature=JSON.stringify([state?.device?.id,isHost(),notes.map(n=>[n,n.senderName||deviceName(n.senderId),targetName(n.targetId),date(n.createdAt)])]);
    if(signature===noteListSignature)return;noteListSignature=signature;
    $('note-list').innerHTML=notes.length?notes.map(n=>{let link='';try{const u=new URL(n.text.trim());if(['http:','https:'].includes(u.protocol)&&!/[\r\n]/.test(n.text.trim()))link=u.href;}catch{}return `<article class="card note-card"><div class="note-top"><span class="avatar">${escape((n.senderName||deviceName(n.senderId)).slice(0,1))}</span><span>${escape(n.senderName||deviceName(n.senderId))}</span><time>${escape(date(n.createdAt))}</time></div><div class="note-body">${escape(n.text)}</div><div class="note-bottom"><span class="note-target">${escape(targetName(n.targetId))}</span><div class="note-actions">${link?`<a class="button secondary" href="${escape(link)}" target="_blank" rel="noopener noreferrer">打开链接 ${icon('external')}</a>`:''}<button class="button secondary" data-copy-note="${escape(n.id)}">${icon('copy')}复制</button>${isHost()||n.senderId===state.device.id?`<button class="icon-button danger" data-delete-note="${escape(n.id)}" title="删除文字" aria-label="删除文字">${icon('trash')}</button>`:''}</div></div></article>`;}).join(''):empty('留一段文字给另一台设备','链接、地址、临时笔记，都可以放在这里。','note');}
  function taskStatus(t){switch(t.state){case'duplicate':return'文件池已有相同内容 · 请选择跳过或仍然上传';case'queued':return'等待发送';case'preparing':return`正在校验原文件 · ${t.size?Math.min(100,Math.floor((t.hashOffset||0)/t.size*100)):100}%`;case'uploading':return`${size(t.offset)} / ${size(t.size)}${t.rate>0?' · '+size(t.rate)+'/s':''}`;case'verifying':return'正在核对完整文件校验值';case'paused':return'已暂停 · 点击继续';case'retrying':return`连接中断，正在尝试恢复（${t.attempt||1}/5）`;case'done':return'已保存到中转站';case'cancelled':return t.duplicate?'已跳过重复项':'已取消';case'error':return'传输未完成';default:return'';}}
  function renderQueue(){
    reportDesktopActivity();
    const unfinished=(state?.transfers||[]).filter(t=>!['complete','completed','done','cancelled'].includes(t.status)&&!tasks.some(local=>local.id===t.id));
    $('queue-card').hidden=!tasks.length&&!unfinished.length;$('queue-count').textContent=tasks.filter(t=>!['done','cancelled'].includes(t.state)).length+unfinished.length;
    const count=tasks.filter(t=>['queued','preparing','uploading','verifying','retrying'].includes(t.state)).length;$('nav-transfer-count').textContent=count;$('nav-transfer-count').hidden=!count;
    const taskIds=new Set(tasks.map(t=>t.localId));
    for(const [id,entry]of queueRows)if(!taskIds.has(id)){entry.row.remove();queueRows.delete(id);}
    for(const t of tasks){
      let entry=queueRows.get(t.localId);
      if(!entry){
        const row=document.createElement('div');row.className='queue-item';row.tabIndex=-1;
        row.innerHTML=`${fileIcon(t.name)}<div class="queue-detail"><div class="queue-filename" title="${escape(t.name)}">${escape(t.name)}</div><div class="queue-meta"><span class="queue-status"></span><span class="queue-percent"></span></div><div class="queue-error" hidden></div><div class="progress-track"><div class="progress-fill"></div></div></div><div class="queue-actions"><button class="icon-button queue-pause" data-task="${t.localId}" title="暂停" aria-label="暂停" hidden>${icon('pause')}</button><button class="icon-button queue-resume" data-task="${t.localId}" title="继续传输" aria-label="继续传输" hidden>${icon('play')}</button><button class="icon-button danger queue-cancel" data-task="${t.localId}" title="取消" aria-label="取消" hidden>${icon('close')}</button><span class="icon-button queue-done" style="color:var(--accent)" hidden>${icon('check')}</span></div>`;
        entry={row,status:row.querySelector('.queue-status'),percent:row.querySelector('.queue-percent'),error:row.querySelector('.queue-error'),fill:row.querySelector('.progress-fill'),pause:row.querySelector('.queue-pause'),resume:row.querySelector('.queue-resume'),cancel:row.querySelector('.queue-cancel'),done:row.querySelector('.queue-done')};
        queueRows.set(t.localId,entry);$('upload-queue').appendChild(row);
      }
      const percent=t.state==='done'?100:t.size?Math.min(100,t.offset/t.size*100):0,focused=document.activeElement;
      entry.row.dataset.state=t.state;entry.status.textContent=taskStatus(t);entry.percent.textContent=t.state==='done'?'完成':Math.floor(percent)+'%';entry.error.textContent=t.error||'';entry.error.hidden=!t.error;entry.fill.style.width=percent.toFixed(1)+'%';
      const visibleActions={pause:['queued','preparing','uploading','retrying'].includes(t.state),resume:['paused','error'].includes(t.state),cancel:!['done','cancelled','verifying'].includes(t.state)};
      for(const [action,visible]of Object.entries(visibleActions)){const button=entry[action];button.hidden=!visible;if(visible)button.dataset.taskAction=action;else delete button.dataset.taskAction;}
      entry.done.hidden=t.state!=='done';let duplicateActions=entry.row.querySelector('.duplicate-actions');if(t.state==='duplicate'){if(!duplicateActions){duplicateActions=document.createElement('div');duplicateActions.className='duplicate-actions';duplicateActions.innerHTML='<button class="button secondary small-button" data-task="'+t.localId+'" data-task-action="skip">跳过上传</button><button class="text-button" data-task="'+t.localId+'" data-task-action="force-upload">仍然上传</button>';entry.row.querySelector('.queue-detail').appendChild(duplicateActions);}}else duplicateActions?.remove();
      if(entry.row.contains(focused)&&focused.hidden){const next=visibleActions.resume?entry.resume:visibleActions.pause?entry.pause:entry.row;next.focus({preventScroll:true});}
    }
    $('pending-resume').hidden=!unfinished.length;
    const resumeSignature=unfinished.map(t=>t.id).join('|');if(resumeSignature!==pendingResumeSignature){pendingResumeSignature=resumeSignature;$('pending-resume').innerHTML=unfinished.length?`<div class="resume-notice">${icon('info')}<p>还有 ${unfinished.length} 个未完成上传。重新选择原文件，并选择原接收范围，可从已保存的位置继续。</p><button class="button secondary small-button" id="resume-select">选择原文件</button></div>`:'';}
  }
  async function hash(data){if(globalThis.crypto?.subtle){try{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('');}catch{}}if(!globalThis.RelayHash)throw new Error('校验模块未加载，请刷新页面后重试');return await RelayHash.hex(data instanceof Uint8Array?data:new Uint8Array(data));}
  async function fingerprint(file,signal,onProgress){
    if(!globalThis.RelayHash?.create)throw new Error('完整文件校验模块未加载，请刷新页面后重试');
    const digest=RelayHash.create(),blockSize=1048576;let lastProgress=0;
    const checkCancelled=()=>{if(signal?.aborted)throw new DOMException('文件校验已取消','AbortError');};
    checkCancelled();
    for(let offset=0;offset<file.size;offset+=blockSize){checkCancelled();const chunk=new Uint8Array(await file.slice(offset,Math.min(offset+blockSize,file.size)).arrayBuffer());checkCancelled();digest.update(chunk);const processed=Math.min(offset+blockSize,file.size);if(processed===file.size||performance.now()-lastProgress>100){onProgress?.(processed);lastProgress=performance.now();}await new Promise(resolve=>setTimeout(resolve,0));checkCancelled();}
    onProgress?.(file.size);return digest.hex();
  }
  function addFiles(files,folderOverride,announce=true,targetOverride=undefined){if(!state)return 0;let added=0;const targetId=targetOverride===undefined?($('file-target').value||null):targetOverride;for(const file of files){if(state.limits?.maxFileSize&&file.size>state.limits.maxFileSize){toast(`${file.name} 超过单文件限制 ${size(state.limits.maxFileSize)}`,'error');continue;}tasks.push({localId:++sequence,context:poolContextKey(),file,name:file.name,size:file.size,targetId,folderId:targetId?null:folderOverride===undefined?($('upload-folder').value||null):folderOverride,offset:0,hashOffset:0,id:null,state:'queued',active:false,rate:0,attempt:0,error:''});added++;}if(added&&announce){goTab('transfer');renderQueue();pump();toast(`已加入 ${added} 个文件`);}return added;}
  function pump(){if(!token)return;let running=tasks.filter(t=>t.active).length;for(const task of tasks){if(running>=2)break;if(task.state==='queued'&&!task.active){task.active=true;running++;runTask(task).finally(()=>{task.active=false;renderQueue();pump();});}}}
  function selectionKey(t){return JSON.stringify([t.name,t.size,t.fingerprint,t.targetId,t.folderId]);}
  async function runTask(t){
    const controller=new AbortController();t.controller=controller;
    try{
      t.state='preparing';t.error='';renderQueue();
      if(t.needsCleanup)await clearCorruptTransfer(t);
      if(!t.fingerprint)t.fingerprint=await fingerprint(t.file,controller.signal,processed=>{t.hashOffset=processed;renderQueue();});
      if(['paused','cancelled'].includes(t.state))return;
      const duplicate=tasks.find(other=>other!==t&&!['done','cancelled'].includes(other.state)&&other.fingerprint===t.fingerprint&&other.name===t.name&&other.size===t.size&&other.targetId===t.targetId&&other.folderId===t.folderId);
      const completedEarlierInBatch=(completedSelections.get(selectionKey(t))||0)>=t.localId;
      if(duplicate||completedEarlierInBatch){t.state='cancelled';t.duplicate=true;t.error=duplicate?'相同内容已在队列中，请继续原任务':'本批次相同内容已发送，无需重复上传';toast(`${t.name} 已跳过重复项`,'info');return;}
      if(!t.id&&!t.duplicateChecked&&state?.capabilities?.duplicateDetection){const found=await api('/api/files/duplicates',{method:'POST',body:{sha256:t.fingerprint,size:t.size,targetId:t.targetId,folderId:t.folderId},signal:controller.signal});if(found.matches?.length){t.state='duplicate';t.error='同一接收范围和目录已有完整副本：'+found.matches[0].name;t.duplicateMatch=found.matches[0];renderQueue();return;}t.duplicateChecked=true;}
      let response;
      if(t.id){try{response=await api(`/api/transfers/${encodeURIComponent(t.id)}`,{signal:controller.signal});}catch(error){if(error.status===404)t.id=null;else throw error;}}
      if(!t.id){response=await api('/api/transfers',{method:'POST',body:{name:t.name,size:t.size,lastModified:t.file.lastModified,fingerprint:t.fingerprint,targetId:t.targetId,folderId:t.folderId}});t.id=response.id;}
      if(t.state==='cancelled'){await api(`/api/transfers/${encodeURIComponent(t.id)}`,{method:'DELETE'}).catch(()=>{});return;}
      if(t.state==='paused')return;
      if(!response||!t.id)throw new Error('服务器没有返回有效的传输任务');
      t.offset=Number(response.offset)||0;const chunkSize=Number(response.chunkSize)||state?.limits?.chunkSize||1048576;
      if(t.offset>t.size||t.offset<0)throw new Error('恢复位置不正确，请取消后重新发送');
      while(t.offset<t.size){
        if(['paused','cancelled'].includes(t.state))return;t.state='uploading';renderQueue();
        const start=t.offset;const chunk=new Uint8Array(await t.file.slice(start,Math.min(start+chunkSize,t.size)).arrayBuffer());const digest=await hash(chunk);
        if(['paused','cancelled'].includes(t.state))return;
        const began=performance.now();let next;
        try{next=await api(`/api/transfers/${encodeURIComponent(t.id)}`,{method:'PUT',body:chunk,headers:{'Content-Type':'application/octet-stream','X-Offset':String(start),'X-Chunk-SHA256':digest},signal:controller.signal});}catch(error){if(error.status===409&&Number.isSafeInteger(error.offset)&&error.offset>=0&&error.offset<=t.size&&error.offset!==start){t.offset=error.offset;continue;}throw error;}
        if(!Number.isSafeInteger(next?.offset)||next.offset<=start||next.offset>t.size)throw new Error('服务器返回的传输进度不正确');
        t.offset=next.offset;t.rate=chunk.length/Math.max(.05,(performance.now()-began)/1000);t.attempt=0;renderQueue();
      }
      if(['paused','cancelled'].includes(t.state))return;
      t.state='verifying';renderQueue();const complete=await api(`/api/transfers/${encodeURIComponent(t.id)}/complete`,{method:'POST',body:{},signal:controller.signal});
      if(!complete||String(complete.sha256||'').toLowerCase()!==t.fingerprint){
        let removed=false;
        if(complete?.id)try{await api(`/api/files/${encodeURIComponent(complete.id)}`,{method:'DELETE'});removed=true;}catch{}
        t.id=null;t.offset=0;t.fingerprint=null;t.hashOffset=0;
        const mismatch=new Error(removed?(hasTrash()?'完整文件校验不一致，本次副本已移入回收站，请勿恢复。请重新选择原文件后重试。':'完整文件校验不一致，已删除本次中转站副本。请重新选择原文件后重试。'):'完整文件校验不一致，未能确认移除本次中转站副本。请先检查文件池并删除该文件后重试。');mismatch.status=422;mismatch.code='FILE_HASH_MISMATCH';await refresh(true);throw mismatch;
      }
      t.state='done';t.offset=t.size;t.error='';t.result=complete;completedSelections.set(selectionKey(t),sequence);renderQueue();await refresh(true);
    }catch(error){
      if(['paused','cancelled'].includes(t.state)||error.name==='AbortError')return;
      if(error.code==='FILE_HASH_MISMATCH'&&t.id){
        t.needsCleanup=true;
        try{await clearCorruptTransfer(t);error.message='完整文件校验不一致，已清除临时副本。点击继续可从头重新发送。';}
        catch{error.message='完整文件校验不一致，临时副本尚未清除。请恢复连接后点击继续，先清理再重新发送。';}
        if(['paused','cancelled'].includes(t.state))return;
      }
      if(error.status===401||error.status===403){t.state='error';t.error='访问权限已失效，请重新配对';if(error.status===401)logout(t.error);return;}
      if((error.network||!error.status||error.status>=500)&&t.attempt<5){t.attempt++;t.state='retrying';t.error='';const wait=Math.min(15000,1000*2**(t.attempt-1));setTimeout(()=>{if(t.state==='retrying'){t.state='queued';renderQueue();pump();}},wait);}
      else{t.state='error';t.error=error.message||'传输失败，请重试';toast(`${t.name}：${t.error}`,'error');}
    }finally{t.controller=null;renderQueue();}
  }
  async function clearCorruptTransfer(t){
    try{if(t.id)await api(`/api/transfers/${encodeURIComponent(t.id)}`,{method:'DELETE'});}
    catch(error){if(error.status!==404){const failure=new Error('临时副本尚未清除，请恢复连接后再试，或取消该任务。');failure.status=422;throw failure;}}
    t.id=null;t.offset=0;t.fingerprint=null;t.hashOffset=0;t.needsCleanup=false;
  }
  async function taskAction(id,action){const t=tasks.find(t=>t.localId===Number(id));if(!t)return;if(action==='skip'){t.state='cancelled';t.duplicate=true;t.error='已跳过，文件池已有同内容原件';renderQueue();pump();return;}if(action==='force-upload'){t.duplicateChecked=true;t.state='queued';t.error='';renderQueue();pump();return;}if(action==='pause'){t.state='paused';t.controller?.abort();}if(action==='resume'){t.state='queued';t.error='';t.attempt=0;pump();}if(action==='cancel'){t.state='cancelled';t.controller?.abort();if(t.id)try{await api(`/api/transfers/${encodeURIComponent(t.id)}`,{method:'DELETE'});await refresh(true);}catch(error){if(error.status!==404)toast('本地队列已取消；未能清除服务端临时文件，请恢复连接后再处理。','error');}}renderQueue();}
  function confirm(title,description,label='确认',tone='danger'){if($('confirm-dialog').open)return Promise.resolve(false);return new Promise(resolve=>{confirmResolve=resolve;$('confirm-title').textContent=title;$('confirm-description').textContent=description;$('confirm-yes').textContent=label;$('confirm-yes').className=`button ${tone}`;$('confirm-dialog').returnValue='cancel';$('confirm-dialog').showModal();});}
  function showText(title,value,hint='选择下方文字，使用系统菜单复制。'){$('text-dialog-title').textContent=title;$('text-dialog-value').value=value;$('text-dialog-hint').textContent=hint;$('text-dialog').showModal();}
  function setLocalVerification(status,message,percent=0){
    const running=status==='running';$('local-verification').dataset.state=status;$('verify-status').textContent=message;
    $('verify-progress').hidden=!running;$('verify-progress').value=percent;
    $('cancel-file-verify').hidden=!running;$('choose-verify-file').disabled=running||!detailFile?.sha256?.match(/^[a-f0-9]{64}$/i);
    $('save-and-verify').disabled=$('choose-verify-file').disabled;
    $('cancel-file-verify').disabled=false;reportDesktopActivity();
  }
  function cancelLocalVerification(){
    if(localVerification){localVerification.abort();localVerification=null;setLocalVerification('cancelled','已取消校验，本次未确认文件完整性。');}
  }
  function showFileDetails(file){
    cancelLocalVerification();detailNativeRequest=null;detailFile={...file};$('verify-file-input').value='';
    $('file-detail-name').textContent=file.name;$('file-detail-size').textContent=`${size(file.size)}（${file.size} 字节）`;
    $('file-detail-origin').textContent=file.senderName||deviceName(file.senderId);$('file-detail-target').textContent=targetName(file.targetId);$('file-detail-date').textContent=date(file.createdAt);
    $('file-detail-hash').textContent=file.sha256||'无可用校验值';
    $('save-and-verify').hidden=!(desktop||window.isSecureContext&&typeof window.showSaveFilePicker==='function'&&['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&!isAndroidHost());
    setLocalVerification('idle',desktop?'尚未校验本设备的文件。选择「保存并校验」，或核对已有的本地副本。':'尚未校验本设备的文件。下载保存后，选择本地副本核对。');$('file-dialog').showModal();
    const pending=desktop&&[...nativeSaves.values()].find(t=>t.fileId===file.id&&!nativeSaveFinished(t));if(pending){detailNativeRequest=pending.requestId;renderNativeSaves();}
  }
  async function verifySavedFile(file){
    if(!detailFile||!file)return;
    cancelLocalVerification();detailNativeRequest=null;const expected={...detailFile},controller=new AbortController();localVerification=controller;
    setLocalVerification('running',`正在校验「${file.name}」 · 0%`);
    try{
      if(file.size!==expected.size){setLocalVerification('mismatch',`不匹配：所选文件为 ${file.size} 字节，应为 ${expected.size} 字节。请确认选择了完整下载的副本。`);return;}
      const actual=await fingerprint(file,controller.signal,processed=>{
        if(localVerification!==controller)return;const percent=file.size?Math.floor(processed/file.size*100):100;
        setLocalVerification('running',`正在校验「${file.name}」 · ${percent}%`,percent);
      });
      if(controller.signal.aborted||localVerification!==controller)return;
      if(actual===expected.sha256.toLowerCase())setLocalVerification('passed',`校验通过：「${file.name}」的大小与完整 SHA-256 均一致。本次选中的本地副本内容完整。`);
      else setLocalVerification('mismatch',`不匹配：「${file.name}」的内容与中转站副本不同，请重新下载后再校验。`);
    }catch(error){
      if(localVerification!==controller)return;
      setLocalVerification(error.name==='AbortError'?'cancelled':'error',error.name==='AbortError'?'已取消校验，本次未确认文件完整性。':'无法读取或校验这个文件，请重新选择。'+(error.message||''));
    }finally{if(localVerification===controller)localVerification=null;reportDesktopActivity();}
  }
  async function saveAndVerifyFile(){
    if(!detailFile||localVerification)return;
    if(desktop){await startNativeSave(detailFile.id,{details:true});return;}
    const expected={...detailFile},controller=new AbortController();localVerification=controller;let writable=null,closed=false;
    const checkCancelled=()=>{if(controller.signal.aborted)throw new DOMException('已取消保存校验','AbortError');};
    // The picker is invoked directly from this click, before any network await.
    let picked;
    try{picked=window.showSaveFilePicker({suggestedName:expected.name});}
    catch(error){localVerification=null;setLocalVerification('error','无法选择保存位置，本次未校验。请使用普通下载后校验已保存文件。');return;}
    setLocalVerification('running','请选择保存位置，然后自动读取保存的副本核对。');
    try{
      const handle=await picked;checkCancelled();
      const ticket=await api(`/api/files/${encodeURIComponent(expected.id)}/ticket`,{method:'POST',body:{},signal:controller.signal});checkCancelled();
      const url=new URL(ticket?.url||'',location.origin);if(!ticket?.url||url.origin!==location.origin)throw new Error('服务器返回了无效的下载地址');
      const response=await fetch(url.href,{signal:controller.signal,cache:'no-store'});if(!response.ok||!response.body)throw new Error(`下载未完成（${response.status}）`);
      checkCancelled();writable=await handle.createWritable();checkCancelled();const reader=response.body.getReader();let written=0;
      try{while(true){checkCancelled();const chunk=await reader.read();if(chunk.done)break;written+=chunk.value.byteLength;if(written>expected.size)throw new Error('收到的文件大小与记录不一致');await writable.write(chunk.value);checkCancelled();setLocalVerification('running',`正在保存 · ${size(written)} / ${size(expected.size)}`,expected.size?Math.floor(written/expected.size*100):100);}}
      finally{reader.releaseLock();}
      if(written!==expected.size)throw new Error('下载内容不完整');checkCancelled();await writable.close();closed=true;checkCancelled();
      const saved=await handle.getFile();checkCancelled();if(saved.size!==expected.size)throw new Error('保存副本的大小不一致');
      const actual=await fingerprint(saved,controller.signal,processed=>{if(localVerification===controller){const percent=saved.size?Math.floor(processed/saved.size*100):100;setLocalVerification('running',`正在读取保存副本核对 · ${percent}%`,percent);}});checkCancelled();
      if(actual!==expected.sha256.toLowerCase()){setLocalVerification('mismatch','保存副本的 SHA-256 不匹配，本次未确认完整性。请重新保存并校验。');return;}
      setLocalVerification('passed',`已保存并校验：「${saved.name}」的大小与完整 SHA-256 均一致。`);
    }catch(error){
      if(localVerification===controller)setLocalVerification(error.name==='AbortError'?'cancelled':'error',error.name==='AbortError'?'已取消保存校验，本次未确认保存副本的完整性。':`${error.message||'保存或读取失败'}。本次未校验通过，请重试或使用普通下载。`);
    }finally{
      controller.abort();if(writable&&!closed)try{await writable.abort();}catch{}
      if(localVerification===controller)localVerification=null;
    }
  }
  async function copyText(text){try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);toast('已复制');return true;}}catch{}const area=document.createElement('textarea');area.value=text;area.style.cssText='position:fixed;left:-9999px;top:0;font-size:16px';document.body.appendChild(area);area.focus();area.select();let ok=false;try{ok=document.execCommand('copy');}catch{}area.remove();if(ok){toast('已复制');return true;}showText('手动复制',text,'当前浏览器限制自动复制。长按下方文字或点击「全选文字」，然后使用系统复制。');return false;}
  async function downloadFile(id,announce=true){if(androidBackground)return requestAndroidSave([id]);if(desktop)return (await startNativeSave(id,{announce})).status==='completed';try{const ticket=await api(`/api/files/${encodeURIComponent(id)}/ticket`,{method:'POST',body:{}});if(!ticket?.url)throw new Error('未能获取下载地址');const url=new URL(ticket.url,location.origin);if(url.origin!==location.origin)throw new Error('服务器返回了无效的下载地址');const a=document.createElement('a');a.href=url.href;a.download='';a.rel='noopener';document.body.appendChild(a);a.click();a.remove();if(announce)toast('已交给浏览器下载，请在下载列表确认保存。','info');return true;}catch(error){toast(error.message,'error');return false;}}
  async function downloadSelected(){const visible=new Set([...document.querySelectorAll('[data-select-file]')].map(el=>el.dataset.selectFile)),hidden=[...selectedFiles].filter(id=>!visible.has(id)).length;if(hidden&&!await confirm('包含当前列表以外的文件','已选中 '+selectedFiles.size+' 个文件，其中 '+hidden+' 个被当前筛选隐藏。继续会保存全部选中项；也可取消后清空选择。','保存全部选中项','primary'))return;if(androidBackground){requestAndroidSave([...selectedFiles]);return;}if(desktop){await saveSelectedOnDesktop();return;}if(downloadingBatch||!selectedFiles.size)return;const ids=[...selectedFiles];if(ids.length>1&&!await confirm('批量下载文件',`将向浏览器请求下载 ${ids.length} 个文件。浏览器可能询问是否允许多个文件下载，请选择允许，并在下载列表确认保存结果。`,'开始下载','primary'))return;downloadingBatch=true;updateSelection();let requested=0;for(const id of ids){if(await downloadFile(id,false))requested++;await new Promise(resolve=>setTimeout(resolve,180));}downloadingBatch=false;updateSelection();toast(`已请求下载 ${requested} 个文件，请在浏览器中确认。`,'info',6500);}
  function requestAndroidSave(ids){const unique=[...new Set(ids)];if(!unique.length)return false;if(unique.length>100){toast('安卓每批最多保存 100 个文件，请分批选择。','error');return false;}if(unique.some(id=>!state?.files?.some(f=>f.id===id))){toast('文件列表已变化，请刷新后重新选择。','error');return false;}location.href='relaydrop://save-files?ids='+encodeURIComponent(unique.join(','));return true;}
  async function saveSelectedOnDesktop(){
    if(downloadingBatch||!selectedFiles.size)return;const ids=[...selectedFiles];
    if(typeof desktop.saveBatch==='function'){await saveBatchOnDesktop(ids);return;}
    if(ids.length>1&&!await confirm('批量保存并校验',`将依次保存 ${ids.length} 个文件，每个文件只在前一个保存并校验结束后选择位置。可以随时取消余下任务。`,'开始保存','primary'))return;
    downloadingBatch=true;desktopBatchStopped=false;updateSelection();renderNativeSaves();let completed=0,failed=0,cancelled=0;
    try{for(const id of ids){if(desktopBatchStopped)break;const result=await startNativeSave(id,{announce:false,batch:true});desktopBatchRequest=null;if(result.status==='completed')completed++;else if(result.status==='failed')failed++;else cancelled++;}}
    finally{downloadingBatch=false;desktopBatchRequest=null;updateSelection();renderNativeSaves();}
    const remaining=ids.length-completed-failed-cancelled;
    toast(`已保存并校验 ${completed} 个${failed?'，失败 '+failed+' 个':''}${cancelled+remaining?'，取消 '+(cancelled+remaining)+' 个':''}。`,failed?'error':completed?'success':'info',6500);
  }
  async function changeFile(id,changes){if(pendingFileChanges.has(id))return;pendingFileChanges.add(id);try{await api('/api/files/'+encodeURIComponent(id),{method:'PATCH',body:changes});await refresh(true);}catch(error){toast(error.message,'error');}finally{pendingFileChanges.delete(id);}}
  async function toggleFavorite(id){const file=state?.files?.find(f=>f.id===id);if(file&&poolOrganized())await changeFile(id,{favorite:!file.favorite});}
  function openCollection(id=null){if(!poolOrganized())return;if(id&&pendingFileChanges.has(id)){toast('正在整理此文件，请稍后重试。','info');return;}collectionFile=id?state.files.find(f=>f.id===id):null;if(id&&!collectionFile)return;
    $('collection-title').textContent=collectionFile?'私人分类':'新建私人分类';$('collection-name-field').hidden=!!collectionFile;$('collection-picker-field').hidden=!collectionFile;$('collection-name').value='';$('collection-error').hidden=true;$('collection-submit').disabled=false;
    $('collection-description').textContent=collectionFile?'为“'+collectionFile.name+'”选择文件夹。仅整理当前设备的视图，其他设备的文件夹和访问权限不变。':'文件夹用于整理当前设备看到的文件，不会复制文件或改变访问权限。';
    $('collection-picker').innerHTML=collectionOptions();$('collection-picker').value=collectionFile?.collection||'';$('collection-submit').textContent=collectionFile?'保存':'创建';$('collection-dialog').showModal();setTimeout(()=>(collectionFile?$('collection-picker'):$('collection-name')).focus(),0);
  }
  async function deleteCollection(){if(!fileCollection||!poolOrganized())return;const name=fileCollection;if(!await confirm('移除这个文件夹？','仅移除“'+name+'”的分类标签，其中的文件会保留在全部文件中。','移除文件夹'))return;
    try{await api('/api/collections/'+encodeURIComponent(name),{method:'DELETE'});fileCollection='';await refresh(true);toast('文件夹已移除，文件已保留');}catch(error){toast(error.message,'error');}
  }
  async function deleteFile(id){const f=state?.files?.find(f=>f.id===id);if(!f||pendingFileChanges.has(id))return;const recoverable=hasTrash();
    if(!await confirm(recoverable?'移入回收站？':'删除中转站中的文件？',recoverable?'“'+f.name+'”将暂时从文件池移除，有管理权限的设备可在回收站恢复。已保存到设备的副本不受影响。':'当前中转站不支持回收站。“'+f.name+'”的中转站副本会直接删除，无法恢复。已保存到设备的副本不受影响。',recoverable?'移入回收站':'删除文件'))return;
    pendingFileChanges.add(id);try{await api('/api/files/'+encodeURIComponent(id),{method:'DELETE'});toast(recoverable?'已移入回收站，可恢复':'已删除中转站副本');await refresh(true);}catch(error){toast(error.message,'error');}finally{pendingFileChanges.delete(id);}}
  async function restoreFile(id){if(!hasTrash()||pendingFileChanges.has(id))return;pendingFileChanges.add(id);try{await api('/api/files/'+encodeURIComponent(id)+'/restore',{method:'POST',body:{}});await refresh(true);toast('文件已恢复，接收范围保持不变');}catch(error){toast(error.message,'error');}finally{pendingFileChanges.delete(id);}}
  async function permanentlyDelete(id){const file=state?.trash?.find(f=>f.id===id);if(!hasTrash()||!file||pendingFileChanges.has(id))return;if(!await confirm('永久删除，无法撤销','将永久删除中转站中的“'+file.name+'”（'+size(file.size)+'），无法再从回收站恢复。请先确认已保存需要保留的副本。','永久删除'))return;
    pendingFileChanges.add(id);try{await api('/api/files/'+encodeURIComponent(id)+'/permanent',{method:'DELETE'});await refresh(true);toast('中转站副本已永久删除');}catch(error){toast(error.message,'error');}finally{pendingFileChanges.delete(id);}}
  async function deleteNote(id){if(!await confirm('删除这条文字？','这条文字会从中转站收件箱中移除。','删除'))return;try{await api(`/api/notes/${encodeURIComponent(id)}`,{method:'DELETE'});await refresh(true);toast('已删除');}catch(error){toast(error.message,'error');}}
  async function revokeDevice(id){if(!await confirm('移除这台设备？',`${deviceName(id)} 将立即失去访问权限。重新加入需要新的配对码。`,'移除设备'))return;try{await api(`/api/devices/${encodeURIComponent(id)}/revoke`,{method:'POST',body:{}});toast('设备已移除');await refresh(true);}catch(error){toast(error.message,'error');}}
  async function launchBluetooth(action,button){button.disabled=true;try{const result=await api(`/api/bluetooth/${action}`,{method:'POST',body:{}});toast(result.message||'系统蓝牙窗口已打开，请在该窗口中继续。','info',6500);}catch(error){toast(error.message,'error');}finally{button.disabled=false;}}
  $('pair-form').addEventListener('submit',async e=>{e.preventDefault();$('pair-error').hidden=true;$('pair-submit').disabled=true;$('pair-submit').textContent='正在加入…';try{const name=$('device-name').value.trim();if(!name)throw new Error('请给设备起个名字');const data=await api('/api/pair',{method:'POST',body:{code:$('pair-code').value.trim(),name},noAuth:true,timeout:15000});token=data.token;if(!token)throw new Error('没有收到有效的连接凭证');storage.remove('relay-host-token',true);storage.set('relay-guest-token',token);storage.set('relay-device-name',name);lastRender='';await refresh(true);if(state)toast('设备已加入，可以开始传送了');}catch(error){$('pair-error').textContent=error.message;$('pair-error').hidden=false;}finally{$('pair-submit').disabled=false;$('pair-submit').innerHTML='加入中转站 <span>↗</span>';}});
  if(desktop){
    document.documentElement.classList.add('desktop-app');document.querySelector('.sidebar-footer span').textContent='桌面版';
    $('download-selected').textContent='保存并校验选中项';
    document.querySelector('.send-foot span:last-child').textContent='传输时请保持应用运行。退出后，重新选择原文件可继续上传。';
    document.querySelector('.checksum-hint').textContent='这是原文件传入中转站后的完整校验值。保存时会读取落盘副本，核对大小与完整 SHA-256。';
    $('download-help').textContent='点击文件旁的保存按钮，选择位置后自动保存并读回核对。只有大小与完整 SHA-256 一致，才会显示「已保存并校验」。批量保存只需选择一次文件夹；文件逐个保存并校验，取消或失败不会改变中转站副本。仍可在文件详情中核对已有的本地文件。';
    $('desktop-exit-help').hidden=!!desktop.isRemote;
    if(desktop.isRemote){document.querySelector('.send-card .quiet-tag').textContent='加密远程传输';document.querySelector('.sidebar-footer span').textContent='远程文件池';document.querySelector('.send-foot span:last-child').textContent='远程传输会使用网络流量，请保持两端程序运行。';$('download-help').textContent='远程文件通过已核对设备身份的加密连接保存。大小、完整 SHA-256 及落盘读回全部一致后，才显示「已保存并校验」。关闭这个窗口会断开远程连接。';}
    $('desktop-save-status').addEventListener('click',()=>{goTab('transfer');$('desktop-download-card').scrollIntoView({block:'center',behavior:'smooth'});});
    $('desktop-clear-saves').addEventListener('click',()=>{for(const [id,t]of nativeSaves)if(nativeSaveFinished(t)&&id!==detailNativeRequest)nativeSaves.delete(id);for(const [id,t]of nativeIncoming)if(nativeSaveFinished(t))nativeIncoming.delete(id);if(nativeBatch&&nativeSaveFinished(nativeBatch))nativeBatch=null;renderNativeSaves();});
    $('desktop-cancel-batch').addEventListener('click',async()=>{desktopBatchStopped=true;renderNativeSaves();if(!desktopBatchRequest)return;try{if(nativeBatch?.requestId===desktopBatchRequest)await desktop.cancelSave(desktopBatchRequest);else await cancelNativeSave(desktopBatchRequest);}catch(error){desktopBatchStopped=false;renderNativeSaves();toast(error.message||'暂时无法取消，请重试','error');}});
    desktop.onSaveProgress(acceptNativeSaveProgress);desktop.onBatchProgress?.(acceptBatchProgress);reportDesktopActivity();
    if(desktop.getSettings){desktop.getSettings().then(applyDesktopSettings).catch(()=>{});desktop.onSettingsChanged?.(applyDesktopSettings);}
    if(desktop.getIncomingFilesStatus){desktop.getIncomingFilesStatus().then(items=>{if(Array.isArray(items))items.forEach(acceptIncomingProgress);}).catch(()=>{});desktop.onIncomingFilesProgress?.(acceptIncomingProgress);}
    async function updateDesktopSetting(changes){try{applyDesktopSettings(await desktop.updateSettings(changes)||await desktop.getSettings());}catch(error){if(desktopSettings)applyDesktopSettings(desktopSettings);toast(error.message||'设置未保存，请重试','error');}}
    $('launch-at-login').addEventListener('change',async()=>{const value=$('launch-at-login').checked;$('launch-at-login').disabled=true;await updateDesktopSetting({launchAtLogin:value});});
    $('desktop-save-mode').addEventListener('change',async()=>{const mode=$('desktop-save-mode').value;$('desktop-save-mode').disabled=true;try{if(mode==='fixed'&&!desktopSettings?.receiveDirectory){applyDesktopSettings(await desktop.chooseReceiveDirectory());if(!desktopSettings?.receiveDirectory)return;}await updateDesktopSetting({saveMode:mode});}catch(error){if(desktopSettings)applyDesktopSettings(desktopSettings);toast(error.message||'未能选择保存目录','error');}finally{$('desktop-save-mode').disabled=false;}});
    $('choose-receive-directory').addEventListener('click',async()=>{try{applyDesktopSettings(await desktop.chooseReceiveDirectory());}catch(error){toast(error.message||'未能选择保存目录','error');}});
    $('clear-receive-directory').addEventListener('click',async()=>{try{applyDesktopSettings(await desktop.clearReceiveDirectory());}catch(error){toast(error.message||'未能清除保存目录','error');}});
    $('close-to-tray').addEventListener('change',async()=>{const checkbox=$('close-to-tray');checkbox.disabled=true;try{const settings=await desktop.updateSettings({closeToTray:checkbox.checked});applyDesktopSettings(settings||await desktop.getSettings());}catch(error){if(desktopSettings)applyDesktopSettings(desktopSettings);toast(error.message||'设置未保存，请重试','error');}});
    document.addEventListener('click',event=>{const anchor=event.target.closest('a[target="_blank"]');if(!anchor||!desktop.openExternal)return;let url;try{url=new URL(anchor.href);if(!['http:','https:'].includes(url.protocol))return;}catch{return;}event.preventDefault();desktop.openExternal(url.href).then(opened=>{if(!opened)toast('链接未打开，请复制后在浏览器中打开。','info');}).catch(error=>toast(error.message||'链接无法打开','error'));});
  }

  const storageCard=document.createElement('section');storageCard.id='pool-storage-card';storageCard.className='card storage-card';storageCard.hidden=true;
  storageCard.innerHTML='<div class="card-heading"><h2>文件池备份与迁移</h2><span id="storage-status" class="quiet-tag">保存在本机</span></div><p class="micro">关闭程序不会删除文件。备份可选密码加密；备份与迁移均校验原件。密码丢失后无法恢复加密备份。</p><p id="storage-location" class="micro"></p><div id="storage-desktop-actions" class="storage-actions"><button class="button secondary small-button" data-storage-action="open">打开数据目录</button><button class="button secondary small-button" data-storage-action="backup-encrypted">加密备份</button><button class="button secondary small-button" data-storage-action="backup">普通备份（未加密）</button><button class="button secondary small-button" data-storage-action="restore">恢复备份</button><button class="button secondary small-button" data-storage-action="migrate">迁移到其他磁盘</button><button id="cancel-storage" class="text-button" hidden>取消操作</button></div><a id="storage-android-open" class="button secondary small-button" href="relaydrop://storage" hidden>打开文件池管理</a><progress id="storage-progress" class="storage-progress" max="1" value="0" hidden></progress><p id="storage-feedback" class="micro" role="status"></p>';
  $('desktop-settings-card').before(storageCard);
  function storageUpdate(value){if(!value)return;if(value.dataDir)$('storage-location').textContent='文件池保存位置：'+value.dataDir;if(value.lastResult){$('storage-feedback').textContent=value.lastResult.success?'上次操作已完成并校验：'+value.lastResult.path+(value.lastResult.mergedPaths?'。深层目录已按原路径合并，已有文件未覆盖。':'')+(value.lastResult.warning?'。'+value.lastResult.warning:''):value.lastResult.error;}}
  function renderStorage(){const localDesktop=!!desktop?.poolStorage&&isHost(),localAndroid=androidBackground&&isHost()&&isAndroidHost();storageCard.hidden=!localDesktop&&!localAndroid;$('storage-desktop-actions').hidden=!localDesktop;$('storage-android-open').hidden=!localAndroid;if(localAndroid)$('storage-location').textContent='文件池保存在此安卓设备的应用数据目录，点击下方进行备份或恢复。';if(!isHost())$('desktop-settings-card').hidden=true;}
  if(desktop?.poolStorage){
    desktop.poolStorage({action:'state'}).then(storageUpdate).catch(()=>{});
    desktop.onStorageProgress?.(value=>{const finished=['completed','failed'].includes(value.phase);$('storage-status').textContent=finished?(value.phase==='completed'?'校验完成':'操作已停止'):'维护中';$('storage-progress').hidden=finished;$('storage-progress').max=Math.max(1,value.total||1);$('storage-progress').value=value.completed||0;$('cancel-storage').hidden=finished;$('storage-feedback').textContent=value.error||({stopping:'正在停止设备连接…',copying:'正在复制并校验文件…',verifying:'正在读回校验…',completed:'已完成，正在恢复文件池…',failed:'操作未完成，正在恢复原文件池…'}[value.phase]||'正在处理文件池…');});
    storageCard.addEventListener('click',async event=>{const requested=event.target.closest('[data-storage-action]')?.dataset.storageAction;if(!requested)return;const encrypted=requested==='backup-encrypted',action=encrypted?'backup':requested;const buttons=storageCard.querySelectorAll('[data-storage-action]');buttons.forEach(b=>b.disabled=true);if(action!=='open')stopped=true;try{const result=await desktop.poolStorage({action,...(encrypted?{encrypted:true}:{})});storageUpdate(result);}catch(error){$('storage-feedback').textContent=error.message||'操作未完成';}finally{stopped=false;buttons.forEach(b=>b.disabled=false);void refresh(true);}});
    $('cancel-storage').addEventListener('click',async()=>{await desktop.poolStorage({action:'cancel'}).catch(()=>{});$('storage-feedback').textContent='正在安全取消，原文件池会保留…';});
  }

  if(desktop?.remoteAction){
    const card=document.createElement('section');card.id='remote-settings-card';card.className='card remote-settings-card';
    card.innerHTML='<div class="card-heading"><h2>远程连接</h2><span id="remote-status" class="quiet-tag" role="status">未配置</span></div><p class="section-description">让不同网络的设备访问这台电脑的文件池。文件保留在这台电脑，远程访问时电脑和程序需保持运行。</p><p class="inline-notice remote-deployment-note">当前未提供已部署的公网中继。填入你自行配置的中继服务后才能跨网络连接；不配置不影响局域网和蓝牙。</p><div class="remote-columns"><form id="remote-host-form" class="remote-form"><h3>共享本机文件池</h3><label for="remote-relay">中继地址</label><input id="remote-relay" type="text" placeholder="tls://relay.example.com:443" maxlength="512" autocomplete="off" spellcheck="false"><label for="remote-service-key">中继接入密钥</label><input id="remote-service-key" type="password" placeholder="由中继管理员提供" maxlength="128" autocomplete="new-password"><label for="remote-relay-pin">中继证书指纹（可选）</label><input id="remote-relay-pin" type="text" placeholder="留空时校验受信证书与域名" maxlength="64" autocomplete="off" spellcheck="false"><p class="micro">自签名中继须填写其完整 SHA-256 指纹。接入密钥通过 Windows 凭据保护保存。</p><div class="remote-actions"><button class="button secondary small-button" type="submit">保存配置</button><button class="button primary small-button" id="remote-start" type="button">启用远程共享</button><button class="text-button" id="remote-stop" type="button">停止</button></div><div class="remote-actions"><button class="text-button" id="remote-copy-invite" type="button">复制连接邀请</button><button class="text-button" id="remote-rotate" type="button">更换邀请</button></div><p class="micro">邀请包含连接密钥，只发给自己的设备。更换邀请会使旧邀请失效。重新打开程序后需再次启用远程共享。</p></form><div class="remote-form"><h3>访问另一台设备</h3><label for="remote-invite">连接邀请</label><textarea id="remote-invite" rows="4" maxlength="8192" placeholder="粘贴文件池设备提供的 relaydrop-remote://… 邀请" spellcheck="false" autocomplete="off"></textarea><button id="remote-join" class="button primary small-button" type="button">验证并打开文件池</button><p class="micro">首次连接需核对完整设备指纹，再输入文件池设备显示的配对码。连接会在独立窗口打开。</p><div id="remote-profiles" class="remote-profiles"></div></div></div><p id="remote-feedback" class="micro" role="status"></p>';
    $('desktop-settings-card').before(card);let remoteState=null,remoteBusy=false;
    function renderRemote(value){if(!value||!Array.isArray(value.profiles))return;remoteState=value;const labels={unconfigured:'未配置',stopped:'已停止',connecting:'正在连接',connected:'中继已连接',online:'中继已连接',reconnecting:'等待重连',retrying:'等待重连',error:'连接异常',closed:'已停止'};$('remote-status').textContent=labels[value.state]||'等待连接';$('remote-feedback').textContent=value.error||'';
      if(document.activeElement!==$('remote-relay'))$('remote-relay').value=value.relay||'';if(document.activeElement!==$('remote-relay-pin'))$('remote-relay-pin').value=value.relayFingerprint||'';$('remote-service-key').placeholder=value.credentialSaved?'已安全保存；留空保留原密钥':'由中继管理员提供';
      $('remote-start').disabled=remoteBusy||!value.configured||value.enabled;$('remote-stop').disabled=remoteBusy||!value.enabled;$('remote-copy-invite').disabled=remoteBusy||value.state!=='online';$('remote-rotate').disabled=remoteBusy||!value.configured;
      $('remote-profiles').replaceChildren();for(const p of value.profiles){const row=document.createElement('div');row.className='remote-profile';const title=document.createElement('p');title.textContent='设备 '+String(p.id).slice(-8)+(p.connected?' · 已打开':'');row.appendChild(title);const address=document.createElement('small');address.textContent=p.relay;row.appendChild(address);const buttons=document.createElement('div');buttons.className='remote-actions';for(const [action,label]of [[p.connected?'disconnect':'reopen',p.connected?'断开':'打开'],['forget','移除信任']]){const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent=label;button.disabled=remoteBusy;button.addEventListener('click',async()=>{if(action==='forget'&&!await confirm('移除这台远程设备？','会断开连接并清除这台电脑保存的邀请和配对凭据，文件池内容不受影响。','移除信任'))return;await remoteCall({action,id:p.id});});buttons.appendChild(button);}row.appendChild(buttons);$('remote-profiles').appendChild(row);}}
    async function remoteCall(request){if(remoteBusy)return;remoteBusy=true;card.querySelectorAll('button').forEach(b=>b.disabled=true);$('remote-feedback').textContent='正在处理…';try{const result=await desktop.remoteAction(request);if(request.action==='copy-invite')toast('邀请已复制，只发给自己的设备');if(request.action==='join')$('remote-invite').value='';if(request.action==='configure')$('remote-service-key').value='';remoteBusy=false;renderRemote(await desktop.remoteAction({action:'state'}));return result;}catch(error){remoteBusy=false;if(remoteState)renderRemote(remoteState);$('remote-feedback').textContent=error.message||'远程操作未完成，请重试。';}finally{remoteBusy=false;card.querySelectorAll('button').forEach(b=>b.disabled=false);if(remoteState){$('remote-start').disabled=!remoteState.configured||remoteState.enabled;$('remote-stop').disabled=!remoteState.enabled;$('remote-copy-invite').disabled=remoteState.state!=='online';$('remote-rotate').disabled=!remoteState.configured;}}}
    $('remote-host-form').addEventListener('submit',event=>{event.preventDefault();void remoteCall({action:'configure',config:{relay:$('remote-relay').value.trim(),serviceKey:$('remote-service-key').value.trim(),relayFingerprint:$('remote-relay-pin').value.trim().toLowerCase()}});});
    $('remote-start').addEventListener('click',()=>remoteCall({action:'start'}));$('remote-stop').addEventListener('click',()=>remoteCall({action:'stop'}));$('remote-copy-invite').addEventListener('click',()=>remoteCall({action:'copy-invite'}));$('remote-rotate').addEventListener('click',async()=>{if(await confirm('更换连接邀请？','旧邀请将失效，当前远程连接会断开；文件池文件和局域网配对保留。','更换邀请'))await remoteCall({action:'rotate'});});$('remote-join').addEventListener('click',()=>remoteCall({action:'join',invite:$('remote-invite').value.trim()}));
    desktop.onRemoteChanged?.(renderRemote);desktop.remoteAction({action:'state'}).then(renderRemote).catch(error=>{$('remote-feedback').textContent=error.message||'无法读取远程设置。';});
  }
  $('pair-transport-note').textContent=location.protocol==='https:'?'此连接使用 HTTPS。首次连接时，请核对中转站设备显示的完整证书指纹，再确认信任。':'当前页面使用 HTTP，连接未加密。请在可信网络使用；若中转站提供 HTTPS 地址，请通过该地址重新加入。';
  if(androidBackground){const link=document.createElement('a');link.id='android-background-send';link.className='button secondary wide';link.textContent='后台发送文件';link.href='relaydrop://choose-files?target=';link.addEventListener('click',()=>{const target=$('file-target').value||'';link.href='relaydrop://choose-files?target='+encodeURIComponent(target)+'&folderId='+encodeURIComponent(target?'':$('upload-folder').value||'');});document.querySelector('.send-card').appendChild(link);}
  $('pair-code').addEventListener('input',()=>{$('pair-code').value=$('pair-code').value.replace(/\D/g,'').slice(0,6);});
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>goTab(b.dataset.tab)));
  $('identity-button').addEventListener('click',()=>goTab('devices'));
  $('show-pairing').addEventListener('click',()=>goTab('devices'));
  $('manage-devices').addEventListener('click',()=>goTab('devices'));
  $('file-input').addEventListener('change',e=>{addFiles([...e.target.files]);e.target.value='';});
  const dropzone=$('dropzone');dropzone.addEventListener('click',()=>$('file-input').click());dropzone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('file-input').click();}});
  ['dragenter','dragover'].forEach(event=>dropzone.addEventListener(event,e=>{e.preventDefault();dropzone.classList.add('dragging');}));['dragleave','drop'].forEach(event=>dropzone.addEventListener(event,e=>{e.preventDefault();dropzone.classList.remove('dragging');}));dropzone.addEventListener('drop',e=>{addFiles([...e.dataTransfer.files]);});
  window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
  $('file-search').addEventListener('input',e=>{fileQuery=e.target.value.slice(0,200);renderFiles();});
  $('file-sort').addEventListener('change',e=>{fileSort=e.target.value;renderFiles();});
  $('file-collection').addEventListener('change',e=>{fileCollection=e.target.value;renderFiles();});
  $('new-collection').addEventListener('click',()=>openCollection());
  $('delete-collection').addEventListener('click',deleteCollection);
  $('collection-form').addEventListener('submit',async event=>{event.preventDefault();const lockedFile=collectionFile?.id;let acquired=false;const button=$('collection-submit');if(button.disabled)return;button.disabled=true;$('collection-error').hidden=true;try{if(collectionFile&&pendingFileChanges.has(collectionFile.id))throw new Error('正在整理此文件，请稍后重试。');if(collectionFile){pendingFileChanges.add(lockedFile);acquired=true;await api('/api/files/'+encodeURIComponent(lockedFile),{method:'PATCH',body:{collection:$('collection-picker').value||null}});}else{const name=$('collection-name').value.trim();if(!name)throw new Error('请输入文件夹名称');if(name.length>64)throw new Error('文件夹名称最多 64 个字符');await api('/api/collections',{method:'POST',body:{name}});fileCollection=name;}await refresh(true);$('collection-dialog').close();toast(collectionFile?'文件夹已更新':'文件夹已创建');}catch(error){$('collection-error').textContent=error.message;$('collection-error').hidden=false;}finally{if(acquired)pendingFileChanges.delete(lockedFile);button.disabled=false;}});
  $('copy-fingerprint').addEventListener('click',()=>{if(state?.security?.certificateFingerprint)copyText(state.security.certificateFingerprint);});
  $('select-all-files').addEventListener('change',e=>{document.querySelectorAll('[data-select-file]').forEach(input=>{if(e.target.checked)selectedFiles.add(input.dataset.selectFile);else selectedFiles.delete(input.dataset.selectFile);input.checked=e.target.checked;input.closest('.file-row').classList.toggle('selected',input.checked);});updateSelection();});
  $('file-list').addEventListener('change',e=>{const id=e.target.dataset.selectFile;if(!id)return;if(e.target.checked)selectedFiles.add(id);else selectedFiles.delete(id);e.target.closest('.file-row').classList.toggle('selected',e.target.checked);updateSelection();});
  $('download-selected').addEventListener('click',downloadSelected);
  $('clear-file-selection').addEventListener('click',()=>{selectedFiles.clear();document.querySelectorAll('[data-select-file]').forEach(input=>{input.checked=false;input.closest('.file-row')?.classList.remove('selected');});updateSelection();});
  $('pool-add-files').addEventListener('click',addFilesToCurrentFolder);
  $('open-pool-from-queue').addEventListener('click',()=>goTab('pool'));
  $('pool-save-tasks').hidden=!desktop&&!androidBackground;
  $('pool-save-tasks').addEventListener('click',()=>{if(androidBackground)location.href='relaydrop://saved-files';else{goTab('transfer');if(!$('desktop-download-card').hidden)$('desktop-download-card').scrollIntoView({block:'center',behavior:'smooth'});}});
  if(androidBackground){$('download-selected').textContent='批量保存并校验';const saved=document.createElement('button');saved.id='android-saved-files';saved.className='button secondary';saved.textContent='后台保存 / 最近保存';saved.addEventListener('click',()=>location.href='relaydrop://saved-files');document.querySelector('#page-transfer .page-heading').appendChild(saved);}
  $('refresh-files').addEventListener('click',async()=>{const b=$('refresh-files');b.classList.add('spinning');pool?.retry();await refresh(true);await refreshLocalCopies(true);b.classList.remove('spinning');});
  $('clear-completed').addEventListener('click',()=>{tasks=tasks.filter(t=>!['done','cancelled'].includes(t.state));renderQueue();});
  $('network-address').addEventListener('change',()=>{selectedAddress=$('network-address').value;renderPairing();});
  $('copy-address').addEventListener('click',()=>{if(selectedAddress)copyText(selectedAddress);});
  $('rotate-code').addEventListener('click',async()=>{const b=$('rotate-code');b.disabled=true;try{await api('/api/pairing/rotate',{method:'POST',body:{}});await refresh(true);toast('配对码已更新');}catch(error){toast(error.message,'error');}finally{b.disabled=false;}});
  $('note-text').addEventListener('input',()=>{$('note-length').textContent=`${$('note-text').value.length.toLocaleString()} / 20,000`;});
  $('note-form').addEventListener('submit',async e=>{e.preventDefault();const original=$('note-text').value;if(!original.trim()){toast('先输入要发送的文字','info');return;}const b=$('send-note');b.disabled=true;try{await api('/api/notes',{method:'POST',body:{text:original,targetId:$('note-target').value||null}});if($('note-text').value===original){$('note-text').value='';$('note-length').textContent='0 / 20,000';}await refresh(true);toast('文字已送达中转站');}catch(error){toast(error.message,'error');}finally{b.disabled=false;}});
  $('leave-device').addEventListener('click',async()=>{if(await confirm('断开此设备？','浏览器中保存的连接凭证将被清除，重新加入需要配对码。','断开'))logout();});
  $('confirm-dialog').addEventListener('close',()=>{confirmResolve?.($('confirm-dialog').returnValue==='confirm');confirmResolve=null;});
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
  $('select-text').addEventListener('click',()=>{$('text-dialog-value').focus();$('text-dialog-value').select();$('text-dialog-value').setSelectionRange(0,$('text-dialog-value').value.length);});
  $('choose-verify-file').addEventListener('click',()=>{setLocalVerification('choosing','请选择下载后保存的本地文件；文件只在本设备读取，不会上传。');$('verify-file-input').value='';$('verify-file-input').click();});
  $('verify-file-input').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';if(file)verifySavedFile(file);else setLocalVerification('cancelled','未选择文件，本次未进行校验。');});
  $('verify-file-input').addEventListener('cancel',()=>setLocalVerification('cancelled','已取消选择，本次未进行校验。'));
  $('cancel-file-verify').addEventListener('click',()=>{if(detailNativeRequest&&!nativeSaveFinished(nativeSaves.get(detailNativeRequest)||{status:'failed'}))cancelNativeSave(detailNativeRequest);else cancelLocalVerification();});
  $('save-and-verify').addEventListener('click',saveAndVerifyFile);
  $('file-dialog').addEventListener('close',()=>{cancelLocalVerification();detailNativeRequest=null;detailFile=null;$('verify-file-input').value='';});
  $('copy-file-hash').addEventListener('click',()=>{if(detailFile?.sha256)copyText(detailFile.sha256);});
  $('open-help').addEventListener('click',()=>$('help-dialog').showModal());
  document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;const d=button.dataset;
    if(d.poolView){poolView=d.poolView;selectedFiles.clear();renderFiles();}
    if(d.favoriteFile)toggleFavorite(d.favoriteFile);if(d.collectionFile)openCollection(d.collectionFile);if(d.restoreFile)restoreFile(d.restoreFile);if(d.permanentFile)permanentlyDelete(d.permanentFile);
    if(d.revealSave&&desktop?.revealSavedFile)desktop.revealSavedFile(d.revealSave).catch(error=>toast(error.message||'无法打开保存位置','error'));
    if(d.cancelIncoming&&desktop?.cancelIncomingFiles){button.disabled=true;desktop.cancelIncomingFiles(d.cancelIncoming).catch(error=>{button.disabled=false;toast(error.message||'暂时无法取消','error');});}
  });
  document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='resume-select')$('file-input').click();if(b.dataset.taskAction)taskAction(b.dataset.task,b.dataset.taskAction);if(b.dataset.previewFile)pool?.open(b.dataset.previewFile);if(b.dataset.fileCategory){fileCategory=b.dataset.fileCategory;renderFiles();}if(b.dataset.cancelSave)cancelNativeSave(b.dataset.cancelSave);if(b.dataset.download)downloadFile(b.dataset.download);if(b.dataset.deleteFile)deleteFile(b.dataset.deleteFile);if(b.dataset.deleteNote)deleteNote(b.dataset.deleteNote);if(b.dataset.revoke)revokeDevice(b.dataset.revoke);if(b.dataset.bt)launchBluetooth(b.dataset.bt,b);if(b.dataset.copyNote){const n=state?.notes?.find(n=>n.id===b.dataset.copyNote);if(n)copyText(n.text);}if(b.dataset.fileInfo){const f=state?.files?.find(f=>f.id===b.dataset.fileInfo);if(f)showFileDetails(f);}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh(true);void refreshLocalCopies(true);pump();}});
  window.addEventListener('online',()=>{refresh(true);tasks.forEach(t=>{if(t.state==='retrying')t.state='queued';});pump();});
  window.addEventListener('beforeunload',e=>{if(desktop){reportDesktopActivity();return;}if(batchRunning||localVerification||tasks.some(t=>!['done','cancelled'].includes(t.state))){e.preventDefault();e.returnValue='';}});
  setInterval(()=>{if(!document.hidden)refresh();},3000);
  setInterval(renderExpiry,30000);
  window.RelayConvenience?.create({desktop,android:androidBackground,toast,size,confirm,api,refresh:()=>refresh(true),
    read:()=>({state,context:state?poolContextKey():'',folderId:currentFolder,poolView,activeTab,connected,tasks:tasks.map(t=>({...t,context:t.context||poolContextKey()})),saves:[...nativeSaves.values()],incoming:[...nativeIncoming.values()],folderTasks:nativeBatch?.folder&&(!nativeSaveFinished(nativeBatch)||nativeBatch.total===0)?[{...nativeBatch,id:nativeBatch.requestId,kind:'save',name:nativeBatch.name,totalBytes:nativeBatch.total,doneBytes:nativeBatch.completed}]:[]}),
    locate:id=>{const file=state?.files?.find(f=>f.id===id);if(file)navigateFolder(file.folderId||null,file.id);else toast('文件已不在当前可见范围，请刷新文件池。','info');},
    openTasks:kind=>{if(androidBackground)location.href=kind==='save'?'relaydrop://saved-files':'relaydrop://upload-tasks';else goTab('transfer');},
    taskAction:async(task,action)=>{if(task.source==='browser')return taskAction(task.id,action);if(task.source==='incoming')return desktop?.cancelIncomingFiles(task.id);if(task.source==='folder')return desktop?.cancelSave(task.id);if(task.source==='save'){if(action==='cancel')return cancelNativeSave(task.id);if(action==='resume')return startNativeSave(task.fileId);}},
    saveFolder:async(folderId,files)=>{if(downloadingBatch)throw new Error('请等待当前保存完成，或先取消当前任务。');const requestId=crypto.randomUUID();nativeBatch={requestId,context:poolContextKey(),folder:true,name:folderId?state.folders.find(f=>f.id===folderId)?.name:'共享文件池',status:'queued',total:files.length,completed:0,failed:0,cancelled:0,files:files.map(f=>({...f}))};downloadingBatch=true;desktopBatchStopped=false;desktopBatchRequest=requestId;renderNativeSaves();try{const result=await desktop.saveFolder({folderId,requestId});acceptBatchProgress({...result,requestId});if(!nativeSaveFinished(nativeBatch))throw new Error('未收到完整的目录保存结果');if(nativeBatch.status==='failed')throw new Error(nativeBatch.error||'目录部分未完成，请查看任务后重试。');}catch(error){nativeBatch.status='failed';nativeBatch.error=error.message;throw error;}finally{downloadingBatch=false;desktopBatchRequest=null;renderNativeSaves();}}
  });
  goTab(activeTab);if(token)refresh(true);else showPair();
})();
