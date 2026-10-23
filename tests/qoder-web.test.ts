import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import type { ProviderConfig } from '../shared/types';
import { QODER_MODELS } from '../shared/qoder';
import { supportsWebSearch, webSearchProvider } from '../shared/web-search';
import { normalizeQoderWebEvidence, QODER_WEB_TIMEOUT_MS, streamQoderCompletion } from '../electron/qoder-web';
import { searchWeb } from '../electron/web-search';

const KEY = 'synthetic-local-model-key';
const config: ProviderConfig = { id: 'qoder', baseURL: 'http://127.0.0.1:8788/v1', model: 'kmodel_latest', apiKey: KEY, maxTokens: 8192, reasoningEffort: 'max' };
const messages = [{ role: 'user', content: 'Synthetic question' }];
const url = 'https://example.org/evidence';
const evidence = () => ({ enabled: true, maxCalls: 8, successfulSearches: 1, successfulFetches: 1,
  calls: [
    { id: 'search-1', name: 'WebSearch', status: 'success', query: 'Synthetic search', resultCount: 1, sources: [url] },
    { id: 'fetch-1', name: 'WebFetch', status: 'success', url, statusCode: 200, contentKind: 'sdk_extracted_or_summarized_page', summary: 'SDK generated page summary, not original page prose.', sources: [url] },
  ], sources: [{ url, title: 'Source title', snippet: 'Search-result snippet.', publishedAt: '2026-10-23' }] });
const frame = (content: string, finish: string | null = null, web?: unknown, model = config.model) => ({ model, choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish }], ...(web !== undefined ? { qoder_web: web } : {}) });
const sse = (value: unknown, newline = '\n') => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${newline}${newline}`;
const controller = () => new AbortController();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const failures: unknown[] = [];
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(error => { failures.push(error); response.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { config: { ...config, baseURL: `http://127.0.0.1:${address.port}/v1` },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); assert.deepEqual(failures, []); } };
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function answer(response: ServerResponse, content = 'Answer', web?: unknown, finish = 'stop', model = config.model) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(sse(frame(content, null, undefined, model)) + sse(frame('', finish, web, model)) + sse('[DONE]'));
}

test('all Qoder catalog models advertise native web only on the explicit local Qoder route', () => {
  for (const model of QODER_MODELS) {
    assert.equal(webSearchProvider({ ...config, model: model.id }), 'qoder');
    assert.equal(supportsWebSearch({ ...config, model: model.id }), true);
  }
  for (const baseURL of ['https://127.0.0.1:8788/v1', 'http://127.0.0.1:8788/v1?token=x', 'http://remote.example/v1', 'http://127.1:8788/v1']) assert.equal(webSearchProvider({ ...config, baseURL }), null);
  assert.equal(webSearchProvider({ ...config, id: 'custom' }), null);
  assert.equal(webSearchProvider({ ...config, model: 'invented-model' }), null);
});

test('evidence requires successful search and page fetch records, not just claimed counters', () => {
  const normalized = normalizeQoderWebEvidence(evidence(), 'Question', KEY, 'en', 12345);
  assert.deepEqual(normalized.sources, [{ url, title: 'Source title', snippet: 'Search-result snippet.', publishedAt: '2026-10-23' }]);
  assert.equal(normalized.query, 'Question'); assert.equal(normalized.searchedAt, 12345);
  assert.equal(normalized.qoderEvidence?.successfulSearches, 1); assert.equal(normalized.qoderEvidence?.successfulFetches, 1);
  assert.match(normalized.summary!, /not verbatim page text/);
  assert.match(normalized.summary!, /SDK generated page summary/);
  assert.doesNotMatch(normalized.sources[0].snippet, /SDK generated/);
  const variations: unknown[] = [undefined, {}, { ...evidence(), enabled: false }, { ...evidence(), calls: [] }, { ...evidence(), successfulSearches: 2 }, { ...evidence(), successfulFetches: 0 }, { ...evidence(), maxCalls: 100 }];
  for (const field of ['statusCode', 'contentKind', 'summary', 'url']) {
    const altered = structuredClone(evidence()) as any; delete altered.calls[1][field]; variations.push(altered);
  }
  for (const patch of [{ status: 'pending' }, { status: 'error' }, { statusCode: 500 }, { summary: '' }, { url: 'http://127.0.0.1/private' }]) {
    const altered = structuredClone(evidence()) as any; Object.assign(altered.calls[1], patch); variations.push(altered);
  }
  const duplicate = structuredClone(evidence()); duplicate.calls[1].id = duplicate.calls[0].id; variations.push(duplicate);
  const invalidSearch = structuredClone(evidence()); invalidSearch.calls[0].query = ''; variations.push(invalidSearch);
  for (const value of variations) assert.throws(() => normalizeQoderWebEvidence(value, 'Question', KEY, 'en'), /verifiable web evidence/);
});

test('sources must be attested by successful calls; unsafe, failed-only and invented links are discarded', () => {
  const payload = evidence() as any;
  payload.calls.push({ id: 'failed', name: 'WebSearch', status: 'error', query: 'failed', sources: ['https://failed.example/path'] });
  payload.sources.push({ url: 'https://failed.example/path', title: 'Failed source' }, { url: 'https://invented.example/path', title: 'Model prose is not evidence' }, { url: 'http://127.0.0.1/private', title: 'Private' }, { url: 'file:///private', title: 'Local file' }, { url, title: 'Duplicate' });
  const result = normalizeQoderWebEvidence(payload, 'Question', KEY, 'en');
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].url, url);
  payload.sources = []; const empty = normalizeQoderWebEvidence(payload, 'Question', KEY, 'en');
  assert.deepEqual(empty.sources, []); assert.equal(empty.summary, undefined);
});

test('evidence is bounded and key-redacted, and source URLs cannot contain publishing credentials', () => {
  const payload = evidence() as any;
  payload.sources[0].title = KEY + 't'.repeat(500); payload.sources[0].snippet = KEY + 's'.repeat(2000);
  payload.calls[1].summary = KEY + 'summary '.repeat(2000); payload.calls[0].query += KEY;
  const secretURL = `https://example.org/?key=${encodeURIComponent(KEY)}`;
  payload.calls[0].sources.push(secretURL); payload.sources.push({ url: secretURL, title: 'Secret URL' });
  const result = normalizeQoderWebEvidence(payload, KEY + 'question', KEY, 'en');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].title.length, 240); assert.equal(result.sources[0].snippet.length, 1200);
  assert.equal(result.summary?.length, 6000);
});

test('one native streamed web request uses the selected key/model, preserves images and returns verified citations', async () => {
  const requests: any[] = [];
  const f = await fixture(async (request, response) => {
    requests.push({ route: request.url, authorization: request.headers.authorization, body: await body(request) });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const bytes = Buffer.from(': keep-alive\r\n\r\n' + sse(frame('答案 🧪 '), '\r\n') + sse(frame('[source](https://example.org/evidence)')) + sse(frame('', 'stop', evidence())) + sse('[DONE]'));
    // Split UTF-8 and CRLF across chunks rather than assuming packet boundaries.
    for (let offset = 0; offset < bytes.length; offset += 7) response.write(bytes.subarray(offset, offset + 7));
    response.end();
  });
  try {
    const delta: string[] = [];
    const imageMessages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj' } }, { type: 'text', text: 'Question' }] }];
    const result = await streamQoderCompletion(f.config, imageMessages, controller().signal, text => delta.push(text), { webSearch: true, query: 'Question', language: 'en' });
    assert.equal(requests.length, 1); assert.equal(requests[0].route, '/v1/chat/completions'); assert.equal(requests[0].authorization, `Bearer ${KEY}`);
    assert.deepEqual(requests[0].body, { model: config.model, messages: imageMessages, stream: true, max_tokens: 8192, reasoning_effort: 'max', web_search: 'required', web_fetch: 'required' });
    assert.equal(result.text, delta.join('')); assert.equal(result.finishReason, 'stop'); assert.equal(result.webSearch?.sources[0].url, url);
  } finally { await f.close(); }
});

test('ordinary Qoder chat omits web flags and ignores unsolicited tool evidence', async () => {
  let received: any;
  const f = await fixture(async (request, response) => { received = await body(request); answer(response, 'Ordinary answer', evidence(), 'length'); });
  try {
    const result = await streamQoderCompletion(f.config, messages, controller().signal, () => {}, { language: 'en' });
    assert.equal(received.web_search, undefined); assert.equal(received.web_fetch, undefined); assert.equal(result.webSearch, undefined); assert.equal(result.finishReason, 'length');
  } finally { await f.close(); }
});

test('a complete terminal frame and DONE release a connection that stays open afterwards', async () => {
  const f = await fixture(async (request, response) => {
    await body(request); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(sse(frame('Complete answer')) + sse(frame('', 'stop', evidence())) + sse('[DONE]'));
    // Deliberately keep the HTTP body open after the protocol completion.
  });
  try {
    const result = await streamQoderCompletion(f.config, messages, controller().signal, () => {}, { webSearch: true, language: 'en', timeoutMs: 500 });
    assert.equal(result.text, 'Complete answer'); assert.equal(result.webSearch?.sources[0].url, url);
  } finally { await f.close(); }
});

test('web length, missing evidence and mid-stream bridge errors never complete successfully', async () => {
  for (const mode of ['length', 'no-evidence', 'error', 'missing-done', 'missing-finish', 'other-model'] as const) {
    const f = await fixture(async (request, response) => {
      await body(request); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse(frame('Partial answer')));
      if (mode === 'error') { response.end(sse({ error: { message: KEY + 'private upstream detail' }, qoder_web: evidence() })); return; }
      if (mode !== 'missing-finish') response.write(sse(frame('', mode === 'length' ? 'length' : 'stop', mode === 'no-evidence' ? undefined : evidence(), mode === 'other-model' ? 'dmodel' : config.model)));
      response.end(mode === 'missing-done' ? '' : sse('[DONE]'));
    });
    try {
      let partial = '';
      await assert.rejects(streamQoderCompletion(f.config, messages, controller().signal, text => { partial += text; }, { webSearch: true, language: 'en' }), error => {
        assert.doesNotMatch(String(error), new RegExp(KEY)); assert.doesNotMatch(String(error), /private upstream detail/); return true;
      });
      assert.equal(partial, 'Partial answer');
    } finally { await f.close(); }
  }
});

test('untrusted endpoints and invalid requests fail before any network operation', async () => {
  const abort = controller(); abort.abort(new Error(KEY));
  await assert.rejects(streamQoderCompletion(config, messages, abort.signal, () => {}, { language: 'en' }), error => { assert.equal((error as Error).name, 'AbortError'); assert.doesNotMatch(String(error), new RegExp(KEY)); return true; });
  for (const altered of [{ ...config, baseURL: 'https://example.org/v1' }, { ...config, id: 'custom' as const }, { ...config, model: 'invented' }, { ...config, apiKey: '' }, { ...config, maxTokens: 33000 }]) await assert.rejects(streamQoderCompletion(altered, messages, controller().signal, () => {}, { language: 'en' }));
  await assert.rejects(streamQoderCompletion(config, [], controller().signal, () => {}, { language: 'en' }));
  await assert.rejects(streamQoderCompletion(config, messages, controller().signal, () => {}, { timeoutMs: QODER_WEB_TIMEOUT_MS + 1, language: 'en' }));
  await assert.rejects(searchWeb(config, 'Question', controller().signal, 'en'), /inside the current chat/);
});

test('native transport rejects redirects without forwarding the selected key', async () => {
  let visits = 0;
  const f = await fixture(async (request, response) => { visits++; await body(request); response.writeHead(307, { Location: `http://127.0.0.1:1/redirect?key=${KEY}` }); response.end(KEY); });
  try {
    await assert.rejects(streamQoderCompletion(f.config, messages, controller().signal, () => {}, { language: 'en' }), /redirected/);
    assert.equal(visits, 1);
  } finally { await f.close(); }
});

test('HTTP errors never echo bridge bodies or credentials', async () => {
  for (const status of [401, 403, 429, 502]) {
    const f = await fixture(async (request, response) => { await body(request); response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: KEY } })); });
    try { await assert.rejects(streamQoderCompletion(f.config, messages, controller().signal, () => {}, { language: 'en' }), error => { assert.doesNotMatch(String(error), new RegExp(KEY)); return true; }); }
    finally { await f.close(); }
  }
});

test('one deadline covers waiting for response headers and a stalled response body', async () => {
  for (const headers of [false, true]) {
    const f = await fixture(async (request, response) => { await body(request); if (headers) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(sse(frame('Before timeout'))); } });
    try {
      const before = Date.now();
      await assert.rejects(streamQoderCompletion(f.config, messages, controller().signal, () => {}, { timeoutMs: 40, language: 'en' }), /timed out/);
      assert.ok(Date.now() - before < 1000, 'The deadline covers both header and body waits');
    } finally { await f.close(); }
  }
});

test('user cancellation closes an in-flight local request and never returns successful web evidence', async () => {
  let incomingClosed = false, started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(async (request, response) => { await body(request); response.on('close', () => { incomingClosed = true; }); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(sse(frame('Before cancellation'))); started(); });
  try {
    const abort = controller(); let partial = '';
    const result = streamQoderCompletion(f.config, messages, abort.signal, text => { partial += text; }, { webSearch: true, language: 'en' });
    await beginning; await delay(10); abort.abort(new Error(KEY));
    await assert.rejects(result, error => { assert.equal((error as Error).name, 'AbortError'); assert.doesNotMatch(String(error), new RegExp(KEY)); return true; });
    for (let attempt = 0; attempt < 20 && !incomingClosed; attempt++) await delay(5);
    assert.equal(incomingClosed, true); assert.equal(partial, 'Before cancellation');
  } finally { await f.close(); }
});

test('invalid content types, UTF-8, JSON, oversized frames and tool handoffs are explicit failures', async () => {
  for (const mode of ['content-type', 'utf8', 'json', 'size', 'tools'] as const) {
    const f = await fixture(async (request, response) => {
      await body(request); response.writeHead(200, { 'Content-Type': mode === 'content-type' ? 'application/json' : 'text/event-stream' });
      if (mode === 'utf8') response.end(Buffer.from([0xff]));
      else if (mode === 'json') response.end('data: not JSON\n\n');
      else if (mode === 'size') response.end('data: ' + 'x'.repeat(1024 * 1024 + 1));
      else if (mode === 'tools') response.end(sse({ model: config.model, choices: [{ index: 0, delta: { tool_calls: [{ id: 'not-allowed' }] }, finish_reason: 'tool_calls' }] }) + sse('[DONE]'));
      else response.end('{}');
    });
    try { await assert.rejects(streamQoderCompletion(f.config, messages, controller().signal, () => {}, { language: 'en' }), /invalid stream/); }
    finally { await f.close(); }
  }
});
