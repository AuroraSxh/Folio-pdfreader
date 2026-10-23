import assert from 'node:assert/strict';
import test from 'node:test';
import { QODER_MODELS, getQoderModel, isQoderEndpoint, qoderEndpoint, qoderReasoningFields } from '../shared/qoder';
import { getVisionCapability } from '../shared/vision';
import { serializeVisionMessages } from '../electron/vision-request';
import { imageDraft } from './image-fixtures';
import type { ProviderConfig, ReasoningEffort } from '../shared/types';

const config = (model: string): ProviderConfig => ({ id: 'qoder', baseURL: 'http://127.0.0.1:8788/v1', model, maxTokens: 4096 });

test('the Qoder catalog covers all current aliases and distinguishes tiered, binary, and unadvertised thinking', () => {
  assert.deepEqual(QODER_MODELS.map(model => model.id).sort(), ['auto','dmodel','dfmodel','gmodel','gfmodel','gm51model','kmodel_latest','kmodel','mmodel','qmodel_38max','qfmodel','qmodel_latest','qmodel','q37fmodel'].sort());
  assert.equal(new Set(QODER_MODELS.map(model => model.id)).size, 14);
  for (const model of QODER_MODELS) {
    const c = config(model.id), expected = model.defaultEffort ? { reasoning_effort: model.defaultEffort } : model.canEnable ? { thinking: { type: 'enabled' } } : {};
    assert.deepEqual(qoderReasoningFields(c), expected);
    if (model.id === 'qmodel_38max' || model.id === 'qfmodel') assert.equal(model.defaultEffort, 'xhigh');
    for (const level of ['low','medium','high','xhigh','max'] as ReasoningEffort[]) {
      if (model.efforts.includes(level)) assert.deepEqual(qoderReasoningFields({ ...c, reasoningEffort: level }), { reasoning_effort: level });
      else assert.throws(() => qoderReasoningFields({ ...c, reasoningEffort: level }, 'en'), /does not support/);
    }
    if (model.canDisable) assert.deepEqual(qoderReasoningFields({ ...c, thinking: false }), model.efforts.length ? { reasoning_effort: 'none' } : { thinking: { type: 'disabled' } });
    else assert.throws(() => qoderReasoningFields({ ...c, thinking: false }, 'en'), /disabling thinking/);
  }
  assert.equal(getQoderModel('invented-model'), undefined);
  assert.throws(() => qoderReasoningFields(config('invented-model'), 'en'), /Unknown Qoder model/);
});

test('Qoder credentials are limited to explicit loopback HTTP protocol routes', () => {
  for (const url of ['http://127.0.0.1:8788/v1', 'http://localhost:9000/v1/', 'http://[::1]:8788/v1/chat/completions', 'HTTP://LOCALHOST/v1']) {
    assert.equal(isQoderEndpoint(url), true, url);
    assert.equal(new URL(qoderEndpoint(url)).pathname, '/v1/chat/completions');
  }
  for (const url of ['https://127.0.0.1:8788/v1','http://192.168.1.4:8788/v1','http://proxy.example/v1','http://127.1/v1','http://2130706433/v1','http://0x7f000001/v1','http://localhost.evil/v1','http://user:pass@localhost/v1','http://localhost/v1?token=hidden','http://localhost/v1#other','http://localhost/v1/../elsewhere','http://localhost:65536/v1','http://localhost:0/v1','http://localhost/v1/responses','file:///v1']) {
    assert.equal(isQoderEndpoint(url), false, url);
    assert.throws(() => qoderEndpoint(url, 'en'), /loopback/, url);
  }
});

test('Qoder vision uses local model capabilities; a manual override never enables images for MiniMax', () => {
  const image = imageDraft();
  for (const model of QODER_MODELS) {
    const c = config(model.id);
    assert.equal(getVisionCapability(c).status, model.id === 'mmodel' ? 'unsupported' : 'supported');
    if (model.vision) {
      const messages = serializeVisionMessages(c, [{ role: 'user', content: 'Explain the synthetic figure.', images: [image] }]);
      assert.equal((messages[0].content as Record<string, any>[])[1].image_url.url, image.dataUrl);
    } else {
      assert.throws(() => serializeVisionMessages({ ...c, vision: 'enabled' }, [{ role: 'user', content: 'Figure', images: [image] }], 'en'), /does not enable image/);
    }
    assert.equal(getVisionCapability({ ...c, vision: 'disabled' }).status, 'unsupported');
  }
  assert.equal(getVisionCapability({ ...config('kmodel_latest'), baseURL: 'https://outside.example/v1', vision: 'enabled' }).status, 'unsupported');
  assert.equal(getVisionCapability(config('unknown')).status, 'unknown');
});
