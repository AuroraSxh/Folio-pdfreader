import assert from 'node:assert/strict';
import test from 'node:test';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createAIService, streamCompletion, type AIHost } from '../electron/ai';
import { smartReading } from '../electron/reading-pipeline';
import { QODER_MODELS, qoderReasoningFields } from '../shared/qoder';
import { validateDraftChatImages } from '../shared/images';
import type { ChatEvent, ChatRequest, ProviderConfig, Settings, Workspace } from '../shared/types';
import { imageDraft } from './image-fixtures';

const source = 'https://example.org/verified-publication';
const evidence = () => ({ enabled: true, maxCalls: 8, successfulSearches: 1, successfulFetches: 1, calls: [
  { id: 'search-1', name: 'WebSearch', status: 'success', query: 'Synthetic evidence query', resultCount: 1, sources: [source] },
  { id: 'fetch-1', name: 'WebFetch', status: 'success', url: source, statusCode: 200, contentKind: 'sdk_extracted_or_summarized_page', summary: 'Synthetic SDK extraction. This is not verbatim webpage text.', sources: [source] },
], sources: [{ url: source, title: 'Verified publication', snippet: 'Synthetic search result snippet.' }] });
function answer(res: ServerResponse, text = 'Synthetic visible answer.', web?: unknown, model = 'kmodel_latest') {
  const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(frame({ model, choices: [{ index: 0, delta: { reasoning_content: 'Hidden reasoning must not be shown.', content: text }, finish_reason: null }] })
    + frame({ model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(web === undefined ? {} : { qoder_web: web }) }) + 'data: [DONE]\n\n');
}
async function endpoint(t: test.TestContext, handler: (body: any, res: ServerResponse, req: IncomingMessage) => void) {
  const errors: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    try { let text = ''; for await (const chunk of req) text += chunk.toString(); handler(JSON.parse(text), res, req); }
    catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.deepEqual(errors, []); });
  return `http://127.0.0.1:${address.port}/v1`;
}
function fixture(baseURL: string, unindexed = false) {
  const config: ProviderConfig = { id: 'qoder', baseURL, model: 'kmodel_latest', apiKey: 'synthetic-selected-model-key', maxTokens: 4096, reasoningEffort: 'max' };
  const settings: Settings = { language: 'en', autoCheckUpdates: false, activeProvider: 'qoder', providers: { qoder: config,
    deepseek: { ...config, id: 'deepseek' }, openai: { ...config, id: 'openai' }, anthropic: { ...config, id: 'anthropic' }, custom: { ...config, id: 'custom' } },
    libraryPath: '/synthetic-library', vaultPath: '', obsidianSubfolder: 'Papers', autoSummary: false, autoMemory: false,
    contextMaxChars: 12000, theme: 'light', readingTheme: 'white', annotationToolbar: 'floating' };
  const workspace: Workspace = { version: 1, id: 'qoder-test-paper', title: 'Synthetic paper', authors: '', journal: '', doi: '', tags: [], favorite: false,
    createdAt: 1, updatedAt: 1, lastReadAt: 1, notes: '', memories: [], memoryIndex: '', activeConversationId: 'conversation',
    conversations: [{ id: 'conversation', title: 'Synthetic discussion', createdAt: 1, messages: [] }],
    documents: [{ id: 'main', name: 'Main.pdf', fileName: 'Main.pdf', role: 'main', size: 1, pageCount: 1, textStatus: unindexed ? undefined : 'ready', outline: [], outlineLoaded: true, annotations: [], view: { page: 1, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0 } }],
    layout: { split: false, leftId: 'main', rightId: '', ratio: 50 } };
  const events: ChatEvent[] = [];
  let finish!: (event: ChatEvent) => void;
  const terminal = new Promise<ChatEvent>(resolve => { finish = resolve; });
  const host: AIHost = { getSettings: () => settings, getWorkspace: () => structuredClone(workspace), listWorkspaces: () => [structuredClone(workspace)],
    getDocumentPages: async () => unindexed ? [] : ['PAPER_EVIDENCE: The synthetic experiment measures cell activation.'],
    mutateWorkspace: async (_id, mutate) => { mutate(workspace); return structuredClone(workspace); },
    saveChatImages: async (_id, images) => validateDraftChatImages(images, workspace.documents).map((image, index) => ({ id: 'synthetic-image-' + index, name: image.name,
      mimeType: image.mimeType, width: image.width, height: image.height, byteSize: image.byteSize, ...(image.source ? { source: image.source } : {}) })),
    emit: event => { events.push(event); if (event.type === 'done' || event.type === 'error') finish(event); },
  };
  const request: ChatRequest = { requestId: 'qoder-request', workspaceId: workspace.id, conversationId: 'conversation', kind: 'chat', documentIds: ['main'], prompt: 'What is the current status of this experiment?' };
  return { config, settings, workspace, events, terminal, request, service: createAIService(host) };
}

test('all 14 Qoder aliases use the selected key, protocol and advertised thinking; vision-capable aliases send actual image blocks', async t => {
  const bodies: any[] = [], requests: IncomingMessage[] = [];
  const baseURL = await endpoint(t, (body, res, req) => { bodies.push(body); requests.push(req); answer(res, undefined, undefined, body.model); });
  for (const model of QODER_MODELS) {
    let visible = '';
    const config: ProviderConfig = { id: 'qoder', baseURL, model: model.id, apiKey: 'synthetic-key-for-' + model.id, maxTokens: 4096 };
    const image = imageDraft();
    const result = await streamCompletion(config, [{ role: 'user', content: 'Explain the synthetic input.', ...(model.vision ? { images: [image] } : {}) }], new AbortController().signal, text => { visible += text; });
    assert.equal(result.text, 'Synthetic visible answer.'); assert.equal(visible, result.text);
    const body = bodies.at(-1), req = requests.at(-1)!;
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer synthetic-key-for-' + model.id);
    assert.equal(body.model, model.id); assert.equal(body.max_tokens, 4096); assert.equal(body.stream, true);
    for (const [name, value] of Object.entries(qoderReasoningFields(config))) assert.deepEqual(body[name], value);
    for (const name of ['temperature', 'top_p', 'tools', 'web_search', 'web_fetch']) assert.equal(body[name], undefined);
    if (model.vision) assert.equal(body.messages[0].content[1].image_url.url, image.dataUrl);
    else assert.equal(body.messages[0].content, 'Explain the synthetic input.');
  }
  assert.equal(bodies.length, 14);
});

for (const unindexed of [false, true]) test(`Qoder web uses one answering request, preserves paper/image context and saves actual source evidence (unindexed=${unindexed})`, async t => {
  let calls = 0;
  const baseURL = await endpoint(t, (body, res, req) => {
    calls++; assert.equal(req.headers.authorization, 'Bearer synthetic-selected-model-key');
    assert.equal(body.model, 'kmodel_latest'); assert.equal(body.reasoning_effort, 'max');
    assert.equal(body.web_search, 'required'); assert.equal(body.web_fetch, 'required');
    assert.match(body.messages[0].content, /Actually use WebSearch and WebFetch/);
    assert.match(body.messages[0].content, /not verbatim webpage excerpts/);
    if (!unindexed) assert.match(body.messages[1].content, /PAPER_EVIDENCE/);
    else assert.match(body.messages[1].content, /No readable PDF text/);
    assert.equal(body.messages.at(-1).content[1].image_url.url, imageDraft().dataUrl);
    assert.match(body.messages.at(-1).content.at(-1).text, /current status/);
    answer(res, `A supported claim. [publication](${source})`, evidence());
  });
  const h = fixture(baseURL, unindexed); t.after(() => h.service.dispose());
  await h.service.start({ ...h.request, webSearch: true, images: [{ ...imageDraft(), source: { documentId: 'main', documentName: 'Spoofed.pdf', page: 1 } }] });
  assert.equal((await h.terminal).type, 'done'); await h.service.drain(); assert.equal(calls, 1);
  const reply = h.workspace.conversations[0].messages[1];
  assert.equal(reply.provider, 'qoder'); assert.equal(reply.model, 'kmodel_latest'); assert.equal(reply.webSearch?.sources[0].url, source);
  assert.equal(reply.webSearch?.qoderEvidence?.successfulSearches, 1); assert.equal(reply.webSearch?.qoderEvidence?.successfulFetches, 1);
  assert.match(reply.webSearch?.summary ?? '', /not verbatim page text/); assert.ok(h.events.some(event => event.webSearch?.sources.length === 1));
  assert.equal(h.workspace.conversations[0].messages[0].images?.[0].source?.documentName, 'Main.pdf');
  assert.doesNotMatch(JSON.stringify(h.workspace), /data:image|synthetic-selected-model-key|Hidden reasoning/);
});

test('Qoder web can answer an outside-paper question without indexed text or an image', async t => {
  let calls = 0;
  const baseURL = await endpoint(t, (body, res) => { calls++; assert.equal(body.web_search, 'required'); answer(res, `External answer. [source](${source})`, evidence()); });
  const h = fixture(baseURL, true); t.after(() => h.service.dispose());
  await h.service.start({ ...h.request, webSearch: true }); assert.equal((await h.terminal).type, 'done'); assert.equal(calls, 1);
  assert.equal(h.workspace.conversations[0].messages[1].webSearch?.sources.length, 1);
});

test('native web stays on each of the 14 selected Qoder aliases and its dedicated credential', async t => {
  const used: string[] = [];
  const baseURL = await endpoint(t, (body, res, req) => {
    used.push(body.model); assert.equal(req.headers.authorization, 'Bearer synthetic-web-' + body.model);
    assert.equal(body.web_search, 'required'); assert.equal(body.web_fetch, 'required');
    answer(res, 'Synthetic evidence-backed answer.', evidence(), body.model);
  });
  for (const model of QODER_MODELS) {
    const h = fixture(baseURL, true); t.after(() => h.service.dispose());
    Object.assign(h.config, { model: model.id, reasoningEffort: model.defaultEffort, apiKey: 'synthetic-web-' + model.id });
    await h.service.start({ ...h.request, webSearch: true }); assert.equal((await h.terminal).type, 'done');
    assert.equal(h.workspace.conversations[0].messages[1].model, model.id);
    assert.equal(h.workspace.conversations[0].messages[1].webSearch?.qoderEvidence?.successfulFetches, 1);
  }
  assert.deepEqual(used, QODER_MODELS.map(model => model.id));
});

test('failed Qoder search evidence keeps only an interrupted partial answer, without a second unsearched answer or trusted citations', async t => {
  let calls = 0;
  const baseURL = await endpoint(t, (_body, res) => { calls++; answer(res, 'Unverified partial text.', { ...evidence(), successfulFetches: 0 }); });
  const h = fixture(baseURL); t.after(() => h.service.dispose());
  await h.service.start({ ...h.request, webSearch: true });
  assert.equal((await h.terminal).type, 'error'); assert.equal(calls, 1);
  const reply = h.workspace.conversations[0].messages[1];
  assert.equal(reply.interrupted, true); assert.equal(reply.webSearch, undefined);
  assert.ok(!h.events.some(event => event.webSearch));
});

test('MiniMax image input, invalid Qoder effort and an external endpoint reject before history or network changes', async t => {
  let calls = 0;
  const baseURL = await endpoint(t, (_body, res) => { calls++; answer(res); });
  const h = fixture(baseURL); t.after(() => h.service.dispose());
  h.config.model = 'mmodel'; h.config.reasoningEffort = undefined;
  await assert.rejects(h.service.start({ ...h.request, images: [imageDraft()] }), /does not enable image/);
  h.config.model = 'qmodel_38max'; h.config.reasoningEffort = 'max';
  await assert.rejects(h.service.start(h.request), /does not support/);
  h.config.reasoningEffort = 'xhigh'; h.config.baseURL = 'https://outside.example/v1';
  await assert.rejects(h.service.start(h.request), /loopback/);
  assert.equal(calls, 0); assert.equal(h.workspace.conversations[0].messages.length, 0);
});

test('Qoder short-turn history obeys the bridge’s 100-message limit', async t => {
  let count = 0;
  const baseURL = await endpoint(t, (body, res) => { count = body.messages.length; assert.equal(body.messages[2].role, 'user'); answer(res); });
  const h = fixture(baseURL); t.after(() => h.service.dispose());
  for (let index = 0; index < 160; index++) h.workspace.conversations[0].messages.push({ id: 'prior-' + index, role: index % 2 ? 'assistant' : 'user', content: 'Short ' + index, createdAt: index });
  await h.service.start(h.request); assert.equal((await h.terminal).type, 'done');
  assert.ok(count > 80 && count <= 100);
  assert.match(h.workspace.conversations[0].messages.at(-1)!.content, /Only the latest/);
});

test('Qoder smart-reading query expansion keeps an allowed reasoning tier instead of forcing unsupported thinking off', async () => {
  const config: ProviderConfig = { id: 'qoder', baseURL: 'http://127.0.0.1:8788/v1', model: 'kmodel_latest', maxTokens: 4096, reasoningEffort: 'max' };
  const h = fixture(config.baseURL), documents = [{ id: 'main', name: 'Main.pdf', pages: Array.from({ length: 30 }, () => 'English experiment methods and cell activation analysis. '.repeat(60)) }];
  let rewrites = 0;
  await smartReading({ workspace: h.workspace, documents, config, language: 'zh-CN', prompt: '巨噬细胞的机制是什么？', maxChars: 3000,
    signal: new AbortController().signal, progress: () => {}, complete: async (c, messages) => {
      rewrites++; assert.equal(c.thinking, undefined); assert.deepEqual(qoderReasoningFields(c), { reasoning_effort: 'max' });
      assert.equal(c.maxTokens, 512); assert.doesNotMatch(JSON.stringify(messages), /English experiment methods/);
      return { text: '["macrophage", "mechanism"]', finishReason: 'stop' };
    } });
  assert.equal(rewrites, 1); await h.service.dispose();
});
