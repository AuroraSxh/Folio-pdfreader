import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUSTOM_PROVIDER_PRESETS, apiOrigin, customPresetForURL, hasAPIOriginChanged, requiresReplacementKey, withProviderBaseURL } from '../shared/provider-presets';
import type { ProviderConfig } from '../shared/types';

const custom: ProviderConfig = { id: 'custom', baseURL: 'https://api.moonshot.cn/v1', model: 'my-selected-model', maxTokens: 8192, hasKey: true };

test('custom presets keep regional platforms distinct and avoid Coding Plan endpoints', () => {
  assert.deepEqual(CUSTOM_PROVIDER_PRESETS.map(preset => preset.baseURL), [
    'https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1', 'https://open.bigmodel.cn/api/paas/v4', 'https://api.z.ai/api/paas/v4',
  ]);
  for (const preset of CUSTOM_PROVIDER_PRESETS) {
    assert.equal(new URL(preset.baseURL).protocol, 'https:');
    assert.ok(!preset.baseURL.includes('/coding/'));
    assert.ok(preset.zh && preset.en && preset.docs.startsWith('https://'));
  }
});

test('preset matching allows equivalent URLs without accepting lookalike domains or extra credentials', () => {
  assert.equal(customPresetForURL('https://API.MOONSHOT.CN:443/v1/')?.id, 'kimi-cn');
  assert.equal(customPresetForURL('https://api.moonshot.ai/v1')?.id, 'kimi-global');
  for (const url of ['https://api.moonshot.cn.evil.example/v1', 'https://api.moonshot.cn/v1?token=secret', 'https://user:secret@api.moonshot.cn/v1', 'https://open.bigmodel.cn/api/coding/paas/v4', 'invalid']) {
    assert.equal(customPresetForURL(url), undefined);
  }
});

test('changing an entered credential destination clears only its draft key, retaining the model and truthful saved-key flag', () => {
  const original = { ...custom, apiKey: 'fixture-entered-key' };
  const changed = withProviderBaseURL(original, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(changed.apiKey, undefined); assert.equal(changed.hasKey, true);
  assert.equal(changed.model, original.model); assert.equal(changed.maxTokens, original.maxTokens);
  assert.equal(original.apiKey, 'fixture-entered-key'); assert.equal(original.baseURL, custom.baseURL);
  assert.equal(withProviderBaseURL(original, 'https://api.moonshot.cn/v1/chat/completions').apiKey, original.apiKey);
});

test('origin checks include protocol and port, preserve equivalent origins and clear a key when the URL becomes incomplete', () => {
  assert.equal(apiOrigin('HTTPS://API.MOONSHOT.CN:443/v1/'), 'https://api.moonshot.cn');
  assert.equal(hasAPIOriginChanged(custom.baseURL, 'https://api.moonshot.cn/v2'), false);
  assert.equal(hasAPIOriginChanged(custom.baseURL, 'https://api.moonshot.cn:8443/v1'), true);
  assert.equal(hasAPIOriginChanged('http://127.0.0.1:11434/v1', 'http://127.0.0.1:8080/v1'), true);
  assert.equal(withProviderBaseURL({ ...custom, apiKey: 'draft-key' }, 'https://').apiKey, undefined);
});

test('a saved key cannot be reused on another origin without a nonblank key explicitly entered for it', () => {
  const target = { ...custom, baseURL: 'https://api.moonshot.ai/v1' };
  assert.equal(requiresReplacementKey(custom, target), true);
  assert.equal(requiresReplacementKey(custom, { ...target, apiKey: ' \n ' }), true);
  assert.equal(requiresReplacementKey(custom, { ...target, apiKey: 'explicit-new-key' }), false);
  assert.equal(requiresReplacementKey(custom, { ...custom, apiKey: undefined }), false);
  assert.equal(requiresReplacementKey({ ...custom, hasKey: false }, target), false);
  assert.equal(requiresReplacementKey({ ...custom, hasKey: false, apiKey: 'backend-hidden-key' }, target), true);
});
