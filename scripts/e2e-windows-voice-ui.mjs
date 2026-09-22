import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Simulated Windows renderer test. It runs the production web bundle with a
// controlled window.folio API; no Windows runtime, native speech, microphone,
// AI service, installed app, or user library is involved.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/windows-voice-ui');
const dist = path.resolve(process.env.FOLIO_DIST || 'dist');
await mkdir(output, { recursive: true });
await stat(path.join(dist, 'index.html'));
const checks = [], errors = [], snapshots = [];
let browser, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const filename = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(dist + path.sep)) { response.writeHead(403); response.end(); return; }
    const data = await readFile(filename);
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' }); response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage([600, 760]).drawText('Pairleaf Windows voice UI fixture. Simulated speech only.', { x: 35, y: 710, size: 12, font });
const pdfBytes = Array.from(await pdf.save());
const control = () => page.getByRole('region', { name: /^(语音对话控制|Voice conversation controls)$/ });
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
};
const phase = value => waitFor(async () => await control().getAttribute('data-phase') === value, value);
const audit = () => page.evaluate(() => {
  const mock = window.__windowsVoiceUI;
  return { calls: mock.calls, requests: mock.requests, listening: mock.listening, speaking: mock.speaking, lastSpeech: mock.lastSpeech };
});
async function openPaper() {
  await page.getByRole('button', { name: /^(打开|Open) Windows voice UI fixture$/ }).click();
  await page.locator('.pdf-pane .textLayer span').first().waitFor();
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.FOLIO_BROWSER_EXECUTABLE ? { executablePath: process.env.FOLIO_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.addInitScript(({ pdfBytes }) => {
    const clone = value => structuredClone(value);
    const persisted = JSON.parse(localStorage.getItem('pairleaf.test.windows-voice-ui') || '{}');
    const listeners = Object.fromEntries(['voice', 'chat', 'open', 'command', 'update', 'close'].map(name => [name, new Set()]));
    const subscribe = name => callback => { listeners[name].add(callback); return () => listeners[name].delete(callback); };
    const settings = { language: persisted.language || 'zh-CN', activeProvider: 'deepseek',
      providers: Object.fromEntries(['deepseek', 'openai', 'anthropic', 'custom'].map(id => [id, { id, baseURL: 'http://127.0.0.1', model: 'fixture', maxTokens: 1024, hasKey: Boolean(persisted.hasKey) }])),
      libraryPath: 'C:\\Isolated UI Fixture', vaultPath: '', obsidianSubfolder: 'Papers', autoSummary: false, autoMemory: false, autoCheckUpdates: false,
      contextMaxChars: 10000, theme: 'light', readingTheme: 'white', annotationToolbar: 'floating' };
    const workspace = { version: 1, id: 'windows-ui-fixture', title: 'Windows voice UI fixture', authors: '', journal: '', doi: '', tags: [], favorite: false,
      createdAt: 1, updatedAt: 1, lastReadAt: 1, notes: '', memories: [], memoryIndex: '',
      documents: [{ id: 'fixture-pdf', name: 'Fixture.pdf', fileName: 'fixture.pdf', role: 'main', size: pdfBytes.length, pageCount: 1, outline: [], outlineLoaded: true, annotations: [], textStatus: 'ready', view: { page: 1, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0 } }],
      conversations: [{ id: 'fixture-chat', title: 'Fixture chat', createdAt: 1, messages: [] }], activeConversationId: 'fixture-chat',
      layout: { split: false, leftId: 'fixture-pdf', rightId: '', ratio: 50 } };
    const mock = window.__windowsVoiceUI = { settings, workspace, available: false, listenError: undefined, calls: [], requests: [], listening: null, speaking: null, lastSpeech: null,
      emitVoice: event => { for (const callback of listeners.voice) callback(event); },
      persist: () => localStorage.setItem('pairleaf.test.windows-voice-ui', JSON.stringify({ language: settings.language, hasKey: settings.providers.deepseek.hasKey })) };
    const changed = () => { workspace.updatedAt = Math.max(Date.now(), workspace.updatedAt + 1); return clone(workspace); };
    window.folio = {
      platform: 'win32',
      bootstrap: async () => ({ settings: clone(settings), workspaces: [clone(workspace)], removedWorkspaces: [], version: '0.5.0' }),
      updateWorkspace: async (_id, patch) => { Object.assign(workspace, patch); return changed(); },
      updateDocument: async (_id, documentId, patch) => { Object.assign(workspace.documents.find(doc => doc.id === documentId), patch); return changed(); },
      updateView: async (_id, documentId, pane, view) => { workspace.layout.views ||= {}; workspace.layout.views[pane] = { documentId, state: clone(view) }; return changed(); },
      readDocument: async () => new Uint8Array(pdfBytes),
      indexDocument: async (_id, documentId, index) => { const doc = workspace.documents.find(item => item.id === documentId); doc.pageCount = index.pageCount; doc.textStatus = 'ready'; return changed(); },
      getDocumentEditHistory: async () => ({ canUndo: false, canRedo: false }),
      saveSettings: async value => { Object.assign(settings, clone(value)); mock.persist(); return clone(settings); },
      getUpdateStatus: async () => ({ phase: 'idle', currentVersion: '0.5.0' }),
      voiceCapabilities: async locale => { mock.calls.push(['capabilities', locale]); return { available: mock.available, engine: 'windows-speech', reason: mock.available ? undefined : 'recognizer-unavailable', locales: mock.available ? ['zh-CN', 'en-US'] : [], voices: [
        { id: 'windows.sapi.1111111111111111111111111111111111111111111111111111111111111111', name: 'Microsoft Huihui Desktop', language: 'zh-CN', quality: 'default' },
        { id: 'windows.sapi.2222222222222222222222222222222222222222222222222222222222222222', name: 'Microsoft Zira Desktop', language: 'en-US', quality: 'default' },
      ] }; },
      voiceSpeak: async options => { mock.calls.push(['speak', options]); mock.lastSpeech = clone(options); mock.speaking = options.sessionId; mock.emitVoice({ type: 'speech-start', sessionId: options.sessionId }); },
      voiceStopSpeaking: async () => { mock.calls.push(['stop-speaking']); mock.speaking = null; },
      voiceListen: async options => { mock.calls.push(['listen', options]); mock.listening = options.sessionId; setTimeout(() => mock.emitVoice(mock.listenError ? { type: 'error', sessionId: options.sessionId, code: mock.listenError } : { type: 'listening', sessionId: options.sessionId }), 10); },
      voiceStopListening: async sessionId => { mock.calls.push(['stop-listening', sessionId]); if (mock.listening === sessionId) mock.listening = null; return { text: '' }; },
      startChat: async request => { mock.requests.push(request); throw new Error('This simulated UI test must never submit an AI request'); },
      abortChat: async () => {},
      onVoice: subscribe('voice'), onChat: subscribe('chat'), onOpen: subscribe('open'), onCommand: subscribe('command'), onUpdate: subscribe('update'), onPrepareClose: subscribe('close'),
    };
  }, { pdfBytes });
  page = await context.newPage(); page.setDefaultTimeout(16000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  assert.match(await page.title(), /Pairleaf/);
  assert.equal(await page.locator('.profile-avatar').innerText(), 'P');
  await openPaper();
  assert.equal(await page.locator('[data-platform="win32"]').count(), 1);
  assert.equal(await control().count(), 0);
  assert.deepEqual((await audit()).calls, []);
  pass('The Pairleaf Windows interface exposes voice controls without activating speech on startup');

  await page.getByRole('button', { name: '语音对话', exact: true }).click(); await phase('paused');
  assert.match(await control().innerText(), /实验性.*本机语音引擎/);
  assert.match(await control().innerText(), /本地识别当前不可用/);
  assert.doesNotMatch(await control().innerText(), /Apple|增强／高级音色/);
  await page.getByRole('combobox', { name: '中文音色', exact: true }).selectOption('windows.sapi.1111111111111111111111111111111111111111111111111111111111111111');
  await page.getByRole('combobox', { name: '英文音色', exact: true }).selectOption('windows.sapi.2222222222222222222222222222222222222222222222222222222222222222');
  await page.getByRole('button', { name: '试听音色', exact: true }).click(); await phase('previewing');
  const preview = await audit();
  assert.equal(preview.requests.length, 0); assert.equal(preview.listening, null);
  assert(preview.lastSpeech.segments.some(segment => segment.voiceId === 'windows.sapi.2222222222222222222222222222222222222222222222222222222222222222'));
  assert(preview.lastSpeech.segments.some(segment => segment.voiceId === 'windows.sapi.1111111111111111111111111111111111111111111111111111111111111111'));
  await page.evaluate(() => { const mock = window.__windowsVoiceUI; const sessionId = mock.speaking; mock.speaking = null; mock.emitVoice({ type: 'speech-end', sessionId }); });
  await phase('paused'); assert.equal((await audit()).listening, null);
  await page.screenshot({ path: path.join(output, 'windows-voice-no-recognizer-zh.png') });
  pass('No-key preview uses available Windows voices even when recognition is unavailable, without Apple download prompts');

  await control().locator('summary').filter({ hasText: '语音使用教程' }).click();
  assert.match(await control().innerText(), /桌面应用访问/);
  assert.match(await control().innerText(), /安装语言组件也不保证可用/);
  assert.match(await control().innerText(), /讲述人的自然语音不保证/);
  assert.doesNotMatch(await control().innerText(), /系统声音.*ⓘ|月／黎潋/);
  snapshots.push(await audit());
  pass('Windows guidance explains local engine limits, desktop microphone permissions, and the actual voice list');

  await page.evaluate(() => { const mock = window.__windowsVoiceUI; mock.settings.providers.deepseek.hasKey = true; mock.persist(); });
  await page.reload(); await openPaper();
  assert.equal(await control().count(), 0);
  await page.getByRole('button', { name: '语音对话', exact: true }).click(); await phase('paused');
  await page.getByRole('button', { name: '开始聆听', exact: true }).click(); await phase('error');
  assert.match(await control().innerText(), /未找到.*本地识别引擎/);
  assert.equal((await audit()).calls.filter(call => call[0] === 'listen').length, 0);
  pass('An unavailable Windows recognizer is reported before any simulated microphone activation');

  await page.evaluate(() => { window.__windowsVoiceUI.available = true; });
  await page.getByRole('button', { name: '重试语音', exact: true }).click(); await phase('listening');
  assert.equal(await control().locator('.fl-voice-options').count(), 0);
  await page.getByRole('button', { name: '暂停聆听', exact: true }).click(); await phase('paused');
  assert.equal((await audit()).listening, null);
  await page.evaluate(() => { window.__windowsVoiceUI.listenError = 'microphone-denied'; });
  await page.getByRole('button', { name: '开始聆听', exact: true }).click(); await phase('error');
  assert.match(await control().innerText(), /Windows 11.*桌面应用访问/);
  assert.doesNotMatch(await control().innerText(), /Apple|macOS|隐私与安全性/);
  snapshots.push(await audit());
  pass('Simulated Windows listening, pause, and microphone denial use platform-specific controls and messages');

  await page.evaluate(() => { const mock = window.__windowsVoiceUI; mock.settings.language = 'en'; mock.persist(); });
  await page.reload(); await openPaper();
  await page.getByRole('button', { name: 'Voice conversation', exact: true }).click(); await phase('paused');
  assert.equal(await page.getByRole('combobox', { name: 'Chinese voice', exact: true }).inputValue(), 'windows.sapi.1111111111111111111111111111111111111111111111111111111111111111');
  assert.equal(await page.getByRole('combobox', { name: 'English voice', exact: true }).inputValue(), 'windows.sapi.2222222222222222222222222222222222222222222222222222222222222222');
  await control().locator('summary').filter({ hasText: 'Voice tutorial' }).click();
  assert.match(await control().innerText(), /Windows local speech.*experimental/i);
  assert.match(await control().innerText(), /desktop app access/);
  assert.match(await control().innerText(), /Narrator natural voices may not be available/);
  assert.doesNotMatch(await control().innerText(), /Apple|Premium|Enhanced/);
  await page.screenshot({ path: path.join(output, 'windows-voice-guide-en.png') });
  snapshots.push(await audit());
  assert(snapshots.every(snapshot => snapshot.requests.length === 0));
  assert.deepEqual(errors, []);
  pass('English Windows guidance and saved voices remain available after reload while voice stays off by default');
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, simulatedPlatform: 'win32', realWindowsRuntimeTested: false, nativeAudioUsed: false, realAIUsed: false, snapshots }, null, 2));
}
