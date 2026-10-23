import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Isolated settings UI and real settings IPC/store. The secure-storage methods
// are replaced before any synthetic credential is entered. No user key,
// keychain, model request, clipboard, microphone or external service is used.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/qoder-settings');
const layoutOnly = process.env.FOLIO_QODER_LAYOUT_ONLY === '1';
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-qoder-settings-'));
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const models = [
  { id: 'dmodel', efforts: ['off', 'high', 'max'], default: 'max' },
  { id: 'dfmodel', efforts: ['off', 'low', 'high', 'max'], default: 'max' },
  { id: 'gmodel', efforts: ['low', 'high', 'max'], default: 'max' },
  { id: 'gfmodel', efforts: ['high', 'max'], default: 'max' },
  { id: 'gm51model', efforts: ['off', 'high', 'max'], default: 'max' },
  { id: 'kmodel_latest', efforts: ['low', 'high', 'max'], default: 'max' },
  { id: 'kmodel', efforts: ['low', 'high', 'max'], default: 'max' },
  { id: 'mmodel', efforts: [], vision: false },
  { id: 'qmodel_38max', efforts: ['off', 'low', 'medium', 'xhigh'], default: 'xhigh' },
  { id: 'qfmodel', efforts: ['off', 'low', 'medium', 'xhigh'], default: 'xhigh' },
  { id: 'qmodel_latest', efforts: [], toggle: true },
  { id: 'qmodel', efforts: [], toggle: true },
  { id: 'q37fmodel', efforts: [] },
  { id: 'auto', efforts: [] },
];
const fakeKeys = { kimi: 'synthetic-qoder-kimi-only', deepseek: 'synthetic-qoder-deepseek-only', otherOrigin: 'synthetic-qoder-other-origin' };
const checks = [], errors = [];
let app, page, failure;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = label => { checks.push(label); console.log('PASS ' + label); };
const state = () => page.evaluate(() => window.folio.bootstrap());
const modelSelect = () => page.getByRole('combobox', { name: /^(Qoder 模型|Qoder model)$/, exact: true });
const effortSelect = () => page.getByRole('combobox', { name: /^(Qoder 思考深度|Qoder thinking depth)$/, exact: true });
// Password fields have no implicit textbox role.
const keyField = () => page.locator('input[aria-label="API Key"]');
const baseURL = () => page.getByRole('textbox', { name: 'API Base URL', exact: true });
const saveButton = () => page.getByRole('button', { name: /^(保存设置|Save settings)$/, exact: true });
async function waitFor(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(65); }
  throw Error('Timed out: ' + label);
}
async function save() {
  const before = await app.evaluate(() => globalThis.__qoderSettingsE2E.saves.length);
  await saveButton().click();
  await waitFor(async () => await app.evaluate(() => globalThis.__qoderSettingsE2E.saves.length) === before + 1, 'settings saved through the actual store');
  await waitFor(() => saveButton().isEnabled(), 'save completed');
}
async function selectModel(id) { await modelSelect().selectOption(id); }
async function shot(name) {
  await page.screenshot({ path: path.join(output, name + '.png'), scale: 'css' });
}
async function assertNoOverflow() {
  const sizes = await page.locator('.fl-settings-modal, .fl-settings-content, .fl-provider-grid, .fl-qoder-settings').evaluateAll(elements => elements.map(element => ({ name: element.className, client: element.clientWidth, scroll: element.scrollWidth })));
  for (const size of sizes) assert.ok(size.scroll <= size.client + 1, 'No horizontal overflow: ' + size.name);
  const dialog = await page.getByRole('dialog').boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(dialog && dialog.x >= 0 && dialog.y >= 0 && dialog.x + dialog.width <= viewport.width + 1 && dialog.y + dialog.height <= viewport.height + 1, 'Settings dialog fits the application viewport');
}

try {
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {} }));
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await waitFor(async () => /\bready\r?\n/.test(await readFile(path.join(profile, 'logs/main.log'), 'utf8').catch(() => '')), 'native startup complete');
  await app.evaluate(({ safeStorage, ipcMain, BrowserWindow }) => {
    const s = globalThis.__qoderSettingsE2E = { saves: [], blocked: [], encryptions: 0, decryptions: 0 };
    // This deterministic transform is deliberately only a mock. Synthetic
    // keys never enter the real OS secure-storage API.
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = value => { s.encryptions++; return Buffer.from(value, 'utf8').map(byte => byte ^ 0x5a); };
    safeStorage.decryptString = value => { s.decryptions++; return Buffer.from(value).map(byte => byte ^ 0x5a).toString('utf8'); };
    const original = ipcMain._invokeHandlers.get('folio:save-settings');
    ipcMain.removeHandler('folio:save-settings');
    ipcMain.handle('folio:save-settings', async (event, input) => {
      const result = await original(event, input);
      s.saves.push({ model: result.providers.qoder.model, hasKey: result.providers.qoder.hasKey, hadKeyInput: Boolean(input.providers.qoder.apiKey), status: { ...result.providers.qoder.modelKeyStatus } });
      return result;
    });
    for (const name of ['start-chat', 'open-external', 'check-updates', 'download-update', 'install-update', 'voice-listen', 'voice-speak', 'read-clipboard-text', 'write-clipboard-text']) {
      const channel = 'folio:' + name; ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => { s.blocked.push(name); throw Error('Unexpected external operation in Qoder settings UI test.'); });
    }
    globalThis.fetch = async () => { s.blocked.push('main-fetch'); throw Error('Network is disabled in the settings UI test.'); };
    const win = BrowserWindow.getAllWindows()[0]; win.setSize(1260, 900);
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { s.blocked.push('renderer-network'); callback({ cancel: true }); });
  });
  await page.getByRole('button', { name: /^(设置与连接|Settings)/ }).first().click();
  await page.locator('.fl-provider-grid > button').filter({ hasText: 'Qoder' }).click();
  if (!layoutOnly) {
  assert.equal((await state()).settings.activeProvider, 'deepseek', 'Selecting a provider card edits its configuration without changing the active provider');
  assert.equal(await page.getByRole('button', { name: '设为默认', exact: true }).isVisible(), true);
  assert.equal(await modelSelect().inputValue(), 'kmodel_latest');
  assert.equal(await effortSelect().inputValue(), 'max');
  assert.equal(await baseURL().inputValue(), 'http://127.0.0.1:8788/v1');
  assert.deepEqual(await modelSelect().locator('option').evaluateAll(options => options.map(option => option.value)), models.map(model => model.id));
  assert.equal(await page.getByRole('spinbutton', { name: '最大输出 tokens', exact: true }).getAttribute('max'), '32000');
  assert.equal(await page.getByRole('textbox', { name: '模型 ID', exact: true }).getAttribute('readonly'), '');
  pass('Qoder settings expose all 14 model aliases, Kimi-K3/Max defaults, the local URL, a read-only model ID and the 32,000-token output limit');

  for (const model of models) {
    await selectModel(model.id);
    assert.equal(await page.getByRole('textbox', { name: '模型 ID', exact: true }).inputValue(), model.id);
    assert.equal(await effortSelect().count(), model.efforts.length ? 1 : 0);
    if (model.efforts.length) {
      assert.deepEqual(await effortSelect().locator('option').evaluateAll(options => options.map(option => option.value)), model.efforts);
      assert.equal(await effortSelect().inputValue(), model.default);
      if (model.efforts.includes('off')) { await effortSelect().selectOption('off'); assert.equal(await effortSelect().inputValue(), 'off'); }
    }
    const toggle = page.getByRole('switch', { name: 'Qoder 思考模式', exact: true });
    assert.equal(await toggle.count(), model.toggle ? 1 : 0);
    if (model.toggle) { assert.equal(await toggle.getAttribute('aria-checked'), 'true'); await toggle.click(); assert.equal(await toggle.getAttribute('aria-checked'), 'false'); }
    assert.equal(await page.locator('#vision-model-help').getAttribute('data-state'), model.vision === false ? 'unsupported' : 'supported');
  }
  assert.deepEqual(await page.getByRole('combobox', { name: '模型图片输入', exact: true }).locator('option').evaluateAll(options => options.map(option => option.value)), ['auto', 'disabled']);
  pass('Each model shows only its supported thinking controls; model switching resets stale levels, MiniMax remains text-only, and Qoder image support cannot be forced on');

  await selectModel('kmodel_latest');
  await page.getByRole('button', { name: '设为默认', exact: true }).click();
  await keyField().fill(fakeKeys.kimi); await save();
  let settings = (await state()).settings;
  assert.equal(settings.activeProvider, 'qoder');
  assert.equal(settings.providers.qoder.hasKey, true);
  assert.deepEqual(settings.providers.qoder.modelKeyStatus, { kmodel_latest: true });
  assert.equal(await keyField().inputValue(), '');
  await selectModel('dmodel');
  assert.equal(await keyField().inputValue(), '');
  assert.match(await keyField().getAttribute('placeholder'), /专用 Key/);
  await keyField().fill(fakeKeys.deepseek); await save();
  settings = (await state()).settings;
  assert.deepEqual(settings.providers.qoder.modelKeyStatus, { kmodel_latest: true, dmodel: true });
  await selectModel('kmodel_latest');
  assert.match(await keyField().getAttribute('placeholder'), /已保存/);
  await save();
  assert.equal((await state()).settings.providers.qoder.model, 'kmodel_latest');
  assert.equal((await state()).settings.providers.qoder.hasKey, true);
  const storedBefore = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(storedBefore.providers.qoder.modelKeys).sort(), ['dmodel', 'kmodel_latest']);
  assert.notEqual(storedBefore.providers.qoder.modelKeys.dmodel.encryptedKey, storedBefore.providers.qoder.modelKeys.kmodel_latest.encryptedKey);
  assert.ok(Object.values(fakeKeys).every(key => !JSON.stringify(storedBefore).includes(key) && !JSON.stringify(settings).includes(key)), 'Synthetic credentials must not appear in public settings or plaintext stored JSON');
  pass('Two model keys save independently through the real store; selecting a saved model reuses its own key without exposing it to the renderer');

  await keyField().fill('synthetic-unsaved-input'); await selectModel('qmodel_38max');
  assert.equal(await keyField().inputValue(), '');
  await page.locator('.fl-settings-footer [role="status"]').filter({ hasText: '未保存的密钥输入已清除' }).waitFor();
  await save();
  assert.equal((await state()).settings.providers.qoder.hasKey, false);
  assert.deepEqual((await state()).settings.providers.qoder.modelKeyStatus, { kmodel_latest: true, dmodel: true });
  pass('Switching models clears an unsaved key and a model with no stored key never inherits another model’s credential');

  await keyField().fill('synthetic-discard-on-origin-change');
  await baseURL().fill('http://127.0.0.1:8789/v1');
  assert.equal(await keyField().inputValue(), '');
  assert.equal(await keyField().getAttribute('aria-invalid'), 'true');
  assert.ok(!(await modelSelect().locator('option').allTextContents()).some(text => text.includes('已保存')));
  const savedCount = await app.evaluate(() => globalThis.__qoderSettingsE2E.saves.length);
  await saveButton().click();
  await page.locator('.fl-settings-footer [role="status"]').filter({ hasText: '重新填写' }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.__qoderSettingsE2E.saves.length), savedCount);
  await selectModel('kmodel_latest');
  assert.match(await keyField().getAttribute('placeholder'), /专用 Key/);
  await baseURL().fill('http://127.0.0.1:8788/v1');
  assert.match(await keyField().getAttribute('placeholder'), /已保存/);
  await save();
  await baseURL().fill('http://127.0.0.1:8789/v1');
  await keyField().fill(fakeKeys.otherOrigin); await save();
  settings = (await state()).settings;
  assert.equal(settings.providers.qoder.baseURL, 'http://127.0.0.1:8789/v1');
  assert.deepEqual(settings.providers.qoder.modelKeyStatus, { kmodel_latest: true });
  const storedAfter = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(storedAfter.providers.qoder.modelKeys), ['kmodel_latest']);
  assert.equal(storedAfter.providers.qoder.modelKeys.kmodel_latest.origin, 'http://127.0.0.1:8789');
  pass('Changing bridge origin clears draft credentials and blocks reuse even when the selected model has no key; returning restores the saved-key status, while explicit replacement binds only the new origin');

  await baseURL().fill('https://example.invalid/v1'); await saveButton().click();
  await page.locator('.fl-settings-footer [role="status"]').filter({ hasText: '本机代理地址' }).waitFor();
  await baseURL().fill('http://127.0.0.1:8789/v1');
  const tokens = page.getByRole('spinbutton', { name: '最大输出 tokens', exact: true });
  await tokens.fill('32001'); await saveButton().click();
  await page.locator('.fl-settings-footer [role="status"]').filter({ hasText: '32000' }).waitFor();
  await tokens.fill('8192'); await save();
  pass('Settings reject a remote Qoder endpoint and output budgets above the local bridge’s supported limit');
  }

  const keyStatusBeforeLayout = Boolean((await state()).settings.providers.qoder.hasKey);
  await page.locator('.fl-font-options').getByRole('button', { name: '150%', exact: true }).click();
  await save();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800));
  await modelSelect().scrollIntoViewIfNeeded(); await assertNoOverflow(); await shot('qoder-settings-zh-150-minimum');
  await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en'); await save();
  await page.getByRole('combobox', { name: 'Qoder model', exact: true }).waitFor();
  await modelSelect().scrollIntoViewIfNeeded(); await assertNoOverflow();
  assert.equal(await page.getByRole('combobox', { name: 'Qoder thinking depth', exact: true }).inputValue(), 'max');
  assert.equal(await page.getByRole('button', { name: 'Save settings', exact: true }).isVisible(), true);
  assert.equal(await page.locator('.fl-settings-nav > button.active').evaluate(button => {
    const node = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes('assistant'));
    if (!node) return false;
    const start = node.textContent.indexOf('assistant'), range = document.createRange();
    range.setStart(node, start); range.setEnd(node, start + 'assistant'.length);
    return range.getClientRects().length === 1;
  }), true, 'The English navigation label does not split a word across lines');
  await shot('qoder-settings-en-150-minimum');
  await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('zh-CN'); await save();
  await page.getByRole('combobox', { name: 'Qoder 模型', exact: true }).waitFor();
  assert.equal(Boolean((await state()).settings.providers.qoder.hasKey), keyStatusBeforeLayout);
  pass('Chinese and English settings remain usable at 150% app text size and the minimum 1000×800 window, preserving model/key selection across language changes');

  const diagnostics = await app.evaluate(() => ({ blocked: globalThis.__qoderSettingsE2E.blocked, encryptions: globalThis.__qoderSettingsE2E.encryptions, decryptions: globalThis.__qoderSettingsE2E.decryptions, saves: globalThis.__qoderSettingsE2E.saves }));
  assert.deepEqual(errors, []); assert.deepEqual(diagnostics.blocked, []);
  assert.equal(diagnostics.encryptions, layoutOnly ? 0 : 3); assert.equal(diagnostics.decryptions, 0);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, layoutOnly, checks, errors, diagnostics }, null, 2));
} catch (error) {
  failure = String(error); console.error(failure); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, error: failure }, null, 2));
} finally {
  if (app) await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
