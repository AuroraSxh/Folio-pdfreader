import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { LibraryStore, newWorkspace } from '../electron/store';

async function environment(t:{after(fn:()=>Promise<void>):void}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'folio-store-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'library'),sources=path.join(directory,'sources');await mkdir(sources);
  const store=new LibraryStore(root);await store.init();return {directory,root,sources,store};
}
async function pdf(filename:string,text='Main paper') {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);pdf.addPage([300,400]).drawText(text,{font,x:30,y:330,size:14});
  const bytes=await pdf.save();await writeFile(filename,bytes);return bytes;
}

test('folder import groups main and supplement, deduplicates bytes and persists snapshots across reload',async t=>{
  const {root,sources,store}=await environment(t);
  const bytes=await pdf(path.join(sources,'Main.pdf'));await writeFile(path.join(sources,'Same-main.pdf'),bytes);await pdf(path.join(sources,'Supplement.pdf'),'Supplement evidence');
  const ws=await store.createFromPaths([sources]);assert.equal(ws.documents.length,2);assert.equal(ws.documents[0].role,'main');assert.equal(ws.documents[1].role,'supplement');assert.equal(ws.layout.split,true);
  ws.notes='snapshot must not mutate storage';assert.equal(store.get(ws.id).notes,'');
  const changed=await store.patch(ws.id,{notes:'Saved notes',title:'Updated paper'});assert.ok(changed.updatedAt>ws.updatedAt);
  const patched=await Promise.all([store.patch(ws.id,{notes:'Latest notes'}),store.patch(ws.id,{favorite:true})]);assert.ok(patched[1].updatedAt>patched[0].updatedAt);
  const loaded=new LibraryStore(root);await loaded.init();const saved=loaded.get(ws.id);assert.equal(saved.notes,'Latest notes');assert.equal(saved.favorite,true);
  assert.deepEqual(await readFile(loaded.documentPath(ws.id,ws.documents[0].id)),Buffer.from(bytes));
  assert.ok(!(await readdir(path.join(root,ws.id))).some(name=>name.endsWith('.tmp')));
});

test('failed attachment batches and failed new-workspace imports leave no partial PDFs or metadata',async t=>{
  const {root,sources,store}=await environment(t);
  const main=path.join(sources,'Main.pdf');await pdf(main);const ws=await store.createFromPaths([main]);
  const valid=path.join(sources,'Another.pdf');await pdf(valid,'Another document');const invalid=path.join(sources,'Corrupted.pdf');await writeFile(invalid,'This is not a PDF');
  const before=await readdir(path.join(root,ws.id));
  await assert.rejects(()=>store.addDocuments(ws.id,[valid,invalid]),/有效的 PDF/);
  assert.deepEqual(await readdir(path.join(root,ws.id)),before);assert.equal(store.get(ws.id).documents.length,1);
  await assert.rejects(()=>store.createFromPaths([valid,invalid]),/有效的 PDF/);assert.equal(store.list().length,1);assert.deepEqual(await readdir(root),[ws.id]);
});

test('failed metadata write leaves disk and in-memory workspace unchanged, queue remains usable',async t=>{
  const {root,store}=await environment(t);const ws=newWorkspace('Original');await store.insert(ws);
  const file=path.join(root,ws.id,'workspace.json'),saved=path.join(root,ws.id,'workspace.saved.json');await rename(file,saved);await mkdir(file);
  await assert.rejects(()=>store.patch(ws.id,{title:'Must not commit'}));assert.equal(store.get(ws.id).title,'Original');
  await rm(file,{recursive:true});await rename(saved,file);await store.patch(ws.id,{title:'Recovered'});
  const reload=new LibraryStore(root);await reload.init();assert.equal(reload.get(ws.id).title,'Recovered');
});

test('backup round-trip retains documents, index, notes; restores never overwrite existing article or unreadable folder',async t=>{
  const {directory,sources,store}=await environment(t);const filename=path.join(sources,'Main.pdf');await pdf(filename);
  const ws=await store.createFromPaths([filename]);await store.patch(ws.id,{notes:'Backup note'});
  await store.index(ws.id,ws.documents[0].id,{pageCount:1,outline:[{id:'o',title:'方法',page:1,children:[]}],pages:['Extracted evidence']});
  const backup=await store.archive(),restored=new LibraryStore(path.join(directory,'restored'));await restored.init();assert.equal(await restored.restore(backup),1);
  assert.equal(restored.get(ws.id).notes,'Backup note');assert.deepEqual(await restored.pages(ws.id,ws.documents[0].id),['Extracted evidence']);
  assert.deepEqual(await readFile(restored.documentPath(ws.id,ws.documents[0].id)),await readFile(filename));
  await restored.patch(ws.id,{notes:'Local changes'});assert.equal(await restored.restore(backup),0);assert.equal(restored.get(ws.id).notes,'Local changes');
  const blocked=new LibraryStore(path.join(directory,'blocked'));await blocked.init();await mkdir(path.join(blocked.root,ws.id));await writeFile(path.join(blocked.root,ws.id,'workspace.json'),'broken file');
  assert.equal(await blocked.restore(backup),0);assert.equal(await readFile(path.join(blocked.root,ws.id,'workspace.json'),'utf8'),'broken file');
});

test('malicious backup PDF paths or malformed metadata are rejected before any archive writes',async t=>{
  const {directory,sources,store}=await environment(t);const filename=path.join(sources,'Main.pdf');await pdf(filename);const ws=await store.createFromPaths([filename]);
  const original=await store.archive();
  for(const corrupt of [(w:any)=>{w.documents[0].fileName='../escaped.pdf';},(w:any)=>{w.documents[0].id='../escaped';},(w:any)=>{w.documents[0].fileName='file:stream.pdf';},(w:any)=>{w.documents[0].fileName='CON.pdf';},(w:any)=>{w.documents.push({...w.documents[0],id:'other-document',fileName:w.documents[0].fileName.toUpperCase()});},(w:any)=>{w.authors={bad:true};},(w:any)=>{w.memories=[{id:'m',title:'x',body:'x',tags:[{}]}];}]){
    const zip=await JSZip.loadAsync(original);const altered=JSON.parse(await zip.file(`${ws.id}/workspace.json`)!.async('string'));corrupt(altered);zip.file(`${ws.id}/workspace.json`,JSON.stringify(altered));
    const target=new LibraryStore(path.join(directory,`target-${Math.random()}`));await target.init();const bytes=await zip.generateAsync({type:'uint8array'});
    await assert.rejects(()=>target.restore(bytes));assert.deepEqual(await readdir(target.root),[]);
  }
});

test('queued workspace removal prevents late index writes from resurrecting its folder and failed trash preserves article',async t=>{
  const {root,sources,store}=await environment(t);const filename=path.join(sources,'Main.pdf');await pdf(filename);const ws=await store.createFromPaths([filename]);
  await assert.rejects(()=>store.remove(ws.id,async()=>{throw new Error('trash unavailable');}),/trash unavailable/);assert.equal(store.get(ws.id).id,ws.id);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const removal=store.remove(ws.id,async dir=>{await gate;await rm(dir,{recursive:true});});
  const lateIndex=store.index(ws.id,ws.documents[0].id,{pageCount:1,outline:[],pages:['Late index']});release();
  await removal;await assert.rejects(lateIndex,/找不到/);assert.deepEqual(await readdir(root),[]);assert.equal(store.list().length,0);
});

test('legacy import remaps conversations, preserves global memory provenance and skips DOI-less reimports',async t=>{
  const {store}=await environment(t);
  const backup={version:1,articles:[{id:'url:https://example.org/paper',url:'https://example.org/paper',title:'Imported paper',authors:['A'],firstReadAt:1,lastReadAt:2,tags:['immunity'],userNotes:'Legacy notes'}],
    conversations:[{id:7,articleId:'url:https://example.org/paper',title:'Legacy chat',createdAt:1}],messages:[{id:1,conversationId:7,role:'system',content:'Hidden system',createdAt:1},{id:2,conversationId:7,role:'user',content:'My question',createdAt:2},{id:3,conversationId:7,role:'assistant',content:'Answer',createdAt:3}],
    memories:[{id:'global',type:'cross-ref',title:'Related finding',body:'Source unspecified',tags:['immunity'],source:'ai',createdAt:1}]};
  assert.equal(await store.importLegacy(backup),2);assert.equal(await store.importLegacy(backup),0);
  const article=store.list().find(w=>w.title==='Imported paper')!;assert.equal(article.notes,'Legacy notes');assert.equal(article.conversations[0].messages.length,2);assert.equal(article.conversations[0].messages[0].content,'My question');
  const globals=store.list().find(w=>w.memories.length)!;assert.match(globals.title,/来源未记录/);assert.equal(globals.memories[0].title,'Related finding');
  await store.moveToTrash(article.id);assert.equal(await store.importLegacy(backup),0);assert.equal(store.listRemoved()[0].id,article.id);
});

test('legacy import validates the entire batch before persisting any articles',async t=>{
  const {store,root}=await environment(t);
  await assert.rejects(()=>store.importLegacy({articles:[{id:'valid',title:'Valid paper',firstReadAt:1,lastReadAt:2},{id:'invalid',title:'Invalid paper',userNotes:{malformed:true},firstReadAt:1,lastReadAt:2}]}),/格式无效/);
  assert.equal(store.list().length,0);assert.deepEqual(await readdir(root),[]);
});

test('soft removal preserves all article data across reload and restore, including detached originals and late notes',async t=>{
  const {root,sources,store}=await environment(t),main=path.join(sources,'Main.pdf'),supplement=path.join(sources,'Supplement.pdf');
  const mainBytes=await pdf(main),extraBytes=await pdf(supplement,'Additional evidence');
  const ws=await store.createFromPaths([main,supplement]),[doc,extra]=ws.documents;
  await store.index(ws.id,doc.id,{pageCount:1,outline:[],pages:['Indexed body']});
  await store.index(ws.id,extra.id,{pageCount:1,outline:[],pages:['Indexed supplement']});
  await store.detachDocument(ws.id,extra.id);
  await store.mutate(ws.id,w=>{
    w.authors='Author A';w.tags=['immunity'];w.documents[0].annotations=[{id:'mark',page:1,text:'evidence',comment:'verify',color:'#ffff00',rects:[[1,2,3,4]],createdAt:1}];
    w.conversations[0].messages.push({id:'answer',role:'assistant',content:'Saved answer',createdAt:2});
    w.memories.push({id:'memory',type:'finding',title:'Finding',body:'Evidence',tags:[],source:'ai',createdAt:3});
  });
  const pendingNotes=store.patch(ws.id,{notes:'Last unsaved note'}),removal=store.moveToTrash(ws.id);
  const lateIndex=store.index(ws.id,doc.id,{pageCount:1,outline:[],pages:['Too late']});
  await pendingNotes;const removed=await removal;await assert.rejects(lateIndex,/找不到/);
  assert.deepEqual(store.list(),[]);assert.equal(removed.documentCount,1);assert.equal(removed.authors,'Author A');assert.deepEqual(removed.tags,['immunity']);
  const trash=path.join(root,'.trash',ws.id);assert.deepEqual(await readFile(path.join(trash,doc.fileName)),Buffer.from(mainBytes));assert.deepEqual(await readFile(path.join(trash,'.removed',extra.fileName)),Buffer.from(extraBytes));
  const oldRemoval=1;await writeFile(path.join(trash,'.removal.json'),JSON.stringify({version:1,removedAt:oldRemoval}));
  const reload=new LibraryStore(root);await reload.init();assert.equal(reload.listRemoved()[0].removedAt,oldRemoval,'old trash must never auto-expire');
  const restored=await reload.restoreRemoved(ws.id);assert.equal(restored.notes,'Last unsaved note');assert.equal(restored.conversations[0].messages[0].content,'Saved answer');assert.equal(restored.memories[0].body,'Evidence');assert.equal(restored.documents[0].annotations[0].comment,'verify');
  assert.deepEqual(await reload.pages(ws.id,doc.id),['Indexed body']);assert.deepEqual(await readFile(path.join(root,ws.id,'.removed',extra.fileName)),Buffer.from(extraBytes));assert.deepEqual(reload.listRemoved(),[]);
  const secondReload=new LibraryStore(root);await secondReload.init();assert.equal(secondReload.list().length,1);assert.equal(secondReload.listRemoved().length,0);
});

test('removal and restore never overwrite an existing destination or resurrect an id during import',async t=>{
  const {root,store}=await environment(t),ws=newWorkspace('Keep my files');await store.insert(ws);
  const trash=path.join(root,'.trash',ws.id);await mkdir(trash,{recursive:true});await writeFile(path.join(trash,'keep.txt'),'unknown original');
  await assert.rejects(()=>store.moveToTrash(ws.id),/相同 ID/);assert.equal(store.get(ws.id).title,ws.title);assert.equal(await readFile(path.join(trash,'keep.txt'),'utf8'),'unknown original');
  await rm(trash,{recursive:true});await store.moveToTrash(ws.id);
  await assert.rejects(()=>store.insert(ws),/已存在/);
  const destination=path.join(root,ws.id);await mkdir(destination);await writeFile(path.join(destination,'keep.txt'),'local files');
  await assert.rejects(()=>store.restoreRemoved(ws.id),/无法覆盖/);assert.equal(store.listRemoved().length,1);assert.equal(await readFile(path.join(destination,'keep.txt'),'utf8'),'local files');
  assert.equal(JSON.parse(await readFile(path.join(trash,'workspace.json'),'utf8')).title,ws.title);
});

test('permanent deletion is limited to removed articles and rejects stale confirmation',async t=>{
  const {root,store}=await environment(t),ws=newWorkspace('Removed'),active=newWorkspace('Active');await store.insert(ws);await store.insert(active);
  const first=await store.moveToTrash(ws.id);await store.restoreRemoved(ws.id);const second=await store.moveToTrash(ws.id);assert.ok(second.removedAt>first.removedAt);
  await assert.rejects(()=>store.purgeRemoved(ws.id,first.removedAt),/重新确认/);assert.equal(store.listRemoved().length,1);
  await assert.rejects(()=>store.purgeRemoved(active.id),/找不到已移除/);await assert.rejects(()=>store.purgeRemoved('../escape'),/找不到已移除/);
  await store.purgeRemoved(ws.id,second.removedAt);assert.deepEqual(store.listRemoved(),[]);assert.deepEqual(await readdir(path.join(root,'.trash')),[]);assert.equal(store.get(active.id).title,'Active');
  const reload=new LibraryStore(root);await reload.init();assert.deepEqual(reload.list().map(w=>w.id),[active.id]);assert.deepEqual(reload.listRemoved(),[]);
});

test('damaged removed records are retained and warned about, and symlinked trash cannot move or purge outside files',async t=>{
  const {root,directory,store}=await environment(t),ws=newWorkspace('Damaged');await store.insert(ws);await store.moveToTrash(ws.id);
  const file=path.join(root,'.trash',ws.id,'workspace.json');await writeFile(file,'broken but valuable');
  await assert.rejects(()=>store.restoreRemoved(ws.id));await assert.rejects(()=>store.purgeRemoved(ws.id));
  const reload=new LibraryStore(root);await reload.init();assert.equal(reload.listRemoved().length,0);assert.ok(reload.loadWarnings.some(w=>w.includes(`.trash/${ws.id}`)));assert.equal(await readFile(file,'utf8'),'broken but valuable');
  await assert.rejects(()=>reload.archive(),/无法读取/);
  const outside=path.join(directory,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep.txt'),'external');
  const other=new LibraryStore(path.join(directory,'other'));await other.init();const active=newWorkspace('Never move');await other.insert(active);
  await symlink(outside,path.join(other.root,'.trash'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>other.moveToTrash(active.id),/本地文件夹/);assert.equal(other.get(active.id).title,'Never move');assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'),'external');
});

test('complete backups retain removed status, detached PDFs and text caches; merge preserves local removed status',async t=>{
  const {directory,sources,store}=await environment(t),filename=path.join(sources,'Paper.pdf'),supplement=path.join(sources,'Extra.pdf');await pdf(filename);const extraBytes=await pdf(supplement,'Detached evidence');
  const ws=await store.createFromPaths([filename,supplement]),extra=ws.documents[1];await store.patch(ws.id,{notes:'Removed note'});
  await store.index(ws.id,extra.id,{pageCount:1,outline:[],pages:['Detached text']});await store.detachDocument(ws.id,extra.id);
  const olderActiveBackup=await store.archive(),removed=await store.moveToTrash(ws.id);
  const active=newWorkspace('Still active');await store.insert(active);
  assert.equal(await store.restore(olderActiveBackup),0);assert.equal(store.listRemoved()[0].id,ws.id,'an older backup must not resurrect a locally removed article');
  const backup=await store.archive(),restored=new LibraryStore(path.join(directory,'restored-trash'));await restored.init();assert.equal(await restored.restore(backup),2);
  assert.deepEqual(restored.list().map(w=>w.id),[active.id]);assert.deepEqual(restored.listRemoved(),[removed]);
  const restoredTrash=path.join(restored.root,'.trash',ws.id);assert.deepEqual(await readFile(path.join(restoredTrash,'.removed',extra.fileName)),Buffer.from(extraBytes));assert.deepEqual(JSON.parse(await readFile(path.join(restoredTrash,'.text',`${extra.id}.json`),'utf8')),['Detached text']);
  assert.equal((await restored.restoreRemoved(ws.id)).notes,'Removed note');assert.equal(await restored.restore(backup),0);assert.equal(restored.listRemoved().length,0,'a backup must not remove a locally restored article');
});

test('removed backup metadata and nested paths validate before any restore writes; old manifest remains supported',async t=>{
  const {directory,store}=await environment(t),ws=newWorkspace('Valid');await store.insert(ws);const old=await JSZip.loadAsync(await store.archive());
  old.file('folio-backup.json',JSON.stringify({format:'folio',version:1,workspaces:[ws.id]}));
  const oldTarget=new LibraryStore(path.join(directory,'old'));await oldTarget.init();assert.equal(await oldTarget.restore(await old.generateAsync({type:'uint8array'})),1);
  await store.moveToTrash(ws.id);const original=await store.archive();
  for(const change of [(z:JSZip)=>z.file(`.trash/${ws.id}/.removal.json`,JSON.stringify({version:1,removedAt:'yesterday'})),(z:JSZip)=>z.file(`.trash/${ws.id}/.removed/nested/file.pdf`,'%PDF-1.7'),(z:JSZip)=>z.file('folio-backup.json',JSON.stringify({format:'folio',version:1,workspaces:[ws.id],removedWorkspaces:[ws.id]}))]){
    const zip=await JSZip.loadAsync(original);change(zip);const target=new LibraryStore(path.join(directory,`invalid-${Math.random()}`));await target.init();
    const bytes=await zip.generateAsync({type:'uint8array'});await assert.rejects(()=>target.restore(bytes));assert.deepEqual(await readdir(target.root),[]);
  }
});
