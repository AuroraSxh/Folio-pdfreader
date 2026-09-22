import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as storeModule from '../electron/store';
import { loadBackendModule } from './backend-harness';
const { SettingsStore, defaultSettings } = await loadBackendModule<typeof import('../electron/settings')>('electron/settings.ts', { electron: { safeStorage: undefined }, './store': storeModule });

function fakeStorage() {
  const calls = { available: 0, encrypt: 0, decrypt: 0 };
  return { calls, secure: {
    isEncryptionAvailable: () => { calls.available++; return true; },
    encryptString: (value: string) => { calls.encrypt++; return Buffer.from(`test-cipher:${value}`); },
    decryptString: (value: Buffer) => { calls.decrypt++; return value.toString().replace(/^test-cipher:/, ''); },
  } };
}
async function temporary(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-settings-locale-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('legacy and unsupported locale settings use Chinese and preserve explicit update opt-out', async t => {
  const directory = await temporary(t), storage = fakeStorage();
  for (const language of [undefined, 'fr', null, 42]) {
    await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ language, autoCheckUpdates: false }));
    const store = new SettingsStore(directory, '/isolated-library', storage.secure); await store.init();
    assert.equal(store.getLanguage(), 'zh-CN'); assert.equal(store.public().autoCheckUpdates, false);
  }
  await fs.writeFile(path.join(directory, 'settings.json'), '{}');
  const migrated = new SettingsStore(directory, '/isolated-library', storage.secure); await migrated.init();
  assert.equal(migrated.public().autoCheckUpdates, true);
  assert.deepEqual(storage.calls, { available: 0, encrypt: 0, decrypt: 0 });
});

test('language and update preference persist without encrypting unchanged keys again', async t => {
  const directory = await temporary(t), storage = fakeStorage();
  const store = new SettingsStore(directory, '/isolated-library', storage.secure); await store.init();
  const input = store.public(); input.providers.deepseek.apiKey = 'dummy-local-key'; await store.save(input);
  const firstDisk = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
  const changed = store.public(); changed.language = 'en'; changed.autoCheckUpdates = false;
  const saved = await store.save(changed);
  assert.equal(saved.language, 'en'); assert.equal(saved.autoCheckUpdates, false); assert.equal(saved.providers.deepseek.apiKey, undefined);
  const disk = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.equal(disk.providers.deepseek.encryptedKey, firstDisk.providers.deepseek.encryptedKey);
  assert.equal(disk.providers.deepseek.apiKey, undefined); assert.deepEqual(storage.calls, { available: 1, encrypt: 1, decrypt: 0 });
  const restarted = new SettingsStore(directory, '/isolated-library', storage.secure); await restarted.init();
  assert.equal(restarted.getLanguage(), 'en'); assert.equal(restarted.get().providers.deepseek.apiKey, 'dummy-local-key');
  await restarted.save({ ...restarted.public(), language: 'zh-CN' });
  assert.deepEqual(storage.calls, { available: 1, encrypt: 1, decrypt: 1 });
});

test('failed atomic settings write does not commit language or poison the save queue', async t => {
  const directory = await temporary(t), storage = fakeStorage();
  const store = new SettingsStore(directory, '/isolated-library', storage.secure); await store.init();
  await fs.mkdir(path.join(directory, 'settings.json'));
  await assert.rejects(store.save({ ...store.public(), language: 'en', autoCheckUpdates: false }));
  assert.equal(store.getLanguage(), 'zh-CN'); assert.equal(store.get().autoCheckUpdates, true);
  await fs.rmdir(path.join(directory, 'settings.json'));
  await store.save({ ...store.public(), language: 'en', autoCheckUpdates: false });
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).language, 'en');
  assert.deepEqual(storage.calls, { available: 0, encrypt: 0, decrypt: 0 });
});

test('settings errors follow requested locale without changing the committed configuration', async t => {
  const directory = await temporary(t), storage = fakeStorage();
  const store = new SettingsStore(directory, '/isolated-library', storage.secure); await store.init();
  const invalid = defaultSettings('/isolated-library'); invalid.language = 'en'; invalid.providers.deepseek.baseURL = 'http://example.com';
  await assert.rejects(store.save(invalid), /must use HTTPS/); assert.equal(store.getLanguage(), 'zh-CN');
  invalid.language = 'zh-CN'; await assert.rejects(store.save(invalid), /须使用 HTTPS/);
  const missingVault = { ...store.public(), language: 'en' as const, vaultPath: path.join(directory, 'absent-vault') };
  await assert.rejects(store.save(missingVault), /vault folder does not exist/);
});
