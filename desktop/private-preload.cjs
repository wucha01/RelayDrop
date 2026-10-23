'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('relayNative',{state:()=>ipcRenderer.invoke('relay:private-state'),action:request=>ipcRenderer.invoke('relay:private-action',request)});
