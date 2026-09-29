import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Real PDF.js, preload, IPC and persistence; generated local PDFs and existing
// fixture answers only. No provider key, network AI request or microphone.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/source-navigation');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-source-e2e-'));
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const workspaceId = 'source-navigation-fixture';
const directory = path.join(profile, 'Library', workspaceId);
const checks = [], errors = [], measurements = {};
let app, page;
const quote = 'Macrophages increased after treatment and remained detectable for seven days.';
const supplementQuote = 'Supplementary experiments confirmed the receptor binding measurement.';
const hiddenQuote = 'The third document contains independent validation of the main experiment.';
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const state = () => page.evaluate(() => window.folio.bootstrap());
const workspace = async () => (await state()).workspaces.find(value => value.id === workspaceId);
const pane = side => page.locator('.pdf-pane').nth(side);
const answer = prefix => page.locator('.fl-message.assistant .fl-markdown').filter({ hasText: prefix });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(75); }
  throw new Error('Timed out: ' + label);
}
async function seed() {
  await mkdir(path.join(directory, '.text'), { recursive: true });
  const documents = [];
  for (const [id, name, excerpt] of [
    ['main', 'Main paper.pdf', quote], ['supplement', 'Supplement.pdf', supplementQuote], ['hidden', 'Validation.pdf', hiddenQuote],
  ]) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) {
      const sheet = pdf.addPage([600, 800]);
      sheet.drawText(`${id} fixture page ${i}`, { x: 40, y: 750, font, size: 16 });
      sheet.drawText('This page is local synthetic test data, not a real academic paper.', { x: 40, y: 710, font, size: 11 });
      if (i === 2) {
        const words = excerpt.split(' '), split = Math.floor(words.length / 2);
        sheet.drawText(words.slice(0, split).join(' '), { x: 40, y: 280, font, size: 13 });
        sheet.drawText(words.slice(split).join(' '), { x: 40, y: 255, font, size: 13 });
      }
    }
    const bytes = await pdf.save();
    await writeFile(path.join(directory, name), bytes);
    await writeFile(path.join(directory, '.text', `${id}.json`), JSON.stringify(['First fixture page.', excerpt, 'Last fixture page.']));
    documents.push({ id, name, fileName: name, role: id === 'main' ? 'main' : 'supplement', size: bytes.length,
      pageCount: 3, outline: [], outlineLoaded: true, annotations: [], textStatus: 'ready',
      view: { page: 1, scale: '0.75', rotation: 0, scrollMode: 0, spreadMode: 0 } });
  }
  const contents = [
    `Main finding: treatment increased macrophages. [Main paper.pdf p.2 | ${quote}]`,
    `Supplement finding: the experiment confirms binding. [Supplement.pdf p.2 | ${supplementQuote}]`,
    `Both sources support this comparison. [Main paper.pdf p.2 | ${quote}] [Supplement.pdf p.2 | ${supplementQuote}]`,
    'Legacy answer has only a page citation. [Main paper.pdf p.3]',
    'Unmatched answer has an incorrect source excerpt. [Main paper.pdf p.2 | This sentence does not exist anywhere on the cited page.]',
    `Hidden document finding: additional validation. [Validation.pdf p.2 | ${hiddenQuote}]`,
    'Unknown source is not a navigation link. [Missing.pdf p.2 | Unverifiable text.]',
  ];
  const now = Date.now();
  const fixture = { version: 1, id: workspaceId, title: 'Source navigation fixture', authors: '', journal: '', doi: '', tags: [], favorite: false,
    createdAt: now, updatedAt: now, lastReadAt: now, documents, notes: '', memories: [], memoryIndex: '',
    conversations: [{ id: 'conversation', title: 'Source checks', createdAt: now, messages: contents.flatMap((content, i) => [
      { id: `user-${i}`, role: 'user', content: `Explain fixture ${i}.`, createdAt: now + i * 2, turnId: `turn-${i}` },
      { id: `assistant-${i}`, role: 'assistant', content, createdAt: now + i * 2 + 1, turnId: `turn-${i}` },
    ]) }], activeConversationId: 'conversation',
    layout: { split: true, direction: 'vertical', leftId: 'main', rightId: 'supplement', ratio: 50 },
  };
  await writeFile(path.join(directory, 'workspace.json'), JSON.stringify(fixture));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {} }));
}
async function launch() {
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  page = await app.firstWindow(); page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1720, 1040);
    globalThis.__forbiddenSourceCalls = [];
    const update = ipcMain._invokeHandlers.get('folio:update-workspace');
    ipcMain.removeHandler('folio:update-workspace');
    ipcMain.handle('folio:update-workspace', async (event, id, patch) => {
      const result = await update(event, id, patch);
      if (globalThis.__delaySourceSwitch && patch.layout?.leftId === 'hidden') {
        globalThis.__sourceSwitchPending = true;
        await new Promise(resolve => setTimeout(resolve, 1000));
        globalThis.__sourceSwitchPending = false;
      }
      return result;
    });
    for (const name of ['start-chat', 'voice-capabilities', 'voice-listen', 'voice-speak']) {
      ipcMain.removeHandler('folio:' + name);
      ipcMain.handle('folio:' + name, () => { globalThis.__forbiddenSourceCalls.push(name); throw new Error('Unexpected AI/speech call: ' + name); });
    }
  });
  await page.getByRole('button', { name: /^(打开|Open) Source navigation fixture$/ }).click();
  await pane(1).locator('.textLayer span').first().waitFor({ state: 'attached' });
  const toggle = page.getByRole('button', { name: /^(阅读伙伴|Reading companion)$/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const dock = page.getByRole('button', { name: /^(固定阅读伙伴|Pin reading companion)$/ });
  if (await dock.isVisible()) await dock.click();
  await answer('Main finding:').waitFor({ state: 'attached' });
}
async function openSettings() {
  await page.getByRole('button', { name: /^(设置与连接|Settings)$/ }).click();
  await page.locator('.fl-settings-nav').getByRole('button', { name: /^(阅读偏好|Reading)$/ }).click();
}
const closeSettings = () => page.getByRole('button', { name: /^(关闭设置|Close settings)$/ }).click();
async function measure() {
  return page.evaluate(() => ({
    ui: parseFloat(getComputedStyle(document.querySelector('.fl-message.assistant .fl-markdown')).fontSize),
    pdf: Array.from(document.querySelectorAll('.pdf-pane')).map(p => {
      const sheet = p.querySelector('.page'), span = sheet.querySelector('.textLayer span'), canvas = sheet.querySelector('canvas');
      return { width: sheet.offsetWidth, height: sheet.offsetHeight, font: getComputedStyle(span).fontSize, canvas: [canvas.width, canvas.height] };
    }),
  }));
}
async function assertOverlayGeometry(side, sourceQuote) {
  const inspectGeometry = () => pane(side).evaluate((element, words) => {
    const sheet = element.querySelector('.page[data-page-number="2"]');
    if (!sheet) return { aligned: false };
    const marks = [...sheet.querySelectorAll('.folio-source-mark')].map(mark => mark.getBoundingClientRect().toJSON());
    const spans = [...sheet.querySelectorAll('.textLayer span[role="presentation"]')].filter(span => {
      const text = span.textContent.trim(); return text && words.includes(text);
    }).map(span => { const range = document.createRange(); range.selectNodeContents(span); return range.getBoundingClientRect().toJSON(); });
    return { marks, spans, text: sheet.querySelector('.textLayer')?.textContent,
      aligned: spans.length === 2 && marks.length === spans.length && spans.every(rect => marks.some(mark =>
        ['left', 'top', 'width', 'height'].every(key => Math.abs(mark[key] - rect[key]) < 3))) };
  }, sourceQuote);
  try { await waitFor(async () => (await inspectGeometry()).aligned, 'source overlay aligns to original text after PDF transforms'); }
  catch (error) { measurements.failedOverlay = await inspectGeometry(); throw error; }
}

try {
  await seed(); await launch();
  measurements.original = await measure();
  await openSettings();
  const size = () => page.getByRole('group', { name: /^(软件文字大小|App text size)$/ }).getByRole('button', { name: '150%', exact: true });
  await size().click();
  await closeSettings();
  assert.equal((await state()).settings.uiFontScale, 1);
  assert.deepEqual(await measure(), measurements.original);
  pass('Changing the draft and closing Settings does not alter saved UI or PDF sizes');
  await openSettings(); await size().click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await waitFor(async () => (await state()).settings.uiFontScale === 1.5, 'font size saved');
  await closeSettings();
  measurements.large = await measure();
  assert.ok(Math.abs(measurements.large.ui / measurements.original.ui - 1.5) < 0.01);
  assert.deepEqual(measurements.large.pdf, measurements.original.pdf);
  pass('150% UI text enlarges the assistant while PDF canvas, text-layer fonts and both zooms remain unchanged');

  // Agent implementations expose source-link and highlight selectors; keep
  // actions through visible answers rather than calling navigation internals.
  await answer('Main finding:').locator('p').first().click({ position: { x: 15, y: 8 } });
  await pane(0).locator('.folio-source-mark').first().waitFor();
  await assertOverlayGeometry(0, quote);
  assert.equal(await pane(0).getByRole('textbox', { name: '当前页码', exact: true }).inputValue(), '2');
  assert.equal(await pane(1).getByRole('textbox', { name: '当前页码', exact: true }).inputValue(), '1');
  pass('Clicking an answer jumps to its source page and highlights its exact multi-line excerpt in the correct pane');
  await answer('Supplement finding:').locator('p').first().click({ position: { x: 15, y: 8 } });
  await pane(1).locator('.folio-source-mark').first().waitFor();
  await assertOverlayGeometry(1, supplementQuote);
  await pane(0).locator('.folio-source-mark').waitFor({ state: 'detached' });
  pass('Supplement citations activate the other PDF pane and clear the previous transient source highlight');

  await pane(1).getByRole('combobox', { name: '缩放比例', exact: true }).selectOption('1.25');
  await assertOverlayGeometry(1, supplementQuote);
  await pane(1).getByRole('button', { name: '阅读模式与导出', exact: true }).click();
  await pane(1).getByRole('button', { name: '顺时针旋转 90°', exact: true }).click();
  await pane(1).getByRole('button', { name: '关闭阅读设置', exact: true }).click();
  await waitFor(async () => (await workspace()).layout.views?.right?.state.rotation === 90, 'rotation saved');
  await pane(1).locator('.folio-source-mark').first().waitFor();
  await assertOverlayGeometry(1, supplementQuote);
  pass('Source overlays remain attached through independent PDF zoom and rotation');

  await answer('Both sources').locator('p').first().click({ position: { x: 15, y: 8 } });
  const choices = answer('Both sources').getByRole('group', { name: '选择原文引用', exact: true });
  await choices.waitFor();
  assert.equal(await choices.getByRole('button').count(), 3);
  await choices.getByRole('button', { name: 'Main paper.pdf · p.2', exact: true }).click();
  await assertOverlayGeometry(0, quote);
  await choices.waitFor({ state: 'detached' });
  pass('Answers citing several PDFs offer an explicit source choice');
  await pane(0).getByRole('button', { name: '清除原文定位', exact: true }).click();
  const mainLink = answer('Main finding:').getByRole('button', { name: '查看原文：Main paper.pdf，第 2 页', exact: true });
  await mainLink.focus(); await page.keyboard.press('Enter');
  await assertOverlayGeometry(0, quote);
  await page.keyboard.press('Escape');
  await pane(0).locator('.folio-source-mark').waitFor({ state: 'detached' });
  pass('Source controls support keyboard activation and Escape dismisses transient highlights');

  // Real selection in an answer must remain copyable and must not navigate.
  await answer('Main finding:').scrollIntoViewIfNeeded();
  const selectBounds = await answer('Main finding:').locator('p').first().evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 12);
    const box = range.getBoundingClientRect(); return { x: box.x + 1, y: box.y + box.height / 2, endX: box.right - 1 };
  });
  await page.mouse.move(selectBounds.x, selectBounds.y); await page.mouse.down();
  await page.mouse.move(selectBounds.endX, selectBounds.y, { steps: 10 }); await page.mouse.up();
  assert.match(await page.evaluate(() => getSelection().toString()), /Main finding/);
  assert.equal(await page.locator('.folio-source-mark').count(), 0);
  await page.evaluate(() => getSelection().removeAllRanges());
  pass('Selecting answer text preserves native selection without triggering source navigation');

  await answer('Legacy answer').locator('p').first().click({ position: { x: 15, y: 8 } });
  await waitFor(async () => await pane(0).getByRole('textbox', { name: '当前页码', exact: true }).inputValue() === '3', 'legacy page citation');
  assert.equal(await page.locator('.folio-source-mark').count(), 0);
  pass('Legacy citations navigate to the cited page without inventing a text highlight');
  await answer('Unmatched answer').locator('p').first().click({ position: { x: 15, y: 8 } });
  await waitFor(async () => await pane(0).getByRole('textbox', { name: '当前页码', exact: true }).inputValue() === '2', 'unmatched quote page');
  await pane(0).getByRole('status').filter({ hasText: /未找到|could not|couldn.t|not found/i }).waitFor();
  assert.equal(await page.locator('.folio-source-mark').count(), 0);
  pass('Unmatched source excerpts show an honest fallback and never create annotation data');
  await app.evaluate(() => { globalThis.__delaySourceSwitch = true; });
  await answer('Hidden document finding:').locator('p').first().click({ position: { x: 15, y: 8 } });
  await waitFor(() => app.evaluate(() => globalThis.__sourceSwitchPending), 'delayed source document response');
  await mainLink.click();
  await waitFor(async () => !await app.evaluate(() => globalThis.__sourceSwitchPending) && (await workspace()).layout.leftId === 'main', 'latest source wins pending document switch');
  await assertOverlayGeometry(0, quote);
  await app.evaluate(() => { globalThis.__delaySourceSwitch = false; });
  pass('Rapid clicks preserve the latest source even when an earlier document switch completes late');
  await answer('Hidden document finding:').locator('p').first().click({ position: { x: 15, y: 8 } });
  await waitFor(async () => (await workspace()).layout.leftId === 'hidden', 'closed source PDF opens');
  await pane(0).locator('.folio-source-mark').first().waitFor();
  await assertOverlayGeometry(0, hiddenQuote);
  assert.equal((await workspace()).layout.rightId, 'supplement');
  pass('Citations to an unopened PDF switch only the target pane and highlight after lazy loading');

  assert((await workspace()).documents.every(document => document.annotations.length === 0));
  assert.equal(await answer('Unknown source').locator('.fl-source-citation, .fl-source-block').count(), 0);
  assert.deepEqual(await app.evaluate(() => globalThis.__forbiddenSourceCalls), []);
  await page.screenshot({ path: path.join(output, 'large-ui-source-highlight.png') });
  await openSettings();
  await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await waitFor(async () => (await state()).settings.language === 'en', 'English settings saved');
  await closeSettings();
  await app.close(); app = undefined;
  await launch();
  assert.equal((await state()).settings.uiFontScale, 1.5);
  await openSettings();
  assert.equal(await size().getAttribute('aria-pressed'), 'true');
  pass('Font preference survives relaunch and is available in English settings');
  await closeSettings();
  await app.evaluate(({ app }) => app.getAppMetrics());
  await delay(3000);
  measurements.idleProcesses = await app.evaluate(({ app }) => app.getAppMetrics().map(item => ({ type: item.type, cpu: item.cpu.percentCPUUsage, memoryKB: item.memory.workingSetSize })));
  assert.deepEqual(errors, []);
  pass('No renderer exceptions, provider requests, microphone calls or persistent PDF annotations');
} catch (error) {
  errors.push(error.stack || String(error));
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, measurements }, null, 2));
  if (app) await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
