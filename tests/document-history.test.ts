import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { LibraryStore } from '../electron/store';
import { DEFAULT_VIEW, type Annotation } from '../shared/types';

async function fixture(t:{after(fn:()=>Promise<void>):void}) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'folio-history-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const files:string[]=[];
  for(const name of ['Main','Supplement']){const pdf=await PDFDocument.create();pdf.addPage().drawText(name);pdf.addPage();const file=path.join(directory,`${name}.pdf`);await writeFile(file,await pdf.save());files.push(file);}
  const store=new LibraryStore(path.join(directory,'library'));await store.init();const workspace=await store.createFromPaths(files);
  return {directory,store,workspace,main:workspace.documents[0].id,supplement:workspace.documents[1].id};
}
const annotation=(id:string,kind?:Annotation['kind']):Annotation=>({id,...(kind?{kind}:{}),page:1,text:`Evidence ${id}`,comment:'',color:'#e2b63f',rects:[[10,20,100,35]],createdAt:1});
const states=(store:LibraryStore,id:string)=>store.getDocumentEditHistory(id);

test('workspace undo crosses PDFs and restores only edited fields, preserving notes, chat and reading positions on disk',async t=>{
  const {store,workspace:ws,main,supplement}=await fixture(t);
  for(const id of [main,supplement])await store.index(ws.id,id,{pageCount:2,outline:[{id:'original',title:'Original outline',page:1,children:[]}],pages:['page 1','page 2']});
  assert.deepEqual(states(store,ws.id),{canUndo:false,canRedo:false});
  await store.patchDocument(ws.id,main,{annotations:[annotation('main')]});
  await store.patchDocument(ws.id,supplement,{annotations:[annotation('supplement','underline')]});
  await store.patchDocument(ws.id,main,{outline:[{id:'edited',title:'编辑目录',page:2,children:[]}]});
  const view={...DEFAULT_VIEW,page:2,scale:'1.25',rotation:90};
  await store.patchDocument(ws.id,main,{view,name:'Renamed main.pdf'});
  await store.mutate(ws.id,w=>{w.notes='Independent note';w.conversations[0].messages.push({id:'chat',role:'assistant',content:'Saved answer',createdAt:1});w.layout.views={left:{documentId:main,state:view}};});
  let result=await store.undoDocumentEdit(ws.id,'undo');assert.equal(result.documents[0].outline[0].title,'Original outline');assert.equal(result.documents[1].annotations.length,1);
  result=await store.undoDocumentEdit(ws.id,'undo');assert.equal(result.documents[1].annotations.length,0);assert.equal(result.documents[0].annotations.length,1);
  result=await store.undoDocumentEdit(ws.id,'undo');assert.equal(result.documents[0].annotations.length,0);assert.deepEqual(states(store,ws.id),{canUndo:false,canRedo:true});
  for(let i=0;i<3;i++)result=await store.undoDocumentEdit(ws.id,'redo');
  assert.equal(result.documents[0].outline[0].title,'编辑目录');assert.equal(result.documents[1].annotations[0].kind,'underline');assert.equal(result.documents[0].annotations[0].id,'main');
  assert.equal(result.notes,'Independent note');assert.equal(result.conversations[0].messages[0].content,'Saved answer');assert.deepEqual(result.documents[0].view,view);assert.deepEqual(result.layout.views?.left?.state,view);assert.equal(result.documents[0].name,'Renamed main.pdf');
  const reload=new LibraryStore(store.root);await reload.init();assert.deepEqual(reload.get(ws.id),result);assert.deepEqual(states(reload,ws.id),{canUndo:false,canRedo:false});
});

test('annotation edits and deletion undo correctly; no-op patches preserve redo, a new edit creates a branch',async t=>{
  const {store,workspace:ws,main}=await fixture(t),original=annotation('a','underline'),edited={...original,comment:'Checked detail',kind:'strikeout' as const,color:'#dd3355'};
  await store.patchDocument(ws.id,main,{annotations:[original]});await store.patchDocument(ws.id,main,{annotations:[edited]});await store.patchDocument(ws.id,main,{annotations:[]});
  assert.deepEqual((await store.undoDocumentEdit(ws.id,'undo')).documents[0].annotations,[edited]);assert.deepEqual((await store.undoDocumentEdit(ws.id,'undo')).documents[0].annotations,[original]);
  await store.patchDocument(ws.id,main,{annotations:[original],view:{...DEFAULT_VIEW,page:2}});assert.equal(states(store,ws.id).canRedo,true);
  assert.deepEqual((await store.undoDocumentEdit(ws.id,'redo')).documents[0].annotations,[edited]);await store.undoDocumentEdit(ws.id,'undo');
  const branch={...original,comment:'New branch'};await store.patchDocument(ws.id,main,{annotations:[branch]});assert.equal(states(store,ws.id).canRedo,false);
  const before=store.get(ws.id);assert.deepEqual(await store.undoDocumentEdit(ws.id,'redo'),before,'redo without history must not write or change timestamps');
  assert.deepEqual((await store.undoDocumentEdit(ws.id,'undo')).documents[0].annotations,[original]);assert.deepEqual((await store.undoDocumentEdit(ws.id,'undo')).documents[0].annotations,[]);
});

test('failed edits, undo and redo leave history intact and can be retried after filesystem recovery',async t=>{
  const {store,workspace:ws,main}=await fixture(t),mark=annotation('saved');await store.patchDocument(ws.id,main,{annotations:[mark]});
  const file=path.join(store.root,ws.id,'workspace.json'),saved=path.join(store.root,ws.id,'workspace.saved.json');
  const block=async()=>{await rename(file,saved);await mkdir(file);};const unblock=async()=>{await rm(file,{recursive:true});await rename(saved,file);};
  await block();await assert.rejects(()=>store.patchDocument(ws.id,main,{annotations:[annotation('failed')]}));await assert.rejects(()=>store.undoDocumentEdit(ws.id,'undo'));
  assert.deepEqual(store.get(ws.id).documents[0].annotations,[mark]);assert.deepEqual(states(store,ws.id),{canUndo:true,canRedo:false});
  await unblock();await store.undoDocumentEdit(ws.id,'undo');await block();await assert.rejects(()=>store.undoDocumentEdit(ws.id,'redo'));
  assert.deepEqual(store.get(ws.id).documents[0].annotations,[]);assert.deepEqual(states(store,ws.id),{canUndo:false,canRedo:true});
  await unblock();await assert.rejects(()=>store.patchDocument(ws.id,main,{annotations:[{...mark,kind:'invalid' as Annotation['kind']}]}),/PDF 记录无效/);assert.equal(states(store,ws.id).canRedo,true);
  await store.undoDocumentEdit(ws.id,'redo');assert.deepEqual(JSON.parse(await readFile(file,'utf8')).documents[0].annotations,[JSON.parse(JSON.stringify(mark))]);
});

test('queued edits and undo keep their order and snapshot submitted annotation data',async t=>{
  const {store,workspace:ws,main}=await fixture(t),first=annotation('first'),second=annotation('second','strikeout');
  const write1=store.patchDocument(ws.id,main,{annotations:[first]}),write2=store.patchDocument(ws.id,main,{annotations:[first,second]});
  first.text='Caller mutated the object after submitting';const undo=store.undoDocumentEdit(ws.id,'undo');
  await Promise.all([write1,write2]);const result=await undo;assert.equal(result.documents[0].annotations.length,1);assert.equal(result.documents[0].annotations[0].text,'Evidence first');
  assert.equal((await store.undoDocumentEdit(ws.id,'redo')).documents[0].annotations.length,2);
});

test('manual outline edits survive later indexing and undo also restores the original outline-loaded state',async t=>{
  const {store,workspace:ws,main}=await fixture(t);assert.equal(ws.documents[0].outlineLoaded,false);
  await store.patchDocument(ws.id,main,{outline:[{id:'manual',title:'My outline',page:2,children:[]}]});
  await store.index(ws.id,main,{pageCount:2,outline:[{id:'native',title:'Native outline',page:1,children:[]}],pages:['indexed','more']});
  assert.equal(store.get(ws.id).documents[0].outline[0].id,'manual');
  const undone=await store.undoDocumentEdit(ws.id,'undo');assert.deepEqual(undone.documents[0].outline,[]);assert.equal(undone.documents[0].outlineLoaded,false);assert.deepEqual(await store.pages(ws.id,main),['indexed','more']);
  assert.equal((await store.undoDocumentEdit(ws.id,'redo')).documents[0].outline[0].id,'manual');
});

test('detaching a PDF removes only its history; article removal and restore clear all session history',async t=>{
  const {store,workspace:ws,main,supplement}=await fixture(t);await store.patchDocument(ws.id,main,{annotations:[annotation('main')]});await store.patchDocument(ws.id,supplement,{annotations:[annotation('extra')]});await store.patchDocument(ws.id,main,{annotations:[annotation('main-edited')]});
  await store.undoDocumentEdit(ws.id,'undo');await store.detachDocument(ws.id,main);
  assert.deepEqual(states(store,ws.id),{canUndo:true,canRedo:false});const undone=await store.undoDocumentEdit(ws.id,'undo');assert.equal(undone.documents.length,1);assert.equal(undone.documents[0].id,supplement);assert.equal(undone.documents[0].annotations.length,0);
  await store.moveToTrash(ws.id);await store.restoreRemoved(ws.id);assert.deepEqual(states(store,ws.id),{canUndo:false,canRedo:false});assert.equal((await store.undoDocumentEdit(ws.id,'redo')).documents[0].annotations.length,0);
});

test('stale undo refuses to overwrite annotations changed outside document editing',async t=>{
  const {store,workspace:ws,main}=await fixture(t);await store.patchDocument(ws.id,main,{annotations:[annotation('recorded')]});await store.mutate(ws.id,w=>{w.documents[0].annotations=[annotation('external')];});
  await assert.rejects(()=>store.undoDocumentEdit(ws.id,'undo'),/其他来源改变/);assert.equal(store.get(ws.id).documents[0].annotations[0].id,'external');assert.deepEqual(states(store,ws.id),{canUndo:false,canRedo:false});
  await assert.rejects(()=>store.undoDocumentEdit(ws.id,'invalid' as 'undo'),/无效撤销/);
});

test('bounded history retains the most recent 50 document edits and remains redoable',async t=>{
  const {store,workspace:ws,main}=await fixture(t);
  for(let i=1;i<=55;i++)await store.patchDocument(ws.id,main,{annotations:[annotation(`edit-${i}`)]});
  for(let i=0;i<50;i++)await store.undoDocumentEdit(ws.id,'undo');
  assert.equal(store.get(ws.id).documents[0].annotations[0].id,'edit-5');assert.deepEqual(states(store,ws.id),{canUndo:false,canRedo:true});
  for(let i=0;i<50;i++)await store.undoDocumentEdit(ws.id,'redo');assert.equal(store.get(ws.id).documents[0].annotations[0].id,'edit-55');
});

test('oversized snapshot is saved but cannot expose a stale undo chain beyond the memory budget',async t=>{
  const {store,workspace:ws,main}=await fixture(t);await store.patchDocument(ws.id,main,{annotations:[annotation('before')]});
  const large={...annotation('large'),text:'x'.repeat(9*1024*1024)};await store.patchDocument(ws.id,main,{annotations:[large]});
  assert.equal(store.get(ws.id).documents[0].annotations[0].text.length,large.text.length);assert.deepEqual(states(store,ws.id),{canUndo:false,canRedo:false});
  await store.patchDocument(ws.id,main,{annotations:[]});await store.patchDocument(ws.id,main,{annotations:[annotation('normal')]});assert.equal(states(store,ws.id).canUndo,true);assert.deepEqual((await store.undoDocumentEdit(ws.id,'undo')).documents[0].annotations,[]);
});
