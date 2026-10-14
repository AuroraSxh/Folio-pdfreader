import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Real Electron/React/PDF UI with controlled chat and external-link IPC.
// Provider adapters are tested separately; no real API key or HTTP call is used.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/web-search-ui');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-web-ui-'));
const env = { ...process.env, FOLIO_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const id = 'web-search-ui-fixture', checks = [], errors = [];
const diagnostics = { stderr: [], startupLog: '' };
const webAnswer = 'This mock answer cites current background [evidence A](https://example.org/evidence) and another result [evidence B](https://example.net/update). The original PDF remains separate [Main.pdf p.1].\n\nAn [ordinary unverified link](https://example.org/not-returned) is not a searched source.';
let app, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const state = () => app.evaluate(() => {
  const value = globalThis.__webSearchUITest;
  return { requests: value.requests, external: value.external, nativeExternal: value.nativeExternal, forbidden: value.forbidden, network: value.network };
});
const toggle = () => page.getByRole('button', { name: /^(联网搜索|Web search)$/ });
const input = () => page.getByRole('textbox', { name: /^(向 AI 提问|Ask AI)$/ });
const sendButton = () => page.getByRole('button', { name: /^(发送问题|Send question)$/ });
async function waitFor(predicate, label) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
}
async function seed() {
  const directory = path.join(profile, 'Library', id);
  await mkdir(path.join(directory, '.text'), { recursive: true });
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([620, 820]).drawText('Local PDF context for web-search UI checks.', { x: 45, y: 730, size: 16, font });
  const bytes = await pdf.save();
  await writeFile(path.join(directory, 'Main.pdf'), bytes);
  await writeFile(path.join(directory, '.text', 'main.json'), JSON.stringify(['Local PDF context for web-search UI checks.']));
  const now = Date.now();
  const workspace = { version: 1, id, title: 'Web search UI fixture', titleStatus: 'confirmed', authors: '', journal: '', doi: '', tags: [], favorite: false, createdAt: now, updatedAt: now, lastReadAt: now,
    documents: [{ id: 'main', name: 'Main.pdf', fileName: 'Main.pdf', role: 'main', size: bytes.length, pageCount: 1, outline: [], outlineLoaded: true, annotations: [], textStatus: 'ready', view: { page: 1, scale: '0.85', rotation: 0, scrollMode: 0, spreadMode: 0 } }], notes: '', memories: [], memoryIndex: '',
    conversations: [{ id: 'chat', title: 'Web UI checks', createdAt: now, messages: [] }], activeConversationId: 'chat', layout: { split: false, leftId: 'main', rightId: '', ratio: 50 } };
  await writeFile(path.join(directory, 'workspace.json'), JSON.stringify(workspace));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: false, providers: {} }));
}
async function openReader() {
  await page.getByRole('button', { name: /^(打开|Open) Web search UI fixture$/ }).click();
  await page.locator('.pdf-pane .textLayer span').first().waitFor({ state: 'attached' });
  const companion = page.getByRole('button', { name: /^(阅读伙伴|Reading companion)$/ });
  if (await companion.getAttribute('aria-expanded') !== 'true') await companion.click();
  const pin = page.getByRole('button', { name: /^(固定阅读伙伴|Pin reading companion)$/ });
  if (await pin.isVisible()) await pin.click();
  await toggle().waitFor();
}
async function send(prompt) {
  const count = (await state()).requests.length;
  await input().fill(prompt); await sendButton().click();
  await waitFor(async () => (await state()).requests.length === count + 1, 'mock request');
  return (await state()).requests.at(-1);
}
async function emit(type, fields = {}) {
  await app.evaluate(({ BrowserWindow }, data) => {
    const request = globalThis.__webSearchUITest.requests.at(-1).request;
    BrowserWindow.getAllWindows()[0].webContents.send('folio:chat', { requestId: request.requestId, workspaceId: request.workspaceId, type: data.type, ...data.fields });
  }, { type, fields });
}
async function finish(type = 'done') {
  await emit(type, type === 'error' ? { text: 'Controlled web-search failure for retry checks.' } : {});
  await waitFor(async () => !await page.getByRole('button', { name: /^(停止生成|Stop generation)$/ }).count(), 'mock request finishes');
}
async function selectConfig(config, language = 'zh-CN', uiFontScale = 1, theme = 'light') {
  await app.evaluate((_electron, value) => { const test = globalThis.__webSearchUITest; test.config = value.config; test.language = value.language; test.uiFontScale = value.uiFontScale; test.theme = value.theme; }, { config, language, uiFontScale, theme });
  await page.reload(); await openReader();
}
async function expandSources(sources, expanded) {
  const summary = sources.locator('summary');
  if ((await summary.getAttribute('aria-expanded') === 'true') !== expanded) { await summary.focus(); await page.keyboard.press('Enter'); }
  await waitFor(async () => await summary.getAttribute('aria-expanded') === String(expanded), 'sources disclosure toggles');
  await waitFor(async () => await sources.locator('.fl-web-source-details').count() === Number(expanded), 'source detail DOM mounts only while expanded');
}
async function assertPopoverFits(label) {
  const bounds = await page.locator('.fl-web-citation-popover').evaluate(element => {
    const card = element.getBoundingClientRect(), panel = element.closest('.fl-assistant').getBoundingClientRect();
    return { card: { x: card.left, y: card.top, right: card.right, bottom: card.bottom, width: card.width, height: card.height }, panel: { x: panel.left, y: panel.top, right: panel.right, bottom: panel.bottom }, viewport: { width: innerWidth, height: innerHeight }, nativeOpen: element.matches(':popover-open'), fontSize: getComputedStyle(element).fontSize, background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color };
  });
  assert.equal(bounds.nativeOpen, true, label + ': native top-layer popover is open');
  assert.ok(bounds.card.x >= Math.max(12, bounds.panel.x + 12) - 1, label + ': left boundary');
  assert.ok(bounds.card.right <= Math.min(bounds.viewport.width - 12, bounds.panel.right - 12) + 1, label + ': right boundary');
  assert.ok(bounds.card.y >= Math.max(12, bounds.panel.y + 12) - 1, label + ': top boundary');
  assert.ok(bounds.card.bottom <= Math.min(bounds.viewport.height - 12, bounds.panel.bottom - 12) + 1, label + ': bottom boundary');
  assert.notEqual(bounds.background, bounds.color, label + ': readable colors');
  diagnostics[label] = bounds;
}

try {
  await seed();
  const executablePath = process.env.FOLIO_EXECUTABLE;
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  app.process().stderr?.on('data', value => { diagnostics.stderr.push(String(value)); if (diagnostics.stderr.length > 80) diagnostics.stderr.shift(); });
  page = await app.firstWindow(); page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '打开 Web search UI fixture', exact: true }).waitFor();
  await page.waitForLoadState('load');
  await waitFor(async () => /\bready\r?\n/.test(await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => '')), 'initial main startup completes');
  await app.evaluate(({ BrowserWindow, ipcMain, shell }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setSize(1680, 1080);
    if (process.env.FOLIO_E2E_HIDE_WINDOW === '1') { window.setFocusable(false); window.hide(); }
    const test = globalThis.__webSearchUITest = { config: { id: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', hasKey: true }, language: 'zh-CN', uiFontScale: 1, theme: 'light',
      requests: [], external: [], nativeExternal: [], forbidden: [], network: [], saved: null };
    const bootstrap = ipcMain._invokeHandlers.get('folio:bootstrap');
    const replace = (name, handler) => { ipcMain.removeHandler('folio:' + name); ipcMain.handle('folio:' + name, handler); };
    // Keep response snapshots authoritative in the UI fixture while real view/
    // metadata IPC still runs. This tests rendering across a renderer reload;
    // backend persistence and native provider payloads have their own tests.
    const withSavedChat = workspace => {
      if (!test.saved || test.saved.id !== workspace.id) return workspace;
      test.saved = { ...workspace, conversations: test.saved.conversations, updatedAt: Math.max(workspace.updatedAt, test.saved.updatedAt) + 1 };
      return structuredClone(test.saved);
    };
    replace('bootstrap', async (...args) => {
      const result = await bootstrap(...args), config = test.config;
      result.settings.activeProvider = config.id;
      result.settings.providers[config.id] = { ...result.settings.providers[config.id], ...config, apiKey: undefined };
      result.settings.language = test.language; result.settings.uiFontScale = test.uiFontScale; result.settings.theme = test.theme;
      result.workspaces = result.workspaces.map(withSavedChat); return result;
    });
    for (const name of ['update-workspace', 'update-view', 'index-document']) {
      const original = ipcMain._invokeHandlers.get('folio:' + name);
      replace(name, async (...args) => withSavedChat(await original(...args)));
    }
    replace('start-chat', (_event, request) => { test.requests.push({ request: structuredClone(request), provider: { id: test.config.id, model: test.config.model, baseURL: test.config.baseURL } }); });
    replace('abort-chat', (_event, requestId) => { const entry = test.requests.find(item => item.request.requestId === requestId); if (entry) window.webContents.send('folio:chat', { requestId, workspaceId: entry.request.workspaceId, type: 'done', interrupted: true }); });
    replace('open-external', (_event, url) => { test.external.push(url); });
    shell.openExternal = async url => { test.nativeExternal.push(url); };
    for (const name of ['voice-capabilities', 'voice-listen', 'voice-speak']) replace(name, () => { test.forbidden.push(name); throw new Error('Unexpected voice call in web-search UI test'); });
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { test.network.push(details.url); callback({ cancel: true }); });
  });
  await page.reload(); await openReader();
  assert.equal(await toggle().getAttribute('aria-pressed'), 'false');
  assert.equal(await toggle().isEnabled(), true);
  assert.match(await page.locator('#web-search-help').textContent(), /默认关闭.*使用当前模型/);
  const offRequest = await send('Explain the paper without using web search.');
  assert.equal(offRequest.request.webSearch, false);
  await finish();
  pass('Web search starts off and ordinary questions explicitly retain a false search flag');

  await toggle().focus(); await page.keyboard.press('Enter');
  assert.equal(await toggle().getAttribute('aria-pressed'), 'true');
  const onRequest = await send('Find recent background for this paper using the current model.');
  assert.equal(onRequest.request.webSearch, true);
  assert.deepEqual(onRequest.provider, { id: 'deepseek', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com' });
  assert.equal(await toggle().isDisabled(), true);
  assert.equal(Object.hasOwn(onRequest.request, 'searchProvider'), false);
  assert.equal(Object.hasOwn(onRequest.request, 'apiKey'), false);
  pass('Explicit keyboard activation enables only a boolean search request for the currently selected model');

  const webResult = { query: 'fixture scientific background', searchedAt: Date.now(), sources: [
    { title: 'Live evidence A', url: 'https://example.org/evidence', snippet: 'Synthetic evidence snippet A.', publishedAt: '2026-10-01' },
    { title: 'Live evidence B', url: 'https://example.net/update', snippet: 'Synthetic evidence snippet B.' },
    { title: 'Unsafe local file', url: 'file:///etc/passwd', snippet: 'Must not be shown.' },
    { title: 'Unsafe local service', url: 'http://127.0.0.1/admin', snippet: 'Must not be shown.' },
    { title: 'Duplicate evidence', url: 'https://example.org/evidence', snippet: 'Must be deduplicated.' },
  ] };
  await emit('status', { text: '正在检索网页来源…', webSearch: webResult });
  await emit('delta', { text: webAnswer });
  const streamingAnswer = page.locator('.fl-message.assistant:not([data-message-id])');
  const streamingSources = streamingAnswer.locator('.fl-web-sources');
  await streamingSources.waitFor();
  assert.equal(await streamingSources.getByRole('link').count(), 0);
  assert.equal(await streamingSources.locator('.fl-web-source-details').count(), 0);
  assert.doesNotMatch(await streamingSources.innerHTML(), /example\.org|example\.net|Synthetic evidence|fixture scientific/);
  assert.match(await streamingSources.innerText(), /网页来源.*2/s);
  await expandSources(streamingSources, true);
  assert.equal(await streamingSources.getByRole('link').count(), 2);
  assert.match(await streamingSources.innerText(), /fixture scientific background.*Synthetic evidence snippet A/s);
  assert.doesNotMatch(await streamingSources.innerText(), /Unsafe|Duplicate|127\.0\.0\.1|file:/);
  assert.equal(await streamingSources.locator('.fl-source-citation').count(), 0);
  await expandSources(streamingSources, false);
  assert.equal(await streamingSources.getByRole('link').count(), 0);
  pass('Streaming source details stay out of the DOM until keyboard expansion, and collapse removes them again');

  const chips = streamingAnswer.locator('.fl-web-citation-chip');
  await waitFor(async () => await chips.count() === 2, 'streaming Markdown trusted URLs become inline chips');
  assert.equal(await streamingAnswer.locator('a[href="https://example.org/not-returned"]').count(), 1);
  assert.equal(await streamingAnswer.locator('.fl-source-citation').count(), 1);
  const firstChip = chips.nth(0);
  assert.match(await firstChip.innerText(), /1.*example\.org/s);
  assert.equal(await streamingAnswer.locator('.fl-web-citation-popover').count(), 0);
  const oldURL = page.url();
  await firstChip.focus(); await page.keyboard.press('Enter');
  const popup = page.locator('.fl-web-citation-popover');
  await popup.waitFor({ state: 'visible' });
  assert.match(await popup.innerText(), /Live evidence A.*example\.org.*Synthetic evidence snippet A/s);
  assert.equal(await popup.getByRole('link', { name: /打开网页/ }).getAttribute('href'), 'https://example.org/evidence');
  assert.deepEqual((await state()).external, []);
  assert.equal(await page.locator('.pdf-source-feedback').count(), 0, 'web chip does not activate the enclosing PDF source block');
  await assertPopoverFits('dockedPopover');
  await page.keyboard.press('Escape');
  await popup.waitFor({ state: 'detached' });
  assert.equal(await firstChip.evaluate(element => document.activeElement === element), true);
  assert.equal(await firstChip.getAttribute('aria-expanded'), 'false');
  assert.deepEqual((await state()).external, []);
  pass('Inline source chips show a bounded source popover, and Escape returns focus without opening a URL or navigating the PDF');

  await firstChip.click(); await popup.waitFor({ state: 'visible' });
  await popup.getByRole('link', { name: /打开网页/ }).click();
  await waitFor(async () => (await state()).external.length === 1, 'explicit open webpage reaches mocked external-link IPC');
  await popup.getByRole('button', { name: '关闭网页来源', exact: true }).click();
  await chips.nth(1).click(); await popup.waitFor({ state: 'visible' });
  await popup.getByRole('link', { name: /打开网页/ }).click({ button: 'middle' });
  await waitFor(async () => (await state()).external.length === 2, 'middle click on explicit open webpage reaches IPC');
  assert.deepEqual((await state()).external, ['https://example.org/evidence', 'https://example.net/update']);
  assert.deepEqual((await state()).nativeExternal, []);
  assert.equal(page.url(), oldURL);
  await page.screenshot({ path: path.join(output, 'streaming-web-citation.png') });
  await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' });
  await streamingAnswer.locator('.fl-source-citation').click();
  await page.locator('.pdf-source-feedback[data-source-status="page-only"]').waitFor();
  assert.equal(await popup.count(), 0);
  assert.deepEqual((await state()).external, ['https://example.org/evidence', 'https://example.net/update']);
  await page.getByRole('button', { name: '清除原文定位', exact: true }).click();
  pass('Only explicit webpage opening dispatches external links; legacy PDF citations continue navigating the PDF independently');

  const saved = await page.evaluate(async ({ workspaceId, result, answer }) => {
    const value = (await window.folio.bootstrap()).workspaces.find(item => item.id === workspaceId);
    const conversation = value.conversations.find(item => item.id === value.activeConversationId);
    conversation.messages.push({ id: 'saved-web-user', role: 'user', content: 'Search fixture request.', createdAt: Date.now() }, { id: 'saved-web-answer', role: 'assistant', content: answer, createdAt: Date.now(), webSearch: result });
    value.updatedAt = Math.max(Date.now(), value.updatedAt + 1); return value;
  }, { workspaceId: id, result: webResult, answer: webAnswer });
  await app.evaluate((_electron, workspace) => { globalThis.__webSearchUITest.saved = workspace; }, saved);
  await emit('done', { workspace: saved });
  await page.locator('[data-message-id="saved-web-answer"] .fl-web-sources').waitFor();
  assert.equal(await streamingSources.count(), 0);
  await page.reload(); await openReader();
  const savedSources = page.locator('[data-message-id="saved-web-answer"] .fl-web-sources');
  assert.equal(await savedSources.getByRole('link').count(), 0);
  assert.equal(await page.locator('[data-message-id="saved-web-answer"] .fl-web-citation-chip').count(), 2);
  assert.equal(saved.conversations[0].messages.at(-1).content, webAnswer, 'saved Markdown and model links remain unchanged');
  assert.equal(await toggle().getAttribute('aria-pressed'), 'false');
  pass('Completed snapshots and reload retain source chips and original Markdown while source details and new search start closed');

  await toggle().click();
  const retriedOn = await send('A search-enabled request that will fail once.');
  await finish('error'); await toggle().click();
  assert.equal(await toggle().getAttribute('aria-pressed'), 'false');
  const countOn = (await state()).requests.length;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitFor(async () => (await state()).requests.length === countOn + 1, 'retry retains enabled search');
  assert.equal((await state()).requests.at(-1).request.webSearch, true);
  assert.equal((await state()).requests.at(-1).request.prompt, retriedOn.request.prompt);
  await finish();
  const retriedOff = await send('A search-disabled request that will fail once.');
  assert.equal(retriedOff.request.webSearch, false);
  await finish('error'); await toggle().click();
  const countOff = (await state()).requests.length;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitFor(async () => (await state()).requests.length === countOff + 1, 'retry retains disabled search');
  assert.equal((await state()).requests.at(-1).request.webSearch, false);
  await finish();
  pass('Retry preserves the original search flag in both directions even after the current toggle changes');

  const supported = [
    { id: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-5.2', hasKey: true },
    { id: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', hasKey: true },
    { id: 'custom', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k3', hasKey: true },
    { id: 'custom', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3', hasKey: true },
  ];
  for (const config of supported) {
    await selectConfig(config);
    assert.equal(await toggle().isEnabled(), true, config.model);
    assert.equal(await toggle().getAttribute('aria-pressed'), 'false', config.model);
    assert.match(await page.locator('.fl-composer-caption').textContent(), new RegExp(config.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await toggle().click(); const entry = await send('Use only the currently selected fixture model for search.');
    assert.equal(entry.request.webSearch, true);
    assert.deepEqual(entry.provider, { id: config.id, model: config.model, baseURL: config.baseURL });
    await finish();
  }
  pass('Official GPT, Anthropic, Kimi K3 and GLM configurations expose current-model search without selecting another provider');

  for (const config of [
    { id: 'custom', baseURL: 'https://gateway.example.org/v1', model: 'kimi-k3', hasKey: true },
    { id: 'custom', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k2.5', hasKey: true },
    { id: 'openai', baseURL: 'https://gateway.example.org/v1', model: 'gpt-5.2', hasKey: true },
  ]) {
    await selectConfig(config);
    assert.equal(await toggle().isDisabled(), true);
    assert.equal(await toggle().getAttribute('aria-pressed'), 'false');
    assert.match(await page.locator('#web-search-help').textContent(), /当前模型或接口(?:暂)?不支持/);
    assert.equal(await page.getByRole('button', { name: '配置当前模型', exact: true }).isEnabled(), true);
  }
  await selectConfig({ id: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', hasKey: false });
  assert.equal(await toggle().isDisabled(), true);
  assert.match(await page.locator('#web-search-help').textContent(), /API Key/);
  pass('Unknown gateways, unsupported Kimi models and missing current-model credentials disable search with an actionable explanation');

  await selectConfig({ id: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', hasKey: true }, 'en', 1.5, 'dark');
  assert.equal(await toggle().getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('#web-search-help').textContent(), /Off by default.*(?:only the current model|Uses this model)/);
  await page.getByRole('region', { name: 'Web sources', exact: true }).waitFor();
  const englishSources = page.getByRole('region', { name: 'Web sources', exact: true });
  assert.equal(await englishSources.getByRole('link').count(), 0);
  await expandSources(englishSources, true);
  assert.equal(await englishSources.getByRole('link').count(), 2);
  await expandSources(englishSources, false);
  const unpin = page.getByRole('button', { name: 'Unpin reading companion', exact: true });
  if (await unpin.isVisible()) await unpin.click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
  await page.locator('.assistant-shell.is-overlay').waitFor();
  const west = page.locator('[data-assistant-resize="w"]');
  await west.focus(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight');
  await waitFor(async () => Math.abs((await page.locator('.assistant-shell').boundingBox()).width - 320) < 2, 'small floating assistant width');
  const largeChip = page.locator('[data-message-id="saved-web-answer"] .fl-web-citation-chip').first();
  await largeChip.scrollIntoViewIfNeeded(); await largeChip.click();
  await popup.waitFor({ state: 'visible' });
  assert.match(await popup.innerText(), /Web source 1.*Live evidence A.*Open webpage/s);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await largeChip.evaluate(element => parseFloat(getComputedStyle(element).fontSize)), 16.5);
  await assertPopoverFits('floatingDark150Popover');
  await page.screenshot({ path: path.join(output, 'web-citation-floating-dark-150.png') });
  const externalBeforeDismiss = (await state()).external.length;
  await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' });
  assert.equal(await largeChip.evaluate(element => document.activeElement === element), true);
  await largeChip.click(); await popup.waitFor({ state: 'visible' });
  await page.locator('.fl-assistant-header strong').click();
  await popup.waitFor({ state: 'detached' });
  await largeChip.click(); await popup.waitFor({ state: 'visible' });
  await largeChip.evaluate(element => element.closest('.fl-chat-scroll').dispatchEvent(new Event('scroll')));
  await popup.waitFor({ state: 'detached' });
  assert.equal((await state()).external.length, externalBeforeDismiss);
  pass('English citations fit a 320px floating panel at 150% dark text; Escape, outside click and scrolling dismiss without opening links');
  const final = await state();
  assert.deepEqual(final.network, []); assert.deepEqual(final.nativeExternal, []); assert.deepEqual(final.forbidden, []); assert.deepEqual(errors, []);
  pass('No renderer exceptions, HTTP attempts, system browser launch, real provider requests, or microphone access');
} catch (error) {
  errors.push(error.stack || String(error));
  await page?.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  diagnostics.startupLog = await readFile(path.join(profile, 'logs', 'main.log'), 'utf8').catch(() => 'No startup log was written.');
  const captured = app ? await state().catch(() => undefined) : undefined;
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, state: captured, diagnostics }, null, 2));
  if (app) await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
