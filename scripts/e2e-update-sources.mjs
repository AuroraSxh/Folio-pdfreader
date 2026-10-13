import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Actual settings UI and settings.json persistence across app restarts.
// Updates, downloads, installers, and external links are mocked at Electron IPC.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/update-sources');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-update-sources-'));
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const checks = [], errors = [], runs = [];
const diagnostics = { stderr: [], startupLog: '' };
let app, page;
const releases = { github: 'https://github.com/AuroraSxh/Folio-pdfreader/releases', gitee: 'https://gitee.com/aurorasxh/pair-leaf/releases' };
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const settings = () => page.evaluate(() => window.folio.bootstrap()).then(value => value.settings);
const panel = () => page.getByRole('region', { name: /^(应用更新|App updates)$/ });
const source = () => panel().getByRole('combobox', { name: /^(更新来源|Update source)$/ });
const check = () => panel().getByRole('button', { name: /^(检查更新|Check for updates)$/ });
const download = () => panel().getByRole('button', { name: /^(下载安装包|Download installer)$/ });
const cancel = () => panel().getByRole('button', { name: /^(取消下载|Cancel download)$/ });
const details = () => panel().locator('.fl-update-source-details');
const pending = () => panel().locator('.fl-update-source-pending');
const mock = () => app.evaluate(() => {
  const value = globalThis.__updateSourcesUITest;
  return { current: value.current, checks: value.checks, downloads: value.downloads, cancellations: value.cancellations, installs: value.installs, external: value.external, nativeExternal: value.nativeExternal, network: value.network, forbidden: value.forbidden };
});
async function waitFor(predicate, label) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
}
async function openUpdates() {
  await page.getByRole('button', { name: /^(设置与连接|Settings)/ }).first().click();
  await page.getByRole('combobox', { name: '语言 / Language', exact: true }).waitFor();
  await page.locator('.fl-settings-nav').getByRole('button', { name: /^(应用更新|Updates)$/ }).click();
  await source().waitFor();
}
async function closeSettings() {
  await page.locator('.fl-settings-footer').getByRole('button', { name: /^(关闭|Close)$/ }).click();
  await page.locator('.fl-settings-modal').waitFor({ state: 'detached' });
}
async function saveSource(expected, language) {
  if (language) await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(language);
  await page.locator('.fl-settings-footer').getByRole('button', { name: /^(保存设置|Save settings)$/ }).click();
  await waitFor(async () => {
    const saved = await settings();
    return saved.updateSource === expected && (!language || saved.language === language) && !await pending().count();
  }, 'source preference is saved and its draft warning clears');
  const file = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
  assert.equal(file.updateSource, expected);
  assert.ok(Object.values(file.providers).every(provider => !provider.apiKey && !provider.encryptedKey), 'No API key should be needed or persisted for update preferences');
}
async function checkSource(expected, scenario = 'normal') {
  await app.evaluate((_electron, scenario) => { globalThis.__updateSourcesUITest.scenario = scenario; }, scenario);
  const before = (await mock()).checks.length;
  await check().click();
  await waitFor(async () => (await mock()).checks.length === before + 1 && (await mock()).current.phase === 'available', 'mock update check returns an available release');
  await waitFor(async () => (await details().innerText()).includes(expected), 'actual source appears in the update card');
  return (await mock()).checks.at(-1);
}
async function expectReleaseLink(expected) {
  const before = (await mock()).external.length;
  await panel().getByRole('button', { name: /^(版本说明|Release notes)$/ }).click();
  await waitFor(async () => (await mock()).external.length === before + 1, 'release page action reaches mocked IPC');
  assert.equal((await mock()).external.at(-1), expected);
}
async function closeApp() {
  if (!app) return;
  const snapshot = await mock().catch(() => undefined);
  if (snapshot) runs.push(snapshot);
  await app.close(); app = undefined;
}
async function launch() {
  const oldLog = await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => '');
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  app.process().stderr?.on('data', data => { diagnostics.stderr.push(String(data)); if (diagnostics.stderr.length > 100) diagnostics.stderr.shift(); });
  page = await app.firstWindow(); page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.fl-library').waitFor();
  await page.waitForLoadState('load');
  await waitFor(async () => /\bready\r?\n/.test((await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => '')).slice(oldLog.length)), 'this app launch reaches main ready');
  await app.evaluate(({ ipcMain, BrowserWindow, app, shell }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1510, 1020);
    if (process.env.FOLIO_E2E_HIDE_WINDOW === '1') { window.setFocusable(false); window.hide(); }
    const value = globalThis.__updateSourcesUITest = { scenario: 'normal', current: { phase: 'idle', currentVersion: app.getVersion() }, checks: [], downloads: [], cancellations: 0, installs: 0, external: [], nativeExternal: [], network: [], forbidden: [], resolveDownload: null };
    const bootstrap = ipcMain._invokeHandlers.get('folio:bootstrap');
    const replace = (name, handler) => { ipcMain.removeHandler('folio:' + name); ipcMain.handle('folio:' + name, handler); };
    const send = () => window.webContents.send('folio:update', structuredClone(value.current));
    replace('update-status', () => structuredClone(value.current));
    replace('check-updates', async event => {
      const saved = (await bootstrap(event)).settings;
      const preference = saved.updateSource ?? 'auto';
      const preferred = preference === 'auto' ? 'gitee' : preference;
      const fallback = value.scenario === 'fallback', newer = value.scenario === 'newer';
      const actual = fallback || newer ? 'github' : preferred;
      const version = newer ? '9.9.2' : '9.9.1';
      const url = actual === 'gitee' ? 'https://gitee.com/aurorasxh/pair-leaf/releases' : 'https://github.com/AuroraSxh/Folio-pdfreader/releases';
      value.current = { phase: 'available', currentVersion: app.getVersion(), sourcePreference: preference, preferredSource: preferred, source: actual,
        ...(preference === 'auto' ? { region: 'CN' } : {}), ...(fallback ? { sourceReason: 'source-fallback' } : newer ? { sourceReason: 'newer-on-other-source' } : {}), lastCheckedAt: Date.now(),
        release: { source: actual, version, url: url + '/tag/v' + version, notes: 'Synthetic release for UI checks only.', publishedAt: '2026-10-13T00:00:00Z', assetName: `Pairleaf-${version}-mac-universal.dmg`, size: 100 * 1024 ** 2, downloadable: true } };
      value.checks.push({ preference, preferred, actual, version, scenario: value.scenario }); send(); return structuredClone(value.current);
    });
    replace('download-update', () => {
      value.downloads.push({ source: value.current.release?.source, version: value.current.release?.version });
      value.current = { ...value.current, phase: 'downloading', downloadedBytes: 25 * 1024 ** 2, totalBytes: 100 * 1024 ** 2 }; send();
      return new Promise(resolve => { value.resolveDownload = resolve; });
    });
    replace('cancel-update', () => {
      value.cancellations++;
      const staleDownload = structuredClone(value.current), resolve = value.resolveDownload;
      value.resolveDownload = null;
      value.current = { ...value.current, phase: 'available', error: 'cancelled' }; send();
      // An obsolete download return must not overwrite the newer cancellation.
      if (resolve) setTimeout(() => resolve(staleDownload), 35);
      return structuredClone(value.current);
    });
    replace('install-update', () => { value.installs++; });
    replace('open-external', (_event, url) => { value.external.push(url); });
    shell.openExternal = async url => { value.nativeExternal.push(url); };
    for (const name of ['start-chat', 'voice-capabilities', 'voice-listen', 'voice-speak']) replace(name, () => { value.forbidden.push(name); throw new Error('Unexpected AI or speech call in updater UI test'); });
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { value.network.push(details.url); callback({ cancel: true }); });
  });
}
async function restartAndVerify(expected, language = 'zh-CN') {
  await closeSettings(); await closeApp(); await launch(); await openUpdates();
  assert.equal(await source().inputValue(), expected);
  assert.equal((await settings()).updateSource, expected);
  assert.equal((await settings()).language, language);
}

try {
  // An absent legacy preference should normalize to auto, without any credential.
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {} }));
  await launch(); await openUpdates();
  assert.equal(await source().inputValue(), 'auto');
  assert.deepEqual(await source().locator('option').evaluateAll(options => options.map(option => option.value)), ['auto', 'gitee', 'github']);
  assert.match(await panel().locator('#fl-update-source-help').textContent(), /中国大陆网络出口优先 Gitee.*代理出口.*保存设置后生效/);
  assert.equal((await mock()).checks.length, 0);
  const autoCheck = await checkSource('Gitee');
  assert.equal(autoCheck.preference, 'auto'); assert.equal(autoCheck.preferred, 'gitee');
  assert.match(await details().innerText(), /实际来源：Gitee.*网络出口：中国大陆/s);
  await expectReleaseLink(releases.gitee + '/tag/v9.9.1');
  await page.screenshot({ path: path.join(output, 'automatic-gitee-source-zh.png') });
  pass('Legacy settings default to auto; Chinese controls explain region/proxy selection and show the actual Gitee source and link');

  await source().selectOption('github');
  assert.equal(await check().isDisabled(), true); assert.equal(await download().isDisabled(), true);
  assert.match(await pending().innerText(), /尚未保存.*下方仍显示上次实际使用的来源/s);
  assert.match(await details().innerText(), /实际来源：Gitee/);
  assert.equal((await mock()).checks.length, 1); assert.equal((await mock()).downloads.length, 0);
  await closeSettings(); await openUpdates();
  assert.equal(await source().inputValue(), 'auto'); assert.equal(await pending().count(), 0);
  pass('Unsaved source changes block checks and new downloads; closing Settings discards the draft without changing the previous source');

  await source().selectOption('gitee'); await saveSource('gitee');
  assert.equal(await check().isEnabled(), true); assert.equal(await download().isEnabled(), true);
  const giteeCheck = await checkSource('Gitee'); assert.equal(giteeCheck.preference, 'gitee');
  await restartAndVerify('gitee');
  pass('Saving Gitee takes effect on the next check and persists through a full application restart');

  await checkSource('Gitee');
  await download().click();
  const progress = panel().getByRole('progressbar', { name: /^(安装包下载进度|Installer download progress)$/ });
  await progress.waitFor(); assert.equal(await progress.getAttribute('value'), '25');
  await source().selectOption('github');
  assert.equal(await cancel().isEnabled(), true); assert.equal(await check().isDisabled(), true);
  assert.match(await details().innerText(), /实际来源：Gitee/);
  assert.equal((await mock()).downloads.at(-1).source, 'gitee');
  await expectReleaseLink(releases.gitee + '/tag/v9.9.1');
  await page.screenshot({ path: path.join(output, 'downloading-original-source-with-unsaved-draft.png') });
  await cancel().click();
  await waitFor(async () => (await mock()).cancellations === 1 && !await progress.count(), 'download cancellation replaces progress');
  await page.waitForTimeout(90);
  assert.equal(await progress.count(), 0);
  assert.equal(await check().isDisabled(), true); assert.equal(await download().isDisabled(), true);
  assert.match(await panel().innerText(), /下载已取消/);
  assert.match(await details().innerText(), /实际来源：Gitee/);
  pass('Changing a draft source leaves an active download on Gitee; cancel remains enabled and an obsolete progress response cannot revive it');

  await saveSource('github');
  const githubCheck = await checkSource('GitHub'); assert.equal(githubCheck.preference, 'github');
  await expectReleaseLink(releases.github + '/tag/v9.9.1');
  await restartAndVerify('github');
  pass('Saving GitHub changes the next check and release link, and the preference survives restart');

  await source().selectOption('auto'); await saveSource('auto', 'en');
  await restartAndVerify('auto', 'en');
  assert.match(await source().locator('option[value="auto"]').textContent(), /Automatic/);
  assert.match(await panel().locator('#fl-update-source-help').textContent(), /proxy’s exit region.*manual choice.*Save settings/s);
  pass('Auto and English preferences persist together across restart, with localized source options and proxy-region guidance');

  const fallback = await checkSource('GitHub', 'fallback');
  assert.equal(fallback.version, '9.9.1'); assert.equal(fallback.preferred, 'gitee');
  assert.match(await details().innerText(), /Actual source: GitHub.*Network exit: mainland China.*Gitee did not return an available update.*uses GitHub/s);
  await expectReleaseLink(releases.github + '/tag/v9.9.1');
  pass('A same-version GitHub fallback is described separately from the preferred Gitee source and opens the actual GitHub release');

  const newer = await checkSource('GitHub', 'newer'); assert.equal(newer.version, '9.9.2');
  assert.match(await details().innerText(), /newer version is available on the other source.*uses GitHub/s);
  assert.match(await panel().locator('.fl-update-status').innerText(), /9\.9\.2/);
  await expectReleaseLink(releases.github + '/tag/v9.9.2');
  assert.equal(await source().inputValue(), 'auto');
  pass('The other-source newer-version message keeps the saved preference distinct from the actual version and release URL');

  await checkSource('Gitee');
  await page.screenshot({ path: path.join(output, 'automatic-gitee-source-en.png') });
  await source().selectOption('github');
  assert.match(await pending().innerText(), /has not been saved.*last source used.*download already in progress continues/s);
  assert.equal(await check().isDisabled(), true); assert.equal(await download().isDisabled(), true);
  assert.match(await details().innerText(), /Actual source: Gitee/);
  await expectReleaseLink(releases.gitee + '/tag/v9.9.1');
  await page.screenshot({ path: path.join(output, 'english-update-source-draft.png') });
  await closeSettings(); assert.equal((await settings()).updateSource, 'auto');
  pass('English unsaved-source guidance disables new actions while release notes continue to follow the last actual source');

  const current = await mock();
  for (const run of [...runs, current]) {
    assert.equal(run.installs, 0); assert.deepEqual(run.network, []); assert.deepEqual(run.nativeExternal, []); assert.deepEqual(run.forbidden, []);
  }
  const files = await readdir(profile, { recursive: true });
  assert.equal(files.some(file => /\.(?:dmg|exe|zip|part|crdownload)$/i.test(file)), false);
  assert.deepEqual(errors, []);
  pass('All checks use isolated data with no repository HTTP, installer files, installation, API keys, AI or microphone calls');
} catch (error) {
  errors.push(error.stack || String(error));
  await page?.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  if (app) {
    await app.evaluate(() => { const value = globalThis.__updateSourcesUITest; value?.resolveDownload?.(value.current); if (value) value.resolveDownload = null; }).catch(() => {});
    await closeApp().catch(() => {});
  }
  diagnostics.startupLog = await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => 'No startup log was written.');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, runs, diagnostics }, null, 2));
  await rm(profile, { recursive: true, force: true });
}
