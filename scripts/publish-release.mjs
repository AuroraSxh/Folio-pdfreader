#!/usr/bin/env node
// One reviewed set of bytes, two fixed official repositories. No release is
// changed unless --execute is explicit; importing this module is side-effect free.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { access, lstat, readFile, link, mkdir, writeFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendUpdateManifest, updatePartName } from '../shared/update-manifest.ts';

export const TARGETS = Object.freeze({
  github: { repository: 'AuroraSxh/Folio-pdfreader', api: 'https://api.github.com', git: 'https://github.com/AuroraSxh/Folio-pdfreader.git' },
  gitee: { repository: 'aurorasxh/pair-leaf', api: 'https://gitee.com/api/v5', git: 'https://gitee.com/aurorasxh/pair-leaf.git' },
});
export const DEFAULT_PART_SIZE = 48 * 1024 * 1024;
export const DEFAULT_GITEE_ASSET_LIMIT = 100_000_000;
export const DEFAULT_GITEE_TOTAL_LIMIT = 1_000_000_000;
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const suffixes = ['mac-universal.dmg', 'windows-x64-setup.exe', 'windows-x64-portable.exe'];
const fail = message => { throw new Error(message); };
const same = (actual, expected) => actual.size === expected.size && actual.sha256 === expected.sha256;
const metadata = item => ({ name: item.name, size: item.size, sha256: item.sha256, ...(item.parts ? { parts: item.parts.map(metadata) } : {}) });
function mayPromoteGithubRelease(releases, version) {
  const parse = tag => {
    if (typeof tag !== 'string' || tag.length > 200) return undefined;
    const match = tag.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/);
    return match?.slice(1, 4).map(value => BigInt(value));
  };
  const candidate = parse(version);
  if (!candidate) return false;
  return releases.filter(release => !release.draft && !release.prerelease).every(release => {
    const existing = parse(release.tag_name);
    // An unrecognized stable tag cannot safely be treated as an older version.
    if (!existing) return false;
    for (let index = 0; index < 3; index++) {
      if (existing[index] > candidate[index]) return false;
      if (existing[index] < candidate[index]) return true;
    }
    return true;
  });
}

async function digest(file, range) {
  const checksum = createHash('sha256'); let size = 0;
  for await (const bytes of createReadStream(file, range)) { checksum.update(bytes); size += bytes.length; }
  return { size, sha256: checksum.digest('hex') };
}
async function inspect(file, name = path.basename(file)) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 1024 ** 3) fail(`Expected a nonempty regular release file: ${name}`);
  return { name, file, ...await digest(file) };
}
async function exists(file) { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

/** Reads and hashes files only. Missing aliases/checksums/parts are represented
 * in the plan and materialized only after every execution preflight succeeds. */
export async function prepareRelease({ directory, version, commit, notesFile, giteePartSize = DEFAULT_PART_SIZE, giteeAssetLimit = DEFAULT_GITEE_ASSET_LIMIT, giteeTotalLimit = DEFAULT_GITEE_TOTAL_LIMIT }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) fail('Use a stable release version such as 0.7.0.');
  if (!/^[a-f0-9]{40}$/i.test(commit ?? '')) fail('A full 40-character release commit SHA is required.');
  if (!Number.isSafeInteger(giteeAssetLimit) || giteeAssetLimit < 1 || giteeAssetLimit > 1024 ** 3) fail('Invalid Gitee asset limit.');
  if (!Number.isSafeInteger(giteePartSize) || giteePartSize < 0 || giteePartSize > giteeAssetLimit) fail('The Gitee part size must fit its declared per-file quota.');
  if (!Number.isSafeInteger(giteeTotalLimit) || giteeTotalLimit < 1) fail('Invalid Gitee total attachment quota.');
  const folder = path.resolve(directory), notesPath = path.resolve(notesFile ?? path.join(folder, 'RELEASE.md'));
  const notes = (await readFile(notesPath, 'utf8')).trim();
  if (!notes || notes.length > 24000) fail('Release notes must contain 1–24,000 characters.');
  const assets = [];
  for (const suffix of suffixes) {
    const name = `Pairleaf-${version}-${suffix}`, original = await inspect(path.join(folder, name));
    const aliasName = `Folio-${version}-${suffix}`, aliasFile = path.join(folder, aliasName);
    const alias = await exists(aliasFile) ? await inspect(aliasFile) : { ...original, name: aliasName, file: aliasFile, source: original.file };
    if (!same(alias, original)) fail(`Legacy alias differs from the canonical package: ${aliasName}`);
    if (giteePartSize && original.size > giteePartSize) {
      const count = Math.ceil(original.size / giteePartSize);
      if (count > 64) fail(`Too many parts for ${name}; increase the part size within the host quota.`);
      original.parts = [];
      for (let index = 0; index < count; index++) {
        const start = index * giteePartSize, end = Math.min(original.size, start + giteePartSize) - 1;
        const partName = updatePartName(name, index + 1);
        const part = { name: partName, file: path.join(folder, 'gitee-parts', partName), source: original.file, start, end, ...await digest(original.file, { start, end }) };
        if (await exists(part.file) && !same(await inspect(part.file), part)) fail(`Existing part has different content: ${partName}`);
        original.parts.push(part);
      }
    }
    assets.push(original, alias);
  }
  for (const name of [`Pairleaf-${version}-mac-license-notices.zip`, `Pairleaf-${version}-windows-license-notices.zip`, 'INSTALL-MAC.txt', 'INSTALL-WINDOWS.txt'])
    assets.push(await inspect(path.join(folder, name)));
  const checksumsFile = path.join(folder, 'SHA256SUMS.txt');
  let checksums = assets.map(item => `${item.sha256}  ${item.name}`).join('\n') + '\n';
  if (await exists(checksumsFile)) {
    await inspect(checksumsFile);
    const existing = await readFile(checksumsFile, 'utf8'), values = new Map();
    for (const line of existing.trim().split(/\r?\n/)) {
      const match = line.match(/^([a-fA-F0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)$/);
      if (!match || values.has(match[2])) fail('SHA256SUMS.txt is malformed or contains duplicate entries.');
      values.set(match[2], match[1].toLowerCase());
    }
    if (values.size !== assets.length || assets.some(item => values.get(item.name) !== item.sha256)) fail('SHA256SUMS.txt does not match the local release files.');
    checksums = existing;
  }
  assets.push({ name: 'SHA256SUMS.txt', file: checksumsFile, content: checksums, size: Buffer.byteLength(checksums), sha256: hash(checksums) });
  const manifest = { schema: 1, version, assets: assets.map(metadata) };
  const body = appendUpdateManifest(notes, manifest);
  const githubAssets = assets;
  // Legacy Folio clients use GitHub. Avoid spending Gitee's 1 GB attachment
  // quota on duplicate aliases: new Gitee-aware clients use canonical names.
  const giteeAssets = assets.filter(item => !item.name.startsWith('Folio-')).flatMap(item => item.parts ?? [item]);
  if (giteeAssets.some(item => item.size > giteeAssetLimit)) fail('A Gitee attachment exceeds the configured per-file quota. Use the default 48 MiB parts.');
  if (giteeAssets.reduce((sum, item) => sum + item.size, 0) > giteeTotalLimit) fail('This release alone exceeds the configured Gitee total attachment quota.');
  return { version, commit: commit.toLowerCase(), tag: `v${version}`, name: `Pairleaf v${version}`, directory: folder, body, manifest, githubAssets, giteeAssets, giteeTotalLimit };
}

export function reviewPlan(plan) {
  return { mode: 'dry-run', version: plan.version, tag: plan.tag, commit: plan.commit,
    notesAndManifestBytes: Buffer.byteLength(plan.body),
    targets: Object.fromEntries(Object.entries(TARGETS).map(([host, target]) => [host, {
      repository: target.repository, staging: host === 'github' ? 'private draft' : 'PUBLIC prerelease',
      bytes: plan[host + 'Assets'].reduce((sum, item) => sum + item.size, 0),
      ...(host === 'gitee' ? { totalAttachmentQuota: plan.giteeTotalLimit } : {}),
      files: plan[host + 'Assets'].map(metadata),
    }])),
    note: 'No local or remote writes. Execution requires GITEE_TOKEN, an existing gh login, a clean source commit and the same pushed tag in both official repositories.' };
}

export async function localSourcePreflight(commit, tag, readGit) {
  const run = readGit ?? (async args => {
    try { return (await exec('git', args, { maxBuffer: 1024 * 1024 })).stdout.trim(); }
    catch { fail('Unable to verify the local Git release state.'); }
  });
  if (await run(['status', '--porcelain']) !== '') fail('Commit all source changes before publishing. Generated release files must remain ignored.');
  if (await run(['rev-parse', 'HEAD']) !== commit || await run(['rev-parse', `${tag}^{commit}`]) !== commit) fail('HEAD and the local release tag must both point to the requested commit.');
  let manifest;
  try { manifest = JSON.parse(await run(['show', `${commit}:package.json`])); }
  catch { fail('Unable to read package.json from the release source commit.'); }
  if (manifest?.version !== tag.slice(1)) fail('The committed package.json version does not match the release tag.');
}
async function remoteTag(host, tag) {
  let output;
  try { output = (await exec('git', ['ls-remote', '--exit-code', TARGETS[host].git, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { maxBuffer: 1024 * 1024, timeout: 60000 })).stdout; }
  catch { fail(`The ${host} release tag is missing or could not be read. Push the same source tag to both repositories first.`); }
  const rows = new Map(output.trim().split('\n').map(line => line.split(/\s+/).reverse()));
  return rows.get(`refs/tags/${tag}^{}`) ?? rows.get(`refs/tags/${tag}`);
}
async function githubCredential() {
  try {
    const token = (await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { maxBuffer: 65536 })).stdout.trim();
    if (token) return token;
  } catch { /* Never print a command error that may include credential output. */ }
  fail('Sign in with gh auth login before executing a release.');
}
async function materialize(plan) {
  for (const item of [...plan.githubAssets, ...plan.giteeAssets]) {
    if (await exists(item.file)) { if (!same(await inspect(item.file), item)) fail(`Local file changed after review: ${item.name}`); continue; }
    if (item.content !== undefined) await writeFile(item.file, item.content, { flag: 'wx' });
    else if (item.source && item.start === undefined) await link(item.source, item.file);
    else if (item.source) {
      await mkdir(path.dirname(item.file), { recursive: true });
      try { await pipeline(createReadStream(item.source, { start: item.start, end: item.end }), createWriteStream(item.file, { flags: 'wx' })); }
      catch (error) { if (error.code !== 'EEXIST') await unlink(item.file).catch(() => {}); throw error; }
    } else fail(`Missing local release file: ${item.name}`);
    if (!same(await inspect(item.file), item)) fail(`Materialized file failed verification: ${item.name}`);
  }
}

/** Dependencies are injectable so protocol and failure paths can be tested
 * with mocked HTTP, without credentials, Git mutation, or live publication. */
export async function publishRelease(plan, options = {}) {
  if (!options.execute) return reviewPlan(plan);
  const fetcher = options.fetch ?? globalThis.fetch;
  const tokens = { github: '', gitee: options.giteeToken ?? process.env.GITEE_TOKEN ?? '' };
  const states = { github: 'not-started', gitee: 'not-started' };
  const log = options.log ?? (() => {});
  let quota;
  const request = async (host, method, route, data, { missing = false, upload = false } = {}) => {
    const target = TARGETS[host], base = upload && host === 'github' ? 'https://uploads.github.com' : target.api;
    const headers = { Authorization: `Bearer ${tokens[host]}`, Accept: 'application/json' };
    let body;
    if (data instanceof FormData || data instanceof Blob) { body = data; if (data instanceof Blob) headers['Content-Type'] = 'application/octet-stream'; }
    else if (data) {
      if (host === 'gitee') { body = new URLSearchParams(Object.entries(data).map(([key, value]) => [key, String(value)])); }
      else { body = JSON.stringify(data); headers['Content-Type'] = 'application/json'; }
    }
    let response;
    try { response = await fetcher(base + route, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(upload ? 15 * 60000 : 60000) }); }
    catch { fail(`${host} ${method} request failed; no credentials or server response were logged.`); }
    if (missing && response.status === 404) return undefined;
    if (!response.ok) fail(`${host} ${method} returned HTTP ${response.status}${[413, 422].includes(response.status) ? '; check attachment size, repository quota and conflicting names' : ''}.`);
    try {
      const chunks = []; let size = 0;
      if (Number(response.headers.get('content-length') ?? 0) > 2 * 1024 * 1024) { await response.body?.cancel(); fail('Too large'); }
      if (!response.body) fail('No response body');
      for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) fail('Too large'); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { fail(`${host} returned an invalid or oversized JSON response.`); }
  };
  const route = (host, tail) => `/repos/${TARGETS[host].repository}${tail}`;
  const githubReleases = async () => {
    const releases = [];
    for (let page = 1; page <= 20; page++) {
      // Authenticated release lists include drafts; the tag endpoint alone
      // cannot discover an interrupted run's unpublished release.
      const batch = await request('github', 'GET', route('github', `/releases?page=${page}&per_page=100`));
      if (!Array.isArray(batch) || batch.some(value => !value || typeof value !== 'object')) fail('GitHub returned an invalid release list.');
      releases.push(...batch);
      if (batch.length < 100) return releases;
    }
    fail('GitHub release history exceeded the bounded release lookup. Review the target release before retrying.');
  };
  const lookup = async host => {
    const tagged = await request(host, 'GET', route(host, `/releases/tags/${encodeURIComponent(plan.tag)}`), undefined, { missing: true });
    if (tagged || host !== 'github') return tagged;
    const candidates = (await githubReleases()).filter(release => release.tag_name === plan.tag);
    if (candidates.length > 1) fail('GitHub has multiple releases with the requested tag; refusing to choose a conflicting draft.');
    return candidates[0];
  };
  const getAssets = async (host, release) => {
    const assets = host === 'github' ? await request(host, 'GET', route(host, `/releases/${release.id}/assets?per_page=100`))
      : (await request(host, 'GET', route(host, `/releases/${release.id}`))).assets;
    if (!Array.isArray(assets)) fail(`${host} returned an invalid release asset list.`);
    return assets;
  };
  const downloadDigest = async (host, asset, expected) => {
    let url = asset.browser_download_url;
    if (typeof url !== 'string') fail(`${host} asset is missing a download URL: ${expected.name}`);
    const initial = new URL(url);
    const prefix = `/${TARGETS[host].repository}/releases/download/${encodeURIComponent(plan.tag)}/`;
    if (initial.protocol !== 'https:' || initial.hostname !== (host === 'gitee' ? 'gitee.com' : 'github.com') || initial.pathname !== prefix + encodeURIComponent(expected.name)
      || initial.username || initial.password || initial.port || initial.search || initial.hash) fail(`${host} asset has an unexpected download URL: ${expected.name}`);
    for (let redirect = 0; redirect < 6; redirect++) {
      // Public download requests never carry either publishing credential.
      const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(15 * 60000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get('location') ?? '', url);
        const allowed = host === 'gitee' ? ['gitee.com', 'foruda.gitee.com'] : ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
        const giteePath = next.hostname === 'gitee.com'
          ? new RegExp(`^/${TARGETS.gitee.repository}/attach_files/[0-9]+/download/${expected.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(next.pathname)
          : next.pathname.startsWith('/attach_file/') && next.pathname.endsWith('/' + encodeURIComponent(expected.name)) && /^\/attach_file\/\d+\/[^/]+$/.test(next.pathname);
        if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash || !allowed.includes(next.hostname)
          || (host === 'gitee' && (next.search || !giteePath))) fail(`${host} download redirected to an unexpected host or path.`);
        await response.body?.cancel(); url = next.href; continue;
      }
      if (!response.ok || !response.body) fail(`${host} download verification failed for ${expected.name}.`);
      const checksum = createHash('sha256'); let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > expected.size) fail(`${host} asset is larger than expected: ${expected.name}`); checksum.update(chunk); }
      return { size, sha256: checksum.digest('hex') };
    }
    fail(`${host} download has too many redirects.`);
  };
  const verify = async (host, asset, expected) => {
    let actual;
    if (host === 'github' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) actual = { size: asset.size, sha256: asset.digest.slice(7).toLowerCase() };
    else actual = await downloadDigest(host, asset, expected);
    if (!same(actual, expected) || (host === 'github' && asset.state !== 'uploaded')) fail(`${host} already has different or incomplete content named ${expected.name}; refusing to overwrite it.`);
  };
  const historicalGiteeSize = async asset => {
    if (Number.isSafeInteger(asset.size) && asset.size >= 0) return asset.size;
    try {
      let url = new URL(asset.browser_download_url);
      const prefix = `/${TARGETS.gitee.repository}/releases/download/`;
      if (url.protocol !== 'https:' || url.hostname !== 'gitee.com' || url.port || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith(prefix) || url.pathname.slice(prefix.length).split('/').length !== 2
        || decodeURIComponent(url.pathname.split('/').at(-1)) !== asset.name) return undefined;
      for (let hop = 0; hop < 5; hop++) {
        const response = await fetcher(url.href, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15000) });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = new URL(response.headers.get('location') ?? '', url);
          const encodedName = encodeURIComponent(asset.name);
          const allowedPath = next.hostname === 'gitee.com'
            ? next.pathname.startsWith(`/${TARGETS.gitee.repository}/attach_files/`) && /\/attach_files\/\d+\/download\/[^/]+$/.test(next.pathname)
            : next.hostname === 'foruda.gitee.com' && /^\/attach_file\/\d+\/[^/]+$/.test(next.pathname);
          if (next.protocol !== 'https:' || next.port || next.username || next.password || next.search || next.hash || !allowedPath || !next.pathname.endsWith('/' + encodedName)) return undefined;
          url = next; continue;
        }
        const value = response.headers.get('content-length');
        return response.ok && value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
      }
    } catch { /* Unknown sizes are disclosed as an incomplete quota lower bound. */ }
    return undefined;
  };
  const checkGiteeQuota = async currentRelease => {
    const currentNames = new Set(currentRelease ? (await getAssets('gitee', currentRelease)).map(asset => asset.name) : []);
    const incrementalBytes = plan.giteeAssets.filter(item => !currentNames.has(item.name)).reduce((sum, item) => sum + item.size, 0);
    let knownHistoricalBytes = 0, unknownAttachmentCount = 0, count = 0, finished = false;
    const seen = new Set();
    for (let page = 1; page <= 20; page++) {
      const releases = await request('gitee', 'GET', route('gitee', `/releases?page=${page}&per_page=100`));
      if (!Array.isArray(releases)) fail('Gitee returned an invalid release list for attachment quota preflight.');
      for (const release of releases) {
        if (!Array.isArray(release.assets)) fail('Gitee release history did not include its attachment list.');
        for (const asset of release.assets) {
          const identity = asset.browser_download_url;
          if (!identity || seen.has(identity)) continue;
          if (++count > 2000) fail('Gitee has too many historical attachments for the bounded quota preflight. Review repository capacity first.');
          seen.add(identity);
          const size = await historicalGiteeSize(asset);
          if (size === undefined) unknownAttachmentCount++; else knownHistoricalBytes += size;
        }
      }
      if (releases.length < 100) { finished = true; break; }
    }
    if (!finished) fail('Gitee release history exceeded the bounded quota preflight. Review repository capacity first.');
    quota = { knownHistoricalBytes, incrementalBytes, unknownAttachmentCount, limit: plan.giteeTotalLimit,
      ordinaryRepositoryAttachmentsCounted: false };
    if (knownHistoricalBytes + incrementalBytes > plan.giteeTotalLimit) fail('Gitee historical release attachments plus new uploads exceed the configured repository quota. No history was deleted; increase available capacity before retrying.');
    log(`Gitee quota preflight: ${knownHistoricalBytes} known historical bytes + ${incrementalBytes} new bytes; ${unknownAttachmentCount} unknown attachment sizes. Ordinary repository attachments may use additional space.`);
  };
  try {
    if (!tokens.gitee.trim()) fail('Set GITEE_TOKEN in the environment before executing a release.');
    tokens.github = await (options.githubToken ?? githubCredential)();
    if (!tokens.github.trim()) fail('The existing GitHub CLI login did not provide a credential.');
    if (plan.body.includes(tokens.github) || plan.body.includes(tokens.gitee)) fail('Release notes contain a publishing credential. Remove it before proceeding.');
    await (options.assertSourceCommit ?? localSourcePreflight)(plan.commit, plan.tag);
    const releases = {};
    // Complete both hosts' preflights before creating either release.
    for (const host of ['github', 'gitee']) {
      const user = await request(host, 'GET', '/user'); if (!user?.login) fail(`${host} credential could not be verified.`);
      const repo = await request(host, 'GET', route(host, ''));
      if (repo?.permissions?.push === false) fail(`${host} credential has no write access to the official repository.`);
      if ((await (options.remoteTag ?? remoteTag)(host, plan.tag))?.toLowerCase() !== plan.commit) fail(`${host} tag does not point to the requested source commit.`);
      const release = await lookup(host);
      if (release) {
        if (!Number.isSafeInteger(release.id) || release.id <= 0) fail(`${host} returned an invalid release identifier.`);
        if (release.tag_name !== plan.tag || release.name !== plan.name || release.body?.trim() !== plan.body.trim()) fail(`${host} release metadata differs from this reviewed plan; refusing to overwrite it.`);
        const assets = await getAssets(host, release), expected = plan[host + 'Assets'];
        const names = new Set();
        for (const asset of assets) {
          const file = expected.find(item => item.name === asset.name);
          if (!file || names.has(asset.name)) fail(`${host} release contains unexpected or duplicate asset names.`);
          names.add(asset.name); await verify(host, asset, file);
        }
        const stable = host === 'github' ? !release.draft && !release.prerelease : !release.prerelease;
        if (stable && assets.length !== expected.length) fail(`${host} stable release is incomplete; refusing to mutate an already published release.`);
        releases[host] = release; states[host] = stable ? 'verified-stable' : 'verified-staging';
      } else states[host] = 'preflight-complete';
    }
    await checkGiteeQuota(releases.gitee);
    await materialize(plan);
    for (const host of ['github', 'gitee']) {
      let release = releases[host];
      if (!release) {
        release = await request(host, 'POST', route(host, '/releases'), { tag_name: plan.tag, target_commitish: plan.commit, name: plan.name, body: plan.body,
          ...(host === 'github' ? { draft: true, prerelease: false } : { prerelease: true }) });
        if (!Number.isSafeInteger(release?.id) || release.id <= 0) fail(`${host} did not return a release identifier.`);
        releases[host] = release; states[host] = 'staging-created';
      }
      const existing = await getAssets(host, release);
      for (const item of plan[host + 'Assets']) {
        if (existing.some(asset => asset.name === item.name)) continue;
        log(`${host}: uploading ${item.name} (${item.size} bytes)`);
        if (host === 'github') await request(host, 'POST', route(host, `/releases/${release.id}/assets?name=${encodeURIComponent(item.name)}`), await openAsBlob(item.file), { upload: true });
        else {
          const form = new FormData(); form.append('file', await openAsBlob(item.file), item.name);
          await request(host, 'POST', route(host, `/releases/${release.id}/attach_files`), form, { upload: true });
        }
      }
      const uploaded = await getAssets(host, release), expected = plan[host + 'Assets'];
      if (uploaded.length !== expected.length || new Set(uploaded.map(item => item.name)).size !== expected.length) fail(`${host} has an incomplete or unexpected uploaded asset set.`);
      for (const item of expected) {
        const asset = uploaded.find(value => value.name === item.name);
        if (!asset) fail(`${host} is missing ${item.name}.`);
        await verify(host, asset, item);
      }
      states[host] = states[host] === 'verified-stable' ? 'verified-stable' : 'verified-staging';
    }
    // There is no cross-host transaction. A failure below is reported as
    // partial completion and a retry can finish the still-staged host safely.
    for (const host of ['gitee', 'github']) {
      if (states[host] !== 'verified-stable') {
        // Recheck immediately before publication: a newer stable version may
        // have appeared during lengthy uploads. Backfills must retain latest.
        const makeLatest = host === 'github' && mayPromoteGithubRelease(await githubReleases(), plan.version);
        await request(host, 'PATCH', route(host, `/releases/${releases[host].id}`), {
          tag_name: plan.tag, name: plan.name, body: plan.body, prerelease: false, ...(host === 'github' ? { draft: false, make_latest: makeLatest ? 'true' : 'false' } : {}),
        });
      }
      const published = await lookup(host);
      if (!published || published.prerelease || published.draft || published.body?.trim() !== plan.body.trim()) fail(`${host} stable publication could not be confirmed.`);
      states[host] = 'published';
    }
    return { success: true, version: plan.version, commit: plan.commit, tag: plan.tag, states, quota,
      urls: { github: `https://github.com/${TARGETS.github.repository}/releases/tag/${plan.tag}`, gitee: `https://gitee.com/${TARGETS.gitee.repository}/releases/tag/${plan.tag}` } };
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Release publication failed.';
    for (const token of Object.values(tokens)) if (token) message = message.split(token).join('[credential]');
    message = message.replace(/(?:access_token|token)=[^&\s]+/gi, 'token=[credential]');
    const failure = new Error(`${message}\nPublication status: github=${states.github}; gitee=${states.gitee}. No old release or conflicting asset was deleted.`);
    failure.states = { ...states };
    throw failure;
  }
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/publish-release.mjs --version 0.7.0 --commit <full-sha> [--directory release/v0.7.0] [--notes RELEASE.md] [--execute]\nDefault: dry-run, no writes. Gitee defaults to 48 MiB parts; --gitee-part-size 0 requests full assets within --gitee-asset-limit (default 100000000). Requires the same committed source tag pushed to both official repositories before execution.'); return;
  }
  const parsed = { execute: false };
  const flags = { '--version': 'version', '--commit': 'commit', '--directory': 'directory', '--notes': 'notesFile', '--gitee-part-size': 'giteePartSize', '--gitee-asset-limit': 'giteeAssetLimit', '--gitee-total-limit': 'giteeTotalLimit' };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--execute') { parsed.execute = true; continue; }
    if (!flags[args[index]] || !args[index + 1] || args[index + 1].startsWith('--')) fail('Unknown or incomplete release argument. See --help.');
    parsed[flags[args[index]]] = args[++index];
  }
  for (const key of ['giteePartSize', 'giteeAssetLimit', 'giteeTotalLimit']) if (parsed[key] !== undefined) parsed[key] = Number(parsed[key]);
  parsed.directory ??= `release/v${parsed.version}`;
  const plan = await prepareRelease(parsed);
  const result = await publishRelease(plan, { execute: parsed.execute, log: text => console.log(text) });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
