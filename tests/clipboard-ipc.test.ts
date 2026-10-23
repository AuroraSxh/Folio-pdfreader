import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBackendModule } from './backend-harness';

async function harness(platform: 'darwin' | 'win32' = 'darwin') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const frame = { url: pathToFileURL(path.join(root, 'dist/index.html')).href };
  const webContents = { mainFrame: frame }, window = { webContents };
  const reads: unknown[][] = [], writes: string[] = [];
  let text = '', failure: Error | undefined, writeFailure: Error | undefined, language = 'en';
  let writeReady: Promise<void> = Promise.resolve();
  const electron = {
    app: { setName() {}, setPath() {}, setAboutPanelOptions() {}, getPath: () => '/isolated-clipboard-ipc', getVersion: () => 'test', requestSingleInstanceLock: () => true, setAppUserModelId() {}, on() {}, quit() {}, whenReady: () => new Promise(() => {}) },
    BrowserWindow: class { constructor() { throw Error('No GUI in clipboard IPC tests'); } },
    ipcMain: { on() {}, handle: (name: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(name, handler) },
    clipboard: {
      readText: async (...args: unknown[]) => { reads.push(args); if (failure) throw failure; return text; },
      writeText: async (value: string) => { await writeReady; if (writeFailure) throw writeFailure; writes.push(value); },
    },
    Menu: {}, shell: {}, dialog: {},
  };
  const main = await loadBackendModule<{ testClipboard: { registerIPC(): void; setState(window: unknown, settings: unknown): void } }>(
    'electron/main.ts', { electron, './settings': {}, './voice': {}, './ai': {}, './obsidian': {}, './pdf-export': {}, './updater': {} },
    'export const testClipboard={registerIPC,setState(w:any,s:any){window=w;settings=s;}};',
    { ...process, platform, env: { FOLIO_USER_DATA: '/isolated-clipboard-ipc' }, argv: ['Pairleaf'] } as NodeJS.Process,
  );
  main.testClipboard.setState(window, { getLanguage: () => language }); main.testClipboard.registerIPC();
  const event = { sender: webContents, senderFrame: frame };
  return { handlers, frame, webContents, reads, writes, event,
    invoke: (name: string, ...args: unknown[]) => handlers.get(`folio:${name}`)!(event, ...args),
    setText: (value: string) => { text = value; }, setFailure: (value: Error) => { failure = value; }, setLanguage: (value: string) => { language = value; },
    setWriteReady: (value: Promise<void>) => { writeReady = value; }, setWriteFailure: (value: Error) => { writeFailure = value; },
  };
}

test('native clipboard reads require the trusted application main frame before accessing any text', async () => {
  const h = await harness();
  for (const channel of ['read-clipboard-text', 'copy-text']) {
    const handler = h.handlers.get(`folio:${channel}`)!; assert.ok(handler);
    for (const event of [
      { sender: {}, senderFrame: h.frame },
      { sender: h.webContents, senderFrame: { ...h.frame } },
      { sender: h.webContents, senderFrame: null },
    ]) await assert.rejects(handler(event, 'synthetic text'), /Unauthorized/);
    const original = h.frame.url;
    h.frame.url = 'https://untrusted.example/';
    await assert.rejects(handler(h.event, 'synthetic text'), /Unauthorized/);
    h.frame.url = original;
  }
  assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
});

test('native clipboard returns empty and multilingual text unchanged on Mac and Windows, with a UTF-8 byte limit', async () => {
  const limit = 5 * 1024 * 1024;
  const atLimit = '中'.repeat(Math.floor(limit / 3)) + 'a'.repeat(limit % 3);
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), limit);
  for (const platform of ['darwin', 'win32'] as const) {
    const h = await harness(platform);
    assert.equal(await h.invoke('read-clipboard-text'), '');
    const value = '合成测试 αβ 🧪\r\nsecond line'; h.setText(value);
    assert.equal(await h.invoke('read-clipboard-text'), value);
    h.setText(atLimit); assert.equal(await h.invoke('read-clipboard-text'), atLimit);
    h.setText(atLimit + '🧪');
    await assert.rejects(h.invoke('read-clipboard-text'), /Clipboard text exceeds 5 MB/);
    h.setLanguage('zh-CN'); await assert.rejects(h.invoke('read-clipboard-text'), /剪贴板文字超过 5 MB/);
    assert.ok(h.reads.every(args => args.length === 0), 'IPC cannot select another clipboard or format');
    assert.equal(h.writes.length, 0, 'Reading must not modify the clipboard');
  }
});

test('clipboard failures disclose no native details and copyText keeps its native validated write path', async () => {
  const h = await harness(); h.setFailure(new Error('synthetic-private-clipboard-content'));
  await assert.rejects(h.invoke('read-clipboard-text'), error => {
    assert.match(String(error), /Unable to read the clipboard/); assert.doesNotMatch(String(error), /synthetic-private/); return true;
  });
  h.setLanguage('zh-CN'); await assert.rejects(h.invoke('read-clipboard-text'), /无法读取剪贴板/);
  for (const value of [undefined, null, {}, '中'.repeat(Math.ceil(5 * 1024 * 1024 / 3))])
    await assert.rejects(h.invoke('copy-text', value), /5 MB/);
  assert.equal(h.writes.length, 0);
  await h.invoke('copy-text', 'copied 合成文字'); assert.deepEqual(h.writes, ['copied 合成文字']);
});

test('preload exposes a no-argument text read and preserves copyText without a generic clipboard API', async () => {
  let exposed: Record<string, any> | undefined;
  const calls: unknown[][] = [];
  await loadBackendModule('electron/preload.ts', { electron: {
    contextBridge: { exposeInMainWorld: (name: string, api: Record<string, any>) => { assert.equal(name, 'folio'); exposed = api; } },
    ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); return args[0] === 'folio:read-clipboard-text' ? 'synthetic text' : undefined; } }, webUtils: {},
  } });
  assert.equal(await exposed!.readClipboardText('html', 'selection'), 'synthetic text');
  assert.deepEqual(calls, [['folio:read-clipboard-text']]);
  await exposed!.copyText('synthetic copy'); assert.deepEqual(calls.at(-1), ['folio:copy-text', 'synthetic copy']);
  assert.equal(exposed!.clipboard, undefined); assert.equal(exposed!.readClipboard, undefined); assert.equal(exposed!.readClipboardImage, undefined);
});

test('copyText IPC waits for the asynchronous native write and surfaces a rejected write', async () => {
  const h = await harness();
  let release!: () => void, completed = false;
  h.setWriteReady(new Promise<void>(resolve => { release = resolve; }));
  const copying = h.invoke('copy-text', 'synthetic delayed copy').then(() => { completed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false); assert.equal(h.writes.length, 0);
  release(); await copying; assert.equal(completed, true); assert.deepEqual(h.writes, ['synthetic delayed copy']);
  h.setWriteFailure(new Error('Synthetic clipboard write failure'));
  await assert.rejects(h.invoke('copy-text', 'must not succeed'), /Synthetic clipboard write failure/);
  assert.equal(h.writes.length, 1);
});
