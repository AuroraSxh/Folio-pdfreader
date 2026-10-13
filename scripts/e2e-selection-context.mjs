import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Actual PDF mouse selection, React state, preload, and annotation persistence.
// AI and speech IPC are mocked: no real key, provider call, or microphone use.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/selection-context');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-selection-e2e-'));
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const workspaceId = 'selection-context-fixture';
const checks = [], errors = [], recorded = [];
const diagnostics = { stderr: [], startupLog: '' };
let app, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const requests = () => app.evaluate(() => globalThis.__selectionContextTest.requests);
const workspace = async () => (await page.evaluate(() => window.folio.bootstrap())).workspaces.find(item => item.id === workspaceId);
const pane = side => page.locator('.pdf-pane').nth(side);
const card = () => page.locator('.fl-selection-context');
const composer = () => page.getByRole('textbox', { name: '向 AI 提问', exact: true });
const sources = () => page.getByRole('combobox', { name: 'AI 引用文档范围', exact: true });
const mode = kind => page.getByRole('group', { name: 'AI 阅读方式', exact: true }).getByRole('button', { name: kind === 'deep' ? '整篇精读' : '智能问答', exact: true });
const toolbar = () => page.getByRole('toolbar', { name: '文字与批注工具', exact: true });
async function waitFor(predicate, description, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + description);
}
async function seed() {
  const directory = path.join(profile, 'Library', workspaceId);
  await mkdir(path.join(directory, '.text'), { recursive: true });
  const documents = [];
  for (const [id, name, role, lines] of [
    ['main', 'Main.pdf', 'main', ['Main passage alpha connects macrophages with immune memory.', 'Main passage beta measures receptor activity after treatment.']],
    ['supplement', 'Supplement.pdf', 'supplement', ['Supplement passage gamma compares independent control groups.', 'Supplement passage delta reports the validation methods.']],
  ]) {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = [];
    for (let number = 1; number <= 3; number++) {
      const sheet = pdf.addPage([620, 820]);
      sheet.drawText(`${id} fixture page ${number}`, { x: 45, y: 755, size: 15, font });
      lines.forEach((text, index) => sheet.drawText(text, { x: 45, y: 690 - index * 42, size: 13, font }));
      sheet.drawText('Local synthetic PDF data for mouse selection testing.', { x: 45, y: 570, size: 11, font });
      pages.push(lines.join('\n'));
    }
    const bytes = await pdf.save();
    await writeFile(path.join(directory, name), bytes);
    await writeFile(path.join(directory, '.text', id + '.json'), JSON.stringify(pages));
    documents.push({ id, name, fileName: name, role, size: bytes.length, pageCount: 3, outline: [], outlineLoaded: true, textStatus: 'ready', annotations: [], view: { page: 1, scale: '0.85', rotation: 0, scrollMode: 0, spreadMode: 0 } });
  }
  const now = Date.now();
  const value = { version: 1, id: workspaceId, title: 'Selection context fixture', titleStatus: 'confirmed', authors: '', journal: '', doi: '', tags: [], favorite: false, createdAt: now, updatedAt: now, lastReadAt: now,
    documents, notes: '', memories: [], memoryIndex: '', conversations: [{ id: 'chat', title: 'Selection checks', createdAt: now, messages: [] }], activeConversationId: 'chat',
    layout: { split: true, direction: 'vertical', leftId: 'main', rightId: 'supplement', ratio: 50 } };
  await writeFile(path.join(directory, 'workspace.json'), JSON.stringify(value));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {} }));
}
async function openReader() {
  await page.getByRole('button', { name: '打开 Selection context fixture', exact: true }).click();
  await pane(1).locator('.textLayer span').first().waitFor({ state: 'attached' });
  const toggle = page.getByRole('button', { name: '阅读伙伴', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const dock = page.getByRole('button', { name: '固定阅读伙伴', exact: true });
  if (await dock.isVisible()) await dock.click();
  await page.locator('.assistant-shell.is-docked').waitFor();
}
async function selectPassage(side, number, prefix) {
  const current = pane(side).getByRole('textbox', { name: '当前页码', exact: true });
  if (await current.inputValue() !== String(number)) { await current.fill(String(number)); await current.press('Enter'); }
  const text = pane(side).locator(`.page[data-page-number="${number}"] .textLayer span`).filter({ hasText: prefix }).first();
  await text.waitFor({ state: 'attached' });
  await pane(side).locator('.pdf-viewer-container').click({ position: { x: 8, y: 12 } });
  let target, previous, stableSince = Date.now();
  await waitFor(async () => {
    const box = await text.boundingBox();
    const viewport = await pane(side).locator('.pdf-viewer-container').boundingBox();
    const usable = box && viewport && box.width > 120 && box.height > 6 && box.x > viewport.x && box.x + box.width < viewport.x + viewport.width - 4 && box.y > viewport.y + 8 && box.y + box.height < viewport.y + viewport.height - 12;
    if (!usable || JSON.stringify(previous) !== JSON.stringify(box)) { previous = box; stableSince = Date.now(); return false; }
    target = box; return Date.now() - stableSince > 250;
  }, 'PDF selection geometry settles');
  await page.mouse.move(target.x + 0.5, target.y + target.height * .5);
  await page.waitForTimeout(40);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(target.x + 0.5 + (target.width - 1) * step / 10, target.y + target.height * .5);
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
  await waitFor(async () => (await page.evaluate(() => window.getSelection()?.toString().trim() ?? '')).length > 25, 'native PDF text selection');
  const selected = await page.evaluate(() => window.getSelection().toString().trim());
  assert.match(selected, new RegExp(prefix));
  await waitFor(async () => await card().count() === 1 && (await card().locator('blockquote').textContent()).trim() === selected, 'selected PDF passage becomes the AI reference card');
  assert.match(await card().innerText(), new RegExp(`${side === 0 ? 'Main' : 'Supplement'}\\.pdf`));
  assert.match(await card().innerText(), new RegExp(`第 ${number} 页`));
  return selected;
}
async function focusAndType(text, expectedSelection) {
  await composer().click(); await composer().fill(text);
  await page.waitForTimeout(220); // Allow PDF selectionchange listeners to settle after composer focus.
  assert.equal(await composer().inputValue(), text);
  assert.equal((await card().locator('blockquote').textContent()).trim(), expectedSelection);
}
async function send(kind, expectedCount) {
  await page.getByRole('button', { name: kind === 'deep' ? '开始整篇精读' : '发送问题', exact: true }).click();
  await waitFor(async () => (await requests()).length === expectedCount, 'AI request recorded');
  const request = (await requests()).at(-1); recorded.push(request);
  return request;
}
async function finish(type = 'done') {
  await app.evaluate(({ BrowserWindow }, type) => {
    const request = globalThis.__selectionContextTest.requests.at(-1);
    BrowserWindow.getAllWindows()[0].webContents.send('folio:chat', { requestId: request.requestId, workspaceId: request.workspaceId, type, ...(type === 'error' ? { text: 'Controlled failure to check retry context.' } : {}) });
  }, type);
  await waitFor(async () => await mode('smart').isEnabled(), 'request completion reaches UI');
}
function expectSelection(request, { documentId, page: number, text }) {
  assert.equal(request.selection?.documentId, documentId);
  assert.equal(request.selection?.documentName, documentId === 'main' ? 'Main.pdf' : 'Supplement.pdf');
  assert.equal(request.selection?.page, number);
  assert.equal(request.selection?.text, text);
  assert.ok(request.selection.rects.length > 0, 'A mouse selection should retain its PDF rectangles');
}

try {
  await seed();
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  app.process().stderr?.on('data', value => { diagnostics.stderr.push(String(value)); if (diagnostics.stderr.length > 80) diagnostics.stderr.shift(); });
  page = await app.firstWindow(); page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '打开 Selection context fixture', exact: true }).waitFor();
  await page.waitForLoadState('load');
  await waitFor(async () => /\bready\r?\n/.test(await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => '')), 'initial main startup completes before reload');
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1840, 1100);
    if (process.env.FOLIO_E2E_HIDE_WINDOW === '1') { window.setFocusable(false); window.hide(); }
    const state = globalThis.__selectionContextTest = { requests: [], forbidden: [] };
    const original = ipcMain._invokeHandlers.get('folio:bootstrap');
    const replace = (name, handler) => { ipcMain.removeHandler('folio:' + name); ipcMain.handle('folio:' + name, handler); };
    replace('bootstrap', async (...args) => { const data = await original(...args); data.settings.providers[data.settings.activeProvider].hasKey = true; return data; });
    replace('start-chat', (_event, request) => { state.requests.push(structuredClone(request)); });
    replace('abort-chat', (_event, requestId) => {
      const request = state.requests.find(item => item.requestId === requestId);
      if (request) window.webContents.send('folio:chat', { requestId, workspaceId: request.workspaceId, type: 'done', interrupted: true });
    });
    for (const name of ['voice-capabilities', 'voice-listen', 'voice-speak']) replace(name, () => { state.forbidden.push(name); throw new Error('Unexpected native voice request in selection test'); });
  });
  await page.reload(); await openReader();

  const mainAlpha = await selectPassage(0, 2, 'Main passage alpha');
  assert.equal(await toolbar().getByRole('button', { name: '复制选中文字', exact: true }).isEnabled(), true);
  await focusAndType('Please explain the highlighted passage.', mainAlpha);
  await page.screenshot({ path: path.join(output, 'main-selection-composer-focus.png') });
  const first = await send('smart', 1);
  assert.equal(first.readingMode, 'smart');
  expectSelection(first, { documentId: 'main', page: 2, text: mainAlpha });
  assert.deepEqual([...first.documentIds].sort(), ['main', 'supplement']);
  pass('Actual main-PDF mouse selection survives composer focus and sends exact text, document, page and rectangles in smart mode');

  await finish('error');
  const mainBeta = await selectPassage(0, 2, 'Main passage beta');
  assert.notEqual(mainBeta, mainAlpha);
  await sources().selectOption('supplement'); await mode('deep').click();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitFor(async () => (await requests()).length === 2, 'retry with original selected passage');
  const retry = (await requests()).at(-1); recorded.push(retry);
  assert.deepEqual(retry.selection, first.selection);
  assert.deepEqual(retry.documentIds, first.documentIds);
  assert.equal(retry.readingMode, first.readingMode);
  assert.equal(retry.prompt, first.prompt);
  await finish();
  pass('Retry keeps the original passage, document scope and reading mode despite a newly selected passage and changed controls');

  await sources().selectOption('main');
  const supplementGamma = await selectPassage(1, 2, 'Supplement passage gamma');
  await focusAndType('Explain this selected supplementary passage in detail.', supplementGamma);
  const deep = await send('deep', 3);
  assert.equal(deep.readingMode, 'deep'); assert.equal(deep.kind, 'chat');
  expectSelection(deep, { documentId: 'supplement', page: 2, text: supplementGamma });
  assert.deepEqual([...deep.documentIds].sort(), ['main', 'supplement']);
  await finish();
  pass('Deep mode sends the selected supplement passage and includes its document even when the source picker is set to main only');

  await mode('smart').click(); await sources().selectOption('main');
  const supplementAgain = await selectPassage(1, 2, 'Supplement passage gamma');
  await focusAndType('Explain this supplementary passage using smart mode.', supplementAgain);
  const scopedSmart = await send('smart', 4);
  expectSelection(scopedSmart, { documentId: 'supplement', page: 2, text: supplementAgain });
  assert.deepEqual([...scopedSmart.documentIds].sort(), ['main', 'supplement']);
  await finish();
  pass('Smart mode also adds the selected supplement to a main-only scope instead of silently dropping it');

  if (await card().count()) await card().getByRole('button', { name: '清除选中文字', exact: true }).click();
  await composer().fill('A question without any selected passage.');
  const unselected = await send('smart', 5);
  assert.equal(unselected.selection, undefined);
  assert.deepEqual(unselected.documentIds, ['main']);
  await finish('error');
  await selectPassage(1, 2, 'Supplement passage delta');
  await sources().selectOption('all'); await mode('deep').click();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitFor(async () => (await requests()).length === 6, 'retry without any original selection');
  const unselectedRetry = (await requests()).at(-1); recorded.push(unselectedRetry);
  assert.equal(unselectedRetry.selection, undefined);
  assert.deepEqual(unselectedRetry.documentIds, ['main']);
  assert.equal(unselectedRetry.readingMode, 'smart');
  assert.equal(unselectedRetry.prompt, unselected.prompt);
  await finish();
  pass('Retry of an originally unselected question does not accidentally attach a newly selected PDF passage');

  await selectPassage(0, 2, 'Main passage beta');
  await toolbar().getByRole('button', { name: '下划线', exact: true }).click();
  await waitFor(async () => (await workspace()).documents.find(item => item.id === 'main').annotations.length === 1, 'underline annotation persisted');
  assert.equal((await workspace()).documents.find(item => item.id === 'main').annotations[0].kind, 'underline');
  await page.getByRole('button', { name: '撤销上一步', exact: true }).click();
  await waitFor(async () => (await workspace()).documents.find(item => item.id === 'main').annotations.length === 0, 'undo removes the fixture annotation');
  // Underline remains armed for repeated markings, independently of undo.
  // Return to ordinary selection before testing the explicit Ask AI action.
  await toolbar().getByRole('button', { name: '选择文字', exact: true }).click();
  pass('The same mouse-selection path still supports underline annotations and undo through real local persistence');

  await selectPassage(1, 2, 'Supplement passage delta');
  await toolbar().getByRole('button', { name: '问 AI', exact: true }).click();
  await waitFor(async () => await composer().evaluate(element => document.activeElement === element), 'explicit Ask AI focuses the composer');
  assert.match(await card().locator('blockquote').textContent(), /Supplement passage delta/);
  await page.screenshot({ path: path.join(output, 'supplement-ask-ai-selection.png') });
  pass('Explicit Ask AI focuses the composer while retaining the supplementary passage reference card');
  assert.deepEqual(await app.evaluate(() => globalThis.__selectionContextTest.forbidden), []);
  assert.deepEqual(errors, []);
  pass('No renderer exceptions, real provider calls, microphone use, or changes to user-library data');
} catch (error) {
  errors.push(error.stack || String(error));
  await page?.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  diagnostics.startupLog = await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => 'No startup log was written.');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, requests: recorded, diagnostics }, null, 2));
  if (app) await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
