import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFHexString, PDFName, PDFArray, PDFDict, PDFRawStream, decodePDFRawStream, degrees } from 'pdf-lib';
import { exportAnnotatedPdf } from '../electron/pdf-export';
import { DEFAULT_VIEW, type PaperDocument } from '../shared/types';

async function fixture() {
  const pdf=await PDFDocument.create();const first=pdf.addPage([400,600]);first.setRotation(degrees(90));pdf.addPage([400,600]);
  const context=pdf.context;
  const root=context.obj({Type:'Outlines'}),rootRef=context.register(root);
  const bookmark=context.obj({Title:PDFHexString.fromText('Original bookmark'),Parent:rootRef,Dest:[first.ref,PDFName.of('Fit')]});const ref=context.register(bookmark);
  root.set(PDFName.of('First'),ref);root.set(PDFName.of('Last'),ref);root.set(PDFName.of('Count'),context.obj(1));pdf.catalog.set(PDFName.of('Outlines'),rootRef);
  const existing=context.obj({Type:'Annot',Subtype:'Text',Rect:[10,10,30,30],Contents:PDFHexString.fromText('Original note'),T:PDFHexString.fromText('Original author')});
  first.node.set(PDFName.of('Annots'),context.obj([context.register(existing)]));
  const doc:PaperDocument={id:'doc',name:'paper.pdf',fileName:'paper.pdf',role:'main',size:0,pageCount:2,outlineLoaded:true,
    outline:[{id:'intro',title:'研究背景 🧬',page:1,children:[{id:'methods',title:'方法与设计',page:2,children:[]}]},{id:'results',title:'结果 / Résultats',page:2,children:[]}],
    annotations:[{id:'highlight-1',page:1,text:'关键实验结果',comment:'需要核对补充图',color:'#ffcc33',rects:[[40,80,20,60],[50,60,90,80]],createdAt:Date.UTC(2026,0,1)}],view:{...DEFAULT_VIEW,rotation:270}};
  return {source:await pdf.save(),doc};
}
async function readPdf(bytes:Uint8Array) {
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading=getDocument({data:bytes.slice(),useSystemFonts:true});return {pdf:await loading.promise,destroy:()=>loading.destroy()};
}

test('exported PDF independently parses Unicode nested bookmarks, valid page destinations, highlights and additive rotation',async t=>{
  const {source,doc}=await fixture(),exported=await exportAnnotatedPdf(source,doc),read=await readPdf(exported);t.after(read.destroy);
  assert.equal(read.pdf.numPages,2);
  const outline=(await read.pdf.getOutline())!;assert.equal(outline.length,2);assert.equal(outline[0].title,'研究背景 🧬');assert.equal(outline[0].items[0].title,'方法与设计');assert.equal(outline[1].title,'结果 / Résultats');
  const childDestination=outline[0].items[0].dest as unknown as {num:number;gen:number}[];assert.equal(await read.pdf.getPageIndex(childDestination[0]),1);
  const first=await read.pdf.getPage(1),second=await read.pdf.getPage(2);assert.equal(first.rotate,0);assert.equal(second.rotate,270);
  const annotations=await first.getAnnotations();assert.equal(annotations.length,2);
  const highlight=annotations.find(annotation=>annotation.subtype==='Highlight')!;assert.ok(highlight);assert.match(highlight.contentsObj.str,/关键实验结果/);assert.match(highlight.contentsObj.str,/需要核对补充图/);assert.equal(highlight.titleObj.str,'Pairleaf');
  assert.deepEqual(highlight.rect,[20,60,90,80]);assert.equal(highlight.quadPoints.length,16);assert.deepEqual([...highlight.color],[255,204,51]);
  assert.ok(annotations.some(annotation=>annotation.contentsObj.str==='Original note'));
  // The imported original remains readable with its untouched rotation and bookmark.
  const original=await readPdf(source);t.after(original.destroy);assert.equal((await original.pdf.getPage(1)).rotate,90);assert.equal((await original.pdf.getOutline())![0].title,'Original bookmark');
});

test('unloaded outline preserves original PDF bookmarks; explicitly emptied outline removes them',async t=>{
  const {source,doc}=await fixture();doc.outlineLoaded=false;doc.outline=[];doc.annotations=[];doc.view.rotation=0;
  const preserved=await readPdf(await exportAnnotatedPdf(source,doc));t.after(preserved.destroy);assert.equal((await preserved.pdf.getOutline())![0].title,'Original bookmark');
  doc.outlineLoaded=true;const removed=await readPdf(await exportAnnotatedPdf(source,doc));t.after(removed.destroy);assert.equal(await removed.pdf.getOutline(),null);
});

test('bookmark destinations clamp to available pages, invalid annotation geometry does not corrupt PDF',async t=>{
  const {source,doc}=await fixture();doc.outline=[{id:'beyond',title:'Beyond final page',page:999,children:[]}];doc.annotations=[{...doc.annotations[0],page:99},{...doc.annotations[0],id:'invalid-rect',rects:[[NaN,0,10,10],[]]},{...doc.annotations[0],id:'zero-area',kind:'underline',rects:[[10,10,10,20],[0,5,30,5]]}];
  const read=await readPdf(await exportAnnotatedPdf(source,doc));t.after(read.destroy);
  const destination=(await read.pdf.getOutline())![0].dest as unknown as {num:number;gen:number}[];assert.equal(await read.pdf.getPageIndex(destination[0]),1);assert.equal((await(await read.pdf.getPage(1)).getAnnotations()).length,1);
});

test('underline and strikeout export as native PDF annotations with matching visible appearances and Unicode comments',async t=>{
  const {source,doc}=await fixture();doc.view.rotation=90;
  doc.annotations.push(
    {...doc.annotations[0],id:'underline',kind:'underline',comment:'下划线评论',rects:[[20,60,90,80],[100,90,160,110]],color:'#267fa3'},
    {...doc.annotations[0],id:'strikeout',kind:'strikeout',page:2,comment:'删除线评论',rects:[[30,110,130,130]],color:'#cc3366'}
  );
  const bytes=await exportAnnotatedPdf(source,doc),read=await readPdf(bytes);t.after(read.destroy);
  const first=await read.pdf.getPage(1),second=await read.pdf.getPage(2);assert.equal(first.rotate,180);assert.equal(second.rotate,90);
  const firstAnnotations=await first.getAnnotations(),secondAnnotations=await second.getAnnotations();
  assert.equal(firstAnnotations.filter(item=>item.subtype==='Highlight').length,1,'legacy missing-kind annotation stays a highlight');
  const underline=firstAnnotations.find(item=>item.subtype==='Underline'),strikeout=secondAnnotations.find(item=>item.subtype==='StrikeOut');
  assert.ok(underline?.hasAppearance);assert.ok(strikeout?.hasAppearance);assert.match(underline.contentsObj.str,/下划线评论/);assert.match(strikeout.contentsObj.str,/删除线评论/);
  assert.deepEqual(underline.rect,[20,60,160,110]);assert.equal(underline.quadPoints.length,16);assert.deepEqual([...underline.color],[38,127,163]);
  assert.deepEqual(strikeout.rect,[30,110,130,130]);assert.equal(strikeout.quadPoints.length,8);
  // A second parser reads the real PDF Form streams: the lines use the same
  // PDF-space baseline/center geometry as the on-screen annotation overlay.
  const written=await PDFDocument.load(bytes);
  const appearance=(page:number,subtype:string)=>{
    const items=written.getPage(page).node.lookup(PDFName.of('Annots'),PDFArray);
    const item=items.asArray().map(ref=>written.context.lookup(ref,PDFDict)).find(item=>item.get(PDFName.of('Subtype'))===PDFName.of(subtype))!;
    const stream=item.lookup(PDFName.of('AP'),PDFDict).lookup(PDFName.of('N'));assert.ok(stream instanceof PDFRawStream);
    return {stream:Buffer.from(decodePDFRawStream(stream).decode()).toString('utf8'),bbox:stream.dict.lookup(PDFName.of('BBox'),PDFArray).asArray().map(value=>Number(value.toString()))};
  };
  const underAppearance=appearance(0,'Underline'),strikeAppearance=appearance(1,'StrikeOut');
  assert.deepEqual(underAppearance.bbox,[0,0,140,50]);assert.match(underAppearance.stream,/1\.3 w 0 1\.6 m 70 1\.6 l S/);assert.match(underAppearance.stream,/1\.3 w 80 31\.6 m 140 31\.6 l S/);
  assert.deepEqual(strikeAppearance.bbox,[0,0,100,20]);assert.match(strikeAppearance.stream,/1\.3 w 0 10 m 100 10 l S/);
  // Parsing appearance operators confirms both pages remain renderable.
  assert.ok((await first.getOperatorList()).fnArray.length>0);assert.ok((await second.getOperatorList()).fnArray.length>0);
});
