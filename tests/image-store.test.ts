import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { LibraryStore, newWorkspace, validateWorkspace } from '../electron/store';
import { renderMarkdown } from '../electron/obsidian';
import { chatImageFilename, MAX_CHAT_IMAGE_BYTES, type StoredChatImage } from '../shared/images';
import { imageDraft, syntheticPNG } from './image-fixtures';

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pairleaf-image-store-'));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const root = path.join(directory, 'library'), store = new LibraryStore(root); await store.init();
  const pdf = await PDFDocument.create(); pdf.addPage([400,500]); const filename = path.join(directory,'Synthetic.pdf'); await fs.writeFile(filename, await pdf.save());
  const ws = await store.createFromPaths([filename]); await store.index(ws.id, ws.documents[0].id, { pageCount:1, outline:[], pages:['Synthetic test paper'] });
  const draft = {...imageDraft(),source:{documentId:ws.documents[0].id,documentName:'Untrusted alias',page:1,rect:[0,0,80,60]}};
  const imageDir = path.join(root,ws.id,'chat-images');
  const commit = async (images:StoredChatImage[],messageId='question') => store.mutate(ws.id, current=>{ current.conversations[0].messages.push({id:messageId,role:'user',content:'Explain this synthetic figure',createdAt:1,images}); });
  return {directory,root,store,ws,draft,imageDir,commit};
}
test('attachments remain separate private files, previews require committed references, and markdown stays text-only', async t=>{
  const {store,root,ws,draft,imageDir,commit}=await fixture(t), images=await store.saveChatImages(ws.id,[draft]), image=images[0];
  assert.equal(image.source?.documentName,ws.documents[0].name,'Server copies the real PDF name into source snapshot');
  assert.equal((await fs.stat(path.join(imageDir,chatImageFilename(image)))).mode & 0o777,0o600);
  await assert.rejects(store.readChatImage(ws.id,image.id),/没有该图片/);
  const updated=await commit(images);
  assert.equal(await store.readChatImage(ws.id,image.id),draft.dataUrl);
  const json=await fs.readFile(path.join(root,ws.id,'workspace.json'),'utf8');assert.ok(!json.includes('base64')&&!json.includes(draft.dataUrl));
  const markdown=renderMarkdown(updated);assert.ok(markdown.includes('Explain this synthetic figure'));assert.ok(!markdown.includes('data:image')&&!markdown.includes(image.id));
  const other=newWorkspace('Other paper');await store.insert(other);
  await assert.rejects(store.readChatImage(other.id,image.id),/没有该图片/);
  await assert.rejects(store.readChatImage('../escape',image.id));await assert.rejects(store.readChatImage(ws.id,'../../file'));
  const reloaded=new LibraryStore(root);await reloaded.init();assert.equal(await reloaded.readChatImage(ws.id,image.id),draft.dataUrl);
});
test('failed user-turn persistence removes staged images and leaves prior messages/images intact',async t=>{
  const {store,root,ws,draft,imageDir,commit}=await fixture(t), first=await store.saveChatImages(ws.id,[draft]);await commit(first);
  const staged=await store.saveChatImages(ws.id,[draft]), file=path.join(root,ws.id,'workspace.json'), saved=file+'.saved';
  await fs.rename(file,saved);await fs.mkdir(file);
  await assert.rejects(commit(staged,'fails'));
  assert.deepEqual(await fs.readdir(imageDir),[chatImageFilename(first[0])]);assert.equal(store.get(ws.id).conversations[0].messages.length,1);
  await fs.rmdir(file);await fs.rename(saved,file);assert.equal(await store.readChatImage(ws.id,first[0].id),draft.dataUrl);
  const cancelled=await store.saveChatImages(ws.id,[draft]);await store.discardChatImages(ws.id,[first[0].id,cancelled[0].id]);
  assert.deepEqual(await fs.readdir(imageDir),[chatImageFilename(first[0])]);
});
test('deleting one exchange preserves shared image references and deleting its last exchange removes the image',async t=>{
  const {store,ws,draft,imageDir,commit}=await fixture(t), images=await store.saveChatImages(ws.id,[draft]);
  await commit(images,'first');await commit(images,'second');
  await store.deleteChatTurn(ws.id,ws.activeConversationId,'first');assert.equal(await store.readChatImage(ws.id,images[0].id),draft.dataUrl);
  await store.deleteChatTurn(ws.id,ws.activeConversationId,'second');assert.deepEqual(await fs.readdir(imageDir),[]);
  await assert.rejects(store.readChatImage(ws.id,images[0].id),/没有该图片/);
});
test('restart clears only unreferenced generated image files and keeps valid message attachments',async t=>{
  const {store,root,ws,draft,imageDir,commit}=await fixture(t), images=await store.saveChatImages(ws.id,[draft]);await commit(images);
  await store.saveChatImages(ws.id,[draft]);await fs.writeFile(path.join(imageDir,'do-not-touch.txt'),'unknown local file');
  const restarted=new LibraryStore(root);await restarted.init();
  assert.deepEqual((await fs.readdir(imageDir)).sort(),[chatImageFilename(images[0]),'do-not-touch.txt'].sort());
  assert.equal(await restarted.readChatImage(ws.id,images[0].id),draft.dataUrl);
});
test('new image sources cannot point to another workspace, stale page, or unknown PDF',async t=>{
  const {store,ws,draft,imageDir}=await fixture(t);
  for(const source of [{...draft.source,documentId:randomUUID()},{...draft.source,page:2},{...draft.source,rect:[0,0,NaN,10]}])await assert.rejects(store.saveChatImages(ws.id,[{...draft,source}]));
  await assert.rejects(fs.stat(imageDir),{code:'ENOENT'});
});
test('opening an unindexed PDF can persist its page count without inventing extracted text or overwriting a known count',async t=>{
  const {store,directory,root}=await fixture(t),fresh=await store.createFromPaths([path.join(directory,'Synthetic.pdf')]),document=fresh.documents[0];
  assert.equal(document.pageCount,0);assert.equal(document.textStatus,undefined);
  for(const count of [0,-1,NaN,Infinity,1.2,1_000_001])await assert.rejects(store.setDocumentPageCount(fresh.id,document.id,count));
  await assert.rejects(store.setDocumentPageCount(fresh.id,'unknown',1));
  const opened=await store.setDocumentPageCount(fresh.id,document.id,1);
  assert.equal(opened.documents[0].pageCount,1);assert.equal(opened.documents[0].textStatus,undefined);assert.deepEqual(await store.pages(fresh.id,document.id),[]);
  await assert.rejects(fs.stat(path.join(root,fresh.id,'.text')),{code:'ENOENT'});
  const images=await store.saveChatImages(fresh.id,[{...imageDraft(),source:{documentId:document.id,documentName:document.name,page:1}}]);assert.equal(images.length,1);await store.discardChatImages(fresh.id,images.map(image=>image.id));
  assert.deepEqual(await store.setDocumentPageCount(fresh.id,document.id,999),opened);
  await store.index(fresh.id,document.id,{pageCount:1,outline:[],pages:['Actual extracted content']});assert.equal(store.get(fresh.id).documents[0].textStatus,'ready');
});
test('historical capture survives PDF removal, trash, restore, v2 backup and merge restore',async t=>{
  const {store,root,directory,ws,draft,imageDir,commit}=await fixture(t), images=await store.saveChatImages(ws.id,[draft]);await commit(images);
  await store.detachDocument(ws.id,ws.documents[0].id);
  assert.equal(store.get(ws.id).documents.length,0);assert.equal(store.get(ws.id).conversations[0].messages[0].images?.[0].source?.documentId,ws.documents[0].id);
  assert.equal(await store.readChatImage(ws.id,images[0].id),draft.dataUrl);
  await store.moveToTrash(ws.id);await assert.rejects(fs.stat(imageDir));
  const backup=await store.archive(),zip=await JSZip.loadAsync(backup),manifest=JSON.parse(await zip.file('folio-backup.json')!.async('string'));
  assert.equal(manifest.version,2);assert.ok(zip.file(`.trash/${ws.id}/chat-images/${chatImageFilename(images[0])}`));
  const target=new LibraryStore(path.join(directory,'restored'));await target.init();assert.equal(await target.restore(backup),1);assert.equal(target.listRemoved().length,1);
  await target.restoreRemoved(ws.id);assert.equal(await target.readChatImage(ws.id,images[0].id),draft.dataUrl);
  await store.restoreRemoved(ws.id);assert.equal(await store.readChatImage(ws.id,images[0].id),draft.dataUrl);
  await store.moveToTrash(ws.id);await store.purgeRemoved(ws.id);await assert.rejects(fs.stat(path.join(root,'.trash',ws.id)));
});
test('preview and backup reject file/directory/workspace symlinks without touching their targets',async t=>{
  const {store,root,directory,ws,draft,imageDir,commit}=await fixture(t), images=await store.saveChatImages(ws.id,[draft]);await commit(images);
  const image=images[0],filename=path.join(imageDir,chatImageFilename(image)),outside=path.join(directory,'outside.png');await fs.writeFile(outside,syntheticPNG());
  await fs.unlink(filename);await fs.symlink(outside,filename);
  await assert.rejects(store.readChatImage(ws.id,image.id),/符号链接/);await assert.rejects(store.archive(),/符号链接/);
  await fs.unlink(filename);await fs.writeFile(filename,syntheticPNG());
  const moved=path.join(directory,'moved-images');await fs.rename(imageDir,moved);await fs.symlink(moved,imageDir,'dir');
  await assert.rejects(store.readChatImage(ws.id,image.id),/符号链接/);await assert.rejects(store.saveChatImages(ws.id,[draft]),/符号链接/);
  await fs.unlink(imageDir);await fs.rename(moved,imageDir);
  const article=path.join(root,ws.id),movedArticle=path.join(directory,'moved-article');await fs.rename(article,movedArticle);await fs.symlink(movedArticle,article,'dir');
  await assert.rejects(store.readChatImage(ws.id,image.id),/符号链接/);
  assert.deepEqual(await fs.readFile(outside),syntheticPNG());
});
test('read validates current file bytes against recorded MIME, dimensions and size',async t=>{
  const {store,ws,draft,imageDir,commit}=await fixture(t),images=await store.saveChatImages(ws.id,[draft]);await commit(images);
  const filename=path.join(imageDir,chatImageFilename(images[0]));await fs.writeFile(filename,Buffer.alloc(images[0].byteSize,65));
  await assert.rejects(store.readChatImage(ws.id,images[0].id),/PNG.*JPEG/);
  await fs.writeFile(filename,Buffer.alloc(MAX_CHAT_IMAGE_BYTES+1));await assert.rejects(store.readChatImage(ws.id,images[0].id),/记录不一致/);
});
test('backup import rejects missing images, forged metadata, symlinks, unsafe paths and decompression oversize atomically',async t=>{
  const {store,directory,ws,draft,commit}=await fixture(t),images=await store.saveChatImages(ws.id,[draft]);await commit(images);
  const backup=await store.archive(),imagePath=`${ws.id}/chat-images/${chatImageFilename(images[0])}`;
  const cases:Array<(zip:JSZip)=>Promise<void>|void>=[
    zip=>{zip.remove(imagePath);},
    async zip=>{const record=JSON.parse(await zip.file(`${ws.id}/workspace.json`)!.async('string'));record.conversations[0].messages[0].images[0].width=17;zip.file(`${ws.id}/workspace.json`,JSON.stringify(record));},
    async zip=>{const manifest=JSON.parse(await zip.file('folio-backup.json')!.async('string'));manifest.version=1;zip.file('folio-backup.json',JSON.stringify(manifest));},
    zip=>{zip.file(imagePath,syntheticPNG(),{unixPermissions:0o120777});},
    zip=>{zip.file(`${ws.id}/chat-images/../unsafe.png`,syntheticPNG());},
    zip=>{zip.file(`${ws.id}/chat-images/${randomUUID()}.png`,syntheticPNG());},
    zip=>{zip.file(imagePath,Buffer.alloc(MAX_CHAT_IMAGE_BYTES+1));},
  ];
  for(let index=0;index<cases.length;index++){
    const zip=await JSZip.loadAsync(backup);await cases[index](zip);const target=new LibraryStore(path.join(directory,'bad-'+index));await target.init();
    await assert.rejects(target.restore(await zip.generateAsync({type:'uint8array',platform:'UNIX',compression:'DEFLATE'})),'reject malformed backup '+index);
    assert.equal(target.list().length,0);assert.deepEqual(await fs.readdir(target.root),[]);
  }
});
test('legacy no-image workspaces/backups remain v1 and malformed stored attachment metadata is rejected',async t=>{
  const {store,ws}=await fixture(t);const zip=await JSZip.loadAsync(await store.archive());assert.equal(JSON.parse(await zip.file('folio-backup.json')!.async('string')).version,1);
  const bad=structuredClone(store.get(ws.id));bad.conversations[0].messages.push({id:'x',role:'user',content:'bad',createdAt:1,images:[{id:randomUUID(),name:'bad',mimeType:'image/png',width:8,height:6,byteSize:50,dataUrl:imageDraft().dataUrl} as unknown as StoredChatImage]});
  assert.throws(()=>validateWorkspace(bad),/已保存图片记录无效/);
});
