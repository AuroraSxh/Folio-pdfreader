import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeUpdateSourcePreference, type UpdateErrorCode, type UpdateRelease, type UpdateService, type UpdateSource, type UpdateSourcePreference, type UpdateStatus } from '../shared/updates';
import { readUpdateManifest, stripUpdateManifest } from '../shared/update-manifest';
import { detectUpdateRegion } from './update-region';

const REPOSITORY = 'AuroraSxh/Folio-pdfreader';
const GITEE_REPOSITORY = 'aurorasxh/pair-leaf';
const API_URLS: Record<UpdateSource, string> = {
  github: `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
  gitee: `https://gitee.com/api/v5/repos/${GITEE_REPOSITORY}/releases`,
};
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface UpdateHost {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  portable?: boolean;
  /** Dedicated directory, e.g. path.join(app.getPath('userData'), 'updates'). */
  directory: string;
  emit: (status: UpdateStatus) => void;
  openInstaller: (filename: string) => Promise<void>;
  flush?: () => Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  downloadIdleTimeoutMs?: number;
  downloadTimeoutMs?: number;
  getSourcePreference?: () => UpdateSourcePreference;
  detectRegion?: (fetcher: typeof globalThis.fetch, signal: AbortSignal) => Promise<'CN' | 'other' | 'unknown'>;
}

type Semver = { core: bigint[]; pre: string[] };
function parseVersion(version: string): Semver {
  const parts = typeof version === 'string' && version.length <= 128 ? STABLE_VERSION.exec(version) : null;
  if (!parts) throw new UpdateFailure('invalid-release');
  return { core: parts.slice(1, 4).map(BigInt), pre: parts[4]?.split('.') ?? [] };
}

/** Strict SemVer precedence. Build metadata has no effect; malformed versions are rejected. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function updateAssetName(version: string, platform: NodeJS.Platform, arch: string, portable = false): string | undefined {
  if (parseVersion(version).pre.length) throw new UpdateFailure('invalid-release');
  const product = compareVersions(version, '0.5.0') >= 0 ? 'Pairleaf' : 'Folio';
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `${product}-${version}-mac-universal.dmg`;
  if (platform === 'win32' && arch === 'x64') return `${product}-${version}-windows-x64-${portable ? 'portable' : 'setup'}.exe`;
  return undefined;
}

class UpdateFailure extends Error {
  constructor(readonly code: UpdateErrorCode) { super(code); this.name = 'UpdateFailure'; }
}

function secureURL(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 16_384) throw new UpdateFailure('invalid-url');
  let url: URL;
  try { url = new URL(value); } catch { throw new UpdateFailure('invalid-url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new UpdateFailure('invalid-url');
  return url;
}

function exactURL(value: unknown, expected: string, allowExpectedQuery = false): string {
  const url = secureURL(value), target = new URL(expected);
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); } catch { throw new UpdateFailure('invalid-url'); }
  if (url.origin !== target.origin || decoded !== decodeURIComponent(target.pathname)
    || (allowExpectedQuery ? url.search !== target.search : !!url.search)) throw new UpdateFailure('invalid-url');
  return expected;
}

/** Redirects start at an exact repository asset; CDN access is never free-form. */
export function validateDownloadURL(value: string, initial: string, rawLocation = value): string {
  const source = secureURL(initial);
  if (source.origin === 'https://gitee.com') {
    const match = new RegExp(`^/${GITEE_REPOSITORY}/releases/download/[^/]+/([^/]+)$`).exec(source.pathname);
    if (!match || source.search) throw new UpdateFailure('invalid-url');
    const url = secureURL(value), name = match[1];
    // Inspect the raw Location before URL normalization can hide backslashes,
    // empty query/fragments, credentials or an explicit default :443 port.
    const authority = rawLocation.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i)?.[1];
    if (/[\\#]/.test(rawLocation) || (authority !== undefined && authority !== url.hostname)) throw new UpdateFailure('invalid-url');
    if (url.origin === source.origin && url.pathname.startsWith(`/${GITEE_REPOSITORY}/releases/download/`)) return exactURL(value, initial);
    // Public Gitee release redirects verified against oschina/mcp-gitee:
    // repository attach_files -> foruda.gitee.com/attach_file. Preserve the
    // exact artifact name at both hops; never authorize arbitrary CDN paths.
    const attachment = new RegExp(`^/${GITEE_REPOSITORY}/attach_files/([1-9]\\d*)/download/[^/]+$`).exec(url.pathname);
    if (url.origin === source.origin && attachment) {
      if (rawLocation.includes('?')) throw new UpdateFailure('invalid-url');
      return exactURL(value, `${source.origin}/${GITEE_REPOSITORY}/attach_files/${attachment[1]}/download/${name}`);
    }
    const cdn = /^\/attach_file\/([1-9]\d*)\/[^/]+$/.exec(url.pathname);
    if (url.origin === 'https://foruda.gitee.com' && cdn) {
      if (!url.search) {
        if (rawLocation.includes('?')) throw new UpdateFailure('invalid-url');
        return exactURL(value, `${url.origin}/attach_file/${cdn[1]}/${name}`);
      }
      // Signed Foruda objects lowercase the stored filename but preserve its
      // original spelling in attname. Match the audited publisher contract;
      // these ephemeral URLs never enter renderer state, cache or diagnostics.
      let originalName: string;
      try { originalName = decodeURIComponent(name); } catch { throw new UpdateFailure('invalid-url'); }
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 3 || new Set(keys).size !== 3 || !keys.every(key => ['token', 'ts', 'attname'].includes(key))
        || !/^[a-f0-9]{32}$/i.test(url.searchParams.get('token') ?? '') || !/^[1-9]\d{0,12}$/.test(url.searchParams.get('ts') ?? '')
        || url.searchParams.get('attname') !== originalName
        || url.pathname !== `/attach_file/${cdn[1]}/${encodeURIComponent(originalName.toLowerCase())}`) throw new UpdateFailure('invalid-url');
      return url.href;
    }
    throw new UpdateFailure('invalid-url');
  }
  if (source.origin !== 'https://github.com' || !source.pathname.startsWith(`/${REPOSITORY}/releases/download/`) || source.search) throw new UpdateFailure('invalid-url');
  const url = secureURL(value);
  if (url.hostname === 'github.com') return exactURL(value, initial);
  if (!['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
    || !/^\/github-production-release-asset(?:-[A-Za-z0-9]+)?\/[1-9]\d*\/[A-Za-z0-9._-]+$/.test(url.pathname)) throw new UpdateFailure('invalid-url');
  return url.href;
}

type AssetPart = { name: string; url: string; size: number; sha256: string };
type Asset = AssetPart & { source: UpdateSource; parts?: AssetPart[] };
type Candidate = { release: UpdateRelease; asset?: Asset; problem?: UpdateErrorCode };
type Operation = { kind: 'checking' | 'downloading' | 'opening'; controller: AbortController; promise: Promise<UpdateStatus>; previous: UpdateStatus; preference: UpdateSourcePreference };
type SourceDecision = Pick<UpdateStatus, 'sourcePreference' | 'preferredSource' | 'region' | 'sourceReason'>;

function releaseCandidate(raw: unknown, host: UpdateHost, source: UpdateSource): Candidate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UpdateFailure('invalid-release');
  const data = raw as Record<string, unknown>;
  if ((source === 'github' ? data.draft !== false : data.draft !== undefined && data.draft !== false) || data.prerelease !== false || typeof data.tag_name !== 'string') throw new UpdateFailure('invalid-release');
  const tag = data.tag_name, version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (parseVersion(version).pre.length) throw new UpdateFailure('invalid-release');
  const url = source === 'github' ? exactURL(data.html_url, `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`)
    : `https://gitee.com/${GITEE_REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`;
  const publishedAt = source === 'github' ? data.published_at : data.created_at;
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))
    || !Array.isArray(data.assets) || data.assets.length > 200 || (data.body !== null && data.body !== undefined && typeof data.body !== 'string')) throw new UpdateFailure('invalid-release');
  const body = typeof data.body === 'string' ? data.body : '';
  const release: UpdateRelease = { source, version, url, notes: stripUpdateManifest(body).slice(0, 24_000), publishedAt, downloadable: false };
  const canonical = updateAssetName(version, host.platform, host.arch, host.portable);
  if (!canonical) return { release, problem: 'unsupported-platform' };
  // Releases from the rename onwards may publish an exact Folio alias for old
  // clients. Prefer canonical metadata; never bypass invalid canonical metadata
  // by silently selecting the alias. Neither accepted name may be duplicated.
  const names = canonical.startsWith('Pairleaf-') ? [canonical, canonical.replace(/^Pairleaf-/, 'Folio-')] : [canonical];
  const assets = data.assets;
  const matches = names.map(name => assets.filter((asset: unknown) => asset && typeof asset === 'object' && (asset as Record<string, unknown>).name === name));
  if (matches.some(group => group.length > 1)) throw new UpdateFailure('invalid-release');
  if (source === 'gitee') {
    let manifest: ReturnType<typeof readUpdateManifest>;
    try { manifest = readUpdateManifest(body, version); } catch { throw new UpdateFailure('invalid-release'); }
    const name = names.find((name, index) => matches[index].length || manifest?.assets.some(entry => entry.name === name && entry.parts));
    if (!name) return { release, problem: 'missing-asset' };
    release.assetName = name;
    const entry = manifest?.assets.find(item => item.name === name);
    if (!entry) return { release, problem: 'missing-digest' };
    release.size = entry.size;
    if (entry.size > MAX_UPDATE_BYTES) return { release, problem: 'size-limit' };
    const route = (filename: string) => `https://gitee.com/${GITEE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
    const asset = matches[names.indexOf(name)][0] as Record<string, unknown> | undefined;
    const parts: AssetPart[] = [];
    let downloadURL: string;
    try {
      if (asset) downloadURL = exactURL(asset.browser_download_url, route(name));
      else if (entry.parts) {
        for (const part of entry.parts) {
          const found = assets.filter((value: unknown) => value && typeof value === 'object' && (value as Record<string, unknown>).name === part.name);
          if (found.length > 1) throw new UpdateFailure('invalid-release');
          if (!found.length) return { release, problem: 'missing-asset' };
          parts.push({ ...part, url: exactURL((found[0] as Record<string, unknown>).browser_download_url, route(part.name)) });
        }
        downloadURL = route(name); // Logical file; only the validated part routes are fetched.
      } else return { release, problem: 'missing-asset' };
    } catch (error) { if (error instanceof UpdateFailure && error.code === 'invalid-release') throw error; return { release, problem: 'invalid-url' }; }
    release.downloadable = true;
    return { release, asset: { name, url: downloadURL, size: entry.size, sha256: entry.sha256, source, ...(parts.length ? { parts } : {}) } };
  }
  const asset = matches.flat()[0] as Record<string, unknown> | undefined;
  if (!asset) return { release, problem: 'missing-asset' };
  const name = asset.name as string;
  release.assetName = name;
  if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || (asset.size as number) <= 0
    || !Number.isSafeInteger(asset.id) || (asset.id as number) <= 0) throw new UpdateFailure('invalid-release');
  release.size = asset.size as number;
  if (release.size > MAX_UPDATE_BYTES) return { release, problem: 'size-limit' };
  let downloadURL: string;
  try {
    exactURL(asset.url, `https://api.github.com/repos/${REPOSITORY}/releases/assets/${asset.id}`);
    downloadURL = exactURL(asset.browser_download_url, `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`);
  } catch { return { release, problem: 'invalid-url' }; }
  const digest = typeof asset.digest === 'string' ? /^sha256:([a-fA-F0-9]{64})$/.exec(asset.digest) : null;
  if (!digest) return { release, problem: 'missing-digest' };
  release.downloadable = true;
  return { release, asset: { name, url: downloadURL, size: release.size, sha256: digest[1].toLowerCase(), source } };
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof UpdateFailure ? signal.reason : new UpdateFailure('cancelled');
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void promise.catch(() => {});
  aborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason instanceof UpdateFailure ? signal.reason : new UpdateFailure('cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function boundedJSON(response: Response, signal: AbortSignal, budget = { remaining: MAX_JSON_BYTES }): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > budget.remaining)) { void response.body?.cancel().catch(() => {}); throw new UpdateFailure('invalid-release'); }
  if (!response.body) throw new UpdateFailure('invalid-release');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await withAbort(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > budget.remaining) throw new UpdateFailure('invalid-release');
      chunks.push(value);
    }
    budget.remaining -= length;
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UpdateFailure('invalid-release'); }
  } finally { void reader.cancel().catch(() => {}); }
}

function sameAsset(a: Asset, b: Asset): boolean { return a.name === b.name && a.sha256 === b.sha256 && a.size === b.size && a.url === b.url; }

/** No timers run while idle. Only explicit calls check/download/install; the host owns startup scheduling. */
export function createUpdateService(host: UpdateHost): UpdateService {
  const fetcher = host.fetch ?? globalThis.fetch, now = host.now ?? Date.now;
  const requestTimeout = host.requestTimeoutMs ?? 12_000;
  const idleTimeout = host.downloadIdleTimeoutMs ?? 30_000;
  const downloadTimeout = host.downloadTimeoutMs ?? 30 * 60_000;
  const directory = path.resolve(host.directory), cachePath = path.join(directory, 'release-cache.json');
  const fingerprint = (preference: UpdateSourcePreference, source: UpdateSource) => `${host.version}:${host.platform}:${host.arch}:${!!host.portable}:${preference}:${source}`;
  const sourcePreference = () => normalizeUpdateSourcePreference(host.getSourcePreference?.());
  let status: UpdateStatus = { phase: 'idle', currentVersion: host.version, sourcePreference: sourcePreference() };
  let candidate: Candidate | undefined, metadataTrusted = false;
  let metadataPreference: UpdateSourcePreference | undefined;
  let alternatives: Candidate[] = [];
  let receipt: { filename: string; asset: Asset } | undefined;
  let operation: Operation | undefined, startupChecked: UpdateSourcePreference | undefined, disposed = false;
  const getStatus = () => structuredClone(status);
  const publish = (patch: Partial<UpdateStatus>) => {
    if (disposed) return;
    status = { ...status, ...patch };
    try { host.emit(getStatus()); } catch { /* A closed renderer must not interrupt file cleanup. */ }
  };

  async function request(url: string, signal: AbortSignal, source: UpdateSource, asset?: Asset): Promise<Response> {
    let next = url;
    for (let hop = 0; hop <= 5; hop++) {
      aborted(signal);
      if (asset) validateDownloadURL(next, asset.url); else exactURL(next, url, true);
      const pending = fetcher(next, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
        headers: { Accept: asset ? 'application/octet-stream' : source === 'github' ? 'application/vnd.github+json' : 'application/json', 'User-Agent': 'Pairleaf-Updater', ...(source === 'github' ? { 'X-GitHub-Api-Version': '2026-03-10' } : {}) },
      });
      // A late Response from an aborted fetch must not leave its body alive,
      // including injected transports that do not implement AbortSignal.
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await withAbort(pending, signal);
      try {
        aborted(signal);
        // Even injected fetch implementations must report their actual response URL.
        if (asset) validateDownloadURL(response.url, asset.url); else exactURL(response.url, url, true);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || hop === 5) throw new UpdateFailure('invalid-url');
          try {
            next = new URL(location, next).href;
            if (asset) validateDownloadURL(next, asset.url, location);
          } catch { throw new UpdateFailure('invalid-url'); }
          void response.body?.cancel().catch(() => {});
          continue;
        }
        if (response.status === 403 || response.status === 429) throw new UpdateFailure('rate-limit');
        if (response.status === 404) throw new UpdateFailure(asset ? 'installer-missing' : 'no-release');
        if (!response.ok || (asset && response.status !== 200)) throw new UpdateFailure('network');
        return response;
      } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
    }
    throw new UpdateFailure('invalid-url');
  }

  function applyCandidate(next: Candidate, checkedAt: number, trusted: boolean, decision: SourceDecision): void {
    candidate = next; metadataTrusted = trusted;
    metadataPreference = decision.sourcePreference;
    const sourceState = { ...decision, source: next.release.source };
    const newer = compareVersions(next.release.version, host.version) > 0;
    if (!newer) { receipt = undefined; publish({ ...sourceState, phase: 'up-to-date', release: undefined, lastCheckedAt: checkedAt, error: undefined, downloadedBytes: undefined, totalBytes: undefined }); return; }
    const downloaded = receipt && next.asset && sameAsset(receipt.asset, next.asset);
    if (!downloaded) receipt = undefined;
    publish({ ...sourceState, phase: downloaded ? 'downloaded' : 'available', release: next.release, lastCheckedAt: checkedAt, error: next.problem, downloadedBytes: downloaded ? next.asset!.size : undefined, totalBytes: downloaded ? next.asset!.size : undefined });
  }

  async function readCache(preference: UpdateSourcePreference): Promise<{ raw: unknown; source: UpdateSource; checkedAt: number; decision: SourceDecision } | undefined> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(cachePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return;
      const cached = JSON.parse(await handle.readFile('utf8'));
      if (cached.schema !== 2 || !['github', 'gitee'].includes(cached.source) || cached.fingerprint !== fingerprint(preference, cached.source)
        || (preference !== 'auto' && cached.source !== preference) || !Number.isSafeInteger(cached.checkedAt)
        || cached.checkedAt > now() || now() - cached.checkedAt >= CACHE_TTL) return;
      // Re-validate cached URLs and metadata. Downloads still require fresh network metadata.
      releaseCandidate(cached.raw, host, cached.source);
      if (!['github', 'gitee'].includes(cached.decision?.preferredSource)
        || (preference === 'auto' && !['CN', 'other', 'unknown'].includes(cached.decision?.region))) return;
      const decision: SourceDecision = { sourcePreference: preference, preferredSource: cached.decision.preferredSource,
        region: preference === 'auto' ? cached.decision.region : undefined,
        sourceReason: ['source-fallback', 'newer-on-other-source', 'region-unavailable'].includes(cached.decision.sourceReason) ? cached.decision.sourceReason : undefined };
      return { raw: cached.raw, source: cached.source, checkedAt: cached.checkedAt, decision };
    } catch { return; }
    finally { await handle?.close().catch(() => {}); }
  }

  async function saveCache(raw: unknown, source: UpdateSource, checkedAt: number, decision: SourceDecision): Promise<void> {
    const temporary = path.join(directory, `.release-cache-${randomUUID()}.tmp`);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, JSON.stringify({ schema: 2, fingerprint: fingerprint(decision.sourcePreference!, source), source, checkedAt, decision, raw }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, cachePath);
    } catch { /* Cache failure does not block a successful network check. */ }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async function fetchSource(source: UpdateSource, op: Operation): Promise<{ raw: unknown; candidate: Candidate; source: UpdateSource }> {
    const controller = new AbortController();
    const cancel = () => controller.abort(op.controller.signal.reason);
    op.controller.signal.addEventListener('abort', cancel, { once: true });
    if (op.controller.signal.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new UpdateFailure('timeout')), requestTimeout);
    try {
      let raw: unknown;
      if (source === 'github') {
        const response = await request(API_URLS[source], controller.signal, source);
        raw = await boundedJSON(response, controller.signal);
      } else {
        // Gitee "latest" means most recently edited, not highest SemVer, and
        // may be an upload-in-progress prerelease. Inspect bounded public pages.
        const releases: { raw: unknown; version: string }[] = [], budget = { remaining: MAX_JSON_BYTES };
        for (let page = 1; page <= 10; page++) {
          const response = await request(`${API_URLS.gitee}?per_page=100&page=${page}`, controller.signal, source);
          const batch = await boundedJSON(response, controller.signal, budget);
          if (!Array.isArray(batch) || batch.length > 100) throw new UpdateFailure('invalid-release');
          for (const item of batch) {
            if (!item || typeof item !== 'object' || item.prerelease !== false || typeof item.tag_name !== 'string') continue;
            const version = item.tag_name.startsWith('v') ? item.tag_name.slice(1) : item.tag_name;
            try { if (!parseVersion(version).pre.length) releases.push({ raw: item, version }); } catch { /* Ignore malformed tags, not valid stable releases. */ }
          }
          if (batch.length < 100) break;
          if (page === 10) throw new UpdateFailure('invalid-release'); // Do not claim an incomplete scan found the newest version.
        }
        if (!releases.length) throw new UpdateFailure('no-release');
        releases.sort((a, b) => compareVersions(b.version, a.version));
        if (releases[1] && compareVersions(releases[0].version, releases[1].version) === 0) throw new UpdateFailure('invalid-release');
        raw = releases[0].raw;
      }
      aborted(controller.signal);
      return { raw, candidate: releaseCandidate(raw, host, source), source };
    } finally { clearTimeout(timer); op.controller.signal.removeEventListener('abort', cancel); controller.abort(); }
  }

  async function regionFor(op: Operation): Promise<'CN' | 'other' | 'unknown'> {
    const controller = new AbortController();
    const cancel = () => controller.abort(op.controller.signal.reason);
    op.controller.signal.addEventListener('abort', cancel, { once: true });
    if (op.controller.signal.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new UpdateFailure('timeout')), 4000);
    try {
      const region = await withAbort((host.detectRegion ?? detectUpdateRegion)(fetcher, controller.signal), controller.signal);
      return region === 'CN' || region === 'other' ? region : 'unknown';
    } catch { aborted(op.controller.signal); return 'unknown'; }
    finally { clearTimeout(timer); op.controller.signal.removeEventListener('abort', cancel); controller.abort(); }
  }

  async function fetchLatest(op: Operation): Promise<void> {
    let selected: Awaited<ReturnType<typeof fetchSource>>;
    let decision: SourceDecision;
    alternatives = [];
    metadataTrusted = false;
    if (op.preference !== 'auto') {
      decision = { sourcePreference: op.preference, preferredSource: op.preference, region: undefined, sourceReason: undefined };
      publish({ ...decision, source: op.preference });
      selected = await fetchSource(op.preference, op);
    } else {
      // Both sources have independent deadlines. A hanging preferred mirror
      // cannot abort a healthy source, and neither source is allowed to downgrade.
      const [region, results] = await Promise.all([
        regionFor(op), Promise.allSettled((['github', 'gitee'] as const).map(source => fetchSource(source, op))),
      ]);
      aborted(op.controller.signal);
      const preferredSource: UpdateSource = region === 'CN' ? 'gitee' : 'github';
      const good = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      decision = { sourcePreference: 'auto', preferredSource, region, sourceReason: region === 'unknown' ? 'region-unavailable' : undefined };
      publish(decision);
      if (!good.length) throw (results[preferredSource === 'github' ? 0 : 1] as PromiseRejectedResult).reason;
      good.sort((a, b) => compareVersions(b.candidate.release.version, a.candidate.release.version)
        || Number(!!b.candidate.asset) - Number(!!a.candidate.asset)
        || Number(b.source === preferredSource) - Number(a.source === preferredSource));
      selected = good[0];
      const preferred = good.find(result => result.source === preferredSource);
      if (selected.source !== preferredSource) decision.sourceReason = preferred && compareVersions(selected.candidate.release.version, preferred.candidate.release.version) > 0 ? 'newer-on-other-source' : 'source-fallback';
      alternatives = good.slice(1).map(result => result.candidate);
    }
    const checkedAt = now();
    applyCandidate(selected.candidate, checkedAt, true, decision);
    await saveCache(selected.raw, selected.source, checkedAt, decision);
    aborted(op.controller.signal);
  }

  async function verifyFile(filename: string, asset: Asset, signal: AbortSignal): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      aborted(signal);
      const link = await fs.lstat(filename);
      if (!link.isFile() || link.isSymbolicLink()) throw new UpdateFailure('installer-missing');
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== asset.size) throw new UpdateFailure('length-mismatch');
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024);
      let length = 0;
      while (true) {
        aborted(signal);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        length += bytesRead;
        if (length > asset.size) throw new UpdateFailure('length-mismatch');
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (length !== asset.size) throw new UpdateFailure('length-mismatch');
      if (!timingSafeEqual(hash.digest(), Buffer.from(asset.sha256, 'hex'))) throw new UpdateFailure('checksum-mismatch');
      const final = await fs.lstat(filename);
      if (!final.isFile() || final.isSymbolicLink() || final.ino !== stat.ino || final.dev !== stat.dev || final.size !== stat.size || final.mtimeMs !== stat.mtimeMs) throw new UpdateFailure('checksum-mismatch');
      aborted(signal);
    } catch (error) {
      if (error instanceof UpdateFailure) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UpdateFailure('installer-missing');
      throw new UpdateFailure('disk-error');
    } finally { await handle?.close().catch(() => {}); }
  }

  const run = (kind: Operation['kind'], action: (op: Operation) => Promise<void>, preference = sourcePreference()): Promise<UpdateStatus> => {
    if (disposed) return Promise.resolve({ ...getStatus(), error: 'disposed' });
    if (operation) return operation.promise;
    const op: Operation = { kind, controller: new AbortController(), previous: getStatus(), promise: Promise.resolve(getStatus()), preference };
    operation = op;
    op.promise = Promise.resolve().then(() => action(op)).catch(error => {
      const code = error instanceof UpdateFailure ? error.code : 'network';
      if (code === 'cancelled') {
        const downloaded = receipt && candidate?.asset && sameAsset(receipt.asset, candidate.asset);
        const phase = downloaded ? 'downloaded' : status.release ? 'available' : op.previous.phase === 'up-to-date' ? 'up-to-date' : 'idle';
        publish({ phase, error: code, downloadedBytes: downloaded ? receipt!.asset.size : undefined, totalBytes: downloaded ? receipt!.asset.size : undefined });
      } else publish({ phase: op.kind === 'opening' && receipt && (code === 'save-failed' || code === 'open-failed') ? 'downloaded' : 'error', error: code });
    }).then(getStatus).finally(() => { if (operation === op) operation = undefined; });
    return op.promise;
  };

  return {
    getStatus,
    check(force = false) {
      if (disposed) return Promise.resolve({ ...getStatus(), error: 'disposed' });
      if (operation) return operation.promise;
      const preference = sourcePreference();
      if (!force && startupChecked === preference && status.sourcePreference === preference) return Promise.resolve(getStatus());
      startupChecked = preference;
      return run('checking', async op => {
        parseVersion(host.version);
        if (metadataPreference !== op.preference) { candidate = undefined; receipt = undefined; metadataTrusted = false; alternatives = []; }
        publish({ phase: 'checking', sourcePreference: op.preference, source: undefined, preferredSource: undefined, region: undefined, sourceReason: undefined,
          release: candidate?.release, error: undefined, downloadedBytes: undefined, totalBytes: undefined });
        if (!force) {
          const cached = await readCache(op.preference);
          aborted(op.controller.signal);
          if (cached) { alternatives = []; applyCandidate(releaseCandidate(cached.raw, host, cached.source), cached.checkedAt, false, cached.decision); return; }
        }
        await fetchLatest(op);
      }, preference);
    },
    download() {
      return run('downloading', async op => {
        if (metadataPreference !== undefined && metadataPreference !== op.preference) {
          candidate = undefined; receipt = undefined; metadataTrusted = false; alternatives = [];
          publish({ phase: 'checking', sourcePreference: op.preference, release: undefined, source: undefined, preferredSource: undefined, region: undefined, sourceReason: undefined,
            error: undefined, downloadedBytes: undefined, totalBytes: undefined });
          await fetchLatest(op);
        }
        if (!candidate || compareVersions(candidate.release.version, host.version) <= 0) throw new UpdateFailure('not-ready');
        // Cache files are not an authority for executable hashes. Obtain fresh metadata first.
        if (!metadataTrusted || now() - (status.lastCheckedAt ?? 0) >= CACHE_TTL) { publish({ phase: 'checking', error: undefined }); await fetchLatest(op); }
        if (!candidate?.asset || !candidate.release.downloadable || compareVersions(candidate.release.version, host.version) <= 0) {
          if (status.phase === 'up-to-date') return;
          throw new UpdateFailure(candidate?.problem ?? 'not-ready');
        }
        const selected = candidate;
        const downloadOne = async (asset: Asset) => {
          const filename = path.join(directory, asset.name);
          const partial = path.join(directory, `.${asset.name}.${randomUUID()}.part`);
          const controller = new AbortController();
          const cancel = () => controller.abort(op.controller.signal.reason);
          op.controller.signal.addEventListener('abort', cancel, { once: true });
          if (op.controller.signal.aborted) cancel();
          let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          const deadline = setTimeout(() => controller.abort(new UpdateFailure('timeout')), downloadTimeout);
          const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(new UpdateFailure('timeout')), idleTimeout); };
          try {
            publish({ phase: 'downloading', error: undefined, downloadedBytes: 0, totalBytes: asset.size });
            try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); } catch { throw new UpdateFailure('disk-error'); }
            // A previously downloaded installer may be reused, but is verified again before offering it.
            try { await verifyFile(filename, asset, controller.signal); receipt = { filename, asset }; publish({ phase: 'downloaded', downloadedBytes: asset.size }); return; }
            catch (error) {
              if (!(error instanceof UpdateFailure) || !['installer-missing', 'length-mismatch', 'checksum-mismatch'].includes(error.code)) throw error;
            }
            try { handle = await fs.open(partial, 'wx', 0o600); } catch { throw new UpdateFailure('disk-error'); }
            const hash = createHash('sha256');
            let length = 0, lastProgress = 0;
            // Gitee parts are streamed serially into one private temporary file;
            // neither a complete part nor the whole installer is held in memory.
            for (const part of asset.parts ?? [asset]) {
              resetIdle();
              const response = await request(part.url, controller.signal, asset.source, { ...part, source: asset.source });
              const declared = response.headers.get('content-length');
              if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== part.size)) { void response.body?.cancel().catch(() => {}); throw new UpdateFailure('length-mismatch'); }
              if (!response.body) throw new UpdateFailure('length-mismatch');
              reader = response.body.getReader();
              const partHash = createHash('sha256'); let partLength = 0;
              while (true) {
                const { value, done } = await withAbort(reader.read(), controller.signal);
                if (done) break;
                resetIdle();
                length += value.byteLength; partLength += value.byteLength;
                if (length > asset.size || length > MAX_UPDATE_BYTES || partLength > part.size) throw new UpdateFailure('length-mismatch');
                hash.update(value); partHash.update(value);
                try {
                  let offset = 0;
                  while (offset < value.byteLength) {
                    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset, null);
                    if (!bytesWritten) throw new UpdateFailure('disk-error');
                    offset += bytesWritten;
                  }
                } catch { throw new UpdateFailure('disk-error'); }
                if (now() - lastProgress >= 150) { lastProgress = now(); publish({ downloadedBytes: length }); }
              }
              if (partLength !== part.size) throw new UpdateFailure('length-mismatch');
              if (!timingSafeEqual(partHash.digest(), Buffer.from(part.sha256, 'hex'))) throw new UpdateFailure('checksum-mismatch');
              void reader.cancel().catch(() => {}); reader = undefined;
            }
            if (length !== asset.size) throw new UpdateFailure('length-mismatch');
            if (!timingSafeEqual(hash.digest(), Buffer.from(asset.sha256, 'hex'))) throw new UpdateFailure('checksum-mismatch');
            aborted(controller.signal);
            try { await handle.sync(); await handle.close(); handle = undefined; await fs.rename(partial, filename); }
            catch { throw new UpdateFailure('disk-error'); }
            aborted(controller.signal);
            receipt = { filename, asset };
            publish({ phase: 'downloaded', error: undefined, downloadedBytes: asset.size, totalBytes: asset.size });
          } finally {
            clearTimeout(deadline); clearTimeout(idleTimer);
            op.controller.signal.removeEventListener('abort', cancel); controller.abort();
            void reader?.cancel().catch(() => {});
            await handle?.close().catch(() => {});
            await fs.rm(partial, { force: true }).catch(() => {});
          }
        };
        try { await downloadOne({ ...selected.asset! }); }
        catch (error) {
          aborted(op.controller.signal);
          const code = error instanceof UpdateFailure ? error.code : 'network';
          const fallback = op.preference === 'auto' && ['network', 'timeout', 'rate-limit', 'installer-missing'].includes(code)
            ? alternatives.find(other => other.asset && other.release.source !== selected.release.source && other.release.version === selected.release.version
              && other.asset.name === selected.asset!.name && other.asset.size === selected.asset!.size && other.asset.sha256 === selected.asset!.sha256) : undefined;
          if (!fallback?.asset) throw error;
          // Keep the previous source for a later retry if this fallback also
          // fails or is cancelled. A source can never be its own alternative.
          alternatives = [selected, ...alternatives].filter(other => other.release.source !== fallback.release.source);
          candidate = fallback;
          publish({ source: fallback.release.source, release: fallback.release, sourceReason: 'source-fallback', error: undefined });
          await downloadOne({ ...fallback.asset });
        }
      });
    },
    async cancel() {
      const op = operation;
      if (!op || op.kind === 'opening') return getStatus();
      op.controller.abort(new UpdateFailure('cancelled'));
      return op.promise;
    },
    install() {
      return run('opening', async op => {
        const ready = receipt;
        if (!ready || status.phase !== 'downloaded') throw new UpdateFailure('not-ready');
        publish({ phase: 'opening', error: undefined });
        try { await host.flush?.(); } catch { throw new UpdateFailure('save-failed'); }
        if (disposed) return;
        // Flush may take time, so verify after it, immediately before handing the file to the OS.
        try { await verifyFile(ready.filename, ready.asset, op.controller.signal); }
        catch (error) { receipt = undefined; throw error; }
        if (disposed) return;
        try { await host.openInstaller(ready.filename); } catch { throw new UpdateFailure('open-failed'); }
        publish({ phase: 'downloaded', error: undefined });
      });
    },
    async dispose() {
      disposed = true;
      const op = operation;
      // Windows openInstaller may initiate app.quit; never wait on our own install callback.
      if (op && op.kind !== 'opening') { op.controller.abort(new UpdateFailure('cancelled')); await op.promise; }
    },
  };
}
