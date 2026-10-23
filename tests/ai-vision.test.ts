import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createAIService, type AIHost } from '../electron/ai';
import { previousImageTurn, recallHistoryImages } from '../electron/vision-request';
import { validateDraftChatImages, type DraftChatImage, type StoredChatImage } from '../shared/images';
import type { ChatEvent, ChatRequest, ProviderConfig, Settings, Workspace } from '../shared/types';
import { imageDraft, syntheticPNG } from './image-fixtures';

function answer(text = 'The visible figure supports this statement. [Main.pdf p.1]') {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function fixture() {
  const provider: ProviderConfig = { id: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'vision-fixture-key', maxTokens: 4096 };
  const settings: Settings = { language: 'en', autoCheckUpdates: false, activeProvider: 'deepseek', providers: { deepseek: provider, openai: { ...provider, id: 'openai' }, anthropic: { ...provider, id: 'anthropic' }, custom: { ...provider, id: 'custom' }, qoder: { ...provider, id: 'qoder', baseURL: 'http://127.0.0.1:8788/v1', model: 'kmodel_latest' } },
    libraryPath: '/unused', vaultPath: '', obsidianSubfolder: '', autoSummary: false, autoMemory: false, contextMaxChars: 12000, theme: 'light', readingTheme: 'white', annotationToolbar: 'floating' };
  const workspace: Workspace = { version: 1, id: 'paper', title: 'Paper', authors: '', journal: '', doi: '', tags: [], favorite: false, createdAt: 1, updatedAt: 1, lastReadAt: 1,
    notes: '', memories: [], memoryIndex: '', activeConversationId: 'conversation', conversations: [{ id: 'conversation', title: 'Questions', createdAt: 1, messages: [] }],
    documents: [{ id: 'main', name: 'Main.pdf', fileName: 'Main.pdf', role: 'main', size: 1, pageCount: 1, textStatus: 'ready', outline: [], outlineLoaded: true, annotations: [], view: { page: 1, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0 } }],
    layout: { split: false, leftId: 'main', rightId: '', ratio: 50 } };
  const files = new Map<string, string>(), events: ChatEvent[] = [], discarded: string[] = [];
  let end!: (event: ChatEvent) => void, terminal = new Promise<ChatEvent>(resolve => { end = resolve; });
  const host: AIHost = { getSettings: () => settings, getWorkspace: () => structuredClone(workspace), listWorkspaces: () => [structuredClone(workspace)],
    getDocumentPages: async () => ['Extracted paper text.'],
    mutateWorkspace: async (_id, mutate) => { mutate(workspace); return structuredClone(workspace); },
    emit: event => { events.push(event); if (event.type === 'done' || event.type === 'error') end(event); },
    saveChatImages: async (_id, images) => validateDraftChatImages(images).map(image => {
      const stored: StoredChatImage = { id: randomUUID(), name: image.name, mimeType: image.mimeType, width: image.width, height: image.height, byteSize: image.byteSize, ...(image.source ? { source: image.source } : {}) };
      files.set(stored.id, image.dataUrl); return stored;
    }),
    readChatImage: async (_id, id) => { const data = files.get(id); if (!data) throw new Error('Missing private attachment'); return data; },
    discardChatImages: async (_id, ids) => { for (const id of ids) if (!workspace.conversations.some(conversation => conversation.messages.some(message => message.images?.some(image => image.id === id)))) { files.delete(id); discarded.push(id); } },
  };
  const service = createAIService(host);
  const request: ChatRequest = { requestId: 'request-1', workspaceId: 'paper', conversationId: 'conversation', kind: 'chat', documentIds: ['main'], prompt: 'Explain this figure.' };
  const next = () => { terminal = new Promise(resolve => { end = resolve; }); };
  return { settings, workspace, host, service, request, files, events, discarded, terminal: () => terminal, next };
}
const sourcedImage = (): DraftChatImage => ({ ...imageDraft(), source: { documentId: 'main', documentName: 'Spoofed.pdf', page: 1, rect: [0, 0, 30, 40] } });

test('an unindexed scan with an explicit image sends real pixels and persists only canonical attachment metadata', async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  h.workspace.documents[0].textStatus = undefined; h.host.getDocumentPages = async () => [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), last = body.messages.at(-1);
    assert.ok(Array.isArray(last.content)); assert.equal(last.content[1].image_url.url, sourcedImage().dataUrl);
    assert.match(last.content[0].text, /Main.pdf p.1/); assert.doesNotMatch(last.content[0].text, /Spoofed/);
    assert.match(body.messages[0].content, /Actual images|selected region/);
    assert.match(body.messages[1].content, /No readable PDF text/); return answer();
  });
  await h.service.start({ ...h.request, images: [sourcedImage()] }); assert.equal((await h.terminal()).type, 'done'); await h.service.drain();
  const messages = h.workspace.conversations[0].messages;
  assert.equal(messages[0].images?.length, 1); assert.equal(messages[0].images?.[0].source?.documentName, 'Main.pdf');
  assert.equal(messages[0].turnId, messages[1].turnId); assert.equal(h.files.size, 1);
  assert.doesNotMatch(JSON.stringify(h.workspace), /data:image|iVBOR/); assert.doesNotMatch(JSON.stringify(h.events), /data:image|iVBOR/);
  assert.match(messages[1].content, /not a visual reading of every PDF page/);
});

test('image-only chat receives an explicit default question and a scan never claims complete deep reading', async t => {
  const h = fixture(); t.after(() => h.service.dispose()); h.workspace.documents[0].textStatus = 'empty'; h.host.getDocumentPages = async () => [''];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); assert.match(body.messages.at(-1).content.at(-1).text, /Explain the attached figure or page/); return answer();
  });
  await h.service.start({ ...h.request, prompt: '', readingMode: 'deep', images: [imageDraft()] });
  assert.equal((await h.terminal()).type, 'done'); await h.service.drain();
  assert.equal(h.workspace.conversations[0].messages[1].reading?.complete, false);
  assert.ok(!h.events.some(event => event.text?.includes('Full reading complete')));
});

test('unsupported models and invalid image sources reject before storing files or writing a user turn', async t => {
  const h = fixture(); t.after(() => h.service.dispose()); let saves = 0;
  h.host.saveChatImages = async () => { saves++; return []; };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network'); });
  h.settings.providers.deepseek.model = 'deepseek-reasoner';
  await assert.rejects(h.service.start({ ...h.request, images: [imageDraft()] }), /does not support/);
  h.settings.providers.deepseek.model = 'deepseek-flash';
  await assert.rejects(h.service.start({ ...h.request, images: [{ ...sourcedImage(), source: { documentId: 'outside', documentName: 'Outside.pdf', page: 1 } }] }), /outside/);
  await assert.rejects(h.service.start({ ...h.request, images: Array.from({ length: 5 }, () => imageDraft()) }), /4/);
  assert.equal(saves, 0); assert.equal(h.workspace.conversations[0].messages.length, 0);
});

test('recent images are loaded for follow-ups only in the current conversation and sent only on the final user message', async t => {
  const h = fixture(); t.after(() => h.service.dispose()); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body));
    assert.equal(body.messages.filter((message: any) => Array.isArray(message.content)).length, 1);
    if (calls === 2) assert.match(body.messages.at(-1).content[0].text, /Earlier image/);
    return answer();
  });
  await h.service.start({ ...h.request, images: [sourcedImage()] }); await h.terminal(); await h.service.drain();
  h.next(); await h.service.start({ ...h.request, requestId: 'followup', prompt: 'What does the blue line mean?' });
  assert.equal((await h.terminal()).type, 'done'); await h.service.drain();
  assert.match(h.workspace.conversations[0].messages.at(-1)!.content, /were resent/); assert.equal(h.files.size, 1);
  h.workspace.conversations.push({ id: 'other', title: 'Other', createdAt: 1, messages: [] }); h.next();
  const replacement = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => { assert.ok(JSON.parse(String(init.body)).messages.every((message: any) => typeof message.content === 'string')); return answer(); });
  await h.service.start({ ...h.request, requestId: 'other-question', conversationId: 'other' }); assert.equal((await h.terminal()).type, 'done'); replacement.mock.restore();
});

test('switching to a text model keeps visible history and explicitly discloses that old images were not resent', async t => {
  const h = fixture(); t.after(() => h.service.dispose()); t.mock.method(globalThis, 'fetch', async () => answer());
  await h.service.start({ ...h.request, images: [imageDraft()] }); await h.terminal(); await h.service.drain();
  h.settings.providers.deepseek.model = 'deepseek-reasoner'; h.next();
  const replacement = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); assert.equal(body.model, 'deepseek-reasoner');
    assert.ok(body.messages.every((message: any) => typeof message.content === 'string'));
    assert.match(body.messages[1].content, /Earlier images were not resent/);
    assert.ok(body.messages.some((message: any) => message.role === 'assistant' && message.content.includes('visible figure'))); return answer('A text-only follow-up.');
  });
  await h.service.start({ ...h.request, requestId: 'text-followup' }); assert.equal((await h.terminal()).type, 'done');
  assert.match(h.workspace.conversations[0].messages.at(-1)!.content, /Earlier images were not resent/); replacement.mock.restore();
});

test('missing historical bytes and count-limited comparisons produce visible omission warnings', async t => {
  for (const scenario of ['missing', 'full-budget'] as const) {
    const h = fixture(); t.after(() => h.service.dispose()); const mock = t.mock.method(globalThis, 'fetch', async () => answer());
    await h.service.start({ ...h.request, images: [imageDraft()] }); await h.terminal(); await h.service.drain(); h.next();
    if (scenario === 'missing') h.files.clear();
    await h.service.start({ ...h.request, requestId: scenario, prompt: 'Compare with the previous image.', ...(scenario === 'full-budget' ? { images: Array.from({ length: 4 }, () => imageDraft()) } : {}) });
    assert.equal((await h.terminal()).type, 'done');
    assert.match(h.workspace.conversations[0].messages.at(-1)!.content, scenario === 'missing' ? /missing or unreadable/ : /omitted due to this request’s image limits/);
    mock.mock.restore();
  }
});

test('historical byte budget is checked before reading an oversized extra image', async () => {
  const h = fixture(); const current = [imageDraft(syntheticPNG(1, 1, 3 * 1024 * 1024)), imageDraft(syntheticPNG(1, 1, 3 * 1024 * 1024))];
  let reads = 0;
  const result = await recallHistoryImages({ candidates: [{ id: randomUUID(), name: 'Earlier large image', mimeType: 'image/png', width: 2048, height: 2048, byteSize: 4 * 1024 * 1024 }],
    current, config: h.settings.providers.deepseek, language: 'en', signal: new AbortController().signal, read: async () => { reads++; return imageDraft().dataUrl; } });
  assert.equal(reads, 0); assert.equal(result.images.length, 0); assert.match(result.warnings.join(' '), /omitted/); await h.service.dispose();
});

test('cancellation while image saving is pending removes unreferenced files and never starts a model request', async t => {
  const h = fixture(); t.after(() => h.service.dispose()); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const save = h.host.saveChatImages!; h.host.saveChatImages = async (id, images) => { const stored = await save(id, images); entered(); await gate; return stored; };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No request expected'); });
  await h.service.start({ ...h.request, images: [imageDraft()] }); await started;
  h.service.abort(h.request.requestId); release(); assert.equal((await h.terminal()).interrupted, true); await h.service.drain();
  assert.equal(h.files.size, 0); assert.equal(h.discarded.length, 1); assert.equal(h.workspace.conversations[0].messages.length, 0);
});

test('failed user-turn persistence cleans pending images, while stream cancellation retains referenced attachments', async t => {
  const failed = fixture(); t.after(() => failed.service.dispose()); failed.host.mutateWorkspace = async () => { throw Error('Fixture disk failure'); };
  await failed.service.start({ ...failed.request, images: [imageDraft()] }); assert.equal((await failed.terminal()).type, 'error'); await failed.service.drain();
  assert.equal(failed.files.size, 0); assert.equal(failed.discarded.length, 1);
  const h = fixture(); t.after(() => h.service.dispose()); let deltaSeen!: () => void; const seen = new Promise<void>(resolve => { deltaSeen = resolve; });
  const emit = h.host.emit; h.host.emit = event => { emit(event); if (event.type === 'delta') deltaSeen(); };
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Partial visible interpretation.' } }] }) + '\n\n'));
    init.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
  } }), { headers: { 'content-type': 'text/event-stream' } }));
  await h.service.start({ ...h.request, images: [imageDraft()] }); await seen; h.service.abort(h.request.requestId);
  assert.equal((await h.terminal()).interrupted, true); await h.service.drain();
  assert.equal(h.files.size, 1); assert.equal(h.workspace.conversations[0].messages[1].interrupted, true);
});

test('images never enter native web search or memory extraction requests', async t => {
  const h = fixture(); t.after(() => h.service.dispose()); h.settings.autoMemory = true;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body));
    if (String(url).endsWith('/anthropic/v1/messages')) { assert.doesNotMatch(String(init.body), /data:image|iVBOR/); return new Response(JSON.stringify({ content: [{ type: 'web_search_tool_result', content: [] }] })); }
    if (calls === 2) { assert.ok(Array.isArray(body.messages.at(-1).content)); return answer(); }
    assert.doesNotMatch(String(init.body), /data:image|iVBOR/); return answer('[]');
  });
  await h.service.start({ ...h.request, images: [imageDraft()], webSearch: true }); assert.equal((await h.terminal()).type, 'done');
  assert.equal(calls, 3);
});

test('full-paper batch reading receives text only and images are attached once to the final synthesis', async t => {
  const h = fixture(); t.after(() => h.service.dispose()); h.workspace.documents[0].pageCount = 20;
  h.host.getDocumentPages = async () => Array.from({ length: 20 }, (_, index) => `Page ${index + 1}. Experimental methods and evidence. `.repeat(80));
  let imageCalls = 0, textCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (Array.isArray(body.messages.at(-1).content)) { imageCalls++; return answer(); }
    textCalls++; assert.doesNotMatch(String(init.body), /data:image|iVBOR/); return answer('Evidence notes from the supplied pages, with limited detail.');
  });
  await h.service.start({ ...h.request, images: [imageDraft()], readingMode: 'deep' });
  assert.equal((await h.terminal()).type, 'done'); assert.equal(imageCalls, 1); assert.ok(textCalls > 1);
});

test('Kimi visible-history conversion preserves actual prior image bytes without replaying incomplete assistant thinking', async t => {
  const h = fixture(); t.after(() => h.service.dispose()); h.settings.activeProvider = 'custom';
  h.settings.providers.custom = { ...h.settings.providers.custom, baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k3' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body)); assert.equal(body.model, 'kimi-k3');
    assert.ok(body.messages.every((message: any) => message.role !== 'assistant'));
    if (calls === 2) assert.ok(body.messages.some((message: any) => typeof message.content === 'string' && message.content.includes('<visible_conversation_history>')));
    assert.equal(body.messages.at(-1).content[1].image_url.url, imageDraft().dataUrl); return answer();
  });
  await h.service.start({ ...h.request, images: [imageDraft()] }); await h.terminal(); await h.service.drain(); h.next();
  await h.service.start({ ...h.request, requestId: 'kimi-followup' }); assert.equal((await h.terminal()).type, 'done'); assert.equal(calls, 2);
});

test('interrupted turns and an explicit topic reset never recall their images', () => {
  const metadata: StoredChatImage = { id: randomUUID(), name: 'Cancelled attachment', mimeType: 'image/png', width: 8, height: 6, byteSize: 100 };
  const interrupted = [
    { id: 'u', role: 'user' as const, content: 'Figure question', createdAt: 1, turnId: 'cancelled', images: [metadata] },
    { id: 'a', role: 'assistant' as const, content: 'Partial', createdAt: 2, turnId: 'cancelled', interrupted: true },
  ];
  assert.deepEqual(previousImageTurn(interrupted, 'Explain that figure again.', 0), []);
  assert.deepEqual(previousImageTurn(interrupted.slice(0, 1), 'new topic: explain graph theory', 0), []);
});

test('summary and voice do not implicitly resend previous chat pictures', async t => {
  const h = fixture(); t.after(() => h.service.dispose());
  const stored = await h.host.saveChatImages!('paper', [imageDraft()]);
  h.workspace.conversations[0].messages.push({ id: 'old-user', role: 'user', content: 'Explain that image.', createdAt: 1, images: stored });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => { assert.doesNotMatch(String(init.body), /data:image|iVBOR/); return answer(); });
  await h.service.start({ ...h.request, kind: 'summary' }); assert.equal((await h.terminal()).type, 'done'); await h.service.drain(); h.next();
  await h.service.start({ ...h.request, requestId: 'voice', source: 'voice' }); assert.equal((await h.terminal()).type, 'done');
});
