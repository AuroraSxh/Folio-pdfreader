import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { LibraryStore, newWorkspace, validateWorkspace } from '../electron/store';
import { type ViewState } from '../shared/types';

async function fixture(t:test.TestContext,both=true) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'pairleaf-import-swap-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=path.join(directory,'library'),main=path.join(directory,'Unhelpful-filename.pdf'),extra=path.join(directory,'Supplement.pdf');
  await writeFile(main,'%PDF-1.7\nMain fixture');await writeFile(extra,'%PDF-1.7\nSupplement fixture');
  const store=new LibraryStore(root);await store.init();
  return {store,root,extra,workspace:await store.createFromPaths(both?[main,extra]:[main])};
}
const index={pageCount:1,outline:[],title:'Recognized paper title',authors:'Recognized author',pages:['Extracted original text']};
const state=(page:number,scale:string,rotation=0,scrollMode=0,spreadMode=0):ViewState=>({page,scale,rotation,scrollMode,spreadMode});

test('new imports await confirmation, and accepting the filename survives indexing, supplements and reload',async t=>{
  const {store,root,extra,workspace:ws}=await fixture(t,false),doc=ws.documents[0];
  assert.equal(ws.titleStatus,'pending');assert.equal(ws.title,'Unhelpful-filename');
  const indexed=await store.index(ws.id,doc.id,index);
  assert.equal(indexed.title,ws.title);assert.equal(indexed.titleStatus,'pending');assert.equal(indexed.authors,index.authors);
  const confirmed=await store.patch(ws.id,{title:ws.title});assert.equal(confirmed.titleStatus,'confirmed');
  await store.index(ws.id,doc.id,{...index,title:'A later metadata value'});await store.addDocuments(ws.id,[extra]);
  const reload=new LibraryStore(root);await reload.init();const saved=reload.get(ws.id);
  assert.equal(saved.title,ws.title);assert.equal(saved.titleStatus,'confirmed');assert.equal(saved.documents.length,2);
});

test('manual titles win a queued late index and confirmation state cannot be assigned through metadata patches',async t=>{
  const {store,root,workspace:ws}=await fixture(t),doc=ws.documents[0];
  await Promise.all([store.patch(ws.id,{title:'  My chosen paper title  '}),store.index(ws.id,doc.id,index)]);
  await store.patch(ws.id,{notes:'My notes',titleStatus:'pending'});
  const saved=store.get(ws.id);assert.equal(saved.title,'My chosen paper title');assert.equal(saved.titleStatus,'confirmed');
  for(const title of ['', ' \n ', 'Bad\0title', 'x'.repeat(1001)])await assert.rejects(()=>store.patch(ws.id,{title}),/文章名称/);
  assert.deepEqual(store.get(ws.id),saved);
  const reload=new LibraryStore(root);await reload.init();assert.deepEqual(reload.get(ws.id),saved);
  const legacy=newWorkspace('Existing library title');await store.insert(legacy);
  await store.patch(legacy.id,{notes:'Keep legacy semantics'});assert.equal(store.get(legacy.id).titleStatus,undefined);
  assert.throws(()=>validateWorkspace({...legacy,titleStatus:'unrecognized'}),/确认状态/);
});

test('swapping drains preceding view writes and moves complete per-pane states without altering documents or edit history',async t=>{
  const {store,root,workspace:ws}=await fixture(t),[left,right]=ws.documents;
  let current=await store.patch(ws.id,{layout:{...ws.layout,direction:'horizontal',ratio:37}});
  const leftView=state(3,'1.8',90,2,1),rightView=state(7,'page-width',270,1,2);
  await store.updateView(ws.id,left.id,'left',state(1,'1.1'),current.layout.paneRevision);
  await store.patchDocument(ws.id,left.id,{annotations:[{id:'annotation',page:1,text:'evidence',comment:'saved',color:'#ff0',rects:[[1,2,3,4]],createdAt:1}]});
  const history=store.getDocumentEditHistory(ws.id);
  const writes=[store.updateView(ws.id,left.id,'left',leftView,current.layout.paneRevision),store.updateView(ws.id,right.id,'right',rightView,current.layout.paneRevision)];
  const swappedPromise=store.swapPanes(ws.id,current.layout);
  const written=await Promise.all(writes);current=await swappedPromise;
  assert.equal(current.layout.leftId,right.id);assert.equal(current.layout.rightId,left.id);
  assert.equal(current.layout.direction,'horizontal');assert.equal(current.layout.ratio,37);
  assert.deepEqual(current.layout.views?.left,{documentId:right.id,state:rightView});
  assert.deepEqual(current.layout.views?.right,{documentId:left.id,state:leftView});
  assert.deepEqual(current.documents,written[1].documents);
  assert.deepEqual(store.getDocumentEditHistory(ws.id),history);
  const reload=new LibraryStore(root);await reload.init();assert.deepEqual(reload.get(ws.id),current);
  const undone=await store.undoDocumentEdit(ws.id,'undo');assert.deepEqual(undone.documents[0].annotations,[]);
  assert.deepEqual(undone.layout,current.layout,'Swap must not enter the annotation undo history');
});

test('same-PDF panes retain independent views and late old-pane saves cannot overwrite the swap',async t=>{
  const {store,root,workspace:ws}=await fixture(t,false),doc=ws.documents[0];
  const opened=await store.patch(ws.id,{layout:{...ws.layout,split:true,rightId:doc.id}}),expected=opened.layout;
  const left=state(2,'1.3',90,2,0),right=state(10,'2.4',0,0,1);
  await store.updateView(ws.id,doc.id,'left',left,expected.paneRevision);
  await store.updateView(ws.id,doc.id,'right',right,expected.paneRevision);
  const swapped=await store.swapPanes(ws.id,expected);
  assert.deepEqual(swapped.layout.views?.left?.state,right);assert.deepEqual(swapped.layout.views?.right?.state,left);
  await assert.rejects(()=>store.swapPanes(ws.id,expected),/分栏已改变/);
  const ignored=await store.updateView(ws.id,doc.id,'left',state(50,'4.0'),expected.paneRevision);
  assert.deepEqual(ignored,swapped,'Discard a stale save without updating the timestamp or disk');
  const fresh=await store.updateView(ws.id,doc.id,'right',state(4,'1.5'),swapped.layout.paneRevision);
  assert.deepEqual(fresh.layout.views?.left?.state,right);assert.equal(fresh.layout.views?.right?.state.page,4);
  const reload=new LibraryStore(root);await reload.init();assert.deepEqual(reload.get(ws.id),fresh);
});

test('swap validates its snapshot, falls back from missing pane states and protects the pane revision from ordinary patches',async t=>{
  const {store,workspace:ws}=await fixture(t),[left,right]=ws.documents;
  const leftView=state(4,'1.2'),rightView=state(8,'2.1');
  await store.patchDocument(ws.id,left.id,{view:leftView});await store.patchDocument(ws.id,right.id,{view:rightView});
  // Stale cached pane state belongs to a different PDF; use each document's own view.
  await store.mutate(ws.id,w=>{w.layout.views={left:{documentId:right.id,state:state(90,'5.0')}};});
  const updated=await store.patch(ws.id,{layout:{...ws.layout,paneRevision:999,ratio:61}});
  assert.equal(updated.layout.paneRevision,ws.layout.paneRevision);
  const swapped=await store.swapPanes(ws.id,updated.layout);
  assert.deepEqual(swapped.layout.views?.left?.state,rightView);assert.deepEqual(swapped.layout.views?.right?.state,leftView);assert.equal(swapped.layout.ratio,61);
  await assert.rejects(()=>store.swapPanes(ws.id,undefined as any),/无效分栏/);
  await assert.rejects(()=>store.swapPanes(ws.id,{...swapped.layout,direction:'horizontal'}),/分栏已改变/);
  const closed=await store.patch(ws.id,{layout:{...swapped.layout,split:false}});
  await assert.rejects(()=>store.swapPanes(ws.id,closed.layout),/打开两栏/);
  assert.deepEqual(store.get(ws.id),closed);
});

test('a failed swap persists neither half of the layout and remains retryable',async t=>{
  const {store,root,workspace:ws}=await fixture(t);
  const filename=path.join(root,ws.id,'workspace.json'),saved=path.join(root,ws.id,'saved-workspace.json');
  await rename(filename,saved);await mkdir(filename);
  await assert.rejects(()=>store.swapPanes(ws.id,ws.layout));assert.deepEqual(store.get(ws.id),ws);
  await rm(filename,{recursive:true});await rename(saved,filename);
  const swapped=await store.swapPanes(ws.id,ws.layout);assert.equal(swapped.layout.leftId,ws.layout.rightId);
});

test('attaching and detaching displayed PDFs invalidates old pane snapshots while keeping title confirmation',async t=>{
  const {store,extra,workspace:ws}=await fixture(t,false);await store.patch(ws.id,{title:'My confirmed title'});
  const added=await store.addDocuments(ws.id,[extra]);assert.ok((added.layout.paneRevision??0)>(ws.layout.paneRevision??0));
  const opened=await store.patch(ws.id,{layout:{...added.layout,split:true}});
  const detached=await store.detachDocument(ws.id,opened.documents[1].id);
  assert.ok((detached.layout.paneRevision??0)>(opened.layout.paneRevision??0));assert.equal(detached.titleStatus,'confirmed');
  assert.equal(detached.title,'My confirmed title');assert.equal(detached.layout.split,false);
});
