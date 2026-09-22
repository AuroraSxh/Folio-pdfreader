import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFArray } from 'pdf-lib';

// Real pointer/keyboard integration checks. No API keys, cloud requests, system
// keychain prompts, or existing library files are required by this suite.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results');
await mkdir(output, { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), 'folio-reading-e2e-'));
const executablePath = process.env.FOLIO_EXECUTABLE;
const env = { ...process.env, FOLIO_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const checks = [], failures = [], measurements = {};
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let app, page, workspaceId;

async function launch() {
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => failures.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
}
async function state() { return page.evaluate(() => window.folio.bootstrap()); }
async function workspace() { return (await state()).workspaces.find(item => item.id === workspaceId); }
async function waitUntil(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(70); }
  throw new Error(`Timed out: ${description}`);
}
async function waitWorkspace(predicate, description) { await waitUntil(async () => predicate(await workspace()), description); }
const pane = side => page.locator('.pdf-pane').nth(side);
const toolbar = () => page.getByRole('toolbar', { name: '文字与批注工具', exact: true });
async function assistant(open, dock = false) {
  const toggle = page.getByRole('button', { name: '阅读伙伴', exact: true });
  if ((await toggle.getAttribute('aria-expanded') === 'true') !== open) await toggle.click();
  await page.locator('.assistant-shell').waitFor({ state: open ? 'visible' : 'hidden' });
  if (open && dock && await page.getByRole('button', { name: '固定阅读伙伴', exact: true }).isVisible()) await page.getByRole('button', { name: '固定阅读伙伴', exact: true }).click();
}
async function navigation(open) {
  const button = page.getByRole('button', { name: open ? '展开文章导航' : '收起文章导航', exact: true });
  if (await button.isVisible()) await button.click();
}
async function viewState() {
  return Promise.all([0, 1].map(async side => ({ page: await pane(side).getByRole('textbox', { name: '当前页码', exact: true }).inputValue(), scale: await pane(side).getByRole('combobox', { name: '缩放比例', exact: true }).inputValue() })));
}
async function setView(side, pageNumber, scale) {
  const input = pane(side).getByRole('textbox', { name: '当前页码', exact: true });
  const waitForView = async (phase, expectedScale) => {
    let previous, stableSince = Date.now(), snapshot;
    try {
      await waitUntil(async () => {
        const [geometry, w] = await Promise.all([
          pane(side).locator('.pdf-viewer-container').evaluate((element, targetPage) => {
            const viewport = element.getBoundingClientRect();
            const target = element.querySelector(`.page[data-page-number="${targetPage}"]`);
            const bounds = target?.getBoundingClientRect();
            return { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, viewport: [viewport.width, viewport.height], page: bounds && [bounds.x, bounds.y, bounds.width, bounds.height], visible: Boolean(bounds && Math.min(bounds.bottom, viewport.bottom) - Math.max(bounds.top, viewport.top) > 20) };
          }, pageNumber),
          workspace(),
        ]);
        const view = w.layout.views?.[side === 0 ? 'left' : 'right']?.state;
        snapshot = { geometry, view, input: await input.inputValue() };
        const current = JSON.stringify(geometry);
        if (current !== previous) { previous = current; stableSince = Date.now(); }
        return geometry.visible && snapshot.input === String(pageNumber) && view?.page === pageNumber
          && (expectedScale === undefined || view.scale === expectedScale) && Date.now() - stableSince >= 210;
      }, `${phase}: pane ${side} reaches page ${pageNumber}${expectedScale ? ` at ${expectedScale}` : ''}`, 10000);
    } catch (error) { measurements.failedViewPreparation = { phase, side, pageNumber, expectedScale, snapshot }; throw error; }
  };
  await input.fill(String(pageNumber)); await input.press('Enter');
  // PDF.js updates its scroll-location anchor after the page-change event. Wait
  // for the visible page and persisted view before issuing the next UI action.
  await waitForView('page navigation settled');
  await pane(side).getByRole('combobox', { name: '缩放比例', exact: true }).selectOption(scale);
  await waitForView('zoom preserves requested page', scale);
  await pane(side).locator(`.page[data-page-number="${pageNumber}"] .textLayer span`).first().waitFor({ state: 'attached' });
}
async function focusPDF(side) {
  await pane(side).locator('.pdf-viewer-container').click({ position: { x: 8, y: 15 } });
}
async function selectText(side) {
  const locate = () => pane(side).locator('.pdf-viewer-container').evaluate(element => {
    const viewport = element.getBoundingClientRect();
    for (const span of element.querySelectorAll('.textLayer span')) {
      const r = span.getBoundingClientRect();
      if (span.textContent.trim() && r.width > 70 && r.height > 7 && r.top > viewport.top + 12 && r.bottom < viewport.bottom - 12 && r.left > viewport.left && r.right < viewport.right - 8) return { x: r.left + 2, y: r.top + r.height * .5, endX: r.right - 2, text: span.textContent, page: span.closest('.page')?.dataset.pageNumber };
    }
    return null;
  });
  let target, previous, stableSince = Date.now();
  await waitUntil(async () => {
    target = await locate();
    if (!target) { previous = null; stableSince = Date.now(); return false; }
    if (JSON.stringify(target) !== JSON.stringify(previous)) { previous = target; stableSince = Date.now(); return false; }
    return Date.now() - stableSince >= 280;
  }, 'PDF text geometry settles after pane resizing', 5000);
  await page.mouse.move(target.x, target.y); await page.mouse.down();
  await page.mouse.move(target.endX, target.y, { steps: 14 }); await page.mouse.up();
  try { await waitUntil(() => page.evaluate(() => Boolean(window.getSelection()?.toString().trim())), 'native PDF selection', 3000); }
  catch (error) { measurements.failedSelection = { side, target, after: await locate(), hit: await page.evaluate(point => ({ start: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 400), end: document.elementFromPoint(point.endX, point.y)?.outerHTML.slice(0, 400), active: document.activeElement?.outerHTML.slice(0, 400), selected: window.getSelection()?.toString() }), target) }; throw error; }
  await waitUntil(() => toolbar().getByRole('button', { name: '复制选中文字', exact: true }).isEnabled(), 'selection geometry delivered to shared toolbar');
  return page.evaluate(() => window.getSelection().toString().trim());
}
async function rightClickSelection(side) {
  const target = await pane(side).locator('.pdf-viewer-container').evaluate(element => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !element.contains(selection.anchorNode)) throw new Error('Right-click test requires this PDF selection');
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 80), y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(target.x, target.y, { button: 'right' });
  await page.getByRole('menu', { name: 'PDF 操作', exact: true }).waitFor();
}
async function annotations() { return (await workspace()).documents.map(document => ({ id: document.id, annotations: document.annotations })); }
async function annotation(documentId, id) { return (await workspace()).documents.find(document => document.id === documentId).annotations.find(item => item.id === id); }
async function historyShortcut(direction, side) {
  await focusPDF(side);
  await page.keyboard.press(direction === 'undo' ? `${modifier}+z` : `${modifier}+Shift+z`);
}
async function openAnnotation(side, id) {
  const w = await workspace();
  const documentId = side === 0 ? w.layout.leftId : w.layout.rightId;
  const document = w.documents.find(item => item.id === documentId);
  const sorted = [...document.annotations].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
  const index = sorted.findIndex(item => item.id === id);
  assert.ok(index >= 0, 'Annotation must exist before opening its editor');
  const sidebar = pane(side).getByRole('button', { name: '目录、缩略图与批注', exact: true });
  if (await sidebar.getAttribute('aria-pressed') !== 'true') await sidebar.click();
  await pane(side).getByRole('button', { name: '高亮与批注', exact: true }).click();
  await pane(side).locator('.pdf-annotation-card').nth(index).click();
  await pane(side).getByRole('textbox', { name: '批注内容', exact: true }).waitFor();
}
async function closePDFSidebars() {
  for (const side of [0, 1]) {
    const button = pane(side).getByRole('button', { name: '目录、缩略图与批注', exact: true });
    if (await button.getAttribute('aria-pressed') === 'true') await button.click();
  }
}
function sameBounds(actual, expected, description, tolerance = 2) {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance, `${description}: ${key} changed ${expected[key]} → ${actual[key]}`);
}
async function dragAssistantHeader(dx, dy) {
  // Start on the actual title text, never on settings/pin/close controls.
  const title = await page.locator('.fl-assistant-header strong').boundingBox();
  const start = { x: title.x + title.width / 2, y: title.y + title.height / 2 };
  const end = { x: start.x + dx, y: start.y + dy };
  const before = await page.locator('.assistant-shell').boundingBox();
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 14 }); await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return { start, end, before, after: await page.locator('.assistant-shell').boundingBox() };
}
async function floatingPosition() {
  const panel = await page.locator('.assistant-shell').boundingBox();
  const reader = await page.locator('.reader-body').boundingBox();
  return { x: panel.x - reader.x, y: panel.y - reader.y };
}
function samePosition(actual, expected, description) {
  for (const axis of ['x', 'y']) assert.ok(Math.abs(actual[axis] - expected[axis]) <= 2, `${description}: ${axis} changed ${expected[axis]} → ${actual[axis]}`);
}
function withinReader(panel, reader) {
  assert.ok(panel.x >= reader.x - 1 && panel.y >= reader.y - 1, 'Floating assistant must stay inside the reader at its top/left edges');
  assert.ok(panel.x + panel.width <= reader.x + reader.width + 1 && panel.y + panel.height <= reader.y + reader.height + 1, 'Floating assistant must stay inside the reader at its bottom/right edges');
}

try {
  await launch();
  await page.getByRole('button', { name: '体验示例工作区', exact: true }).click();
  await pane(1).locator('.textLayer span').first().waitFor();
  workspaceId = (await state()).workspaces[0].id;
  await waitWorkspace(w => w.documents.length === 2 && w.documents.every(document => document.textStatus === 'ready'), 'both demo PDFs indexed');
  const originalSettings = (await state()).settings;
  assert.equal(await page.getByRole('button', { name: '阅读伙伴', exact: true }).getAttribute('aria-expanded'), 'false');
  assert.ok(await page.getByRole('button', { name: '展开文章导航', exact: true }).isVisible());
  const navigationBox = await page.getByRole('complementary', { name: '精简导航', exact: true }).boundingBox();
  assert.ok(Math.abs(navigationBox.width - 48) <= 2, `Compact rail should be 48px, received ${navigationBox.width}`);
  const beforeOverlay = await page.locator('.pdf-columns').boundingBox();
  await assistant(true);
  await page.waitForTimeout(250);
  const afterOverlay = await page.locator('.pdf-columns').boundingBox();
  sameBounds(afterOverlay, beforeOverlay, 'AI overlay must preserve PDF reading bounds');
  const glass = await page.locator('.assistant-shell').evaluate(element => { const style = getComputedStyle(element); return { filter: style.backdropFilter, background: style.backgroundColor, reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches }; });
  measurements.overlay = { before: beforeOverlay, after: afterOverlay, glass };
  if (!glass.reducedTransparency) { assert.match(glass.filter, /blur\(/); assert.match(glass.background, /^rgba\(/); assert.ok(Number(glass.background.split(',').at(-1).replace(')', '')) < 1); }
  const draft = 'Reading E2E draft · 专注模式后继续思考';
  await page.getByRole('textbox', { name: '向 AI 提问', exact: true }).fill(draft);
  check('Fresh workspace defaults to 48px rail and closed AI; opening overlay preserves PDF bounds');

  await page.locator('.fl-assistant-header[aria-label="移动阅读伙伴"]').waitFor();
  const moved = await dragAssistantHeader(-140, 55);
  assert.ok(moved.after.x < moved.before.x - 100, 'Title drag must move the floating assistant horizontally');
  assert.ok(moved.after.y > moved.before.y + 30, 'Title drag must move the floating assistant vertically');
  sameBounds(await page.locator('.pdf-columns').boundingBox(), beforeOverlay, 'Moving AI must preserve PDF bounds');
  assert.equal(await page.getByRole('textbox', { name: '向 AI 提问', exact: true }).inputValue(), draft);
  const readerBounds = await page.locator('.reader-body').boundingBox();
  let header = await page.locator('.fl-assistant-header strong').boundingBox();
  const clampedBottomRight = await dragAssistantHeader(readerBounds.x + readerBounds.width - 2 - (header.x + header.width / 2), readerBounds.y + readerBounds.height - 2 - (header.y + header.height / 2));
  withinReader(clampedBottomRight.after, readerBounds);
  assert.ok(clampedBottomRight.after.x < clampedBottomRight.before.x + clampedBottomRight.end.x - clampedBottomRight.start.x - 10, 'Right boundary must clamp an attempted out-of-bounds drag');
  assert.ok(clampedBottomRight.after.y < clampedBottomRight.before.y + clampedBottomRight.end.y - clampedBottomRight.start.y - 10, 'Bottom boundary must clamp an attempted out-of-bounds drag');
  header = await page.locator('.fl-assistant-header strong').boundingBox();
  const clampedTopLeft = await dragAssistantHeader(readerBounds.x + 2 - (header.x + header.width / 2), readerBounds.y + 2 - (header.y + header.height / 2));
  withinReader(clampedTopLeft.after, readerBounds);
  assert.ok(clampedTopLeft.after.x > clampedTopLeft.before.x + clampedTopLeft.end.x - clampedTopLeft.start.x + 5);
  assert.ok(clampedTopLeft.after.y > clampedTopLeft.before.y + clampedTopLeft.end.y - clampedTopLeft.start.y + 5);
  const currentPosition = await floatingPosition();
  await dragAssistantHeader(220 - currentPosition.x, 56 - currentPosition.y);
  const beforeFloatingResize = await page.locator('.assistant-shell').boundingBox();
  let floatingDivider = await page.getByRole('separator', { name: '调整阅读伙伴宽度', exact: true }).boundingBox();
  await page.mouse.move(floatingDivider.x + floatingDivider.width / 2, floatingDivider.y + floatingDivider.height / 2); await page.mouse.down();
  await page.mouse.move(floatingDivider.x + floatingDivider.width / 2 - 36, floatingDivider.y + floatingDivider.height / 2, { steps: 10 }); await page.mouse.up();
  await waitUntil(async () => (await page.locator('.assistant-shell').boundingBox()).width > beforeFloatingResize.width + 30, 'positioned floating panel resizes from its left edge');
  const afterFloatingResize = await page.locator('.assistant-shell').boundingBox();
  assert.ok(Math.abs(afterFloatingResize.x + afterFloatingResize.width - beforeFloatingResize.x - beforeFloatingResize.width) <= 2, 'Resizing the moved floating panel must keep its opposite right edge fixed');
  assert.ok(Math.abs(afterFloatingResize.y - beforeFloatingResize.y) <= 2, 'Floating resize must preserve vertical position');
  sameBounds(await page.locator('.pdf-columns').boundingBox(), beforeOverlay, 'Floating resize must preserve PDF bounds');
  // Restore the original width so later dock/focus coverage uses its original geometry.
  floatingDivider = await page.getByRole('separator', { name: '调整阅读伙伴宽度', exact: true }).boundingBox();
  await page.mouse.move(floatingDivider.x + floatingDivider.width / 2, floatingDivider.y + floatingDivider.height / 2); await page.mouse.down();
  await page.mouse.move(floatingDivider.x + floatingDivider.width / 2 + afterFloatingResize.width - beforeFloatingResize.width, floatingDivider.y + floatingDivider.height / 2, { steps: 10 }); await page.mouse.up();
  await waitUntil(async () => Math.abs((await page.locator('.assistant-shell').boundingBox()).width - beforeFloatingResize.width) <= 2, 'floating panel width restored');
  const rememberedFloatingPosition = await floatingPosition();
  samePosition(rememberedFloatingPosition, { x: 220, y: 56 }, 'Floating panel can be placed at an interior location');
  measurements.floatingDrag = { moved, clampedBottomRight, clampedTopLeft, beforeResize: beforeFloatingResize, afterResize: afterFloatingResize, rememberedPosition: rememberedFloatingPosition };
  check('Floating AI moves in both axes, clamps boundaries and resizes with its opposite edge fixed without resizing PDFs');

  const beforeHeaderControls = await page.locator('.assistant-shell').boundingBox();
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  sameBounds(await page.locator('.assistant-shell').boundingBox(), beforeHeaderControls, 'Settings button must not start dragging');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  const dragInput = page.getByRole('textbox', { name: '向 AI 提问', exact: true });
  await dragInput.click(); await dragInput.press('End'); await dragInput.pressSequentially('!'); await dragInput.press('Backspace');
  assert.equal(await dragInput.inputValue(), draft);
  sameBounds(await page.locator('.assistant-shell').boundingBox(), beforeHeaderControls, 'Typing must not move the panel');
  await page.getByRole('button', { name: '关闭阅读伙伴', exact: true }).click();
  await page.locator('.assistant-shell').waitFor({ state: 'hidden' });
  await assistant(true);
  samePosition(await floatingPosition(), rememberedFloatingPosition, 'Closing and reopening must preserve the dragged position');
  assert.equal(await dragInput.inputValue(), draft);
  sameBounds(await page.locator('.pdf-columns').boundingBox(), beforeOverlay, 'Panel controls must preserve PDF bounds');
  await page.screenshot({ path: path.join(output, 'reading-assistant-drag.png') });
  check('AI settings, close/reopen and typing work normally after dragging and retain position and draft');

  await page.getByRole('button', { name: '固定阅读伙伴', exact: true }).click();
  await waitUntil(async () => (await page.locator('.pdf-columns').boundingBox()).width < beforeOverlay.width - 150, 'docked AI allocates reading width');
  assert.equal(await page.locator('.assistant-shell').evaluate(element => getComputedStyle(element).backdropFilter), 'none');
  assert.notEqual(await page.locator('.fl-assistant-header').getAttribute('aria-label'), '移动阅读伙伴');
  const dockedDrag = await dragAssistantHeader(-45, 35);
  sameBounds(dockedDrag.after, dockedDrag.before, 'Docked panel must not move when its title is dragged');
  await page.getByRole('button', { name: '取消固定阅读伙伴', exact: true }).waitFor();
  const beforeResize = await page.locator('.assistant-shell').boundingBox();
  const divider = await page.getByRole('separator', { name: '调整阅读伙伴宽度', exact: true }).boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2); await page.mouse.down();
  await page.mouse.move(divider.x - 75, divider.y + divider.height / 2, { steps: 12 }); await page.mouse.up();
  await waitUntil(async () => (await page.locator('.assistant-shell').boundingBox()).width > beforeResize.width + 35, 'docked panel drag changes width');
  const afterResize = await page.locator('.assistant-shell').boundingBox();
  measurements.dock = { beforeResize, afterResize, dockedDrag };
  await page.getByRole('button', { name: '取消固定阅读伙伴', exact: true }).click();
  samePosition(await floatingPosition(), rememberedFloatingPosition, 'Unpinning must restore the last floating position');
  await page.getByRole('button', { name: '固定阅读伙伴', exact: true }).click();
  check('Pinned AI ignores title dragging, resizes from its separator and retains its floating position when unpinned');

  await navigation(true);
  await setView(0, 2, '1.25'); await setView(1, 2, '0.75');
  await waitWorkspace(w => w.layout.views?.left?.state.page === 2 && w.layout.views?.right?.state.page === 2, 'independent page positions saved');
  const beforeFocus = { views: await viewState(), bounds: await page.locator('.pdf-columns').boundingBox(), aiWidth: (await page.locator('.assistant-shell').boundingBox()).width, preferences: await page.evaluate(() => localStorage.getItem('folio.reading-layout.v1')) };
  await page.getByRole('button', { name: '专注阅读', exact: true }).click();
  await page.locator('.assistant-shell').waitFor({ state: 'hidden' });
  await page.locator('.app-sidebar.in-workspace, .app-rail').waitFor({ state: 'hidden' });
  assert.ok((await page.locator('.pdf-columns').boundingBox()).width > beforeFocus.bounds.width + 150);
  assert.deepEqual(await viewState(), beforeFocus.views);
  assert.equal(await page.locator('.assistant-shell textarea[aria-label="向 AI 提问"]').inputValue(), draft);
  assert.equal(await page.evaluate(() => localStorage.getItem('folio.reading-layout.v1')), beforeFocus.preferences);
  await page.getByRole('button', { name: '退出专注阅读', exact: true }).click();
  await page.locator('.assistant-shell').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '收起文章导航', exact: true }).waitFor();
  sameBounds(await page.locator('.pdf-columns').boundingBox(), beforeFocus.bounds, 'Exiting focus restores dock and navigation');
  assert.deepEqual(await viewState(), beforeFocus.views);
  assert.equal(await page.locator('.assistant-shell textarea[aria-label="向 AI 提问"]').inputValue(), draft);
  assert.deepEqual((await state()).settings, originalSettings);
  await page.screenshot({ path: path.join(output, 'reading-layout-focus-restored.png') });
  check('Focus mode restores navigation, dock width, independent views and unsent AI draft without changing API settings');

  const title = (await workspace()).title;
  await page.reload();
  await page.getByRole('button', { name: `打开 ${title}`, exact: true }).click();
  await pane(1).locator('.textLayer span').first().waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '取消固定阅读伙伴', exact: true }).waitFor();
  await page.getByRole('button', { name: '收起文章导航', exact: true }).waitFor();
  assert.ok(Math.abs((await page.locator('.assistant-shell').boundingBox()).width - beforeFocus.aiWidth) <= 2);
  assert.deepEqual(await viewState(), beforeFocus.views);
  assert.deepEqual((await state()).settings, originalSettings);
  check('Reading layout preferences survive reopening independently of provider settings');

  await assistant(false); await navigation(false);
  await setView(0, 1, 'page-width'); await setView(1, 1, 'page-width');
  await closePDFSidebars();
  const initial = await workspace();
  const documentIds = [initial.layout.leftId, initial.layout.rightId];
  assert.notEqual(documentIds[0], documentIds[1]);
  const definitions = [{ side: 0, kind: 'highlight', label: '荧光笔' }, { side: 0, kind: 'underline', label: '下划线' }, { side: 1, kind: 'strikeout', label: '删除线' }];
  const created = [];
  for (const definition of definitions) {
    await focusPDF(definition.side);
    await toolbar().getByRole('button', { name: '选择文字', exact: true }).click();
    const previous = (await workspace()).documents.find(document => document.id === documentIds[definition.side]).annotations.map(item => item.id);
    await selectText(definition.side);
    await toolbar().getByRole('button', { name: definition.label, exact: true }).click();
    await waitWorkspace(w => w.documents.find(document => document.id === documentIds[definition.side]).annotations.length === previous.length + 1, `${definition.kind} stored from real selection`);
    const saved = (await workspace()).documents.find(document => document.id === documentIds[definition.side]).annotations.find(item => !previous.includes(item.id));
    assert.equal(saved.kind || 'highlight', definition.kind); assert.ok(saved.rects.length > 0);
    created.push({ ...definition, id: saved.id, documentId: documentIds[definition.side] });
    await toolbar().getByRole('button', { name: '选择文字', exact: true }).click();
  }
  check('Real text selection creates highlight, underline and strikeout across two PDF files');

  const latest = created.at(-1);
  await historyShortcut('undo', 0);
  await waitUntil(async () => !(await annotation(latest.documentId, latest.id)), 'undo targets most recent edit in opposite PDF');
  await historyShortcut('redo', 0);
  await waitUntil(async () => Boolean(await annotation(latest.documentId, latest.id)), 'redo restores opposite PDF annotation');
  check('Workspace-wide undo and redo follow edit order across PDF panes');
  if (process.platform === 'darwin') {
    await focusPDF(0); await page.keyboard.press('Control+z');
    await waitUntil(async () => !(await annotation(latest.documentId, latest.id)), 'Mac Control+z undoes the document edit');
    await focusPDF(0); await page.keyboard.press('Control+Shift+z');
    await waitUntil(async () => Boolean(await annotation(latest.documentId, latest.id)), 'Mac Control+Shift+z redoes the document edit');
    check('Mac accepts literal Control+Z and Control+Shift+Z for PDF undo and redo alongside Command shortcuts');
  }

  for (const item of created) {
    const original = structuredClone(await annotation(item.documentId, item.id));
    const editedKind = item.kind === 'underline' ? 'strikeout' : 'underline';
    const comment = `Edited ${item.kind}: 阅读与证据`;
    await openAnnotation(item.side, item.id);
    await pane(item.side).getByRole('combobox', { name: '批注类型', exact: true }).selectOption(editedKind);
    await pane(item.side).getByRole('textbox', { name: '批注内容', exact: true }).fill(comment);
    await pane(item.side).getByRole('button', { name: '保存批注', exact: true }).click();
    await waitUntil(async () => (await annotation(item.documentId, item.id))?.comment === comment, `${item.kind} comment edit persisted`);
    assert.equal((await annotation(item.documentId, item.id)).kind, editedKind);
    await historyShortcut('undo', 1 - item.side);
    await waitUntil(async () => JSON.stringify(await annotation(item.documentId, item.id)) === JSON.stringify(original), `undo ${item.kind} edit`);
    await historyShortcut('redo', 1 - item.side);
    await waitUntil(async () => (await annotation(item.documentId, item.id))?.comment === comment, `redo ${item.kind} edit`);
    await historyShortcut('undo', 1 - item.side);
    await waitUntil(async () => JSON.stringify(await annotation(item.documentId, item.id)) === JSON.stringify(original), `restore original ${item.kind} for deletion check`);
    await openAnnotation(item.side, item.id);
    await pane(item.side).getByRole('button', { name: '删除批注', exact: true }).click();
    await waitUntil(async () => !(await annotation(item.documentId, item.id)), `delete ${item.kind}`);
    await historyShortcut('undo', 1 - item.side);
    await waitUntil(async () => Boolean(await annotation(item.documentId, item.id)), `undo delete ${item.kind}`);
    await historyShortcut('redo', 1 - item.side);
    await waitUntil(async () => !(await annotation(item.documentId, item.id)), `redo delete ${item.kind}`);
    await historyShortcut('undo', 1 - item.side);
    await waitUntil(async () => JSON.stringify(await annotation(item.documentId, item.id)) === JSON.stringify(original), `final persisted ${item.kind} restoration`);
  }
  check('All three annotation kinds support UI type/comment edits, deletion, undo and redo across both PDFs');

  await closePDFSidebars();
  const beforeInput = await annotations();
  const beforeInputHistory = await page.evaluate(id => window.folio.getDocumentEditHistory(id), workspaceId);
  await assistant(true, true);
  const composer = page.getByRole('textbox', { name: '向 AI 提问', exact: true });
  await composer.fill(''); await composer.pressSequentially('Native editor undo test', { delay: 20 });
  const fullInput = await composer.inputValue();
  await composer.press(`${modifier}+z`);
  await waitUntil(async () => (await composer.inputValue()) !== fullInput, 'native textarea undo changes its own text');
  assert.deepEqual(await annotations(), beforeInput);
  assert.deepEqual(await page.evaluate(id => window.folio.getDocumentEditHistory(id), workspaceId), beforeInputHistory);
  check('Undo inside the AI input edits native text without undoing PDF annotations or changing document history');
  if (process.platform === 'darwin') {
    await composer.fill(''); await composer.pressSequentially('Literal Control undo inside input', { delay: 20 });
    const controlInput = await composer.inputValue();
    await composer.press('Control+z');
    await waitUntil(async () => (await composer.inputValue()) !== controlInput, 'Mac Control+z routes to native text undo');
    assert.deepEqual(await annotations(), beforeInput);
    assert.deepEqual(await page.evaluate(id => window.folio.getDocumentEditHistory(id), workspaceId), beforeInputHistory);
    await composer.press('Control+Shift+z');
    await waitUntil(async () => (await composer.inputValue()) === controlInput, 'Mac Control+Shift+z routes to native text redo');
    check('Mac literal Control+Z and Control+Shift+Z undo/redo input text without modifying annotation history');
  }
  await assistant(false);

  for (const [index, definition] of definitions.entries()) {
    const side = index % 2;
    await focusPDF(side); await toolbar().getByRole('button', { name: '选择文字', exact: true }).click();
    await selectText(side); await rightClickSelection(side);
    const before = (await workspace()).documents.find(document => document.id === documentIds[side]).annotations.length;
    await page.getByRole('menuitem', { name: definition.kind === 'highlight' ? '荧光高亮' : definition.label, exact: true }).click();
    await waitWorkspace(w => w.documents.find(document => document.id === documentIds[side]).annotations.length === before + 1, `right-click ${definition.kind}`);
  }
  check('Real PDF right-click menu creates each of the three annotation kinds');

  // Use an unmarked page so the context-menu comment has its own visible pin.
  await setView(0, 3, 'page-width');
  await focusPDF(0); await toolbar().getByRole('button', { name: '选择文字', exact: true }).click();
  const beforeComment = await annotations();
  const selectedQuote = await selectText(0);
  const selectedPage = await pane(0).locator('.pdf-viewer-container').evaluate(element => {
    const anchor = window.getSelection()?.anchorNode;
    if (!anchor || !element.contains(anchor)) throw new Error('Comment test requires a native selection in the main PDF');
    return Number((anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement).closest('.page').dataset.pageNumber);
  });
  assert.equal(selectedPage, 3, 'Comment selection should identify its actual PDF page');
  await rightClickSelection(0);
  await page.getByRole('menuitem', { name: '添加批注', exact: true }).click();
  const newCommentInput = toolbar().getByRole('textbox', { name: '新批注', exact: true });
  const commentText = '右键阅读批注：这里的证据值得核查。\nKeep the original quotation and page.';
  await newCommentInput.fill(commentText);
  assert.deepEqual(await annotations(), beforeComment, 'Opening and typing a new comment must not save an annotation');
  await toolbar().getByRole('button', { name: '保存', exact: true }).click();
  const previousCommentIds = beforeComment.find(item => item.id === documentIds[0]).annotations.map(item => item.id);
  await waitWorkspace(w => w.documents.find(document => document.id === documentIds[0]).annotations.length === previousCommentIds.length + 1, 'context-menu comment saved exactly once');
  const savedComment = structuredClone((await workspace()).documents.find(document => document.id === documentIds[0]).annotations.find(item => !previousCommentIds.includes(item.id)));
  assert.equal(savedComment.page, selectedPage);
  assert.equal(savedComment.text, selectedQuote);
  assert.equal(savedComment.comment, commentText);
  assert.ok(savedComment.rects.length > 0 && savedComment.rects.every(rect => rect.length === 4 && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]), 'Saved comment must keep valid PDF selection rectangles');
  assert.deepEqual((await annotations()).find(item => item.id === documentIds[1]), beforeComment.find(item => item.id === documentIds[1]));
  measurements.contextComment = { id: savedComment.id, documentId: documentIds[0], page: savedComment.page, quote: savedComment.text, comment: savedComment.comment };
  check('Selected PDF text opens a right-click comment editor and saves one annotation with its page, quotation and comment');

  await focusPDF(0); await toolbar().getByRole('button', { name: '选择文字', exact: true }).click();
  await selectText(0); await rightClickSelection(0);
  const beforeCancel = await annotations();
  const historyBeforeCancel = await page.evaluate(id => window.folio.getDocumentEditHistory(id), workspaceId);
  await page.getByRole('menuitem', { name: '添加批注', exact: true }).click();
  await newCommentInput.fill('Cancelled comment must never be saved');
  await toolbar().getByRole('button', { name: '取消', exact: true }).click();
  await newCommentInput.waitFor({ state: 'hidden' });
  assert.deepEqual(await annotations(), beforeCancel);
  assert.deepEqual(await page.evaluate(id => window.folio.getDocumentEditHistory(id), workspaceId), historyBeforeCancel);
  check('Cancelling a new right-click comment leaves saved annotations and undo history unchanged');

  await focusPDF(0);
  const commentMark = pane(0).locator(`.page[data-page-number="3"] .folio-markup[data-annotation-id="${savedComment.id}"]`).first();
  await commentMark.waitFor();
  const commentMarkBounds = await commentMark.boundingBox();
  assert.ok(commentMarkBounds?.width > 0 && commentMarkBounds.height > 0, 'The saved comment must have a visible PDF mark');
  // Mark overlays intentionally ignore pointer events; right-click their real
  // coordinates so the PDF text layer exercises geometric annotation hit testing.
  await page.mouse.click(commentMarkBounds.x + commentMarkBounds.width / 2, commentMarkBounds.y + commentMarkBounds.height / 2, { button: 'right' });
  await page.getByRole('menuitem', { name: '编辑批注', exact: true }).click();
  const existingCommentInput = pane(0).getByRole('textbox', { name: '批注内容', exact: true });
  await existingCommentInput.waitFor();
  assert.equal(await existingCommentInput.inputValue(), savedComment.comment, 'Right-clicking marked text must open the existing annotation comment');
  assert.deepEqual(await annotations(), beforeCancel, 'Opening an existing comment must not modify saved annotations');
  await closePDFSidebars();
  await focusPDF(0);
  const commentPin = pane(0).locator(`.folio-comment-pin[data-annotation-id="${savedComment.id}"]`);
  await commentPin.click({ button: 'right' });
  await page.getByRole('menu', { name: 'PDF 操作', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: '删除批注', exact: true }).click();
  await waitUntil(async () => !(await annotation(documentIds[0], savedComment.id)), 'pin context-menu deletion persisted');
  await commentPin.waitFor({ state: 'detached' });
  assert.deepEqual(await annotations(), beforeComment, 'Deleting the context-menu comment must leave every prior annotation intact');
  await historyShortcut('undo', 1);
  await waitUntil(async () => JSON.stringify(await annotation(documentIds[0], savedComment.id)) === JSON.stringify(savedComment), 'undo restores the deleted comment from the opposite PDF');
  await commentPin.waitFor();
  assert.deepEqual(await annotations(), beforeCancel);
  check('Marked text opens its existing comment; pin context deletion removes only that annotation and Command/Control+Z restores it');

  // The sole direct annotation fixture represents an old saved workspace whose
  // annotation predates the optional kind field; all new edits above use UI.
  const legacyId = 'legacy-highlight-without-kind';
  await page.evaluate(async ({ workspaceId, documentId, legacyId }) => {
    const w = (await window.folio.bootstrap()).workspaces.find(item => item.id === workspaceId);
    const document = w.documents.find(item => item.id === documentId);
    await window.folio.updateDocument(workspaceId, documentId, { annotations: [...document.annotations, { id: legacyId, page: 1, text: 'Legacy highlight evidence', comment: '旧格式兼容', color: '#ffda63', rects: [[58, 650, 200, 664]], createdAt: Date.now() }] });
  }, { workspaceId, documentId: documentIds[0], legacyId });
  const expectedAnnotations = await annotations();
  await app.close(); app = null;
  await launch();
  await page.getByRole('button', { name: `打开 ${title}`, exact: true }).click();
  await pane(1).locator('.textLayer span').first().waitFor();
  assert.deepEqual(await annotations(), expectedAnnotations);
  assert.deepEqual(await page.evaluate(id => window.folio.getDocumentEditHistory(id), workspaceId), { canUndo: false, canRedo: false });
  check('Final undo results and all annotation kinds survive a full app restart; session edit history resets');
  await assistant(true);
  const unpin = page.getByRole('button', { name: '取消固定阅读伙伴', exact: true });
  if (await unpin.isVisible()) await unpin.click();
  samePosition(await floatingPosition(), rememberedFloatingPosition, 'Full application restart must preserve the last dragged floating position');
  withinReader(await page.locator('.assistant-shell').boundingBox(), await page.locator('.reader-body').boundingBox());
  await assistant(false);
  check('Dragged floating position survives a full application restart and remains inside the reader');

  const exportedTypes = [];
  for (const side of [0, 1]) {
    const destination = path.join(output, `reading-annotations-${side ? 'supplement' : 'main'}.pdf`);
    await rm(destination, { force: true });
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    await pane(side).getByRole('button', { name: '阅读模式与导出', exact: true }).click();
    await pane(side).getByRole('button', { name: '导出 PDF（含目录与批注）', exact: true }).click();
    await waitUntil(async () => { try { return (await readFile(destination)).length > 100; } catch { return false; } }, 'actual PDF export file');
    const pdf = await PDFDocument.load(await readFile(destination));
    const byId = new Map(), contentsById = new Map();
    for (const pdfPage of pdf.getPages()) {
      const list = pdfPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!list) continue;
      for (let i = 0; i < list.size(); i++) {
        const item = list.lookup(i, PDFDict);
        const name = item.get(PDFName.of('NM'));
        if (!name?.decodeText) continue;
        const type = String(item.get(PDFName.of('Subtype')));
        byId.set(name.decodeText(), type); exportedTypes.push(type);
        const contents = item.get(PDFName.of('Contents'));
        if (contents?.decodeText) contentsById.set(name.decodeText(), contents.decodeText());
        assert.ok(item.lookup(PDFName.of('QuadPoints'), PDFArray).size() >= 8);
        if (type === '/Underline' || type === '/StrikeOut') assert.ok(item.lookup(PDFName.of('AP'), PDFDict), 'Line markup must contain an appearance dictionary');
      }
    }
    for (const expected of expectedAnnotations.find(item => item.id === documentIds[side]).annotations) {
      assert.equal(byId.get(expected.id), { highlight: '/Highlight', underline: '/Underline', strikeout: '/StrikeOut' }[expected.kind || 'highlight']);
      if (expected.comment) assert.equal(contentsById.get(expected.id), [expected.text, expected.comment].filter(Boolean).join('\n\n'), 'Exported PDF must preserve the original quotation and comment, including Unicode and newlines');
    }
    if (side === 0) assert.equal(byId.get(legacyId), '/Highlight');
    await pane(side).getByRole('button', { name: '关闭阅读设置', exact: true }).click();
  }
  for (const type of ['/Highlight', '/Underline', '/StrikeOut']) assert.ok(exportedTypes.includes(type));
  check('UI export preserves comments and quotations, native markup types, line appearance streams and legacy highlights');
  assert.deepEqual(failures, []);
  check('No renderer JavaScript errors');
  await page.screenshot({ path: path.join(output, 'reading-annotations-complete.png') });
  await writeFile(path.join(output, 'e2e-reading-report.json'), JSON.stringify({ checks, failures, measurements, userData, executablePath: executablePath || 'development Electron' }, null, 2));
  await Promise.all(['e2e-reading-failure.json', 'e2e-reading-failure.png'].map(name => rm(path.join(output, name), { force: true })));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'e2e-reading-failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'e2e-reading-failure.json'), JSON.stringify({ checks, failures, measurements, error: error.stack || String(error), userData }, null, 2));
  throw error;
} finally { if (app) await app.close(); }
console.log(`${checks.length} reading integration checks passed. Artifacts: ${output}`);
