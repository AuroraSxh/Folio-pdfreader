/** Renderer-safe update state. File paths and downloaded asset credentials stay in main. */
export const UPDATE_RELEASES_URL = 'https://github.com/AuroraSxh/Folio-pdfreader/releases';

export type UpdateSource = 'github' | 'gitee';
export type UpdateSourcePreference = UpdateSource | 'auto';
export const UPDATE_RELEASES_URLS: Record<UpdateSource, string> = {
  github: UPDATE_RELEASES_URL,
  gitee: 'https://gitee.com/aurorasxh/pair-leaf/releases',
};
export function normalizeUpdateSourcePreference(value: unknown): UpdateSourcePreference {
  return value === 'github' || value === 'gitee' ? value : 'auto';
}

export type UpdateErrorCode =
  | 'network' | 'timeout' | 'rate-limit' | 'no-release' | 'invalid-release' | 'invalid-url'
  | 'unsupported-platform' | 'missing-asset' | 'missing-digest' | 'size-limit'
  | 'length-mismatch' | 'checksum-mismatch' | 'disk-error' | 'not-ready'
  | 'installer-missing' | 'open-failed' | 'save-failed' | 'cancelled' | 'disposed';

export interface UpdateRelease {
  source?: UpdateSource;
  version: string;
  url: string;
  notes: string;
  publishedAt: string;
  assetName?: string;
  size?: number;
  /** False when this platform lacks a verified, downloadable release asset. */
  downloadable: boolean;
}

export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'opening' | 'error';
  currentVersion: string;
  source?: UpdateSource;
  preferredSource?: UpdateSource;
  sourcePreference?: UpdateSourcePreference;
  region?: 'CN' | 'other' | 'unknown';
  sourceReason?: 'source-fallback' | 'newer-on-other-source' | 'region-unavailable';
  release?: UpdateRelease;
  downloadedBytes?: number;
  totalBytes?: number;
  lastCheckedAt?: number;
  /** Stable code for UI localization; never includes raw OS/network messages. */
  error?: UpdateErrorCode;
}

export interface UpdateService {
  getStatus(): UpdateStatus;
  check(force?: boolean): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  cancel(): Promise<UpdateStatus>;
  install(): Promise<UpdateStatus>;
  dispose(): Promise<void>;
}
