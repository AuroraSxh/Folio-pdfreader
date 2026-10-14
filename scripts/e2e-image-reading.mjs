import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// Synthetic vector PDFs, an actual local saved image, real capture/IPC, mocked
// model and speech. Never reads normal user data, keys, papers or microphone.
const output=path.resolve(process.env.FOLIO_E2E_OUTPUT||'test-results/image-reading');
await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(os.tmpdir(),'pairleaf-image-reading-'));
const env={...process.env,FOLIO_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
const workspaceId='image-reading-fixture',title='Synthetic figures for image reading',historyId=randomUUID();
const checks=[],errors=[],captures=[],diagnostics={stdout:[],stderr:[]},idle=[];
let app,page,cdp,failure;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pass=label=>{checks.push(label);console.log('PASS '+label);};
const pane=side=>page.locator('.pdf-pane').nth(side);
const drafts=()=>page.locator('.fl-image-attachments[data-kind="draft"] .fl-image-card');
const input=()=>page.getByRole('textbox',{name:'向 AI 提问',exact:true});
const send=()=>page.getByRole('button',{name:'发送问题',exact:true});
const history=()=>page.getByRole('combobox',{name:'历史对话',exact:true});
const state=()=>page.evaluate(()=>window.folio.bootstrap());
const requests=()=>app.evaluate(()=>globalThis.__imageE2E.requests);
const sourcePDF=path.join(profile,'fresh-import.pdf');
const colors={main:[[[220,40,40],[40,180,60],[50,90,220],[230,190,40]],[[25,150,210],[210,65,145],[60,175,85],[165,90,200]]],supplement:[[[140,55,185],[25,180,180],[235,130,35],[80,100,145]],[[210,75,25],[70,110,210],[130,185,45],[185,55,155]]]};
const digest=url=>createHash('sha256').update(Buffer.from(url.split(',')[1],'base64')).digest('hex');
async function waitFor(predicate,label,timeout=18000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await predicate())return;await delay(60);}throw Error('Timed out: '+label);}
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?(value>>>1)^0xedb88320:value>>>1;}return(value^0xffffffff)>>>0;}
function chunk(kind,data){const type=Buffer.from(kind),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([size,type,data,crc]);}
function storedPNG(){const header=Buffer.alloc(13);header.writeUInt32BE(8,0);header.writeUInt32BE(6,4);header[8]=8;header[9]=6;const pixels=Buffer.alloc(6*33);for(let y=0;y<6;y++)for(let x=0;x<8;x++)pixels.set([15,90,160,255],y*33+1+x*4);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
async function makePDF(id){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);pdf.setTitle('Synthetic figure capture article');
  for(let index=0;index<2;index++){
    const sheet=pdf.addPage([600,800]);
    [[20,410],[310,410],[20,20],[310,20]].forEach(([x,y],quadrant)=>sheet.drawRectangle({x,y,width:270,height:370,color:rgb(...colors[id][index][quadrant].map(value=>value/255))}));
    sheet.drawText(`${id.toUpperCase()} synthetic page ${index+1}`,{x:35,y:790,size:8,font});
    sheet.drawText('Locally generated test vectors only',{x:35,y:393,size:9,font});
  }
  return pdf.save();
}
async function seed(){
  const directory=path.join(profile,'Library',workspaceId);await mkdir(path.join(directory,'.text'),{recursive:true});await mkdir(path.join(directory,'chat-images'));
  const documents=[];
  for(const id of ['main','supplement']){const bytes=await makePDF(id),name=id==='main'?'Main colors.pdf':'Supplement colors.pdf';await writeFile(path.join(directory,name),bytes);await writeFile(path.join(directory,'.text',id+'.json'),JSON.stringify(['Synthetic page one','Synthetic page two']));documents.push({id,name,fileName:name,role:id==='main'?'main':'supplement',size:bytes.length,pageCount:2,outline:[],outlineLoaded:true,textStatus:'ready',annotations:[],view:{page:1,scale:'page-width',rotation:0,scrollMode:0,spreadMode:0}});if(id==='main')await writeFile(sourcePDF,bytes);}
  const image=storedPNG();await writeFile(path.join(directory,'chat-images',historyId+'.png'),image,{mode:0o600});
  const now=Date.now();
  const workspace={version:1,id:workspaceId,title,titleStatus:'confirmed',authors:'Synthetic fixtures',journal:'',doi:'',tags:[],favorite:false,createdAt:now,updatedAt:now,lastReadAt:now,documents,notes:'',memories:[],memoryIndex:'',conversations:[
    {id:'chat',title:'Image capture checks',createdAt:now,messages:[]},
    {id:'history',title:'Saved image history',createdAt:now,messages:[{id:'saved-question',role:'user',content:'A saved synthetic image',createdAt:now,images:[{id:historyId,name:'Saved blue fixture',mimeType:'image/png',width:8,height:6,byteSize:image.length,source:{documentId:'main',documentName:'Main colors.pdf',page:1}}]},{id:'long-answer',role:'assistant',content:Array.from({length:60},(_,i)=>`Synthetic historical explanation ${i+1}. No real scientific conclusion.`).join('\n\n'),createdAt:now+1}]},
    {id:'alternate',title:'Another image conversation',createdAt:now,messages:[]},
  ],activeConversationId:'chat',layout:{split:true,direction:'vertical',leftId:'main',rightId:'supplement',ratio:50}};
  await writeFile(path.join(directory,'workspace.json'),JSON.stringify(workspace));
  await writeFile(path.join(profile,'settings.json'),JSON.stringify({language:'zh-CN',activeProvider:'openai',providers:{openai:{model:'gpt-4.1',vision:'auto'}},autoCheckUpdates:false,autoSummary:false,autoMemory:false,readingTheme:'sepia'}));
}
async function installMocks(){
  await app.evaluate(({ipcMain,BrowserWindow,dialog},freshPath)=>{
    const win=BrowserWindow.getAllWindows()[0];win.setSize(1440,860);
    const s=globalThis.__imageE2E={requests:[],reads:[],blocked:[],holdStart:false,startResolvers:[],holdIndex:false,indexCalls:[],indexResolvers:[],listening:null,voiceText:'',speechCalls:[],originals:{}};
    const replace=(name,handler)=>{const channel='folio:'+name;s.originals[name]=ipcMain._invokeHandlers.get(channel);ipcMain.removeHandler(channel);ipcMain.handle(channel,handler);};
    const publicKeyFlag=result=>{result.providers[result.activeProvider].hasKey=true;return result;};
    replace('bootstrap',async(...args)=>{const result=await s.originals.bootstrap(...args);publicKeyFlag(result.settings);return result;});
    replace('save-settings',async(...args)=>publicKeyFlag(await s.originals['save-settings'](...args)));
    replace('read-chat-image',async(...args)=>{s.reads.push({workspaceId:args[1],imageId:args[2]});return s.originals['read-chat-image'](...args);});
    replace('start-chat',(_event,request)=>{s.requests.push(structuredClone(request));if(s.holdStart)return new Promise(resolve=>s.startResolvers.push(resolve));});
    replace('abort-chat',(_event,requestId)=>{const request=s.requests.find(item=>item.requestId===requestId);if(request)win.webContents.send('folio:chat',{type:'done',requestId,workspaceId:request.workspaceId,interrupted:true});});
    replace('index-document',(...args)=>{s.indexCalls.push({workspaceId:args[1],documentId:args[2]});if(s.holdIndex)return new Promise((resolve,reject)=>s.indexResolvers.push(()=>s.originals['index-document'](...args).then(resolve,reject)));return s.originals['index-document'](...args);});
    replace('voice-capabilities',()=>{s.speechCalls.push('capabilities');return {available:true,engine:'speech-analyzer',locales:['zh-CN','en-US'],voices:[]};});
    replace('voice-listen',(_event,options)=>{s.speechCalls.push('listen');s.listening=options.sessionId;s.voiceText='';setTimeout(()=>win.webContents.send('folio:voice',{type:'listening',sessionId:options.sessionId}),10);});
    replace('voice-stop-listening',()=>{s.speechCalls.push('stop-listening');s.listening=null;return {text:s.voiceText};});
    replace('voice-stop-speaking',()=>{s.speechCalls.push('stop-speaking');});
    for(const name of ['voice-speak','open-external','check-updates','download-update','install-update'])replace(name,()=>{s.blocked.push(name);throw Error('Forbidden real service in image test: '+name);});
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[freshPath]});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{s.blocked.push(details.url);callback({cancel:true});});
  },sourcePDF);
}
async function openFixture(){await page.getByRole('button',{name:'打开 '+title,exact:true}).click();for(const side of [0,1])await pane(side).locator('.textLayer span').first().waitFor();const toggle=page.getByRole('button',{name:'阅读伙伴',exact:true});if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();const pin=page.getByRole('button',{name:'固定阅读伙伴',exact:true});if(await pin.isVisible())await pin.click();await waitFor(()=>pane(0).getByRole('button',{name:'发送当前页给 AI',exact:true}).isEnabled(),'capture enabled');}
async function setDPR(value){cdp??=await page.context().newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:860,deviceScaleFactor:value,mobile:false});await waitFor(()=>page.evaluate(expected=>devicePixelRatio===expected,value),'requested DPR');await delay(300);}
async function stats(url,points=[[.25,.25],[.75,.25],[.25,.75],[.75,.75]]){
  const result=await page.evaluate(async({url,points})=>{const source=new Image();source.src=url;await source.decode();const image=await createImageBitmap(source),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});const pixels=points.map(([x,y])=>{context.clearRect(0,0,1,1);context.drawImage(image,Math.min(image.width-1,Math.floor(x*image.width)),Math.min(image.height-1,Math.floor(y*image.height)),1,1,0,0,1,1);return [...context.getImageData(0,0,1,1).data];});const result={width:image.width,height:image.height,pixels};image.close();canvas.width=canvas.height=0;return result;},{url,points});
  return {...result,byteSize:Buffer.from(url.split(',')[1],'base64').length,mimeType:url.slice(5,url.indexOf(';')),sha256:digest(url)};
}
function colorEquals(actual,expected){assert.ok(actual.every((value,index)=>index===3?value===255:Math.abs(value-expected[index])<=2),`Expected RGB ${expected}, received ${actual}`);}
async function captureWhole(side){const count=await drafts().count();await pane(side).getByRole('button',{name:'发送当前页给 AI',exact:true}).click();await waitFor(async()=>await drafts().count()===count+1,'current page joins draft');return drafts().last().locator('img').getAttribute('src');}
async function clearDrafts(){while(await drafts().count())await drafts().first().getByRole('button',{name:/^移除图像：/}).click();}
async function crop(side,start,end){const count=await drafts().count();await pane(side).getByRole('button',{name:'框选图表问 AI',exact:true}).click();const layer=pane(side).locator('.pdf-image-capture-overlay');await layer.waitFor();const box=await layer.boundingBox();assert.ok(box);const from={x:box.x+box.width*start[0],y:box.y+box.height*start[1]},to={x:box.x+box.width*end[0],y:box.y+box.height*end[1]};const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert.ok([from,to].every(point=>point.x>0&&point.y>0&&point.x<viewport.width&&point.y<viewport.height),'crop endpoints visible');await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:12});await page.mouse.up();await waitFor(async()=>await drafts().count()===count+1,'crop joins draft');return drafts().last().locator('img').getAttribute('src');}
async function goPage(side,number){const field=pane(side).getByRole('textbox',{name:'当前页码',exact:true});await field.fill(String(number));await field.press('Enter');await waitFor(async()=>await field.inputValue()===String(number),'page navigation');await pane(side).locator(`.page[data-page-number="${number}"] canvas`).waitFor();await delay(220);}
async function complete(){await app.evaluate(async({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0],s=globalThis.__imageE2E,request=s.requests.at(-1),data=await s.originals.bootstrap({sender:win.webContents,senderFrame:win.webContents.mainFrame});const workspace=data.workspaces.find(item=>item.id===request.workspaceId);const conversation=workspace.conversations.find(item=>item.id===request.conversationId);conversation.messages.push({id:request.requestId+'-user',role:'user',content:request.prompt,createdAt:Date.now()},{id:request.requestId+'-answer',role:'assistant',content:'Synthetic mocked response. No model was contacted.',createdAt:Date.now()+1});win.webContents.send('folio:chat',{type:'done',requestId:request.requestId,workspaceId:request.workspaceId,workspace});});await waitFor(()=>send().isVisible(),'mock response completion');}
async function model(model){await page.getByRole('button',{name:/^设置与连接/}).first().click();await page.locator('.fl-settings-nav').getByRole('button',{name:'AI 阅读助手',exact:true}).click();await page.getByRole('textbox',{name:'模型 ID',exact:true}).fill(model);await page.getByRole('button',{name:'保存设置',exact:true}).click();await waitFor(async()=>(await state()).settings.providers.openai.model===model,'model preference saves');await page.getByRole('button',{name:'关闭设置',exact:true}).click();}
async function shot(name){const notice=page.locator('.app-toast:not(.error)>button');if(await notice.isVisible())await notice.click();await page.screenshot({path:path.join(output,name+'.png'),scale:'css'});}
async function holdEncoding(){await page.evaluate(()=>{const original=HTMLCanvasElement.prototype.toBlob;window.__imageEncoding={held:false,release:null,original};HTMLCanvasElement.prototype.toBlob=function(callback,...args){HTMLCanvasElement.prototype.toBlob=original;return original.call(this,blob=>{window.__imageEncoding.held=true;window.__imageEncoding.release=()=>callback(blob);},...args);};});}
async function releaseEncoding(){await page.evaluate(()=>{window.__imageEncoding?.release?.();if(window.__imageEncoding?.original)HTMLCanvasElement.prototype.toBlob=window.__imageEncoding.original;});}
async function observeIdle(){
  await waitFor(()=>page.evaluate(()=>window.__captureCanvases.every(canvas=>canvas.width===0&&canvas.height===0)),'temporary capture canvases released');
  const sample=async()=>({...await app.evaluate(({app,BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];return {time:Date.now(),focused:window.isFocused(),visible:window.isVisible(),metrics:app.getAppMetrics()};}),renderer:await page.evaluate(()=>({visibilityState:document.visibilityState,focused:document.hasFocus(),releasedCaptureCanvases:window.__captureCanvases.filter(canvas=>canvas.width===0&&canvas.height===0).length}))});
  await sample();await delay(500);const before=await sample();await delay(3000);const after=await sample(),seconds=(after.time-before.time)/1000;
  assert.ok(before.focused&&after.focused&&before.visible&&after.visible,'Idle sample must stay visible and focused at both endpoints');
  const processes=after.metrics.map(metric=>{const previous=before.metrics.find(item=>item.pid===metric.pid&&item.creationTime===metric.creationTime);const delta=previous?metric.cpu.cumulativeCPUUsage-previous.cpu.cumulativeCPUUsage:null;return {pid:metric.pid,type:metric.type,cpuPercent:delta===null?null:Math.max(0,delta)/seconds*100,workingSetMiB:metric.memory.workingSetSize/1024};});
  const complete=processes.every(item=>Number.isFinite(item.cpuPercent))&&before.metrics.every(item=>after.metrics.some(next=>next.pid===item.pid&&next.creationTime===item.creationTime));
  const result={label:'two-pdf-image-draft-thumbnails',seconds,complete,cpuPercent:complete?processes.reduce((sum,item)=>sum+item.cpuPercent,0):null,gpuProcessCpuPercent:processes.filter(item=>item.type==='GPU').reduce((sum,item)=>sum+(item.cpuPercent??0),0),processes,samples:[before,after]};idle.push(result);
  console.log('IDLE '+JSON.stringify({seconds,cpuPercent:result.cpuPercent,gpuProcessCpuPercent:result.gpuProcessCpuPercent,focused:[before.focused,after.focused]}));
}

try{
  await seed();const executablePath=process.env.FOLIO_EXECUTABLE;app=await electron.launch({args:executablePath?[]:['.'],...(executablePath?{executablePath}:{}),env});
  for(const channel of ['stdout','stderr'])app.process()[channel]?.on('data',data=>{diagnostics[channel].push(String(data));if(diagnostics[channel].length>80)diagnostics[channel].shift();});
  page=await app.firstWindow();page.setDefaultTimeout(18000);page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('button',{name:'打开 '+title,exact:true}).waitFor();await page.waitForLoadState('load');await waitFor(async()=>/\bready\r?\n/.test(await readFile(path.join(profile,'logs/main.log'),'utf8').catch(()=>'')),'native startup complete before reload');
  await installMocks();await page.reload();await page.evaluate(()=>{window.__captureCanvases=[];const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback,...args){if(!this.isConnected)window.__captureCanvases.push(this);return original.call(this,callback,...args);};});await openFixture();await setDPR(1);

  assert.deepEqual(await app.evaluate(()=>globalThis.__imageE2E.reads),[],'Inactive conversation does not load image bytes');
  await history().selectOption('history');await page.locator('.fl-chat-scroll').evaluate(element=>{element.scrollTop=0;});
  const saved=page.locator(`[data-image-id="${historyId}"]`);await waitFor(async()=>await saved.getAttribute('data-image-state')==='loaded','actual saved image is lazy-loaded');
  const reads=await app.evaluate(()=>globalThis.__imageE2E.reads);assert.ok(reads.every(item=>item.workspaceId===workspaceId&&item.imageId===historyId));
  await saved.getByRole('button',{name:'预览图像：Saved blue fixture',exact:true}).click();await page.getByRole('dialog',{name:'图像预览',exact:true}).waitFor();await shot('saved-image-preview');await page.keyboard.press('Escape');await history().selectOption('chat');
  pass('Saved attachment loads through real read-chat-image only when its conversation becomes visible, and preview closes with Escape');

  const mainWhole=await captureWhole(0),mainStats=await stats(mainWhole);assert.deepEqual([mainStats.width,mainStats.height],[1536,2048]);mainStats.pixels.forEach((color,index)=>colorEquals(color,colors.main[0][index]));assert.equal(mainStats.mimeType,'image/png');assert.ok(mainStats.byteSize<=4*1024*1024);captures.push({label:'main-page-1-DPR1',...mainStats});
  await drafts().first().getByRole('button',{name:/^预览图像：/}).click();await shot('current-page-preview');await page.getByRole('button',{name:'关闭图像预览',exact:true}).click();await clearDrafts();assert.equal((await requests()).length,0);
  pass('Left current-page capture preserves actual vector colors at bounded resolution; preview/removal does not send');

  await goPage(1,2);const suppWhole=await captureWhole(1),suppStats=await stats(suppWhole);suppStats.pixels.forEach((color,index)=>colorEquals(color,colors.supplement[1][index]));captures.push({label:'supplement-page-2',...suppStats});
  assert.match(await drafts().first().innerText(),/Supplement colors.pdf.*第 2 页/s);pass('Right current-page capture uses its own supplementary PDF and independent page number');

  await setDPR(2);await goPage(0,1);const cropped=await crop(0,[.15,.15],[.35,.35]),croppedStats=await stats(cropped,[[.5,.5]]);colorEquals(croppedStats.pixels[0],colors.main[0][0]);assert.ok(Math.abs(croppedStats.width-360)<=8&&Math.abs(croppedStats.height-480)<=8);captures.push({label:'main-crop-DPR2',...croppedStats});await shot('two-pdf-image-drafts');
  pass('Mouse crop at DPR 2 contains only the selected vector region and expected pixel dimensions');

  await page.getByRole('combobox',{name:'AI 引用文档范围',exact:true}).selectOption('main');assert.equal(await input().inputValue(),'');assert.equal(await send().isEnabled(),true);
  await app.evaluate(()=>{globalThis.__imageE2E.holdStart=true;});await send().click();await waitFor(async()=>(await requests()).length===1,'image-only request');
  const first=(await requests())[0];assert.ok(first.prompt.trim());assert.deepEqual(first.images.map(image=>image.dataUrl),[suppWhole,cropped]);assert.deepEqual(first.images.map(image=>[image.source.documentId,image.source.page]),[['supplement',2],['main',1]]);assert.ok(first.documentIds.includes('main')&&first.documentIds.includes('supplement'));
  const rect=first.images[1].source.rect;[90,520,210,680].forEach((value,index)=>assert.ok(Math.abs(rect[index]-value)<3));
  const nextDraft=await captureWhole(0);assert.equal(await drafts().count(),1);
  await app.evaluate(()=>{const s=globalThis.__imageE2E;s.holdStart=false;s.startResolvers.splice(0).forEach(resolve=>resolve());});await delay(150);assert.equal(await drafts().count(),1);assert.equal(await drafts().first().locator('img').getAttribute('src'),nextDraft);await complete();
  pass('Image-only submit sends exact captured bytes/source pages and includes supplement scope; a new capture survives pending acknowledgement');

  if(process.platform==='darwin'||process.platform==='win32'){
    await page.getByRole('button',{name:'语音对话',exact:true}).click();const voice=page.getByRole('region',{name:'语音对话控制',exact:true});await waitFor(async()=>await voice.getAttribute('data-phase')==='paused','mock voice configured');await page.getByRole('button',{name:/^(开始聆听|继续聆听)$/}).click();await waitFor(async()=>await voice.getAttribute('data-phase')==='listening','mock voice starts');
    await app.evaluate(({BrowserWindow})=>{const s=globalThis.__imageE2E;s.voiceText='这是一句合成语音测试问题。';BrowserWindow.getAllWindows()[0].webContents.send('folio:voice',{type:'partial',sessionId:s.listening,text:s.voiceText});});await waitFor(async()=>(await requests()).length===2,'voice request');assert.equal((await requests())[1].source,'voice');assert.equal((await requests())[1].images,undefined);await page.getByRole('button',{name:'结束语音对话',exact:true}).click();await voice.waitFor({state:'detached'});assert.equal(await drafts().count(),1);
    pass('Mocked voice question sends no image drafts and leaves the typed image available');
  }
  await clearDrafts();

  await pane(0).getByRole('button',{name:'阅读模式与导出',exact:true}).click();await pane(0).getByRole('button',{name:'顺时针旋转 90°',exact:true}).click();await pane(0).getByRole('button',{name:'关闭阅读设置',exact:true}).click();await goPage(0,2);await pane(0).locator('.pdf-viewer-container').evaluate(element=>{element.scrollTop+=35;});await delay(200);
  const rotated=await crop(0,[.1,.2],[.32,.4]),rotatedStats=await stats(rotated,[[.5,.5]]);colorEquals(rotatedStats.pixels[0],colors.main[1][2]);assert.ok(Math.abs(rotatedStats.width-528)<=8&&Math.abs(rotatedStats.height-360)<=8);captures.push({label:'rotated90-scrolled-main-page2-DPR2',...rotatedStats});
  const countBeforeRotate=(await requests()).length;await send().click();await waitFor(async()=>(await requests()).length===countBeforeRotate+1,'rotated crop request');const rotationRequest=(await requests()).at(-1);assert.equal(rotationRequest.images[0].source.page,2);[120,80,240,256].forEach((value,index)=>assert.ok(Math.abs(rotationRequest.images[0].source.rect[index]-value)<3));await complete();
  pass('A 90-degree rotated crop after scrolling keeps the original PDF-space rectangle and page binding');

  await captureWhole(1);await model('gpt-3.5-turbo');const requestCount=(await requests()).length;await input().fill('Synthetic text with a blocked image');assert.equal(await send().isDisabled(),true);await input().press('Enter');await delay(100);assert.equal((await requests()).length,requestCount);assert.equal(await drafts().count(),1);await clearDrafts();await input().fill('Synthetic text-only question');await send().click();await waitFor(async()=>(await requests()).length===requestCount+1,'text-only question on text model');assert.equal((await requests()).at(-1).images,undefined);await complete();await model('gpt-4.1');
  pass('Known text-only model blocks image sending without losing the draft; normal text questions still work');

  await holdEncoding();await pane(1).getByRole('button',{name:'发送当前页给 AI',exact:true}).click();await waitFor(()=>page.evaluate(()=>window.__imageEncoding?.held),'capture encoding held');await history().selectOption('alternate');await waitFor(async()=>(await state()).workspaces.find(item=>item.id===workspaceId).activeConversationId==='alternate','conversation switch persisted');await releaseEncoding();await delay(250);assert.equal(await drafts().count(),0);
  pass('Late capture completion after conversation switching never inserts into the new conversation');

  await pane(1).getByRole('button',{name:'框选图表问 AI',exact:true}).click();await pane(1).locator('.pdf-image-capture-overlay').waitFor();await page.keyboard.press('Escape');await pane(1).locator('.pdf-image-capture-overlay').waitFor({state:'detached'});assert.equal(await drafts().count(),0);
  await pane(1).getByRole('button',{name:'框选图表问 AI',exact:true}).click();await pane(1).locator('.pdf-image-capture-overlay').waitFor();await pane(1).locator('.pdf-viewer-container').evaluate(element=>{element.scrollTop=Math.max(0,element.scrollTop-20);});await pane(1).locator('.pdf-image-capture-overlay').waitFor({state:'detached'});assert.equal(await drafts().count(),0);
  pass('Escape and page scrolling cancel selection mode without accidental image attachments');

  await page.locator('.back-button').click();await app.evaluate(()=>{globalThis.__imageE2E.holdIndex=true;});await page.getByRole('button',{name:/^导入论文/}).click();await page.getByRole('dialog',{name:'确认文章名称',exact:true}).waitFor();await page.getByRole('button',{name:'确认名称',exact:true}).click();await waitFor(()=>pane(0).getByRole('button',{name:'发送当前页给 AI',exact:true}).isEnabled(),'newly imported PDF count available before index');
  const fresh=(await state()).workspaces.find(item=>item.id!==workspaceId);assert.ok(fresh);assert.equal(fresh.documents[0].pageCount,2);assert.equal(fresh.documents[0].textStatus,undefined);await assert.rejects(readFile(path.join(profile,'Library',fresh.id,'.text',fresh.documents[0].id+'.json')),{code:'ENOENT'});
  await captureWhole(0);const beforeFresh=(await requests()).length;await send().click();await waitFor(async()=>(await requests()).length===beforeFresh+1,'unindexed image send');const freshRequest=(await requests()).at(-1);assert.equal(freshRequest.workspaceId,fresh.id);assert.equal(freshRequest.images[0].source.documentId,fresh.documents[0].id);assert.equal((await state()).workspaces.find(item=>item.id===fresh.id).documents[0].textStatus,undefined);await complete();await shot('fresh-unindexed-image-question');
  await app.evaluate(async()=>{const s=globalThis.__imageE2E;s.holdIndex=false;await Promise.all(s.indexResolvers.splice(0).map(release=>release()));});
  pass('Fresh PDF metadata enables capture/send while text indexing is deliberately pending, without claiming text is ready');

  await page.locator('.back-button').click();await openFixture();await clearDrafts();await captureWhole(0);await captureWhole(1);await shot('two-pdf-attachments-idle');await observeIdle();
  pass('Capture canvases release their backing pixels; foreground idle CPU is sampled with both PDFs and image thumbnails visible');

  assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>globalThis.__imageE2E.blocked),[]);pass('No renderer errors, real model requests, native microphone, speech playback, updates or external links');
}catch(error){failure=String(error.stack||error);console.error(failure);if(page)await page.screenshot({path:path.join(output,'failure.png'),scale:'css'}).catch(()=>{});process.exitCode=1;}
finally{
  let requestSummary=[],runtime;
  if(app){await releaseEncoding().catch(()=>{});await app.evaluate(async()=>{const s=globalThis.__imageE2E;if(!s)return;s.startResolvers.splice(0).forEach(resolve=>resolve());s.holdIndex=false;await Promise.all(s.indexResolvers.splice(0).map(release=>release()));}).catch(()=>{});
    const recorded=await requests().catch(()=>[]);requestSummary=recorded.map(request=>({requestId:request.requestId,workspaceId:request.workspaceId,conversationId:request.conversationId,prompt:request.prompt,source:request.source,documentIds:request.documentIds,images:request.images?.map(image=>({name:image.name,source:image.source,sha256:digest(image.dataUrl),byteSize:Buffer.from(image.dataUrl.split(',')[1],'base64').length}))}));
    runtime=await app.evaluate(({app,BrowserWindow})=>({version:app.getVersion(),isPackaged:app.isPackaged,focused:BrowserWindow.getAllWindows()[0]?.isFocused(),visible:BrowserWindow.getAllWindows()[0]?.isVisible()})).catch(()=>null);
    diagnostics.startupLog=await readFile(path.join(profile,'logs/main.log'),'utf8').catch(()=>'');await app.close().catch(()=>{});
  }
  await rm(profile,{recursive:true,force:true});
  await writeFile(path.join(output,'report.json'),JSON.stringify({passed:!failure&&!errors.length,checks,errors,failure,captures,requests:requestSummary,runtime,diagnostics,idle,cpuDefinition:'Cumulative CPU seconds delta / elapsed wall seconds ×100. 100% is one logical core. GPU-process CPU is not GPU hardware utilization.',windowClosed:true,temporaryProfileRemoved:true,modelAndSpeech:'Mock IPC only; historical image preview and PDF storage/read are real isolated local IPC.'},null,2));
  console.log(JSON.stringify({passed:!failure&&!errors.length,checks:checks.length,captures:captures.length,requests:requestSummary.length,report:path.join(output,'report.json')}));
}
