import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolated integration test of the actual UI. Native speech and AI are mocked
// at Electron IPC, so this test neither records audio nor contacts a provider.
const output=path.resolve(process.env.FOLIO_E2E_OUTPUT||'test-results/voice');
await mkdir(output,{recursive:true});
const userData=await mkdtemp(path.join(os.tmpdir(),'folio-voice-e2e-'));
const env={...process.env,FOLIO_USER_DATA:userData};
delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
let app,page; const checks=[],errors=[];
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const wait=async(fn,label)=>{const end=Date.now()+18000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw Error('Timed out: '+label);};
const control=()=>page.getByRole('region',{name:/^(语音对话控制|Voice conversation controls)$/});
const phase=value=>wait(async()=>await control().getAttribute('data-phase')===value,value);
const mockState=()=>app.evaluate(()=>{const v=globalThis.__folioVoiceTest;return {calls:v.calls,listening:v.listening,speaking:v.speaking,spoken:v.spoken,requests:v.requests};});

try{
  const executablePath=process.env.FOLIO_EXECUTABLE;
  app=await electron.launch({args:executablePath?[]:['.'],...(executablePath?{executablePath}:{}),env});
  page=await app.firstWindow();page.setDefaultTimeout(18000);
  page.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,1000));
  await page.getByRole('button',{name:'体验示例工作区',exact:true}).click();
  await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor();
  await wait(async()=>await page.evaluate(async()=>(await window.folio.bootstrap()).workspaces[0].documents.every(d=>d.textStatus==='ready')),'PDF indexing');
  // Missing-key start opens existing AI setup and never records audio.
  await page.getByRole('button',{name:'语音对话',exact:true}).click();
  await page.getByRole('combobox',{name:'语言 / Language',exact:true}).waitFor();
  await page.locator('.fl-settings-footer').getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'结束语音对话',exact:true}).click();
  pass('A voice request without an AI key opens setup before microphone activation');

  await app.evaluate(({ipcMain,BrowserWindow})=>{
    const bootstrap=ipcMain._invokeHandlers.get('folio:bootstrap');
    const v=globalThis.__folioVoiceTest={calls:[],requests:[],listening:null,speaking:null,text:'',spoken:'',mode:'normal',workspaces:new Map(),pending:new Map()};
    const send=(channel,event)=>BrowserWindow.getAllWindows()[0].webContents.send('folio:'+channel,event);
    const replace=(name,handler)=>{ipcMain.removeHandler('folio:'+name);ipcMain.handle('folio:'+name,handler);};
    replace('bootstrap',async(event,...args)=>{const data=await bootstrap(event,...args);data.settings.providers[data.settings.activeProvider].hasKey=true;data.workspaces=data.workspaces.map(ws=>v.workspaces.get(ws.id)||ws);return data;});
    replace('voice-capabilities',()=>({available:true,engine:'speech-analyzer',locales:['zh-CN','en-US'],voices:[{id:'com.apple.voice.test.zh',name:'中文测试',language:'zh-CN'},{id:'com.apple.voice.test.en',name:'English test',language:'en-US'}],needsModelDownload:v.mode==='download'}));
    replace('voice-listen',(_event,options)=>{
      v.calls.push(['listen',options]);v.listening=options.sessionId;v.text='';
      if(options.allowModelDownload)v.mode='normal';
      setTimeout(()=>send('voice',v.mode==='denied'?{sessionId:options.sessionId,type:'error',code:'microphone-denied'}:{sessionId:options.sessionId,type:'listening'}),15);
    });
    replace('voice-stop-listening',(_event,id)=>{v.calls.push(['stop-listening',id]);const text=v.listening===id?v.text:'';if(v.listening===id)v.listening=null;return {text};});
    replace('voice-speak',(_event,options)=>{assertUnused();v.calls.push(['speak',options]);v.speaking=options.sessionId;v.spoken=options.text;send('voice',{sessionId:options.sessionId,type:'speech-start'});});
    function assertUnused(){if(v.listening)throw Error('Microphone must stop before TTS');}
    replace('voice-stop-speaking',()=>{v.calls.push(['stop-speaking']);v.speaking=null;});
    replace('start-chat',async(event,request)=>{
      v.requests.push(request);const data=await bootstrap(event);const ws=structuredClone(v.workspaces.get(request.workspaceId)||data.workspaces.find(item=>item.id===request.workspaceId));
      const chat=ws.conversations.find(item=>item.id===request.conversationId);
      chat.messages.push({id:request.requestId+'-user',role:'user',content:request.prompt,source:request.source,createdAt:Date.now()});ws.updatedAt=Date.now();v.workspaces.set(ws.id,ws);
      const base={requestId:request.requestId,workspaceId:ws.id};send('chat',{...base,type:'status',workspace:structuredClone(ws)});
      const answer='补充图支持正文结论。这里是第二句解释。';
      const first=setTimeout(()=>send('chat',{...base,type:'delta',text:answer.slice(0,10)}),40);
      const saved=setTimeout(()=>{send('chat',{...base,type:'delta',text:answer.slice(10)});chat.messages.push({id:request.requestId+'-assistant',role:'assistant',content:answer,source:'voice',createdAt:Date.now()});ws.updatedAt=Date.now();v.workspaces.set(ws.id,ws);send('chat',{...base,type:'status',text:'回答已保存',workspace:structuredClone(ws)});},150);
      const done=setTimeout(()=>{v.pending.delete(request.requestId);send('chat',{...base,type:'done',workspace:structuredClone(ws)});},300);
      v.pending.set(request.requestId,{timers:[first,saved,done],base,ws});
    });
    replace('abort-chat',(_event,id)=>{const job=v.pending.get(id);if(job){job.timers.forEach(clearTimeout);v.pending.delete(id);send('chat',{...job.base,type:'done',interrupted:true,workspace:structuredClone(job.ws)});}});
  });
  await page.reload();
  await page.getByRole('button',{name:'打开 A workspace for a closer reading',exact:true}).click();
  await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor();
  // Preserve typed draft and PDF instances while voice runs behind a closed panel.
  if(await page.getByRole('button',{name:'阅读伙伴',exact:true}).getAttribute('aria-expanded')!=='true')await page.getByRole('button',{name:'阅读伙伴',exact:true}).click();
  await page.getByRole('textbox',{name:'向 AI 提问',exact:true}).fill('保留这段尚未发送的手写草稿');
  await page.getByRole('button',{name:'阅读伙伴',exact:true}).click();
  await page.evaluate(()=>{window.__voicePdfViews=[...document.querySelectorAll('.pdf-viewer-container')];});
  await page.getByRole('button',{name:'语音对话',exact:true}).click();await phase('listening');
  assert.equal(await page.locator('.assistant-shell').isVisible(),false);
  await app.evaluate(({BrowserWindow})=>{const v=globalThis.__folioVoiceTest;v.text='请解释正文和补充图的关系。';BrowserWindow.getAllWindows()[0].webContents.send('folio:voice',{sessionId:v.listening,type:'partial',text:v.text});});
  await phase('speaking');
  const first=await mockState();assert.equal(first.requests.length,1);assert.equal(first.requests[0].source,'voice');assert.equal(first.requests[0].voiceLocale,'zh-CN');assert.equal(first.listening,null);assert.equal(first.spoken,'补充图支持正文结论。这里是第二句解释。');
  await page.getByRole('button',{name:'阅读伙伴',exact:true}).click();
  await page.locator('.fl-user-message').filter({hasText:'请解释正文和补充图的关系。'}).waitFor();
  await page.locator('.fl-message.assistant').filter({hasText:first.spoken}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'向 AI 提问',exact:true}).inputValue(),'保留这段尚未发送的手写草稿');
  assert.ok(await page.evaluate(()=>window.__voicePdfViews.every((node,index)=>node===document.querySelectorAll('.pdf-viewer-container')[index])));
  await page.screenshot({path:path.join(output,'voice-chat-visible.png')});
  pass('Hidden-panel speech uses one chat history, preserves typed drafts and PDF panes, and stops the microphone before playback');
  await page.getByRole('button',{name:'阅读伙伴',exact:true}).click();
  await page.screenshot({path:path.join(output,'voice-panel-hidden.png')});
  await page.getByRole('button',{name:'打断并讲话',exact:true}).click();await phase('listening');
  const next=await mockState();assert.notEqual(next.listening,first.calls.find(call=>call[0]==='listen')[1].sessionId);assert.equal(next.speaking,null);
  pass('Interrupt stops playback and starts a fresh listening session');
  await page.getByRole('button',{name:'暂停聆听',exact:true}).click();await phase('paused');assert.equal((await mockState()).listening,null);
  await page.getByRole('button',{name:'语音选项',exact:true}).click();
  await page.getByRole('combobox',{name:'语音语言',exact:true}).selectOption('en-US');
  await page.getByRole('combobox',{name:'朗读速度',exact:true}).selectOption('0.45');
  await page.getByRole('button',{name:'继续聆听',exact:true}).click();await phase('listening');
  assert.equal((await mockState()).calls.filter(call=>call[0]==='listen').at(-1)[1].locale,'en-US');
  await page.getByRole('button',{name:'结束语音对话',exact:true}).click();await control().waitFor({state:'detached'});assert.equal((await mockState()).listening,null);
  pass('Pause releases audio, language and speed can change, and ending removes the controls');

  await app.evaluate(()=>{globalThis.__folioVoiceTest.mode='download';});
  const countBefore=(await mockState()).calls.filter(call=>call[0]==='listen').length;
  await page.getByRole('button',{name:'语音对话',exact:true}).click();await phase('download');
  assert.equal((await mockState()).calls.filter(call=>call[0]==='listen').length,countBefore);
  await page.getByRole('button',{name:'下载模型并开始',exact:true}).click();await phase('listening');
  assert.equal((await mockState()).calls.filter(call=>call[0]==='listen').at(-1)[1].allowModelDownload,true);
  await page.getByRole('button',{name:'结束语音对话',exact:true}).click();
  pass('Missing models never trigger an automatic download or microphone start');
  await app.evaluate(()=>{globalThis.__folioVoiceTest.mode='denied';});
  await page.getByRole('button',{name:'语音对话',exact:true}).click();await phase('error');
  assert.match(await control().innerText(),/麦克风权限未开启/);
  await page.getByRole('button',{name:'结束语音对话',exact:true}).click();
  await app.evaluate(()=>{globalThis.__folioVoiceTest.mode='normal';});
  await page.getByRole('button',{name:'语音对话',exact:true}).click();await phase('listening');
  await page.getByRole('button',{name:'文献库',exact:true}).click();await control().waitFor({state:'detached'});
  await wait(async()=>(await mockState()).listening===null,'workspace switch releases microphone');
  pass('Permission denial has a readable error, and leaving the paper stops voice');
  assert.deepEqual(errors,[]);
}finally{
  if(app)await app.close();
  await writeFile(path.join(output,'report.json'),JSON.stringify({checks,errors,nativeAudioUsed:false,realAIUsed:false},null,2));
  await rm(userData,{recursive:true,force:true});
}
