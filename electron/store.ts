import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import JSZip from 'jszip';
import { DEFAULT_VIEW, type Workspace, type PaperDocument, type DocumentIndex, type OutlineItem, type RemovedWorkspace, type DocumentEditHistory } from '../shared/types';

export async function atomicWrite(file: string, data: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, data, { mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
const reservedFilename = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
export function safeFilename(value:string) {
  let name=[...value.replace(/[\\/:*?"<>|\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim()].slice(0,140).join('').replace(/[. ]+$/g,'');
  while(Buffer.byteLength(name,'utf8')>200)name=[...name].slice(0,-1).join('');
  if(reservedFilename.test(name))name=`_${name}`;
  return name||'untitled';
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);
const clone = <T>(x: T): T => structuredClone(x);
const portablePdfName=(name:string)=>name===path.basename(name)&&!/[/\\:*?"<>|\x00-\x1f]/.test(name)&&!reservedFilename.test(name)&&/\.pdf$/i.test(name);
const removalFile = '.removal.json';
interface RemovedRecord { workspace: Workspace; removedAt: number }
type EditableFields = Partial<Pick<PaperDocument,'annotations'|'outline'|'outlineLoaded'>>;
interface RecordedEdit { documentId:string; before:string; after:string; bytes:number }
interface EditStack { undo:RecordedEdit[]; redo:RecordedEdit[] }
// Session-only history: at most 50 operations per article, 20 recently edited
// articles, and 16 MiB of UTF-16 snapshot strings. Oversized edits are still
// saved, but clear that article's history rather than retaining an unsafe gap.
const HISTORY_STEPS=50,HISTORY_ARTICLES=20,HISTORY_BYTES=16*1024*1024;
function validateRemoval(value: unknown): number {
  const item=value as {version?:number;removedAt?:number};
  if(!item||item.version!==1||typeof item.removedAt!=='number'||!Number.isFinite(item.removedAt)||item.removedAt<=0)throw new Error('已移除文章记录无效');
  return item.removedAt;
}
async function exists(file:string) {try{await fs.lstat(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
function removedSummary(record:RemovedRecord):RemovedWorkspace {
  const {workspace:ws,removedAt}=record;
  return {id:ws.id,title:ws.title,authors:ws.authors,tags:[...ws.tags],documentCount:ws.documents.length,removedAt};
}

export function newWorkspace(title = '未命名论文'): Workspace {
  const now = Date.now(), conversationId = randomUUID();
  return { version: 1, id: randomUUID(), title, authors: '', journal: '', doi: '', tags: [], favorite: false,
    createdAt: now, updatedAt: now, lastReadAt: now, documents: [], notes: '', memories: [], memoryIndex: '',
    conversations: [{ id: conversationId, title: '阅读对话', createdAt: now, messages: [] }], activeConversationId: conversationId,
    layout: { split: false, leftId: '', rightId: '', ratio: 50 } };
}

export function validateWorkspace(value: unknown): asserts value is Workspace {
  const w = value as Workspace;
  if (!w || w.version !== 1 || !validId(w.id) || typeof w.title !== 'string' || !Array.isArray(w.documents)
    || !Array.isArray(w.conversations) || !Array.isArray(w.memories) || !Array.isArray(w.tags)
    || typeof w.notes !== 'string' || typeof w.memoryIndex !== 'string' || !w.layout
    || ![w.authors,w.journal,w.doi].every(x=>typeof x==='string') || !w.tags.every(x=>typeof x==='string')
    || ![w.createdAt,w.updatedAt,w.lastReadAt].every(Number.isFinite)) throw new Error('工作区文件格式无效');
  const validateOutline=(items:OutlineItem[],depth=0):boolean=>depth<=40&&items.every(item=>item&&typeof item.id==='string'&&typeof item.title==='string'&&Number.isInteger(item.page)&&item.page>=1&&Array.isArray(item.children)&&validateOutline(item.children,depth+1));
  const ids = new Set<string>();
  const filenames = new Set<string>();
  for (const doc of w.documents) {
    if (!doc || !validId(doc.id) || ids.has(doc.id.toLowerCase()) || typeof doc.name!=='string' || !['main','supplement'].includes(doc.role)
      || typeof doc.fileName !== 'string' || doc.fileName !== path.basename(doc.fileName)
      || /[\\/:*?"<>|\x00-\x1f]/.test(doc.fileName) || reservedFilename.test(doc.fileName) || filenames.has(doc.fileName.toLowerCase()) || !doc.fileName.toLowerCase().endsWith('.pdf')
      || !Array.isArray(doc.outline) || !validateOutline(doc.outline) || !Array.isArray(doc.annotations) || !doc.view
      || !Number.isInteger(doc.view.page) || doc.view.page<1 || typeof doc.view.scale!=='string' || !Number.isFinite(doc.view.rotation) || doc.view.rotation%90!==0
      || ![0,1,2,3].includes(doc.view.scrollMode) || ![0,1,2].includes(doc.view.spreadMode)
      || !Number.isInteger(doc.pageCount) || doc.pageCount<0 || !Number.isFinite(doc.size) || doc.size<0
      || doc.annotations.some(a=>!a||typeof a.id!=='string'||!Number.isInteger(a.page)||a.page<1||typeof a.text!=='string'||typeof a.comment!=='string'||typeof a.color!=='string'||(a.kind!==undefined&&!['highlight','underline','strikeout'].includes(a.kind))||!Number.isFinite(a.createdAt)||!Array.isArray(a.rects)||a.rects.some(r=>!Array.isArray(r)||r.length!==4||!r.every(Number.isFinite)))) throw new Error('工作区 PDF 记录无效');
    ids.add(doc.id.toLowerCase());filenames.add(doc.fileName.toLowerCase());
  }
  const conversationIds=new Set<string>();
  for(const c of w.conversations){if(!c||typeof c.id!=='string'||!c.id||conversationIds.has(c.id)||typeof c.title!=='string'||!Number.isFinite(c.createdAt)||!Array.isArray(c.messages)||c.messages.some(m=>!m||typeof m.id!=='string'||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||!Number.isFinite(m.createdAt)))throw new Error('对话数据无效');conversationIds.add(c.id);}
  if(!conversationIds.has(w.activeConversationId))throw new Error('当前对话不存在');
  for(const m of w.memories) if(!m||typeof m.id!=='string'||!m.id||!['finding','interpretation','question','user-note','cross-ref'].includes(m.type)||typeof m.title!=='string'||typeof m.body!=='string'||!Array.isArray(m.tags)||!m.tags.every(t=>typeof t==='string')||!['ai','user'].includes(m.source)||!Number.isFinite(m.createdAt))throw new Error('记忆数据无效');
  if(typeof w.layout.split!=='boolean'||typeof w.layout.leftId!=='string'||typeof w.layout.rightId!=='string'||!Number.isFinite(w.layout.ratio))throw new Error('阅读布局无效');
  if(w.layout.direction!==undefined&&!['vertical','horizontal'].includes(w.layout.direction))throw new Error('分割方向无效');
  if(w.layout.views)for(const [pane,value] of Object.entries(w.layout.views)){
    const v=value?.state;
    if(!['left','right'].includes(pane)||!value||!validId(value.documentId)||!v||!Number.isInteger(v.page)||v.page<1||typeof v.scale!=='string'||!Number.isFinite(v.rotation)||v.rotation%90!==0||![0,1,2,3].includes(v.scrollMode)||![0,1,2].includes(v.spreadMode))throw new Error('阅读区域状态无效');
  }
  if(w.summary&&(![w.summary.content,w.summary.provider,w.summary.model].every(x=>typeof x==='string')||!Number.isFinite(w.summary.createdAt)))throw new Error('总结数据无效');
}

async function resolvePdfs(paths: string[], depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const out: string[] = [];
  for(const filename of paths) {
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      const files = (await fs.readdir(filename)).filter(n=>!n.startsWith('.')).sort();
      out.push(...await resolvePdfs(files.map(n=>path.join(filename,n)), depth+1));
    } else if (stat.isFile() && /\.pdf$/i.test(filename)) out.push(filename);
  }
  return out;
}

export class LibraryStore {
  private workspaces = new Map<string, Workspace>();
  private removed = new Map<string, RemovedRecord>();
  private editHistory = new Map<string,EditStack>();
  private historyBytes = 0;
  private writes: Promise<unknown> = Promise.resolve();
  public loadWarnings: string[] = [];
  constructor(public readonly root: string) {}
  async init() {
    this.workspaces.clear();this.removed.clear();this.editHistory.clear();this.historyBytes=0;this.loadWarnings=[];
    await fs.mkdir(this.root, { recursive: true });
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      try {
        const ws = JSON.parse(await fs.readFile(path.join(this.root,entry.name,'workspace.json'), 'utf8'));
        validateWorkspace(ws);
        if(ws.id !== entry.name) throw new Error('工作区 ID 不匹配');
        this.workspaces.set(ws.id,ws);
      } catch (e) { this.loadWarnings.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    try{
      if(await this.trashRoot())for(const entry of await fs.readdir(path.join(this.root,'.trash'),{withFileTypes:true})){
        if(entry.isSymbolicLink()){this.loadWarnings.push(`.trash/${entry.name}: 符号链接未载入，文件已保留`);continue;}
        if(!entry.isDirectory()||!validId(entry.name))continue;
        try{this.removed.set(entry.name,await this.readRemoved(entry.name));}
        catch(error){this.loadWarnings.push(`.trash/${entry.name}: ${error instanceof Error?error.message:String(error)}`);}
      }
    }catch(error){this.loadWarnings.push(`.trash: ${error instanceof Error?error.message:String(error)}`);}
  }
  list() { return clone([...this.workspaces.values()].sort((a,b)=>b.lastReadAt-a.lastReadAt)); }
  listRemoved():RemovedWorkspace[] { return [...this.removed.values()].sort((a,b)=>b.removedAt-a.removedAt).map(removedSummary); }
  getRemoved(id:string):RemovedWorkspace {const record=this.removed.get(id);if(!record)throw new Error('找不到已移除的文章');return removedSummary(record);}
  get(id: string): Workspace { const ws = this.workspaces.get(id); if(!ws) throw new Error('找不到这篇论文'); return clone(ws); }
  directory(id: string) { this.get(id); return path.join(this.root, id); }
  documentPath(id: string, documentId: string) {
    const doc = this.get(id).documents.find(d=>d.id===documentId); if(!doc) throw new Error('找不到此 PDF');
    return path.join(this.directory(id),doc.fileName);
  }
  private queue<T>(fn:()=>Promise<T>): Promise<T> {
    const next = this.writes.then(fn); this.writes = next.catch(()=>{}); return next;
  }
  getDocumentEditHistory(id:string):DocumentEditHistory {
    this.get(id);const history=this.editHistory.get(id);
    return {canUndo:!!history?.undo.length,canRedo:!!history?.redo.length};
  }
  private clearEditHistory(id:string) {
    const history=this.editHistory.get(id);if(!history)return;
    for(const item of [...history.undo,...history.redo])this.historyBytes-=item.bytes;
    this.editHistory.delete(id);
  }
  private forgetDocumentHistory(id:string,documentId:string) {
    const history=this.editHistory.get(id);if(!history)return;
    for(const direction of ['undo','redo'] as const)history[direction]=history[direction].filter(item=>{if(item.documentId!==documentId)return true;this.historyBytes-=item.bytes;return false;});
    if(!history.undo.length&&!history.redo.length)this.editHistory.delete(id);
  }
  private recordDocumentEdit(id:string,documentId:string,before:EditableFields,after:EditableFields) {
    if(!Object.keys(before).length)return;
    const a=JSON.stringify(before),b=JSON.stringify(after),bytes=2*(a.length+b.length)+documentId.length*2;
    if(a===b)return;
    if(bytes>HISTORY_BYTES){this.clearEditHistory(id);return;}
    const history=this.editHistory.get(id)??{undo:[],redo:[]};
    for(const item of history.redo)this.historyBytes-=item.bytes;
    history.redo=[];history.undo.push({documentId,before:a,after:b,bytes});this.historyBytes+=bytes;
    while(history.undo.length>HISTORY_STEPS)this.historyBytes-=history.undo.shift()!.bytes;
    this.editHistory.delete(id);this.editHistory.set(id,history);
    while(this.editHistory.size>HISTORY_ARTICLES)this.clearEditHistory(this.editHistory.keys().next().value!);
    while(this.historyBytes>HISTORY_BYTES){
      const oldest=this.editHistory.keys().next().value!;
      if(this.editHistory.size>1)this.clearEditHistory(oldest);
      else this.historyBytes-=history.undo.shift()!.bytes;
    }
  }
  async undoDocumentEdit(id:string,direction:'undo'|'redo'):Promise<Workspace> {
    return this.queue(async()=>{
      if(direction!=='undo'&&direction!=='redo')throw new Error('无效撤销操作');
      const ws=this.get(id),history=this.editHistory.get(id),entry=history?.[direction].at(-1);
      if(!entry||!history)return ws;
      const doc=ws.documents.find(item=>item.id===entry.documentId);
      const expected=JSON.parse(direction==='undo'?entry.after:entry.before) as EditableFields;
      const replacement=JSON.parse(direction==='undo'?entry.before:entry.after) as EditableFields;
      const keys=Object.keys(expected) as (keyof EditableFields)[];
      const current=doc?Object.fromEntries(keys.map(key=>[key,doc[key]])):undefined;
      if(!doc||!isDeepStrictEqual(JSON.parse(JSON.stringify(current)),expected)){
        this.clearEditHistory(id);throw new Error('批注或目录已从其他来源改变，已清除过期撤销历史，当前内容未修改');
      }
      Object.assign(doc,replacement);ws.updatedAt=Math.max(Date.now(),ws.updatedAt+1);
      await this.persist(ws);
      // A failed write leaves the stacks intact, allowing a safe retry.
      history[direction].pop();history[direction==='undo'?'redo':'undo'].push(entry);
      this.editHistory.delete(id);this.editHistory.set(id,history);return clone(ws);
    });
  }
  private hasStoredId(id:string) {return [...this.workspaces.keys(),...this.removed.keys()].some(key=>key.toLowerCase()===id.toLowerCase());}
  private async trashRoot(create=false):Promise<boolean> {
    const directory=path.join(this.root,'.trash');
    if(create)await fs.mkdir(directory,{recursive:true});
    try{const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('已移除文章目录不是有效的本地文件夹');return true;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  }
  private async readRemoved(id:string):Promise<RemovedRecord> {
    if(!validId(id)||!await this.trashRoot())throw new Error('找不到已移除的文章');
    const directory=path.join(this.root,'.trash',id),stat=await fs.lstat(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('已移除文章不是有效的本地文件夹');
    const workspace=JSON.parse(await fs.readFile(path.join(directory,'workspace.json'),'utf8'));validateWorkspace(workspace);
    if(workspace.id!==id)throw new Error('已移除文章 ID 不匹配');
    const removedAt=validateRemoval(JSON.parse(await fs.readFile(path.join(directory,removalFile),'utf8')));
    return {workspace,removedAt};
  }
  private async storedOnDisk(id:string) {return await exists(path.join(this.root,id))||await exists(path.join(this.root,'.trash',id));}
  private async persist(ws: Workspace) {
    validateWorkspace(ws);
    await atomicWrite(path.join(this.root,ws.id,'workspace.json'),JSON.stringify(ws,null,2));
    this.workspaces.set(ws.id,clone(ws));
  }
  async flush() { await this.writes; }
  async insert(ws: Workspace) { return this.queue(async()=>{ validateWorkspace(ws);if(this.hasStoredId(ws.id)||await this.storedOnDisk(ws.id))throw new Error('工作区已存在（可能位于已移除文章中）');const dir=path.join(this.root,ws.id);await fs.mkdir(dir);try{await this.persist(ws);return clone(ws);}catch(error){await fs.rm(dir,{recursive:true,force:true});throw error;} }); }
  async mutate(id: string, fn: (ws:Workspace)=>void):Promise<Workspace> {
    return this.queue(async()=>{ const ws=this.get(id),previous=ws.updatedAt;fn(ws);if(ws.id!==id)throw new Error('不能修改工作区 ID');ws.updatedAt=Math.max(Date.now(),previous+1);await this.persist(ws);return clone(ws); });
  }
  async patch(id: string, patch: Partial<Workspace>) {
    return this.mutate(id, ws=>{
      for(const key of ['title','authors','journal','doi','notes'] as const) if(typeof patch[key]==='string') ws[key]=patch[key]!;
      if(Array.isArray(patch.tags)) ws.tags=patch.tags.filter(t=>typeof t==='string').slice(0,100);
      if(typeof patch.favorite==='boolean') ws.favorite=patch.favorite;
      if(typeof patch.lastReadAt==='number' && Number.isFinite(patch.lastReadAt)) ws.lastReadAt=patch.lastReadAt;
      if(patch.layout) {const {views: _views,...layout}=patch.layout;ws.layout={...ws.layout,...layout};}
      if(patch.activeConversationId && ws.conversations.some(c=>c.id===patch.activeConversationId)) ws.activeConversationId=patch.activeConversationId;
    });
  }
  async createFromPaths(paths: string[]) {
    const files = await resolvePdfs(paths);
    if(!files.length) throw new Error('未找到 PDF 文件，请选择 PDF 或包含 PDF 的文件夹');
    files.sort((a,b)=>Number(/supp|support|补充/i.test(path.basename(a)))-Number(/supp|support|补充/i.test(path.basename(b))));
    const ws=newWorkspace(path.basename(files[0]).replace(/\.pdf$/i,''));
    await this.insert(ws);
    try { return await this.addDocuments(ws.id,files); }
    catch (e) { await this.queue(async()=>{ this.workspaces.delete(ws.id); await fs.rm(path.join(this.root,ws.id),{recursive:true,force:true}); }); throw e; }
  }
  async addDocuments(id: string, paths: string[]) {
    const files = await resolvePdfs(paths);
    if(!files.length) throw new Error('未找到 PDF 文件');
    return this.queue(async()=>{
      const ws=this.get(id), staged: string[]=[];
      const digests = new Set<string>();
      for(const d of ws.documents) digests.add(createHash('sha256').update(await fs.readFile(this.documentPath(id,d.id))).digest('hex'));
      try {
        for(const filename of files) {
          if((await fs.stat(filename)).size>512*1024*1024) throw new Error(`PDF 大于 512 MB：${path.basename(filename)}`);
          const bytes=await fs.readFile(filename);
          if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new Error(`不是有效的 PDF：${path.basename(filename)}`);
          const digest=createHash('sha256').update(bytes).digest('hex'); if(digests.has(digest)) continue; digests.add(digest);
          const docId=randomUUID(); const name=path.basename(filename);
          const fileName=`${docId.slice(0,8)}-${safeFilename(name.replace(/\.pdf$/i,''))}.pdf`;
          const output=path.join(this.root,id,fileName); await atomicWrite(output,bytes); staged.push(output);
          ws.documents.push({id:docId,name,fileName,role:ws.documents.length?'supplement':'main',size:bytes.length,pageCount:0,outline:[],outlineLoaded:false,annotations:[],view:{...DEFAULT_VIEW}});
        }
        ws.layout.leftId ||= ws.documents[0]?.id ?? ''; ws.layout.rightId ||= ws.documents[1]?.id ?? '';
        if(ws.documents.length>1 && ws.documents.length===staged.length) ws.layout.split=true;
        ws.updatedAt=Math.max(Date.now(),ws.updatedAt+1); await this.persist(ws); return clone(ws);
      } catch(e) { await Promise.all(staged.map(f=>fs.rm(f,{force:true}))); throw e; }
    });
  }
  async patchDocument(id:string, docId:string, patch:Partial<PaperDocument>) {
    const input=clone(patch);
    return this.queue(async()=>{
      const ws=this.get(id);
      const doc=ws.documents.find(d=>d.id===docId); if(!doc) throw new Error('PDF 已不存在');
      const beforeDoc=clone(doc),before:EditableFields={},after:EditableFields={};
      if(typeof input.name==='string') doc.name=input.name;
      if(input.role==='main' || input.role==='supplement') { if(input.role==='main') ws.documents.forEach(d=>{d.role='supplement';}); doc.role=input.role; }
      if(Array.isArray(input.outline)){doc.outline=input.outline;doc.outlineLoaded=true;}
      if(Array.isArray(input.annotations)) doc.annotations=input.annotations;
      if(input.view) doc.view={...doc.view,...input.view};
      for(const key of ['annotations','outline','outlineLoaded'] as const)if(!isDeepStrictEqual(beforeDoc[key],doc[key])){Object.assign(before,{[key]:beforeDoc[key]});Object.assign(after,{[key]:doc[key]});}
      ws.updatedAt=Math.max(Date.now(),ws.updatedAt+1);await this.persist(ws);
      this.recordDocumentEdit(id,docId,before,after);return clone(ws);
    });
  }
  async index(id:string,docId:string,index:DocumentIndex) {
    return this.queue(async()=>{
      const ws=this.get(id),doc=ws.documents.find(d=>d.id===docId);if(!doc)throw new Error('PDF 已不存在');
      if(!Array.isArray(index.pages)||!index.pages.every(p=>typeof p==='string')||!Number.isInteger(index.pageCount)||index.pageCount<0||index.pages.length!==index.pageCount)throw new Error('PDF 文本索引无效');
      doc.pageCount=index.pageCount; doc.textStatus=index.pages.some(p=>p.trim())?'ready':'empty';
      if(!doc.outlineLoaded) {doc.outline=index.outline;doc.outlineLoaded=true;}
      if(doc.role==='main' && !ws.authors && index.authors) ws.authors=index.authors;
      ws.updatedAt=Math.max(Date.now(),ws.updatedAt+1);validateWorkspace(ws);
      await atomicWrite(path.join(this.root,id,'.text',`${docId}.json`),JSON.stringify(index.pages));
      await this.persist(ws);return clone(ws);
    });
  }
  async pages(id:string,docId:string):Promise<string[]> {
    this.documentPath(id,docId);
    try{return JSON.parse(await fs.readFile(path.join(this.root,id,'.text',`${docId}.json`),'utf8'));}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
  }
  async detachDocument(id:string,docId:string) {
    // Keep detached originals under .removed so removing a workspace attachment is reversible.
    return this.queue(async()=>{
      const ws=this.get(id),doc=ws.documents.find(d=>d.id===docId);if(!doc)throw new Error('PDF 不存在');
      ws.documents=ws.documents.filter(d=>d.id!==docId);
      if(!ws.documents.some(d=>d.role==='main') && ws.documents[0])ws.documents[0].role='main';
      if(ws.layout.leftId===docId)ws.layout.leftId=ws.documents[0]?.id??'';
      if(ws.layout.rightId===docId)ws.layout.rightId=ws.documents.find(d=>d.id!==ws.layout.leftId)?.id??'';
      if(!ws.layout.rightId)ws.layout.split=false;
      const source=path.join(this.root,id,doc.fileName),dir=path.join(this.root,id,'.removed');
      await fs.mkdir(dir,{recursive:true});
      await fs.rename(source,path.join(dir,doc.fileName));
      ws.updatedAt=Math.max(Date.now(),ws.updatedAt+1);
      try{await this.persist(ws);}catch(e){await fs.rename(path.join(dir,doc.fileName),source);throw e;}
      this.forgetDocumentHistory(id,docId);
      return clone(ws);
    });
  }
  async forget(id:string) { await this.queue(async()=>{this.workspaces.delete(id);this.clearEditHistory(id);}); }
  async remove(id:string,removeDirectory:(directory:string)=>Promise<void>) {return this.queue(async()=>{const directory=this.directory(id);await removeDirectory(directory);this.workspaces.delete(id);this.clearEditHistory(id);});}
  async moveToTrash(id:string):Promise<RemovedWorkspace> {
    // Move the entire article directory on the same volume, including caches and
    // detached originals. Nothing expires automatically in the application trash.
    return this.queue(async()=>{
      const workspace=this.get(id),source=this.directory(id);await this.trashRoot(true);
      const destination=path.join(this.root,'.trash',id);
      if(this.removed.has(id)||await exists(destination))throw new Error('已移除文章中已有相同 ID，未移动任何文件');
      const stat=await fs.lstat(source);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('文章目录无效');
      const record={workspace,removedAt:Math.max(Date.now(),workspace.updatedAt+1)};
      await atomicWrite(path.join(source,removalFile),JSON.stringify({version:1,removedAt:record.removedAt}));
      try{await fs.rename(source,destination);}
      catch(error){await fs.rm(path.join(source,removalFile),{force:true}).catch(()=>{});throw error;}
      this.workspaces.delete(id);this.removed.set(id,clone(record));this.clearEditHistory(id);return removedSummary(record);
    });
  }
  async restoreRemoved(id:string):Promise<Workspace> {
    return this.queue(async()=>{
      this.getRemoved(id);
      const record=await this.readRemoved(id),ws=record.workspace;
      const destination=path.join(this.root,id),source=path.join(this.root,'.trash',id);
      if(this.workspaces.has(id)||await exists(destination))throw new Error('论文库中已有相同 ID 的文件夹，无法覆盖恢复');
      ws.updatedAt=Math.max(Date.now(),ws.updatedAt+1,record.removedAt+1);
      await fs.rename(source,destination);
      try{await this.persist(ws);}
      catch(error){await fs.rename(destination,source);throw error;}
      this.removed.delete(id);
      this.clearEditHistory(id);
      await fs.rm(path.join(destination,removalFile),{force:true}).catch(()=>{});
      return clone(ws);
    });
  }
  async purgeRemoved(id:string,expectedRemovedAt?:number):Promise<void> {
    return this.queue(async()=>{
      const removed=this.getRemoved(id);
      if(expectedRemovedAt!==undefined&&expectedRemovedAt!==removed.removedAt)throw new Error('文章状态已改变，请重新确认彻底删除');
      const disk=await this.readRemoved(id);
      if(disk.removedAt!==removed.removedAt)throw new Error('已移除文章记录已改变，未删除文件');
      await fs.rm(path.join(this.root,'.trash',id),{recursive:true});
      this.removed.delete(id);
    });
  }
  async archive():Promise<Uint8Array> {
    return this.queue(async()=>{
      const zip=new JSZip(),workspaces=this.list(),removed=[...this.removed.values()];
      // Do not silently omit a damaged removed article from a "complete" backup.
      if(await this.trashRoot())for(const entry of await fs.readdir(path.join(this.root,'.trash'),{withFileTypes:true})){
        if(entry.isSymbolicLink()||(entry.isDirectory()&&!this.removed.has(entry.name)))throw new Error(`已移除文章 ${entry.name} 无法读取，请先保留其文件并修复，再备份完整论文库`);
      }
      zip.file('folio-backup.json',JSON.stringify({format:'folio',version:1,createdAt:Date.now(),workspaces:workspaces.map(w=>w.id),removedWorkspaces:removed.map(r=>r.workspace.id)},null,2));
      const records=[...workspaces.map(workspace=>({workspace,prefix:workspace.id,removedAt:undefined as number|undefined})),...removed.map(r=>({...r,prefix:`.trash/${r.workspace.id}`}))];
      for(const {workspace:ws,prefix,removedAt} of records){
        const directory=path.join(this.root,prefix);
        zip.file(`${prefix}/workspace.json`,JSON.stringify(ws,null,2));
        if(removedAt!==undefined)zip.file(`${prefix}/${removalFile}`,JSON.stringify({version:1,removedAt}));
        for(const doc of ws.documents){
          zip.file(`${prefix}/${doc.fileName}`,await fs.readFile(path.join(directory,doc.fileName)));
        }
        // Detached originals and their text caches are retained in both states.
        for(const folder of ['.removed','.text']){
          const child=path.join(directory,folder);if(!await exists(child))continue;
          const stat=await fs.lstat(child);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`备份目录无效：${prefix}/${folder}`);
          for(const entry of await fs.readdir(child,{withFileTypes:true})){
            if(!entry.isFile())continue;
            if(folder==='.text'?!/^[a-zA-Z0-9-]{1,80}\.json$/.test(entry.name):!portablePdfName(entry.name))continue;
            zip.file(`${prefix}/${folder}/${entry.name}`,await fs.readFile(path.join(child,entry.name)));
          }
        }
      }
      return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:4}});
    });
  }
  async restore(data:Uint8Array):Promise<number> {
    const zip=await JSZip.loadAsync(data,{checkCRC32:true});
    const manifest=JSON.parse(await zip.file('folio-backup.json')?.async('string')??'null');
    if(manifest?.format!=='folio'||manifest.version!==1||!Array.isArray(manifest.workspaces)||(manifest.removedWorkspaces!==undefined&&!Array.isArray(manifest.removedWorkspaces)))throw new Error('不是 Folio 备份文件');
    const incoming: {ws:Workspace;files:Map<string,Uint8Array>;removedAt?:number}[]=[],seen=new Set<string>();
    const records=[...manifest.workspaces.map((id:unknown)=>({id,removed:false})),...(manifest.removedWorkspaces??[]).map((id:unknown)=>({id,removed:true}))];
    for(const {id,removed} of records){
      if(typeof id!=='string'||!validId(id)||seen.has(id.toLowerCase()))throw new Error('备份包含无效或重复路径');seen.add(id.toLowerCase());
      if(this.hasStoredId(id))continue;
      const prefix=removed?`.trash/${id}`:id;
      const ws=JSON.parse(await zip.file(`${prefix}/workspace.json`)?.async('string')??'null');validateWorkspace(ws);
      if(ws.id!==id)throw new Error('备份工作区 ID 不一致');
      const removedAt=removed?validateRemoval(JSON.parse(await zip.file(`${prefix}/${removalFile}`)?.async('string')??'null')):undefined;
      const files=new Map<string,Uint8Array>();
      for(const doc of ws.documents){
        const file=zip.file(`${prefix}/${doc.fileName}`);if(!file)throw new Error(`备份缺少 PDF：${doc.name}`);
        const bytes=await file.async('uint8array');if(!Buffer.from(bytes.subarray(0,1024)).includes(Buffer.from('%PDF-')))throw new Error('备份 PDF 内容无效');
        files.set(doc.fileName,bytes);
      }
      for(const [name,file] of Object.entries(zip.files)){
        if(file.dir)continue;
        if(name.startsWith(`${prefix}/.removed/`)){
          const relative=name.slice(`${prefix}/.removed/`.length);if(!portablePdfName(relative))throw new Error('备份中已移除 PDF 路径无效');
          const bytes=await file.async('uint8array');if(!Buffer.from(bytes.subarray(0,1024)).includes(Buffer.from('%PDF-')))throw new Error('备份中已移除 PDF 内容无效');
          files.set(`.removed/${relative}`,bytes);
        }else if(name.startsWith(`${prefix}/.text/`)){
          const relative=name.slice(`${prefix}/.text/`.length);if(!/^[a-zA-Z0-9-]{1,80}\.json$/.test(relative))throw new Error('备份文本索引路径无效');
          const pages=JSON.parse(await file.async('string'));if(!Array.isArray(pages)||!pages.every(x=>typeof x==='string'))throw new Error('备份文本索引无效');
          files.set(`.text/${relative}`,Buffer.from(JSON.stringify(pages)));
        }
      }
      incoming.push({ws,files,removedAt});
    }
    return this.queue(async()=>{
      const added:{id:string;directory:string}[]=[];
      try{
        for(const {ws,files,removedAt} of incoming){
          // Local state wins, including articles currently in application trash.
          if(this.hasStoredId(ws.id)||await this.storedOnDisk(ws.id))continue;
          if(removedAt!==undefined)await this.trashRoot(true);
          const dir=removedAt===undefined?path.join(this.root,ws.id):path.join(this.root,'.trash',ws.id);
          // Never replace even an unreadable, pre-existing workspace folder.
          try{await fs.mkdir(dir);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')continue;throw e;}
          added.push({id:ws.id,directory:dir});
          for(const [name,data]of files)await atomicWrite(path.join(dir,name),data);
          if(removedAt===undefined)await this.persist(ws);
          else{
            await atomicWrite(path.join(dir,'workspace.json'),JSON.stringify(ws,null,2));
            await atomicWrite(path.join(dir,removalFile),JSON.stringify({version:1,removedAt}));
            this.removed.set(ws.id,{workspace:clone(ws),removedAt});
          }
        }
        return added.length;
      }catch(error){
        for(const {id,directory} of added){this.workspaces.delete(id);this.removed.delete(id);await fs.rm(directory,{recursive:true,force:true});}
        throw error;
      }
    });
  }
  async importLegacy(raw:unknown) {
    const data=raw as Record<string,unknown>;const body=(data?.data??data) as Record<string,unknown>;
    if(!Array.isArray(body?.articles))throw new Error('找不到旧插件备份中的 articles');
    const rows=(key:string):Record<string,any>[]=>Array.isArray(body[key])?(body[key] as Record<string,any>[]).filter(row=>row&&typeof row==='object'):[];
    const stableId=(identity:string)=>`legacy-${createHash('sha256').update(identity).digest('hex').slice(0,40)}`;
    const normalizedDoi=(doi:string)=>doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').toLowerCase();
    const now=Date.now();
    const memories=(items:Record<string,any>[])=>items.map(m=>({id:stableId(`memory:${m.id??JSON.stringify(m)}`),type:m.type,title:m.title,body:m.body,tags:m.tags??[],createdAt:Number.isFinite(m.createdAt)?m.createdAt:now,source:m.source==='user'?'user' as const:'ai' as const}));
    const incoming:Workspace[]=[];
    for(const article of rows('articles')){
      if(typeof article.title!=='string')throw new Error('旧插件文章标题无效，未导入任何文章');
      const ws=newWorkspace(article.title);
      const identity=typeof article.id==='string'&&article.id?article.id:typeof article.url==='string'&&article.url?article.url:JSON.stringify([article.title,article.authors,article.firstReadAt]);
      ws.id=stableId(`article:${identity}`);
      ws.doi=article.doi??'';ws.authors=Array.isArray(article.authors)?article.authors.filter((a:unknown)=>typeof a==='string').join(', '):'';ws.journal=article.journal??'';
      ws.tags=Array.isArray(article.tags)?article.tags.filter((t:unknown)=>typeof t==='string'):[];ws.favorite=!!article.favorite;ws.notes=article.userNotes??'';ws.memoryIndex=article.memoryIndex??'';
      ws.createdAt=article.firstReadAt??now;ws.lastReadAt=article.lastReadAt??now;
      const summaries=rows('summaries').filter(s=>s.articleId===article.id).sort((a,b)=>b.createdAt-a.createdAt);
      if(summaries[0]){const summary=summaries[0];ws.summary={content:summary.content,provider:summary.provider,model:summary.model,createdAt:summary.createdAt};}
      ws.memories=memories(rows('memories').filter(m=>m.articleId===article.id));
      const conversations=rows('conversations').filter(c=>c.articleId===article.id);
      if(conversations.length){
        ws.conversations=conversations.map(c=>({id:randomUUID(),title:c.title??'导入的对话',createdAt:c.createdAt??now,messages:rows('messages').filter(m=>m.conversationId===c.id&&['user','assistant'].includes(m.role)).sort((a,b)=>a.createdAt-b.createdAt).map(m=>({id:randomUUID(),role:m.role,content:m.content,createdAt:m.createdAt??now}))}));
        ws.activeConversationId=ws.conversations[0].id;
      }
      validateWorkspace(ws);incoming.push(ws);
    }
    // Old cross-reference rows deliberately had no articleId. Preserve them in an
    // explicit collection rather than dropping them or inventing an article source.
    const globalMemories=rows('memories').filter(m=>m.articleId==null);
    if(globalMemories.length){
      const ws=newWorkspace('旧插件跨论文记忆（来源未记录）');ws.id=stableId('global-memory-collection');
      ws.notes='这些跨论文记忆由旧插件保存为全局数据，备份未记录具体来源文章。引用前请核实原始论文。';
      ws.memories=memories(globalMemories);ws.tags=[...new Set(ws.memories.flatMap(m=>m.tags))];
      ws.memoryIndex=ws.memories.slice(0,12).map(m=>`- [${m.type}] ${m.title}`).join('\n');
      validateWorkspace(ws);incoming.push(ws);
    }
    return this.queue(async()=>{
      const added:string[]=[];
      try{
        for(const ws of incoming){
          if(this.hasStoredId(ws.id)||await this.storedOnDisk(ws.id)||(ws.doi&&[...this.workspaces.values(),...[...this.removed.values()].map(r=>r.workspace)].some(w=>normalizedDoi(w.doi)===normalizedDoi(ws.doi))))continue;
          const directory=path.join(this.root,ws.id);
          try{await fs.mkdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')continue;throw error;}
          added.push(ws.id);await this.persist(ws);
        }
        return added.length;
      }catch(error){
        for(const id of added){this.workspaces.delete(id);await fs.rm(path.join(this.root,id),{recursive:true,force:true});}
        throw error;
      }
    });
  }
}
