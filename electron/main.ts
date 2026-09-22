import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LibraryStore, atomicWrite, safeFilename } from './store';
import { SettingsStore } from './settings';
import { exportAnnotatedPdf } from './pdf-export';
import { writeDemo } from './demo';
import { createAIService } from './ai';
import { renderMarkdown, exportToObsidian } from './obsidian';
import { isApplicationURL, pdfDialogOptions, pdfPathsFromArguments, sameLocalPath } from './desktop';
import type { ChatRequest, DocumentIndex, PaperDocument, Settings, Workspace, ViewState } from '../shared/types';

app.setName('Folio');
if(process.env.FOLIO_USER_DATA)app.setPath('userData',process.env.FOLIO_USER_DATA);
let window:BrowserWindow|null=null;
let library:LibraryStore;
let settings:SettingsStore;
let ai:ReturnType<typeof createAIService>;
const pendingFiles:string[]=[];
const primaryInstance=process.platform!=='win32'||app.requestSingleInstanceLock();
if(!primaryInstance)app.quit();
if(process.platform==='win32'&&primaryInstance){
  app.setAppUserModelId('com.folio.paperreader');
  pendingFiles.push(...pdfPathsFromArguments(process.argv.slice(1),process.cwd()));
  app.on('second-instance',(_event,argv,cwd)=>{
    pendingFiles.push(...pdfPathsFromArguments(argv.slice(1),cwd));
    if(!initialized)return;
    if(!window)void createWindow();
    else{if(window.isMinimized())window.restore();window.show();window.focus();if(rendererReady)void openPending();}
  });
}
const printWindows=new Set<BrowserWindow>();
const devURL=process.env.VITE_DEV_SERVER_URL;
const appFile=path.join(__dirname,'../dist/index.html');
let initialized=false;
let quitting=false;
let rendererReady=false;
let windowCanClose=false;
let closeResolve:((error?:string)=>void)|undefined;
let flushing:Promise<void>|undefined;
const startupLog=path.join(app.getPath('userData'),'logs','main.log');
async function logEvent(message:string){try{await fs.mkdir(path.dirname(startupLog),{recursive:true});await fs.appendFile(startupLog,`${new Date().toISOString()} ${message}\n`,{mode:0o600});}catch{/* A diagnostic write must not hide the original error. */}}

function flushRenderer():Promise<void>{
  if(!window||window.isDestroyed()||!rendererReady)return Promise.resolve();
  if(flushing)return flushing;
  flushing=new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{closeResolve=undefined;reject(new Error('窗口尚未响应保存请求，请稍后再试。'));},10000);
    closeResolve=error=>{clearTimeout(timer);closeResolve=undefined;if(error)reject(new Error(error));else resolve();};
    emit('prepare-close',null);
  }).finally(()=>{flushing=undefined;});
  return flushing;
}

function emit(channel:string,value:unknown){if(window&&!window.isDestroyed())window.webContents.send(`folio:${channel}`,value);}
function trusted(event:Electron.IpcMainInvokeEvent|Electron.IpcMainEvent){
  if(event.sender!==window?.webContents || event.senderFrame!==event.sender.mainFrame)throw new Error('拒绝未授权窗口请求');
  const url=event.senderFrame?.url??'';
  if(!isApplicationURL(url,appFile,devURL))throw new Error('拒绝未授权来源');
}
function handle(channel:string,fn:(...args:any[])=>unknown){ipcMain.handle(`folio:${channel}`,async(event,...args)=>{trusted(event);return fn(...args);});}
async function choosePdfs(mode:'files'|'folder'|'mixed'='mixed'){const result=await dialog.showOpenDialog(window!,pdfDialogOptions(mode));return result.canceled?null:result.filePaths;}
async function saveFile(title:string,defaultPath:string,extension:string){const result=await dialog.showSaveDialog(window!,{title,defaultPath,filters:[{name:extension.toUpperCase(),extensions:[extension]}]});return result.canceled?null:result.filePath??null;}

function registerIPC(){
  ipcMain.on('folio:prepared-close',(event,result)=>{try{trusted(event);closeResolve?.(result?.ok?undefined:String(result?.error??'笔记保存失败'));}catch{/* Ignore foreign renderer acknowledgements. */}});
  handle('bootstrap',()=>{rendererReady=true;if(pendingFiles.length)setImmediate(()=>void openPending());return {settings:settings.public(),workspaces:library.list(),removedWorkspaces:library.listRemoved(),version:app.getVersion()};});
  handle('create-workspace',async(paths?:string[])=>{const files=paths??await choosePdfs();return files?.length?library.createFromPaths(files):null;});
  handle('import-documents',async(id:string,paths?:string[])=>{library.get(id);const files=paths??await choosePdfs();return files?.length?library.addDocuments(id,files):null;});
  handle('demo',async()=>{
    const existing=library.list().find(w=>w.tags.includes('Folio 示例'));if(existing)return existing;
    const dir=await fs.mkdtemp(path.join(app.getPath('temp'),'folio-demo-'));
    try{const paths=await writeDemo(dir);const ws=await library.createFromPaths(paths);return await library.patch(ws.id,{title:'A workspace for a closer reading',authors:'Folio Studio',journal:'交互阅读示例 · 非真实论文',tags:['Folio 示例','阅读指南'],notes:'## 我的阅读笔记\n\n这是一篇用于体验阅读功能的示例文档，数据均为演示内容。\n\n- 左侧阅读正文，右侧对照补充材料。\n- 选中文字后可高亮、添加批注或询问 AI。\n- 打开设置，填写自己的 DeepSeek API Key 开始辅助阅读。\n'});}
    finally{await fs.rm(dir,{recursive:true,force:true});}
  });
  handle('update-workspace',(id:string,patch:Partial<Workspace>)=>library.patch(id,patch));
  handle('delete-workspace',async(id:string)=>{await flushRenderer();await ai.cancelWorkspace(id);await library.moveToTrash(id);});
  handle('list-removed-workspaces',()=>library.listRemoved());
  handle('restore-workspace',(id:string)=>library.restoreRemoved(id));
  handle('purge-workspace',async(id:string)=>{
    const removed=library.getRemoved(id);
    const result=await dialog.showMessageBox(window!,{type:'warning',title:'彻底删除文章',message:`彻底删除「${removed.title}」？`,detail:'此操作将永久删除这篇文章的全部 PDF、笔记、标注、记忆和对话，无法恢复。',buttons:['彻底删除','取消'],defaultId:1,cancelId:1,noLink:true});
    if(result.response!==0)return false;
    await library.purgeRemoved(id,removed.removedAt);return true;
  });
  handle('copy-text',(text:string)=>{if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>5*1024*1024)throw new Error('复制内容必须是 5 MB 以内的文字');clipboard.writeText(text);});
  handle('update-document',(id:string,doc:string,patch:Partial<PaperDocument>)=>library.patchDocument(id,doc,patch));
  handle('undo-document-edit',(id:string,direction:'undo'|'redo')=>library.undoDocumentEdit(id,direction));
  handle('document-edit-history',(id:string)=>library.getDocumentEditHistory(id));
  handle('native-edit',(action:string)=>{if(action==='undo')window!.webContents.undo();else if(action==='redo')window!.webContents.redo();else throw new Error('无效编辑操作');});
  handle('update-view',(id:string,docId:string,pane:'left'|'right',view:ViewState)=>library.mutate(id,ws=>{
    if(pane!=='left'&&pane!=='right')throw new Error('无效阅读区域');
    const doc=ws.documents.find(d=>d.id===docId);if(!doc)throw new Error('PDF 已不存在');
    doc.view=view;
    const displayed=ws.layout[pane==='left'?'leftId':'rightId'];
    if(displayed===docId)ws.layout.views={...ws.layout.views,[pane]:{documentId:docId,state:view}};
  }));
  handle('remove-document',(id:string,doc:string)=>library.detachDocument(id,doc));
  handle('read-document',async(id:string,doc:string)=>new Uint8Array(await fs.readFile(library.documentPath(id,doc))));
  handle('index-document',(id:string,doc:string,index:DocumentIndex)=>library.index(id,doc,index));
  handle('reveal-workspace',async(id:string)=>{const error=await shell.openPath(library.directory(id));if(error)throw new Error(error);});
  handle('export-pdf',async(id:string,docId:string)=>{
    await library.flush();
    const doc=library.get(id).documents.find(d=>d.id===docId);if(!doc)throw new Error('找不到 PDF');
    const file=await saveFile('导出包含目录与批注的 PDF 副本',`${safeFilename(doc.name.replace(/\.pdf$/i,''))} - Folio.pdf`,'pdf');if(!file)return null;
    const original=library.documentPath(id,docId);
    const destination=await fs.realpath(file).catch(()=>path.resolve(file));
    if(sameLocalPath(destination,await fs.realpath(original)))throw new Error('请另存为一个新文件，以保留原件');
    try{await atomicWrite(file,await exportAnnotatedPdf(await fs.readFile(library.documentPath(id,docId)),doc));}
    catch(e){if(/encrypted/i.test(String(e)))throw new Error('加密 PDF 可阅读，但目前不能导出修改后的副本。请先用原工具解除加密。');throw e;}
    return {path:file};
  });
  handle('print-pdf',async(id:string,docId:string)=>{
    await library.flush();
    const doc=library.get(id).documents.find(d=>d.id===docId);if(!doc)throw new Error('找不到 PDF');
    const bytes=await exportAnnotatedPdf(await fs.readFile(library.documentPath(id,docId)),doc);
    const file=path.join(app.getPath('temp'),`folio-print-${randomUUID()}.pdf`);await fs.writeFile(file,bytes);
    const win=new BrowserWindow({width:1000,height:800,show:true,title:`打印 · ${doc.name}`,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    printWindows.add(win);win.on('closed',()=>{printWindows.delete(win);void fs.rm(file,{force:true});});
    // Chromium's native PDF toolbar supplies print preview, printer selection, and page ranges.
    await win.loadFile(file);
  });
  handle('save-settings',(input:Settings)=>settings.save(input));
  handle('pick-folder',async(kind:string)=>{if(kind!=='vault')throw new Error('无效目录类型');const r=await dialog.showOpenDialog(window!,{title:'选择 Obsidian 仓库目录',properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0];});
  handle('start-chat',(request:ChatRequest)=>ai.start(request));
  handle('abort-chat',(id:string)=>ai.abort(id));
  handle('new-conversation',(id:string)=>library.mutate(id,ws=>{const c={id:randomUUID(),title:`新对话 ${ws.conversations.length+1}`,createdAt:Date.now(),messages:[]};ws.conversations.push(c);ws.activeConversationId=c.id;}));
  handle('delete-memory',(id:string,memoryId:string)=>library.mutate(id,ws=>{ws.memories=ws.memories.filter(m=>m.id!==memoryId);ws.memoryIndex=ws.memories.slice(0,12).map(m=>`- [${m.type}] ${m.title}`).join('\n');}));
  handle('export-markdown',async(id:string,target:string)=>{
    await library.flush();
    const ws=library.get(id);
    if(target==='obsidian')return exportToObsidian(ws,settings.get());
    if(target!=='file')throw new Error('无效导出目标');
    const file=await saveFile('导出 Markdown 阅读笔记',`${safeFilename(ws.title)}.md`,'md');if(!file)return null;
    await atomicWrite(file,renderMarkdown(ws,undefined,library.root));return {path:file};
  });
  handle('backup',async()=>{const file=await saveFile('备份完整论文库（包含已移除文章）',`Folio-backup-${new Date().toISOString().slice(0,10)}.zip`,'zip');if(!file)return null;await flushRenderer();await atomicWrite(file,await library.archive());return {path:file};});
  handle('restore',async()=>{
    const result=await dialog.showOpenDialog(window!,{title:'合并恢复 Folio 备份（已存在的文章保留）',properties:['openFile'],filters:[{name:'Folio 备份',extensions:['zip']}]});if(result.canceled)return null;
    return {count:await library.restore(await fs.readFile(result.filePaths[0]))};
  });
  handle('import-legacy',async()=>{
    const result=await dialog.showOpenDialog(window!,{title:'导入 Paper Reading Assistant JSON 备份',properties:['openFile'],filters:[{name:'旧插件备份',extensions:['json']}]});if(result.canceled)return null;
    return {count:await library.importLegacy(JSON.parse(await fs.readFile(result.filePaths[0],'utf8')))};
  });
  handle('open-external',async(url:string)=>{const u=new URL(url);if(!['https:','http:','mailto:'].includes(u.protocol))throw new Error('不支持的外部链接');await shell.openExternal(u.href);});
  handle('open-obsidian',async()=>{const vault=settings.get().vaultPath;if(!vault)throw new Error('请先选择 Obsidian 仓库');await shell.openExternal(`obsidian://open?vault=${encodeURIComponent(path.basename(vault))}`);});
}

function makeMenu(){
  const command=(name:string)=>()=>emit('command',name);
  const importFolder=async()=>{
    try{if(!window)await createWindow();const files=await choosePdfs('folder');if(files?.length)emit('open',await library.createFromPaths(files));}
    catch(error){if(window)await dialog.showMessageBox(window,{type:'error',message:'无法导入文章文件夹',detail:error instanceof Error?error.message:String(error)});}
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Folio',submenu:[{role:'about'},{type:'separator'},{label:'设置…',accelerator:'CmdOrCtrl+,',click:command('settings')},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
    {label:'文件',submenu:[{label:'导入论文…',accelerator:'CmdOrCtrl+O',click:command('import')},{label:'导入文章文件夹…',click:()=>void importFolder()},{label:'添加补充材料…',accelerator:'CmdOrCtrl+Shift+O',click:command('supplement')},{label:'返回论文库',accelerator:'CmdOrCtrl+L',click:command('library')},{type:'separator'},{label:'导出阅读笔记…',accelerator:'CmdOrCtrl+Shift+E',click:command('export')},{role:'close'}]},
    {label:'编辑',submenu:[{label:'撤销',accelerator:'CmdOrCtrl+Z',click:command('undo')},{label:'重做',accelerator:'CmdOrCtrl+Shift+Z',click:command('redo')},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'视图',submenu:[{label:'专注阅读',accelerator:'CmdOrCtrl+Shift+F',click:command('focus-reading')},{type:'separator'},{label:'切换分栏',accelerator:'CmdOrCtrl+\\',click:command('split')},{label:'纵向分割（左右）',click:command('split-vertical')},{label:'横向分割（上下）',click:command('split-horizontal')},{label:'取消分割',click:command('split-none')},{type:'separator'},{label:'显示 / 隐藏助手',accelerator:'CmdOrCtrl+J',click:command('assistant')},{role:'togglefullscreen'},...(devURL?[{role:'toggleDevTools' as const}]:[])]},
    {label:'窗口',submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]}
  ]));
}

async function openPending(){
  if(!initialized||!window||!pendingFiles.length)return;
  const files=pendingFiles.splice(0);
  try{const workspace=await library.createFromPaths(files);emit('open',workspace);}
  catch(e){await dialog.showMessageBox(window,{type:'error',message:'无法导入 PDF',detail:e instanceof Error?e.message:String(e)});}
}
async function createWindow(){
  windowCanClose=false;rendererReady=false;
  window=new BrowserWindow({width:1540,height:990,minWidth:1000,minHeight:660,title:'Folio',backgroundColor:'#f6f5f1',...(process.platform==='darwin'?{titleBarStyle:'hiddenInset' as const,trafficLightPosition:{x:18,y:18}}:{}),show:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false}});
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https?:/.test(url))void shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(isApplicationURL(url,appFile,devURL))return;event.preventDefault();if(/^https?:/.test(url))void shell.openExternal(url);});
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  window.webContents.on('render-process-gone',(_event,details)=>{void logEvent(`renderer-exit ${JSON.stringify(details)}`);});
  window.webContents.on('did-fail-load',(_event,code,description,url,isMainFrame)=>{if(isMainFrame)void logEvent(`page-load-failed ${code} ${description} ${url}`);});
  window.once('ready-to-show',()=>window?.show());
  window.on('close',event=>{
    if(windowCanClose)return;event.preventDefault();
    void flushRenderer().then(async()=>{await library.flush();windowCanClose=true;window?.close();}).catch(e=>{if(window)void dialog.showMessageBox(window,{type:'error',message:'笔记尚未保存，窗口保持打开',detail:String(e)});});
  });
  window.on('closed',()=>{window=null;});
  if(devURL)await window.loadURL(devURL);else await window.loadFile(appFile);
  // This needs a loaded renderer; awaiting it before loadFile can stall startup.
  // PDF panes own trackpad pinch while the surrounding UI stays at a fixed scale.
  await window.webContents.setVisualZoomLevelLimits(1,1);
}

app.on('open-file',(event,file)=>{event.preventDefault();pendingFiles.push(file);if(initialized){if(!window)void createWindow();else void openPending();}});
app.on('activate',()=>{if(initialized&&!window)void createWindow();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',event=>{
  if(quitting||!library)return;event.preventDefault();quitting=true;
  void (async()=>{await flushRenderer();await ai?.dispose();await library.flush();windowCanClose=true;app.quit();})().catch(e=>{quitting=false;if(window)void dialog.showMessageBox(window,{type:'error',message:'退出前未能保存笔记',detail:String(e)});});
});

if(primaryInstance)void app.whenReady().then(async()=>{
  await logEvent(`starting Folio ${app.getVersion()} / Electron ${process.versions.electron} / ${process.arch}`);
  const root=process.env.FOLIO_USER_DATA?path.join(app.getPath('userData'),'Library'):path.join(app.getPath('documents'),'Folio Library');
  settings=new SettingsStore(app.getPath('userData'),root);await settings.init();library=new LibraryStore(root);await library.init();
  ai=createAIService({getWorkspace:id=>library.get(id),listWorkspaces:()=>library.list(),getSettings:()=>settings.get(),getDocumentPages:(id,doc)=>library.pages(id,doc),mutateWorkspace:(id,fn)=>library.mutate(id,fn),emit:event=>emit('chat',event)});
  registerIPC();makeMenu();initialized=true;await createWindow();
  await logEvent('ready');
  if(library.loadWarnings.length)await dialog.showMessageBox(window!,{type:'warning',message:'部分工作区未能读取，文件已保留',detail:library.loadWarnings.join('\n')});
}).catch(async error=>{await logEvent(`startup-error ${error instanceof Error?error.stack:String(error)}`);dialog.showErrorBox('Folio 启动失败',`${error instanceof Error?error.message:String(error)}\n\n诊断日志：${startupLog}`);app.quit();});
