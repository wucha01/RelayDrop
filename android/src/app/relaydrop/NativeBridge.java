package app.relaydrop;
/** Main-page scoped capability; no Android JavascriptInterface is exposed. */
final class NativeBridge {
  static String script(String nonce){return String.join("\n",
    "(()=>{const nonce="+org.json.JSONObject.quote(nonce)+";const pending=new Map();",
    "const credential=()=>sessionStorage.getItem('relay-host-token')||localStorage.getItem('relay-guest-token')||'';",
    "async function query(path,request){const response=await fetch(path+'?'+new URLSearchParams(request),{headers:{'X-Relay-Saved-Nonce':nonce,'X-Relay-Saved-Credential':credential()},cache:'no-store',redirect:'error'});const result=await response.json();if(!response.ok||result.error)throw Error(result.error||'原生查询未获授权');return result;}",
    "window.relaySavedCopies={list(request){if(!request||!Array.isArray(request.files)||request.files.length>100)return Promise.reject(Error('副本查询无效'));return query('/__relay_native_saved',{context:request.context,files:JSON.stringify(request.files.map(f=>({id:f.id,sha256:f.sha256})))});}};",
    "window.relayNativeTasks={list(request){return query('/__relay_native_tasks',{context:request&&request.context});},action(request){return new Promise((resolve,reject)=>{if(!request||!['upload','save'].includes(request.kind)||!['pause','resume','cancel'].includes(request.action)){reject(Error('任务操作无效'));return;}const requestId='task_'+crypto.getRandomValues(new Uint32Array(4)).join('_');const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('操作未确认，请从点击按钮重新操作'));},16000);pending.set(requestId,{resolve,reject,timer});location.href='relaydrop://task-control?'+new URLSearchParams({...request,requestId,nonce});});}};",
    "window.addEventListener('relay-native-task-result',event=>{const data=event.detail||{},item=pending.get(data.requestId);if(!item)return;pending.delete(data.requestId);clearTimeout(item.timer);data.ok?item.resolve({ok:true}):item.reject(Error(data.error||'任务操作失败'));});",
    "window.dispatchEvent(new Event('relay-saved-copies-ready'));window.dispatchEvent(new Event('relay-native-tasks-ready'));return true;})()");}
}
