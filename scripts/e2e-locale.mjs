import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Isolated UI checks. No real API key, GitHub download, or installer is used.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/locale');
await mkdir(output, { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), 'folio-locale-e2e-'));
const env = { ...process.env, FOLIO_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
let app, page;
const checks = [], errors = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const state = () => page.evaluate(() => window.folio.bootstrap());
const waitFor = async (fn, description) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error('Timed out: ' + description);
};
async function launch() {
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000));
}
async function settings() {
  await page.getByRole('button', { name: /^(设置与连接|Settings)/ }).first().click();
  await page.getByRole('combobox', { name: '语言 / Language', exact: true }).waitFor();
}
async function setLanguage(language) {
  await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(language);
  await page.getByRole('button', { name: /^(保存设置|Save settings)$/, exact: true }).click();
  await waitFor(async () => (await state()).settings.language === language && await page.locator('html').getAttribute('lang') === language, 'language changes without restart');
}
async function closeSettings() {
  await page.locator('.fl-settings-footer').getByRole('button', { name: /^(关闭|Close)$/, exact: true }).click();
}
async function menus() {
  return app.evaluate(({ Menu }) => {
    const flatten = menu => menu.items.flatMap(item => [item.label, ...(item.submenu ? flatten(item.submenu) : [])]);
    return flatten(Menu.getApplicationMenu());
  });
}

try {
  await launch();
  await page.getByRole('button', { name: '体验示例工作区', exact: true }).click();
  await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor();
  await waitFor(async () => (await state()).workspaces[0]?.documents.every(doc => doc.textStatus === 'ready'), 'demo PDFs indexed');
  const workspaceId = (await state()).workspaces[0].id;
  const left = page.locator('.pdf-pane').nth(0), right = page.locator('.pdf-pane').nth(1);
  await left.getByRole('textbox', { name: '当前页码', exact: true }).fill('2');
  await left.getByRole('textbox', { name: '当前页码', exact: true }).press('Enter');
  await waitFor(async () => (await state()).workspaces[0].layout.views?.left?.state.page === 2, 'non-default reading page saved');
  await left.getByRole('combobox', { name: '缩放比例', exact: true }).selectOption('1');
  await right.getByRole('combobox', { name: '缩放比例', exact: true }).selectOption('0.75');
  await waitFor(async () => {
    const views = (await state()).workspaces[0].layout.views;
    return views?.left?.state.scale === '1' && views?.right?.state.scale === '0.75';
  }, 'independent zoom saved');
  await page.getByRole('button', { name: '阅读伙伴', exact: true }).click();
  const draft = 'Keep this draft · 保留我的问题';
  await page.getByRole('textbox', { name: '向 AI 提问', exact: true }).fill(draft);
  await page.getByRole('tab', { name: '笔记', exact: true }).click();
  const note = 'Original reading note · 原始中文笔记';
  await page.getByRole('textbox', { name: '个人阅读笔记', exact: true }).fill(note);
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await waitFor(async () => (await state()).workspaces[0].notes === note, 'notes saved');
  const before = (await state()).workspaces[0];
  await page.evaluate(() => { window.__folioLocaleViewers = [...document.querySelectorAll('.pdf-viewer-container')]; });

  await settings();
  await setLanguage('en');
  assert.ok(await page.getByRole('button', { name: 'Save settings', exact: true }).isVisible());
  const englishMenu = await menus();
  for (const label of ['File', 'Edit', 'Copy', 'Check for updates…']) assert.ok(englishMenu.some(item => item.toLowerCase() === label.toLowerCase()), 'English native menu: ' + label);
  await closeSettings();
  assert.ok(await page.getByRole('button', { name: 'Reading companion', exact: true }).isVisible());
  assert.equal(await left.getByRole('textbox', { name: 'Current page', exact: true }).inputValue(), '2');
  assert.equal(await left.getByRole('combobox', { name: 'Zoom level', exact: true }).inputValue(), '1');
  assert.equal(await right.getByRole('combobox', { name: 'Zoom level', exact: true }).inputValue(), '0.75');
  assert.equal(await page.getByRole('textbox', { name: 'Ask AI', exact: true }).inputValue(), draft);
  assert.ok(await page.evaluate(() => window.__folioLocaleViewers.every((node, index) => node === document.querySelectorAll('.pdf-viewer-container')[index])), 'Language change must retain both PDF viewers');
  const after = (await state()).workspaces.find(ws => ws.id === workspaceId);
  assert.equal(after.notes, note);
  assert.deepEqual(after.documents.map(d => d.annotations), before.documents.map(d => d.annotations));
  pass('Chinese → English updates native and PDF UI without reopening PDFs or losing zoom, pages, notes, or chat draft');

  // Context-menu strings are translated without replacing the PDF text layer.
  await left.locator('.pdf-viewer-container').click({ button: 'right', position: { x: 5, y: 5 } });
  await page.getByRole('menu', { name: 'PDF actions', exact: true }).waitFor();
  assert.ok(await page.getByRole('menuitem', { name: 'Add comment', exact: true }).isVisible());
  assert.ok(await page.getByRole('menuitem', { name: 'Strikethrough', exact: true }).isVisible());
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(output, 'reader-english.png') });
  pass('English PDF context menu includes comments and text markup');

  await settings();
  await setLanguage('zh-CN');
  assert.ok((await menus()).includes('文件'));
  await closeSettings();
  assert.equal(await page.getByRole('textbox', { name: '向 AI 提问', exact: true }).inputValue(), draft);
  assert.equal(await left.getByRole('textbox', { name: '当前页码', exact: true }).inputValue(), '2');
  pass('Switching back restores Chinese UI and keeps the same reading session');

  await settings();
  await setLanguage('en');
  await closeSettings();
  await app.close(); app = undefined;
  const persisted = JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8'));
  assert.equal(persisted.language, 'en');
  assert.ok(Object.values(persisted.providers).every(provider => !provider.apiKey && !provider.encryptedKey));
  await launch();
  await page.getByRole('heading', { name: /^My Library/ }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal((await state()).workspaces.find(ws => ws.id === workspaceId).notes, note);
  pass('English preference survives restart; personal notes remain unchanged and no credentials are written');

  // Exercise the updater UI with test IPC handlers only. No network or installer.
  await app.evaluate(({ ipcMain, BrowserWindow, app }) => {
    const release = { version: '9.9.9', url: 'https://github.com/AuroraSxh/Folio-pdfreader/releases/tag/v9.9.9', notes: 'Test release', publishedAt: '2026-09-22T00:00:00Z', assetName: 'Folio-9.9.9-mac-universal.dmg', size: 100, downloadable: true };
    const send = status => BrowserWindow.getAllWindows()[0].webContents.send('folio:update', status);
    let current = { phase: 'idle', currentVersion: app.getVersion() };
    for (const channel of ['update-status', 'check-updates', 'download-update', 'install-update']) ipcMain.removeHandler('folio:' + channel);
    ipcMain.handle('folio:update-status', () => current);
    ipcMain.handle('folio:check-updates', () => { current = { phase: 'available', currentVersion: app.getVersion(), release }; send(current); return current; });
    ipcMain.handle('folio:download-update', () => { current = { ...current, phase: 'downloaded', downloadedBytes: 100, totalBytes: 100 }; send(current); return current; });
    ipcMain.handle('folio:install-update', () => { global.__folioTestInstallCalls = (global.__folioTestInstallCalls || 0) + 1; });
  });
  await settings();
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByRole('button', { name: /Check for updates/i }).last().click();
  await page.getByText('9.9.9', { exact: false }).first().waitFor();
  await page.screenshot({ path: path.join(output, 'update-english.png') });
  assert.equal(await app.evaluate(() => global.__folioTestInstallCalls || 0), 0);
  pass('Manual update check shows a release in settings without running an installer');
  const updates = page.getByRole('region', { name: 'App updates', exact: true });
  await updates.getByRole('button', { name: 'Download installer', exact: true }).click();
  await updates.getByText('Installer downloaded and verified', { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => global.__folioTestInstallCalls || 0), 0);
  await updates.getByRole('button', { name: /^(Open DMG|Open installer)$/, exact: true }).click();
  await waitFor(async () => await app.evaluate(() => global.__folioTestInstallCalls || 0) === 1, 'explicit installer action reaches IPC');
  await updates.getByRole('checkbox', { name: 'Automatically check for updates', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await waitFor(async () => (await state()).settings.autoCheckUpdates === false, 'automatic check preference saved');
  pass('Update UI waits for an explicit install click and persists the automatic-check preference');

  await closeSettings();
  await page.screenshot({ path: path.join(output, 'library-english.png') });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'e2e-locale-report.json'), JSON.stringify({ passed: true, checks, errors, version: (await state()).version }, null, 2));
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(output, 'e2e-locale-failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'e2e-locale-report.json'), JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  await rm(userData, { recursive: true, force: true });
}
