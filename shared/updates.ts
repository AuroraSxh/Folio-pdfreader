/** Renderer-safe update state. File paths and downloaded asset credentials stay in main. */
export const UPDATE_RELEASES_URL = 'https://github.com/AuroraSxh/Folio-pdfreader/releases';

export type UpdateErrorCode =
  | 'network' | 'timeout' | 'rate-limit' | 'no-release' | 'invalid-release' | 'invalid-url'
  | 'unsupported-platform' | 'missing-asset' | 'missing-digest' | 'size-limit'
  | 'length-mismatch' | 'checksum-mismatch' | 'disk-error' | 'not-ready'
  | 'installer-missing' | 'open-failed' | 'save-failed' | 'cancelled' | 'disposed';

export interface UpdateRelease {
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
