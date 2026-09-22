import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compareVersions, createUpdateService, MAX_UPDATE_BYTES, updateAssetName, validateDownloadURL, type UpdateHost } from '../electron/updater';
import type { UpdateStatus } from '../shared/updates';

const API = 'https://api.github.com/repos/AuroraSxh/Folio-pdfreader/releases/latest';
const REPO = 'https://github.com/AuroraSxh/Folio-pdfreader';
const CONTENT = Buffer.from('Folio updater unit-test fixture; never a real installer.');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function response(body: BodyInit | null, url: string, init: ResponseInit = {}): Response {
  const result = new Response(body, init);
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
function release(version = '0.3.0', bytes: Uint8Array = CONTENT) {
  const tag = `v${version}`;
  return {
    tag_name: tag, draft: false, prerelease: false, html_url: `${REPO}/releases/tag/${encodeURIComponent(tag)}`,
    published_at: '2026-09-22T01:00:00Z', body: 'Test release notes, not remote instructions.',
    assets: [updateAssetName(version, 'darwin', 'arm64')!, updateAssetName(version, 'win32', 'x64')!, updateAssetName(version, 'win32', 'x64', true)!].map((name, index) => ({
      id: index + 1, name, state: 'uploaded', size: bytes.byteLength, digest: `sha256:${sha256(bytes)}`,
      url: `https://api.github.com/repos/AuroraSxh/Folio-pdfreader/releases/assets/${index + 1}`,
      browser_download_url: `${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    })),
  };
}
type Release = ReturnType<typeof release>;
type FetchReply = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

async function fixture(t: TestContext, options: Partial<UpdateHost> & { raw?: Release; reply?: FetchReply } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-updater-test-'));
  const directory = options.directory ?? path.join(base, 'updates');
  const calls: string[] = [], opened: string[] = [], states: UpdateStatus[] = [];
  const listeners = new Set<(state: UpdateStatus) => void>();
  const raw = options.raw ?? release();
  const host: UpdateHost = {
    version: '0.2.2', platform: 'darwin', arch: 'arm64', directory,
    openInstaller: async filename => { opened.push(filename); },
    ...options,
    emit: state => { states.push(state); for (const listen of listeners) listen(state); options.emit?.(state); },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      const headers = new Headers(init?.headers);
      assert.equal(headers.has('authorization'), false);
      assert.equal(headers.has('x-api-key'), false);
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'manual');
      if (options.reply) return options.reply(url, init);
      if (url === API) return response(JSON.stringify(raw), url, { headers: { 'content-type': 'application/json' } });
      if (raw.assets.some(asset => asset.browser_download_url === url)) return response(CONTENT, url, { headers: { 'content-length': String(CONTENT.length) } });
      throw new Error('Unexpected URL in unit-test mock');
    }) as typeof fetch,
  };
  const service = createUpdateService(host);
  t.after(async () => { await service.dispose(); await fs.rm(base, { recursive: true, force: true }); });
  const waitFor = (predicate: (state: UpdateStatus) => boolean) => {
    const existing = states.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<UpdateStatus>((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('Expected update state was not emitted')); }, 2000);
      const listener = (state: UpdateStatus) => { if (predicate(state)) { clearTimeout(timer); listeners.delete(listener); resolve(state); } };
      listeners.add(listener);
    });
  };
  return { service, host, raw, directory, base, opened, calls, states, waitFor };
}

test('strict SemVer ordering rejects malformed versions and never compares build metadata', () => {
  for (const [a, b] of [['1.10.0', '1.9.9'], ['2.0.0', '1.999.999'], ['1.0.0', '1.0.0-rc.1'], ['1.0.0-beta.11', '1.0.0-beta.2'], ['1.0.0-beta', '1.0.0-11'], ['1.0.0-beta.1', '1.0.0-beta']]) {
    assert.equal(compareVersions(a, b), 1, `${a} > ${b}`);
    assert.equal(compareVersions(b, a), -1);
  }
  assert.equal(compareVersions('1.2.3+one', '1.2.3+two'), 0);
  assert.equal(compareVersions('99999999999999999.0.0', '99999999999999998.0.0'), 1);
  for (const value of ['v1.0.0', '01.0.0', '1.2', '1.2.3.4', '1.0.0-01', '1.0.0-', '1.0.0+', '1.0.0 foo', '../1.0.0', '1.0.0\n']) assert.throws(() => compareVersions(value, '1.0.0'));
});

test('Mac universal and Windows setup/portable names are platform-specific', () => {
  assert.equal(updateAssetName('0.3.0', 'darwin', 'arm64'), 'Folio-0.3.0-mac-universal.dmg');
  assert.equal(updateAssetName('0.3.0', 'darwin', 'x64'), 'Folio-0.3.0-mac-universal.dmg');
  assert.equal(updateAssetName('0.3.0', 'win32', 'x64'), 'Folio-0.3.0-windows-x64-setup.exe');
  assert.equal(updateAssetName('0.3.0', 'win32', 'x64', true), 'Folio-0.3.0-windows-x64-portable.exe');
  assert.equal(updateAssetName('0.3.0', 'win32', 'arm64'), undefined);
  assert.equal(updateAssetName('0.3.0', 'linux', 'x64'), undefined);
  assert.throws(() => updateAssetName('0.3.0-beta', 'darwin', 'arm64'));
});

test('check/download/install are distinct and require SHA-256 plus a second on-disk check', async t => {
  const f = await fixture(t);
  const available = await f.service.check();
  assert.equal(available.phase, 'available'); assert.equal(available.release?.downloadable, true);
  assert.equal(available.release?.version, '0.3.0');
  assert.equal(f.opened.length, 0);
  assert.equal((await f.service.download()).phase, 'downloaded');
  assert.equal(f.opened.length, 0, 'Downloading cannot launch an installer');
  const filename = path.join(f.directory, f.raw.assets[0].name);
  assert.deepEqual(await fs.readFile(filename), CONTENT);
  assert.equal((await f.service.install()).phase, 'downloaded');
  assert.deepEqual(f.opened, [filename]);
  assert.ok(f.states.some(state => state.phase === 'opening'));
  assert.equal(JSON.stringify(f.service.getStatus()).includes(f.directory), false);
  assert.equal(JSON.stringify(f.service.getStatus()).includes('sha256:'), false);
  const snapshot = f.service.getStatus(); snapshot.release!.version = 'bad';
  assert.equal(f.service.getStatus().release?.version, '0.3.0', 'Renderer snapshots are detached');
});

test('manual checks bypass the six-hour cache; automatic checking occurs only once per session', async t => {
  let time = Date.parse('2026-09-22T08:00:00Z');
  const first = await fixture(t, { now: () => time });
  await first.service.check(); await first.service.check();
  assert.equal(first.calls.length, 1);
  await first.service.dispose();
  const cached = await fixture(t, { directory: first.directory, now: () => time });
  assert.equal((await cached.service.check()).phase, 'available');
  assert.equal(cached.calls.length, 0);
  await cached.service.check(true);
  assert.equal(cached.calls.length, 1);
  time += 6 * 60 * 60 * 1000;
  const expired = await fixture(t, { directory: first.directory, now: () => time });
  await expired.service.check();
  assert.equal(expired.calls.length, 1);
});

test('cached executable digests are not trusted: downloading first fetches fresh GitHub metadata', async t => {
  const first = await fixture(t); await first.service.check(); await first.service.dispose();
  const filename = path.join(first.directory, first.raw.assets[0].name);
  const bad = Buffer.alloc(CONTENT.length, 120);
  await fs.writeFile(filename, bad);
  const cacheFile = path.join(first.directory, 'release-cache.json');
  const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  cache.raw.assets[0].digest = `sha256:${sha256(bad)}`;
  await fs.writeFile(cacheFile, JSON.stringify(cache));
  const second = await fixture(t, { directory: first.directory });
  await second.service.check(); assert.equal(second.calls.length, 0);
  assert.equal((await second.service.install()).error, 'not-ready');
  assert.equal((await second.service.download()).phase, 'downloaded');
  assert.equal(second.calls[0], API);
  assert.deepEqual(await fs.readFile(filename), CONTENT);
  assert.equal(second.opened.length, 0);
});

test('equal/older releases do not offer downloads; draft and prerelease releases are rejected', async t => {
  for (const version of ['0.2.2', '0.2.1']) {
    const f = await fixture(t, { raw: release(version) });
    assert.equal((await f.service.check()).phase, 'up-to-date');
    assert.equal((await f.service.download()).error, 'not-ready');
    assert.equal(f.calls.length, 1); assert.equal(f.opened.length, 0);
  }
  for (const modification of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.3.0-rc.1' }, { tag_name: 'v01.0.0' }]) {
    const raw = Object.assign(release(), modification);
    const f = await fixture(t, { raw });
    assert.equal((await f.service.check()).error, 'invalid-release');
  }
});

test('missing digest/assets and unsupported hosts give release-page fallbacks without downloading', async t => {
  const digest = release(); digest.assets[0].digest = '';
  const missing = release(); missing.assets = [];
  for (const [options, error] of [[{ raw: digest }, 'missing-digest'], [{ raw: missing }, 'missing-asset'], [{ platform: 'linux', arch: 'x64' }, 'unsupported-platform']] as const) {
    const f = await fixture(t, options);
    const status = await f.service.check();
    assert.equal(status.phase, 'available'); assert.equal(status.error, error);
    assert.equal(status.release?.downloadable, false);
    assert.equal(status.release?.url, `${REPO}/releases/tag/v0.3.0`);
    await f.service.download(); await f.service.install();
    assert.equal(f.calls.length, 1); assert.equal(f.opened.length, 0);
  }
});

test('asset URLs must belong to this release and repository, with no credentials, downgrade, or port', async t => {
  for (const bad of [
    'http://github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.3.0/file.dmg',
    'https://github.com.evil.test/AuroraSxh/Folio-pdfreader/releases/download/v0.3.0/file.dmg',
    'https://github.com/Someone/Other/releases/download/v0.3.0/file.dmg',
    'https://github.com:444/AuroraSxh/Folio-pdfreader/releases/download/v0.3.0/file.dmg',
    'https://user:password@github.com/AuroraSxh/Folio-pdfreader/releases/download/v0.3.0/file.dmg',
    `${REPO}/releases/download/v0.2.2/Folio-0.3.0-mac-universal.dmg`,
  ]) {
    const raw = release(); raw.assets[0].browser_download_url = bad;
    const f = await fixture(t, { raw });
    assert.equal((await f.service.check()).error, 'invalid-url');
    await f.service.download();
    assert.equal(f.calls.length, 1); assert.equal(f.opened.length, 0);
  }
  const raw = release(); raw.html_url = 'https://evil.test/releases';
  const f = await fixture(t, { raw });
  assert.equal((await f.service.check()).error, 'invalid-url');
  assert.equal(f.service.getStatus().release, undefined);
});

test('redirects are checked before following them, and unexpected final response URLs are rejected', async t => {
  const raw = release(), assetURL = raw.assets[0].browser_download_url;
  const official = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/fixture?signature=unit-test';
  const olderCDN = 'https://objects.githubusercontent.com/github-production-release-asset-2e65be/123/fixture';
  assert.equal(validateDownloadURL(official, assetURL), official);
  assert.equal(validateDownloadURL(olderCDN, assetURL), olderCDN);
  for (const bad of ['http://release-assets.githubusercontent.com/github-production-release-asset/123/fixture', 'https://release-assets.githubusercontent.com.evil.test/github-production-release-asset/123/fixture', 'https://evil.test/file', 'https://release-assets.githubusercontent.com/unrelated/file']) assert.throws(() => validateDownloadURL(bad, assetURL));
  assert.throws(() => validateDownloadURL('https://github.com/Other/Repo/releases/download/v1/installer', 'https://github.com/Other/Repo/releases/download/v1/installer'));
  const good = await fixture(t, { reply: url => url === API ? response(JSON.stringify(raw), url) : url === assetURL ? response(null, url, { status: 302, headers: { location: official } }) : response(CONTENT, official) });
  await good.service.check(); assert.equal((await good.service.download()).phase, 'downloaded');
  assert.deepEqual(good.calls, [API, assetURL, official]);
  const badRedirect = await fixture(t, { reply: url => url === API ? response(JSON.stringify(raw), url) : response(null, url, { status: 302, headers: { location: 'https://evil.test/file' } }) });
  await badRedirect.service.check(); assert.equal((await badRedirect.service.download()).error, 'invalid-url');
  assert.equal(badRedirect.calls.length, 2, 'The disallowed destination is never fetched');
  const badFinal = await fixture(t, { reply: url => url === API ? response(JSON.stringify(raw), url) : response(CONTENT, 'https://evil.test/file') });
  await badFinal.service.check(); assert.equal((await badFinal.service.download()).error, 'invalid-url');
  assert.equal(badFinal.opened.length, 0);
  const badAPI = await fixture(t, { reply: () => response(JSON.stringify(raw), 'https://api.github.com/repos/Other/Repo/releases/latest') });
  assert.equal((await badAPI.service.check()).error, 'invalid-url');
});

test('declared size, actual stream length, hash, and maximum size independently block unsafe downloads', async t => {
  const raw = release();
  for (const [bytes, declared, expected] of [
    [CONTENT, String(CONTENT.length + 1), 'length-mismatch'],
    [CONTENT.subarray(1), undefined, 'length-mismatch'],
    [Buffer.concat([CONTENT, Buffer.from('!')]), undefined, 'length-mismatch'],
    [Buffer.alloc(CONTENT.length, 120), undefined, 'checksum-mismatch'],
  ] as const) {
    const f = await fixture(t, { reply: url => url === API ? response(JSON.stringify(raw), url) : response(bytes, url, declared ? { headers: { 'content-length': declared } } : {}) });
    await f.service.check(); assert.equal((await f.service.download()).error, expected);
    assert.equal((await f.service.install()).error, 'not-ready');
    assert.equal(f.opened.length, 0);
    assert.ok((await fs.readdir(f.directory)).every(name => !name.endsWith('.part') && !name.endsWith('.dmg')));
  }
  const huge = release(); huge.assets[0].size = MAX_UPDATE_BYTES + 1;
  const f = await fixture(t, { raw: huge });
  assert.equal((await f.service.check()).error, 'size-limit');
  await f.service.download(); assert.equal(f.calls.length, 1);
});

test('tampering, truncating, replacing with symlink, or changing the file during flush prevents installation', async t => {
  for (const method of ['hash', 'truncate', 'symlink', 'flush'] as const) {
    let filename = '';
    const f = await fixture(t, { flush: method === 'flush' ? async () => { await fs.writeFile(filename, Buffer.alloc(CONTENT.length, 120)); } : undefined });
    await f.service.check(); await f.service.download();
    filename = path.join(f.directory, f.raw.assets[0].name);
    if (method === 'hash') await fs.writeFile(filename, Buffer.alloc(CONTENT.length, 120));
    if (method === 'truncate') await fs.truncate(filename, 2);
    if (method === 'symlink') { const target = path.join(f.base, 'other-file'); await fs.writeFile(target, CONTENT); await fs.unlink(filename); await fs.symlink(target, filename); }
    const status = await f.service.install();
    assert.equal(status.phase, 'error');
    assert.equal(status.error, method === 'truncate' ? 'length-mismatch' : method === 'symlink' ? 'installer-missing' : 'checksum-mismatch');
    assert.equal(f.opened.length, 0);
    assert.equal((await f.service.check(true)).phase, 'available', 'Failed verification invalidates the previous download receipt');
  }
});

test('cancelling a streaming download removes .part and coalesces concurrent operations', async t => {
  const raw = release(); let cancelled = false;
  const f = await fixture(t, { reply: url => url === API ? response(JSON.stringify(raw), url) : response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(CONTENT.subarray(0, 8)); }, cancel() { cancelled = true; } }), url) });
  await f.service.check();
  const first = f.service.download(), second = f.service.download(), simultaneousCheck = f.service.check(true), simultaneousInstall = f.service.install();
  assert.equal(first, second); assert.equal(first, simultaneousCheck); assert.equal(first, simultaneousInstall);
  await f.waitFor(state => state.phase === 'downloading' && (state.downloadedBytes ?? 0) > 0);
  assert.ok((await fs.readdir(f.directory)).some(name => name.endsWith('.part')));
  const status = await f.service.cancel();
  assert.equal(status.error, 'cancelled'); assert.equal(status.phase, 'available');
  assert.equal((await first).phase, 'available');
  assert.ok((await fs.readdir(f.directory)).every(name => !name.endsWith('.part')));
  assert.equal(cancelled, true); assert.equal(f.calls.length, 2); assert.equal(f.opened.length, 0);
});

test('check and stalled body timeouts finish promptly and never run an installer', async t => {
  const check = await fixture(t, { requestTimeoutMs: 10, reply: () => new Promise(() => {}) });
  assert.equal((await check.service.check()).error, 'timeout');
  const raw = release();
  const stalled = await fixture(t, { downloadIdleTimeoutMs: 10, reply: url => url === API ? response(JSON.stringify(raw), url) : response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(CONTENT.subarray(0, 8)); } }), url) });
  await stalled.service.check(); assert.equal((await stalled.service.download()).error, 'timeout');
  assert.ok((await fs.readdir(stalled.directory)).every(name => !name.endsWith('.part')));
  assert.equal(stalled.opened.length, 0);
});

test('save/open failures preserve a verified download for direct installation retry', async t => {
  for (const where of ['save', 'open'] as const) {
    let fail = true, opened = 0;
    const f = await fixture(t, { flush: async () => { if (where === 'save' && fail) throw new Error('private filesystem detail'); }, openInstaller: async () => { if (where === 'open' && fail) throw new Error('private filesystem detail'); opened++; } });
    await f.service.check(); await f.service.download();
    const bad = await f.service.install();
    assert.equal(bad.phase, 'downloaded'); assert.equal(bad.error, where === 'save' ? 'save-failed' : 'open-failed');
    assert.equal(JSON.stringify(bad).includes('private filesystem detail'), false); assert.equal(opened, 0);
    fail = false;
    assert.equal((await f.service.install()).error, undefined);
    assert.equal(opened, 1); assert.equal(f.calls.length, 2);
  }
});

test('disposing during install cannot deadlock app.quit and disposing downloads cleans partial data', async t => {
  let dispose: (() => Promise<void>) | undefined;
  const install = await fixture(t, { openInstaller: async () => { await dispose!(); } });
  dispose = () => install.service.dispose();
  await install.service.check(); await install.service.download();
  await install.service.install();
  assert.equal((await install.service.check(true)).error, 'disposed');
  const raw = release();
  const download = await fixture(t, { reply: url => url === API ? response(JSON.stringify(raw), url) : response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(CONTENT.subarray(0, 8)); } }), url) });
  await download.service.check(); const pending = download.service.download();
  await download.waitFor(state => (state.downloadedBytes ?? 0) > 0);
  await download.service.dispose(); await pending;
  assert.ok((await fs.readdir(download.directory)).every(name => !name.endsWith('.part')));
});

test('HTTP errors and excessive metadata return stable codes rather than raw response text', async t => {
  for (const [status, expected] of [[404, 'no-release'], [403, 'rate-limit'], [429, 'rate-limit'], [500, 'network']] as const) {
    const f = await fixture(t, { reply: url => response('untrusted response detail', url, { status }) });
    assert.equal((await f.service.check()).error, expected);
    assert.equal(JSON.stringify(f.service.getStatus()).includes('untrusted response detail'), false);
  }
  const f = await fixture(t, { reply: url => response('{}', url, { headers: { 'content-length': String(3 * 1024 * 1024) } }) });
  assert.equal((await f.service.check()).error, 'invalid-release');
});
