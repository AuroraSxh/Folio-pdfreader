import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { FolioAPI } from '../shared/types';
const invoke=(channel:string,...args:unknown[])=>ipcRenderer.invoke(`folio:${channel}`,...args);
const subscribe=(channel:string,callback:(value:any)=>void)=>{const handler=(_event:Electron.IpcRendererEvent,value:unknown)=>callback(value);ipcRenderer.on(`folio:${channel}`,handler);return()=>ipcRenderer.removeListener(`folio:${channel}`,handler);};
const api:FolioAPI={
  platform:process.platform==='darwin'?'darwin':process.platform==='win32'?'win32':'linux',
  bootstrap:()=>invoke('bootstrap'),createWorkspace:paths=>invoke('create-workspace',paths),importDocuments:(id,paths)=>invoke('import-documents',id,paths),createDemo:()=>invoke('demo'),
  updateWorkspace:(id,patch)=>invoke('update-workspace',id,patch),deleteWorkspace:id=>invoke('delete-workspace',id),
  listRemovedWorkspaces:()=>invoke('list-removed-workspaces'),restoreWorkspace:id=>invoke('restore-workspace',id),purgeWorkspace:id=>invoke('purge-workspace',id),copyText:text=>invoke('copy-text',text),
  updateDocument:(id,doc,patch)=>invoke('update-document',id,doc,patch),removeDocument:(id,doc)=>invoke('remove-document',id,doc),
  undoDocumentEdit:(id,direction)=>invoke('undo-document-edit',id,direction),getDocumentEditHistory:id=>invoke('document-edit-history',id),nativeEdit:action=>invoke('native-edit',action),
  updateView:(id,doc,pane,view)=>invoke('update-view',id,doc,pane,view),
  readDocument:(id,doc)=>invoke('read-document',id,doc),indexDocument:(id,doc,index)=>invoke('index-document',id,doc,index),
  exportPdf:(id,doc)=>invoke('export-pdf',id,doc),printPdf:(id,doc)=>invoke('print-pdf',id,doc),revealWorkspace:id=>invoke('reveal-workspace',id),
  saveSettings:settings=>invoke('save-settings',settings),pickFolder:kind=>invoke('pick-folder',kind),
  getUpdateStatus:()=>invoke('update-status'),checkForUpdates:()=>invoke('check-updates'),
  downloadUpdate:()=>invoke('download-update'),cancelUpdate:()=>invoke('cancel-update'),installUpdate:()=>invoke('install-update'),
  onUpdate:callback=>subscribe('update',callback),
  startChat:request=>invoke('start-chat',request),abortChat:id=>invoke('abort-chat',id),newConversation:id=>invoke('new-conversation',id),deleteMemory:(id,memory)=>invoke('delete-memory',id,memory),
  deleteChatTurn:(id,conversation,message)=>invoke('delete-chat-turn',id,conversation,message),
  voiceCapabilities:locale=>invoke('voice-capabilities',locale),voiceListen:options=>invoke('voice-listen',options),voiceStopListening:sessionId=>invoke('voice-stop-listening',sessionId),
  voiceSpeak:options=>invoke('voice-speak',options),voiceStopSpeaking:()=>invoke('voice-stop-speaking'),onVoice:callback=>subscribe('voice',callback),
  exportMarkdown:(id,target)=>invoke('export-markdown',id,target),backup:()=>invoke('backup'),restore:()=>invoke('restore'),importLegacy:()=>invoke('import-legacy'),
  openExternal:url=>invoke('open-external',url),openObsidian:()=>invoke('open-obsidian'),pathForFile:file=>webUtils.getPathForFile(file),
  onChat:callback=>subscribe('chat',callback),onOpen:callback=>subscribe('open',callback),onCommand:callback=>subscribe('command',callback),
  onPrepareClose:callback=>{const handler=()=>{void Promise.resolve().then(callback).then(()=>ipcRenderer.send('folio:prepared-close',{ok:true})).catch(error=>ipcRenderer.send('folio:prepared-close',{ok:false,error:String(error)}));};ipcRenderer.on('folio:prepare-close',handler);return()=>ipcRenderer.removeListener('folio:prepare-close',handler);}
};
contextBridge.exposeInMainWorld('folio',api);
