import assert from 'node:assert/strict';
import test from 'node:test';
import { detectUpdateRegion, parseUpdateRegion, UPDATE_REGION_URL } from '../electron/update-region';

function reply(body: BodyInit | null, url = UPDATE_REGION_URL, init: ResponseInit = {}) {
  const response = new Response(body, init); Object.defineProperty(response, 'url', { value: url }); return response;
}
test('only the unique valid loc country determines download region, never colo, language or timezone', () => {
  assert.equal(parseUpdateRegion('loc=CN\ncolo=SJC\n'), 'CN');
  for (const country of ['US', 'HK', 'TW', 'MO', 'SG', 'DE']) assert.equal(parseUpdateRegion(`loc=${country}\ncolo=PEK`), 'other');
  for (const body of ['colo=PEK', 'loc=XX', 'loc=ZZ', 'loc=T1', 'loc=cn', 'loc=CN\nloc=US', 'loc=CN extra']) assert.equal(parseUpdateRegion(body), 'unknown');
});
test('anonymous country check strips all other trace information from its result', async () => {
  const fetcher = (async (url, init) => {
    assert.equal(url, UPDATE_REGION_URL); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers); assert.equal(headers.has('authorization'), false); assert.equal(headers.has('cookie'), false);
    return reply('ip=192.0.2.1\nloc=CN\ncolo=ANY\n');
  }) as typeof fetch;
  assert.equal(await detectUpdateRegion(fetcher, new AbortController().signal), 'CN');
});
test('unavailable, redirected, oversized and interrupted country checks return unknown', async () => {
  for (const response of [reply('loc=CN', UPDATE_REGION_URL, { status: 429 }), reply('loc=CN', 'https://example.org/trace'), reply('loc=CN', UPDATE_REGION_URL, { headers: { 'content-length': '9999' } }), reply('loc=CN\n' + 'x'.repeat(8192))]) {
    assert.equal(await detectUpdateRegion((async () => response) as typeof fetch, new AbortController().signal), 'unknown');
  }
  const controller = new AbortController();
  const result = detectUpdateRegion((async () => new Promise(() => {})) as typeof fetch, controller.signal);
  controller.abort(); assert.equal(await result, 'unknown');
  assert.equal(await detectUpdateRegion((async () => { throw new Error('network'); }) as typeof fetch, new AbortController().signal), 'unknown');
});
