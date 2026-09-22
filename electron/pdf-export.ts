import { PDFDocument, PDFName, PDFNumber, PDFHexString, PDFString, PDFArray, degrees, type PDFRef } from 'pdf-lib';
import type { PaperDocument, OutlineItem } from '../shared/types';

export async function exportAnnotatedPdf(source:Uint8Array,doc:PaperDocument):Promise<Uint8Array>{
  const pdf=await PDFDocument.load(source);
  const pages=pdf.getPages();
  if(doc.view.rotation)for(const page of pages)page.setRotation(degrees((page.getRotation().angle+doc.view.rotation)%360));
  const context=pdf.context;
  // Rebuild the full bookmark hierarchy with real PDF destinations, preserving Unicode titles.
  if(doc.outlineLoaded){
    const root=context.obj({Type:'Outlines'});const rootRef=context.register(root);
    const descendants=(items:OutlineItem[]):number=>items.reduce((n,x)=>n+1+descendants(x.children),0);
    const build=(items:OutlineItem[],parent:PDFRef)=>{
      const nodes=items.map(item=>{
        const page=pages[Math.max(0,Math.min(pages.length-1,item.page-1))];
        const node=context.obj({Title:PDFHexString.fromText(item.title),Parent:parent,Dest:[page.ref,PDFName.of('Fit')]});
        return {item,node,ref:context.register(node)};
      });
      nodes.forEach(({item,node,ref},i)=>{
        if(i)node.set(PDFName.of('Prev'),nodes[i-1].ref);if(i<nodes.length-1)node.set(PDFName.of('Next'),nodes[i+1].ref);
        if(item.children.length){const child=build(item.children,ref);node.set(PDFName.of('First'),child[0].ref);node.set(PDFName.of('Last'),child.at(-1)!.ref);node.set(PDFName.of('Count'),PDFNumber.of(descendants(item.children)));}
      });return nodes;
    };
    if(doc.outline.length){const nodes=build(doc.outline,rootRef);root.set(PDFName.of('First'),nodes[0].ref);root.set(PDFName.of('Last'),nodes.at(-1)!.ref);root.set(PDFName.of('Count'),PDFNumber.of(descendants(doc.outline)));pdf.catalog.set(PDFName.of('Outlines'),rootRef);}
    else pdf.catalog.delete(PDFName.of('Outlines'));
  }
  for(const annotation of doc.annotations){
    const page=pages[annotation.page-1];if(!page)continue;
    const rects=annotation.rects.filter(r=>r.length===4&&r.every(Number.isFinite));if(!rects.length)continue;
    const color=annotation.color.replace('#','');const rgb=[0,2,4].map(i=>parseInt(color.slice(i,i+2),16)/255);if(rgb.some(Number.isNaN))rgb.splice(0,3,1,0.85,0.25);
    const normalized=rects.map(([x1,y1,x2,y2])=>[Math.min(x1,x2),Math.min(y1,y2),Math.max(x1,x2),Math.max(y1,y2)]).filter(([x1,y1,x2,y2])=>x2>x1&&y2>y1);
    if(!normalized.length)continue;
    const rect=[Math.min(...normalized.map(r=>r[0])),Math.min(...normalized.map(r=>r[1])),Math.max(...normalized.map(r=>r[2])),Math.max(...normalized.map(r=>r[3]))];
    const quad=normalized.flatMap(([x1,y1,x2,y2])=>[x1,y2,x2,y2,x1,y1,x2,y1]);
    const kind=annotation.kind??'highlight';
    const subtype=kind==='underline'?'Underline':kind==='strikeout'?'StrikeOut':'Highlight';
    const item=context.obj({Type:'Annot',Subtype:subtype,Rect:rect,QuadPoints:quad,C:rgb,CA:kind==='highlight'?0.38:1,F:4,
      Contents:PDFHexString.fromText([annotation.text,annotation.comment].filter(Boolean).join('\n\n')),
      T:PDFHexString.fromText('Pairleaf'),NM:PDFString.of(annotation.id),M:PDFString.fromDate(new Date(annotation.createdAt))});
    if(kind!=='highlight'){
      // Native text-markup annotations plus an appearance matching Folio's PDF
      // coordinate geometry. Page rotation and zoom are applied by the reader.
      const n=(value:number)=>Number(value.toFixed(5)).toString();
      const lines=normalized.map(([x1,y1,x2,y2])=>{
        const height=y2-y1,y=y1+height*(kind==='underline'?0.08:0.5),width=Math.max(0.75,Math.min(2.5,height*0.065));
        return `${n(width)} w ${n(x1-rect[0])} ${n(y-rect[1])} m ${n(x2-rect[0])} ${n(y-rect[1])} l S`;
      });
      const appearance=context.flateStream(`q ${rgb.map(n).join(' ')} RG\n${lines.join('\n')}\nQ`,{Type:'XObject',Subtype:'Form',FormType:1,BBox:[0,0,rect[2]-rect[0],rect[3]-rect[1]],Resources:context.obj({})});
      item.set(PDFName.of('AP'),context.obj({N:context.register(appearance)}));
    }
    let annots=page.node.lookupMaybe(PDFName.of('Annots'),PDFArray);
    if(!annots){annots=context.obj([]);page.node.set(PDFName.of('Annots'),annots);}
    annots.push(context.register(item));
  }
  return pdf.save();
}
