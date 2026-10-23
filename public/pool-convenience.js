/* Local file access and task feedback. No file paths or credentials are persisted. */
'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RelayConvenience=api;})(typeof window==='object'?window:globalThis,function(){
  const finished=new Set(['completed','done','cancelled','failed','blocked','needs_source']);
  const statuses={queued:'等待处理',choosing:'选择保存位置',confirming:'等待确认',preparing:'校验原文件',hashing:'校验原文件',importing:'缓存原文件',staged:'等待发送',organizing:'建立目录',sending:'正在发送',uploading:'正在发送',saving:'正在保存',verifying:'核对完整性',running:'正在处理',waiting:'等待重连',retrying:'等待重试',paused:'已暂停',duplicate:'发现重复文件',completed:'已完成并校验',done:'已完成并校验',cancelled:'已取消',failed:'未完成',blocked:'身份已变化，请重新确认',needs_source:'请重新选择原文件'};
  const safeText=value=>typeof value==='string'?value.slice(0,500):'';
  function normalize(source,items,context){
    return (Array.isArray(items)?items:[]).slice(-100).filter(t=>t&&(!t.context||t.context===context)).map(t=>{
      const rawStatus=safeText(t.status||t.state)||'queued',status=rawStatus==='error'?'failed':rawStatus,id=String(t.requestId||t.localId||t.id||'');
      let total=Number(t.totalBytes??t.total??t.size)||0,done=Number(t.doneBytes??t.transferred??t.offset)||0;
      if(source==='incoming'){total=Number(t.total)||0;done=(Number(t.completed)||0)+(Number(t.skipped)||0);}
      total=Number.isFinite(total)?Math.max(0,total):0;done=Number.isFinite(done)?Math.min(total,Math.max(0,done)):0;
      return {key:source+':'+id,id,source,status,name:safeText(t.name||t.file?.name)||'文件任务',error:safeText(t.error),kind:t.kind==='save'||source==='save'?'save':'upload',done,total,percent:total?Math.floor(done/total*100):0,finished:finished.has(status),fileId:safeText(t.fileId||t.result?.id),folderId:t.folderId||null};
    }).filter(t=>t.id);
  }
  function summary(items){return {active:items.filter(t=>!t.finished&&t.status!=='paused').length,paused:items.filter(t=>t.status==='paused').length,failed:items.filter(t=>['failed','blocked','needs_source'].includes(t.status)).length,completed:items.filter(t=>['done','completed'].includes(t.status)).length};}
  function folderSnapshot(state,folderId){
    if(!state||!Array.isArray(state.folders)||!Array.isArray(state.files))throw new Error('文件池尚未连接。');
    if(folderId&&!state.folders.some(f=>f.id===folderId))throw new Error('当前目录已不可用，请刷新后重试。');
    const ids=new Set([folderId||null]);let changed=true;
    while(changed){changed=false;for(const f of state.folders){if(ids.has(f.parentId||null)&&!ids.has(f.id)){ids.add(f.id);changed=true;}}}
    const files=state.files.filter(f=>!f.targetId&&ids.has(f.folderId||null));
    return {name:folderId?state.folders.find(f=>f.id===folderId).name:'共享文件池',files,folders:state.folders.filter(f=>ids.has(f.id)),totalBytes:files.reduce((n,f)=>n+(Number(f.size)||0),0)};
  }
  function create(options){
    const $=id=>document.getElementById(id),desktop=options.desktop,android=options.android,rows=new Map();
    let remoteTasks=[],taskContext='',loading=false,lastNative=0,expanded=false,busyFolder=false,dismissed=new Set(),dialogOrder=[];
    const element=(tag,attrs={},text)=>{const node=document.createElement(tag);for(const [key,value]of Object.entries(attrs)){if(key==='class')node.className=value;else node.setAttribute(key,value);}if(text!==undefined)node.textContent=text;return node;};
    const localAvailable=!!desktop?.openLocalLibrary&&!desktop.isRemote||android;
    const localOpen=()=>{if(android)location.href='relaydrop://local-files';else Promise.resolve(desktop.openLocalLibrary()).catch(error=>options.toast(error.message,'error'));};
    if(localAvailable){
      const nav=element('button',{class:'nav-item',id:'local-files-entry','aria-label':'本机文件'});nav.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 4h16v12H4zM8 20h8M12 16v4M8 8h8M8 11h5"/></svg><span>本机文件</span>';nav.addEventListener('click',localOpen);const navigation=document.querySelector('.navigation');navigation.classList.add('native-local-navigation');navigation.appendChild(nav);
      const pair=element('button',{class:'button secondary wide',id:'offline-local-files'},'打开本机文件 · 无需连接');pair.addEventListener('click',localOpen);document.querySelector('.pair-form-wrap').appendChild(pair);
      const offline=element('button',{class:'text-button',id:'offline-local-shortcut'},'打开已保存文件');offline.addEventListener('click',localOpen);$('offline-banner').appendChild(offline);
    }
    const folderButton=element('button',{id:'pool-save-folder',class:'text-button',type:'button'},'保存此目录');
    folderButton.hidden=!desktop?.saveFolder&&!android;
    document.querySelector('.pool-navigation').appendChild(folderButton);
    folderButton.addEventListener('click',async()=>{
      if(busyFolder)return;const current=options.read(),context=current.context,folderId=current.folderId;
      try{
        const snapshot=folderSnapshot(current.state,folderId);
        if(snapshot.files.length>300||snapshot.folders.length>2000)throw new Error('一次最多保存 300 个文件和 2000 个目录，请进入子目录分批保存。');
        if(!await options.confirm('保存「'+snapshot.name+'」及子目录','包含 '+snapshot.files.length+' 个文件、'+snapshot.folders.length+' 个目录，共 '+options.size(snapshot.totalBytes)+'。保留目录层级和空目录；搜索与筛选不会缩小保存范围。已有本机文件不会覆盖。','选择保存位置','primary'))return;
        const fresh=options.read();if(fresh.context!==context||fresh.folderId!==folderId)throw new Error('当前连接或目录已变化，请重新确认。');
        if(android){location.href='relaydrop://save-folder?folderId='+encodeURIComponent(folderId||'');return;}
        busyFolder=true;folderButton.disabled=true;await options.saveFolder(folderId,snapshot.files);options.toast('目录保存任务已结束，请查看完成和失败数量。','info');
      }catch(error){options.toast(error.message||'目录未能保存','error');}finally{busyFolder=false;folderButton.disabled=false;}
    });
    const taskEntry=element('button',{id:'pool-task-entry',class:'text-button',type:'button','aria-haspopup':'dialog','aria-controls':'pool-task-dialog'}),badge=element('span',{id:'pool-task-count'},'0');taskEntry.append(document.createTextNode('任务 '),badge);document.querySelector('.pool-navigation').appendChild(taskEntry);
    const taskDialog=element('dialog',{id:'pool-task-dialog','aria-label':'当前文件池任务'}),panel=element('section',{id:'pool-task-panel',class:'pool-task-panel','aria-label':'当前文件池任务'});
    const heading=element('div',{class:'pool-task-heading'}),title=element('strong',{id:'pool-task-summary','role':'status'}),toggle=element('button',{id:'pool-task-toggle',class:'text-button','aria-expanded':'false'},'展开'),clear=element('button',{id:'pool-task-clear',class:'text-button'},'收起已完成');
    heading.append(title,toggle,clear);const list=element('div',{id:'pool-task-list',class:'pool-task-list'}),close=element('button',{id:'pool-task-close',class:'button secondary',type:'button'},'返回文件池'),footer=element('div',{class:'dialog-actions'});footer.append(close);panel.append(heading,list);taskDialog.append(panel,footer);document.body.appendChild(taskDialog);
    taskEntry.addEventListener('click',()=>{dialogOrder=[];expanded=false;update();taskDialog.showModal();});close.addEventListener('click',()=>taskDialog.close());
    toggle.addEventListener('click',()=>{expanded=!expanded;update();});
    clear.addEventListener('click',()=>{for(const task of currentTasks())if(['done','completed','cancelled'].includes(task.status))dismissed.add(task.key);update();if(!currentTasks().length)taskDialog.close();});
    list.addEventListener('click',async event=>{
      const button=event.target.closest('[data-pool-task-action]');if(!button)return;
      const task=currentTasks().find(t=>t.key===button.dataset.taskKey),action=button.dataset.poolTaskAction;if(!task)return;
      button.disabled=true;
      try{
        if(action==='locate'){taskDialog.close();options.locate(task.fileId);return;}
        if(action==='details'){taskDialog.close();options.openTasks(task.kind);return;}
        if(task.source==='android'){await window.relayNativeTasks.action({context:taskContext,id:task.id,kind:task.kind,action});lastNative=0;await pollNative();}
        else await options.taskAction(task,action);
      }catch(error){options.toast(error.message||'任务操作未完成','error');}finally{button.disabled=false;update();}
    });
    function currentTasks(){
      const data=options.read();if(!data.state||!data.context)return [];
      return [...normalize('browser',data.tasks,data.context),...normalize('save',data.saves,data.context),...normalize('incoming',data.incoming,data.context),...normalize('folder',data.folderTasks,data.context),...normalize('android',remoteTasks,data.context)].filter(t=>!dismissed.has(t.key));
    }
    function actions(task){
      const result=[];
      if(task.fileId&&['done','completed'].includes(task.status)&&options.read().state?.files.some(f=>f.id===task.fileId))result.push(['locate','在池中查看']);
      if(task.source==='browser'){
        if(['paused','failed'].includes(task.status))result.push(['resume','继续 / 重试']);
        else if(!task.finished&&!['duplicate'].includes(task.status))result.push(['pause','暂停']);
        if(!task.finished)result.push(['cancel','取消']);
        if(task.status==='duplicate')result.push(['details','处理重复项']);
      }else if(task.source==='android'&&window.relayNativeTasks?.action){
        if(['paused','failed','waiting'].includes(task.status))result.push(['resume','继续 / 重试']);
        else if(!task.finished)result.push(['pause','暂停']);
        if(!task.finished||task.status==='failed')result.push(['cancel','取消']);
      }else if(task.source==='save'){
        if(task.status==='failed'&&task.fileId)result.push(['resume','重试']);
        else if(!task.finished)result.push(['cancel','取消']);
      }else if(['incoming','folder'].includes(task.source)&&!task.finished)result.push(['cancel','取消']);
      if(task.error||!result.length&&!['done','completed','cancelled'].includes(task.status))result.push(['details','查看任务']);
      return result;
    }
    function update(){
      const data=options.read();if(taskContext!==data.context){taskContext=data.context;remoteTasks=[];dismissed.clear();rows.clear();list.replaceChildren();lastNative=0;dialogOrder=[];if(taskDialog.open)taskDialog.close();}
      folderButton.disabled=busyFolder||!data.connected||!data.state||data.poolView==='trash';
      taskEntry.disabled=!data.state;if(!data.state&&taskDialog.open)taskDialog.close();
      const all=currentTasks(),count=summary(all);
      const headingText=[count.active?count.active+' 项进行中':'',count.paused?count.paused+' 项暂停':'',count.failed?count.failed+' 项未完成':'',count.completed?count.completed+' 项已完成':''].filter(Boolean).join(' · ')||(all.length?'任务已取消':'暂无任务');
      badge.textContent=all.length>99?'99+':String(all.length);taskEntry.title=headingText;taskEntry.setAttribute('aria-label','文件池任务：'+headingText);taskEntry.dataset.active=String(count.active>0);taskEntry.dataset.failed=String(count.failed>0);
      if(title.textContent!==headingText)title.textContent=headingText;
      toggle.textContent=expanded?'收起':'展开';toggle.setAttribute('aria-expanded',String(expanded));toggle.hidden=all.length<=2;clear.hidden=!all.some(t=>['done','completed','cancelled'].includes(t.status));
      let ordered=all.map((t,i)=>({...t,order:i})).sort((a,b)=>Number(a.finished)-Number(b.finished)||Number(!a.error)-Number(!b.error)||b.order-a.order);
      if(taskDialog.open){for(const task of ordered)if(!dialogOrder.includes(task.key))dialogOrder.push(task.key);ordered.sort((a,b)=>dialogOrder.indexOf(a.key)-dialogOrder.indexOf(b.key));}else dialogOrder=ordered.map(t=>t.key);
      const visible=ordered.slice(0,expanded?30:2),keys=new Set(visible.map(t=>t.key));
      for(const[key,row]of rows)if(!keys.has(key)){row.remove();rows.delete(key);}
      for(const [index,task] of visible.entries()){
        let row=rows.get(task.key);
        if(!row){row=element('div',{class:'pool-task-row','data-pool-task-key':task.key});row.append(element('div',{class:'pool-task-name'}),element('span',{class:'pool-task-status'}),element('progress',{max:'100','aria-label':'任务进度'}),element('div',{class:'pool-task-actions'}));rows.set(task.key,row);list.appendChild(row);}
        if(list.children[index]!==row)list.insertBefore(row,list.children[index]||null);
        const name=row.querySelector('.pool-task-name');name.textContent=(task.kind==='save'?'保存 · ':'发送 · ')+task.name;name.title=task.name;
        row.dataset.status=task.status;const message=row.querySelector('.pool-task-status');message.textContent=(statuses[task.status]||'正在处理')+(task.error?' · '+task.error:task.total?' · '+task.percent+'%':'');message.title=message.textContent;
        const meter=row.querySelector('progress');meter.hidden=task.finished||task.status==='paused';if(task.total&&['sending','saving','uploading','running'].includes(task.status))meter.value=task.percent;else meter.removeAttribute('value');
        const actionBox=row.querySelector('.pool-task-actions'),available=actions(task),signature=JSON.stringify(available);
        if(actionBox.dataset.signature!==signature){actionBox.dataset.signature=signature;actionBox.replaceChildren(...available.map(([action,label])=>element('button',{class:'text-button','data-pool-task-action':action,'data-task-key':task.key},label)));}
      }
      renderPrivacy(data);
    }
    async function pollNative(){
      if(loading||!android||!window.relayNativeTasks?.list||document.hidden)return;
      const data=options.read();if(!data.state||data.activeTab!=='pool'||!data.connected||Date.now()-lastNative<2000)return;
      const context=data.context;loading=true;lastNative=Date.now();
      try{const result=await window.relayNativeTasks.list({context});if(options.read().context!==context)return;if(result?.context!==context||!Array.isArray(result.tasks))throw new Error('队列身份不一致');remoteTasks=result.tasks.map(t=>({...t,context}));update();}
      catch{if(options.read().context===context){remoteTasks=[];update();}}
      finally{loading=false;}
    }
    const privacy=element('section',{id:'privacy-card',class:'card privacy-card'});
    privacy.append(element('h2',{},'隐私与共享'),element('p',{class:'micro'},'定向文件由发送者、接收者和文件池主机查看。私人分类只整理列表，不改变访问权限。原件保存在本机；备份可选择密码加密。'));
    const privacyActions=element('div',{class:'storage-actions'}),lock=element('button',{id:'lock-interface',class:'button secondary small-button'},'锁定界面'),configure=element('button',{id:'configure-lock',class:'button secondary small-button'},'设置界面锁'),sharing=element('button',{id:'toggle-sharing',class:'button secondary small-button'},'暂停共享'),reset=element('button',{id:'reset-pairing-limits',class:'text-button'},'解除配对限制');
    privacyActions.append(lock,configure,sharing,reset);privacy.append(privacyActions,element('p',{id:'privacy-sharing-status',class:'micro',role:'status'}));$('page-devices').appendChild(privacy);
    const protect=async action=>{try{if(android){location.href='relaydrop://lock-app';return;}await desktop.lockAction({action});}catch(error){options.toast(error.message||'界面锁操作未完成','error');}};
    lock.addEventListener('click',()=>protect('lock'));configure.addEventListener('click',()=>protect('configure'));
    sharing.addEventListener('click',async()=>{
      const data=options.read(),paused=!!data.state?.sharing?.paused;
      if(!await options.confirm(paused?'恢复共享？':'暂停其他设备访问？',paused?'恢复后，已配对设备可以重新访问文件池。':'会中断其他设备正在接收的内容。原文件、本机管理和本机副本保留；已经保存到其他设备的副本无法收回。',paused?'恢复共享':'暂停共享',paused?'primary':'danger'))return;
      try{if(android){location.href='relaydrop://'+(paused?'resume-sharing':'pause-sharing');return;}if(desktop?.sharingAction)await desktop.sharingAction({action:paused?'resume':'pause'});else await options.api('/api/sharing',{method:'POST',body:{paused:!paused}});await options.refresh();update();}catch(error){options.toast(error.message||'共享状态未改变','error');}
    });
    reset.addEventListener('click',async()=>{if(!await options.confirm('解除配对限制并更换配对码？','只影响新设备加入；已配对设备继续保持连接。','解除并换码','primary'))return;try{await options.api('/api/pairing/reset-limits',{method:'POST',body:{}});await options.refresh();options.toast('限制已解除，请使用新的配对码');}catch(error){options.toast(error.message,'error');}});
    function renderPrivacy(data){
      const host=data.state?.device?.role==='host';privacy.hidden=!data.state;lock.hidden=!desktop?.lockAction&&!android;configure.hidden=!desktop?.lockAction;sharing.hidden=!host;reset.hidden=!host;sharing.textContent=data.state?.sharing?.paused?'恢复共享':'暂停共享';
      $('privacy-sharing-status').textContent=data.state?.sharing?.paused?'已暂停共享，其他设备暂时无法访问。':'锁定界面后仍可继续共享；暂停共享才会停止其他设备访问。';
    }
    const timer=setInterval(()=>{if(!document.hidden){update();void pollNative();}},750);
    window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
    window.addEventListener('relay-native-tasks-ready',()=>{lastNative=0;void pollNative();});
    update();return {refresh:update};
  }
  return {normalize,summary,folderSnapshot,create};
});
