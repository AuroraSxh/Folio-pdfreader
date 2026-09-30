import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { mock } from './mock-http-stream';

test('mock fetch preserves request JSON, paths, auth headers, response status and streamed UTF-8 bytes', async t => {
  const server = await mock((body, response, request) => {
    assert.deepEqual(body, { prompt: '中文' }); assert.equal(request.url, '/v1/messages?fixture=1');
    assert.equal(request.method, 'POST'); assert.equal(request.headers['x-api-key'], 'test-only-placeholder');
    response.writeHead(201, { 'Content-Type': 'text/event-stream', 'X-Fixture': 'preserved' });
    const bytes = Buffer.from('first😀second');
    response.write(bytes.subarray(0, 7));
    queueMicrotask(() => response.end(bytes.subarray(7)));
  }); t.after(server.close);
  const result = await fetch(server.url + '/v1/messages?fixture=1', { method: 'POST', headers: { 'X-API-Key': 'test-only-placeholder' }, body: JSON.stringify({ prompt: '中文' }) });
  assert.ok(result instanceof Response); assert.ok(result.body instanceof ReadableStream);
  assert.equal(result.status, 201); assert.equal(result.headers.get('x-fixture'), 'preserved');
  assert.equal(await result.text(), 'first😀second');
});

test('abort before headers rejects the pending fetch and makes late writes harmless', async t => {
  let reached!: () => void, reply: ServerResponse | undefined;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const server = await mock((_body, response) => { reply = response; reached(); }); t.after(server.close);
  const controller = new AbortController();
  const request = fetch(server.url, { method: 'POST', body: '{}', signal: controller.signal });
  await started;
  const rejection = assert.rejects(request, error => error instanceof Error && error.name === 'AbortError');
  controller.abort(); await rejection;
  assert.equal(reply!.write('late'), false); assert.doesNotThrow(() => reply!.end('late end'));
});

test('flushHeaders exposes a streaming response and abort rejects an in-flight body read', async t => {
  let reply: ServerResponse | undefined;
  const server = await mock((_body, response) => {
    reply = response; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
  }); t.after(server.close);
  const controller = new AbortController();
  const response = await fetch(server.url, { method: 'POST', body: '{}', signal: controller.signal });
  const reader = response.body!.getReader();
  const pending = reader.read(), rejection = assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
  controller.abort(); await rejection;
  assert.equal(reply!.write('late chunk'), false); assert.doesNotThrow(() => reply!.end());
});

test('body cancellation stops late writes and closing all mock endpoints restores the exact original fetch', async () => {
  const original = globalThis.fetch;
  let reply: ServerResponse | undefined;
  const first = await mock((_body, response) => { reply = response; response.writeHead(200); response.write('partial'); });
  const second = await mock((_body, response) => { response.end('second'); });
  try {
    const response = await fetch(first.url, { method: 'POST', body: '{}' });
    await response.body!.cancel();
    assert.equal(reply!.write('late'), false);
    first.close(); assert.notEqual(globalThis.fetch, original);
    assert.equal(await (await fetch(second.url, { method: 'POST', body: '{}' })).text(), 'second');
  } finally { first.close(); second.close(); }
  assert.equal(globalThis.fetch, original);
});
