import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const { prepareRelease, publishRelease, localSourcePreflight, TARGETS } = await import(new URL('../scripts/publish-release.mjs', import.meta.url).href);
const commit = 'a'.repeat(40), version = '0.7.0';
const githubToken = 'github-fixture-credential', giteeToken = 'gitee-fixture-credential';
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const sourceArchives = (tag: string) => ['.zip', '.tar.gz'].map(suffix => ({
  name: tag + suffix,
  browser_download_url: `https://gitee.com/${TARGETS.gitee.repository}/archive/refs/tags/${encodeURIComponent(tag)}${suffix}`,
}));
async function fixture(t: { after: (fn: () => Promise<void>) => void }, changes = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-publish-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const suffix of ['mac-universal.dmg', 'windows-x64-setup.exe', 'windows-x64-portable.exe'])
    await writeFile(path.join(directory, `Pairleaf-${version}-${suffix}`), Buffer.from(suffix + ':local fixture bytes:'.repeat(7)));
  for (const name of [`Pairleaf-${version}-mac-license-notices.zip`, `Pairleaf-${version}-windows-license-notices.zip`, 'INSTALL-MAC.txt', 'INSTALL-WINDOWS.txt'])
    await writeFile(path.join(directory, name), 'Small local fixture: ' + name);
  await writeFile(path.join(directory, 'RELEASE.md'), 'Release fixture notes. No real credentials or installers.');
  const plan = await prepareRelease({ directory, version, commit, giteePartSize: 80, ...changes });
  return { directory, plan };
}
function http(plan: any) {
  const state: Record<string, any> = { github: { release: undefined, files: new Map() }, gitee: { release: undefined, files: new Map() } };
  const calls: { host: string; method: string; route: string; query: string }[] = [];
  let failGiteeUpload = false, failGithubFinalize = false;
  const history: Record<string, any[]> = { github: [], gitee: [] };
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const release = (host: string) => state[host].release && { ...state[host].release,
    assets: [...state[host].files.values()].map(item => item.asset).concat(host === 'gitee' ? sourceArchives(state[host].release.tag_name) : []) };
  const fetch = async (input: string, init: any = {}) => {
    const url = new URL(input), host = url.hostname === 'gitee.com' ? 'gitee' : 'github', method = init.method ?? 'GET';
    const route = url.pathname.replace(/^\/api\/v5/, '');
    calls.push({ host, method, route, query: url.search });
    if (route.includes('/releases/download/')) {
      assert.equal(new Headers(init.headers).has('authorization'), false, 'Publishing credentials must never accompany public downloads');
      const name = decodeURIComponent(url.pathname.split('/').at(-1)!);
      const file = state[host].files.get(name);
      if (!file) return response({}, 404);
      if (method === 'HEAD') return new Response(null, { headers: { 'Content-Length': String(file.bytes.length) } });
      return new Response(file.bytes, { headers: { 'Content-Length': String(file.bytes.length) } });
    }
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${host === 'github' ? githubToken : giteeToken}`);
    assert.ok(!url.search.includes('token'), 'Credentials must not enter URLs');
    if (route === '/user') return response({ login: 'fixture-owner' });
    const base = '/repos/' + TARGETS[host].repository;
    if (route === base) return response({ permissions: { push: true } });
    if (route === base + '/releases' && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? 1), count = Number(url.searchParams.get('per_page') ?? 100);
      return response([...history[host], ...(release(host) ? [release(host)] : [])].slice((page - 1) * count, page * count));
    }
    // GitHub's tag lookup does not expose draft releases. Retrying must find
    // those via the authenticated list, rather than silently creating another.
    if (route.startsWith(base + '/releases/tags/')) return release(host) && !(host === 'github' && state[host].release.draft) ? response(release(host)) : response({}, 404);
    if (route === base + '/releases' && method === 'POST') {
      if (state[host].release) return response({ error: 'A release for this tag already exists' }, 422);
      const data = typeof init.body === 'string' ? JSON.parse(init.body) : Object.fromEntries(init.body);
      for (const flag of ['draft', 'prerelease']) if (typeof data[flag] === 'string') data[flag] = data[flag] === 'true';
      state[host].release = { ...data, id: host === 'github' ? 11 : 22 };
      return response(release(host), 201);
    }
    const id = state[host].release?.id;
    if (route === base + `/releases/${id}`) {
      if (method === 'PATCH') {
        if (host === 'github' && failGithubFinalize) return response({ error: 'Final publication unavailable' }, 503);
        const data = typeof init.body === 'string' ? JSON.parse(init.body) : Object.fromEntries(init.body);
        for (const flag of ['draft', 'prerelease']) if (typeof data[flag] === 'string') data[flag] = data[flag] === 'true';
        assert.equal(data.tag_name, plan.tag); assert.equal(data.body, plan.body); assert.equal(data.name, plan.name);
        if (host === 'github' && data.make_latest === 'true') state.github.latest = data.tag_name;
        Object.assign(state[host].release, data);
      }
      return response(release(host));
    }
    if (route === base + `/releases/${id}/assets` && method === 'GET') return response([...state[host].files.values()].map(item => item.asset));
    if (method === 'POST' && (route.endsWith('/assets') || route.endsWith('/attach_files'))) {
      if (host === 'gitee' && failGiteeUpload) return response({ error: 'Repository upload rejected' }, 413);
      const blob = host === 'github' ? init.body : init.body.get('file');
      const name = host === 'github' ? url.searchParams.get('name') : blob.name;
      assert.ok(!state[host].files.has(name), 'An existing asset must never be overwritten');
      const bytes = Buffer.from(await blob.arrayBuffer());
      const asset = { name, ...(host === 'github' ? { size: bytes.length, digest: 'sha256:' + digest(bytes), state: 'uploaded' } : {}),
        browser_download_url: `https://${host === 'github' ? 'github.com' : 'gitee.com'}/${TARGETS[host].repository}/releases/download/${plan.tag}/${encodeURIComponent(name)}` };
      state[host].files.set(name, { bytes, asset });
      return response(asset, 201);
    }
    throw new Error('Unexpected mocked request: ' + method + ' ' + route);
  };
  return { fetch, calls, state,
    failGitee: (value: boolean) => { failGiteeUpload = value; },
    failGithubFinalize: (value: boolean) => { failGithubFinalize = value; },
    history: (value: any[]) => { history.gitee = value; },
    githubHistory: (value: any[]) => { history.github = value; },
    options: () => ({ execute: true, fetch, githubToken: async () => githubToken, giteeToken, remoteTag: async () => commit, assertSourceCommit: async () => {} }),
  };
}

const fakeCdnToken = 'a'.repeat(32);
function signedGiteeDownloads(transport: any, options: { changeRedirect?: (url: string, name: string) => string; corrupt?: boolean; historyName?: string } = {}) {
  return async (input: string, init: any = {}) => {
    const url = new URL(input), name = decodeURIComponent(url.pathname.split('/').at(-1)!);
    if (url.hostname === 'gitee.com' && url.pathname.includes('/releases/download/')) {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      return new Response(null, { status: 302, headers: { Location: `https://gitee.com/${TARGETS.gitee.repository}/attach_files/123/download/${encodeURIComponent(name)}` } });
    }
    if (url.hostname === 'gitee.com' && url.pathname.includes('/attach_files/')) {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      const query = new URLSearchParams({ token: fakeCdnToken, ts: '1700000000', attname: name });
      const location = `https://foruda.gitee.com/attach_file/123/${encodeURIComponent(name.toLowerCase())}?${query}`;
      return new Response(null, { status: 302, headers: { Location: options.changeRedirect?.(location, name) ?? location } });
    }
    if (url.hostname === 'foruda.gitee.com') {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      const originalName = url.searchParams.get('attname')!;
      if (init.method === 'HEAD') {
        assert.equal(originalName, options.historyName);
        return new Response(null, { headers: { 'Content-Length': '57' } });
      }
      const original = transport.state.gitee.files.get(originalName).bytes;
      const bytes = options.corrupt ? Buffer.alloc(original.length, 'z') : original;
      return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
    }
    return transport.fetch(input, init);
  };
}

test('default dry-run performs no credential lookup, HTTP request, alias creation or file write', async t => {
  const { directory, plan } = await fixture(t), before = await readdir(directory);
  const review = await publishRelease(plan, { fetch: () => assert.fail('No HTTP in dry-run'), githubToken: () => assert.fail('No credential lookup in dry-run') });
  assert.equal(review.mode, 'dry-run'); assert.equal(review.targets.github.files.length, 11);
  assert.ok(review.targets.gitee.files.some((item: any) => item.name.endsWith('.part001')));
  assert.ok(review.targets.gitee.files.every((item: any) => !item.name.startsWith('Folio-')));
  assert.deepEqual(await readdir(directory), before);
});

test('both hosts publish identical version, commit and manifest after full-file/part integrity verification; retries are idempotent', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  const result = await publishRelease(plan, transport.options());
  assert.equal(result.success, true); assert.deepEqual(result.states, { github: 'published', gitee: 'published' });
  assert.equal(transport.state.github.release.body, transport.state.gitee.release.body);
  assert.equal(transport.state.github.release.target_commitish, commit); assert.equal(transport.state.gitee.release.target_commitish, commit);
  assert.equal(transport.state.github.release.draft, false); assert.equal(transport.state.gitee.release.prerelease, false);
  assert.equal(transport.state.github.latest, plan.tag);
  for (const asset of plan.githubAssets.filter((item: any) => item.parts)) {
    const reconstructed = Buffer.concat(asset.parts.map((part: any) => transport.state.gitee.files.get(part.name).bytes));
    assert.equal(digest(reconstructed), asset.sha256); assert.deepEqual(reconstructed, await readFile(asset.file));
  }
  const mutations = transport.calls.filter(call => call.method === 'POST' || call.method === 'PATCH').length;
  await publishRelease(plan, transport.options());
  assert.equal(transport.calls.filter(call => call.method === 'POST' || call.method === 'PATCH').length, mutations);
});

test('one host failing leaves releases staged, reports failure, and safely resumes without uploading GitHub assets twice', async t => {
  const { plan } = await fixture(t), transport = http(plan); transport.failGitee(true);
  await assert.rejects(publishRelease(plan, transport.options()), /gitee POST returned HTTP 413.*quota/s);
  assert.equal(transport.state.github.release.draft, true); assert.equal(transport.state.gitee.release.prerelease, true);
  assert.ok(!transport.calls.some(call => call.method === 'PATCH'));
  const githubUploads = transport.calls.filter(call => call.host === 'github' && call.method === 'POST' && call.route.endsWith('/assets')).length;
  transport.failGitee(false);
  assert.equal((await publishRelease(plan, transport.options())).success, true);
  assert.equal(transport.calls.filter(call => call.host === 'github' && call.method === 'POST' && call.route.endsWith('/assets')).length, githubUploads);
});

test('Gitee 16 uploaded files plus two generated source archives finalize and resume without reuploading', async t => {
  const { directory } = await fixture(t);
  for (const [suffix, size] of [['mac-universal.dmg', 330], ['windows-x64-setup.exe', 210], ['windows-x64-portable.exe', 211]] as const)
    await writeFile(path.join(directory, `Pairleaf-${version}-${suffix}`), Buffer.alloc(size, 'x'));
  const plan = await prepareRelease({ directory, version, commit, giteePartSize: 80 });
  assert.equal(plan.giteeAssets.length, 16);
  const transport = http(plan), logs: string[] = [];
  let interruptFinalization = true;
  const options = { ...transport.options(), log: (line: string) => logs.push(line), fetch: async (input: string, init: any = {}) => {
    if (interruptFinalization && input.startsWith('https://gitee.com/') && init.method === 'PATCH') return new Response('{}', { status: 503 });
    return transport.fetch(input, init);
  } };
  await assert.rejects(publishRelease(plan, options), /gitee PATCH returned HTTP 503/);
  assert.equal(transport.state.gitee.release.prerelease, true);
  const response = await transport.fetch(`https://gitee.com/api/v5/repos/${TARGETS.gitee.repository}/releases/22`, { headers: { Authorization: `Bearer ${giteeToken}` } });
  assert.equal((await response.json()).assets.length, 18);
  const uploads = transport.calls.filter(call => call.method === 'POST').length;
  interruptFinalization = false;
  assert.equal((await publishRelease(plan, options)).success, true);
  assert.equal(transport.calls.filter(call => call.method === 'POST').length, uploads);
  assert.ok(plan.giteeAssets.every((asset: any) => logs.includes(`gitee: verifying ${asset.name}`)));
});

test('only exact platform archives are ignored; real extra ZIPs and lookalike URLs still block publication', async t => {
  const { plan } = await fixture(t);
  const canonical = sourceArchives(plan.tag)[0];
  const candidates = [
    { name: 'notes.zip', browser_download_url: `https://gitee.com/${TARGETS.gitee.repository}/releases/download/${plan.tag}/notes.zip` },
    { ...canonical, browser_download_url: `https://gitee.com/${TARGETS.gitee.repository}/releases/download/${plan.tag}/${canonical.name}` },
    { ...canonical, browser_download_url: canonical.browser_download_url.replace('gitee.com', 'example.com') },
    { ...canonical, browser_download_url: canonical.browser_download_url + '?download=1' },
    { ...canonical, browser_download_url: canonical.browser_download_url + '#source' },
    { ...canonical, browser_download_url: canonical.browser_download_url.replace('https://gitee.com/', 'https://user@gitee.com/') },
    { ...canonical, browser_download_url: canonical.browser_download_url.replace('https://gitee.com/', 'https://gitee.com:443/') },
    { ...canonical, name: 'other.zip' },
  ];
  for (const asset of candidates) {
    const transport = http(plan);
    transport.state.gitee.release = { id: 22, tag_name: plan.tag, name: plan.name, body: plan.body, prerelease: true };
    transport.state.gitee.files.set(asset.name, { bytes: Buffer.from('extra'), asset });
    await assert.rejects(publishRelease(plan, transport.options()), /unexpected or duplicate asset names/);
    assert.ok(!transport.calls.some(call => ['POST', 'PATCH', 'DELETE'].includes(call.method)));
  }
});

test('Gitee quota excludes generated source archives and retains real uploaded ZIP usage', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  const historical = sourceArchives('v0.1.0');
  transport.history([{ id: 1, tag_name: 'v0.1.0', assets: [
    ...historical.map(asset => ({ ...asset, size: 999_999_999 })),
    { name: 'v0.1.0.zip', size: 31, browser_download_url: `https://gitee.com/${TARGETS.gitee.repository}/releases/download/v0.1.0/v0.1.0.zip` },
    { name: 'notes.zip', size: 23, browser_download_url: `https://gitee.com/${TARGETS.gitee.repository}/releases/download/v0.1.0/notes.zip` },
  ] }]);
  const result = await publishRelease(plan, transport.options());
  assert.equal(result.success, true);
  assert.equal(result.quota.knownHistoricalBytes, 54);
  assert.equal(result.quota.unknownAttachmentCount, 0);
  assert.ok(!transport.calls.some(call => call.route.includes('/archive/refs/tags/')));
});

test('different existing remote bytes are rejected before any mutation', async t => {
  const { plan } = await fixture(t), transport = http(plan), first = plan.githubAssets[0];
  transport.state.github.release = { id: 11, tag_name: plan.tag, name: plan.name, body: plan.body, draft: true, prerelease: false };
  transport.state.github.files.set(first.name, { bytes: Buffer.from('different'), asset: { name: first.name, size: first.size, digest: 'sha256:' + '0'.repeat(64), state: 'uploaded' } });
  await assert.rejects(publishRelease(plan, transport.options()), /refusing to overwrite/);
  assert.ok(!transport.calls.some(call => ['POST', 'PATCH', 'DELETE'].includes(call.method)));
});

test('different local aliases are never replaced during planning', async t => {
  const { directory } = await fixture(t);
  const alias = path.join(directory, `Folio-${version}-mac-universal.dmg`); await writeFile(alias, 'different existing bytes');
  await assert.rejects(prepareRelease({ directory, version, commit }), /Legacy alias differs/);
  assert.equal(await readFile(alias, 'utf8'), 'different existing bytes');
});

test('failure messages redact known credentials and complete token query values, even before HTTP', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  const options = { ...transport.options(), assertSourceCommit: async () => { throw new Error(`Check failed ${giteeToken} ${githubToken} access_token=unrelated-secret&token=other-secret`); } };
  await assert.rejects(publishRelease(plan, options), (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const secret of [giteeToken, githubToken, 'unrelated-secret', 'other-secret']) assert.ok(!error.message.includes(secret));
    assert.match(error.message, /credential/); return true;
  });
  assert.equal(transport.calls.length, 0);
});

test('known historical Gitee attachment usage plus new bytes blocks exceeding quota before creating either release', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  transport.history([{ id: 1, tag_name: 'v0.1.0', assets: [{ name: 'old.bin', size: 999_999_999, browser_download_url: 'https://gitee.com/aurorasxh/pair-leaf/releases/download/v0.1.0/old.bin' }] }]);
  await assert.rejects(publishRelease(plan, transport.options()), /historical release attachments.*repository quota/);
  assert.ok(!transport.calls.some(call => ['POST', 'PATCH', 'DELETE'].includes(call.method)));
});

test('mismatched remote tags and oversized JSON are rejected without mutations or secret output', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  await assert.rejects(publishRelease(plan, { ...transport.options(), remoteTag: async () => 'b'.repeat(40) }), /tag does not point/);
  assert.ok(!transport.calls.some(call => ['POST', 'PATCH', 'DELETE'].includes(call.method)));
  await assert.rejects(publishRelease(plan, { ...transport.options(), fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /oversized JSON/);
});

test('existing stable release notes lacking the reviewed manifest are not overwritten', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  transport.state.github.release = { id: 11, tag_name: plan.tag, name: plan.name, body: 'Older published notes without integrity metadata', draft: false, prerelease: false };
  await assert.rejects(publishRelease(plan, transport.options()), /metadata differs/);
  assert.ok(!transport.calls.some(call => ['POST', 'PATCH', 'DELETE'].includes(call.method)));
});

test('a final publication failure reports the exact partially published state and a retry completes the other host', async t => {
  const { plan } = await fixture(t), transport = http(plan); transport.failGithubFinalize(true);
  await assert.rejects(publishRelease(plan, transport.options()), (error: any) => {
    assert.match(error.message, /github PATCH returned HTTP 503/);
    assert.deepEqual(error.states, { github: 'verified-staging', gitee: 'published' }); return true;
  });
  assert.equal(transport.state.github.release.draft, true); assert.equal(transport.state.gitee.release.prerelease, false);
  const uploads = transport.calls.filter(call => call.method === 'POST').length;
  transport.failGithubFinalize(false);
  assert.equal((await publishRelease(plan, transport.options())).success, true);
  assert.equal(transport.calls.filter(call => call.method === 'POST').length, uploads);
});

test('Gitee verification follows only the official repository/attachment/CDN chain without authorization headers', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  let redirects = 0;
  const routedFetch = async (input: string, init: any = {}) => {
    const url = new URL(input), name = decodeURIComponent(url.pathname.split('/').at(-1)!);
    if (url.hostname === 'gitee.com' && url.pathname.includes('/releases/download/')) {
      assert.equal(new Headers(init.headers).has('authorization'), false); redirects++;
      return new Response(null, { status: 302, headers: { Location: `https://gitee.com/${TARGETS.gitee.repository}/attach_files/123/download/${encodeURIComponent(name)}` } });
    }
    if (url.hostname === 'gitee.com' && url.pathname.includes('/attach_files/')) {
      assert.equal(new Headers(init.headers).has('authorization'), false); redirects++;
      return new Response(null, { status: 302, headers: { Location: `https://foruda.gitee.com/attach_file/123/${encodeURIComponent(name)}` } });
    }
    if (url.hostname === 'foruda.gitee.com') {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      return new Response(transport.state.gitee.files.get(name).bytes);
    }
    return transport.fetch(input, init);
  };
  assert.equal((await publishRelease(plan, { ...transport.options(), fetch: routedFetch })).success, true);
  assert.equal(redirects, plan.giteeAssets.length * 2);
});

test('Gitee signed lowercase CDN redirects verify full content and historical quota without logging signatures', async t => {
  const { plan } = await fixture(t), transport = http(plan), historyName = 'Old-Package.zip';
  transport.history([{ id: 1, tag_name: 'v0.1.0', assets: [{ name: historyName,
    browser_download_url: `https://gitee.com/${TARGETS.gitee.repository}/releases/download/v0.1.0/${historyName}` }] }]);
  const logs: string[] = [];
  const result = await publishRelease(plan, { ...transport.options(), fetch: signedGiteeDownloads(transport, { historyName }), log: (line: string) => logs.push(line) });
  assert.equal(result.success, true);
  assert.equal(result.quota.knownHistoricalBytes, 57);
  assert.equal(result.quota.unknownAttachmentCount, 0);
  assert.ok(plan.giteeAssets.every((asset: any) => logs.includes(`gitee: verified ${asset.name}`)));
  assert.ok(!logs.join('\n').includes(fakeCdnToken));
});

test('signed CDN redirect validation rejects extra or duplicate parameters and mismatched URL components', async t => {
  const { plan } = await fixture(t), first = plan.giteeAssets[0];
  const mutations: ((url: string, name: string) => string)[] = [
    url => url + '&extra=1',
    url => url + '&token=' + fakeCdnToken,
    (url, name) => url + '&attname=' + encodeURIComponent(name),
    url => url + '&ts=1700000000',
    url => { const changed = new URL(url); changed.searchParams.set('attname', 'wrong.bin'); return changed.href; },
    url => { const changed = new URL(url); changed.searchParams.set('token', 'not-a-signature'); return changed.href; },
    url => { const changed = new URL(url); changed.searchParams.set('ts', '-1'); return changed.href; },
    url => { const changed = new URL(url); changed.searchParams.set('ts', '1'.repeat(30)); return changed.href; },
    url => { const changed = new URL(url); changed.searchParams.delete('attname'); return changed.href; },
    url => url.replace('/attach_file/123/', '/attach_file/not-numeric/'),
    (url, name) => url.replace(encodeURIComponent(name.toLowerCase()) + '?', 'wrong.bin?'),
    (url, name) => url.replace(encodeURIComponent(name.toLowerCase()) + '?', encodeURIComponent(name) + '?'),
    url => url.replace('foruda.gitee.com', 'evil.example'),
    url => url.replace('https:', 'http:'),
    url => url.replace('https://', 'https://user@'),
    url => url.replace('foruda.gitee.com/', 'foruda.gitee.com:443/'),
    url => url + '#download',
    (_url, name) => `https://gitee.com/${TARGETS.gitee.repository}/attach_files/123/download/${encodeURIComponent(name)}?token=${fakeCdnToken}`,
  ];
  for (const changeRedirect of mutations) {
    const transport = http(plan);
    transport.state.gitee.release = { id: 22, tag_name: plan.tag, name: plan.name, body: plan.body, prerelease: true };
    transport.state.gitee.files.set(first.name, { bytes: Buffer.alloc(first.size), asset: { name: first.name,
      browser_download_url: `https://gitee.com/${TARGETS.gitee.repository}/releases/download/${plan.tag}/${first.name}` } });
    await assert.rejects(publishRelease(plan, { ...transport.options(), fetch: signedGiteeDownloads(transport, { changeRedirect }) }), (error: any) => {
      assert.match(error.message, /redirected to an unexpected host or path/);
      assert.ok(!error.message.includes(fakeCdnToken)); return true;
    });
    assert.ok(!transport.calls.some(call => ['POST', 'PATCH', 'DELETE'].includes(call.method)));
  }
});

test('a valid signed CDN redirect cannot bypass the expected full-file SHA-256', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  await assert.rejects(publishRelease(plan, { ...transport.options(), fetch: signedGiteeDownloads(transport, { corrupt: true }) }), /different or incomplete content/);
  assert.ok(!transport.calls.some(call => call.method === 'PATCH'));
  assert.equal(transport.state.gitee.release.prerelease, true);
});

test('a same-host Gitee download URL for the wrong asset is rejected before downloading or mutating', async t => {
  const { plan } = await fixture(t), transport = http(plan), first = plan.giteeAssets[0];
  transport.state.gitee.release = { id: 22, tag_name: plan.tag, name: plan.name, body: plan.body, prerelease: true };
  transport.state.gitee.files.set(first.name, { bytes: Buffer.from('irrelevant'), asset: { name: first.name,
    browser_download_url: `https://gitee.com/${TARGETS.gitee.repository}/releases/download/${plan.tag}/another-file.bin` } });
  await assert.rejects(publishRelease(plan, transport.options()), /unexpected download URL/);
  assert.ok(!transport.calls.some(call => ['POST', 'PATCH', 'DELETE'].includes(call.method)));
  assert.ok(!transport.calls.some(call => call.route.includes('/releases/download/')));
});

test('matching HEAD and tags cannot publish a source commit whose package version differs from the release', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  const reads: string[][] = [];
  let committedPackage = JSON.stringify({ version: '0.6.0' });
  const readGit = async (args: string[]) => {
    reads.push(args);
    if (args[0] === 'status') return '';
    if (args[0] === 'rev-parse') return commit;
    assert.deepEqual(args, ['show', `${commit}:package.json`]);
    return committedPackage;
  };
  const assertSourceCommit = (source: string, tag: string) => localSourcePreflight(source, tag, readGit);
  await assert.rejects(publishRelease(plan, { ...transport.options(), assertSourceCommit }), /committed package\.json version does not match/);
  assert.equal(transport.calls.length, 0, 'Version mismatch must fail before any HTTP request or release mutation');
  assert.ok(reads.some(args => args[0] === 'show' && args[1] === `${commit}:package.json`));
  committedPackage = JSON.stringify({ version });
  await assertSourceCommit(commit, plan.tag);
  committedPackage = '{broken';
  await assert.rejects(assertSourceCommit(commit, plan.tag), /Unable to read package\.json from the release source commit/);
});

test('an existing GitHub draft is found on a later authenticated list page when its tag endpoint returns 404', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  transport.state.github.release = { id: 11, tag_name: plan.tag, name: plan.name, body: plan.body,
    target_commitish: commit, draft: true, prerelease: false };
  transport.githubHistory([
    ...Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, tag_name: `v0.0.${index}`, draft: false, prerelease: false })),
    { id: 2000, tag_name: 'v99.0.0', draft: true, prerelease: false },
    { id: 2001, tag_name: 'v100.0.0', draft: false, prerelease: true },
  ]);
  assert.equal((await publishRelease(plan, transport.options())).success, true);
  assert.ok(transport.calls.some(call => call.host === 'github' && call.method === 'GET'
    && call.route.endsWith('/releases') && call.query.includes('page=2')));
  assert.equal(transport.calls.filter(call => call.host === 'github' && call.method === 'POST' && call.route.endsWith('/releases')).length, 0);
  assert.equal(transport.state.github.release.id, 11);
  assert.equal(transport.state.github.release.make_latest, 'true', 'Unpublished drafts and prereleases must not block a newer stable release');
});

test('backfilling and retrying an old tag preserves the newer stable GitHub latest version', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  transport.githubHistory([{ id: 30, tag_name: 'v0.10.0', draft: false, prerelease: false }]);
  transport.state.github.latest = 'v0.10.0';
  transport.failGitee(true);
  await assert.rejects(publishRelease(plan, transport.options()), /gitee POST returned HTTP 413/);
  assert.equal(transport.state.github.release.draft, true);
  transport.failGitee(false);
  assert.equal((await publishRelease(plan, transport.options())).success, true);
  assert.equal(transport.state.github.release.make_latest, 'false');
  assert.equal(transport.state.github.latest, 'v0.10.0');
  assert.equal(transport.calls.filter(call => call.host === 'github' && call.method === 'POST' && call.route.endsWith('/releases')).length, 1,
    'A retry must reuse the previous draft rather than create a second release');
});

test('the latest-version comparison is refreshed if a newer stable release appears while attachments upload', async t => {
  const { plan } = await fixture(t), transport = http(plan);
  let appeared = false;
  const fetch = async (input: string, init: any = {}) => {
    if (!appeared && input.includes('gitee.com') && input.includes('/releases/download/')) {
      appeared = true;
      transport.githubHistory([{ id: 40, tag_name: 'v1.0.0', draft: false, prerelease: false }]);
      transport.state.github.latest = 'v1.0.0';
    }
    return transport.fetch(input, init);
  };
  assert.equal((await publishRelease(plan, { ...transport.options(), fetch })).success, true);
  assert.equal(appeared, true); assert.equal(transport.state.github.release.make_latest, 'false');
  assert.equal(transport.state.github.latest, 'v1.0.0');
});

test('draft discovery stops at its pagination bound rather than creating an unverified duplicate', async t => {
  const { plan } = await fixture(t), transport = http(plan); let pages = 0;
  const fetch = async (input: string, init: any = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases') && (init.method ?? 'GET') === 'GET') {
      pages++;
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: index + 1, tag_name: `v0.0.${index}`, draft: false, prerelease: false }))));
    }
    return transport.fetch(input, init);
  };
  await assert.rejects(publishRelease(plan, { ...transport.options(), fetch }), /bounded release lookup/);
  assert.equal(pages, 20);
  assert.ok(!transport.calls.some(call => ['POST', 'PATCH', 'DELETE'].includes(call.method)));
});
