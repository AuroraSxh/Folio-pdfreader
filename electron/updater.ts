import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { UpdateErrorCode, UpdateRelease, UpdateService, UpdateStatus } from '../shared/updates';

const REPOSITORY = 'AuroraSxh/Folio-pdfreader';
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
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
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `Folio-${version}-mac-universal.dmg`;
  if (platform === 'win32' && arch === 'x64') return `Folio-${version}-windows-x64-${portable ? 'portable' : 'setup'}.exe`;
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

function exactURL(value: unknown, expected: string): string {
  const url = secureURL(value), target = new URL(expected);
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); } catch { throw new UpdateFailure('invalid-url'); }
  if (url.origin !== target.origin || decoded !== decodeURIComponent(target.pathname) || url.search) throw new UpdateFailure('invalid-url');
  return expected;
}

/** Only official GitHub asset CDN endpoints are accepted after a repository-bound URL. */
export function validateDownloadURL(value: string, initial: string): string {
  const source = secureURL(initial);
  if (source.origin !== 'https://github.com' || !source.pathname.startsWith(`/${REPOSITORY}/releases/download/`) || source.search) throw new UpdateFailure('invalid-url');
  const url = secureURL(value);
  if (url.hostname === 'github.com') return exactURL(value, initial);
  if (!['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
    || !/^\/github-production-release-asset(?:-[A-Za-z0-9]+)?\/[1-9]\d*\/[A-Za-z0-9._-]+$/.test(url.pathname)) throw new UpdateFailure('invalid-url');
  return url.href;
}

type Asset = { name: string; url: string; size: number; sha256: string };
type Candidate = { release: UpdateRelease; asset?: Asset; problem?: UpdateErrorCode };
type Operation = { kind: 'checking' | 'downloading' | 'opening'; controller: AbortController; promise: Promise<UpdateStatus>; previous: UpdateStatus };

function releaseCandidate(raw: unknown, host: UpdateHost): Candidate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UpdateFailure('invalid-release');
  const data = raw as Record<string, unknown>;
  if (data.draft !== false || data.prerelease !== false || typeof data.tag_name !== 'string') throw new UpdateFailure('invalid-release');
  const tag = data.tag_name, version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (parseVersion(version).pre.length) throw new UpdateFailure('invalid-release');
  const url = exactURL(data.html_url, `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`);
  if (typeof data.published_at !== 'string' || !Number.isFinite(Date.parse(data.published_at))
    || !Array.isArray(data.assets) || data.assets.length > 200 || (data.body !== null && data.body !== undefined && typeof data.body !== 'string')) throw new UpdateFailure('invalid-release');
  const release: UpdateRelease = { version, url, notes: typeof data.body === 'string' ? data.body.slice(0, 24_000) : '', publishedAt: data.published_at, downloadable: false };
  const name = updateAssetName(version, host.platform, host.arch, host.portable);
  if (!name) return { release, problem: 'unsupported-platform' };
  const matches = data.assets.filter((asset: unknown) => asset && typeof asset === 'object' && (asset as Record<string, unknown>).name === name);
  if (!matches.length) return { release, problem: 'missing-asset' };
  if (matches.length !== 1) throw new UpdateFailure('invalid-release');
  const asset = matches[0] as Record<string, unknown>;
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
  return { release, asset: { name, url: downloadURL, size: release.size, sha256: digest[1].toLowerCase() } };
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof UpdateFailure ? signal.reason : new UpdateFailure('cancelled');
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  aborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason instanceof UpdateFailure ? signal.reason : new UpdateFailure('cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) { void response.body?.cancel().catch(() => {}); throw new UpdateFailure('invalid-release'); }
  if (!response.body) throw new UpdateFailure('invalid-release');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await withAbort(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_BYTES) throw new UpdateFailure('invalid-release');
      chunks.push(value);
    }
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
  const fingerprint = `${host.version}:${host.platform}:${host.arch}:${!!host.portable}`;
  let status: UpdateStatus = { phase: 'idle', currentVersion: host.version };
  let candidate: Candidate | undefined, metadataTrusted = false;
  let receipt: { filename: string; asset: Asset } | undefined;
  let operation: Operation | undefined, startupChecked = false, disposed = false;
  const getStatus = () => structuredClone(status);
  const publish = (patch: Partial<UpdateStatus>) => {
    if (disposed) return;
    status = { ...status, ...patch };
    try { host.emit(getStatus()); } catch { /* A closed renderer must not interrupt file cleanup. */ }
  };

  async function request(url: string, op: Operation, asset?: Asset): Promise<Response> {
    let next = url;
    for (let hop = 0; hop <= 5; hop++) {
      aborted(op.controller.signal);
      if (asset) validateDownloadURL(next, asset.url); else exactURL(next, API_URL);
      const response = await withAbort(fetcher(next, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: op.controller.signal,
        headers: { Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': 'Folio-Updater', 'X-GitHub-Api-Version': '2026-03-10' },
      }), op.controller.signal);
      try {
        // Even injected fetch implementations must report their actual response URL.
        if (asset) validateDownloadURL(response.url, asset.url); else exactURL(response.url, API_URL);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location || hop === 5) throw new UpdateFailure('invalid-url');
          try { next = new URL(location, next).href; } catch { throw new UpdateFailure('invalid-url'); }
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

  function applyCandidate(next: Candidate, checkedAt: number, trusted: boolean): void {
    candidate = next; metadataTrusted = trusted;
    const newer = compareVersions(next.release.version, host.version) > 0;
    if (!newer) { receipt = undefined; publish({ phase: 'up-to-date', release: undefined, lastCheckedAt: checkedAt, error: undefined, downloadedBytes: undefined, totalBytes: undefined }); return; }
    const downloaded = receipt && next.asset && sameAsset(receipt.asset, next.asset);
    if (!downloaded) receipt = undefined;
    publish({ phase: downloaded ? 'downloaded' : 'available', release: next.release, lastCheckedAt: checkedAt, error: next.problem, downloadedBytes: downloaded ? next.asset!.size : undefined, totalBytes: downloaded ? next.asset!.size : undefined });
  }

  async function readCache(): Promise<{ raw: unknown; checkedAt: number } | undefined> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(cachePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return;
      const cached = JSON.parse(await handle.readFile('utf8'));
      if (cached.schema !== 1 || cached.fingerprint !== fingerprint || !Number.isSafeInteger(cached.checkedAt)
        || cached.checkedAt > now() || now() - cached.checkedAt >= CACHE_TTL) return;
      // Re-validate cached URLs and metadata. Downloads still require fresh network metadata.
      releaseCandidate(cached.raw, host);
      return { raw: cached.raw, checkedAt: cached.checkedAt };
    } catch { return; }
    finally { await handle?.close().catch(() => {}); }
  }

  async function saveCache(raw: unknown, checkedAt: number): Promise<void> {
    const temporary = path.join(directory, `.release-cache-${randomUUID()}.tmp`);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, JSON.stringify({ schema: 1, fingerprint, checkedAt, raw }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, cachePath);
    } catch { /* Cache failure does not block a successful network check. */ }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async function fetchLatest(op: Operation): Promise<void> {
    const timer = setTimeout(() => op.controller.abort(new UpdateFailure('timeout')), requestTimeout);
    try {
      const response = await request(API_URL, op);
      const raw = await boundedJSON(response, op.controller.signal);
      aborted(op.controller.signal);
      const next = releaseCandidate(raw, host), checkedAt = now();
      applyCandidate(next, checkedAt, true);
      await saveCache(raw, checkedAt);
      aborted(op.controller.signal);
    } finally { clearTimeout(timer); }
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

  const run = (kind: Operation['kind'], action: (op: Operation) => Promise<void>): Promise<UpdateStatus> => {
    if (disposed) return Promise.resolve({ ...getStatus(), error: 'disposed' });
    if (operation) return operation.promise;
    const op: Operation = { kind, controller: new AbortController(), previous: getStatus(), promise: Promise.resolve(getStatus()) };
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
      if (operation) return operation.promise;
      if (!force && startupChecked) return Promise.resolve(getStatus());
      startupChecked = true;
      return run('checking', async op => {
        parseVersion(host.version);
        publish({ phase: 'checking', error: undefined });
        if (!force) {
          const cached = await readCache();
          aborted(op.controller.signal);
          if (cached) { applyCandidate(releaseCandidate(cached.raw, host), cached.checkedAt, false); return; }
        }
        await fetchLatest(op);
      });
    },
    download() {
      return run('downloading', async op => {
        if (!candidate || compareVersions(candidate.release.version, host.version) <= 0) throw new UpdateFailure('not-ready');
        // Cache files are not an authority for executable hashes. Obtain fresh metadata first.
        if (!metadataTrusted) { publish({ phase: 'checking', error: undefined }); await fetchLatest(op); }
        if (!candidate?.asset || !candidate.release.downloadable || compareVersions(candidate.release.version, host.version) <= 0) {
          if (status.phase === 'up-to-date') return;
          throw new UpdateFailure(candidate?.problem ?? 'not-ready');
        }
        const asset = { ...candidate.asset }, filename = path.join(directory, asset.name);
        const partial = path.join(directory, `.${asset.name}.${randomUUID()}.part`);
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = setTimeout(() => op.controller.abort(new UpdateFailure('timeout')), downloadTimeout);
        const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => op.controller.abort(new UpdateFailure('timeout')), idleTimeout); };
        try {
          publish({ phase: 'downloading', error: undefined, downloadedBytes: 0, totalBytes: asset.size });
          try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); } catch { throw new UpdateFailure('disk-error'); }
          // A previously downloaded installer may be reused, but is verified again before offering it.
          try { await verifyFile(filename, asset, op.controller.signal); receipt = { filename, asset }; publish({ phase: 'downloaded', downloadedBytes: asset.size }); return; }
          catch (error) {
            if (!(error instanceof UpdateFailure) || !['installer-missing', 'length-mismatch', 'checksum-mismatch'].includes(error.code)) throw error;
          }
          resetIdle();
          const response = await request(asset.url, op, asset);
          const declared = response.headers.get('content-length');
          if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== asset.size)) { void response.body?.cancel().catch(() => {}); throw new UpdateFailure('length-mismatch'); }
          if (!response.body) throw new UpdateFailure('length-mismatch');
          reader = response.body.getReader();
          try { handle = await fs.open(partial, 'wx', 0o600); } catch { throw new UpdateFailure('disk-error'); }
          const hash = createHash('sha256');
          let length = 0, lastProgress = 0;
          while (true) {
            const { value, done } = await withAbort(reader.read(), op.controller.signal);
            if (done) break;
            resetIdle();
            length += value.byteLength;
            if (length > asset.size || length > MAX_UPDATE_BYTES) throw new UpdateFailure('length-mismatch');
            hash.update(value);
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
          if (length !== asset.size) throw new UpdateFailure('length-mismatch');
          if (!timingSafeEqual(hash.digest(), Buffer.from(asset.sha256, 'hex'))) throw new UpdateFailure('checksum-mismatch');
          aborted(op.controller.signal);
          try { await handle.sync(); await handle.close(); handle = undefined; await fs.rename(partial, filename); }
          catch { throw new UpdateFailure('disk-error'); }
          aborted(op.controller.signal);
          receipt = { filename, asset };
          publish({ phase: 'downloaded', error: undefined, downloadedBytes: asset.size, totalBytes: asset.size });
        } finally {
          clearTimeout(deadline); clearTimeout(idleTimer);
          void reader?.cancel().catch(() => {});
          await handle?.close().catch(() => {});
          await fs.rm(partial, { force: true }).catch(() => {});
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
