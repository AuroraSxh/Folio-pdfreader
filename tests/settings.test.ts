import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as storeModule from '../electron/store';
import { loadBackendModule } from './backend-harness';
import type { ProviderId, Settings } from '../shared/types';

const { SettingsStore } = await loadBackendModule<typeof import('../electron/settings')>('electron/settings.ts', { electron: { safeStorage: undefined }, './store': storeModule });
async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pairleaf-settings-origin-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = { encrypted: 0, decrypted: 0 };
  const storage = { isEncryptionAvailable: () => true,
    encryptString: (value: string) => { calls.encrypted++; return Buffer.from('test-cipher:' + value); },
    decryptString: (value: Buffer) => { calls.decrypted++; return value.toString().replace(/^test-cipher:/, ''); },
  };
  const store = new SettingsStore(directory, '/isolated-library', storage); await store.init();
  return { directory, store, calls, storage };
}

test('saved credentials cannot silently move to a different provider origin through direct settings IPC', async t => {
  const { store, directory, calls } = await fixture(t);
  const original = store.public();
  original.providers.custom.baseURL = 'https://api.moonshot.cn/v1';
  original.providers.custom.apiKey = 'original-fixture-key';
  await store.save(original);
  const diskBefore = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
  for (const apiKey of [undefined, '', '  ']) {
    const changed = store.public(); changed.providers.custom.baseURL = 'https://open.bigmodel.cn/api/paas/v4'; changed.providers.custom.apiKey = apiKey;
    await assert.rejects(store.save(changed), /重新填写.*API Key/);
    assert.equal(store.get().providers.custom.baseURL, 'https://api.moonshot.cn/v1');
    assert.equal(store.get().providers.custom.apiKey, 'original-fixture-key');
    assert.equal(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'), diskBefore);
  }
  assert.equal(calls.encrypted, 1);
});

test('explicit replacement key commits the new origin and survives a restart without exposing plaintext in public settings', async t => {
  const { store, directory, storage } = await fixture(t);
  const original = store.public(); original.providers.custom.baseURL = 'https://api.moonshot.cn/v1'; original.providers.custom.apiKey = 'first-fixture-key';
  await store.save(original);
  const changed = store.public(); changed.providers.custom.baseURL = 'https://api.moonshot.ai/v1'; changed.providers.custom.apiKey = ' regional-replacement-key ';
  const saved = await store.save(changed);
  assert.equal(saved.providers.custom.baseURL, 'https://api.moonshot.ai/v1'); assert.equal(saved.providers.custom.hasKey, true); assert.equal(saved.providers.custom.apiKey, undefined);
  const restarted = new SettingsStore(directory, '/isolated-library', storage); await restarted.init();
  assert.equal(restarted.get().providers.custom.apiKey, 'regional-replacement-key');
  const disk = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.equal(disk.providers.custom.apiKey, undefined); assert.ok(disk.providers.custom.encryptedKey);
});

test('same-origin path and model edits preserve blank-key behavior without reencryption', async t => {
  const { store, calls } = await fixture(t);
  const original = store.public(); original.providers.custom.baseURL = 'https://api.moonshot.cn/v1'; original.providers.custom.apiKey = 'stable-fixture-key';
  await store.save(original);
  const changed = store.public(); changed.providers.custom.baseURL = 'https://API.MOONSHOT.CN:443/v1/chat/completions/'; changed.providers.custom.model = 'kimi-k3';
  await store.save(changed);
  assert.equal(store.get().providers.custom.apiKey, 'stable-fixture-key'); assert.equal(calls.encrypted, 1);
});

test('the origin guard applies to every provider even when it is not the active provider and uses the requested language', async t => {
  const { store } = await fixture(t);
  const original = store.public(); original.language = 'en';
  for (const id of Object.keys(original.providers) as ProviderId[]) original.providers[id].apiKey = 'fixture-key-' + id;
  await store.save(original);
  for (const id of Object.keys(original.providers) as ProviderId[]) {
    const changed = store.public(); changed.providers[id].baseURL = 'https://different-provider.example/v1';
    await assert.rejects(store.save(changed), /another provider or region.*API key/);
  }
});

test('uncredentialed local providers can change origins without requiring an API key', async t => {
  const { store, calls } = await fixture(t);
  const changed = store.public(); changed.providers.custom.baseURL = 'http://127.0.0.1:8080/v1';
  await store.save(changed);
  assert.equal(store.get().providers.custom.baseURL, 'http://127.0.0.1:8080/v1');
  assert.equal(store.get().providers.custom.apiKey, undefined); assert.equal(calls.encrypted, 0);
});

test('old and invalid update-source settings migrate to auto while valid explicit sources survive loading', async t => {
  const { store, directory, storage, calls } = await fixture(t);
  assert.equal(store.public().updateSource, 'auto');
  for (const [value, expected] of [
    [undefined, 'auto'], [null, 'auto'], ['mirror', 'auto'], ['GITEE', 'auto'], [42, 'auto'], [{}, 'auto'],
    ['auto', 'auto'], ['gitee', 'gitee'], ['github', 'github'],
  ] as const) {
    await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ updateSource: value, autoCheckUpdates: false, annotationToolbar: 'fixed' }));
    const loaded = new SettingsStore(directory, '/isolated-library', storage); await loaded.init();
    assert.equal(loaded.public().updateSource, expected);
    assert.equal(loaded.public().autoCheckUpdates, false);
    assert.equal(loaded.public().annotationToolbar, 'fixed');
  }
  assert.deepEqual(calls, { encrypted: 0, decrypted: 0 });
});

test('update-source preferences persist and restart without changing AI keys, reading preferences, or language', async t => {
  const { store, directory, storage, calls } = await fixture(t);
  const original = store.public(); original.providers.deepseek.apiKey = 'update-source-fixture-key';
  original.language = 'en'; original.annotationToolbar = 'selection'; original.uiFontScale = 1.3;
  await store.save(original);
  const keyBefore = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).providers.deepseek.encryptedKey;
  for (const updateSource of ['gitee', 'github', 'auto'] as const) {
    const saved = await store.save({ ...store.public(), updateSource });
    assert.equal(saved.updateSource, updateSource);
    assert.equal(saved.providers.deepseek.apiKey, undefined); assert.equal(saved.providers.deepseek.hasKey, true);
    const disk = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
    assert.equal(disk.updateSource, updateSource);
    assert.equal(disk.providers.deepseek.encryptedKey, keyBefore);
    const restarted = new SettingsStore(directory, '/isolated-library', storage); await restarted.init();
    assert.equal(restarted.public().updateSource, updateSource);
    assert.equal(restarted.get().providers.deepseek.apiKey, 'update-source-fixture-key');
    assert.equal(restarted.public().annotationToolbar, 'selection');
    assert.equal(restarted.public().uiFontScale, 1.3); assert.equal(restarted.public().language, 'en');
  }
  assert.equal(calls.encrypted, 1);
});

test('invalid update-source values are normalized before persistence and failed saves do not commit a source change', async t => {
  const { store, directory } = await fixture(t);
  await fs.mkdir(path.join(directory, 'settings.json'));
  await assert.rejects(store.save({ ...store.public(), updateSource: 'gitee' }));
  assert.equal(store.public().updateSource, 'auto');
  await fs.rmdir(path.join(directory, 'settings.json'));
  await store.save({ ...store.public(), updateSource: 'gitee' });
  assert.equal(store.public().updateSource, 'gitee');
  for (const invalid of [undefined, null, 'Gitee', 'https://untrusted.example/releases', true, {}]) {
    await store.save({ ...store.public(), updateSource: invalid as Settings['updateSource'] });
    assert.equal(store.public().updateSource, 'auto');
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).updateSource, 'auto');
  }
});
