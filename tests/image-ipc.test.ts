import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadBackendModule } from './backend-harness';

test('image preview IPC only reaches workspace-scoped storage from the trusted main frame',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),handlers=new Map<string,(...args:any[])=>Promise<unknown>>(),calls:unknown[][]=[];
  const frame={url:pathToFileURL(path.join(root,'dist/index.html')).href},webContents={mainFrame:frame},window={webContents};
  const electron={app:{setName(){},setPath(){},setAboutPanelOptions(){},getPath:()=>'/isolated-image-ipc',getVersion:()=>'test',requestSingleInstanceLock:()=>true,setAppUserModelId(){},on(){},quit(){},whenReady:()=>new Promise(()=>{})},BrowserWindow:class{constructor(){throw Error('No GUI in IPC tests');}},ipcMain:{on(){},handle:(name:string,handler:(...args:any[])=>Promise<unknown>)=>handlers.set(name,handler)},Menu:{},shell:{},dialog:{},clipboard:{}};
  const main=await loadBackendModule<{testImages:{setState(window:unknown,library:unknown,settings:unknown):void;registerIPC():void}}>('electron/main.ts',{electron,'./settings':{},'./voice':{},'./ai':{},'./obsidian':{},'./pdf-export':{},'./updater':{}},'export const testImages={registerIPC,setState(w:any,l:any,s:any){window=w;library=l;settings=s;}};', {...process,env:{FOLIO_USER_DATA:'/isolated-image-ipc'},argv:['Pairleaf']} as NodeJS.Process);
  main.testImages.setState(window,{readChatImage:async(...args:unknown[])=>{calls.push(args);return 'data:image/png;base64,synthetic';},setDocumentPageCount:async(...args:unknown[])=>{calls.push(args);return 'updated-workspace';}},{getLanguage:()=>'en'});main.testImages.registerIPC();
  const handler=handlers.get('folio:read-chat-image')!;assert.ok(handler);
  for(const event of [{sender:{},senderFrame:frame},{sender:webContents,senderFrame:{...frame}},{sender:webContents,senderFrame:null}])await assert.rejects(handler(event,'workspace','image'),/Unauthorized/);
  assert.equal(calls.length,0);
  const original=frame.url;frame.url='https://untrusted.example';await assert.rejects(handler({sender:webContents,senderFrame:frame},'workspace','image'),/Unauthorized/);frame.url=original;
  assert.equal(await handler({sender:webContents,senderFrame:frame},'workspace','image'),'data:image/png;base64,synthetic');assert.deepEqual(calls,[['workspace','image']]);
  const pages=handlers.get('folio:document-page-count')!;await assert.rejects(pages({sender:{},senderFrame:frame},'workspace','document',3),/Unauthorized/);
  assert.equal(await pages({sender:webContents,senderFrame:frame},'workspace','document',3),'updated-workspace');assert.deepEqual(calls.at(-1),['workspace','document',3]);
});
test('preload image bridge exposes only workspace/id reads, with no arbitrary path or write API',async()=>{
  let exposed:Record<string,any>|undefined;const calls:unknown[][]=[];
  await loadBackendModule('electron/preload.ts',{electron:{contextBridge:{exposeInMainWorld:(name:string,api:Record<string,any>)=>{assert.equal(name,'folio');exposed=api;}},ipcRenderer:{invoke:async(...args:unknown[])=>{calls.push(args);return 'local-image';}},webUtils:{}}});
  assert.equal(await exposed!.readChatImage('workspace','image'),'local-image');assert.deepEqual(calls,[['folio:read-chat-image','workspace','image']]);
  await exposed!.setDocumentPageCount('workspace','document',3);assert.deepEqual(calls.at(-1),['folio:document-page-count','workspace','document',3]);
  assert.equal(exposed!.saveChatImages,undefined);assert.equal(exposed!.readFile,undefined);assert.equal(exposed!.discardChatImages,undefined);
});
