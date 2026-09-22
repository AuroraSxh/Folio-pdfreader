import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';
import { createServer } from 'node:http';

const output=path.resolve(process.env.FOLIO_E2E_OUTPUT||'test-results');await mkdir(output,{recursive:true});
const executablePath=process.env.FOLIO_EXECUTABLE;
const userData=await mkdtemp(path.join(os.tmpdir(),'folio-e2e-'));
const env={...process.env,FOLIO_USER_DATA:userData};delete env.ELECTRON_RUN_AS_NODE;
let app;
const failures=[];
const checks=[];
const check=(name)=>{checks.push(name);console.log(`PASS ${name}`);};
const requests=[];
// Installed Playwright checks a predicate's returned Promise for truthiness before
// its resolution. Poll awaited IPC results outside waitForFunction instead.
async function waitForAsync(page,predicate,timeoutMs=30000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(await page.evaluate(predicate))return;await page.waitForTimeout(50);}
  throw new Error('Timed out waiting for persisted application state');
}
const mock=createServer(async(req,res)=>{
  const buffers=[];for await(const chunk of req)buffers.push(chunk);
  const body=JSON.parse(Buffer.concat(buffers).toString());requests.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const text='这是本地模拟服务的集成测试回答：补充材料说明了阅读清单。 [Supplementary materials.pdf p.2]';
  for(const part of [text.slice(0,19),text.slice(19)]){res.write(`data: ${JSON.stringify({choices:[{delta:{content:part}}]})}\n\n`);await new Promise(r=>setTimeout(r,100));}
  res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const mockURL=`http://127.0.0.1:${mock.address().port}/v1`;
try {
  app=await electron.launch({args:executablePath?[]:['.'],...(executablePath?{executablePath}:{}),env});
  const page=await app.firstWindow();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1000));
  async function openAssistant(){
    const toggle=page.getByRole('button',{name:'阅读伙伴',exact:true});
    if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
    await page.locator('.assistant-shell').waitFor({state:'visible'});
    const pin=page.getByRole('button',{name:'固定阅读伙伴',exact:true});
    if(await pin.isVisible())await pin.click();
  }
  async function expandArticleNavigation(){
    const expand=page.getByRole('button',{name:'展开文章导航',exact:true});
    if(await expand.isVisible())await expand.click();
  }
  page.on('pageerror',error=>failures.push(error.message));
  await page.getByRole('button',{name:'体验示例工作区'}).waitFor();
  await page.screenshot({path:path.join(output,'01-library-empty.png')});
  check('Desktop launch, empty library, isolated local data');
  await page.getByRole('button',{name:'体验示例工作区'}).click();
  await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor();
  await waitForAsync(page,async()=>{const b=await window.folio.bootstrap();return b.workspaces[0]?.documents.every(d=>d.pageCount>0&&d.textStatus==='ready');});
  let data=await page.evaluate(()=>window.folio.bootstrap());let ws=data.workspaces[0];
  assert.equal(ws.documents.length,2);assert.equal(ws.documents[0].pageCount,4);assert.equal(ws.documents[1].pageCount,2);
  assert.equal(await page.locator('.pdf-pane').count(),2);
  await page.screenshot({path:path.join(output,'02-split-reader.png')});
  check('Real PDFs imported, both documents rendered, full text and outlines indexed');
  const left=page.locator('.pdf-pane').nth(0),right=page.locator('.pdf-pane').nth(1);
  const sharedToolbar=page.getByRole('toolbar',{name:'文字与批注工具',exact:true});
  assert.equal(await sharedToolbar.count(),1);
  assert.ok(await sharedToolbar.getByRole('button',{name:'复制选中文字',exact:true}).isDisabled());
  await openAssistant();
  await page.getByRole('tab',{name:'笔记',exact:true}).click();
  const selectPdfText=async()=>{
    // A real blank-margin click clears an earlier selection; dragging from
    // inside the old selection would begin browser drag-and-drop instead.
    await left.locator('.pdf-viewer-container').click({position:{x:8,y:12}});
    const locate=()=>left.locator('.pdf-viewer-container').evaluate(element=>{
      const viewport=element.getBoundingClientRect();
      for(const span of element.querySelectorAll('.textLayer span')){
        const r=span.getBoundingClientRect();
        if(span.textContent.trim()&&r.width>70&&r.height>7&&r.top>viewport.top+10&&r.bottom<viewport.bottom-10&&r.left>viewport.left&&r.right<viewport.right-8)return {x:r.left+2,y:r.top+r.height*.5,endX:r.right-2};
      }
      return null;
    });
    let target,previous,stableSince=Date.now();const deadline=Date.now()+5000;
    while(Date.now()<deadline){target=await locate();if(!target||JSON.stringify(target)!==JSON.stringify(previous)){previous=target;stableSince=Date.now();}else if(Date.now()-stableSince>=280)break;await page.waitForTimeout(70);}
    if(!target||Date.now()-stableSince<280)throw new Error('PDF text geometry did not settle for pointer selection');
    await page.mouse.move(target.x,target.y);await page.mouse.down();await page.mouse.move(target.endX,target.y,{steps:12});await page.mouse.up();
    await page.waitForFunction(()=>!!window.getSelection()?.toString().trim(),null,{timeout:5000});
    return page.evaluate(()=>window.getSelection().toString().trim());
  };
  const selectedText=await selectPdfText();
  // Ordinary PDF selection used to trigger AI-composer autofocus, clearing its
  // Range after a render. Check the settled selection, not the earlier copy race.
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>window.getSelection()?.toString()),selectedText);
  assert.equal(await page.getByRole('tab',{name:'笔记',exact:true}).getAttribute('aria-selected'),'true');
  assert.ok(await sharedToolbar.getByRole('button',{name:'复制选中文字',exact:true}).isEnabled());
  async function expectClipboard(text){
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){if((await app.evaluate(({clipboard})=>clipboard.readText())).trim()===text.trim())return;await page.waitForTimeout(50);}
    assert.equal((await app.evaluate(({clipboard})=>clipboard.readText())).trim(),text.trim());
  }
  await app.evaluate(({clipboard})=>clipboard.writeText('Folio copy sentinel'));
  await page.keyboard.press(process.platform==='darwin'?'Meta+C':'Control+C');
  await expectClipboard(selectedText);
  await app.evaluate(({clipboard})=>clipboard.writeText('Folio copy sentinel'));
  await sharedToolbar.getByRole('button',{name:'复制选中文字',exact:true}).click();
  await expectClipboard(selectedText);
  async function openPdfMenu(){
    const point=await left.locator('.pdf-viewer-container').evaluate(element=>{
      const viewport=element.getBoundingClientRect();const selection=window.getSelection();
      const selected=selection?.rangeCount&&element.contains(selection.anchorNode)?selection.getRangeAt(0).getBoundingClientRect():null;
      return selected&&selected.width?{x:selected.left+Math.min(selected.width/2,80),y:selected.top+selected.height/2}:{x:viewport.left+30,y:viewport.top+30};
    });
    await page.mouse.click(point.x,point.y,{button:'right'});
  }
  await openPdfMenu();
  await app.evaluate(({clipboard})=>clipboard.writeText('Folio copy sentinel'));
  await page.getByRole('menuitem',{name:'复制选中文字',exact:true}).click();
  await expectClipboard(selectedText);
  check('PDF text copies to the system clipboard via native shortcut, toolbar and right-click menu');
  await selectPdfText();
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>window.getSelection()?.toString()),selectedText);
  await sharedToolbar.getByRole('button',{name:'问 AI',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='向 AI 提问',null,{timeout:10000});
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'向 AI 提问');
  assert.equal(await page.getByRole('tab',{name:'对话',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.fl-selection-context blockquote').textContent(),selectedText);
  await page.getByRole('button',{name:'清除选中文字',exact:true}).click();
  check('Ordinary PDF selection keeps focus and Notes tab; explicit Ask AI opens and focuses chat');
  await openPdfMenu();await page.getByRole('menuitem',{name:'取消分栏',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.pdf-pane').length===1);
  await openPdfMenu();await page.getByRole('menuitem',{name:'上下分栏',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.pdf-columns.split.horizontal')&&document.querySelectorAll('.pdf-pane').length===2);
  await waitForAsync(page,async()=>{const w=(await window.folio.bootstrap()).workspaces[0];return w.layout.direction==='horizontal'&&w.layout.leftId===w.layout.rightId;});
  await openPdfMenu();await page.getByRole('menuitem',{name:'左右分栏',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.pdf-columns.split:not(.horizontal)'));
  await page.getByRole('combobox',{name:'右侧 PDF'}).selectOption(ws.documents[1].id);
  await page.waitForFunction(name=>document.querySelectorAll('.pdf-pane')[1]?.getAttribute('aria-label')===name,`${ws.documents[1].name} 阅读器`);
  await right.locator('.textLayer span').first().waitFor();
  check('PDF right-click menu cancels split, splits the same PDF above/below, and switches to side-by-side');
  await page.keyboard.press('Escape');
  async function setToolbarMode(mode){
    await page.getByRole('button',{name:'设置与连接',exact:false}).click();
    await page.getByRole('button',{name:'阅读偏好',exact:true}).click();
    await page.getByRole('combobox',{name:'批注工具栏位置',exact:true}).selectOption(mode);
    await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await page.waitForFunction(value=>document.querySelectorAll('.pdf-annotation-tools-'+value).length===(value==='selection'?0:1),mode);
    await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  }
  await setToolbarMode('fixed');
  for(const pane of [left,right]){
    const toolbar=await sharedToolbar.boundingBox();
    const viewer=await pane.locator('.pdf-viewer-container').boundingBox();
    assert.ok(toolbar.y+toolbar.height<=viewer.y+2,'Fixed toolbar must sit above the scrolling PDF');
  }
  await page.screenshot({path:path.join(output,'08-fixed-annotation-toolbar.png')});
  await setToolbarMode('selection');
  await setToolbarMode('floating');
  assert.equal((await page.evaluate(()=>window.folio.bootstrap())).settings.annotationToolbar,'floating');
  assert.equal(await sharedToolbar.count(),1);
  check('One shared annotation toolbar serves both panes; fixed, floating and selection-only modes save through Settings');
  await sharedToolbar.getByRole('button',{name:'切换工具栏位置',exact:true}).click();
  await page.locator('.pdf-annotation-tools-fixed').waitFor();
  await waitForAsync(page,async()=> (await window.folio.bootstrap()).settings.annotationToolbar==='fixed');
  await sharedToolbar.getByRole('button',{name:'切换工具栏位置',exact:true}).click();
  await page.locator('.pdf-annotation-tools-floating').waitFor();
  await waitForAsync(page,async()=> (await window.folio.bootstrap()).settings.annotationToolbar==='floating');
  assert.equal(await sharedToolbar.count(),1);
  check('Toolbar position toggles directly between fixed and floating with settings persistence');
  await left.getByRole('button',{name:'下一页',exact:true}).click();
  assert.equal(await left.getByRole('textbox',{name:'当前页码',exact:true}).inputValue(),'2');
  assert.equal(await right.getByRole('textbox',{name:'当前页码',exact:true}).inputValue(),'1');
  check('Independent split-pane navigation');
  await left.getByRole('combobox',{name:'缩放比例'}).selectOption('1.25');
  await right.getByRole('combobox',{name:'缩放比例'}).selectOption('0.75');
  await left.locator('.pdf-viewer-container').evaluate(element=>{const rect=element.getBoundingClientRect();element.dispatchEvent(new WheelEvent('wheel',{deltaY:-20,ctrlKey:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,bubbles:true,cancelable:true}));});
  await page.waitForFunction(()=>{const select=document.querySelector('.pdf-pane select[aria-label="缩放比例"]');return select&&parseFloat(select.selectedOptions[0].textContent)>125;});
  assert.equal(await right.getByRole('combobox',{name:'缩放比例'}).inputValue(),'0.75');
  assert.equal(await page.evaluate(()=>window.visualViewport.scale),1);
  const zoomBefore=await left.getByRole('combobox',{name:'缩放比例'}).inputValue();
  const scrollArea=await left.locator('.pdf-viewer-container').boundingBox();await page.mouse.move(scrollArea.x+scrollArea.width/2,scrollArea.y+scrollArea.height/2);await page.mouse.wheel(0,160);
  assert.equal(await left.getByRole('combobox',{name:'缩放比例'}).inputValue(),zoomBefore);
  check('Independent zoom controls + trackpad Ctrl-wheel routing; regular wheel does not zoom or scale app UI');
  await left.getByRole('combobox',{name:'缩放比例'}).selectOption('page-width');await right.getByRole('combobox',{name:'缩放比例'}).selectOption('page-width');
  await left.getByRole('button',{name:'搜索文章文字',exact:true}).click();
  const search=left.getByRole('textbox',{name:'搜索 PDF'});await search.fill('demonstration');await search.press('Enter');
  await left.locator('.highlight').first().waitFor();
  check('Full-document search highlights actual text');
  await left.getByRole('button',{name:'搜索文章文字',exact:true}).click();
  await openAssistant();
  await page.getByRole('tab',{name:'笔记',exact:true}).click();
  const notes=page.getByRole('textbox',{name:'个人阅读笔记'});await notes.fill('## E2E 阅读笔记\n\n正文与 Supplement 对照，必须在重新打开后保留。');await notes.blur();
  await waitForAsync(page,async()=> (await window.folio.bootstrap()).workspaces[0].notes.includes('E2E 阅读笔记'));
  check('Notes auto-save into article workspace');
  await expandArticleNavigation();
  await page.getByTitle('编辑论文信息',{exact:true}).first().click();
  await page.getByLabel('论文标题',{exact:true}).fill('Folio 集成验证 · 双 PDF 阅读');
  await page.getByLabel('研究标签',{exact:true}).fill('integration, evidence');
  await page.getByRole('button',{name:'保存信息'}).click();
  await waitForAsync(page,async()=> (await window.folio.bootstrap()).workspaces[0].title.startsWith('Folio 集成验证'));
  check('Editable paper metadata and tags persist');
  await page.getByRole('button',{name:'阅读布局',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'横向分割 · 上下',exact:false}).click();
  await page.getByRole('combobox',{name:'下方 PDF'}).selectOption(ws.documents[0].id);
  // Selecting a different PDF persists layout asynchronously. Old text stays
  // visible until the new pane mounts; wait for its identity and loaded pages.
  await page.waitForFunction(({name,pages})=>{
    const pane=document.querySelectorAll('.pdf-pane')[1];
    return pane?.getAttribute('aria-label')===name&&pane.querySelector('form>span')?.textContent?.trim()===`/ ${pages}`&&pane.querySelector('.textLayer span')&&!pane.querySelector('button[aria-label="下一页"]')?.disabled;
  },{name:`${ws.documents[0].name} 阅读器`,pages:ws.documents[0].pageCount});
  const topInput=page.locator('.pdf-pane').nth(0).getByRole('textbox',{name:'当前页码'});
  const bottomInput=page.locator('.pdf-pane').nth(1).getByRole('textbox',{name:'当前页码'});
  await topInput.fill('2');await topInput.press('Enter');await bottomInput.fill('4');await bottomInput.press('Enter');
  await waitForAsync(page,async()=>{const w=(await window.folio.bootstrap()).workspaces[0];return w.layout.views?.left?.state.page===2&&w.layout.views?.right?.state.page===4;});
  assert.equal(await topInput.inputValue(),'2');assert.equal(await bottomInput.inputValue(),'4');
  const upper=await page.getByRole('region',{name:'上方阅读区'}).boundingBox();
  const lower=await page.getByRole('region',{name:'下方阅读区'}).boundingBox();
  assert.ok(upper.y+upper.height<=lower.y+2);assert.ok(Math.abs(upper.width-lower.width)<2);
  await page.screenshot({path:path.join(output,'06-horizontal-split.png')});
  await page.reload();await page.getByRole('button',{name:'打开 Folio 集成验证 · 双 PDF 阅读',exact:true}).click();
  await page.waitForFunction(()=>{const v=document.querySelectorAll('input[aria-label="当前页码"]');return v.length===2&&v[0].value==='2'&&v[1].value==='4';});
  check('Zotero-style horizontal split: same PDF has independent page positions restored after reopening');
  await page.getByRole('combobox',{name:'下方 PDF'}).selectOption(ws.documents[1].id);
  await page.waitForFunction(name=>document.querySelectorAll('.pdf-pane')[1]?.getAttribute('aria-label')===name,`${ws.documents[1].name} 阅读器`);
  await page.getByRole('button',{name:'阅读布局',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'纵向分割 · 左右',exact:false}).click();
  await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor();
  // Exercise export dialogs without opening system pickers during automation.
  const pdfOut=path.join(output,'exported-with-outline.pdf');
  await app.evaluate(({dialog},destination)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:destination});},pdfOut);
  ws=(await page.evaluate(()=>window.folio.bootstrap())).workspaces[0];
  await page.evaluate(async({workspaceId,documentId})=>{
    await window.folio.updateDocument(workspaceId,documentId,{outline:[{id:'edited',title:'编辑后的中文目录',page:2,children:[{id:'child',title:'子章节',page:3,children:[]}]}],annotations:[{id:'e2e-highlight',page:1,text:'Evidence',comment:'E2E 批注',color:'#ffda63',rects:[[58,650,200,664]],createdAt:Date.now()}]});
    await window.folio.exportPdf(workspaceId,documentId);
  },{workspaceId:ws.id,documentId:ws.documents[0].id});
  const exported=await PDFDocument.load(await readFile(pdfOut));assert.equal(exported.getPageCount(),4);
  const outlines=exported.catalog.lookup(PDFName.of('Outlines'),PDFDict);const first=outlines.lookup(PDFName.of('First'),PDFDict);assert.equal(first.get(PDFName.of('Title')).decodeText(),'编辑后的中文目录');
  assert.ok(exported.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray).size()>0);
  check('Export writes actual Unicode PDF bookmarks, nested outline and highlight annotations');
  const vault=path.join(userData,'Test Vault');await mkdir(vault);
  await page.evaluate(async(vaultPath)=>{const b=await window.folio.bootstrap();b.settings.vaultPath=vaultPath;b.settings.obsidianSubfolder='Papers';await window.folio.saveSettings(b.settings);},vault);
  const firstExport=await page.evaluate(id=>window.folio.exportMarkdown(id,'obsidian'),ws.id);
  const secondExport=await page.evaluate(id=>window.folio.exportMarkdown(id,'obsidian'),ws.id);
  assert.equal(firstExport.path,secondExport.path);assert.ok(secondExport.overwritten);assert.match(await readFile(firstExport.path,'utf8'),/E2E 阅读笔记/);
  check('Obsidian export is real, idempotent and includes notes');
  await page.reload();
  await page.getByRole('button',{name:'打开 Folio 集成验证 · 双 PDF 阅读',exact:true}).click();
  await page.locator('.textLayer span').first().waitFor();
  await openAssistant();
  await page.getByRole('tab',{name:'笔记',exact:true}).click();
  assert.match(await page.getByRole('textbox',{name:'个人阅读笔记'}).inputValue(),/E2E 阅读笔记/);
  check('Reload recovers documents, layout, edited outline and notes from disk');
  await page.getByRole('button',{name:'设置与连接',exact:false}).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({path:path.join(output,'03-deepseek-settings.png')});
  assert.ok(await page.getByText('Flash',{exact:true}).count());
  check('User-editable DeepSeek configuration screen renders');
  await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  const thirdPdf=await PDFDocument.create();thirdPdf.addPage().drawText('Additional supplementary evidence for background text indexing.');
  const thirdPath=path.join(userData,'Extra supplement.pdf');await writeFile(thirdPath,await thirdPdf.save());
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},thirdPath);
  await expandArticleNavigation();
  await page.getByRole('button',{name:'添加补充材料',exact:true}).click();
  await waitForAsync(page,async()=>{const w=(await window.folio.bootstrap()).workspaces[0];return w.documents.length===3&&w.documents.every(d=>d.textStatus==='ready');});
  check('Additional off-screen supplement is indexed automatically for AI context');
  await page.evaluate(async(url)=>{const b=await window.folio.bootstrap();b.settings.activeProvider='custom';b.settings.autoMemory=false;b.settings.providers.custom={id:'custom',baseURL:url,model:'local-integration-test',apiKey:'test-only-not-a-real-secret',maxTokens:2048};await window.folio.saveSettings(b.settings);},mockURL);
  await page.reload();
  await page.getByRole('button',{name:'打开 Folio 集成验证 · 双 PDF 阅读',exact:true}).click();
  await openAssistant();
  await page.getByRole('textbox',{name:'向 AI 提问'}).fill('对照所有补充材料，解释阅读清单。');
  await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await page.locator('.fl-message.assistant').filter({hasText:'这是本地模拟服务'}).waitFor();
  await waitForAsync(page,async()=>{const w=(await window.folio.bootstrap()).workspaces[0];return w.conversations.some(c=>c.messages.some(m=>m.role==='assistant'&&m.content.includes('本地模拟服务')));});
  assert.equal(requests.length,1);
  await writeFile(path.join(output,'mock-request.json'),JSON.stringify(requests[0],null,2));
  assert.ok(JSON.stringify(requests[0].messages).includes('Additional supplementary evidence'));
  await page.getByRole('link',{name:'Supplementary materials.pdf p.2',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('input[aria-label="当前页码"]')[1]?.value==='2');
  await page.screenshot({path:path.join(output,'05-ai-citations.png')});
  assert.equal(await page.locator('.fl-message.user').count(),1);
  check('Real IPC + encrypted settings + local SSE mock → one chat answer with all PDFs and clickable citation');
  const settingsDisk=await readFile(path.join(userData,'settings.json'),'utf8');assert.ok(!settingsDisk.includes('test-only-not-a-real-secret'));
  check('API key is encrypted on disk and never returned in bootstrap');
  assert.equal((await page.evaluate(()=>window.folio.bootstrap())).settings.providers.custom.apiKey,undefined);
  await page.getByRole('button',{name:'文献库',exact:true}).click();
  await page.screenshot({path:path.join(output,'04-library-with-paper.png')});
  const beforeRemoval=(await page.evaluate(()=>window.folio.bootstrap())).workspaces.find(item=>item.id===ws.id);
  // Grid-card removal controls become pointer-enabled only after hovering the
  // card. Model that user step before Playwright's click actionability check.
  await page.locator('.fl-workspace-card').filter({has:page.getByRole('button',{name:'移除 Folio 集成验证 · 双 PDF 阅读',exact:true})}).hover();
  await page.getByRole('button',{name:'移除 Folio 集成验证 · 双 PDF 阅读',exact:true}).click();
  await page.getByRole('button',{name:'确认移除',exact:true}).click();
  await waitForAsync(page,async()=>{const b=await window.folio.bootstrap();return b.workspaces.length===0&&b.removedWorkspaces.length===1;});
  await page.getByRole('button',{name:/^已移除文章/}).click();
  await page.getByRole('button',{name:'恢复 Folio 集成验证 · 双 PDF 阅读',exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'07-removed-articles.png')});
  await page.reload();
  await page.getByRole('button',{name:/^已移除文章/}).click();
  await page.getByRole('button',{name:'恢复 Folio 集成验证 · 双 PDF 阅读',exact:true}).click();
  await waitForAsync(page,async()=>{const b=await window.folio.bootstrap();return b.workspaces.length===1&&b.removedWorkspaces.length===0;});
  const afterRestore=(await page.evaluate(()=>window.folio.bootstrap())).workspaces[0];
  assert.equal(afterRestore.id,beforeRemoval.id);
  assert.equal(afterRestore.notes,beforeRemoval.notes);
  assert.deepEqual(afterRestore.documents,beforeRemoval.documents);
  assert.deepEqual(afterRestore.conversations,beforeRemoval.conversations);
  check('Removed article survives reload and restores PDFs, views, annotations, notes and conversations');
  // Create a disposable second article so permanent-deletion checks cannot affect
  // the first article used by the quit/save assertion below.
  await page.getByRole('button',{name:/^全部论文/}).click();
  await page.getByRole('button',{name:/^导入论文/}).first().click();
  await waitForAsync(page,async()=> (await window.folio.bootstrap()).workspaces.length===2);
  const disposable=(await page.evaluate(()=>window.folio.bootstrap())).workspaces.find(item=>item.id!==ws.id);
  await page.getByRole('button',{name:'文献库',exact:true}).click();
  await page.locator('.fl-workspace-card').filter({has:page.getByRole('button',{name:'移除 '+disposable.title,exact:true})}).hover();
  await page.getByRole('button',{name:'移除 '+disposable.title,exact:true}).click();
  await page.getByRole('button',{name:'确认移除',exact:true}).click();
  await waitForAsync(page,async()=> (await window.folio.bootstrap()).removedWorkspaces.length===1);
  await page.getByRole('button',{name:/^已移除文章/}).click();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async(...args)=>{const options=args.at(-1);return {response:options.cancelId??0,checkboxChecked:false};};});
  await page.getByRole('button',{name:'彻底删除 '+disposable.title,exact:true}).click();
  await page.getByRole('button',{name:'彻底删除 '+disposable.title,exact:true}).waitFor({state:'visible'});
  assert.equal((await page.evaluate(()=>window.folio.bootstrap())).removedWorkspaces.length,1);
  check('Cancelling permanent deletion keeps the removed article');
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async(...args)=>{const options=args.at(-1);const response=options.buttons.findIndex(text=>text.includes('彻底删除'));if(response<0)throw new Error('Permanent-delete confirmation lacks explicit destructive label');return {response,checkboxChecked:false};};});
  await page.getByRole('button',{name:'彻底删除 '+disposable.title,exact:true}).click();
  await waitForAsync(page,async()=> (await window.folio.bootstrap()).removedWorkspaces.length===0);
  await assert.rejects(readFile(path.join(userData,'Library','.trash',disposable.id,'workspace.json')),{code:'ENOENT'});
  assert.equal((await page.evaluate(()=>window.folio.bootstrap())).workspaces[0].id,ws.id);
  check('Explicitly confirmed deletion removes only the disposable article files');
  await page.getByRole('button',{name:/^全部论文/}).click();
  assert.deepEqual(failures,[]);check('No renderer JavaScript errors');
  await page.getByRole('button',{name:'打开 Folio 集成验证 · 双 PDF 阅读',exact:true}).click();
  await openAssistant();
  await page.getByRole('tab',{name:'笔记',exact:true}).click();
  await page.getByRole('textbox',{name:'个人阅读笔记'}).fill('Immediately before quit: 最新笔记不能丢失。');
  await app.close();app=null;
  const saved=JSON.parse(await readFile(path.join(userData,'Library',ws.id,'workspace.json'),'utf8'));
  assert.equal(saved.notes,'Immediately before quit: 最新笔记不能丢失。');
  check('Native quit handshake flushes latest notes before debounce expires');
  await writeFile(path.join(output,'e2e-report.json'),JSON.stringify({checks,failures,userData,executablePath:executablePath||'development Electron'},null,2));
  await Promise.all(['e2e-failure.json','e2e-failure.png'].map(name=>rm(path.join(output,name),{force:true})));
} catch(error) {
  if(app){const pages=app.windows();await pages[0]?.screenshot({path:path.join(output,'e2e-failure.png')}).catch(()=>{});}
  await writeFile(path.join(output,'e2e-failure.json'),JSON.stringify({checks,failures,error:String(error),userData},null,2));
  throw error;
} finally {if(app)await app.close();await new Promise(resolve=>mock.close(resolve));}
console.log(`${checks.length} integration checks passed. Screenshots: ${output}`);
