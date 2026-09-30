import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Real Electron, PDF.js, preload, IPC and disk persistence. All PDFs and profile
// data are generated locally; no user library, provider key or microphone.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/pane-swap');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-pane-swap-e2e-'));
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const workspaceId = 'pane-swap-fixture';
const directory = path.join(profile, 'Library', workspaceId);
const checks = [], errors = [], measurements = {};
const MIME = 'application/x-pairleaf-pane-swap';
const initialViews = {
  left: { page: 2, scale: '0.75', rotation: 0, scrollMode: 0, spreadMode: 0 },
  right: { page: 4, scale: '1', rotation: 90, scrollMode: 3, spreadMode: 0 },
};
let app, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = () => page.evaluate(() => window.folio.bootstrap());
const workspace = async () => (await state()).workspaces.find(item => item.id === workspaceId);
// Side labels follow the physical pane even if React retains viewer instances
// by moving their keyed columns, or an implementation uses CSS grid ordering.
const column = side => page.locator(`.reading-column[data-pane-side="${side}"], .reading-column:not([data-pane-side])[aria-label="${side === 'left' ? '左侧' : '右侧'}阅读区"], .reading-column:not([data-pane-side])[aria-label="${side === 'left' ? '上方' : '下方'}阅读区"], .reading-column:not([data-pane-side])[aria-label="${side === 'left' ? 'Left' : 'Right'} reading pane"], .reading-column:not([data-pane-side])[aria-label="${side === 'left' ? 'Top' : 'Bottom'} reading pane"]`);
const pane = side => column(side).locator('.pdf-pane');
const handle = side => column(side).locator('[data-pane-swap-handle]');
const pageInput = side => pane(side).getByRole('textbox', { name: /^(当前页码|Current page)$/ });
const scaleInput = side => pane(side).getByRole('combobox', { name: /^(缩放比例|Zoom level)$/ });
const metrics = () => app.evaluate(() => globalThis.__paneSwapChecks);
const savedView = (ws, side) => {
  const documentId = ws.layout[side === 'left' ? 'leftId' : 'rightId'];
  return ws.layout.views?.[side]?.documentId === documentId
    ? ws.layout.views[side].state : ws.documents.find(item => item.id === documentId).view;
};
async function waitFor(predicate, label, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(70); }
  throw new Error('Timed out: ' + label);
}
async function seed() {
  await mkdir(path.join(directory, '.text'), { recursive: true });
  const documents = [];
  for (const [id, name, side] of [['main', 'Main paper.pdf', 'left'], ['supplement', 'Supplement.pdf', 'right']]) {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = [];
    for (let i = 1; i <= 9; i++) {
      const sheet = pdf.addPage([600, 800]);
      const text = `${id} fixture page ${i}. This synthetic document tests retained PDF reading views.`;
      sheet.drawText(`${id} fixture page ${i}`, { x: 40, y: 750, font, size: 17 });
      sheet.drawText('This synthetic document tests retained PDF reading views.', { x: 40, y: 700, font, size: 12 });
      sheet.drawText(`Unique ${id} annotation belongs to this PDF.`, { x: 40, y: 660, font, size: 12 });
      pages.push(text);
    }
    const bytes = await pdf.save();
    await writeFile(path.join(directory, name), bytes);
    await writeFile(path.join(directory, '.text', `${id}.json`), JSON.stringify(pages));
    documents.push({ id, name, fileName: name, role: id === 'main' ? 'main' : 'supplement', size: bytes.length,
      pageCount: pages.length, outline: [], outlineLoaded: true, textStatus: 'ready', view: initialViews[side],
      annotations: [{ id: `${id}-annotation`, page: initialViews[side].page, text: `Unique ${id} annotation belongs to this PDF.`,
        comment: `${id} comment`, color: '#f5ce65', kind: id === 'main' ? 'highlight' : 'underline',
        rects: [[40, 659, 330, 674]], createdAt: 1 }],
    });
  }
  const now = Date.now();
  const fixture = { version: 1, id: workspaceId, title: 'Pane swap fixture', authors: '', journal: '', doi: '', tags: [], favorite: false,
    createdAt: now, updatedAt: now, lastReadAt: now, documents, notes: '', memories: [], memoryIndex: '',
    conversations: [{ id: 'conversation', title: 'Pane checks', createdAt: now, messages: [] }], activeConversationId: 'conversation',
    layout: { split: true, direction: 'vertical', leftId: 'main', rightId: 'supplement', ratio: 50, paneRevision: 0,
      views: { left: { documentId: 'main', state: initialViews.left }, right: { documentId: 'supplement', state: initialViews.right } } },
  };
  await writeFile(path.join(directory, 'workspace.json'), JSON.stringify(fixture));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {} }));
}
async function launch() {
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  page = await app.firstWindow();
  page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1720, 1040);
    // CDP drives real DOM input without stealing the user's desktop focus.
    window.webContents.setBackgroundThrottling(false);
    if (process.env.FOLIO_E2E_HIDE_WINDOW === '1') { window.setFocusable(false); window.hide(); }
    globalThis.__paneSwapChecks = { reads: [], events: [], forbidden: [] };
    globalThis.__delayPaneView = 0;
    for (const name of ['read-document', 'update-view', 'swap-panes']) {
      const original = ipcMain._invokeHandlers.get('folio:' + name);
      if (!original) throw new Error('Missing handler: ' + name);
      ipcMain.removeHandler('folio:' + name);
      ipcMain.handle('folio:' + name, async (event, ...args) => {
        const log = globalThis.__paneSwapChecks;
        if (name === 'read-document') log.reads.push({ workspaceId: args[0], documentId: args[1] });
        log.events.push({ name, phase: 'start', args, time: Date.now() });
        if (name === 'update-view' && globalThis.__delayPaneView) await new Promise(resolve => setTimeout(resolve, globalThis.__delayPaneView));
        const result = await original(event, ...args);
        log.events.push({ name, phase: 'end', args, time: Date.now() });
        return result;
      });
    }
    for (const name of ['start-chat', 'voice-capabilities', 'voice-listen', 'voice-speak', 'create-workspace', 'import-documents']) {
      ipcMain.removeHandler('folio:' + name);
      ipcMain.handle('folio:' + name, () => {
        globalThis.__paneSwapChecks.forbidden.push(name);
        throw new Error('Unexpected provider, speech or import call: ' + name);
      });
    }
  });
  await openWorkspace();
}
async function openWorkspace() {
  await page.getByRole('button', { name: /^(打开|Open) Pane swap fixture$/ }).click();
  await pane('left').locator('.textLayer span').first().waitFor({ state: 'attached' });
  await pane('right').locator('.textLayer span').first().waitFor({ state: 'attached' });
  await handle('left').waitFor({ state: 'visible' });
  const ai = page.getByRole('button', { name: /^(阅读伙伴|Reading companion)$/ });
  if (await ai.getAttribute('aria-expanded') === 'true') await ai.click();
  await page.evaluate(mime => {
    window.__lastPaneDrag = '';
    window.addEventListener('drop', event => {
      const data = event.dataTransfer?.getData(mime);
      if (data) window.__lastPaneDrag = data;
    }, true);
  }, MIME);
}
async function snapshot() {
  const ws = await workspace();
  return {
    left: { documentId: ws.layout.leftId, state: savedView(ws, 'left') },
    right: { documentId: ws.layout.rightId, state: savedView(ws, 'right') },
    revision: ws.layout.paneRevision ?? 0,
  };
}
async function assertRendered(expected) {
  for (const side of ['left', 'right']) {
    await waitFor(async () => await pageInput(side).inputValue() === String(expected[side].state.page)
      && await scaleInput(side).inputValue() === expected[side].state.scale, `${side} page and zoom reflect saved view`);
    assert.equal(await column(side).locator('.document-tab select').inputValue(), expected[side].documentId);
    const bounds = await pane(side).locator(`.page[data-page-number="${expected[side].state.page}"]`).boundingBox();
    assert.ok(bounds, `${side} selected page is mounted`);
    assert.equal(bounds.width > bounds.height, expected[side].state.rotation % 180 === 90, `${side} retains rotation`);
  }
}
async function rememberViewers() {
  for (const side of ['left', 'right']) await column(side).evaluate((element, key) => {
    window.__paneSwapViewers ??= {};
    window.__paneSwapViewers[key] = element.querySelector('.pdfViewer');
  }, side);
}
async function assertViewersSwapped() {
  for (const side of ['left', 'right']) assert.equal(await column(side).evaluate((element, source) =>
    element.querySelector('.pdfViewer') === window.__paneSwapViewers[source], side === 'left' ? 'right' : 'left'), true,
  `${side} must retain the opposite viewer instance`);
}
async function dragSwap(from, { header = false } = {}) {
  const before = await snapshot(), beforeMetrics = await metrics();
  await rememberViewers();
  const source = header ? column(from).locator('.document-role') : handle(from);
  await source.dragTo(column(from === 'left' ? 'right' : 'left'), { targetPosition: { x: 70, y: 115 } });
  await waitFor(async () => (await workspace()).layout.paneRevision === before.revision + 1, 'atomic pane exchange persisted');
  const expected = { left: before.right, right: before.left };
  await assertRendered(expected);
  await waitFor(async () => !(await handle('left').isDisabled()), 'swap finished');
  await delay(550);
  const after = await snapshot();
  assert.deepEqual({ left: after.left, right: after.right }, expected);
  await assertViewersSwapped();
  assert.equal((await metrics()).reads.length, beforeMetrics.reads.length, 'Swapping must not reread or reload PDFs');
  assert.equal(await page.locator('[data-pane-swap-target],[data-pane-swap-source]').count(), 0);
  return { before, after };
}
async function setLayout(horizontal) {
  await page.getByRole('button', { name: /^(阅读布局|Reading layout)$/ }).click();
  await page.getByRole('menuitemradio', { name: horizontal ? /横向分割|Stacked/ : /纵向分割|Side by side/ }).click();
  await waitFor(async () => (await workspace()).layout.direction === (horizontal ? 'horizontal' : 'vertical'), 'layout saved');
  let previous = '', stableSince = Date.now();
  await waitFor(async () => {
    const ws = await workspace();
    const actual = await Promise.all(['left', 'right'].map(async side => ({
      page: Number(await pageInput(side).inputValue()), scale: await scaleInput(side).inputValue(),
    })));
    const current = JSON.stringify(actual);
    if (current !== previous) { previous = current; stableSince = Date.now(); }
    return ['left', 'right'].every((side, index) => savedView(ws, side).page === actual[index].page
      && savedView(ws, side).scale === actual[index].scale) && Date.now() - stableSince > 600;
  }, 'resized PDF views settle before beginning the next drag');
}
async function setView(side, pageNumber, scale, rotation) {
  await pane(side).getByRole('button', { name: /^(阅读模式与导出|Reading modes and export)$/ }).click();
  await pane(side).getByRole('combobox', { name: /^(滚动方式|Scrolling)$/ }).selectOption('3');
  const previousRotation = savedView(await workspace(), side).rotation;
  for (let angle = previousRotation; angle !== rotation; angle = (angle + 90) % 360)
    await pane(side).getByRole('button', { name: /^(顺时针旋转 90°|Rotate 90° clockwise)$/ }).click();
  await pane(side).getByRole('button', { name: /^(关闭阅读设置|Close reading settings)$/ }).click();
  await scaleInput(side).selectOption(scale);
  await pageInput(side).fill(String(pageNumber));
  await pageInput(side).press('Enter');
  await waitFor(async () => {
    const view = savedView(await workspace(), side);
    return view.page === pageNumber && view.scale === scale && view.rotation === rotation && view.scrollMode === 3;
  }, `prepared ${side} independent reading view`);
  await pane(side).locator(`.page[data-page-number="${pageNumber}"] .textLayer span`).first().waitFor({ state: 'attached' });
}

try {
  await seed();
  await launch();
  const originals = (await workspace()).documents.map(({ id, annotations }) => ({ id, annotations }));
  await assertRendered(await snapshot());
  measurements.sideBySide = await dragSwap('left');
  await pane('left').locator('[data-annotation-id="supplement-annotation"]').first().waitFor({ state: 'attached' });
  await pane('right').locator('[data-annotation-id="main-annotation"]').first().waitFor({ state: 'attached' });
  pass('Dragging the grip exchanges left/right PDFs with page, zoom, rotation and scrolling state; viewer instances and annotations follow without PDF reloads');

  const unchanged = await snapshot(), importsBefore = (await metrics()).forbidden.length;
  await handle('left').dragTo(column('left'), { targetPosition: { x: 70, y: 115 } });
  assert.deepEqual(await snapshot(), unchanged);
  await column('right').evaluate((element, mime) => {
    const dt = new DataTransfer();
    dt.setData(mime, window.__lastPaneDrag || JSON.stringify({ version: 1, workspaceId: 'old-paper', identity: 'old', from: 'left', token: 'old' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, MIME);
  assert.deepEqual(await snapshot(), unchanged);
  await page.locator('.titlebar').evaluate((element, mime) => {
    const dt = new DataTransfer();
    dt.setData(mime, window.__lastPaneDrag);
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, MIME);
  assert.equal((await metrics()).forbidden.length, importsBefore);
  assert.equal(await page.locator('.drop-overlay').count(), 0);
  pass('Same-pane, replayed and out-of-pane internal drops do not swap or trigger PDF import');

  await setLayout(true);
  measurements.stacked = await dragSwap('right', { header: true });
  const top = await column('left').boundingBox(), bottom = await column('right').boundingBox();
  assert.ok(top.y + top.height <= bottom.y + 8, 'Top and bottom columns retain stacked geometry');
  pass('Dragging a document tab swaps stacked top/bottom panes without recreating PDF viewers');

  await setLayout(false);
  await column('right').locator('.document-tab select').selectOption('main');
  await waitFor(async () => (await workspace()).layout.rightId === 'main', 'same PDF opened in both panes');
  await pane('right').locator('.textLayer span').first().waitFor({ state: 'attached' });
  await setView('left', 2, '0.75', 0);
  await setView('right', 6, '1.25', 180);
  measurements.sameDocument = await dragSwap('left');
  assert.equal(measurements.sameDocument.after.left.state.page, 6);
  assert.equal(measurements.sameDocument.after.right.state.page, 2);
  pass('Two views of the same PDF exchange their independent page, zoom and rotation states');

  const beforeFast = await snapshot(), fastReadCount = (await metrics()).reads.length;
  await rememberViewers();
  await app.evaluate(() => { globalThis.__delayPaneView = 350; globalThis.__paneSwapChecks.events = []; });
  await pageInput('left').fill('7');
  await pageInput('left').press('Enter');
  await handle('left').dragTo(column('right'), { targetPosition: { x: 70, y: 115 } });
  await waitFor(async () => (await workspace()).layout.paneRevision === beforeFast.revision + 1, 'quick exchange after page change');
  await waitFor(async () => !(await handle('left').isDisabled()), 'quick exchange finished');
  await app.evaluate(() => { globalThis.__delayPaneView = 0; });
  const afterFast = await snapshot();
  assert.equal(afterFast.right.state.page, 7);
  assert.equal(afterFast.left.state.page, beforeFast.right.state.page);
  const trace = (await metrics()).events;
  const saved = trace.findIndex(event => event.name === 'update-view' && event.phase === 'end' && event.args[3].page === 7);
  const swapped = trace.findIndex(event => event.name === 'swap-panes' && event.phase === 'start');
  assert.ok(saved >= 0 && swapped > saved, 'The pending page write completes before the atomic swap begins');
  await assertViewersSwapped();
  assert.equal((await metrics()).reads.length, fastReadCount);
  await delay(900);
  assert.deepEqual(await snapshot(), afterFast, 'Late debounced writes must not overwrite exchanged views');
  measurements.fastSwap = { before: beforeFast, after: afterFast, events: trace };
  pass('An immediate drag after navigation flushes delayed view writes before swapping, with no late overwrite');

  await handle('left').focus();
  await page.keyboard.press('Enter');
  await waitFor(async () => (await workspace()).layout.paneRevision === afterFast.revision + 1, 'keyboard exchange');
  await waitFor(async () => !(await handle('left').isDisabled()), 'keyboard exchange finished');
  const beforeReload = await snapshot();
  await page.reload();
  await openWorkspace();
  await assertRendered(beforeReload);
  assert.deepEqual(await snapshot(), beforeReload);
  assert.deepEqual((await workspace()).documents.map(({ id, annotations }) => ({ id, annotations })), originals);
  pass('Keyboard swap, app reload and disk persistence retain both independent views and all original annotations');

  await page.screenshot({ path: path.join(output, 'pane-swap.png') });
  assert.deepEqual((await metrics()).forbidden, []);
  assert.deepEqual(errors, []);
  pass('No renderer exceptions, provider requests, microphone calls or accidental imports');
} catch (error) {
  errors.push(error.stack || String(error));
  measurements.failureState = await workspace().catch(() => null);
  measurements.failureMetrics = await metrics().catch(() => null);
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, measurements }, null, 2));
  if (app) await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
