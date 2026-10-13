import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ProviderConfig } from '../shared/types';
import { safeWebSourceUrl, supportsWebSearch, webSearchProvider } from '../shared/web-search';
import { searchWeb, WEB_SEARCH_MAX_RESPONSE_BYTES, WEB_SEARCH_TIMEOUT_MS } from '../electron/web-search';

const KEY = 'unit-test-placeholder-key';
const config: ProviderConfig = { id: 'deepseek', apiKey: KEY, baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-pro', maxTokens: 8192, thinking: true, reasoningEffort: 'max' };
const openai: ProviderConfig = { ...config, id: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-5.5' };
const anthropic: ProviderConfig = { ...config, id: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' };
const kimi: ProviderConfig = { ...config, id: 'custom', baseURL: 'https://api.moonshot.ai/v1', model: 'kimi-k3' };
const glm: ProviderConfig = { ...config, id: 'custom', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' };
const controller = () => new AbortController();
const item = (url = 'https://example.org/paper', title = 'A public paper') => ({ type: 'web_search_result', url, title, page_age: '2026-10-12' });
const result = (content: unknown = [item()]) => ({ content: [{ type: 'web_search_tool_result', content }] });
const json = (payload: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' }, ...init });
const responses = (sources: unknown[] = [{ type: 'url', url: 'https://example.org/paper', title: 'A public paper' }]) => ({ status: 'completed', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', sources } },
  { type: 'message', content: [{ type: 'output_text', text: 'Provider-generated search summary.', annotations: [{ type: 'url_citation', url: 'https://example.org/paper', title: 'A public paper' }] }] },
] });
function mockFetch(t: TestContext, reply: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) {
  return t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => reply(input, init));
}

test('supports search only for official DeepSeek credentials and supported chat base paths', () => {
  for (const baseURL of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/']) assert.equal(supportsWebSearch({ ...config, baseURL }), true);
  for (const baseURL of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://other.test', 'https://api.deepseek.com:444', 'https://user@api.deepseek.com', 'https://api.deepseek.com?key=secret', 'https://api.deepseek.com/#part', 'https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/anthropic', 'not-a-url']) assert.equal(supportsWebSearch({ ...config, baseURL }), false, baseURL);
  assert.equal(supportsWebSearch({ ...config, id: 'custom' }), false);
  assert.equal(supportsWebSearch(undefined), false);
});

test('source URLs reject credential, local, encoded IP, private IPv6 and non-web links', () => {
  for (const value of [null, {}, '', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.org', 'https://localhost', 'https://a.localhost.', 'http://printer.local', 'http://service.internal', 'http://router', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://10.1.2.3', 'http://172.16.1.2', 'http://192.168.1.2', 'http://169.254.1.1', 'http://100.64.0.1', 'http://224.0.0.1', 'http://[::]', 'http://[::1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[fec0::1]', 'http://[::ffff:127.0.0.1]', 'https://example.org/\nsecret']) assert.equal(safeWebSourceUrl(value), null, String(value));
  assert.equal(safeWebSourceUrl('https://EXAMPLE.org/paper?q=1#section'), 'https://example.org/paper?q=1#section');
  assert.equal(safeWebSourceUrl('https://8.8.8.8/'), 'https://8.8.8.8/');
  assert.equal(safeWebSourceUrl('https://[2606:4700:4700::1111]/'), 'https://[2606:4700:4700::1111]/');
});

test('uses the selected Pro model in a bounded official Messages request without following redirects', async t => {
  const fetch = mockFetch(t, (input, init) => {
    assert.equal(String(input), 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), KEY);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'deepseek-v4-pro');
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content[0].text, 'Perform a web search for the query: public paper');
    for (const name of ['thinking', 'stream', 'tool_choice', 'system']) assert.equal(name in body, false);
    return json(result());
  });
  const found = await searchWeb(config, ' public paper ', controller().signal, 'en');
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(found.query, 'public paper');
  assert.equal(found.sources[0].url, 'https://example.org/paper');
  assert.equal(typeof found.searchedAt, 'number');
});

test('joins only structured citations to results, deduplicates URLs, clamps strings and sources', async t => {
  const sources = [item(), item(), ...Array.from({ length: 12 }, (_, i) => item(`https://example.org/${i}`, 'T'.repeat(500)))];
  mockFetch(t, () => json({ content: [
    { type: 'text', text: 'Invented prose https://fake.example.org/', citations: [{ url: 'https://example.org/paper', cited_text: 'S'.repeat(2000) }, { url: 'https://fake.example.org/', cited_text: 'Unbacked citation' }] },
    { type: 'web_search_tool_result', content: sources },
  ] }));
  const found = await searchWeb(config, 'query', controller().signal);
  assert.equal(found.sources.length, 8);
  assert.equal(found.sources[0].snippet.length, 1200);
  assert.equal(found.sources[0].publishedAt, '2026-10-12');
  assert.equal(found.sources[1].title.length, 240);
  assert.equal(found.sources[1].snippet, '');
  assert.ok(found.sources.every(source => source.url !== 'https://fake.example.org/'));
});

test('drops unsafe URLs and malformed items and prevents reflected keys in structured source fields', async t => {
  mockFetch(t, () => json({ content: [
    { type: 'web_search_tool_result', content: [null, 1, {}, item('http://127.0.0.1/'), item('javascript:alert(1)'), item(`https://example.org/?key=${KEY}`), item('https://example.org/paper', `Title ${KEY}`)] },
    { type: 'text', citations: [{ url: 'https://example.org/paper', cited_text: `Snippet ${KEY}` }] },
  ] }));
  const found = await searchWeb(config, 'query', controller().signal, 'en');
  assert.equal(found.sources.length, 1);
  assert.equal(JSON.stringify(found).includes(KEY), false);
});

test('genuinely empty result lists stay empty and never use assistant prose as sources', async t => {
  mockFetch(t, () => json(result([])));
  assert.deepEqual((await searchWeb(config, 'query', controller().signal)).sources, []);
});

test('missing structured blocks and malformed payloads fail explicitly with localized messages', async t => {
  let payload: unknown = { content: [{ type: 'text', text: 'I searched the internet: https://example.org/' }] };
  mockFetch(t, () => json(payload));
  await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), /no actual search results/);
  for (payload of [null, [], {}, { content: {} }, { content: [], error: { message: KEY } }, result(null)]) {
    await assert.rejects(searchWeb(config, 'query', controller().signal), error => error instanceof Error && /搜索/.test(error.message) && !error.message.includes(KEY));
  }
});

test('server tool error blocks never become an empty successful search', async t => {
  mockFetch(t, () => json(result({ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded', message: KEY })));
  await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), /unavailable or its search limit/);
});

test('rejects invalid configuration, missing key and overlong queries before dispatch', async t => {
  const fetch = mockFetch(t, () => { throw new Error('Must not dispatch'); });
  for (const provider of [{ ...config, baseURL: 'https://other.test' }, { ...config, id: 'custom' as const }, { ...config, apiKey: '' }]) await assert.rejects(searchWeb(provider, 'query', controller().signal, 'en'));
  for (const query of ['', '   ', 'q'.repeat(2001)]) await assert.rejects(searchWeb(config, query, controller().signal, 'en'), /query/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('authentication, credit, rate limit and server failures never expose the provider body', async t => {
  let status = 401;
  mockFetch(t, () => json({ error: { message: `Reflected ${KEY}` } }, { status }));
  for (const [code, pattern] of [[401, /authentication/], [402, /balance/], [403, /authentication/], [429, /rate limited/], [503, /HTTP 503/]] as const) {
    status = code;
    await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), error => error instanceof Error && pattern.test(error.message) && !error.message.includes(KEY));
  }
});

test('rejects redirect responses and redacts network diagnostics', async t => {
  let response: Response | undefined = json(result(), { status: 302, headers: { location: 'https://other.test' } });
  mockFetch(t, () => { if (response) return response; throw new Error(`Network error with ${KEY}`); });
  await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), /HTTP 302/);
  response = json(result());
  Object.defineProperty(response, 'redirected', { value: true });
  await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), /redirected/);
  response = json(result());
  Object.defineProperty(response, 'url', { value: 'https://other.test/messages' });
  await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), /redirected/);
  response = undefined;
  await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), error => error instanceof Error && /Could not connect/.test(error.message) && !error.message.includes(KEY));
});

test('bounds declared and streamed response sizes and rejects malformed JSON', async t => {
  let response = json(result(), { headers: { 'content-length': String(WEB_SEARCH_MAX_RESPONSE_BYTES + 1) } });
  mockFetch(t, () => response);
  await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), /oversized or invalid/);
  response = new Response(' '.repeat(WEB_SEARCH_MAX_RESPONSE_BYTES + 1));
  await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), /oversized or invalid/);
  response = new Response(`malformed ${KEY}`);
  await assert.rejects(searchWeb(config, 'query', controller().signal, 'en'), error => error instanceof Error && /invalid/.test(error.message) && !error.message.includes(KEY));
});

test('pre-cancelled requests never dispatch and ongoing requests remain cancellable even with uncooperative fetch', async t => {
  const fetch = mockFetch(t, () => new Promise<Response>(() => {}));
  const first = controller(); first.abort(new Error(KEY));
  await assert.rejects(searchWeb(config, 'query', first.signal, 'en'), /cancelled/);
  assert.equal(fetch.mock.callCount(), 0);
  const next = controller(), task = searchWeb(config, 'query', next.signal, 'en');
  next.abort(new Error(KEY));
  await assert.rejects(task, error => error instanceof Error && /cancelled/.test(error.message) && !error.message.includes(KEY));
});

test('cancellation while reading the body cancels its stream without exposing partial text', async t => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  mockFetch(t, () => new Response(stream));
  const active = controller();
  const task = searchWeb(config, 'query', active.signal, 'en');
  await new Promise<void>(resolve => setImmediate(resolve));
  active.abort();
  await assert.rejects(task, /cancelled/);
  assert.equal(cancelled, true);
});

test('timeout bounds a stalled transport and aborts the request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let transportSignal: AbortSignal | undefined;
  mockFetch(t, (_input, init) => { transportSignal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); });
  const task = searchWeb(config, 'query', controller().signal, 'en');
  const rejected = assert.rejects(task, /timed out/);
  t.mock.timers.tick(WEB_SEARCH_TIMEOUT_MS);
  await rejected;
  assert.equal(transportSignal?.aborted, true);
});

test('recognizes the five documented official provider routes without cross-provider credential reuse', () => {
  for (const [provider, expected] of [[config, 'deepseek'], [openai, 'openai'], [anthropic, 'anthropic'], [kimi, 'kimi'], [glm, 'glm']] as const) {
    assert.equal(webSearchProvider(provider), expected);
    assert.equal(supportsWebSearch(provider), true);
  }
  assert.equal(webSearchProvider({ ...kimi, baseURL: 'https://api.moonshot.cn/v1/' }), 'kimi');
  assert.equal(webSearchProvider({ ...glm, baseURL: 'https://api.z.ai/api/paas/v4' }), 'glm');
  for (const provider of [
    { ...openai, baseURL: 'https://api.anthropic.com/v1' }, { ...anthropic, id: 'openai' as const },
    { ...openai, id: 'custom' as const }, { ...kimi, model: 'kimi-k2.5' },
    { ...kimi, baseURL: 'https://api.moonshot.ai.evil.test/v1' },
    { ...glm, baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    { ...glm, baseURL: 'https://api.z.ai/api/coding/paas/v4' },
    { ...glm, baseURL: 'http://open.bigmodel.cn/api/paas/v4' },
    { ...glm, baseURL: 'https://user:secret@open.bigmodel.cn/api/paas/v4' },
  ]) assert.equal(supportsWebSearch(provider), false, provider.baseURL);
});

test('OpenAI uses its selected model and bearer key through Responses with structured sources', async t => {
  mockFetch(t, (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/responses');
    const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
    assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(headers.has('x-api-key'), false);
    assert.equal(body.model, openai.model);
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 4096);
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.deepEqual(body.include, ['web_search_call.action.sources']);
    return json(responses([{ type: 'url', url: 'https://example.org/paper' }]));
  });
  const found = await searchWeb(openai, 'query', controller().signal, 'en');
  assert.equal(found.sources[0].title, 'A public paper');
  assert.equal(found.sources[0].snippet, '');
  assert.equal(found.summary, 'Provider-generated search summary.');
});

test('OpenAI annotations can supply structured citations but require an actual completed search call', async t => {
  let payload: unknown = { status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'query' } },
    { type: 'message', content: [{ type: 'output_text', text: 'Summary', annotations: [{ type: 'url_citation', url: 'https://example.org/a', title: 'Source A' }] }] },
  ] };
  mockFetch(t, () => json(payload));
  assert.equal((await searchWeb(openai, 'query', controller().signal, 'en')).sources[0].title, 'Source A');
  payload = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'I searched', annotations: [{ type: 'url_citation', url: 'https://example.org/' }] }] }] };
  await assert.rejects(searchWeb(openai, 'query', controller().signal, 'en'), /did not perform an actual web search/);
});

test('Responses failures, in-progress tools and missing source metadata cannot masquerade as searches', async t => {
  let payload: unknown = null;
  mockFetch(t, () => json(payload));
  for (payload of [
    { ...responses(), error: { message: KEY } }, { ...responses(), status: 'incomplete' },
    { status: 'completed', output: [{ type: 'web_search_call', status: 'failed' }] },
    { status: 'completed', output: [{ type: 'web_search_call', status: 'in_progress' }] },
    { status: 'completed', output: [{ type: 'web_search_call', status: 'completed', action: {} }] },
  ]) await assert.rejects(searchWeb(openai, 'query', controller().signal, 'en'), error => error instanceof Error && !error.message.includes(KEY));
});

test('Kimi K3 uses each selected regional origin without undocumented OpenAI fields or legacy tool loops', async t => {
  let expectedOrigin = 'https://api.moonshot.ai';
  mockFetch(t, (input, init) => {
    assert.equal(String(input), `${expectedOrigin}/v1/responses`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'kimi-k3');
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.deepEqual(body.include, ['web_search_call.action.sources']);
    assert.deepEqual(body.reasoning, { effort: 'max' });
    for (const field of ['store', 'background', 'previous_response_id', 'tool_choice']) assert.equal(field in body, false);
    return json(responses());
  });
  assert.equal((await searchWeb(kimi, 'query', controller().signal)).sources.length, 1);
  expectedOrigin = 'https://api.moonshot.cn';
  assert.equal((await searchWeb({ ...kimi, baseURL: `${expectedOrigin}/v1` }, 'query', controller().signal)).sources.length, 1);
});

test('Kimi only trusts documented action.sources and never guesses citations from answer annotations or prose', async t => {
  mockFetch(t, () => json({ status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [] } },
    { type: 'message', content: [{ type: 'output_text', text: 'A link https://invented.example.org/', annotations: [{ type: 'url_citation', url: 'https://invented.example.org/' }] }] },
  ] }));
  const found = await searchWeb(kimi, 'query', controller().signal);
  assert.deepEqual(found.sources, []);
  assert.equal(found.summary, undefined);
});

test('Responses summary is bounded, redacted and omitted when all source URLs are unsafe', async t => {
  let payload = { status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://example.org/' }] } },
    { type: 'message', content: [{ type: 'output_text', text: `${KEY} ${'S'.repeat(9000)}` }] },
  ] };
  mockFetch(t, () => json(payload));
  const found = await searchWeb(kimi, 'query', controller().signal);
  assert.equal(found.summary?.length, 6000);
  assert.equal(found.summary?.includes(KEY), false);
  payload.output[0].action!.sources[0].url = 'http://127.0.0.1/';
  const unsafe = await searchWeb(kimi, 'query', controller().signal);
  assert.deepEqual(unsafe.sources, []);
  assert.equal(unsafe.summary, undefined);
});

test('Anthropic retains the selected Claude model and native tool excerpts on its own origin', async t => {
  mockFetch(t, (input, init) => {
    assert.equal(String(input), 'https://api.anthropic.com/v1/messages');
    const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
    assert.equal(headers.get('x-api-key'), KEY);
    assert.equal(headers.has('authorization'), false);
    assert.equal(body.model, anthropic.model);
    assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
    return json({ ...result(), stop_reason: 'end_turn' });
  });
  assert.equal((await searchWeb(anthropic, 'query', controller().signal)).sources.length, 1);
});

test('Anthropic paused turns and tool errors are explicit failures without invented sources', async t => {
  let payload: unknown = { ...result(), stop_reason: 'pause_turn' };
  mockFetch(t, () => json(payload));
  await assert.rejects(searchWeb(anthropic, 'query', controller().signal, 'en'), /not completed/);
  payload = result({ type: 'web_search_tool_result_error', error_code: 'unavailable' });
  await assert.rejects(searchWeb(anthropic, 'query', controller().signal, 'en'), /unavailable/);
});

test('GLM uses the matching official regional engine with selected model and structured web_search sources', async t => {
  let origin = 'https://open.bigmodel.cn', engine = 'search_pro';
  mockFetch(t, (input, init) => {
    assert.equal(String(input), `${origin}/api/paas/v4/chat/completions`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, glm.model);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${KEY}`);
    assert.deepEqual(body.tools, [{ type: 'web_search', web_search: { enable: true, search_result: true, require_search: true, search_engine: engine, search_query: 'query', count: 8 } }]);
    assert.equal('tool_choice' in body, false);
    return json({ web_search: [{ title: 'GLM source', link: 'https://example.org/glm', content: 'Actual returned source excerpt', publish_date: '2026-10-13', refer: 'ref_1' }], choices: [{ message: { content: 'Prose with https://invented.example.org/' } }] });
  });
  let found = await searchWeb(glm, 'query', controller().signal, 'en');
  assert.deepEqual(found.sources, [{ title: 'GLM source', url: 'https://example.org/glm', snippet: 'Actual returned source excerpt', publishedAt: '2026-10-13' }]);
  assert.equal(found.summary, undefined);
  origin = 'https://api.z.ai'; engine = 'search_pro_jina';
  found = await searchWeb({ ...glm, baseURL: `${origin}/api/paas/v4` }, 'query', controller().signal, 'en');
  assert.equal(found.sources.length, 1);
});

test('GLM missing/error results and native-model rejection never trigger a provider or model fallback', async t => {
  let payload: unknown = { choices: [{ message: { content: 'Prose only' } }] }, status = 200;
  const fetch = mockFetch(t, () => json(payload, { status }));
  await assert.rejects(searchWeb(glm, 'query', controller().signal, 'en'), /no actual search sources/);
  payload = { error: { message: KEY }, web_search: [] };
  await assert.rejects(searchWeb(glm, 'query', controller().signal, 'en'), /no actual search sources/);
  status = 400;
  await assert.rejects(searchWeb(glm, 'query', controller().signal, 'en'), /current model supports native search/);
  assert.equal(fetch.mock.callCount(), 3);
});
