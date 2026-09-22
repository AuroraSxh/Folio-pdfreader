import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Real UI, preload, IPC, and disk persistence. All files live in an isolated
// profile. AI and speech entry points fail closed if this test reaches them;
// the deletion handler and workspace storage are never mocked.
const output = path.resolve(process.env.FOLIO_E2E_OUTPUT || 'test-results/chat-deletion');
await mkdir(output, { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), 'folio-chat-deletion-e2e-'));
const env = { ...process.env, FOLIO_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const executablePath = process.env.FOLIO_EXECUTABLE;
const workspaceId = 'chat-deletion-fixture', conversationId = 'chat-deletion-conversation';
const title = 'Chat deletion fixture', documentId = 'chat-deletion-pdf';
const directory = path.join(userData, 'Library', workspaceId);
const workspaceFile = path.join(directory, 'workspace.json');
const checks = [], errors = [], ipcAudit = [];
let app, page, fixture, pdfBytes;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(predicate, label, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(70); }
  throw new Error('Timed out: ' + label);
}
const state = () => page.evaluate(() => window.folio.bootstrap());
const workspace = async () => (await state()).workspaces.find(item => item.id === workspaceId);
const diskWorkspace = async () => JSON.parse(await readFile(workspaceFile, 'utf8'));
const conversation = value => value.conversations.find(item => item.id === conversationId);
const message = (role, content) => page.locator(`article.fl-message.${role}`).filter({ hasText: content });
const dialog = () => page.getByRole('alertdialog', { name: /^(删除本轮问答？|Delete this exchange\?)$/ });
const deleteButton = row => row.getByRole('button', { name: /^(删除本轮问答|Delete this exchange)$/ });
const audit = () => app.evaluate(() => globalThis.__folioChatDeletionAudit);

async function seed() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([600, 760]).drawText('Chat deletion persistence fixture. No external paper or service is used.', { x: 35, y: 710, size: 11, font });
  pdfBytes = await pdf.save();
  const now = 1_790_000_000_000;
  const pair = (turnId, source, question, answer, offset) => [
    { id: `${turnId}-user`, turnId, role: 'user', content: question, createdAt: now + offset, ...(source ? { source } : {}) },
    { id: `${turnId}-assistant`, turnId, role: 'assistant', content: answer, createdAt: now + offset + 1, provider: 'fixture', model: 'local-fixture', ...(source ? { source } : {}) },
  ];
  const memory = (id, source, sourceTurnIds, body) => ({
    id, source, type: source === 'user' ? 'user-note' : 'finding', title: id, body, tags: [], createdAt: now,
    ...(sourceTurnIds ? { sourceTurnIds } : {}),
  });
  fixture = {
    version: 1, id: workspaceId, title, authors: 'Folio test fixture', journal: '', doi: '', tags: [], favorite: false,
    createdAt: now, updatedAt: now, lastReadAt: now,
    documents: [{ id: documentId, name: 'Fixture paper.pdf', fileName: 'fixture.pdf', role: 'main', size: pdfBytes.length,
      pageCount: 1, outline: [], outlineLoaded: true, annotations: [], textStatus: 'ready',
      view: { page: 1, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0 } }],
    notes: '## Personal notes\n\nKeep my own note, even this copied phrase: First voice answer stays until confirmed.\n',
    summary: { content: 'Summary derived from the first voice exchange.', provider: 'fixture', model: 'local-fixture', createdAt: now, sourceTurnId: 'voice-one' },
    memories: [
      memory('voice-one-memory', 'ai', ['voice-one'], 'First voice derived finding.'),
      memory('voice-two-memory', 'ai', ['voice-two'], 'Second voice derived finding.'),
      memory('shared-voice-memory', 'ai', ['voice-one', 'voice-two'], 'Finding derived from both voice exchanges.'),
      memory('typed-memory', 'ai', ['typed-one'], 'Typed exchange finding must remain.'),
      memory('manual-memory', 'user', undefined, 'My manually written reading memory must remain.'),
    ],
    memoryIndex: 'First voice derived finding.\nSecond voice derived finding.\nFinding derived from both voice exchanges.\nTyped exchange finding must remain.\nMy manually written reading memory must remain.',
    conversations: [
      { id: conversationId, title: 'Fixture conversation', createdAt: now, messages: [
        ...pair('voice-one', 'voice', 'First voice question for deletion.', 'First voice answer stays until confirmed.', 10),
        ...pair('voice-two', 'voice', 'Second voice question for deletion.', 'Second voice answer stays until its turn is deleted.', 20),
        ...pair('typed-one', undefined, 'Typed question must remain.', 'Typed answer must remain.', 30),
      ] },
      { id: 'other-conversation', title: 'Unrelated conversation', createdAt: now, messages:
        pair('other-turn', undefined, 'Another conversation question.', 'Another conversation answer.', 40) },
    ],
    activeConversationId: conversationId,
    layout: { split: false, leftId: documentId, rightId: '', ratio: 50 },
  };
  await mkdir(path.join(directory, '.text'), { recursive: true });
  await writeFile(path.join(directory, 'fixture.pdf'), pdfBytes);
  await writeFile(path.join(directory, '.text', `${documentId}.json`), JSON.stringify(['Chat deletion persistence fixture.']));
  await writeFile(workspaceFile, JSON.stringify(fixture, null, 2));
  // No API key/encrypted key is present, so settings never access the keychain.
  await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ language: 'zh-CN', autoCheckUpdates: false, autoSummary: false, autoMemory: true, providers: {} }));
}

async function launch() {
  app = await electron.launch({ args: executablePath ? [] : ['.'], ...(executablePath ? { executablePath } : {}), env });
  page = await app.firstWindow();
  page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 1000);
    const calls = globalThis.__folioChatDeletionAudit = { deletions: [], forbidden: [] };
    const deletion = ipcMain._invokeHandlers.get('folio:delete-chat-turn');
    if (!deletion) throw new Error('The real delete-chat-turn IPC handler is missing. Build the current app before testing.');
    ipcMain.removeHandler('folio:delete-chat-turn');
    ipcMain.handle('folio:delete-chat-turn', (event, ...args) => {
      calls.deletions.push(args);
      return deletion(event, ...args);
    });
    for (const name of ['start-chat', 'voice-capabilities', 'voice-listen', 'voice-speak']) {
      ipcMain.removeHandler('folio:' + name);
      ipcMain.handle('folio:' + name, () => {
        calls.forbidden.push(name);
        throw new Error('Chat deletion must not start AI or speech: ' + name);
      });
    }
  });
  const bootstrap = await state();
  assert.equal(bootstrap.settings.libraryPath, path.join(userData, 'Library'));
  assert(Object.values(bootstrap.settings.providers).every(provider => !provider.hasKey && !provider.apiKey));
  assert.equal(bootstrap.workspaces.length, 1, 'only the isolated fixture must be loaded');
}

async function openPaper() {
  const language = (await state()).settings.language;
  await page.getByRole('button', { name: `${language === 'en' ? 'Open' : '打开'} ${title}`, exact: true }).click();
  await page.locator('.pdf-pane .textLayer span').first().waitFor();
  const toggle = page.getByRole('button', { name: /^(阅读伙伴|Reading companion)$/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('tab', { name: /^(对话|Chat)$/, exact: true }).click();
  await message('assistant', 'Typed answer must remain.').waitFor();
}

function assertRetained(value, removed) {
  const expectedMessages = conversation(fixture).messages.filter(item => !removed.includes(item.turnId));
  assert.deepEqual(conversation(value).messages, expectedMessages);
  assert.equal(value.notes, fixture.notes);
  assert.deepEqual(value.conversations.find(item => item.id === 'other-conversation'), fixture.conversations[1]);
  const expectedMemories = fixture.memories.filter(item => item.source === 'user' || !item.sourceTurnIds?.some(id => removed.includes(id)));
  assert.deepEqual(value.memories, expectedMemories);
  if (removed.includes('voice-one')) {
    assert.equal(value.summary, undefined);
    assert(!value.memoryIndex.includes('First voice derived finding.'));
    assert(!value.memoryIndex.includes('Finding derived from both voice exchanges.'));
  } else assert.deepEqual(value.summary, fixture.summary);
  if (removed.includes('voice-two')) assert(!value.memoryIndex.includes('Second voice derived finding.'));
}

async function waitDeleted(removed) {
  await waitFor(async () => {
    const current = await workspace();
    return removed.every(turnId => !conversation(current).messages.some(item => item.turnId === turnId));
  }, 'deleted exchanges leave the real workspace');
  assertRetained(await workspace(), removed);
  await waitFor(async () => {
    try { assertRetained(await diskWorkspace(), removed); return true; } catch { return false; }
  }, 'deletion and derived-memory cleanup persist to workspace.json');
}

async function close() {
  if (!app) return;
  ipcAudit.push(await audit());
  const current = app;
  await current.close();
  app = undefined; page = undefined;
}

try {
  await seed(); await launch(); await openPaper();
  assertRetained(await workspace(), []);
  assert.equal(await page.locator('article.fl-message').count(), 6);
  assert.equal(await page.getByRole('button', { name: '删除本轮问答', exact: true }).count(), 6);

  await deleteButton(message('assistant', 'First voice answer stays until confirmed.')).click();
  await dialog().waitFor();
  assert.equal(await dialog().getAttribute('aria-label'), '删除本轮问答？');
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await dialog().waitFor({ state: 'detached' });
  assertRetained(await workspace(), []); assertRetained(await diskWorkspace(), []);
  assert.equal((await audit()).deletions.length, 0);
  pass('Chinese confirmation can be cancelled without deleting any message, memory, summary, or notes');

  await deleteButton(message('assistant', 'First voice answer stays until confirmed.')).click();
  await dialog().getByRole('button', { name: '删除问答', exact: true }).click();
  await page.getByText('本轮问答已删除', { exact: true }).waitFor();
  await waitDeleted(['voice-one']);
  assert.equal(await message('user', 'First voice question for deletion.').count(), 0);
  assert.equal(await message('assistant', 'First voice answer stays until confirmed.').count(), 0);
  assert.equal(await page.locator('article.fl-message').count(), 4);
  assert.deepEqual((await audit()).deletions, [[workspaceId, conversationId, 'voice-one-assistant']]);
  await page.screenshot({ path: path.join(output, 'deleted-first-exchange-zh.png') });
  pass('Deleting from an assistant message removes its complete exchange and linked AI memory/summary through real IPC');

  await page.getByRole('button', { name: /^(设置与连接|Settings)/ }).first().click();
  await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
  await page.getByRole('button', { name: /^(保存设置|Save settings)$/, exact: true }).click();
  await waitFor(async () => (await state()).settings.language === 'en' && await page.locator('html').getAttribute('lang') === 'en', 'English interface');
  await page.locator('.fl-settings-footer').getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Delete this exchange', exact: true }).count(), 4);
  await deleteButton(message('user', 'Second voice question for deletion.')).click();
  await dialog().waitFor();
  assert.equal(await dialog().getAttribute('aria-label'), 'Delete this exchange?');
  assert.equal(await dialog().getByRole('button', { name: 'Cancel', exact: true }).isVisible(), true);
  await dialog().getByRole('button', { name: 'Delete exchange', exact: true }).click();
  await page.getByText('Exchange deleted', { exact: true }).waitFor();
  await waitDeleted(['voice-one', 'voice-two']);
  assert.equal(await page.locator('article.fl-message').count(), 2);
  assert.deepEqual((await audit()).deletions, [
    [workspaceId, conversationId, 'voice-one-assistant'],
    [workspaceId, conversationId, 'voice-two-user'],
  ]);
  await page.screenshot({ path: path.join(output, 'deleted-second-exchange-en.png') });
  pass('The English user-message action deletes the matching answer while retaining typed chat, manual memory, notes, and other conversations');

  await page.reload(); await openPaper();
  assertRetained(await workspace(), ['voice-one', 'voice-two']);
  assert.equal(await page.locator('article.fl-message').count(), 2);
  pass('Renderer reload keeps both deleted exchanges absent');

  await close(); await launch(); await openPaper();
  assertRetained(await workspace(), ['voice-one', 'voice-two']);
  assertRetained(await diskWorkspace(), ['voice-one', 'voice-two']);
  assert.equal(await page.locator('article.fl-message').count(), 2);
  assert.deepEqual(await readFile(path.join(directory, 'fixture.pdf')), Buffer.from(pdfBytes));
  assert.deepEqual((await audit()).deletions, []);
  pass('A complete app restart reloads the persisted deletion and preserves the original PDF');

  await close();
  assert(ipcAudit.every(run => run.forbidden.length === 0));
  assert.deepEqual(errors, []);
  pass('Deletion never starts AI, voice discovery, microphone capture, or read-aloud');
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  try { await close(); }
  finally {
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, ipcAudit, realDeletionIPC: true, nativeAudioUsed: false, realAIUsed: false }, null, 2));
    await rm(userData, { recursive: true, force: true });
  }
}
