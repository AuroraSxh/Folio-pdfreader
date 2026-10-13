import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Actual PDF selection, React controls, preload, IPC and persistence. Synthetic
// local papers only; no API key, AI request, microphone, or personal library.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/comment-popover');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-comment-popover-'));
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const workspaceId = 'comment-popover-fixture', checks = [], errors = [], measurements = [];
const idleObservation = { cpuDefinition: 'Cumulative CPU seconds delta / elapsed wall seconds * 100; 100% = one logical core. GPU process CPU is CPU activity, not GPU chip utilization.', stages: [] };
const title = 'Comment popover fixture';
const idleOnly = process.env.FOLIO_COMMENT_IDLE_ONLY === '1';
let app, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pane = side => page.locator('.pdf-pane').nth(side);
const dialog = () => page.getByRole('dialog', { name: '添加批注', exact: true });
const toolbar = () => page.getByRole('toolbar', { name: '文字与批注工具', exact: true });
const state = () => page.evaluate(() => window.folio.bootstrap());
const workspace = async () => (await state()).workspaces.find(item => item.id === workspaceId);
const annotations = async () => (await workspace()).documents.map(document => ({ id: document.id, annotations: document.annotations }));
async function waitFor(predicate, label, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(70); }
  throw new Error('Timed out: ' + label);
}
async function seed() {
  const directory = path.join(profile, 'Library', workspaceId);
  await mkdir(path.join(directory, '.text'), { recursive: true });
  const documents = [];
  for (const id of ['main', 'supplement']) {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    const text = [];
    for (let index = 1; index <= 3; index++) {
      const sheet = pdf.addPage([600, 800]);
      const passages = [
        ['Upper left passage', 35, 745], ['Upper right passage', 385, 720],
        ['Middle evidence passage', 65, 390], ['Lower right passage', 385, 60],
      ];
      for (const [passage, x, y] of passages) sheet.drawText(passage, { x, y, font, size: 12 });
      text.push(passages.map(([passage]) => passage).join('\n'));
    }
    const bytes = await pdf.save(), fileName = `${id}.pdf`;
    await writeFile(path.join(directory, fileName), bytes);
    await writeFile(path.join(directory, '.text', `${id}.json`), JSON.stringify(text));
    documents.push({ id, name: fileName, fileName, role: id === 'main' ? 'main' : 'supplement', size: bytes.length,
      pageCount: 3, outline: [], outlineLoaded: true, textStatus: 'ready', annotations: [],
      view: { page: 1, scale: '1', rotation: 0, scrollMode: 0, spreadMode: 0 } });
  }
  const now = Date.now();
  await writeFile(path.join(directory, 'workspace.json'), JSON.stringify({ version: 1, id: workspaceId, title, titleStatus: 'confirmed', authors: '', journal: '', doi: '', tags: [], favorite: false,
    createdAt: now, updatedAt: now, lastReadAt: now, documents, notes: '', memories: [], memoryIndex: '',
    conversations: [{ id: 'conversation', title: 'Comment checks', createdAt: now, messages: [] }], activeConversationId: 'conversation',
    layout: { split: true, direction: 'vertical', leftId: 'main', rightId: 'supplement', ratio: 50 } }));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {}, annotationToolbar: 'floating' }));
}
async function configure(mode) {
  if (await page.locator('.pdf-pane').count()) {
    await page.locator('.back-button').click();
    await waitFor(async () => await page.locator('.pdf-pane').count() === 0, 'readers unmounted before fixture view reset');
  }
  await page.evaluate(async ({ id, mode }) => {
    const data = await window.folio.bootstrap(), ws = data.workspaces.find(item => item.id === id);
    await window.folio.saveSettings({ ...data.settings, annotationToolbar: mode });
    await window.folio.updateWorkspace(id, { layout: { ...ws.layout, split: true, direction: 'vertical', leftId: 'main', rightId: 'supplement', ratio: 50 } });
    const view = { page: 1, scale: '1', rotation: 0, scrollMode: 0, spreadMode: 0 };
    await window.folio.updateView(id, 'main', 'left', view);
    await window.folio.updateView(id, 'supplement', 'right', view);
  }, { id: workspaceId, mode });
  await page.reload();
  await page.getByRole('button', { name: `打开 ${title}`, exact: true }).click();
  for (const side of [0, 1]) await pane(side).locator('.page[data-page-number="1"] .textLayer span').first().waitFor();
  assert.equal((await state()).settings.annotationToolbar, mode);
}
async function select(side, passage) {
  const target = pane(side).locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: passage }).first();
  await target.scrollIntoViewIfNeeded();
  let box, previous, stableSince = Date.now();
  await waitFor(async () => {
    box = await target.boundingBox();
    if (!box) return false;
    const value = JSON.stringify(box);
    if (value !== previous) { previous = value; stableSince = Date.now(); }
    return Date.now() - stableSince > 180;
  }, 'selectable PDF text settles');
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
  await waitFor(() => toolbar().getByRole('button', { name: '复制选中文字', exact: true }).isEnabled(), 'native selection delivered to toolbar');
  return page.evaluate(() => {
    const selection = window.getSelection(), rect = selection.getRangeAt(0).getBoundingClientRect();
    return { text: selection.toString().trim(), box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  });
}
async function openComment(side, selected, method = 'context') {
  if (method === 'toolbar') await toolbar().getByRole('button', { name: '批注', exact: true }).click();
  else {
    if (method === 'keyboard') {
      await pane(side).locator('.pdf-viewer-container').evaluate(element => element.focus({ preventScroll: true }));
      await page.keyboard.press('Shift+F10');
    } else await page.mouse.click(selected.box.x + selected.box.width / 2, selected.box.y + selected.box.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: '添加批注', exact: true }).click();
  }
  await dialog().waitFor();
  assert.equal(await dialog().count(), 1);
  assert.equal(await dialog().getByRole('textbox', { name: '新批注', exact: true }).evaluate(element => element === document.activeElement), true, 'New comment receives keyboard focus');
  assert.equal(await dialog().evaluate(element => element.closest('.shared-annotation-host') === null), true, 'Editor is independent from the shared toolbar');
  assert.equal(await dialog().getAttribute('data-document-id'), side === 0 ? 'main' : 'supplement');
  assert.equal(await dialog().locator('blockquote').textContent(), selected.text);
}
async function geometry(side, label, selected) {
  const popup = await dialog().boundingBox(), area = await pane(side).locator('.pdf-viewer-container').boundingBox();
  assert.ok(popup && area);
  assert.ok(popup.x >= area.x - 1 && popup.y >= area.y - 1, label + ': top/left within active PDF');
  assert.ok(popup.x + popup.width <= area.x + area.width + 1 && popup.y + popup.height <= area.y + area.height + 1, label + ': bottom/right within active PDF');
  if (selected) {
    const distance = Math.min(Math.abs(popup.y - selected.box.y - selected.box.height), Math.abs(popup.y + popup.height - selected.box.y));
    assert.ok(distance <= 16, label + ': comment is adjacent to the selected passage, not the toolbar');
  }
  measurements.push({ label, popup, area });
  return popup;
}
async function closeSidebars() {
  for (const side of [0, 1]) {
    const button = pane(side).getByRole('button', { name: '目录、缩略图与批注', exact: true });
    if (await button.getAttribute('aria-pressed') === 'true') await button.click();
  }
}
async function observeIdle(label) {
  const sample = async () => {
    const native = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { time: Date.now(), isFocused: window.isFocused(), isVisible: window.isVisible(), metrics: app.getAppMetrics() };
    });
    return { ...native, renderer: await page.evaluate(() => ({ visibilityState: document.visibilityState, hasFocus: document.hasFocus() })) };
  };
  await sample(); // Warm up Electron's process CPU sampling before the baseline.
  await delay(350);
  await page.evaluate(() => {
    const target = document.querySelector('.folio-new-comment-popover');
    const probe = window.__commentIdleProbe = { count: 0, observer: null };
    if (target) {
      probe.observer = new MutationObserver(records => { probe.count += records.length; });
      probe.observer.observe(target, { attributes: true, attributeFilter: ['style'] });
    }
  });
  const before = await sample();
  await delay(3000);
  const after = await sample(), seconds = (after.time - before.time) / 1000;
  const styleMutations = await page.evaluate(() => { const probe = window.__commentIdleProbe; probe.observer?.disconnect(); delete window.__commentIdleProbe; return probe.count; });
  const processes = after.metrics.map(metric => {
    const prior = before.metrics.find(item => item.pid === metric.pid && item.creationTime === metric.creationTime);
    const delta = prior && Number.isFinite(metric.cpu.cumulativeCPUUsage) && Number.isFinite(prior.cpu.cumulativeCPUUsage)
      ? Math.max(0, metric.cpu.cumulativeCPUUsage - prior.cpu.cumulativeCPUUsage) : null;
    return { pid: metric.pid, type: metric.type, cpuSeconds: delta, cpuPercent: delta === null ? null : delta / seconds * 100, workingSetMiB: metric.memory.workingSetSize / 1024 };
  });
  const complete = processes.every(item => item.cpuPercent !== null) && before.metrics.every(metric => after.metrics.some(item => item.pid === metric.pid && item.creationTime === metric.creationTime));
  const result = { label, seconds, samples: [before, after], processes, complete,
    cpuPercent: complete ? processes.reduce((sum, item) => sum + item.cpuPercent, 0) : null,
    gpuProcessCpuPercent: processes.filter(item => item.type === 'GPU').reduce((sum, item) => sum + (item.cpuPercent ?? 0), 0), styleMutations };
  idleObservation.stages.push(result);
  assert.equal(styleMutations, 0, 'An idle comment must not keep rewriting its position');
  console.log(`IDLE ${label}: ${result.cpuPercent?.toFixed(3) ?? 'unavailable'}% of one CPU core; GPU-process CPU ${result.gpuProcessCpuPercent.toFixed(3)}%; focused ${before.isFocused}/${after.isFocused}; visibility ${before.renderer.visibilityState}/${after.renderer.visibilityState}; position writes ${styleMutations}`);
}

try {
  await seed();
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  page = await app.firstWindow(); page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: `打开 ${title}`, exact: true }).waitFor();
  await page.waitForLoadState('load');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1640, 1060));
  let selected;
  if (!idleOnly) {
  for (const mode of ['floating', 'fixed', 'selection']) {
    await configure(mode);
    for (const side of [0, 1]) {
      const before = await annotations();
      const history = await page.evaluate(id => window.folio.getDocumentEditHistory(id), workspaceId);
      const selected = await select(side, side === 0 ? 'Middle evidence passage' : 'Lower right passage');
      await openComment(side, selected, mode === 'fixed' ? 'keyboard' : side === 0 ? 'toolbar' : 'context');
      await geometry(side, `${mode} pane ${side}`, selected);
      const input = dialog().getByRole('textbox', { name: '新批注', exact: true });
      const comment = `Comment ${mode} ${side} · 保留选中文字`;
      await input.fill(comment);
      if (mode === 'fixed' && side === 0) await page.screenshot({ path: path.join(output, 'comment-next-to-selection-fixed-toolbar.png') });
      if (mode === 'floating' && side === 1) await page.screenshot({ path: path.join(output, 'comment-next-to-selection-right-pane.png') });
      assert.deepEqual(await annotations(), before, 'Typing alone must not write an annotation');
      if (mode === 'floating' && side === 0) {
        const beforeScroll = await geometry(side, 'before scroll');
        const area = await pane(side).locator('.pdf-viewer-container').boundingBox();
        await page.mouse.move(area.x + 8, area.y + area.height / 2); await page.mouse.wheel(0, 60);
        await waitFor(async () => Math.abs((await dialog().boundingBox()).y - beforeScroll.y) > 20, 'popover follows PDF scrolling');
        await geometry(side, 'after scroll');
        await pane(side).getByRole('combobox', { name: '缩放比例', exact: true }).selectOption('1.25');
        await delay(250); await geometry(side, 'after zoom');
        assert.equal(await input.inputValue(), comment);
        await pane(side).getByRole('button', { name: '阅读模式与导出', exact: true }).click();
        await pane(side).getByRole('button', { name: '顺时针旋转 90°', exact: true }).click();
        await pane(side).getByRole('button', { name: '关闭阅读设置', exact: true }).click();
        await delay(250); await geometry(side, 'after rotation');
        await dialog().getByRole('button', { name: '保存', exact: true }).click();
        await waitFor(async () => (await workspace()).documents.find(document => document.id === 'main').annotations.length === 1, 'comment saved through real IPC');
        const saved = (await workspace()).documents.find(document => document.id === 'main').annotations[0];
        assert.equal(saved.comment, comment); assert.equal(saved.text, selected.text); assert.equal(saved.page, 1);
        assert.ok(saved.rects.length && saved.rects.every(rect => rect.length === 4 && rect.every(Number.isFinite)));
        await page.getByRole('button', { name: '撤销上一步', exact: true }).click();
        await waitFor(async () => JSON.stringify(await annotations()) === JSON.stringify(before), 'undo restores all annotations');
        await closeSidebars();
        pass('Save keeps the captured quotation/page through scrolling, zoom and rotation, and remains undoable');
      } else {
        if (mode === 'fixed' && side === 1) {
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 740));
          await delay(250); await geometry(side, 'narrow window');
        }
        if (side === 0) await input.press('Escape');
        else await dialog().getByRole('button', { name: '取消', exact: true }).click();
        await dialog().waitFor({ state: 'hidden' });
        assert.deepEqual(await annotations(), before);
        assert.deepEqual(await page.evaluate(id => window.folio.getDocumentEditHistory(id), workspaceId), history);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1640, 1060));
      }
    }
    pass(`${mode}: both panes anchor comments beside native selections; keyboard/context/toolbar entry and cancellation preserve data`);
  }

  await configure('fixed');
  selected = await select(0, 'Upper left passage');
  await openComment(0, selected);
  await dialog().getByRole('textbox', { name: '新批注', exact: true }).fill('Draft follows the document during equal-size pane exchange');
  const handle = page.locator('.reading-column[data-pane-side="left"] [data-pane-swap-handle]');
  await handle.focus(); await page.keyboard.press('Enter');
  await waitFor(async () => (await workspace()).layout.rightId === 'main', 'document panes exchange');
  await waitFor(async () => {
    const box = await dialog().boundingBox(), area = await pane(1).boundingBox();
    return box && area && box.x >= area.x;
  }, 'popover moves with an equal-width exchanged pane');
  await geometry(1, 'equal-size pane exchange');
  assert.equal(await dialog().getAttribute('data-document-id'), 'main');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  pass('Equal-size pane exchange moves the existing draft to the document’s new reading area');

  await configure('fixed');
  const beforeSwitch = await annotations();
  selected = await select(0, 'Middle evidence passage'); await openComment(0, selected);
  await dialog().getByRole('textbox', { name: '新批注', exact: true }).fill('Never write this draft into another PDF');
  await page.getByRole('combobox', { name: '左侧 PDF', exact: true }).selectOption('supplement');
  await dialog().waitFor({ state: 'hidden' });
  assert.deepEqual(await annotations(), beforeSwitch);
  pass('Changing a pane’s document removes its unsaved popover without modifying either PDF');

  await configure('fixed');
  selected = await select(0, 'Middle evidence passage'); await openComment(0, selected);
  await page.locator('.workspace-top-title').click();
  const modal = page.locator('.modal-overlay'); await modal.waitFor();
  assert.ok(await dialog().evaluate(element => {
    const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + 15, r.y + 15);
    return !!hit?.closest('.modal-overlay');
  }), 'Global modal must cover the comment popover');
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  pass('Global metadata modal remains above the non-modal comment editor');
  }
  await configure('fixed');
  selected = await select(0, 'Middle evidence passage'); await openComment(0, selected);
  await dialog().getByRole('textbox', { name: '新批注', exact: true }).fill('Short idle observation only');
  await observeIdle('draft-open');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await observeIdle('draft-closed');
  pass('Open and closed draft idle observations record process CPU/focus without continuous position writes');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'e2e-comment-popover-report.json'), JSON.stringify({ passed: true, mode: idleOnly ? 'idle-only' : 'full', checks, errors, measurements, idleObservation }, null, 2));
  await rm(path.join(output, 'e2e-comment-popover-failure.png'), { force: true });
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(output, 'e2e-comment-popover-failure.png') }).catch(() => {});
  const bootError = page ? await page.locator('.boot-screen').innerText().catch(() => '') : '';
  await writeFile(path.join(output, 'e2e-comment-popover-report.json'), JSON.stringify({ passed: false, mode: idleOnly ? 'idle-only' : 'full', checks, errors, measurements, idleObservation, error: String(error), bootError }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) {
    let closeTimer;
    try {
      await Promise.race([app.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Test app close timed out')), 12000); })]);
    } catch (error) {
      // A renderer error boundary can remove the close-handshake listener. Only
      // terminate the child created by this test; never enumerate user apps.
      const child = app.process();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL'); await exited;
      }
      console.error(error); process.exitCode = 1;
    } finally { clearTimeout(closeTimer); }
  }
  await rm(profile, { recursive: true, force: true });
}
