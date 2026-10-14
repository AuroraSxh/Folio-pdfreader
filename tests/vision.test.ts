import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisionCapability, supportsVision } from '../shared/vision';
import { serializeVisionMessages } from '../electron/vision-request';
import { streamCompletion } from '../electron/ai';
import type { ProviderConfig } from '../shared/types';
import { imageDraft, syntheticJPEG } from './image-fixtures';

export const visionProfiles: ProviderConfig[] = [
  { id: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', maxTokens: 4096, apiKey: 'synthetic-key' },
  { id: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1', maxTokens: 4096, apiKey: 'synthetic-key' },
  { id: 'anthropic', baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6', maxTokens: 4096, apiKey: 'synthetic-key' },
  { id: 'custom', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k3', maxTokens: 4096, apiKey: 'synthetic-key' },
  { id: 'custom', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5v-turbo', maxTokens: 4096, apiKey: 'synthetic-key' },
];

test('vision capabilities distinguish confirmed models, text-only/retired models, and unknown routes', () => {
  for (const profile of visionProfiles) {
    assert.equal(getVisionCapability(profile).status, 'supported'); assert.equal(supportsVision(profile), true);
    assert.equal(getVisionCapability({ ...profile, vision: 'disabled' }).status, 'unsupported');
  }
  for (const [profile, model] of [[visionProfiles[0], 'deepseek-reasoner'], [visionProfiles[1], 'gpt-3.5-turbo'], [visionProfiles[2], 'claude-2.1'], [visionProfiles[3], 'kimi-k2-thinking'], [visionProfiles[4], 'glm-4.7'], [visionProfiles[4], 'glm-5.3'], [visionProfiles[4], 'glm-4v-flash']] as const) {
    assert.equal(getVisionCapability({ ...profile, model }).status, 'unsupported', model);
    assert.equal(getVisionCapability({ ...profile, model, vision: 'enabled' }).status, 'unsupported', model);
  }
  const unknown = { ...visionProfiles[1], id: 'custom' as const, model: 'private-vlm', baseURL: 'https://my-gateway.example/v1' };
  assert.equal(getVisionCapability(unknown).status, 'unknown');
  assert.equal(getVisionCapability({ ...unknown, vision: 'enabled' }).status, 'supported');
  assert.equal(getVisionCapability({ ...visionProfiles[4], model: 'glm-future-model' }).status, 'unknown');
  assert.equal(getVisionCapability({ ...visionProfiles[3], baseURL: 'https://api.moonshot.ai/v1' }).status, 'supported');
  assert.equal(getVisionCapability({ ...visionProfiles[4], baseURL: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6v' }).status, 'supported');
});

test('text-only requests preserve their string message shape without testing image capability', () => {
  const messages = [{ role: 'user' as const, content: 'Text question.' }];
  assert.deepEqual(serializeVisionMessages({ ...visionProfiles[0], model: 'deepseek-reasoner' }, messages), messages);
  assert.deepEqual(serializeVisionMessages({ ...visionProfiles[4], model: 'glm-5.3' }, messages), messages);
});

test('official capability list recognizes documented GPT/Claude IDs without inventing family combinations or dates', () => {
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.4-nano', 'gpt-4.1-2025-04-14'])
    assert.equal(getVisionCapability({ ...visionProfiles[1], model }).status, 'supported', model);
  for (const model of ['gpt-5.5-nano', 'gpt-5.2-mini', 'gpt-6-terra', 'gpt-6-astra-2099-01-01', 'gpt-4.1-2099-01-01'])
    assert.equal(getVisionCapability({ ...visionProfiles[1], model }).status, 'unknown', model);
  for (const model of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-5-20251101'])
    assert.equal(getVisionCapability({ ...visionProfiles[2], model }).status, 'supported', model);
  for (const model of ['claude-haiku-5-9', 'claude-sonnet-5-4', 'claude-sonnet-4-6-20990101'])
    assert.equal(getVisionCapability({ ...visionProfiles[2], model }).status, 'unknown', model);
  assert.equal(getVisionCapability({ ...visionProfiles[0], model: 'deepseek-v4-pro' }).status, 'unknown');
  const retired = getVisionCapability({ ...visionProfiles[3], model: 'kimi-k2.5' });
  assert.equal(retired.status, 'unsupported'); assert.match(retired.reason.en, /retired.*historically/);
  assert.equal(retired.docs, 'https://platform.kimi.ai/docs/models');
});

for (const profile of visionProfiles) test(`${profile.model} sends actual PNG/JPEG blocks using the current key, model and chat endpoint`, async t => {
  const first = { ...imageDraft(), source: { documentId: 'main', documentName: 'Main.pdf', page: 2, rect: [0, 0, 20, 30] } };
  const second = imageDraft(syntheticJPEG, 'image/jpeg');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests++; const body = JSON.parse(String(init.body));
    assert.ok(String(url).startsWith(profile.baseURL)); assert.equal(body.model, profile.model);
    assert.equal(new Headers(init.headers).get(profile.id === 'anthropic' ? 'x-api-key' : 'Authorization'), profile.id === 'anthropic' ? 'synthetic-key' : 'Bearer synthetic-key');
    const message = body.messages.at(-1); assert.equal(message.role, 'user'); assert.ok(Array.isArray(message.content));
    assert.equal(message.images, undefined); assert.match(message.content[0].text, /Main.pdf p.2/);
    assert.match(message.content[0].text, /selected region only/); assert.equal(message.content.at(-1).text, 'Compare these plots.');
    if (profile.id === 'anthropic') {
      assert.deepEqual(message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: first.dataUrl.split(',')[1] } });
      assert.equal(message.content[3].source.media_type, 'image/jpeg');
      return new Response('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Visible figure.' } }) + '\n\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    assert.equal(message.content[1].image_url.url, profile.model.startsWith('glm-') ? first.dataUrl.split(',')[1] : first.dataUrl);
    assert.equal(message.content[3].image_url.url, profile.model.startsWith('glm-') ? second.dataUrl.split(',')[1] : second.dataUrl);
    assert.equal(body[profile.id === 'openai' ? 'max_completion_tokens' : 'max_tokens'], profile.maxTokens);
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Visible figure.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const completion = await streamCompletion(profile, [{ role: 'system', content: 'Analyze the visible picture.' }, { role: 'user', content: 'Compare these plots.', images: [first, second] }], new AbortController().signal, () => {}, 1000, 'en');
  assert.equal(completion.text, 'Visible figure.'); assert.equal(requests, 1);
});

test('text model and over-budget images fail before any request; images cannot enter system/assistant roles', async t => {
  let requests = 0; t.mock.method(globalThis, 'fetch', async () => { requests++; throw Error('No network'); });
  const messages = [{ role: 'user' as const, content: 'Question', images: [imageDraft()] }];
  await assert.rejects(streamCompletion({ ...visionProfiles[4], model: 'glm-5.3' }, messages, new AbortController().signal, () => {}), /不支持|does not support/);
  await assert.rejects(streamCompletion(visionProfiles[0], [{ ...messages[0], images: Array.from({ length: 5 }, () => imageDraft()) }], new AbortController().signal, () => {}), /4/);
  for (const role of ['system', 'assistant'] as const) assert.throws(() => serializeVisionMessages(visionProfiles[0], [{ ...messages[0], role }]), /用户|user/);
  assert.equal(requests, 0);
});

test('image request HTTP/stream errors never echo an image payload or the provider credential', async t => {
  const image = imageDraft(), echoed = image.dataUrl + ' synthetic-key ' + image.dataUrl.split(',')[1];
  for (const error of ['http', 'stream'] as const) {
    const mock = t.mock.method(globalThis, 'fetch', async () => error === 'http'
      ? new Response(JSON.stringify({ error: { message: echoed } }), { status: 400 })
      : new Response('data: ' + JSON.stringify({ error: { message: echoed } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await assert.rejects(streamCompletion(visionProfiles[0], [{ role: 'user', content: 'Read it', images: [image] }], new AbortController().signal, () => {}, 1000, 'en'), failure => {
      assert.doesNotMatch(String(failure), /synthetic-key|data:image|iVBOR/); return true;
    }); mock.mock.restore();
  }
});
