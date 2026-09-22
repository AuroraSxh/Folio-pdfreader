import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LibraryStore, atomicWrite, safeFilename } from './store';
import { SettingsStore } from './settings';
import { exportAnnotatedPdf } from './pdf-export';
import { writeDemo } from './demo';
import { createAIService } from './ai';
import { createUpdateService } from './updater';
import type { UpdateService } from '../shared/updates';
import { renderMarkdown, exportToObsidian } from './obsidian';
import { isApplicationURL, pdfDialogOptions, pdfPathsFromArguments, sameLocalPath } from './desktop';
import type { ChatRequest, DocumentIndex, PaperDocument, Settings, Workspace, ViewState } from '../shared/types';
import { translate } from '../shared/i18n';

app.setName('Folio');
if(process.env.FOLIO_USER_DATA)app.setPath('userData',process.env.FOLIO_USER_DATA);
let window:BrowserWindow|null=null;
let library:LibraryStore;
let settings:SettingsStore;
let ai:ReturnType<typeof createAIService>;
let updater:UpdateService;
let autoUpdateTimer:ReturnType<typeof setTimeout>|undefined;
const t=(zh:string,en:string,values?:Record<string,string|number>)=>translate(settings?.getLanguage()??'zh-CN',zh,en,values);
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

// Localize known legacy backend errors at the IPC boundary; file names, user
// content and unknown provider/OS diagnostics are preserved verbatim.
const legacyErrors:Record<string,string>={
  '已移除文章记录无效':'Invalid removed-paper record.',
  '工作区文件格式无效':'Invalid workspace file format.',
  '工作区 PDF 记录无效':'Invalid workspace PDF record.',
  '对话数据无效':'Invalid conversation data.',
  '当前对话不存在':'The current conversation does not exist.',
  '记忆数据无效':'Invalid memory data.',
  '阅读布局无效':'Invalid reading layout.',
  '分割方向无效':'Invalid split direction.',
  '阅读区域状态无效':'Invalid reading-pane state.',
  '总结数据无效':'Invalid summary data.',
  '工作区 ID 不匹配':'Workspace ID does not match.',
  '找不到已移除的文章':'Removed paper not found.',
  '找不到这篇论文':'Paper not found.',
  '找不到此 PDF':'PDF not found.',
  '无效撤销操作':'Invalid undo or redo action.',
  '批注或目录已从其他来源改变，已清除过期撤销历史，当前内容未修改':'Annotations or bookmarks changed elsewhere. Outdated undo history was cleared; current content was not changed.',
  '已移除文章目录不是有效的本地文件夹':'The removed-papers directory is not a valid local folder.',
  '已移除文章不是有效的本地文件夹':'The removed paper is not a valid local folder.',
  '已移除文章 ID 不匹配':'Removed-paper ID does not match.',
  '工作区已存在（可能位于已移除文章中）':'The workspace already exists, possibly in Removed papers.',
  '不能修改工作区 ID':'The workspace ID cannot be changed.',
  '未找到 PDF 文件，请选择 PDF 或包含 PDF 的文件夹':'No PDFs were found. Choose PDF files or a folder containing them.',
  '未找到 PDF 文件':'No PDF files were found.',
  'PDF 已不存在':'The PDF is no longer available.',
  'PDF 文本索引无效':'Invalid PDF text index.',
  'PDF 不存在':'PDF not found.',
  '已移除文章中已有相同 ID，未移动任何文件':'A removed paper already has this ID. No files were moved.',
  '文章目录无效':'Invalid paper directory.',
  '论文库中已有相同 ID 的文件夹，无法覆盖恢复':'A folder with this ID already exists in the library; restore will not overwrite it.',
  '文章状态已改变，请重新确认彻底删除':'The paper has changed. Confirm permanent deletion again.',
  '已移除文章记录已改变，未删除文件':'The removed-paper record changed. No files were deleted.',
  '不是 Folio 备份文件':'This is not a Folio backup.',
  '备份包含无效或重复路径':'The backup contains invalid or duplicate paths.',
  '备份工作区 ID 不一致':'The backup workspace ID does not match.',
  '备份 PDF 内容无效':'A PDF in the backup is invalid.',
  '备份中已移除 PDF 路径无效':'A removed-PDF path in the backup is invalid.',
  '备份中已移除 PDF 内容无效':'A removed PDF in the backup is invalid.',
  '备份文本索引路径无效':'A text-index path in the backup is invalid.',
  '备份文本索引无效':'A text index in the backup is invalid.',
  '找不到旧插件备份中的 articles':'The legacy extension backup has no articles collection.',
  '旧插件文章标题无效，未导入任何文章':'A legacy paper title is invalid. No papers were imported.',
  '请先在设置中选择 Obsidian Vault 文件夹。':'Choose an Obsidian vault folder in Settings first.',
  'Obsidian Vault 路径不是文件夹。':'The Obsidian vault path is not a folder.',
  'Obsidian 子文件夹必须是 Vault 内的相对路径。':'The Obsidian subfolder must be a relative path inside the vault.',
  'Obsidian 子文件夹不能通过链接指向 Vault 外部。':'The Obsidian subfolder cannot link outside the vault.',
  '符号链接未载入，文件已保留':'The symbolic link was not loaded; files have been kept.',
};
function localizeBackendError(error:unknown):string{
  const message=error instanceof Error?error.message:String(error);
  if(settings?.getLanguage()!=='en')return message;
  if(legacyErrors[message])return legacyErrors[message];
  const dynamic:[RegExp,string][]=[
    [/^PDF 大于 512 MB：(.*)$/,'PDF exceeds 512 MB: $1'],
    [/^不是有效的 PDF：(.*)$/,'Not a valid PDF: $1'],
    [/^备份目录无效：(.*)$/,'Invalid backup directory: $1'],
    [/^备份缺少 PDF：(.*)$/,'PDF missing from backup: $1'],
    [/^已移除文章 (.*) 无法读取，请先保留其文件并修复，再备份完整论文库$/,'Removed paper $1 cannot be read. Keep and repair its files before backing up the complete library.'],
  ];
  for(const [pattern,replacement]of dynamic)if(pattern.test(message))return message.replace(pattern,replacement);
  const separator=message.lastIndexOf(': ');
  if(separator>=0){const suffix=message.slice(separator+2);if(legacyErrors[suffix])return message.slice(0,separator+2)+legacyErrors[suffix];}
  return message;
}

function flushRenderer():Promise<void>{
  if(!window||window.isDestroyed()||!rendererReady)return Promise.resolve();
  if(flushing)return flushing;
  flushing=new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{closeResolve=undefined;reject(new Error(t("窗口尚未响应保存请求，请稍后再试。","The window has not responded to the save request. Please try again shortly.")));},10000);
    closeResolve=error=>{clearTimeout(timer);closeResolve=undefined;if(error)reject(new Error(error));else resolve();};
    emit('prepare-close',null);
  }).finally(()=>{flushing=undefined;});
  return flushing;
}

function emit(channel:string,value:unknown){if(window&&!window.isDestroyed())window.webContents.send(`folio:${channel}`,value);}
function trusted(event:Electron.IpcMainInvokeEvent|Electron.IpcMainEvent){
  if(event.sender!==window?.webContents || event.senderFrame!==event.sender.mainFrame)throw new Error(t("拒绝未授权窗口请求","Unauthorized window request rejected."));
  const url=event.senderFrame?.url??'';
  if(!isApplicationURL(url,appFile,devURL))throw new Error(t("拒绝未授权来源","Unauthorized origin rejected."));
}
function handle(channel:string,fn:(...args:any[])=>unknown){ipcMain.handle(`folio:${channel}`,async(event,...args)=>{trusted(event);try{return await fn(...args);}catch(error){throw new Error(localizeBackendError(error));}});}
async function createWorkspaceFromPaths(paths:string[]){
  const language=settings.getLanguage();
  const ws=await library.createFromPaths(paths);
  // Only initialize new, empty conversation labels. Locale changes never rewrite
  // an existing paper's title, messages, notes, or memories.
  if(language!=='en')return ws;
  return library.mutate(ws.id,current=>{for(const conversation of current.conversations)if(!conversation.messages.length&&conversation.title==='阅读对话')conversation.title='Reading conversation';});
}
async function choosePdfs(mode:'files'|'folder'|'mixed'='mixed'){
  const options=pdfDialogOptions(mode);
  options.title=mode==='folder'?t('选择文章文件夹','Choose a paper folder'):process.platform==='darwin'&&mode==='mixed'?t('选择正文 PDF 和补充材料，或一个文章文件夹','Choose the main PDF and supplements, or a paper folder'):t('选择正文 PDF 和补充材料','Choose the main PDF and supplementary files');
  options.buttonLabel=t('打开','Open');if(options.filters)options.filters=[{name:t('PDF 文档','PDF documents'),extensions:['pdf']}];
  const result=await dialog.showOpenDialog(window!,options);return result.canceled?null:result.filePaths;
}
async function saveFile(title:string,defaultPath:string,extension:string){const result=await dialog.showSaveDialog(window!,{title,defaultPath,buttonLabel:t('保存','Save'),filters:[{name:extension.toUpperCase(),extensions:[extension]}]});return result.canceled?null:result.filePath??null;}

function registerIPC(){
  ipcMain.on('folio:prepared-close',(event,result)=>{try{trusted(event);closeResolve?.(result?.ok?undefined:String(result?.error??t("笔记保存失败","Notes could not be saved.")));}catch{/* Ignore foreign renderer acknowledgements. */}});
  handle('bootstrap',()=>{rendererReady=true;if(pendingFiles.length)setImmediate(()=>void openPending());return {settings:settings.public(),workspaces:library.list(),removedWorkspaces:library.listRemoved(),version:app.getVersion()};});
  handle('create-workspace',async(paths?:string[])=>{const files=paths??await choosePdfs();return files?.length?createWorkspaceFromPaths(files):null;});
  handle('import-documents',async(id:string,paths?:string[])=>{library.get(id);const files=paths??await choosePdfs();return files?.length?library.addDocuments(id,files):null;});
  handle('demo',async()=>{
    const existing=library.list().find(w=>(w.tags.includes('Folio 示例')||w.tags.includes('Folio example')));if(existing)return existing;
    const dir=await fs.mkdtemp(path.join(app.getPath('temp'),'folio-demo-'));
    try{const paths=await writeDemo(dir);const ws=await createWorkspaceFromPaths(paths);return await library.patch(ws.id,{title:'A workspace for a closer reading',authors:'Folio Studio',journal:t('交互阅读示例 · 非真实论文','Interactive reading example · not a real paper'),tags:[t('Folio 示例','Folio example'),t('阅读指南','Reading guide')],notes:t('## 我的阅读笔记\n\n这是一篇用于体验阅读功能的示例文档，数据均为演示内容。\n\n- 左侧阅读正文，右侧对照补充材料。\n- 选中文字后可高亮、添加批注或询问 AI。\n- 打开设置，填写自己的 DeepSeek API Key 开始辅助阅读。\n','## My reading notes\n\nThis sample document demonstrates reading features. All data is illustrative.\n\n- Read the main text on the left and compare supplementary files on the right.\n- Select text to highlight, annotate or ask AI.\n- Open Settings and enter your own DeepSeek API key to start assisted reading.\n')});}
    finally{await fs.rm(dir,{recursive:true,force:true});}
  });
  handle('update-workspace',(id:string,patch:Partial<Workspace>)=>library.patch(id,patch));
  handle('delete-workspace',async(id:string)=>{await flushRenderer();await ai.cancelWorkspace(id);await library.moveToTrash(id);});
  handle('list-removed-workspaces',()=>library.listRemoved());
  handle('restore-workspace',(id:string)=>library.restoreRemoved(id));
  handle('purge-workspace',async(id:string)=>{
    const removed=library.getRemoved(id);
    const result=await dialog.showMessageBox(window!,{type:'warning',title:t("彻底删除文章","Permanently delete paper"),message:t('彻底删除「{title}」？','Permanently delete “{title}”?',{title:removed.title}),detail:t("此操作将永久删除这篇文章的全部 PDF、笔记、标注、记忆和对话，无法恢复。","This permanently deletes all PDFs, notes, annotations, memories and conversations for this paper. It cannot be undone."),buttons:[t("彻底删除","Delete permanently"),t("取消","Cancel")],defaultId:1,cancelId:1,noLink:true});
    if(result.response!==0)return false;
    await library.purgeRemoved(id,removed.removedAt);return true;
  });
  handle('copy-text',(text:string)=>{if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>5*1024*1024)throw new Error(t("复制内容必须是 5 MB 以内的文字","Copied content must be text no larger than 5 MB."));clipboard.writeText(text);});
  handle('update-document',(id:string,doc:string,patch:Partial<PaperDocument>)=>library.patchDocument(id,doc,patch));
  handle('undo-document-edit',(id:string,direction:'undo'|'redo')=>library.undoDocumentEdit(id,direction));
  handle('document-edit-history',(id:string)=>library.getDocumentEditHistory(id));
  handle('native-edit',(action:string)=>{if(action==='undo')window!.webContents.undo();else if(action==='redo')window!.webContents.redo();else throw new Error(t("无效编辑操作","Invalid editing action."));});
  handle('update-view',(id:string,docId:string,pane:'left'|'right',view:ViewState)=>library.mutate(id,ws=>{
    if(pane!=='left'&&pane!=='right')throw new Error(t("无效阅读区域","Invalid reading pane."));
    const doc=ws.documents.find(d=>d.id===docId);if(!doc)throw new Error(t("PDF 已不存在","The PDF is no longer available."));
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
    const doc=library.get(id).documents.find(d=>d.id===docId);if(!doc)throw new Error(t("找不到 PDF","PDF not found."));
    const file=await saveFile(t("导出包含目录与批注的 PDF 副本","Export a PDF copy with bookmarks and annotations"),`${safeFilename(doc.name.replace(/\.pdf$/i,''))} - Folio.pdf`,'pdf');if(!file)return null;
    const original=library.documentPath(id,docId);
    const destination=await fs.realpath(file).catch(()=>path.resolve(file));
    if(sameLocalPath(destination,await fs.realpath(original)))throw new Error(t("请另存为一个新文件，以保留原件","Save to a new file to preserve the original."));
    try{await atomicWrite(file,await exportAnnotatedPdf(await fs.readFile(library.documentPath(id,docId)),doc));}
    catch(e){if(/encrypted/i.test(String(e)))throw new Error(t("加密 PDF 可阅读，但目前不能导出修改后的副本。请先用原工具解除加密。","Encrypted PDFs can be read, but edited copies cannot be exported yet. Remove encryption with the original tool first."));throw e;}
    return {path:file};
  });
  handle('print-pdf',async(id:string,docId:string)=>{
    await library.flush();
    const doc=library.get(id).documents.find(d=>d.id===docId);if(!doc)throw new Error(t("找不到 PDF","PDF not found."));
    const bytes=await exportAnnotatedPdf(await fs.readFile(library.documentPath(id,docId)),doc);
    const file=path.join(app.getPath('temp'),`folio-print-${randomUUID()}.pdf`);await fs.writeFile(file,bytes);
    const win=new BrowserWindow({width:1000,height:800,show:true,title:t('打印 · {name}','Print · {name}',{name:doc.name}),webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    printWindows.add(win);win.on('closed',()=>{printWindows.delete(win);void fs.rm(file,{force:true});});
    // Chromium's native PDF toolbar supplies print preview, printer selection, and page ranges.
    await win.loadFile(file);
  });
  handle('save-settings',async(input:Settings)=>{const language=settings.getLanguage(),saved=await settings.save(input);if(language!==saved.language)makeMenu();return saved;});
  handle('pick-folder',async(kind:string)=>{if(kind!=='vault')throw new Error(t("无效目录类型","Invalid folder type."));const r=await dialog.showOpenDialog(window!,{title:t("选择 Obsidian 仓库目录","Choose an Obsidian vault folder"),properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0];});
  handle('start-chat',(request:ChatRequest)=>ai.start(request));
  handle('abort-chat',(id:string)=>ai.abort(id));
  handle('update-status',()=>updater.getStatus());
  handle('check-updates',()=>updater.check(true));
  handle('download-update',()=>updater.download());
  handle('cancel-update',()=>updater.cancel());
  handle('install-update',async()=>{await updater.install();});
  handle('new-conversation',(id:string)=>library.mutate(id,ws=>{const c={id:randomUUID(),title:t('新对话 {number}','New conversation {number}',{number:ws.conversations.length+1}),createdAt:Date.now(),messages:[]};ws.conversations.push(c);ws.activeConversationId=c.id;}));
  handle('delete-memory',(id:string,memoryId:string)=>library.mutate(id,ws=>{ws.memories=ws.memories.filter(m=>m.id!==memoryId);ws.memoryIndex=ws.memories.slice(0,12).map(m=>`- [${m.type}] ${m.title}`).join('\n');}));
  handle('export-markdown',async(id:string,target:string)=>{
    await library.flush();
    const ws=library.get(id);
    if(target==='obsidian')return exportToObsidian(ws,settings.get());
    if(target!=='file')throw new Error(t("无效导出目标","Invalid export target."));
    const file=await saveFile(t("导出 Markdown 阅读笔记","Export Markdown reading notes"),`${safeFilename(ws.title)}.md`,'md');if(!file)return null;
    await atomicWrite(file,renderMarkdown(ws,undefined,library.root,settings.getLanguage()));return {path:file};
  });
  handle('backup',async()=>{const file=await saveFile(t("备份完整论文库（包含已移除文章）","Back up the full library, including removed papers"),`Folio-backup-${new Date().toISOString().slice(0,10)}.zip`,'zip');if(!file)return null;await flushRenderer();await atomicWrite(file,await library.archive());return {path:file};});
  handle('restore',async()=>{
    const result=await dialog.showOpenDialog(window!,{title:t("合并恢复 Folio 备份（已存在的文章保留）","Merge a Folio backup (existing papers are kept)"),properties:['openFile'],filters:[{name:t("Folio 备份","Folio backup"),extensions:['zip']}]});if(result.canceled)return null;
    return {count:await library.restore(await fs.readFile(result.filePaths[0]))};
  });
  handle('import-legacy',async()=>{
    const result=await dialog.showOpenDialog(window!,{title:t("导入 Paper Reading Assistant JSON 备份","Import a Paper Reading Assistant JSON backup"),properties:['openFile'],filters:[{name:t("旧插件备份","Legacy extension backup"),extensions:['json']}]});if(result.canceled)return null;
    return {count:await library.importLegacy(JSON.parse(await fs.readFile(result.filePaths[0],'utf8')))};
  });
  handle('open-external',async(url:string)=>{const u=new URL(url);if(!['https:','http:','mailto:'].includes(u.protocol))throw new Error(t("不支持的外部链接","Unsupported external link."));await shell.openExternal(u.href);});
  handle('open-obsidian',async()=>{const vault=settings.get().vaultPath;if(!vault)throw new Error(t("请先选择 Obsidian 仓库","Choose an Obsidian vault first."));await shell.openExternal(`obsidian://open?vault=${encodeURIComponent(path.basename(vault))}`);});
}

function initializeUpdater(){
  updater=createUpdateService({version:app.getVersion(),platform:process.platform,arch:process.arch,portable:!!process.env.PORTABLE_EXECUTABLE_FILE,directory:path.join(app.getPath('userData'),'updates'),emit:status=>emit('update',status),
    flush:async()=>{await flushRenderer();if(process.platform==='win32')for(const ws of library.list())await ai.cancelWorkspace(ws.id);await library.flush();},
    openInstaller:async(file)=>{if(process.platform==='win32'&&process.env.PORTABLE_EXECUTABLE_FILE){shell.showItemInFolder(file);return;}const error=await shell.openPath(file);if(error)throw new Error(error);if(process.platform==='win32')app.quit();}
  });
}
function scheduleUpdateCheck(){
  if(autoUpdateTimer||!app.isPackaged||process.env.FOLIO_USER_DATA)return;
  autoUpdateTimer=setTimeout(()=>{autoUpdateTimer=undefined;if(!quitting&&settings.public().autoCheckUpdates)void updater.check(false);},5000);
}

function makeMenu(){
  const command=(name:string)=>()=>emit('command',name);
  const importFolder=async()=>{
    try{if(!window)await createWindow();const files=await choosePdfs('folder');if(files?.length)emit('open',await createWorkspaceFromPaths(files));}
    catch(error){if(window)await dialog.showMessageBox(window,{type:'error',message:t("无法导入文章文件夹","Could not import the paper folder"),detail:localizeBackendError(error)});}
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Folio',submenu:[{label:t("关于 Folio","About Folio"),role:'about'},{type:'separator'},{label:t("设置…","Settings…"),accelerator:'CmdOrCtrl+,',click:command('settings')},{label:t('检查更新…','Check for Updates…'),click:()=>{emit('command','updates');void updater.check(true);}},{type:'separator'},{label:t("隐藏 Folio","Hide Folio"),role:'hide'},{label:t("隐藏其他应用","Hide Others"),role:'hideOthers'},{label:t("显示全部","Show All"),role:'unhide'},{type:'separator'},{label:t("退出 Folio","Quit Folio"),role:'quit'}]},
    {label:t("文件","File"),submenu:[{label:t("导入论文…","Import paper…"),accelerator:'CmdOrCtrl+O',click:command('import')},{label:t("导入文章文件夹…","Import paper folder…"),click:()=>void importFolder()},{label:t("添加补充材料…","Add supplementary files…"),accelerator:'CmdOrCtrl+Shift+O',click:command('supplement')},{label:t("返回论文库","Back to library"),accelerator:'CmdOrCtrl+L',click:command('library')},{type:'separator'},{label:t("导出阅读笔记…","Export reading notes…"),accelerator:'CmdOrCtrl+Shift+E',click:command('export')},{label:t("关闭窗口","Close Window"),role:'close'}]},
    {label:t("编辑","Edit"),submenu:[{label:t("撤销","Undo"),accelerator:'CmdOrCtrl+Z',click:command('undo')},{label:t("重做","Redo"),accelerator:'CmdOrCtrl+Shift+Z',click:command('redo')},{type:'separator'},{label:t("剪切","Cut"),role:'cut'},{label:t("复制","Copy"),role:'copy'},{label:t("粘贴","Paste"),role:'paste'},{label:t("全选","Select All"),role:'selectAll'}]},
    {label:t("视图","View"),submenu:[{label:t("专注阅读","Focus reading"),accelerator:'CmdOrCtrl+Shift+F',click:command('focus-reading')},{type:'separator'},{label:t("切换分栏","Toggle split view"),accelerator:'CmdOrCtrl+\\',click:command('split')},{label:t("纵向分割（左右）","Split side by side"),click:command('split-vertical')},{label:t("横向分割（上下）","Split top and bottom"),click:command('split-horizontal')},{label:t("取消分割","Close split view"),click:command('split-none')},{type:'separator'},{label:t("显示 / 隐藏助手","Show / hide assistant"),accelerator:'CmdOrCtrl+J',click:command('assistant')},{label:t("切换全屏","Toggle Full Screen"),role:'togglefullscreen'},...(devURL?[{label:t("开发者工具","Developer Tools"),role:'toggleDevTools' as const}]:[])]},
    {label:t("窗口","Window"),submenu:[{label:t("最小化","Minimize"),role:'minimize'},{label:t("缩放窗口","Zoom Window"),role:'zoom'},{label:t("全部置于最前","Bring All to Front"),role:'front'}]}
  ]));
}

async function openPending(){
  if(!initialized||!window||!pendingFiles.length)return;
  const files=pendingFiles.splice(0);
  try{const workspace=await createWorkspaceFromPaths(files);emit('open',workspace);}
  catch(e){await dialog.showMessageBox(window,{type:'error',message:t("无法导入 PDF","Could not import PDF"),detail:localizeBackendError(e)});}
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
    void flushRenderer().then(async()=>{await library.flush();windowCanClose=true;window?.close();}).catch(e=>{if(window)void dialog.showMessageBox(window,{type:'error',message:t("笔记尚未保存，窗口保持打开","Notes have not been saved; the window will remain open"),detail:localizeBackendError(e)});});
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
  void (async()=>{await flushRenderer();await ai?.dispose();await library.flush();if(autoUpdateTimer)clearTimeout(autoUpdateTimer);await updater?.dispose();windowCanClose=true;app.quit();})().catch(e=>{quitting=false;if(window)void dialog.showMessageBox(window,{type:'error',message:t("退出前未能保存笔记","Could not save notes before quitting"),detail:localizeBackendError(e)});});
});

if(primaryInstance)void app.whenReady().then(async()=>{
  await logEvent(`starting Folio ${app.getVersion()} / Electron ${process.versions.electron} / ${process.arch}`);
  const root=process.env.FOLIO_USER_DATA?path.join(app.getPath('userData'),'Library'):path.join(app.getPath('documents'),'Folio Library');
  settings=new SettingsStore(app.getPath('userData'),root);await settings.init();library=new LibraryStore(root);await library.init();
  ai=createAIService({getWorkspace:id=>library.get(id),listWorkspaces:()=>library.list(),getSettings:()=>settings.get(),getDocumentPages:(id,doc)=>library.pages(id,doc),mutateWorkspace:(id,fn)=>library.mutate(id,fn),emit:event=>emit('chat',event)});
  initializeUpdater();
  registerIPC();makeMenu();initialized=true;await createWindow();
  // One delayed check per launch; the service owns its six-hour cache. Tests and
  // development runs never contact GitHub automatically. Manual checks still work.
  scheduleUpdateCheck();
  await logEvent('ready');
  if(library.loadWarnings.length)await dialog.showMessageBox(window!,{type:'warning',message:t("部分工作区未能读取，文件已保留","Some workspaces could not be read; their files have been kept"),detail:library.loadWarnings.map(localizeBackendError).join('\n')});
}).catch(async error=>{await logEvent(`startup-error ${error instanceof Error?error.stack:String(error)}`);dialog.showErrorBox(t("Folio 启动失败","Folio could not start"),`${localizeBackendError(error)}\n\n${t('诊断日志：','Diagnostic log: ')}${startupLog}`);app.quit();});
