import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Real PDF selection, React and local preferences; no provider, microphone or
// personal library. Lifecycle cancellation signals are injected after real drags.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/assistant-resize');
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-assistant-resize-'));
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
await mkdir(output, { recursive: true });
const id = 'assistant-resize-fixture', title = 'Assistant resize fixture', checks = [], errors = [], measurements = [];
const draft = 'Keep this unsent draft while moving and resizing the companion.';
let app, page;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const shell = () => page.locator('.assistant-shell');
const input = () => page.getByRole('textbox', { name: /^(向 AI 提问|Ask AI)$/ });
const nativeSelection = () => page.evaluate(() => window.getSelection()?.toString().trim());
const preferences = () => page.evaluate(() => JSON.parse(localStorage.getItem('folio.reading-layout.v1')));
const edge = direction => page.locator(`[data-assistant-resize="${direction}"]`);
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function until(predicate, label) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(65); }
  throw new Error('Timed out: ' + label);
}
const near = (value, expected, label, tolerance = 2) => assert.ok(Math.abs(value - expected) <= tolerance, `${label}: ${value} != ${expected}`);
function same(actual, expected, label) { for (const field of ['x', 'y', 'width', 'height']) near(actual[field], expected[field], `${label} ${field}`); }
async function geometry(label) {
  const panel = await shell().boundingBox(), reader = await page.locator('.reader-body').boundingBox();
  assert.ok(panel.x >= reader.x - 1 && panel.y >= reader.y - 1, label + ' top-left stays inside reader');
  assert.ok(panel.x + panel.width <= reader.x + reader.width + 1 && panel.y + panel.height <= reader.y + reader.height + 1, label + ' bottom-right stays inside reader');
  measurements.push({ label, panel, reader }); return { panel, reader };
}
async function drag(locator, dx, dy, finish = 'up') {
  const box = await locator.boundingBox(); assert.ok(box);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await locator.evaluate(element => element.addEventListener('pointerdown', event => { window.__resizePointer = event.pointerId; }, { once: true }));
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 }); await frames();
  if (finish === 'hold') return;
  if (finish === 'escape') await page.keyboard.press('Escape');
  else if (finish === 'pointercancel') await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.__resizePointer })));
  else if (finish === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  else if (finish === 'lostcapture') await locator.evaluate(element => element.releasePointerCapture(window.__resizePointer));
  if (finish !== 'up') await frames();
  await page.mouse.up(); await frames();
}
async function moveTo(x, y) {
  const { panel, reader } = await geometry('before position');
  await drag(page.locator('.fl-assistant-header strong'), reader.x + x - panel.x, reader.y + y - panel.y);
}
async function retainsSelection(selected, label) {
  assert.equal(await input().inputValue(), draft, label + ': draft');
  assert.equal((await page.locator('.fl-selection-context blockquote').textContent()).trim(), selected, label + ': saved PDF quote');
}
async function seed() {
  const directory = path.join(profile, 'Library', id); await mkdir(path.join(directory, '.text'), { recursive: true });
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const texts = [];
  for (let number = 1; number <= 3; number++) {
    const sheet = pdf.addPage([600, 800]);
    const lines = ['Evidence passage keeps its selection.', 'The companion remains movable beside this paper.', 'This synthetic paragraph has no private information.'];
    lines.forEach((text, index) => sheet.drawText(text, { x: 35, y: 730 - index * 22, size: 12, font }));
    texts.push(lines.join('\n'));
  }
  const bytes = await pdf.save(); await writeFile(path.join(directory, 'Main.pdf'), bytes);
  await writeFile(path.join(directory, '.text', 'main.json'), JSON.stringify(texts));
  const now = Date.now();
  await writeFile(path.join(directory, 'workspace.json'), JSON.stringify({ version: 1, id, title, titleStatus: 'confirmed', authors: '', journal: '', doi: '', tags: [], favorite: false, createdAt: now, updatedAt: now, lastReadAt: now,
    documents: [{ id: 'main', name: 'Main.pdf', fileName: 'Main.pdf', role: 'main', size: bytes.length, pageCount: 3, outline: [], outlineLoaded: true, annotations: [], textStatus: 'ready', view: { page: 1, scale: '1', rotation: 0, scrollMode: 0, spreadMode: 0 } }],
    notes: '', memories: [], memoryIndex: '', conversations: [{ id: 'chat', title: 'Resize checks', createdAt: now, messages: [] }], activeConversationId: 'chat', layout: { split: false, leftId: 'main', rightId: '', ratio: 50 } }));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {} }));
}
try {
  await seed(); const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  page = await app.firstWindow(); page.setDefaultTimeout(18000); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: `打开 ${title}`, exact: true }).waitFor();
  await until(async () => /\bready\r?\n/.test(await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => '')), 'initial startup complete');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await page.evaluate(() => localStorage.setItem('folio.reading-layout.v1', JSON.stringify({ navigation: 'rail', assistantOpen: true, assistantMode: 'overlay', assistantWidth: 440, assistantHeight: 500, assistantPosition: { x: 900, y: 100 } })));
  await page.reload(); await page.getByRole('button', { name: `打开 ${title}`, exact: true }).click();
  await shell().waitFor(); await input().fill(draft); await frames();
  const beforeSelection = await shell().boundingBox();
  const text = page.locator('.pdf-pane .page[data-page-number="1"] .textLayer span').filter({ hasText: 'Evidence passage keeps its selection.' }).first();
  await text.waitFor(); await text.scrollIntoViewIfNeeded(); await frames();
  const line = await text.boundingBox();
  const lastLine = await page.locator('.pdf-pane .page[data-page-number="1"] .textLayer span').filter({ hasText: 'This synthetic paragraph has no private information.' }).first().boundingBox();
  await page.mouse.move(line.x + 1, line.y + line.height / 2); await page.mouse.down();
  await page.mouse.move(lastLine.x + lastLine.width - 1, lastLine.y + lastLine.height / 2, { steps: 16 }); await page.mouse.up();
  await until(() => page.locator('.fl-selection-context').isVisible(), 'real selected paragraph appears in companion');
  const selected = await nativeSelection(); assert.ok(selected.length > 100);
  const first = (await geometry('selection card opened')).panel;
  same(first, beforeSelection, 'Selection card cannot change the outer drag bounds');
  assert.equal(await edge('nw').count(), 1); assert.equal(await page.locator('[data-assistant-resize]').count(), 8);
  await retainsSelection(selected, 'initial selection');
  pass('Real PDF selection appears as a quote without changing the floating outer size');

  await page.evaluate(() => {
    window.__layoutWrites = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'folio.reading-layout.v1') window.__layoutWrites++; return original.call(this, key, value); };
  });
  for (const [dx, dy] of [[-80, 0], [80, 0], [0, 60], [0, -60]]) {
    const before = await shell().boundingBox();
    await drag(page.locator('.fl-assistant-header strong'), dx, dy);
    const after = (await geometry(`selected passage move ${dx},${dy}`)).panel;
    near(after.x, before.x + dx, 'horizontal movement'); near(after.y, before.y + dy, 'vertical movement');
    near(after.width, first.width, 'moving keeps width'); near(after.height, first.height, 'selected card cannot grow panel');
    assert.equal(await nativeSelection(), selected, 'Dragging keeps the native PDF Range'); await retainsSelection(selected, 'moving');
  }
  pass('Selected-passage companion moves all four directions while retaining its native PDF selection and unsent draft');

  for (const corner of ['bottom-right', 'top-left']) {
    const reader = await page.locator('.reader-body').boundingBox(), header = await page.locator('.fl-assistant-header strong').boundingBox();
    const target = corner === 'top-left' ? { x: reader.x + 2, y: reader.y + 2 } : { x: reader.x + reader.width - 2, y: reader.y + reader.height - 2 };
    await drag(page.locator('.fl-assistant-header strong'), target.x - header.x - header.width / 2, target.y - header.y - header.height / 2);
    const result = await geometry(corner);
    near(result.panel.x, corner === 'top-left' ? reader.x + 12 : reader.x + reader.width - result.panel.width - 12, corner + ' x');
    near(result.panel.y, corner === 'top-left' ? reader.y + 12 : reader.y + reader.height - result.panel.height - 12, corner + ' y');
  }
  await moveTo(300, 100); await retainsSelection(selected, 'boundary drags');
  pass('Quote-bearing panel reaches every legal reader boundary and remains fully inside it');

  for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const before = await shell().boundingBox(), writes = await page.evaluate(() => window.__layoutWrites);
    const dx = direction.includes('w') ? -18 : direction.includes('e') ? 18 : 0, dy = direction.includes('n') ? -18 : direction.includes('s') ? 18 : 0;
    await drag(edge(direction), dx, dy, 'hold');
    assert.equal(await page.evaluate(() => window.__layoutWrites), writes, 'Pointer frames cannot persist layout');
    if (direction === 'n') {
      const held = await shell().boundingBox();
      await page.evaluate(() => {
        for (const type of ['pointermove', 'pointerup', 'pointercancel']) window.dispatchEvent(new PointerEvent(type, { pointerId: window.__resizePointer + 99, clientX: 0, clientY: 0 }));
      });
      await frames(); same(await shell().boundingBox(), held, 'Unrelated pointer cannot move or finish gesture');
      assert.equal(await shell().getAttribute('data-resize-active'), direction);
      assert.equal(await page.evaluate(() => window.__layoutWrites), writes);
    }
    await page.mouse.up(); await frames();
    await until(async () => await page.evaluate(() => window.__layoutWrites) === writes + 1, 'one final size commit');
    const after = (await geometry('resize ' + direction)).panel;
    if (direction.includes('w')) near(after.x + after.width, before.x + before.width, direction + ' opposite right');
    else near(after.x, before.x, direction + ' fixed left');
    if (direction.includes('n')) near(after.y + after.height, before.y + before.height, direction + ' opposite bottom');
    else near(after.y, before.y, direction + ' fixed top');
    await retainsSelection(selected, 'resize ' + direction); assert.equal(await nativeSelection(), selected, 'Resize keeps native text selection');
  }
  await page.screenshot({ path: path.join(output, 'selected-passage-resized.png') });
  pass('All eight handles resize the selected-passage panel, preserve opposite edges, and persist once on release');

  for (const signal of ['escape', 'pointercancel', 'blur', 'lostcapture']) {
    const before = await shell().boundingBox(), saved = await preferences(), writes = await page.evaluate(() => window.__layoutWrites);
    await drag(edge('nw'), 30, 28, signal);
    same(await shell().boundingBox(), before, signal + ' rolls back'); assert.deepEqual(await preferences(), saved);
    assert.equal(await page.evaluate(() => window.__layoutWrites), writes);
    assert.equal(await page.locator('body.resizing-assistant').count(), 0); await retainsSelection(selected, signal);
  }
  pass('Escape, pointer cancellation, blur and lost capture roll back floating size without changing preferences or draft');

  const beforeKeyboard = await shell().boundingBox(), oldHeight = (await preferences()).assistantHeight;
  await edge('se').focus(); await page.keyboard.press('ArrowLeft'); await frames();
  near((await shell().boundingBox()).width, beforeKeyboard.width - 10, 'corner keyboard width'); assert.equal((await preferences()).assistantHeight, oldHeight);
  await edge('s').focus(); await page.keyboard.press('ArrowUp'); await frames();
  near((await shell().boundingBox()).height, beforeKeyboard.height - 10, 'edge keyboard height');
  const remembered = await preferences();
  await page.getByRole('button', { name: '关闭阅读伙伴', exact: true }).click();
  await page.getByRole('button', { name: '阅读伙伴', exact: true }).click(); await frames();
  await retainsSelection(selected, 'close/reopen'); assert.deepEqual(await preferences(), remembered);
  pass('Keyboard resizing handles individual axes and close/reopen preserves size, quote and draft');

  await page.getByRole('button', { name: '固定阅读伙伴', exact: true }).click(); await page.locator('.assistant-shell.is-docked').waitFor();
  const dock = page.locator('.assistant-resize-handle'); assert.equal(await page.locator('[data-assistant-resize]').count(), 0);
  for (const signal of ['escape', 'pointercancel', 'blur', 'lostcapture']) {
    const before = await shell().boundingBox(), saved = await preferences();
    await drag(dock, 30, 0, signal); same(await shell().boundingBox(), before, 'docked ' + signal); assert.deepEqual(await preferences(), saved);
  }
  const dockedHeight = (await preferences()).assistantHeight;
  await drag(dock, 24, 0); assert.equal((await preferences()).assistantHeight, dockedHeight);
  await retainsSelection(selected, 'docked');
  pass('Docked width resizing has the same cancellation protections and never modifies floating height');

  const savedDocked = await preferences();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await page.locator('.assistant-shell.is-overlay').waitFor(); await frames(); await geometry('temporary narrow overlay');
  assert.deepEqual(await preferences(), savedDocked); await retainsSelection(selected, 'narrow');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await page.locator('.assistant-shell.is-docked').waitFor(); await frames();
  assert.deepEqual(await preferences(), savedDocked);
  await page.getByRole('button', { name: '取消固定阅读伙伴', exact: true }).click(); await frames();
  near((await shell().boundingBox()).height, savedDocked.assistantHeight, 'height restores after temporary shrink');
  await retainsSelection(selected, 'wide again');
  pass('Narrow-window fallback and return to dock preserve preferred geometry, selection and unsent input');

  await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
  await page.getByRole('group', { name: '软件文字大小', exact: true }).getByRole('button', { name: '150%', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await until(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale').trim() === '1.5'), 'font scale saved');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await frames(); await geometry('150 percent selected passage');
  await retainsSelection(selected, '150 percent');
  const largeBefore = await shell().boundingBox(); await drag(page.locator('.fl-assistant-header strong'), -30, 20);
  const largeAfter = await shell().boundingBox(); near(largeAfter.x, largeBefore.x - 30, 'large type moving x'); near(largeAfter.y, largeBefore.y + 20, 'large type moving y');
  await input().scrollIntoViewIfNeeded(); await input().click(); await input().press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await input().pressSequentially('!');
  assert.equal(await input().inputValue(), draft + '!'); await input().press('Backspace');
  await page.screenshot({ path: path.join(output, 'selected-passage-150-percent.png') });
  pass('At 150% text size the selected-passage panel remains movable and its composer stays reachable');

  await edge('s').focus();
  for (let count = 0; count < 6; count++) await page.keyboard.press('Shift+ArrowUp');
  await edge('e').focus();
  for (let count = 0; count < 6; count++) await page.keyboard.press('Shift+ArrowLeft');
  await frames();
  const minimum = (await geometry('minimum size at 150 percent')).panel;
  near(minimum.width, 320, 'minimum width'); near(minimum.height, 400, 'minimum height');
  await input().scrollIntoViewIfNeeded(); await input().click(); await input().press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await input().pressSequentially('!');
  assert.equal(await input().inputValue(), draft + '!'); await input().press('Backspace');
  const send = page.getByRole('button', { name: '发送问题', exact: true });
  await send.scrollIntoViewIfNeeded();
  for (const control of [send, page.getByRole('button', { name: '关闭阅读伙伴', exact: true })]) {
    assert.equal(await control.evaluate(element => {
      const box = element.getBoundingClientRect(), target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return element === target || element.contains(target);
    }), true, 'Minimum-size send and close controls must be reachable');
  }
  const minimumTitle = await page.locator('.fl-assistant-header strong').boundingBox();
  assert.ok(minimumTitle.y >= minimum.y && minimumTitle.y + minimumTitle.height <= minimum.y + minimum.height, 'At minimum size, editing the composer must leave its drag title reachable');
  await drag(page.locator('.fl-assistant-header strong'), 20, 20);
  const movedMinimum = await shell().boundingBox(); near(movedMinimum.x, minimum.x + 20, 'minimum-size move x'); near(movedMinimum.y, minimum.y + 20, 'minimum-size move y');
  await retainsSelection(selected, 'minimum size');
  await page.screenshot({ path: path.join(output, 'selected-passage-minimum-150-percent.png') });
  pass('Minimum 320 by 400 panel at 150% keeps input and drag title reachable without losing its quote');

  await frames();
  const idle = await page.evaluate(async () => {
    let styleWrites = 0; const element = document.querySelector('.assistant-shell');
    const observer = new MutationObserver(records => { styleWrites += records.filter(record => record.attributeName === 'style').length; });
    observer.observe(element, { attributes: true, attributeFilter: ['style'] });
    await new Promise(resolve => setTimeout(resolve, 650)); observer.disconnect(); return { styleWrites, visibility: document.visibilityState, focus: document.hasFocus() };
  });
  assert.equal(idle.styleWrites, 0, 'Idle selection does not cause a positioning loop'); measurements.push({ label: 'idle observation', ...idle });
  pass('An idle selected-passage panel performs no continuous geometry writes');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'assistant-resize-report.json'), JSON.stringify({ passed: true, checks, measurements, errors }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'assistant-resize-failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'assistant-resize-report.json'), JSON.stringify({ passed: false, checks, measurements, errors, failure: String(error?.stack || error) }, null, 2));
  throw error;
} finally { await app?.close(); if (process.env.FOLIO_KEEP_FIXTURE !== '1') await rm(profile, { recursive: true, force: true }); }
