'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
exports.launch=async function(action){
  if(process.platform!=='win32')throw Object.assign(new Error('该入口仅适用于 Windows；安卓请使用系统分享菜单中的蓝牙。'),{status:501});
  const system=process.env.SystemRoot||'C:\\Windows';
  let exe,args;
  if(action==='send'||action==='receive'){exe=path.join(system,'System32','fsquirt.exe');args=[action==='send'?'-send':'-receive'];}
  else if(action==='settings'){exe=path.join(system,'explorer.exe');args=['ms-settings:bluetooth'];}
  else throw Object.assign(new Error('未知蓝牙操作'),{status:400});
  await new Promise((resolve,reject)=>{const child=spawn(exe,args,{windowsHide:true,detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
  return {ok:true,message:'已打开系统蓝牙窗口，请在该窗口完成操作。系统蓝牙传输不纳入本应用的局域网队列。'};
};
