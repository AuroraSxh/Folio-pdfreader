import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Run only when the desktop is available. Both paths must be packaged app
// executables (not a DMG/setup EXE). This never opens the real user profile.
// Example: FOLIO_OLD_EXECUTABLE="…/Folio.app/Contents/MacOS/Folio" \
//          FOLIO_EXECUTABLE="…/Pairleaf.app/Contents/MacOS/Pairleaf" \
//          FOLIO_E2E_OUTPUT="test-results/v0.5.0/upgrade" node scripts/e2e-upgrade.mjs
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/upgrade');
const checks = [], errors = [], networkAttempts = [], launches = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let userData, app, page, phase = 'setup', before, originals = [];
await mkdir(output, { recursive: true });

async function executable(variable) {
  const value = process.env[variable];
  assert.ok(value, `${variable} must name a packaged application executable`);
  const filename = await realpath(path.resolve(value));
  assert.ok((await stat(filename)).isFile(), `${variable} must name a file`);
  return filename;
}
async function waitFor(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(80); }
  throw new Error('Timed out: ' + description);
}
const state = () => page.evaluate(() => window.folio.bootstrap());
function assertNoKeys(settings) {
  assert.ok(Object.values(settings.providers).every(provider => !provider.apiKey && !provider.encryptedKey && !provider.hasKey), 'This fixture must never contain credentials');
}
async function launch(filename, expectedVersion, label) {
  phase = label;
  const env = { ...process.env, FOLIO_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  app = await electron.launch({ executablePath: filename, args: ['--disable-background-networking'], env, timeout: 30000 });
  // No test action calls a provider/update service. Fail closed if the renderer
  // unexpectedly tries to access HTTP(S); normal PDF assets are local files.
  await app.context().route(/^https?:\/\//, route => {
    networkAttempts.push({ phase: label, origin: new URL(route.request().url()).origin });
    return route.abort();
  });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push({ phase: label, message: error.message }));
  await page.waitForFunction(() => Boolean(window.folio));
  const identity = await app.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData') }));
  assert.equal(identity.packaged, true, 'Upgrade checks require real packaged apps');
  assert.equal(identity.version, expectedVersion, 'Unexpected build supplied to upgrade test');
  assert.equal(await realpath(identity.userData), await realpath(userData), 'The app must use the isolated shared profile');
  const bootstrap = await state();
  assert.equal(bootstrap.settings.libraryPath, path.join(userData, 'Library'));
  assert.equal(bootstrap.settings.autoCheckUpdates, false);
  assertNoKeys(bootstrap.settings);
  assert.equal((await page.evaluate(() => window.folio.getUpdateStatus())).phase, 'idle', 'Launching the isolated profile must not check GitHub');
  launches.push({ label, executable: path.basename(filename), ...identity });
  return bootstrap;
}
async function close() {
  if (!app) return;
  const current = app;
  await current.close();
  app = undefined; page = undefined;
}
async function originalFiles(workspace) {
  return Promise.all(workspace.documents.map(async document => {
    assert.equal(path.basename(document.fileName), document.fileName);
    const filename = path.join(userData, 'Library', workspace.id, document.fileName);
    const bytes = await readFile(filename);
    return { documentId: document.id, fileName: document.fileName, bytes: bytes.length, sha256: digest(bytes) };
  }));
}
async function report(passed, error) {
  await writeFile(path.join(output, 'e2e-upgrade-report.json'), JSON.stringify({
    passed, phase, checks, errors, networkAttempts, launches, originals,
    workspaceId: before?.id, error: error ? String(error) : undefined,
    coverage: 'Real packaged Folio 0.4.1 creates and saves data through its preload/IPC; packaged Pairleaf 0.5.0 reads the same isolated profile and renders both PDFs.',
    limits: 'No real user library, API credentials, keychain, microphone, TTS, installer execution, or OS-level install/uninstall migration is tested. This does not test old/new concurrent processes.',
  }, null, 2));
}

try {
  const oldExecutable = await executable('FOLIO_OLD_EXECUTABLE'), newExecutable = await executable('FOLIO_EXECUTABLE');
  assert.notEqual(oldExecutable, newExecutable, 'Old and new binaries must be different files');
  userData = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-upgrade-e2e-'));
  // Only bootstrap isolation is seeded. Every paper, note, mark, setting, and
  // saved reading position below is created by the unmodified old application.
  await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, providers: {} }));
  const empty = await launch(oldExecutable, '0.4.1', 'old Folio');
  assert.equal(empty.workspaces.length, 0);
  assert.equal(empty.removedWorkspaces.length, 0);
  const demo = await page.evaluate(() => window.folio.createDemo());
  assert.equal(demo.documents.length, 2);
  // Reload refreshes the normal renderer after the real createDemo IPC call.
  await page.reload();
  await page.getByRole('button', { name: `打开 ${demo.title}`, exact: true }).click();
  await page.locator('.pdf-pane').nth(1).locator('.textLayer span').first().waitFor();
  await waitFor(async () => (await state()).workspaces.find(item => item.id === demo.id)?.documents.every(document => document.textStatus === 'ready' && document.pageCount >= 2), 'old app indexes both actual demo PDFs');
  // Unmount readers before writing exact progress through IPC, so a pending
  // viewer save cannot overwrite the requested fixture state on quit.
  await page.locator('.rail-brand, button.brand').first().click();
  await waitFor(async () => await page.locator('.pdf-pane').count() === 0, 'old PDF readers unmount before writing saved progress');
  const title = 'Upgrade fixture · 保留论文标题';
  const notes = '## Personal reading notes / 个人笔记\n\nKeep this exact text across the Folio → Pairleaf upgrade.\n保留我的笔记、引文、标记与两个 PDF 的独立阅读进度。\n';
  const leftView = { page: 2, scale: '0.75', rotation: 0, scrollMode: 0, spreadMode: 0 };
  const rightView = { page: 2, scale: '1', rotation: 0, scrollMode: 0, spreadMode: 0 };
  before = await page.evaluate(async ({ id, title, notes, leftView, rightView }) => {
    const api = window.folio;
    let workspace = (await api.bootstrap()).workspaces.find(item => item.id === id);
    workspace = await api.updateWorkspace(id, { title, notes, favorite: true, tags: ['升级回归', 'Preserve user content'], layout: { ...workspace.layout, split: true, direction: 'vertical', ratio: 50 } });
    const left = workspace.documents.find(document => document.id === workspace.layout.leftId);
    const right = workspace.documents.find(document => document.id === workspace.layout.rightId);
    await api.updateDocument(id, left.id, { annotations: [...left.annotations, { id: 'upgrade-fixture-comment', page: 2, text: 'Research question', comment: 'Keep this personal comment · 保留批注', color: '#f8de71', kind: 'underline', rects: [[58, 700, 165, 714]], createdAt: 1790000000000 }] });
    await api.updateView(id, left.id, 'left', leftView);
    await api.updateView(id, right.id, 'right', rightView);
    const settings = (await api.bootstrap()).settings;
    await api.saveSettings({ ...settings, language: 'en', autoCheckUpdates: false, autoSummary: false, annotationToolbar: 'fixed' });
    return (await api.bootstrap()).workspaces.find(item => item.id === id);
  }, { id: demo.id, title, notes, leftView, rightView });
  assert.equal(before.notes, notes);
  assert.deepEqual(before.layout.views.left.state, leftView);
  assert.deepEqual(before.layout.views.right.state, rightView);
  originals = await originalFiles(before);
  await close();
  const workspaceFile = path.join(userData, 'Library', before.id, 'workspace.json');
  const oldWorkspaceBytes = await readFile(workspaceFile), oldSettingsBytes = await readFile(path.join(userData, 'settings.json'));
  assert.deepEqual(JSON.parse(oldWorkspaceBytes.toString()), before, 'Old app must finish real disk writes before upgrade');
  assert.equal(JSON.parse(oldSettingsBytes.toString()).language, 'en');
  assertNoKeys(JSON.parse(oldSettingsBytes.toString()));
  pass('Packaged Folio 0.4.1 saves real PDFs, notes, comment, settings and independent pane progress in an isolated profile');

  const upgraded = await launch(newExecutable, '0.5.0', 'new Pairleaf');
  assert.equal(upgraded.workspaces.length, 1);
  assert.equal(upgraded.removedWorkspaces.length, 0);
  assert.deepEqual(upgraded.workspaces[0], before, 'No workspace field may change merely by loading the new version');
  assert.equal(upgraded.settings.language, 'en');
  assert.equal(upgraded.settings.annotationToolbar, 'fixed');
  assert.equal(upgraded.settings.autoSummary, false);
  assert.deepEqual(await readFile(workspaceFile), oldWorkspaceBytes);
  assert.deepEqual(await readFile(path.join(userData, 'settings.json')), oldSettingsBytes);
  assert.deepEqual(await originalFiles(before), originals, 'Both original PDF files must remain byte-for-byte identical');
  pass('Pairleaf reads the exact old workspace, settings and original PDF bytes without a rewrite or duplicate library');

  await waitFor(async () => await page.locator('html').getAttribute('lang') === 'en', 'saved English preference reaches the new renderer');
  assert.match(await page.title(), /Pairleaf/);
  assert.match(await page.locator('.titlebar-label').innerText(), /Pairleaf/);
  await page.getByRole('button', { name: `Open ${title}`, exact: true }).click();
  for (const [side, expected] of [[0, leftView], [1, rightView]]) {
    const pane = page.locator('.pdf-pane').nth(side);
    await pane.locator('.textLayer span').first().waitFor();
    await waitFor(async () => await pane.getByRole('textbox', { name: 'Current page', exact: true }).inputValue() === String(expected.page)
      && await pane.getByRole('combobox', { name: 'Zoom level', exact: true }).inputValue() === expected.scale, 'restored page and zoom in pane ' + side);
  }
  const afterReading = (await state()).workspaces.find(item => item.id === before.id);
  assert.equal(afterReading.notes, notes);
  assert.deepEqual(afterReading.documents.map(document => document.annotations), before.documents.map(document => document.annotations));
  assert.deepEqual(afterReading.layout.views.left.state, leftView);
  assert.deepEqual(afterReading.layout.views.right.state, rightView);
  assert.deepEqual(await originalFiles(afterReading), originals);
  pass('New branding and English UI render both old PDFs at their independent saved pages/zoom while preserving notes and comments');
  await close();
  assert.deepEqual(errors, []);
  assert.deepEqual(networkAttempts, []);
  assertNoKeys(JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8')));
  pass('Both test apps exit; no renderer network attempt, page error or saved credential was observed');
  await report(true);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(output, 'e2e-upgrade-failure.png') }).catch(() => {});
  await report(false, error);
  process.exitCode = 1;
} finally {
  try { await close(); }
  catch (error) { console.error('Test application close failed:', error); process.exitCode = 1; }
  // Never delete a profile still in use by an app whose close failed.
  if (userData && !app) await rm(userData, { recursive: true, force: true });
}
