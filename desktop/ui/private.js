'use strict';
const $=id=>document.getElementById(id);
let initial,offset=0,query='',busy=false,pending=false;
function error(value){$('error').textContent=String(value||'').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'').replace(/^Error: /,'');$('error').hidden=!value;}
async function load(reset=true){
  if(busy){pending=pending||reset;return;}busy=true;$('more').disabled=true;
  const requestedQuery=query;
  try{
    if(reset){offset=0;$('files').replaceChildren();$('count').textContent='正在读取本机保存记录…';}
    const result=await relayNative.action({action:'list',query:requestedQuery,offset,limit:50});
    if(requestedQuery!==query){pending=true;return;}
    $('count').textContent='找到 '+result.total+' 份副本 · 最多显示最近 2000 条保存记录';
    for(const file of result.files){
      const row=document.createElement('article');row.className='file';
      const name=document.createElement('strong');name.textContent=file.name;
      const detail=document.createElement('p');detail.textContent=file.path+' · '+new Date(file.savedAt).toLocaleString()+' · '+({saved:'副本完整',unverified:'打开前校验',missing:'已移动或删除',changed:'内容已变化',unavailable:'暂不可读'}[file.status]||'待检查');row.append(name,detail);
      for(const [action,label]of [['open','打开'],['reveal','打开位置']]){
        const button=document.createElement('button');button.textContent=label;button.disabled=!['saved','unverified'].includes(file.status);button.dataset.action=action;button.dataset.receipt=file.receiptId;
        button.onclick=async()=>{button.disabled=true;button.textContent='正在校验…';error('');try{await relayNative.action({action,receiptId:file.receiptId});}catch(e){error(e.message);await load();}finally{if(button.isConnected){button.textContent=label;button.disabled=!['saved','unverified'].includes(file.status);}}};
        row.append(button);
      }
      $('files').append(row);
    }
    offset+=result.files.length;$('more').hidden=!result.more;
  }catch(e){error(e.message);}finally{busy=false;$('more').disabled=false;if(pending){pending=false;void load();}}
}
$('search').addEventListener('input',()=>{query=$('search').value;void load();});$('more').onclick=()=>load(false);
$('form').onsubmit=async event=>{
  event.preventDefault();error('');$('submit').disabled=true;
  try{await relayNative.action({action:initial.kind==='lock'?'unlock':initial.kind==='password'?'password':'configure',password:$('password').value,currentPassword:$('current').value,confirmPassword:$('confirm').value});for(const id of ['password','current','confirm'])$(id).value='';if(initial.kind==='settings')location.reload();}
  catch(e){error(e.message);}finally{$('submit').disabled=false;}
};
$('disable').onclick=async()=>{error('');try{await relayNative.action({action:'disable',currentPassword:$('current').value});location.reload();}catch(e){error(e.message);}};
(async()=>{
  initial=await relayNative.state();$('title').textContent=initial.title||({lock:'界面已锁定',settings:'本机界面锁',password:'备份密码',library:'本机已保存文件'}[initial.kind]);
  if(initial.kind==='library'){$('hint').textContent='这些是你已保存到本机的副本；断网或文件池关闭后仍可使用。每次打开前重新核对完整 SHA-256。';$('library').hidden=false;await load();return;}
  $('form').hidden=false;$('current-label').hidden=initial.kind!=='settings'||!initial.configured;$('confirm-label').hidden=initial.kind==='lock'||initial.kind==='password'&&!initial.confirm;$('disable').hidden=initial.kind!=='settings'||!initial.configured;
  $('password').autocomplete=initial.kind==='lock'?'current-password':'new-password';$('submit').textContent=initial.kind==='lock'?'解锁':initial.kind==='settings'?'保存密码':'确认';
  $('hint').textContent=initial.kind==='lock'?'锁定只隐藏应用界面，设备共享继续运行。要阻止外部连接，请另行暂停共享。':initial.kind==='settings'?'设置后，下次启动需要解锁。界面锁不加密磁盘上的原文件，也不能防止同一 Windows 账号直接读取文件。请妥善记住密码。':'密码仅在本机内存中使用，不写入记录或日志。';
  if(initial.error)error(initial.error);$('password').focus();
})().catch(e=>error(e.message));
