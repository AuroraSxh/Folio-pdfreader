import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createUpdateService, updateAssetName, validateDownloadURL, type UpdateHost } from '../electron/updater';
import { appendUpdateManifest, readUpdateManifest, updatePartName } from '../shared/update-manifest';
import type { UpdateSource, UpdateSourcePreference, UpdateStatus } from '../shared/updates';

const API = { github: 'https://api.github.com/repos/AuroraSxh/Folio-pdfreader/releases/latest', gitee: 'https://gitee.com/api/v5/repos/aurorasxh/pair-leaf/releases?per_page=100&page=1' };
const REPO = { github: 'https://github.com/AuroraSxh/Folio-pdfreader', gitee: 'https://gitee.com/aurorasxh/pair-leaf' };
const BYTES = Buffer.from('isolated dual-source fixture, never a real installer');
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function response(body: BodyInit | null, url: string, status = 200) {
  const result = new Response(body, { status }); Object.defineProperty(result, 'url', { value: url }); return result;
}
function release(source: UpdateSource, version = '0.7.0', bytes = BYTES) {
  const name = updateAssetName(version, 'darwin', 'arm64')!;
  const asset = { name, browser_download_url: `${REPO[source]}/releases/download/v${version}/${name}` };
  const body = appendUpdateManifest('Public release notes.', { schema: 1, version, assets: [{ name, size: bytes.length, sha256: digest(bytes) }] });
  return source === 'gitee' ? { id: 123, tag_name: `v${version}`, prerelease: false, created_at: '2026-10-13T01:00:00Z', body, assets: [asset] }
    : { tag_name: `v${version}`, draft: false, prerelease: false, html_url: `${REPO.github}/releases/tag/v${version}`, published_at: '2026-10-13T01:00:00Z', body,
      assets: [{ ...asset, id: 12, url: 'https://api.github.com/repos/AuroraSxh/Folio-pdfreader/releases/assets/12', state: 'uploaded', size: bytes.length, digest: `sha256:${digest(bytes)}` }] };
}
type RawRelease = ReturnType<typeof release>;
interface Options extends Partial<UpdateHost> {
  preference?: UpdateSourcePreference; region?: 'CN' | 'other' | 'unknown'; github?: RawRelease; gitee?: RawRelease;
  reply?: (url: string, init: RequestInit | undefined, fallback: () => Response) => Response | Promise<Response>;
}
async function fixture(t: TestContext, options: Options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pairleaf-update-sources-'));
  const directory = options.directory ?? path.join(base, 'updates');
  const preference = { value: options.preference ?? 'auto' };
  const calls: string[] = [], states: UpdateStatus[] = [], opened: string[] = [];
  const github = options.github ?? release('github'), gitee = options.gitee ?? release('gitee');
  let regionCalls = 0;
  const host: UpdateHost = { version: '0.6.0', platform: 'darwin', arch: 'arm64', directory, requestTimeoutMs: 50,
    getSourcePreference: () => preference.value,
    detectRegion: async () => { regionCalls++; return options.region ?? 'CN'; },
    openInstaller: async filename => { opened.push(filename); }, ...options,
    emit: status => { states.push(status); options.emit?.(status); },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      assert.equal(new Headers(init?.headers).has('x-api-key'), false);
      assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'manual');
      const fallback = () => {
        if (url === API.github) return response(JSON.stringify(github), url);
        if (url === API.gitee) return response(JSON.stringify([gitee]), url);
        if ([...github.assets, ...gitee.assets].some(asset => asset.browser_download_url === url)) return response(BYTES, url);
        throw new Error('Unexpected fixture URL');
      };
      return options.reply ? options.reply(url, init, fallback) : fallback();
    }) as typeof fetch,
  };
  const service = createUpdateService(host);
  t.after(async () => { await service.dispose(); await fs.rm(base, { recursive: true, force: true }); });
  return { service, host, directory, preference, calls, states, opened, github, gitee, regionCalls: () => regionCalls };
}

test('manual sources never detect location or contact the other host; Gitee uses its public schema and body integrity manifest', async t => {
  for (const source of ['github', 'gitee'] as const) {
    const f = await fixture(t, { preference: source });
    const available = await f.service.check();
    assert.equal(available.phase, 'available'); assert.equal(available.source, source);
    assert.equal(available.sourcePreference, source); assert.equal(available.region, undefined);
    assert.equal(available.release?.source, source); assert.equal(available.release?.notes, 'Public release notes.');
    assert.equal(available.release?.downloadable, true); assert.equal(available.release?.size, BYTES.length);
    assert.equal((await f.service.download()).phase, 'downloaded');
    assert.equal(f.regionCalls(), 0); assert.deepEqual(f.calls, [API[source], f[source].assets[0].browser_download_url]);
    await f.service.install(); assert.equal(f.opened.length, 1);
  }
});

test('automatic equal-version selection follows CN/overseas/unknown preference and records the real source', async t => {
  for (const region of ['CN', 'other', 'unknown'] as const) {
    const f = await fixture(t, { region }); const state = await f.service.check();
    const expected = region === 'CN' ? 'gitee' : 'github';
    assert.equal(state.source, expected); assert.equal(state.preferredSource, expected); assert.equal(state.region, region);
    assert.equal(state.sourceReason, region === 'unknown' ? 'region-unavailable' : undefined);
    assert.equal(state.sourcePreference, 'auto'); assert.equal(f.regionCalls(), 1);
    assert.deepEqual(new Set(f.calls), new Set(Object.values(API)));
  }
});

test('automatic comparison chooses the higher stable version even when the preferred mirror lags', async t => {
  for (const region of ['CN', 'other'] as const) {
    const higher = region === 'CN' ? 'github' : 'gitee';
    const f = await fixture(t, { region, [higher]: release(higher, '0.8.0') });
    const state = await f.service.check();
    assert.equal(state.source, higher); assert.equal(state.release?.version, '0.8.0');
    assert.equal(state.sourceReason, 'newer-on-other-source');
  }
});

test('a preferred metadata failure or independent timeout does not abort the healthy source', async t => {
  for (const failure of ['404', '500', 'network', 'stalled-fetch', 'stalled-body', 'malformed'] as const) {
    let githubSignal: AbortSignal | null | undefined;
    const f = await fixture(t, { region: 'CN', requestTimeoutMs: 10, reply: (url, init, fallback) => {
      if (url === API.github) { githubSignal = init?.signal; return fallback(); }
      if (url === API.gitee) {
        if (failure === 'network') throw new TypeError('private transport details');
        if (failure === 'stalled-fetch') return new Promise(() => {});
        if (failure === 'stalled-body') return response(new ReadableStream({ start() {} }), url);
        if (failure === 'malformed') return response('not-json', url);
        return response('', url, Number(failure));
      }
      return fallback();
    } });
    const state = await f.service.check();
    assert.equal(state.source, 'github'); assert.equal(state.phase, 'available');
    assert.equal(state.sourceReason, 'source-fallback'); assert.equal(state.preferredSource, 'gitee');
    assert.ok(githubSignal); assert.equal((await f.service.download()).phase, 'downloaded');
    assert.equal(f.opened.length, 0);
  }
});

test('Gitee missing, malformed, mismatched or duplicated manifests cannot authorize downloads', async t => {
  for (const mode of ['missing', 'malformed', 'wrong-version', 'duplicate', 'wrong-url', 'duplicate-asset', 'prerelease'] as const) {
    const gitee = release('gitee');
    if (mode === 'missing') gitee.body = 'No integrity information.';
    if (mode === 'malformed') gitee.body = '<!-- pairleaf-update-v1\n{\n-->';
    if (mode === 'wrong-version') gitee.body = release('gitee', '0.8.0').body;
    if (mode === 'duplicate') gitee.body += gitee.body;
    if (mode === 'wrong-url') gitee.assets[0].browser_download_url = gitee.assets[0].browser_download_url.replace('/aurorasxh/pair-leaf/', '/another/repository/');
    if (mode === 'duplicate-asset') gitee.assets = [...gitee.assets, gitee.assets[0]];
    if (mode === 'prerelease') gitee.prerelease = true;
    const f = await fixture(t, { preference: 'gitee', gitee }); const state = await f.service.check();
    assert.equal(state.error, mode === 'missing' ? 'missing-digest' : mode === 'wrong-url' ? 'invalid-url' : mode === 'prerelease' ? 'no-release' : 'invalid-release');
    assert.notEqual((await f.service.download()).phase, 'downloaded'); assert.equal(f.calls.length, 1);
  }
});

test('same-version validated mirror is selected when preferred assets have no digest', async t => {
  const gitee = release('gitee'); gitee.body = 'No manifest.';
  const f = await fixture(t, { gitee }); const state = await f.service.check();
  assert.equal(state.source, 'github'); assert.equal(state.sourceReason, 'source-fallback');
  assert.equal(state.release?.downloadable, true);
});

test('automatic download fallback requires the same verified version, name, size and hash', async t => {
  for (const failure of ['network', 'status', 'timeout'] as const) {
    const f = await fixture(t, { downloadIdleTimeoutMs: 100, reply: (url, _init, fallback) => {
      if (url.startsWith(`${REPO.gitee}/releases/download/`)) {
        if (failure === 'network') throw new TypeError('Unreachable');
        if (failure === 'timeout') return new Promise(() => {});
        return response('', url, 503);
      }
      return fallback();
    } });
    await f.service.check(); const downloaded = await f.service.download();
    assert.equal(downloaded.phase, 'downloaded', `${failure}: ${downloaded.error}`); assert.equal(downloaded.source, 'github');
    assert.equal(downloaded.release?.source, 'github'); assert.equal(downloaded.sourceReason, 'source-fallback');
    assert.deepEqual(f.calls.slice(-2), [f.gitee.assets[0].browser_download_url, f.github.assets[0].browser_download_url]);
    assert.deepEqual(await fs.readFile(path.join(f.directory, f.github.assets[0].name)), BYTES);
    assert.ok((await fs.readdir(f.directory)).every(name => !name.endsWith('.part')));
    assert.equal(f.opened.length, 0);
  }
});

test('retry after both download sources fail can return to the recovered original source without refreshing metadata', async t => {
  let recovered = false;
  const f = await fixture(t, { reply: (url, _init, fallback) => {
    if (url.startsWith(`${REPO.github}/releases/download/`)) return response('', url, 503);
    if (url.startsWith(`${REPO.gitee}/releases/download/`) && !recovered) return response('', url, 503);
    return fallback();
  } });
  await f.service.check(); const failed = await f.service.download();
  assert.equal(failed.error, 'network'); assert.equal(failed.source, 'github');
  recovered = true;
  const retried = await f.service.download();
  assert.equal(retried.phase, 'downloaded'); assert.equal(retried.source, 'gitee');
  assert.equal(retried.sourceReason, 'source-fallback');
  assert.deepEqual(f.calls, [API.github, API.gitee, f.gitee.assets[0].browser_download_url, f.github.assets[0].browser_download_url,
    f.github.assets[0].browser_download_url, f.gitee.assets[0].browser_download_url]);
  assert.deepEqual(await fs.readFile(path.join(f.directory, f.gitee.assets[0].name)), BYTES);
  assert.ok((await fs.readdir(f.directory)).every(name => !name.endsWith('.part'))); assert.equal(f.opened.length, 0);
});

test('retry after cancelling the fallback download retains the original source and cleans its partial stream', async t => {
  let retrying = false, cancelled = false, fallbackStarted!: () => void;
  const started = new Promise<void>(resolve => { fallbackStarted = resolve; });
  const f = await fixture(t, { reply: (url, _init, fallback) => {
    if (url.startsWith(`${REPO.gitee}/releases/download/`) && !retrying) return response('', url, 503);
    if (url.startsWith(`${REPO.github}/releases/download/`)) {
      if (retrying) return response('', url, 503);
      return response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(BYTES.subarray(0, 7)); fallbackStarted(); },
        cancel() { cancelled = true; },
      }), url);
    }
    return fallback();
  } });
  await f.service.check(); const pending = f.service.download(); await started;
  assert.equal((await f.service.cancel()).error, 'cancelled'); await pending;
  assert.equal(cancelled, true); assert.equal(f.service.getStatus().source, 'github');
  assert.ok((await fs.readdir(f.directory)).every(name => !name.endsWith('.part')));
  retrying = true;
  const retried = await f.service.download();
  assert.equal(retried.phase, 'downloaded'); assert.equal(retried.source, 'gitee');
  assert.deepEqual(f.calls.slice(2), [f.gitee.assets[0].browser_download_url, f.github.assets[0].browser_download_url,
    f.github.assets[0].browser_download_url, f.gitee.assets[0].browser_download_url]);
  assert.deepEqual(await fs.readFile(path.join(f.directory, f.gitee.assets[0].name)), BYTES); assert.equal(f.opened.length, 0);
});

test('download fallback never changes version or accepts a differing filename, size, or SHA-256', async t => {
  for (const difference of ['version', 'name', 'size', 'hash'] as const) {
    const github = difference === 'version' ? release('github', '0.6.9') : release('github');
    const asset = github.assets[0] as { name: string; browser_download_url: string; size: number; digest: string };
    if (difference === 'name') { asset.name = asset.name.replace('Pairleaf-', 'Folio-'); asset.browser_download_url = asset.browser_download_url.replace('Pairleaf-', 'Folio-'); }
    if (difference === 'size') asset.size++;
    if (difference === 'hash') asset.digest = `sha256:${'a'.repeat(64)}`;
    const f = await fixture(t, { github, reply: (url, _init, fallback) => url.startsWith(`${REPO.gitee}/releases/download/`) ? response('', url, 503) : fallback() });
    await f.service.check(); const state = await f.service.download();
    assert.equal(state.error, 'network'); assert.equal(state.source, 'gitee');
    assert.equal(f.calls.filter(url => url.startsWith(`${REPO.github}/releases/download/`)).length, 0);
  }
});

test('integrity failures and manual-source failures never silently fall back', async t => {
  for (const mode of ['integrity', 'manual'] as const) {
    const f = await fixture(t, { preference: mode === 'manual' ? 'gitee' : 'auto', reply: (url, _init, fallback) => {
      if (url.startsWith(`${REPO.gitee}/releases/download/`)) return mode === 'manual' ? response('', url, 503) : response(Buffer.alloc(BYTES.length), url);
      return fallback();
    } });
    await f.service.check(); const result = await f.service.download();
    assert.equal(result.error, mode === 'manual' ? 'network' : 'checksum-mismatch');
    assert.equal(f.calls.filter(url => url.startsWith(`${REPO.github}/releases/download/`)).length, 0);
    if (mode === 'manual') assert.equal(f.calls.includes(API.github), false);
    assert.equal((await f.service.install()).error, 'not-ready');
  }
});

test('preference changes invalidate in-memory and disk source decisions before downloading', async t => {
  const first = await fixture(t, { preference: 'github' }); await first.service.check();
  first.preference.value = 'gitee';
  const downloaded = await first.service.download();
  assert.equal(downloaded.sourcePreference, 'gitee'); assert.equal(downloaded.source, 'gitee');
  assert.deepEqual(first.calls, [API.github, API.gitee, first.gitee.assets[0].browser_download_url]);
  const cached = JSON.parse(await fs.readFile(path.join(first.directory, 'release-cache.json'), 'utf8'));
  assert.match(cached.fingerprint, /gitee:gitee$/); assert.equal(cached.source, 'gitee');
  const second = await fixture(t, { preference: 'github', directory: first.directory });
  assert.equal((await second.service.check()).source, 'github'); assert.deepEqual(second.calls, [API.github]);
});

test('Gitee cache is only a display hint and changed cached hashes cannot authorize an installer', async t => {
  const first = await fixture(t, { preference: 'gitee' }); await first.service.check(); await first.service.dispose();
  const cachePath = path.join(first.directory, 'release-cache.json');
  const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  const wrong = Buffer.alloc(BYTES.length, 42);
  cached.raw.body = appendUpdateManifest('Public notes', { schema: 1, version: '0.7.0', assets: [{ name: first.gitee.assets[0].name, size: BYTES.length, sha256: digest(wrong) }] });
  await fs.writeFile(cachePath, JSON.stringify(cached));
  await fs.writeFile(path.join(first.directory, first.gitee.assets[0].name), wrong);
  const second = await fixture(t, { preference: 'gitee', directory: first.directory });
  assert.equal((await second.service.check()).source, 'gitee'); assert.equal(second.calls.length, 0);
  assert.equal((await second.service.download()).phase, 'downloaded'); assert.equal(second.calls[0], API.gitee);
  assert.deepEqual(await fs.readFile(path.join(first.directory, first.gitee.assets[0].name)), BYTES);
});

test('source preference is captured per operation, including a settings change while metadata is pending', async t => {
  let releasePending!: () => void;
  const gate = new Promise<void>(resolve => { releasePending = resolve; });
  const f = await fixture(t, { preference: 'github', reply: async (url, _init, fallback) => { if (url === API.github) await gate; return fallback(); } });
  const check = f.service.check(); f.preference.value = 'gitee'; releasePending();
  assert.equal((await check).source, 'github'); assert.equal(f.regionCalls(), 0);
  assert.equal((await f.service.check()).source, 'gitee'); assert.deepEqual(f.calls, [API.github, API.gitee]);
});

test('cancellation aborts both independent metadata requests without starting downloads', async t => {
  const signals: AbortSignal[] = [];
  let bothStarted!: () => void; const started = new Promise<void>(resolve => { bothStarted = resolve; });
  const f = await fixture(t, { reply: (_url, init) => { signals.push(init!.signal!); if (signals.length === 2) bothStarted(); return new Promise(() => {}); } });
  const check = f.service.check(); await started; const cancelled = await f.service.cancel();
  assert.equal(cancelled.error, 'cancelled'); assert.equal((await check).phase, 'idle');
  assert.ok(signals.every(signal => signal.aborted)); assert.equal(f.calls.length, 2); assert.equal(f.opened.length, 0);
});

test('unverified Gitee redirects and repository substitutions are rejected before fetching', async t => {
  const initial = release('gitee').assets[0].browser_download_url;
  assert.equal(validateDownloadURL(initial, initial), initial);
  for (const url of ['https://gitee.com.evil.test/file', 'https://evil.test/file', initial.replace('/aurorasxh/pair-leaf/', '/other/repo/'), initial.replace('https:', 'http:')]) assert.throws(() => validateDownloadURL(url, initial));
  const f = await fixture(t, { preference: 'gitee', reply: (url, _init, fallback) => url === initial ? (() => { const result = response(null, url, 302); result.headers.set('location', 'https://evil.test/installer'); return result; })() : fallback() });
  await f.service.check(); assert.equal((await f.service.download()).error, 'invalid-url');
  assert.equal(f.calls.includes('https://evil.test/installer'), false);
});

test('Gitee public attachment and Foruda redirects retain the repository-bound filename and full integrity checks', async t => {
  const initial = release('gitee').assets[0].browser_download_url, name = release('gitee').assets[0].name;
  const attachment = `${REPO.gitee}/attach_files/2693158/download/${name}`;
  const cdn = `https://foruda.gitee.com/attach_file/1776922953017544574/${name}`;
  assert.equal(validateDownloadURL(attachment, initial), attachment);
  assert.equal(validateDownloadURL(cdn, initial), cdn);
  for (const bad of [attachment.replace('/aurorasxh/pair-leaf/', '/other/repo/'), attachment.replace('2693158', 'not-an-id'),
    attachment.replace(name, 'another.exe'), cdn.replace(name, 'another.exe'), cdn.replace('foruda.gitee.com', 'foruda.gitee.com.evil.test'),
    cdn.replace('/attach_file/', '/arbitrary/'), cdn + '?redirect=evil', cdn.replace('https:', 'http:')]) assert.throws(() => validateDownloadURL(bad, initial));
  const f = await fixture(t, { preference: 'gitee', reply: (url, _init, fallback) => {
    const destination = url === initial ? attachment : url === attachment ? cdn : undefined;
    if (destination) { const result = response(null, url, 302); result.headers.set('location', destination); return result; }
    return url === cdn ? response(BYTES, url) : fallback();
  } });
  await f.service.check(); assert.equal((await f.service.download()).phase, 'downloaded');
  assert.deepEqual(f.calls, [API.gitee, initial, attachment, cdn]); assert.equal(f.opened.length, 0);
});

const SIGNED_CDN_TOKEN = '0123456789abcdef0123456789abcdef'; // Synthetic fixture, never an API credential.
function signedGiteeURL(name: string, id = '1776922953017544574') {
  return `https://foruda.gitee.com/attach_file/${id}/${encodeURIComponent(name.toLowerCase())}?` + new URLSearchParams({ token: SIGNED_CDN_TOKEN, ts: '1700000000', attname: name });
}

test('signed Foruda URLs require exactly three valid fields and the original attachment name', () => {
  const initial = release('gitee').assets[0].browser_download_url, name = release('gitee').assets[0].name;
  const signed = signedGiteeURL(name);
  assert.equal(validateDownloadURL(signed, initial), signed);
  const encodedName = 'Pairleaf-0.7.0+Build7-mac-universal.dmg.part001';
  const encodedInitial = `${REPO.gitee}/releases/download/v0.7.0/${encodeURIComponent(encodedName)}`;
  assert.equal(validateDownloadURL(signedGiteeURL(encodedName), encodedInitial), signedGiteeURL(encodedName));
  const changed = (key: string, value: string | null) => { const url = new URL(signed); if (value === null) url.searchParams.delete(key); else url.searchParams.set(key, value); return url.href; };
  for (const invalid of [
    signed + '&extra=value', signed + '&token=' + SIGNED_CDN_TOKEN, signed + '&ts=1700000001', signed + '&attname=' + encodeURIComponent(name),
    changed('token', 'f'.repeat(31)), changed('token', 'g'.repeat(32)), changed('token', null),
    changed('ts', '0'), changed('ts', '-1'), changed('ts', '1700000000.1'), changed('ts', '1'.repeat(14)), changed('ts', null),
    changed('attname', name.toLowerCase()), changed('attname', '../' + name), changed('attname', null),
    signed.replace('/' + name.toLowerCase() + '?', '/' + name + '?'),
    signed.replace('foruda.gitee.com', 'foruda.gitee.com.evil.test'), signed.replace('foruda.gitee.com', 'user:password@foruda.gitee.com'),
    signed.replace('foruda.gitee.com', 'foruda.gitee.com:443'), signed.replace('foruda.gitee.com', 'foruda.gitee.com:444'),
    signed.replace('https:', 'http:'), signed.replace('/attach_file/', '/other/'), signed.replace('1776922953017544574', 'not-an-id'),
    signed + '#', signed.replace('/attach_file/', '\\attach_file/'),
    `https://foruda.gitee.com/attach_file/1776922953017544574/${name}?`,
  ]) assert.throws(() => validateDownloadURL(invalid, initial), /invalid-url/);
});

test('signed lowercase Gitee download redirects preserve size/hash checks and never expose their token', async t => {
  for (const payload of ['valid', 'wrong-size', 'wrong-hash'] as const) {
    const name = release('gitee').assets[0].name, initial = release('gitee').assets[0].browser_download_url;
    const attachment = `${REPO.gitee}/attach_files/2693158/download/${name}`, cdn = signedGiteeURL(name);
    const f = await fixture(t, { preference: 'gitee', reply: (url, _init, fallback) => {
      const destination = url === initial ? attachment : url === attachment ? cdn : undefined;
      if (destination) { const result = response(null, url, 302); result.headers.set('location', destination); return result; }
      return url === cdn ? response(payload === 'valid' ? BYTES : payload === 'wrong-size' ? BYTES.subarray(1) : Buffer.alloc(BYTES.length), url) : fallback();
    } });
    await f.service.check(); const state = await f.service.download();
    assert.deepEqual(f.calls, [API.gitee, initial, attachment, cdn]);
    if (payload === 'valid') {
      assert.equal(state.phase, 'downloaded'); assert.deepEqual(await fs.readFile(path.join(f.directory, name)), BYTES);
    } else {
      assert.equal(state.error, payload === 'wrong-size' ? 'length-mismatch' : 'checksum-mismatch');
      assert.equal((await f.service.install()).error, 'not-ready');
    }
    assert.doesNotMatch(JSON.stringify(f.states), new RegExp(SIGNED_CDN_TOKEN));
    assert.doesNotMatch(await fs.readFile(path.join(f.directory, 'release-cache.json'), 'utf8'), /foruda\.gitee\.com|0123456789abcdef0123456789abcdef/);
    assert.ok((await fs.readdir(f.directory)).every(filename => !filename.endsWith('.part'))); assert.equal(f.opened.length, 0);
  }
});

test('invalid raw signed redirects are rejected before URL normalization or a CDN fetch', async t => {
  const name = release('gitee').assets[0].name, initial = release('gitee').assets[0].browser_download_url;
  const cdn = signedGiteeURL(name);
  for (const destination of [cdn.replace('foruda.gitee.com', 'foruda.gitee.com:443'), cdn + '#', cdn.replace('/attach_file/', '\\attach_file/'), cdn + '&unknown=1']) {
    const f = await fixture(t, { preference: 'gitee', reply: (url, _init, fallback) => {
      if (url === initial) { const result = response(null, url, 302); result.headers.set('location', destination); return result; }
      return fallback();
    } });
    await f.service.check(); assert.equal((await f.service.download()).error, 'invalid-url');
    assert.deepEqual(f.calls, [API.gitee, initial]); assert.equal(f.opened.length, 0);
  }
});

function splitRelease() {
  const raw = release('gitee'), name = raw.assets[0].name;
  const bytes = [BYTES.subarray(0, 17), BYTES.subarray(17, 34), BYTES.subarray(34)];
  const parts = bytes.map((value, index) => ({ name: updatePartName(name, index + 1), size: value.length, sha256: digest(value) }));
  raw.body = appendUpdateManifest('Split release notes.', { schema: 1, version: '0.7.0', assets: [{ name, size: BYTES.length, sha256: digest(BYTES), parts }] });
  raw.assets = parts.map(part => ({ name: part.name, browser_download_url: `${REPO.gitee}/releases/download/v0.7.0/${part.name}` }));
  const urls = raw.assets.map(asset => asset.browser_download_url);
  const reply = (url: string, fallback: () => Response) => urls.includes(url) ? response(bytes[urls.indexOf(url)], url) : fallback();
  return { raw, name, bytes, parts, urls, reply };
}

test('Gitee multipart updates accept individually signed lowercase CDN files and verify the assembled installer', async t => {
  const split = splitRelease();
  const attachments = split.parts.map((part, index) => `${REPO.gitee}/attach_files/${2693158 + index}/download/${part.name}`);
  const signed = split.parts.map((part, index) => signedGiteeURL(part.name, String(1776922953017544 + index)));
  const f = await fixture(t, { preference: 'gitee', gitee: split.raw, reply: (url, _init, fallback) => {
    const sourceIndex = split.urls.indexOf(url), attachmentIndex = attachments.indexOf(url), signedIndex = signed.indexOf(url);
    const destination = sourceIndex >= 0 ? attachments[sourceIndex] : attachmentIndex >= 0 ? signed[attachmentIndex] : undefined;
    if (destination) { const result = response(null, url, 302); result.headers.set('location', destination); return result; }
    return signedIndex >= 0 ? response(split.bytes[signedIndex], url) : fallback();
  } });
  await f.service.check(); assert.equal((await f.service.download()).phase, 'downloaded');
  assert.deepEqual(f.calls, [API.gitee, ...split.urls.flatMap((url, index) => [url, attachments[index], signed[index]])]);
  assert.deepEqual(await fs.readFile(path.join(f.directory, split.name)), BYTES);
  assert.doesNotMatch(JSON.stringify(f.states), /foruda\.gitee\.com|0123456789abcdef0123456789abcdef/);
  assert.ok((await fs.readdir(f.directory)).every(name => !name.includes('.part'))); assert.equal(f.opened.length, 0);
});

test('Gitee pieces stream in order into the original installer and only the assembled verified file can open', async t => {
  const split = splitRelease();
  const f = await fixture(t, { preference: 'gitee', gitee: split.raw, reply: (url, _init, fallback) => split.reply(url, fallback) });
  const checked = await f.service.check();
  assert.equal(checked.release?.assetName, split.name); assert.equal(checked.release?.size, BYTES.length);
  assert.equal(checked.release?.notes, 'Split release notes.'); assert.doesNotMatch(JSON.stringify(checked), /part00/);
  const downloaded = await f.service.download();
  assert.equal(downloaded.phase, 'downloaded'); assert.equal(downloaded.downloadedBytes, BYTES.length);
  assert.deepEqual(f.calls, [API.gitee, ...split.urls]);
  const filename = path.join(f.directory, split.name);
  assert.deepEqual(await fs.readFile(filename), BYTES);
  assert.ok((await fs.readdir(f.directory)).every(name => !name.includes('.part')));
  assert.equal(f.opened.length, 0); await f.service.install(); assert.deepEqual(f.opened, [filename]);
  await fs.writeFile(filename, Buffer.alloc(BYTES.length));
  assert.equal((await f.service.install()).error, 'checksum-mismatch'); assert.equal(f.opened.length, 1);
});

test('a full Gitee attachment is preferred over parts with the same verified logical filename', async t => {
  const split = splitRelease(), whole = release('gitee').assets[0];
  split.raw.assets = [whole, ...split.raw.assets];
  const f = await fixture(t, { preference: 'gitee', gitee: split.raw });
  await f.service.check(); assert.equal((await f.service.download()).phase, 'downloaded');
  assert.deepEqual(f.calls, [API.gitee, whole.browser_download_url]);
});

test('missing/duplicate/misrouted Gitee pieces and malformed part manifests block the logical asset', async t => {
  for (const failure of ['missing', 'duplicate', 'url', 'name', 'total'] as const) {
    const split = splitRelease();
    if (failure === 'missing') split.raw.assets.pop();
    if (failure === 'duplicate') split.raw.assets = [...split.raw.assets, split.raw.assets[0]];
    if (failure === 'url') split.raw.assets[1].browser_download_url = split.raw.assets[1].browser_download_url.replace('/v0.7.0/', '/v0.6.0/');
    if (failure === 'name' || failure === 'total') {
      const manifest = readUpdateManifest(split.raw.body, '0.7.0')!;
      if (failure === 'name') manifest.assets[0].parts![0].name = '../another.dmg'; else manifest.assets[0].parts![0].size++;
      split.raw.body = `<!-- pairleaf-update-v1\n${JSON.stringify(manifest)}\n-->`;
    }
    const f = await fixture(t, { preference: 'gitee', gitee: split.raw });
    const state = await f.service.check();
    assert.equal(state.error, failure === 'missing' ? 'missing-asset' : failure === 'url' ? 'invalid-url' : 'invalid-release');
    assert.notEqual((await f.service.download()).phase, 'downloaded'); assert.equal(f.calls.length, 1);
  }
});

test('part length, individual checksum and whole-file checksum are independently enforced', async t => {
  for (const failure of ['part-length', 'part-checksum', 'whole-checksum'] as const) {
    const split = splitRelease();
    if (failure === 'whole-checksum') {
      const manifest = readUpdateManifest(split.raw.body, '0.7.0')!; manifest.assets[0].sha256 = 'f'.repeat(64);
      split.raw.body = appendUpdateManifest('Test mismatch', manifest);
    }
    const f = await fixture(t, { preference: 'gitee', gitee: split.raw, reply: (url, _init, fallback) => {
      if (url === split.urls[1] && failure !== 'whole-checksum') return response(failure === 'part-length' ? split.bytes[1].subarray(1) : Buffer.alloc(split.bytes[1].length), url);
      return split.reply(url, fallback);
    } });
    await f.service.check(); const state = await f.service.download();
    assert.equal(state.error, failure === 'part-length' ? 'length-mismatch' : 'checksum-mismatch');
    assert.equal((await f.service.install()).error, 'not-ready'); assert.equal(f.opened.length, 0);
    assert.ok((await fs.readdir(f.directory)).every(name => !name.includes('.part') && !name.endsWith('.dmg')));
  }
});

test('cancelling midway through Gitee pieces removes the assembled partial file and prevents later-piece fetches', async t => {
  const split = splitRelease(); let partStarted!: () => void, cancelled = false;
  const started = new Promise<void>(resolve => { partStarted = resolve; });
  const f = await fixture(t, { preference: 'gitee', gitee: split.raw, reply: (url, _init, fallback) => {
    if (url === split.urls[1]) { partStarted(); return response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(split.bytes[1].subarray(0, 1)); }, cancel() { cancelled = true; } }), url); }
    return split.reply(url, fallback);
  } });
  await f.service.check(); const downloading = f.service.download(); await started;
  assert.equal((await f.service.cancel()).error, 'cancelled'); await downloading;
  assert.equal(cancelled, true); assert.equal(f.calls.includes(split.urls[2]), false);
  assert.ok((await fs.readdir(f.directory)).every(name => !name.includes('.part') && !name.endsWith('.dmg')));
  assert.equal(f.opened.length, 0);
});

test('automatic fallback after a Gitee part network failure downloads only an identical GitHub whole asset', async t => {
  const split = splitRelease();
  const f = await fixture(t, { gitee: split.raw, reply: (url, _init, fallback) => url === split.urls[1] ? response('', url, 503) : split.reply(url, fallback) });
  await f.service.check(); const state = await f.service.download();
  assert.equal(state.phase, 'downloaded'); assert.equal(state.source, 'github'); assert.equal(state.sourceReason, 'source-fallback');
  assert.equal(f.calls.includes(split.urls[2]), false); assert.equal(f.calls.at(-1), f.github.assets[0].browser_download_url);
  assert.deepEqual(await fs.readFile(path.join(f.directory, split.name)), BYTES);
  assert.ok((await fs.readdir(f.directory)).every(name => !name.includes('.part')));
});

test('Gitee release-list ordering and upload-in-progress prereleases cannot hide the highest stable version', async t => {
  const newer = release('gitee', '0.8.0'), prerelease = { ...release('gitee', '0.9.0'), prerelease: true };
  const f = await fixture(t, { preference: 'gitee', reply: (url, _init, fallback) => url === API.gitee
    ? response(JSON.stringify([release('gitee', '0.7.0'), prerelease, { ...newer, tag_name: 'not-semver' }, newer]), url) : fallback() });
  const state = await f.service.check(); assert.equal(state.release?.version, '0.8.0'); assert.equal(state.release?.downloadable, true);
  assert.equal(f.calls.some(url => url.includes('/releases/latest')), false);
});

test('Gitee release selection inspects later bounded pages instead of treating the first page as latest', async t => {
  const ignored = Array.from({ length: 99 }, (_, index) => ({ tag_name: `unrelated-${index}`, prerelease: false }));
  const secondPage = API.gitee.replace('&page=1', '&page=2');
  const f = await fixture(t, { preference: 'gitee', reply: (url, _init, fallback) => url === API.gitee
    ? response(JSON.stringify([release('gitee', '0.7.0'), ...ignored]), url)
    : url === secondPage ? response(JSON.stringify([release('gitee', '0.8.0')]), url) : fallback() });
  assert.equal((await f.service.check()).release?.version, '0.8.0'); assert.deepEqual(f.calls, [API.gitee, secondPage]);
});

test('empty Gitee repositories fall back automatically but stay no-release in manual Gitee mode', async t => {
  for (const preference of ['auto', 'gitee'] as const) {
    const f = await fixture(t, { preference, reply: (url, _init, fallback) => url === API.gitee ? response('[]', url) : fallback() });
    const state = await f.service.check();
    if (preference === 'auto') { assert.equal(state.source, 'github'); assert.equal(state.sourceReason, 'source-fallback'); }
    else { assert.equal(state.error, 'no-release'); assert.deepEqual(f.calls, [API.gitee]); }
  }
});

test('Gitee metadata pagination has a ten-page and aggregate two-MiB bound', async t => {
  for (const failure of ['page-limit', 'byte-limit'] as const) {
    const batch = Array.from({ length: 100 }, (_, index) => ({ tag_name: `unrelated-${index}`, prerelease: false, body: index === 0 && failure === 'byte-limit' ? 'x'.repeat(1_100_000) : '' }));
    const f = await fixture(t, { preference: 'gitee', requestTimeoutMs: 1000, reply: url => response(JSON.stringify(batch), url) });
    assert.equal((await f.service.check()).error, 'invalid-release');
    assert.equal(f.calls.length, failure === 'page-limit' ? 10 : 2);
    assert.equal(f.opened.length, 0);
  }
});

test('region detector failure records unknown and still compares both official sources', async t => {
  const f = await fixture(t, { detectRegion: async () => { throw new Error('private region service details'); } });
  const state = await f.service.check();
  assert.equal(state.source, 'github'); assert.equal(state.region, 'unknown'); assert.equal(state.sourceReason, 'region-unavailable');
  assert.doesNotMatch(JSON.stringify(state), /private region service/); assert.equal(f.calls.length, 2);
});

test('switching back after a source-changing download cannot reuse the earlier session check flag', async t => {
  const f = await fixture(t, { preference: 'github' }); await f.service.check();
  f.preference.value = 'gitee'; await f.service.download();
  f.preference.value = 'github';
  assert.equal((await f.service.check()).source, 'github'); assert.equal(f.calls.at(-1), API.github);
  assert.equal(f.calls.filter(url => url === API.github).length, 2);
});
