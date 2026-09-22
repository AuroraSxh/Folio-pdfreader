import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exportAnnotatedPdf } from './pdf-export';
import { DEFAULT_VIEW, type PaperDocument } from '../shared/types';

const chapters=[
  ['A workspace for a closer reading',
    'Reading a paper is rarely a one-document task. The main text presents the argument, while supplementary materials preserve experimental detail. Pairleaf brings these documents into one quiet workspace.',
    'This is a demonstration document, not a published study. All values in the sample figure are illustrative. Use it to explore split reading, editable outlines, full-text search, highlighting, and page navigation.',
    'Keep the main article in the left pane and open Supplementary materials in the right pane. Each pane has its own zoom, page position, scrolling mode, and search. Your reading position is saved locally.'],
  ['01  Read the evidence together',
    'Start with the research question. What is being measured, what is being compared, and what would count as a meaningful result? The example below illustrates how information can be distributed across files.',
    'For a complete description of the demonstration groups, see Supplementary Table S1 on page 1. For the reading checklist, see Supplementary Methods on page 2. These references are intentionally usable across the two panes.',
    'Select a sentence to highlight it or send it to the assistant. Highlights and comments are saved in the workspace and can be included in an exported PDF copy. Original imported files remain available.'],
  ['02  Ask focused questions',
    'The assistant reads the text layer of selected PDFs and includes document names and page numbers in its context. A question can refer to the main article, a supplement, or the text you selected.',
    'Example questions: What is the main research question? Which controls are described in Supplementary Methods? Summarize the limitations and identify what additional evidence would be needed.',
    'Configure your own DeepSeek API key in Settings. Choose Flash or Pro, turn thinking on or off, and choose a reasoning effort. Summaries, chat history, and typed long-term memories stay with this workspace.'],
  ['03  Turn reading into notes',
    'Write your own notes alongside the paper. The assistant can use those notes and relevant article memories in later conversations. You can inspect and delete memories at any time.',
    'Export to Markdown or select an Obsidian vault. Re-exporting the same article updates the matching note using its stable article identifier, keeping your literature collection organized.',
    'Use the backup action in Settings to save your library, PDFs, notes, conversations, outlines, and highlights together. API keys are excluded from the backup. This concludes the demonstration.']
];

async function makeDocument(supplement:boolean){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold),serif=await pdf.embedFont(StandardFonts.TimesRoman);
  const content=supplement?[
    ['Supplementary materials','Table S1. Demonstration groups','Group A: illustrative reference condition, n = 24. Group B: illustrative comparison condition, n = 24. Group C: illustrative follow-up condition, n = 24. These values are fictional and must not be interpreted as scientific results.','This supplement accompanies the Pairleaf demonstration document. Use the right pane to keep supporting material visible as you read the main article.'],
    ['Supplementary methods','Reading checklist','Identify the research question and the evidence supporting the central claim. Check whether the methods describe relevant controls, sample sizes, exclusions, and statistical assumptions.','Compare the main figure with the supplementary tables. Distinguish observed results from interpretations. Record unresolved questions as notes so they are available in future reading sessions.']
  ]:chapters;
  pdf.setTitle(supplement?'Pairleaf · Supplementary materials':'Pairleaf · A workspace for a closer reading');pdf.setAuthor('Pairleaf');pdf.setSubject('Demonstration document, not a published study');
  for(const [index,chapter]of content.entries()){
    const page=pdf.addPage([595,842]);page.drawText('F O L I O   /   R E A D I N G   S T U D I O',{x:58,y:793,size:9,font:bold,color:rgb(.23,.38,.3)});
    page.drawLine({start:{x:58,y:775},end:{x:537,y:775},thickness:.7,color:rgb(.8,.83,.8)});
    page.drawText(supplement?'SUPPLEMENTARY INFORMATION':'A GUIDE TO THOUGHTFUL READING',{x:58,y:746,size:9,font,color:rgb(.47,.51,.47)});
    let y=704;
    const lines=(text:string,size:number,f=font)=>{const words=text.split(' '),out:string[]=[];let line='';for(const word of words){if(f.widthOfTextAtSize(`${line} ${word}`,size)>475&&line){out.push(line);line=word;}else line=line?`${line} ${word}`:word;}if(line)out.push(line);return out;};
    for(const line of lines(chapter[0],29,serif)){page.drawText(line,{x:58,y,size:29,font:serif,color:rgb(.13,.19,.15)});y-=36;}
    y-=15;
    for(const para of chapter.slice(1)){for(const line of lines(para,11)){page.drawText(line,{x:58,y,size:11,font,color:rgb(.23,.26,.24)});y-=18;}y-=20;}
    if(index===0&&!supplement){
      page.drawRectangle({x:58,y:140,width:479,height:150,color:rgb(.95,.97,.95)});page.drawText('Illustrative comparison',{x:77,y:268,size:10,font:bold,color:rgb(.23,.38,.3)});
      [72,102,85].forEach((v,i)=>{page.drawRectangle({x:102+i*135,y:168,width:66,height:v,color:rgb(.32+i*.09,.5+i*.05,.39+i*.08)});page.drawText(`Group ${String.fromCharCode(65+i)}`,{x:110+i*135,y:151,size:9,font});});
    }
    page.drawLine({start:{x:58,y:70},end:{x:537,y:70},thickness:.6,color:rgb(.83,.85,.83)});
    page.drawText('DEMONSTRATION DOCUMENT  /  NOT A PUBLISHED STUDY',{x:58,y:51,size:7,font,color:rgb(.5,.53,.5)});page.drawText(String(index+1).padStart(2,'0'),{x:523,y:51,size:9,font});
  }
  const doc:PaperDocument={id:'demo',name:'demo.pdf',fileName:'demo.pdf',role:'main',size:0,pageCount:content.length,outline:content.map((c,i)=>({id:`outline-${i}`,title:c[0],page:i+1,children:[]})),outlineLoaded:true,annotations:[],view:{...DEFAULT_VIEW}};
  return exportAnnotatedPdf(await pdf.save(),doc);
}
export async function writeDemo(directory:string){
  await fs.mkdir(directory,{recursive:true});const main=path.join(directory,'Pairleaf - A closer reading.pdf'),supp=path.join(directory,'Supplementary materials.pdf');
  await fs.writeFile(main,await makeDocument(false));await fs.writeFile(supp,await makeDocument(true));return [main,supp];
}
