import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as storeModule from '../electron/store';
import * as desktop from '../electron/desktop';
import * as i18n from '../shared/i18n';
import { loadBackendModule } from './backend-harness';
import type { Settings } from '../shared/types';
import type { UpdateStatus } from '../shared/updates';

const { SettingsStore } = await loadBackendModule<typeof import('../electron/settings')>('electron/settings.ts', { electron: { safeStorage: undefined }, './store': storeModule });
const root = fileURLToPath(new URL('../', import.meta.url));
async function harness(t: test.TestContext, platform: NodeJS.Platform = 'darwin', options: { portable?: boolean; packaged?: boolean; isolated?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-main-locale-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(directory, path.join(directory, 'Library'), {
    isEncryptionAvailable: () => { throw new Error('Unexpected secure-storage access'); },
    encryptString: () => { throw new Error('Unexpected secure-storage access'); },
    decryptString: () => { throw new Error('Unexpected secure-storage access'); },
  }); await settings.init();
  const library = new storeModule.LibraryStore(path.join(directory, 'Library')); await library.init();
  const handlers = new Map<string, (...args: any[]) => any>(), menus: any[][] = [], dialogs: any[] = [], sent: any[][] = [], opened: string[] = [], revealed: string[] = [], calls: string[] = [], timers: { callback: () => void; delay: number }[] = [];
  let quits = 0, updateHost: any, openError = '';
  const voiceCalls: any[] = []; let voiceInstances = 0;
  const voiceFactory = (options: any) => { voiceInstances++; return { capabilities: async (locale: string) => { voiceCalls.push(['capabilities', locale]); return { available:true,engine:'speech-analyzer',locales:['zh-CN'],voices:[] }; }, listen: async (value: any) => { voiceCalls.push(['listen', value]); options.emit({sessionId:value.sessionId,type:'listening'}); }, stopListening: async (id: string) => { voiceCalls.push(['stop',id]);return {text:'测试'}; }, speak: async (value: any) => { voiceCalls.push(['speak',value]); }, stopSpeaking: async () => { voiceCalls.push(['stop-speaking']); }, dispose: async () => { voiceCalls.push(['dispose']); } }; };
  const status: UpdateStatus = { phase: 'idle', currentVersion: '0.3.0' };
  const updater = { getStatus: () => status, check: async (force: boolean) => { calls.push(`check:${force}`); return status; }, download: async () => { calls.push('download'); return status; }, cancel: async () => { calls.push('cancel'); return status; }, install: async () => { calls.push('install'); await updateHost.flush(); await updateHost.openInstaller('/isolated/Folio-download'); return status; }, dispose: async () => { calls.push('dispose'); } };
  const mainFrame = { url: pathToFileURL(path.join(root, 'dist/index.html')).href };
  const webContents = { mainFrame, send: (...args: any[]) => sent.push(args) };
  const window = { webContents, isDestroyed: () => false };
  const electron = {
    app: { setName() {}, setPath() {}, getPath: () => directory, getVersion: () => '0.3.0', requestSingleInstanceLock: () => true, setAppUserModelId() {}, on() {}, quit: () => { quits++; }, whenReady: () => new Promise(() => {}), isPackaged: !!options.packaged },
    BrowserWindow: class { constructor() { throw new Error('GUI must not launch in backend tests'); } },
    clipboard: {}, ipcMain: { on() {}, handle: (channel: string, callback: (...args: any[]) => any) => handlers.set(channel, callback) },
    Menu: { buildFromTemplate: (template: any[]) => template, setApplicationMenu: (menu: any[]) => menus.push(menu) },
    shell: { openPath: async (file: string) => { opened.push(file); return openError; }, showItemInFolder: (file: string) => revealed.push(file) },
    dialog: { showOpenDialog: async (_window: unknown, options: any) => { dialogs.push(options); return { canceled: true, filePaths: [] }; }, showMessageBox: async (_window: unknown, options: any) => { dialogs.push(options); return { response: 1 }; } },
  };
  const processMock = { ...process, platform, env: { ...(options.portable ? { PORTABLE_EXECUTABLE_FILE: 'Folio.exe' } : {}), ...(options.isolated ? { FOLIO_USER_DATA: directory } : {}) }, argv: ['Folio.exe'], cwd: () => directory } as unknown as NodeJS.Process;
  const main = await loadBackendModule<any>('electron/main.ts', { electron, './voice': {createVoiceService:voiceFactory}, './store': storeModule, './settings': { SettingsStore }, './pdf-export': {}, './demo': {}, './ai': {}, './obsidian': {}, './desktop': { ...desktop, pdfDialogOptions: (mode: 'files' | 'folder' | 'mixed') => desktop.pdfDialogOptions(mode, platform) }, '../shared/i18n': i18n, './updater': { createUpdateService: (host: any) => { updateHost = host; return updater; } } },
    `export const testMain={stopVoice,makeMenu,registerIPC,choosePdfs,localizeBackendError,initializeUpdater,scheduleUpdateCheck,setState(state:any){settings=state.settings;library=state.library;window=state.window;ai=state.ai;}};`, processMock,
    { setTimeout: (callback: () => void, delay: number) => { const timer = { callback, delay }; timers.push(timer); return timer; }, clearTimeout: () => {} });
  main.testMain.setState({ settings, library, window, ai: { cancelWorkspace: async (id: string) => { calls.push(`cancel-ai:${id}`); } } });
  main.testMain.initializeUpdater(); main.testMain.registerIPC(); main.testMain.makeMenu();
  const invoke = (name: string, ...args: any[]) => handlers.get(`folio:${name}`)!({ sender: webContents, senderFrame: mainFrame }, ...args);
  return { directory, settings, library, voiceCalls, voiceInstances: () => voiceInstances, handlers, main: main.testMain, menus, dialogs, sent, opened, revealed, calls, timers, updater, updateHost: () => updateHost, quits: () => quits, openError: (error: string) => { openError = error; }, invoke };
}

test('saving language rebuilds actual native menus immediately, including edit roles, and failed saves keep the menu', async t => {
  const h = await harness(t); assert.equal(h.menus[0][2].label, '编辑');
  await h.invoke('save-settings', { ...h.settings.public(), language: 'en' });
  assert.equal(h.menus.length, 2); const menu = h.menus.at(-1)!;
  assert.equal(menu[1].label, 'File'); assert.equal(menu[2].submenu.find((item: any) => item.role === 'copy').label, 'Copy');
  assert.equal(menu[2].submenu.find((item: any) => item.role === 'paste').label, 'Paste');
  menu[2].submenu.find((item: any) => item.label === 'Undo').click(); assert.deepEqual(h.sent.at(-1), ['folio:command', 'undo']);
  const invalid: Settings = { ...h.settings.public(), language: 'zh-CN', vaultPath: path.join(h.directory, 'absent') };
  await assert.rejects(h.invoke('save-settings', invalid)); assert.equal(h.menus.length, 2); assert.equal(h.settings.getLanguage(), 'en');
  await h.invoke('save-settings', { ...h.settings.public(), language: 'zh-CN' }); assert.equal(h.menus.at(-1)![2].label, '编辑');
});

test('native pickers, permanent-delete confirmation and known backend errors follow language without translating titles', async t => {
  const h = await harness(t, 'win32'); await h.invoke('save-settings', { ...h.settings.public(), language: 'en' });
  await h.main.choosePdfs('mixed'); const files = h.dialogs.at(-1);
  assert.match(files.title, /main PDF/); assert.ok(files.properties.includes('openFile')); assert.ok(!files.properties.includes('openDirectory')); assert.equal(files.filters[0].name, 'PDF documents');
  await h.main.choosePdfs('folder'); assert.equal(h.dialogs.at(-1).title, 'Choose a paper folder');
  const ws = storeModule.newWorkspace('中文文章标题'); await h.library.insert(ws); await h.library.moveToTrash(ws.id);
  assert.equal(await h.invoke('purge-workspace', ws.id), false);
  const confirm = h.dialogs.at(-1); assert.match(confirm.message, /中文文章标题/); assert.match(confirm.detail, /cannot be undone/); assert.deepEqual(confirm.buttons, ['Delete permanently', 'Cancel']);
  assert.equal(h.library.listRemoved().length, 1);
  await assert.rejects(h.invoke('update-document', 'missing', 'missing', {}), /Paper not found/);
  assert.equal(h.main.localizeBackendError(new Error('不是有效的 PDF：中文文件.pdf')), 'Not a valid PDF: 中文文件.pdf');
  assert.equal(h.main.localizeBackendError(new Error('用户自定义错误')), '用户自定义错误');
});

test('only newly created workspaces receive English initial conversation labels', async t => {
  const h = await harness(t); const old = storeModule.newWorkspace('原有中文文章'); old.notes = '原有中文笔记'; await h.library.insert(old);
  await h.invoke('save-settings', { ...h.settings.public(), language: 'en' });
  const file = path.join(h.directory, '原始文件.pdf'); await fs.writeFile(file, '%PDF-1.7\nTest import fixture');
  const created = await h.invoke('create-workspace', [file]);
  assert.equal(created.conversations[0].title, 'Reading conversation'); assert.equal(created.title, '原始文件');
  assert.equal(h.library.get(old.id).conversations[0].title, '阅读对话'); assert.equal(h.library.get(old.id).notes, old.notes);
  const newConversation = await h.invoke('new-conversation', old.id); assert.equal(newConversation.conversations[1].title, 'New conversation 2');
});

test('manual update IPC and menu stay available in isolated builds, while automatic checks only run once after startup', async t => {
  for (const options of [{ packaged: false }, { packaged: true, isolated: true }]) {
    const h = await harness(t, 'darwin', options); h.main.scheduleUpdateCheck(); assert.equal(h.timers.length, 0);
    await h.invoke('check-updates'); assert.deepEqual(h.calls, ['check:true']);
  }
  const h = await harness(t, 'darwin', { packaged: true }); h.main.scheduleUpdateCheck(); h.main.scheduleUpdateCheck();
  assert.equal(h.timers.length, 1); assert.equal(h.timers[0].delay, 5000); h.timers[0].callback(); assert.deepEqual(h.calls, ['check:false']);
  await h.invoke('save-settings', { ...h.settings.public(), language: 'en' });
  h.menus.at(-1)![0].submenu.find((item: any) => item.label === 'Check for Updates…').click();
  assert.deepEqual(h.sent.at(-1), ['folio:command', 'updates']); assert.deepEqual(h.calls, ['check:false', 'check:true']);
  await h.invoke('download-update'); await h.invoke('cancel-update'); assert.deepEqual(h.calls.slice(-2), ['download', 'cancel']);
  assert.deepEqual(await h.invoke('update-status'), { phase: 'idle', currentVersion: '0.3.0' });
  h.updateHost().emit({ phase: 'checking' }); assert.deepEqual(h.sent.at(-1), ['folio:update', { phase: 'checking' }]);
  const optedOut = await harness(t, 'darwin', { packaged: true }); optedOut.main.scheduleUpdateCheck(); await optedOut.settings.save({ ...optedOut.settings.public(), autoCheckUpdates: false }); optedOut.timers[0].callback(); assert.deepEqual(optedOut.calls, []);
});

test('install hooks save before opening, preserve the app on failure, and reveal portable Windows downloads', async t => {
  const mac = await harness(t); let saved = false;
  mac.library.flush = async () => { saved = true; }; await mac.invoke('install-update'); assert.equal(saved, true); assert.equal(mac.opened.length, 1); assert.equal(mac.quits(), 0);
  const win = await harness(t, 'win32'); const ws = storeModule.newWorkspace('Paper'); await win.library.insert(ws);
  win.library.flush = async () => { win.calls.push('flush-library'); };
  await win.invoke('install-update'); assert.deepEqual(win.calls, ['install', `cancel-ai:${ws.id}`, 'flush-library']); assert.equal(win.opened.length, 1); assert.equal(win.quits(), 1);
  const failure = await harness(t, 'win32'); failure.library.flush = async () => { throw new Error('Save failed'); };
  await assert.rejects(failure.invoke('install-update'), /Save failed/); assert.equal(failure.opened.length, 0); assert.equal(failure.quits(), 0);
  const openFailure = await harness(t, 'win32'); openFailure.openError('Installer could not open');
  await assert.rejects(openFailure.invoke('install-update'), /Installer could not open/); assert.equal(openFailure.quits(), 0);
  const portable = await harness(t, 'win32', { portable: true }); await portable.invoke('install-update');
  assert.equal(portable.opened.length, 0); assert.deepEqual(portable.revealed, ['/isolated/Folio-download']); assert.equal(portable.quits(), 0); assert.equal(portable.updateHost().portable, true);
});


test('native speech IPC is lazy, uses the trusted renderer and releases its helper when interrupted', async t => {
  const h=await harness(t);
  assert.equal(h.voiceInstances(),0);
  await h.invoke('voice-stop-speaking');
  assert.equal(h.voiceInstances(),0);
  await assert.rejects(h.handlers.get('folio:voice-listen')!({sender:{},senderFrame:{}},{sessionId:'foreign',locale:'zh-CN'}),/未授权/);
  assert.equal(h.voiceInstances(),0);
  const capabilities=await h.invoke('voice-capabilities','zh-CN');
  assert.equal(capabilities.engine,'speech-analyzer');assert.equal(h.voiceInstances(),1);
  await h.invoke('voice-listen',{sessionId:'listen-1',locale:'zh-CN'});
  assert.deepEqual(h.sent.at(-1),['folio:voice',{sessionId:'listen-1',type:'listening'}]);
  assert.deepEqual(await h.invoke('voice-stop-listening','listen-1'),{text:'测试'});
  await h.main.stopVoice();
  assert.deepEqual(h.sent.at(-1),['folio:command','stop-voice']);
  assert.deepEqual(h.voiceCalls.at(-1),['dispose']);
  await h.invoke('voice-capabilities','en-US');
  assert.equal(h.voiceInstances(),2);
});
