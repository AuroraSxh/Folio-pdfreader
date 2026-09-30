import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Real import IPC, PDF.js extraction, UI confirmation, and disk persistence.
// Only the native file chooser and the timing of PDF reads are controlled.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/import-title');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-import-e2e-'));
const fixtureDirectory = path.join(profile, 'fixtures');
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const checks = [], errors = [], diagnostics = [];
let app, page;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const state = () => page.evaluate(() => window.folio.bootstrap());
const getWorkspace = async id => (await state()).workspaces.find(item => item.id === id);
const dialog = () => page.getByRole('dialog', { name: /^(确认文章名称|Confirm paper title)$/ });
const titleInput = () => dialog().getByRole('textbox', { name: /^(文章名称|Paper title)$/ });
const confirmButton = () => dialog().getByRole('button', { name: /^(确认名称|Confirm title)$/ });
const deferButton = () => dialog().locator('footer').getByRole('button', { name: /^(稍后确认|Confirm later)$/ });

async function waitFor(predicate, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(60); }
  throw new Error('Timed out: ' + description);
}
async function pdfFixture(filename, metadata, headlines, scanned = false) {
  const pdf = await PDFDocument.create();
  if (metadata !== undefined) pdf.setTitle(metadata);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheet = pdf.addPage([620, 820]);
  if (scanned) sheet.drawRectangle({ x: 48, y: 620, width: 360, height: 40, color: rgb(.7, .7, .7) });
  else {
    sheet.drawText('Nature', { x: 48, y: 780, font, size: 32 });
    sheet.drawText('RESEARCH ARTICLE', { x: 48, y: 741, font, size: 13 });
    headlines.forEach((text, index) => sheet.drawText(text, { x: 48, y: 680 - index * 27, font, size: 21 }));
    sheet.drawText('Jane Smith, Alice Brown', { x: 48, y: 596, font, size: 11 });
    sheet.drawText('Abstract', { x: 48, y: 530, font, size: 11 });
    for (let row = 0; row < 12; row++) sheet.drawText(`Local synthetic fixture paragraph ${row + 1} describes immune cells and their activity.`, { x: 48, y: 505 - row * 15, font, size: 10 });
  }
  const filenamePath = path.join(fixtureDirectory, filename);
  await writeFile(filenamePath, await pdf.save());
  return filenamePath;
}
async function launch() {
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, dialog, ipcMain }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1580, 1020);
    if (process.env.FOLIO_E2E_HIDE_WINDOW === '1') {
      // Optional for running CDP checks without intercepting the user's keyboard.
      window.setFocusable(false);
      window.hide();
    }
    globalThis.__importTestPaths = [];
    globalThis.__importForbiddenCalls = [];
    globalThis.__importReadWaiters = [];
    globalThis.__importHoldReads = false;
    globalThis.__importSavedTitles = [];
    const update = ipcMain._invokeHandlers.get('folio:update-workspace');
    ipcMain.removeHandler('folio:update-workspace');
    ipcMain.handle('folio:update-workspace', async (event, id, patch) => {
      if (typeof patch.title === 'string') globalThis.__importSavedTitles.push({ id, title: patch.title });
      return update(event, id, patch);
    });
    dialog.showOpenDialog = async () => {
      const filePaths = globalThis.__importTestPaths;
      globalThis.__importTestPaths = [];
      return { canceled: !filePaths.length, filePaths };
    };
    const read = ipcMain._invokeHandlers.get('folio:read-document');
    ipcMain.removeHandler('folio:read-document');
    ipcMain.handle('folio:read-document', async (...args) => {
      if (globalThis.__importHoldReads) await new Promise(resolve => globalThis.__importReadWaiters.push(resolve));
      return read(...args);
    });
    for (const name of ['start-chat', 'voice-capabilities', 'voice-listen', 'voice-speak']) {
      ipcMain.removeHandler('folio:' + name);
      ipcMain.handle('folio:' + name, () => { globalThis.__importForbiddenCalls.push(name); throw new Error('Unexpected AI/speech call during import: ' + name); });
    }
  });
  await page.locator('.fl-library').waitFor();
}
async function choose(paths) { await app.evaluate((_electron, values) => { globalThis.__importTestPaths = values; }, paths); }
async function importPaper(paths) {
  if (await page.locator('.back-button').isVisible()) await page.locator('.back-button').click();
  const before = new Set((await state()).workspaces.map(item => item.id));
  await choose(paths);
  await page.locator('.fl-library-intro').getByRole('button', { name: /导入论文|Import paper/ }).click();
  await dialog().waitFor();
  let result;
  await waitFor(async () => { result = (await state()).workspaces.find(item => !before.has(item.id)); return !!result; }, 'imported workspace persisted');
  return result;
}
async function settledTitle(expected) {
  await waitFor(async () => await titleInput().inputValue() === expected && !await dialog().locator('.import-title-spin').count(), 'title identification: ' + expected);
}
async function confirmTitle(id, title) {
  await confirmButton().click();
  await dialog().waitFor({ state: 'detached' });
  await waitFor(async () => { const value = await getWorkspace(id); return value?.title === title && value.titleStatus === 'confirmed'; }, 'explicit title confirmation saved');
}
async function reopen(title) {
  if (await page.locator('.back-button').isVisible()) await page.locator('.back-button').click();
  await page.locator('.fl-card-open').filter({ hasText: title }).click();
}
async function releaseReads() {
  await app.evaluate(() => {
    globalThis.__importHoldReads = false;
    for (const resolve of globalThis.__importReadWaiters.splice(0)) resolve();
  });
}

try {
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {} }));
  const metadataTitle = 'CD4 T cells coordinate local immune memory';
  const firstPageTitle = 'Cell surface proteins coordinate immune responses during aging';
  const metadataFile = await pdfFixture('metadata_fixture.pdf', metadataTitle, ['A deliberately different visual title']);
  const firstPageFile = await pdfFixture('s43587-026-01209-9.pdf', 'Microsoft Word - Document1', ['Cell surface proteins coordinate', 'immune responses during aging']);
  const delayedFile = await pdfFixture('delayed_fixture.pdf', 'A delayed automatic title from PDF metadata', ['A delayed first page title']);
  const supplementFile = await pdfFixture('supplement.pdf', 'A supplement must not rename the parent paper', ['Supplementary validation measurements']);
  const scannedFile = await pdfFixture('scan_fixture.pdf', undefined, [], true);
  await launch();

  const metadataWorkspace = await importPaper([metadataFile]);
  await settledTitle(metadataTitle);
  assert.equal((await getWorkspace(metadataWorkspace.id)).title, 'metadata_fixture');
  assert.equal((await getWorkspace(metadataWorkspace.id)).titleStatus, 'pending');
  await waitFor(async () => (await getWorkspace(metadataWorkspace.id)).documents[0].textStatus === 'ready', 'index completes before title confirmation');
  assert.equal((await getWorkspace(metadataWorkspace.id)).title, 'metadata_fixture');
  assert.equal((await getWorkspace(metadataWorkspace.id)).titleStatus, 'pending');
  pass('Real PDF import suggests a metadata title while indexing leaves the provisional name unconfirmed');

  await titleInput().focus();
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => !!document.activeElement?.closest('.import-title-dialog')));
  await confirmButton().focus();
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => !!document.activeElement?.closest('.import-title-dialog')));
  await page.screenshot({ path: path.join(output, 'metadata-title-confirmation.png') });
  await confirmTitle(metadataWorkspace.id, metadataTitle);
  pass('The title dialog traps keyboard focus and saves only after the visible confirmation button is pressed');

  await choose([supplementFile]);
  await page.locator('.workspace-topbar').getByRole('button', { name: /添加 PDF|Add PDF/ }).click();
  await waitFor(async () => (await getWorkspace(metadataWorkspace.id)).documents.length === 2, 'supplement imported');
  await waitFor(async () => (await getWorkspace(metadataWorkspace.id)).documents.every(item => item.textStatus === 'ready'), 'supplement indexed');
  assert.equal(await dialog().count(), 0);
  assert.equal((await getWorkspace(metadataWorkspace.id)).title, metadataTitle);
  pass('Adding and indexing a supplement does not prompt for another article name or rename the confirmed paper');

  const firstPageWorkspace = await importPaper([firstPageFile]);
  await settledTitle(firstPageTitle);
  assert.match(await dialog().locator('.import-title-status').textContent(), /首页/);
  await deferButton().click();
  await dialog().waitFor({ state: 'detached' });
  await waitFor(async () => (await getWorkspace(firstPageWorkspace.id)).documents[0].textStatus === 'ready', 'first-page fixture indexed');
  assert.equal((await getWorkspace(firstPageWorkspace.id)).title, 's43587-026-01209-9');
  assert.equal((await getWorkspace(firstPageWorkspace.id)).titleStatus, 'pending');
  await reopen('s43587-026-01209-9');
  await settledTitle(firstPageTitle);
  await page.screenshot({ path: path.join(output, 'first-page-title-confirmation.png') });
  await titleInput().fill('Reviewed title from the first page');
  await confirmTitle(firstPageWorkspace.id, 'Reviewed title from the first page');
  pass('Bad Word metadata falls back to a multiline first-page headline; deferring keeps it pending and reopening asks again');

  await app.evaluate(() => { globalThis.__importHoldReads = true; });
  const delayedWorkspace = await importPaper([delayedFile]);
  await waitFor(() => app.evaluate(() => globalThis.__importReadWaiters.length > 0), 'PDF reads held before title extraction');
  await titleInput().fill('My manually reviewed article title');
  await releaseReads();
  await waitFor(async () => !await dialog().locator('.import-title-spin').count(), 'delayed title extraction finishes');
  assert.equal(await titleInput().inputValue(), 'My manually reviewed article title');
  assert.equal((await getWorkspace(delayedWorkspace.id)).title, 'delayed_fixture');
  await confirmTitle(delayedWorkspace.id, 'My manually reviewed article title');
  await waitFor(async () => (await getWorkspace(delayedWorkspace.id)).documents[0].textStatus === 'ready', 'late PDF index finishes');
  assert.equal((await getWorkspace(delayedWorkspace.id)).title, 'My manually reviewed article title');
  pass('Typing before delayed PDF extraction finishes preserves the manual title, including after confirmation and background indexing');

  await page.getByRole('button', { name: /^(设置与连接|Settings)$/ }).click();
  await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
  await page.locator('.fl-settings-nav').getByRole('button', { name: '阅读偏好', exact: true }).click();
  await page.getByRole('group', { name: '软件文字大小', exact: true }).getByRole('button', { name: '150%', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await waitFor(async () => (await state()).settings.language === 'en', 'English settings saved');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const scannedWorkspace = await importPaper([scannedFile]);
  await settledTitle('scan fixture');
  assert.match(await dialog().locator('.import-title-status').textContent(), /No reliable title/);
  await titleInput().fill('A reviewed title for the scanned paper');
  await page.screenshot({ path: path.join(output, 'english-large-font-title-confirmation.png') });
  const fits = await dialog().evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; });
  assert.equal(fits, true);
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' });
  assert.equal((await getWorkspace(scannedWorkspace.id)).title, 'scan_fixture');
  assert.equal((await getWorkspace(scannedWorkspace.id)).titleStatus, 'pending');
  pass('Scanned PDFs offer an honest editable filename fallback in English at 150% UI text; Escape leaves the title unconfirmed');

  assert.deepEqual(await app.evaluate(() => globalThis.__importForbiddenCalls), []);
  await app.close(); app = undefined;
  await launch();
  assert.equal((await getWorkspace(metadataWorkspace.id)).title, metadataTitle);
  assert.equal((await getWorkspace(firstPageWorkspace.id)).title, 'Reviewed title from the first page');
  assert.equal((await getWorkspace(delayedWorkspace.id)).title, 'My manually reviewed article title');
  await reopen('My manually reviewed article title');
  await page.locator('.pdf-pane .textLayer span').first().waitFor({ state: 'attached' });
  assert.equal(await dialog().count(), 0);
  await reopen('scan_fixture');
  await settledTitle('scan fixture');
  await titleInput().fill('A reviewed title for the scanned paper');
  await confirmTitle(scannedWorkspace.id, 'A reviewed title for the scanned paper');
  pass('Confirmed article names persist after relaunch without prompting; deferred articles still require confirmation');

  assert.deepEqual(await app.evaluate(() => globalThis.__importForbiddenCalls), []);
  assert.deepEqual(errors, []);
  pass('Import title detection makes no AI or microphone calls and causes no renderer exceptions');
} catch (error) {
  errors.push(error.stack || String(error));
  diagnostics.push(await app?.evaluate(() => globalThis.__importSavedTitles).catch(() => undefined));
  diagnostics.push(await state().then(value => value.workspaces.map(item => ({ title: item.title, titleStatus: item.titleStatus }))).catch(() => undefined));
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, ...(diagnostics.length ? { diagnostics } : {}) }, null, 2));
  if (app) { await releaseReads().catch(() => {}); await app.close().catch(() => {}); }
  await rm(profile, { recursive: true, force: true });
}
