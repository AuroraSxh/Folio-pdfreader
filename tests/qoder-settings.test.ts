import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as storeModule from '../electron/store';
import { loadBackendModule } from './backend-harness';
import { QODER_MODELS, qoderReasoningFields } from '../shared/qoder';
import type { Settings } from '../shared/types';

const { SettingsStore } = await loadBackendModule<typeof import('../electron/settings')>('electron/settings.ts', { electron: { safeStorage: undefined }, './store': storeModule });
async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pairleaf-qoder-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = { encrypted: 0, decrypted: 0, available: true };
  const storage = { isEncryptionAvailable: () => calls.available,
    encryptString: (text: string) => { calls.encrypted++; return Buffer.from('synthetic-cipher:' + text); },
    decryptString: (bytes: Buffer) => { calls.decrypted++; assert.ok(bytes.toString().startsWith('synthetic-cipher:')); return bytes.toString().slice('synthetic-cipher:'.length); },
  };
  const store = new SettingsStore(directory, '/synthetic-library', storage); await store.init();
  return { store, directory, storage, calls, disk: async () => JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')) };
}
function choose(input: Settings, model: string, key?: string): Settings {
  const known = QODER_MODELS.find(item => item.id === model)!;
  input.activeProvider = 'qoder'; input.providers.qoder = { ...input.providers.qoder, model, apiKey: key, thinking: undefined, reasoningEffort: known.defaultEffort };
  return input;
}

test('each Qoder model keeps its own encrypted key; selecting another model never reuses the previous key', async t => {
  const h = await fixture(t);
  const first = await h.store.save(choose(h.store.public(), 'kmodel_latest', 'synthetic-kimi-credential'));
  assert.equal(first.providers.qoder.hasKey, true); assert.deepEqual(first.providers.qoder.modelKeyStatus, { kmodel_latest: true });
  const other = await h.store.save(choose(h.store.public(), 'dmodel'));
  assert.equal(other.providers.qoder.hasKey, false); assert.equal(h.store.get().providers.qoder.apiKey, undefined);
  await h.store.save(choose(h.store.public(), 'dmodel', 'synthetic-deepseek-credential'));
  await h.store.save(choose(h.store.public(), 'kmodel_latest'));
  assert.equal(h.store.get().providers.qoder.apiKey, 'synthetic-kimi-credential');
  const publicSettings = h.store.public(), disk = await h.disk();
  assert.equal(publicSettings.providers.qoder.apiKey, undefined);
  assert.deepEqual(publicSettings.providers.qoder.modelKeyStatus, { kmodel_latest: true, dmodel: true });
  assert.doesNotMatch(JSON.stringify(publicSettings), /synthetic-(kimi|deepseek)-credential|modelKeys|encryptedKey/);
  assert.equal(disk.providers.qoder.apiKey, undefined); assert.equal(disk.providers.qoder.hasKey, undefined); assert.equal(disk.providers.qoder.modelKeyStatus, undefined);
  assert.equal(Object.keys(disk.providers.qoder.modelKeys).length, 2); assert.equal(h.calls.encrypted, 2);
  const restored = new SettingsStore(h.directory, '/synthetic-library', h.storage); await restored.init();
  assert.equal(restored.get().providers.qoder.apiKey, 'synthetic-kimi-credential');
  await restored.save(choose(restored.public(), 'dmodel'));
  assert.equal(restored.get().providers.qoder.apiKey, 'synthetic-deepseek-credential');
  assert.equal(h.calls.encrypted, 2);
});

test('every Qoder model survives save and restart without inheriting another model’s thinking tier', async t => {
  const h = await fixture(t);
  for (const model of QODER_MODELS) {
    await h.store.save(choose(h.store.public(), model.id, 'synthetic-credential-for-' + model.id));
    const stored = (await h.disk()).providers.qoder;
    if (!model.defaultEffort) assert.equal(stored.reasoningEffort, undefined);
    const restored = new SettingsStore(h.directory, '/synthetic-library', h.storage); await restored.init();
    const config = restored.get().providers.qoder;
    assert.equal(config.model, model.id); assert.equal(config.apiKey, 'synthetic-credential-for-' + model.id);
    assert.equal(config.reasoningEffort, model.defaultEffort);
    assert.deepEqual(qoderReasoningFields(config), qoderReasoningFields({ model: model.id }));
    await restored.save(restored.public());
  }
});

test('changing a Qoder proxy origin requires a replacement even when the selected model has no key', async t => {
  const h = await fixture(t);
  await h.store.save(choose(h.store.public(), 'kmodel_latest', 'synthetic-old-origin-key'));
  await h.store.save(choose(h.store.public(), 'mmodel'));
  const before = await h.disk(), draft = h.store.public();
  assert.equal(draft.providers.qoder.hasKey, false);
  draft.providers.qoder.baseURL = 'http://127.0.0.1:9898/v1';
  await assert.rejects(h.store.save(draft), /重新填写/);
  assert.deepEqual(await h.disk(), before);
  draft.providers.qoder.apiKey = 'synthetic-new-origin-key';
  await h.store.save(draft);
  assert.deepEqual(h.store.public().providers.qoder.modelKeyStatus, { mmodel: true });
  await h.store.save(choose(h.store.public(), 'kmodel_latest'));
  assert.equal(h.store.get().providers.qoder.apiKey, undefined);
  assert.equal((await h.disk()).providers.qoder.modelKeys.kmodel_latest, undefined);
});

test('Qoder validates native protocol controls and commits its key cache only after atomic persistence', async t => {
  const h = await fixture(t);
  for (const patch of [{ baseURL: 'http://proxy.example/v1' }, { model: 'unknown' }, { model: 'kmodel_latest', thinking: false }, { model: 'qmodel_38max', reasoningEffort: 'max' }]) {
    const draft = h.store.public(); Object.assign(draft.providers.qoder, patch);
    await assert.rejects(h.store.save(draft)); assert.deepEqual(h.store.public().providers.qoder.modelKeyStatus, {});
  }
  const draft = choose(h.store.public(), 'dmodel', 'synthetic-failed-write');
  await fs.mkdir(path.join(h.directory, 'settings.json'));
  await assert.rejects(h.store.save(draft));
  assert.equal(h.store.get().providers.qoder.apiKey, undefined); assert.deepEqual(h.store.public().providers.qoder.modelKeyStatus, {});
  await fs.rmdir(path.join(h.directory, 'settings.json'));
  h.calls.available = false; await assert.rejects(h.store.save(draft), /安全存储/);
  assert.equal(h.store.get().providers.qoder.apiKey, undefined);
  h.calls.available = true; await h.store.save(draft);
  assert.equal(h.store.get().providers.qoder.apiKey, 'synthetic-failed-write');
});

test('legacy settings gain Qoder defaults without migrating other providers’ credentials', async t => {
  const h = await fixture(t);
  const legacy = h.store.public(); delete (legacy.providers as Partial<Settings['providers']>).qoder;
  legacy.providers.custom.apiKey = 'synthetic-legacy-custom-key';
  await h.store.save(legacy);
  const disk = await h.disk(); delete disk.providers.qoder;
  await fs.writeFile(path.join(h.directory, 'settings.json'), JSON.stringify(disk));
  const restored = new SettingsStore(h.directory, '/synthetic-library', h.storage); await restored.init();
  assert.equal(restored.get().providers.custom.apiKey, 'synthetic-legacy-custom-key');
  assert.equal(restored.get().providers.qoder.model, 'kmodel_latest');
  assert.equal(restored.get().providers.qoder.apiKey, undefined);
  assert.deepEqual(restored.public().providers.qoder.modelKeyStatus, {});
});
