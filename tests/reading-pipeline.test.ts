import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { mock } from './mock-http-stream';
import { deepReading, readingBudget, smartReading } from '../electron/reading-pipeline';
import { createAIService, type AIHost } from '../electron/ai';
import { planDeepReading, type ReadingReport, type ReadingSource } from '../shared/reading';
import type { ChatEvent, ChatRequest, ProviderConfig, Settings, Workspace } from '../shared/types';

type Options = Parameters<typeof deepReading>[0];
const defaultView = { page: 1, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0 };
function workspace(sources: ReadingSource[] = []): Workspace {
  return { version: 1, id: 'reading-fixture', title: 'Synthetic research paper', authors: 'Fixture Author', journal: '', doi: '', tags: [], favorite: false,
    createdAt: 1, updatedAt: 1, lastReadAt: 1, notes: '', memories: [], memoryIndex: '',
    documents: sources.map((source, index) => ({ id: source.id, name: source.name, fileName: source.name,
      role: index ? 'supplement' : 'main', size: 100, pageCount: source.pageCount ?? source.pages.length,
      textStatus: 'ready', outline: [], outlineLoaded: true, annotations: [], view: { ...defaultView } })),
    conversations: [{ id: 'conversation', title: 'Reading', createdAt: 1, messages: [] }], activeConversationId: 'conversation',
    layout: { split: sources.length > 1, leftId: sources[0]?.id ?? '', rightId: sources[1]?.id ?? '', ratio: 50 } };
}
function config(baseURL = 'https://api.deepseek.com'): ProviderConfig {
  return { id: 'deepseek', apiKey: 'local-test-credential', baseURL, model: 'deepseek-flash', maxTokens: 4096, thinking: true, reasoningEffort: 'high' };
}
function settings(baseURL = 'https://api.deepseek.com'): Settings {
  const provider = config(baseURL);
  return { language: 'zh-CN', autoCheckUpdates: false, activeProvider: 'deepseek',
    providers: { deepseek: provider, openai: { ...provider, id: 'openai' }, anthropic: { ...provider, id: 'anthropic' }, custom: { ...provider, id: 'custom' } },
    libraryPath: '/tmp/reading-fixture', vaultPath: '', obsidianSubfolder: '', autoSummary: false, autoMemory: false,
    contextMaxChars: 12000, theme: 'light', readingTheme: 'white', annotationToolbar: 'floating' };
}
function options(documents: ReadingSource[], changes: Partial<Options> = {}): Options {
  return { workspace: workspace(documents), documents, config: config(), language: 'en', prompt: 'Explain the research.',
    maxChars: 6000, signal: new AbortController().signal, progress: () => {}, complete: async () => ({ text: 'Evidence note.', finishReason: 'stop' }), ...changes };
}
function longSources(): ReadingSource[] {
  return [
    { id: 'main', name: 'Main.pdf', role: 'main', pages: [
      'EVIDENCE_START\n' + 'The first experiment measured cell signaling. '.repeat(370) + '\nEVIDENCE_TAIL',
      'EVIDENCE_SECOND\n' + 'Independent validation supports the observed effect. '.repeat(45),
    ] },
    { id: 'sup', name: 'Supplement.pdf', role: 'supplement', pages: [
      'EVIDENCE_SUPPLEMENT\n' + 'Control groups were analyzed independently. '.repeat(80),
      '', 'EVIDENCE_LASTPAGE\nNegative controls did not show the same phenotype.',
    ] },
  ];
}

test('smart reading expands a Chinese question without sending PDF text and finds matching evidence on page 60', async () => {
  const sources: ReadingSource[] = [{ id: 'main', name: 'Main.pdf', pages: Array.from({ length: 60 }, (_, i) =>
    i === 59 ? 'TERMINAL_EVIDENCE: Macrophage exhaustion is reversed by checkpoint blockade. '.repeat(15)
      : `General laboratory methods section ${i + 1}. ` + 'The instruments were calibrated before measurement. '.repeat(30)) }];
  const question = '巨噬细胞耗竭能通过阻断检查点逆转吗？';
  let rewrites = 0;
  const result = await smartReading(options(sources, { prompt: question, language: 'zh-CN', maxChars: 4500,
    complete: async (provider, messages, _signal, _delta, timeout) => {
      rewrites++;
      assert.equal(provider.thinking, false); assert.equal(provider.maxTokens, 512); assert.equal(timeout, 30000);
      assert.equal(JSON.parse(messages[1].content).question, question);
      assert.ok(!JSON.stringify(messages).includes('TERMINAL_EVIDENCE'));
      assert.ok(!JSON.stringify(messages).includes('local-test-credential'));
      return { text: '["macrophage exhaustion", "checkpoint blockade", "reversed"]', finishReason: 'stop' };
    } }));
  assert.equal(rewrites, 1); assert.equal(result.strategy, 'retrieval'); assert.equal(result.report.mode, 'smart');
  assert.match(result.content, /TERMINAL_EVIDENCE/); assert.match(result.content, /\[Main\.pdf p\.60\]/);
  assert.ok(result.report.documents[0].includedPages.includes(60)); assert.equal(result.report.complete, false);
  assert.ok(result.content.length <= 4500);
});

test('query expansion failure falls back honestly without reflecting credentials or provider errors', async () => {
  const sources = [{ id: 'main', name: 'Main.pdf', pages: Array.from({ length: 8 }, () => 'An English scientific paragraph. '.repeat(110)) }];
  const result = await smartReading(options(sources, { prompt: '蛋白质结合的机制是什么？', language: 'zh-CN', maxChars: 2000,
    complete: async () => { throw new Error('Authorization local-test-credential rejected by private endpoint'); } }));
  assert.ok(result.hasText); assert.equal(result.strategy, 'overview');
  assert.match(result.warnings.join(' '), /跨语言/);
  assert.ok(!JSON.stringify(result).includes('local-test-credential'));
  assert.ok(!JSON.stringify(result).includes('private endpoint'));
});

test('a fitting paper goes directly into one final request and is not pre-emptively marked completed', async () => {
  let calls = 0;
  const result = await deepReading(options([{ id: 'main', name: 'Main.pdf', pages: ['A short but complete methods and results paragraph.'] }], {
    complete: async () => { calls++; return { text: 'Unexpected preprocessing' }; },
  }));
  assert.equal(calls, 0); assert.equal(result.strategy, 'full'); assert.equal(result.report.complete, false);
  assert.equal(result.report.batches, 1); assert.match(result.content, /complete methods and results/);
});

test('deep reading visits every batch including an overlong page tail and supplements, counting a split page only when all parts finish', async () => {
  const sources = longSources(), limit = 5000;
  const plan = planDeepReading(sources, limit, 'en');
  const inputs: string[] = [], progress: { report: ReadingReport; completed: number }[] = [];
  const result = await deepReading(options(sources, { maxChars: limit,
    complete: async (_config, messages) => {
      const text = messages.at(-1)!.content; inputs.push(text);
      return { text: (text.match(/EVIDENCE_[A-Z]+/g) ?? []).join(' ') || 'Batch methods reviewed.', finishReason: 'stop' };
    },
    progress: (_text, report, value) => { if (value.phase === 'reading') progress.push({ report: structuredClone(report), completed: value.completed }); },
  }));
  assert.deepEqual(inputs, plan.batches.map(batch => batch.content));
  assert.ok(inputs.every(text => text.length <= limit));
  for (const marker of ['START', 'TAIL', 'SECOND', 'SUPPLEMENT', 'LASTPAGE']) assert.match(result.content, new RegExp('EVIDENCE_' + marker));
  assert.deepEqual(result.report.documents.map(doc => [doc.documentId, doc.includedPages, doc.unavailablePages]), [
    ['main', [1, 2], []], ['sup', [1, 3], [2]],
  ]);
  assert.equal(result.report.complete, true); assert.equal(result.report.batches, plan.batches.length);
  const lastPart = plan.batches.findLastIndex(batch => batch.sources.some(source => source.documentId === 'main' && source.page === 1));
  assert.ok(lastPart > 0);
  for (const entry of progress) {
    const counted = entry.report.documents.find(doc => doc.documentId === 'main')!.includedPages.includes(1);
    assert.equal(counted, entry.completed > lastPart, 'A partial long page must not appear fully read');
  }
});

test('deep evidence cache reuses completed batches but respects model, source text and language changes', async () => {
  const sources = longSources(), cache = new Map<string, string>();
  let calls = 0;
  const base = options(sources, { maxChars: 5000,
    getCache: async key => cache.get(key), setCache: async (key, text) => { cache.set(key, text); },
    complete: async () => { calls++; return { text: 'Verified compact evidence.', finishReason: 'stop' }; },
  });
  const first = await deepReading(base), batches = first.report.batches!;
  const expected = new Set(planDeepReading(sources, 5000, 'en').batches.map(batch => batch.content)).size;
  assert.equal(calls, expected); assert.equal(cache.size, expected);
  assert.ok([...cache.keys()].every(key => /^[a-f0-9]{64}$/.test(key)));
  const second = await deepReading({ ...base, prompt: 'A different question about the same paper.', config: { ...base.config, apiKey: 'other-local-test-credential' } });
  assert.equal(calls, expected); assert.equal(second.report.cachedBatches, batches);
  const largerOutput = await deepReading({ ...base, config: { ...base.config, maxTokens: 8192 } });
  assert.equal(calls, expected); assert.equal(largerOutput.report.cachedBatches, batches);
  await deepReading({ ...base, config: { ...base.config, model: 'deepseek-pro' } });
  assert.equal(calls, expected * 2);
  await deepReading({ ...base, language: 'zh-CN' });
  assert.equal(calls, expected * 3);
  const changed = structuredClone(sources); changed[0].pages[0] = changed[0].pages[0].replace('EVIDENCE_START', 'MODIFIED_START');
  const changedResult = await deepReading({ ...base, documents: changed });
  assert.ok(calls > expected * 3); assert.ok(changedResult.report.cachedBatches! < batches);
});

test('hierarchical consolidation carries all note beginnings and tails forward instead of truncating oversized notes', async () => {
  let batches = 0, reductions = 0;
  const result = await deepReading(options(longSources(), { maxChars: 3500,
    complete: async (_config, messages) => {
      const content = messages.at(-1)!.content;
      if (content.startsWith('<full_reading_evidence>')) {
        reductions++;
        return { text: [...new Set(content.match(/(?:BEGIN|END)_\d+/g) ?? [])].join(' '), finishReason: 'stop' };
      }
      const id = ++batches;
      return { text: `BEGIN_${id} ` + 'Detailed evidence note. '.repeat(150) + ` END_${id}`, finishReason: 'stop' };
    },
  }));
  assert.ok(batches > 2); assert.ok(reductions > 1); assert.ok(result.content.length <= 2500);
  for (let i = 1; i <= batches; i++) {
    assert.match(result.content, new RegExp(`\\bBEGIN_${i}\\b`));
    assert.match(result.content, new RegExp(`\\bEND_${i}\\b`));
  }
});

test('cancelling an intermediate batch stops reading and never caches the interrupted batch', async () => {
  const controller = new AbortController(), cache = new Map<string, string>();
  let calls = 0; const reports: ReadingReport[] = [];
  await assert.rejects(deepReading(options(longSources(), { maxChars: 5000, signal: controller.signal,
    complete: async () => { if (++calls === 2) controller.abort(); return { text: 'Pending evidence', finishReason: 'stop' }; },
    setCache: async (key, text) => { cache.set(key, text); }, progress: (_text, report) => reports.push(structuredClone(report)),
  })), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(calls, 2); assert.equal(cache.size, 1); assert.ok(reports.every(report => !report.complete));
});

test('token-limited intermediate evidence is rejected and never cached as a complete note', async () => {
  const cache = new Map<string, string>(); let calls = 0;
  await assert.rejects(deepReading(options(longSources(), { maxChars: 5000,
    complete: async () => ({ text: `Evidence batch ${++calls}`, finishReason: calls === 2 ? 'length' : 'stop' }),
    setCache: async (key, text) => { cache.set(key, text); },
  })), /output limit/i);
  assert.equal(calls, 2); assert.equal(cache.size, 1); assert.equal([...cache.values()][0], 'Evidence batch 1');
});

test('token-limited consolidation stops instead of returning a falsely complete result', async () => {
  await assert.rejects(deepReading(options(longSources(), { maxChars: 3500,
    complete: async (_config, messages) => messages.at(-1)!.content.startsWith('<full_reading_evidence>')
      ? { text: 'Truncated combined evidence', finishReason: 'max_tokens' }
      : { text: 'Unusually long evidence. '.repeat(100), finishReason: 'stop' },
  })), /consolidation reached the output limit/i);
});

test('shared context budget leaves bounded room for history, memory, paper and the complete question', () => {
  const cfg = settings(), question = 'Assess the study limitations.';
  const result = readingBudget(cfg, cfg.providers.deepseek, question);
  assert.equal(result.total, 12000);
  assert.ok(result.history > 0 && result.memory > 0 && result.paper > result.history);
  assert.ok(result.history + result.memory + result.paper + question.length < result.total);
  cfg.contextMaxChars = 500000;
  assert.equal(readingBudget(cfg, cfg.providers.deepseek, question).total, 160000);
  assert.equal(readingBudget(cfg, { ...cfg.providers.deepseek, baseURL: 'https://compatible.example/v1' }, question).total, 48000);
  assert.throws(() => readingBudget({ ...cfg, contextMaxChars: 8000 }, cfg.providers.deepseek, 'x'.repeat(7000)), /问题过长|context budget/);
});

function frame(data: unknown) { return `data: ${JSON.stringify(data)}\n\n`; }
function answer(response: ServerResponse, text: string, finish = 'stop') {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(frame({ choices: [{ delta: { content: text }, finish_reason: finish }] }) + 'data: [DONE]\n\n');
}
function harness(config: Settings, sources: ReadingSource[]) {
  const current = workspace(sources), events: ChatEvent[] = [], cache = new Map<string, string>();
  let resolveTerminal: (value: ChatEvent) => void;
  const terminal = new Promise<ChatEvent>(resolve => { resolveTerminal = resolve; });
  const host: AIHost = {
    getWorkspace: () => structuredClone(current), listWorkspaces: () => [structuredClone(current)], getSettings: () => config,
    getDocumentPages: async (_id, id) => sources.find(source => source.id === id)?.pages ?? [],
    mutateWorkspace: async (_id, mutate) => { mutate(current); return structuredClone(current); },
    emit: event => { events.push(event); if (event.type === 'done' || event.type === 'error') resolveTerminal(event); },
    getReadingCache: async (_id: string, key: string) => cache.get(key),
    setReadingCache: async (_id: string, key: string, text: string) => { cache.set(key, text); },
  };
  return { service: createAIService(host), current, events, terminal, cache };
}
const request = (sources: ReadingSource[], changes: Partial<ChatRequest> = {}): ChatRequest => ({
  requestId: 'reading-request', workspaceId: 'reading-fixture', conversationId: 'conversation', prompt: 'Explain all experimental findings.',
  kind: 'chat', documentIds: sources.map(source => source.id), ...changes,
});

test('the real smart SSE service rewrites a Chinese query and sends matching page 60 evidence to the final answer request', async t => {
  const sources = [{ id: 'main', name: 'Main.pdf', pages: Array.from({ length: 60 }, (_, index) => index === 59
    ? 'LATE_RESULT: Checkpoint blockade reverses macrophage exhaustion. '.repeat(12)
    : 'Instrument calibration and general laboratory methods. '.repeat(35)) }];
  const bodies: any[] = [];
  const server = await mock((body, response) => {
    bodies.push(body);
    if (body.messages[0].content.startsWith('Translate the research question')) answer(response, '["checkpoint blockade", "macrophage exhaustion"]');
    else answer(response, '阻断检查点逆转了巨噬细胞耗竭。[Main.pdf p.60]');
  }); t.after(server.close);
  const cfg = settings(server.url); cfg.contextMaxChars = 8000;
  const h = harness(cfg, sources); t.after(() => h.service.dispose());
  await h.service.start(request(sources, { prompt: '阻断检查点能否逆转巨噬细胞耗竭？' }));
  assert.equal((await h.terminal).type, 'done'); assert.equal(bodies.length, 2);
  assert.ok(!JSON.stringify(bodies[0].messages).includes('LATE_RESULT'));
  assert.match(JSON.stringify(bodies[1].messages), /LATE_RESULT/); assert.match(JSON.stringify(bodies[1].messages), /Main\.pdf p\.60/);
  const reading = h.current.conversations[0].messages.at(-1)!.reading!;
  assert.equal(reading.mode, 'smart'); assert.equal(reading.complete, false); assert.ok(reading.documents[0].includedPages.includes(60));
});

test('summary requests force deep reading and persist successful coverage through the real SSE service', async t => {
  const sources = longSources(); let evidenceCalls = 0, finalCalls = 0;
  const server = await mock((body, response) => {
    const isEvidence = body.messages.length === 2;
    if (isEvidence) { evidenceCalls++; answer(response, 'Compact main and supplementary evidence.'); }
    else { finalCalls++; answer(response, 'Complete final synthesis with source citations.'); }
  }); t.after(server.close);
  const h = harness(settings(server.url), sources); t.after(() => h.service.dispose());
  await h.service.start(request(sources, { kind: 'summary', readingMode: 'smart' }));
  assert.equal((await h.terminal).type, 'done');
  assert.ok(evidenceCalls > 1); assert.equal(finalCalls, 1);
  assert.equal(h.current.summary?.reading?.mode, 'deep'); assert.equal(h.current.summary?.reading?.complete, true);
  assert.deepEqual(h.current.summary?.reading?.documents.map(doc => doc.includedPages), [[1, 2], [1, 3]]);
  assert.equal(h.current.conversations[0].messages.at(-1)?.reading?.mode, 'deep');
  assert.ok(h.events.some(event => event.progress?.phase === 'reading'));
});

test('an intermediate SSE token limit preserves an older summary and never emits a complete new one', async t => {
  const sources = longSources(); let calls = 0;
  const server = await mock((_body, response) => answer(response, 'Partial evidence', ++calls === 2 ? 'length' : 'stop'));
  t.after(server.close);
  const h = harness(settings(server.url), sources); t.after(() => h.service.dispose());
  const prior = { content: 'Previously completed summary', provider: 'deepseek', model: 'deepseek-flash', createdAt: 1 };
  h.current.summary = prior;
  await h.service.start(request(sources, { kind: 'summary' }));
  assert.equal((await h.terminal).type, 'error'); assert.deepEqual(h.current.summary, prior);
  assert.equal(h.cache.size, 1);
  assert.ok(h.current.conversations[0].messages.filter(message => message.role === 'assistant')
    .every(message => message.interrupted && !message.reading?.complete));
  assert.ok(!h.events.some(event => event.type === 'done' && event.reading?.complete));
});

test('cancelling deep reading during an SSE evidence batch does not replace a completed summary', async t => {
  const sources = longSources(); let calls = 0;
  let reached: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const server = await mock((_body, response) => {
    if (++calls === 1) answer(response, 'First batch complete');
    else { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(frame({ choices: [{ delta: { content: 'Unfinished batch' } }] })); reached(); }
  }); t.after(server.close);
  const h = harness(settings(server.url), sources); t.after(() => h.service.dispose());
  h.current.summary = { content: 'Retain previous summary', provider: 'deepseek', model: 'deepseek-flash', createdAt: 1 };
  await h.service.start(request(sources, { kind: 'summary' }));
  await waiting; h.service.abort('reading-request');
  const done = await h.terminal;
  assert.equal(done.type, 'done'); assert.equal(done.interrupted, true);
  assert.equal(h.current.summary.content, 'Retain previous summary'); assert.equal(h.cache.size, 1);
  assert.ok(!h.current.conversations[0].messages.some(message => message.role === 'assistant' && !message.interrupted));
});

test('smart service bounds attached history and memory inside the shared input budget', async t => {
  const sources = [{ id: 'main', name: 'Main.pdf', pages: ['Evidence about cellular activation.'] }];
  let submitted: any;
  const server = await mock((body, response) => { submitted = body; answer(response, 'Answer from bounded context.'); });
  t.after(server.close);
  const cfg = settings(server.url); cfg.contextMaxChars = 16000;
  const h = harness(cfg, sources); t.after(() => h.service.dispose());
  h.current.notes = 'MEMORY_NOTE '.repeat(9000);
  h.current.conversations[0].messages = Array.from({ length: 16 }, (_, index) => ({
    id: 'history-' + index, role: index % 2 ? 'assistant' as const : 'user' as const,
    content: `HISTORY_${index} ` + 'old dialogue '.repeat(70), createdAt: index,
  }));
  const req = request(sources, { readingMode: 'smart' }), budget = readingBudget(cfg, cfg.providers.deepseek, req.prompt);
  await h.service.start(req); assert.equal((await h.terminal).type, 'done');
  const messages = submitted.messages as { role: string; content: string }[];
  const history = messages.filter(message => message.content.startsWith('HISTORY_'));
  assert.ok(history.length < 16); assert.ok(history.reduce((sum, message) => sum + message.content.length, 0) <= budget.history);
  const reference = messages.find(message => message.content.includes('MEMORY_NOTE'))!;
  assert.ok(reference.content.length <= budget.paper + budget.memory + 500);
  assert.ok(messages.reduce((sum, message) => sum + message.content.length, 0) <= budget.total + 1000);
  assert.equal(h.current.conversations[0].messages.at(-1)?.reading?.mode, 'smart');
});

test('a token-limited final deep answer remains interrupted and never replaces a completed summary or creates memory', async t => {
  const sources = longSources(); let finals = 0;
  const server = await mock((body, response) => {
    if (body.messages.length === 2) answer(response, 'Completed intermediate evidence.');
    else { finals++; answer(response, 'Final synthesis stopped midway', 'length'); }
  }); t.after(server.close);
  const cfg = settings(server.url); cfg.autoMemory = true;
  const h = harness(cfg, sources); t.after(() => h.service.dispose());
  const previous = { content: 'Previous complete summary', provider: 'deepseek', model: 'deepseek-flash', createdAt: 1 };
  h.current.summary = previous;
  await h.service.start(request(sources, { kind: 'summary' }));
  assert.equal((await h.terminal).type, 'error'); assert.equal(finals, 1);
  assert.deepEqual(h.current.summary, previous); assert.equal(h.current.memories.length, 0);
  const partial = h.current.conversations[0].messages.at(-1)!;
  assert.equal(partial.role, 'assistant'); assert.equal(partial.interrupted, true); assert.equal(partial.reading?.complete, false);
  assert.match(partial.content, /Final synthesis stopped midway/);
});

test('deep and summary requests cannot use a selected excerpt to bypass incomplete full-document indexing', async t => {
  const sources = [{ id: 'main', name: 'Main.pdf', pages: ['Only the selected excerpt has been extracted so far.'], pageCount: 60 }];
  let calls = 0;
  const server = await mock((_body, response) => { calls++; answer(response, 'Should never read this incomplete index.'); });
  t.after(server.close);
  const h = harness(settings(server.url), sources); t.after(() => h.service.dispose());
  delete h.current.documents[0].textStatus;
  const selection = { documentId: 'main', documentName: 'Main.pdf', page: 1, text: sources[0].pages[0], rects: [] };
  await assert.rejects(h.service.start(request(sources, { selection, readingMode: 'deep' })), /索引尚未完成|indexing is not complete/);
  await assert.rejects(h.service.start(request(sources, { selection, kind: 'summary', readingMode: 'smart' })), /索引尚未完成|indexing is not complete/);
  assert.equal(calls, 0); assert.equal(h.current.conversations[0].messages.length, 0); assert.equal(h.current.summary, undefined);
});
