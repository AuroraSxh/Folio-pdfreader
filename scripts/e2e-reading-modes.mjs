import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// UI contract tests with actual Electron/React/PDF rendering and controlled IPC.
// This does not test provider retrieval: pipeline tests cover that separately.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/reading-modes');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-reading-ui-'));
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const id = 'reading-mode-fixture', checks = [], errors = [];
const diagnostics = { stdout: [], stderr: [], rendererConsole: [], failedRequests: [], startupLog: '' };
let app, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const requests = () => app.evaluate(() => globalThis.__readingUITest.requests);
const modes = () => page.getByRole('group', { name: /^(AI 阅读方式|AI reading mode)$/ });
const smart = () => modes().getByRole('button', { name: /^(智能问答|Smart Q&A)$/ });
const deep = () => modes().getByRole('button', { name: /^(整篇精读|Full-paper reading)$/ });
const input = () => page.getByRole('textbox', { name: /^(向 AI 提问|Ask AI)$/ });
const coverage = kind => page.locator(`[data-message-id="${kind}"] .fl-reading-coverage`);
async function waitFor(predicate, label) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
}
async function emit(type, fields = {}) {
  await app.evaluate(({ BrowserWindow }, data) => {
    const request = globalThis.__readingUITest.requests.at(-1);
    BrowserWindow.getAllWindows()[0].webContents.send('folio:chat', { requestId: request.requestId, workspaceId: request.workspaceId, type: data.type, ...data.fields });
  }, { type, fields });
}
async function openCompanion() {
  await page.getByRole('button', { name: /^(打开|Open) Reading modes fixture$/ }).click();
  await page.locator('.pdf-pane .textLayer span').first().waitFor({ state: 'attached' });
  const toggle = page.getByRole('button', { name: /^(阅读伙伴|Reading companion)$/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const dock = page.getByRole('button', { name: /^(固定阅读伙伴|Pin reading companion)$/ });
  if (await dock.isVisible()) await dock.click();
}
async function seed() {
  const directory = path.join(profile, 'Library', id);
  await mkdir(path.join(directory, '.text'), { recursive: true });
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [];
  for (let index = 1; index <= 100; index++) {
    const page = pdf.addPage([600, 800]);
    if (index !== 100) page.drawText(`Synthetic reading fixture page ${index}`, { x: 40, y: 720, font, size: 16 });
    pages.push(index === 100 ? '' : `Synthetic reading fixture page ${index}.`);
  }
  const bytes = await pdf.save();
  await writeFile(path.join(directory, 'Main.pdf'), bytes);
  await writeFile(path.join(directory, '.text', 'main.json'), JSON.stringify(pages));
  const document = { id: 'main', name: 'Main.pdf', fileName: 'Main.pdf', role: 'main', size: bytes.length, pageCount: 100, outline: [], outlineLoaded: true, annotations: [], textStatus: 'ready', view: { page: 1, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0 } };
  const report = (mode, includedPages, complete) => ({ mode, complete, batches: mode === 'deep' ? 5 : undefined, cachedBatches: mode === 'deep' ? 2 : undefined, documents: [{ documentId: 'main', name: 'Main.pdf', totalPages: 100, readablePages: 99, includedPages, unavailablePages: [100] }] });
  const now = Date.now();
  const smartReport = report('smart', [60, 61], false);
  const completeReport = report('deep', Array.from({ length: 99 }, (_, index) => index + 1), true);
  const partialReport = report('deep', Array.from({ length: 30 }, (_, index) => index + 1), false);
  const messages = [['smart-answer', 'A saved answer from retrieved excerpts.', smartReport], ['complete-answer', 'A saved summary of all available text.', completeReport], ['partial-answer', 'A stopped reading with partial coverage.', partialReport]].flatMap(([messageId, content, reading], index) => [
    { id: messageId + '-user', role: 'user', content: 'Fixture question ' + index, createdAt: now + index * 2 },
    { id: messageId, role: 'assistant', content, reading, createdAt: now + index * 2 + 1 },
  ]);
  const workspace = { version: 1, id, title: 'Reading modes fixture', titleStatus: 'confirmed', authors: '', journal: '', doi: '', tags: [], favorite: false, createdAt: now, updatedAt: now, lastReadAt: now,
    documents: [document], notes: '', summary: { content: 'Saved summary.', provider: 'deepseek', model: 'fixture-model', createdAt: now, reading: completeReport }, memories: [], memoryIndex: '',
    conversations: [{ id: 'chat', title: 'Reading mode checks', createdAt: now, messages }], activeConversationId: 'chat', layout: { split: false, leftId: 'main', rightId: '', ratio: 50 } };
  await writeFile(path.join(directory, 'workspace.json'), JSON.stringify(workspace));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {} }));
}

try {
  await seed();
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  const collect = target => chunk => { target.push(String(chunk)); if (target.length > 100) target.shift(); };
  app.process().stdout?.on('data', collect(diagnostics.stdout));
  app.process().stderr?.on('data', collect(diagnostics.stderr));
  page = await app.firstWindow(); page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) { diagnostics.rendererConsole.push(message.text()); if (diagnostics.rendererConsole.length > 100) diagnostics.rendererConsole.shift(); } });
  page.on('requestfailed', request => diagnostics.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  // firstWindow resolves before createWindow's initial loadFile has finished.
  // Reloading at that point can cancel startup and trigger the native error box.
  await page.getByRole('button', { name: /^(打开|Open) Reading modes fixture$/ }).waitFor();
  await page.waitForLoadState('load');
  await waitFor(async () => /\bready\r?\n/.test(await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => '')), 'main process finished initial startup');
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1640, 1060);
    if (process.env.FOLIO_E2E_HIDE_WINDOW === '1') { window.setFocusable(false); window.hide(); }
    const state = globalThis.__readingUITest = { requests: [], aborted: [], voiceCalls: [], listening: null, voiceText: '' };
    const bootstrap = ipcMain._invokeHandlers.get('folio:bootstrap');
    const replace = (name, action) => { ipcMain.removeHandler('folio:' + name); ipcMain.handle('folio:' + name, action); };
    replace('bootstrap', async (...args) => { const result = await bootstrap(...args); result.settings.providers[result.settings.activeProvider].hasKey = true; return result; });
    replace('start-chat', (_event, request) => { state.requests.push(request); });
    replace('abort-chat', (_event, requestId) => {
      state.aborted.push(requestId);
      const request = state.requests.find(item => item.requestId === requestId);
      if (request) window.webContents.send('folio:chat', { type: 'done', requestId, workspaceId: request.workspaceId, interrupted: true });
    });
    replace('voice-capabilities', () => { state.voiceCalls.push('capabilities'); return { available: true, engine: 'speech-analyzer', locales: ['zh-CN', 'en-US'], voices: [] }; });
    replace('voice-listen', (_event, options) => { state.voiceCalls.push('listen'); state.listening = options.sessionId; state.voiceText = ''; setTimeout(() => window.webContents.send('folio:voice', { type: 'listening', sessionId: options.sessionId }), 10); });
    replace('voice-stop-listening', () => { state.voiceCalls.push('stop-listening'); state.listening = null; return { text: state.voiceText }; });
    replace('voice-stop-speaking', () => { state.voiceCalls.push('stop-speaking'); });
    replace('voice-speak', () => { throw new Error('No native speech playback belongs in this UI test'); });
  });
  // Re-bootstrap through the actual preload to install the key-free UI fixture.
  await page.reload(); await openCompanion();
  assert.equal(await smart().getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: '发送问题', exact: true }).isDisabled(), true);
  await coverage('smart-answer').locator('summary').click();
  assert.match(await coverage('smart-answer').innerText(), /引用片段涉及 2\/100 页/);
  assert.match(await coverage('smart-answer').innerText(), /未将每一页全文发送/);
  assert.match(await coverage('smart-answer').innerText(), /60–61/);
  await coverage('complete-answer').locator('summary').click();
  assert.match(await coverage('complete-answer').innerText(), /1–99/);
  assert.match(await coverage('complete-answer').innerText(), /无可提取文字：100/);
  assert.match(await coverage('complete-answer').innerText(), /复用了 2 段/);
  await coverage('partial-answer').locator('summary').click();
  assert.match(await coverage('partial-answer').innerText(), /精读尚未完成/);
  pass('Saved smart, complete deep, and partial deep answers expose compact and honest page coverage, including unreadable pages');

  await input().fill('Explain the result on page 60.');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await waitFor(async () => (await requests()).length === 1, 'smart request');
  assert.equal((await requests())[0].readingMode, 'smart');
  assert.equal((await requests())[0].kind, 'chat');
  assert.equal(await deep().isDisabled(), true);
  await emit('status', { progress: { phase: 'searching', completed: 0, total: 100 } });
  await page.locator('.fl-reading-progress').filter({ hasText: '正在全文中寻找相关片段' }).waitFor();
  await emit('error', { text: 'Controlled request failure for retry verification.' });
  await deep().click();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitFor(async () => (await requests()).length === 2, 'retry request');
  assert.equal((await requests())[1].readingMode, 'smart');
  assert.equal((await requests())[1].prompt, (await requests())[0].prompt);
  await emit('done');
  pass('Smart is the default, progress follows events, and retry preserves the original mode after the selector changes');

  assert.equal(await input().inputValue(), '');
  assert.equal(await page.getByRole('button', { name: '开始整篇精读', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '开始整篇精读', exact: true }).click();
  await waitFor(async () => (await requests()).length === 3, 'empty deep request');
  assert.equal((await requests())[2].readingMode, 'deep');
  assert.equal((await requests())[2].kind, 'summary');
  assert.ok((await requests())[2].prompt.trim());
  await emit('status', { progress: { phase: 'reading', completed: 2, total: 5, cached: 1 } });
  const progress = page.getByRole('progressbar', { name: '整篇精读进度', exact: true });
  await progress.waitFor(); assert.equal(await progress.getAttribute('value'), '2'); assert.equal(await progress.getAttribute('max'), '5');
  await page.screenshot({ path: path.join(output, 'deep-reading-progress-zh.png') });
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await waitFor(async () => (await app.evaluate(() => globalThis.__readingUITest.aborted)).length === 1, 'deep request cancellation');
  pass('Empty full-paper reading starts a summary, exposes accessible batch progress and cache counts, and can be stopped');

  await input().fill('Compare the methods throughout the selected paper.');
  await page.getByRole('combobox', { name: 'AI 引用文档范围', exact: true }).selectOption('main');
  await page.getByRole('button', { name: '开始整篇精读', exact: true }).click();
  await waitFor(async () => (await requests()).length === 4, 'question-specific deep request');
  assert.equal((await requests())[3].kind, 'chat');
  assert.equal((await requests())[3].readingMode, 'deep');
  assert.deepEqual((await requests())[3].documentIds, ['main']);
  await emit('done');
  await smart().click();
  await page.getByRole('tab', { name: '笔记', exact: true }).click();
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  await waitFor(async () => (await requests()).length === 5, 'summary request');
  assert.equal((await requests())[4].readingMode, 'deep');
  assert.equal((await requests())[4].kind, 'summary');
  await emit('done');
  pass('Deep questions keep the selected document scope; the existing summary action always requests deep reading');

  if (process.platform === 'darwin' || process.platform === 'win32') {
    await deep().click();
    await page.getByRole('button', { name: '语音对话', exact: true }).click();
    const voice = page.getByRole('region', { name: '语音对话控制', exact: true });
    await waitFor(async () => await voice.getAttribute('data-phase') === 'paused', 'voice configured');
    await page.getByRole('button', { name: /^(开始聆听|继续聆听)$/ }).click();
    await waitFor(async () => await voice.getAttribute('data-phase') === 'listening', 'mock voice listening');
    await app.evaluate(({ BrowserWindow }) => {
      const state = globalThis.__readingUITest; state.voiceText = '请解释第六十页的结果。';
      BrowserWindow.getAllWindows()[0].webContents.send('folio:voice', { type: 'partial', sessionId: state.listening, text: state.voiceText });
    });
    await waitFor(async () => (await requests()).length === 6, 'voice request');
    assert.equal((await requests())[5].source, 'voice');
    assert.equal((await requests())[5].readingMode, 'smart');
    assert.equal((await requests())[5].kind, 'chat');
    await page.getByRole('button', { name: '结束语音对话', exact: true }).click();
    await voice.waitFor({ state: 'detached' });
    pass('Voice questions remain smart even when the typed composer selects deep reading; all speech calls are mocked');
  }

  await page.evaluate(async () => { const data = await window.folio.bootstrap(); await window.folio.saveSettings({ ...data.settings, language: 'en', uiFontScale: 1.5 }); });
  await page.reload(); await openCompanion();
  assert.equal(await smart().getAttribute('aria-pressed'), 'true');
  await deep().focus(); await page.keyboard.press('Enter');
  assert.equal(await deep().getAttribute('aria-pressed'), 'true');
  await coverage('partial-answer').locator('summary').click();
  assert.match(await coverage('partial-answer').innerText(), /not a complete paper summary/);
  await coverage('complete-answer').locator('summary').click();
  assert.match(await coverage('complete-answer').innerText(), /Scanned images and image details were not read/);
  const fits = await modes().evaluate(element => { const box = element.getBoundingClientRect(), panel = element.closest('.fl-assistant').getBoundingClientRect(); return box.left >= panel.left && box.right <= panel.right; });
  assert.equal(fits, true);
  await page.screenshot({ path: path.join(output, 'reading-modes-english-150.png') });
  pass('Mode controls support keyboard activation, English copy and 150% UI text without exceeding the assistant width');
  assert.deepEqual(errors, []);
  pass('No renderer errors, provider network requests, or real microphone activity');
} catch (error) {
  errors.push(error.stack || String(error));
  await page?.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(cause => diagnostics.rendererConsole.push('Failure screenshot unavailable: ' + cause.message));
  throw error;
} finally {
  diagnostics.startupLog = await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => 'No startup log was written.');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, diagnostics }, null, 2));
  if (app) await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
