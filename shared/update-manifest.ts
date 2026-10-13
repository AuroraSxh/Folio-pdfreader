/** Release-owned integrity metadata for hosts without native SHA-256 digests. */
export interface UpdateManifestPart { name: string; size: number; sha256: string }
export interface UpdateManifestAsset extends UpdateManifestPart { parts?: UpdateManifestPart[] }
export interface UpdateManifest { schema: 1; version: string; assets: UpdateManifestAsset[] }

const START = '<!-- pairleaf-update-v1\n';
const END = '\n-->';
const MARKER = '<!-- pairleaf-update-v1';
const MAX_MANIFEST = 32 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;

export function updatePartName(assetName: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 64) throw new Error('Invalid update part number');
  return `${assetName}.part${String(ordinal).padStart(3, '0')}`;
}

export function validateUpdateManifest(value: unknown, expectedVersion: string): UpdateManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update manifest');
  const data = value as Partial<UpdateManifest>;
  if (data.schema !== 1 || !VERSION.test(expectedVersion) || data.version !== expectedVersion
    || !Array.isArray(data.assets) || !data.assets.length || data.assets.length > 32) throw new Error('Invalid update manifest');
  const names = new Set<string>();
  const assets = data.assets.map(asset => {
    if (!asset || typeof asset !== 'object' || typeof asset.name !== 'string' || asset.name.length > 200
      || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(asset.name) || asset.name.includes('..') || names.has(asset.name)
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 * 1024 * 1024
      || typeof asset.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid update manifest asset');
    names.add(asset.name);
    let parts: UpdateManifestPart[] | undefined;
    if (asset.parts !== undefined) {
      if (!Array.isArray(asset.parts) || !asset.parts.length || asset.parts.length > 64) throw new Error('Invalid update parts');
      parts = asset.parts.map((part, index) => {
        if (!part || typeof part !== 'object' || part.name !== updatePartName(asset.name, index + 1) || names.has(part.name)
          || !Number.isSafeInteger(part.size) || part.size <= 0 || part.size > asset.size
          || typeof part.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(part.sha256)) throw new Error('Invalid update part');
        names.add(part.name);
        return { name: part.name, size: part.size, sha256: part.sha256.toLowerCase() };
      });
      if (parts.reduce((sum, part) => sum + part.size, 0) !== asset.size) throw new Error('Update parts have the wrong total size');
    }
    return { name: asset.name, size: asset.size, sha256: asset.sha256.toLowerCase(), ...(parts ? { parts } : {}) };
  });
  return { schema: 1, version: expectedVersion, assets };
}

/** Missing metadata is distinguishable from malformed/ambiguous metadata. */
export function readUpdateManifest(body: string, expectedVersion: string): UpdateManifest | undefined {
  const start = body.indexOf(MARKER);
  if (start < 0) return undefined;
  if (body.indexOf(MARKER, start + MARKER.length) >= 0 || !body.startsWith(START, start)) throw new Error('Invalid update manifest');
  const end = body.indexOf(END, start + START.length);
  if (end < 0 || end - start > MAX_MANIFEST) throw new Error('Invalid update manifest');
  return validateUpdateManifest(JSON.parse(body.slice(start + START.length, end)), expectedVersion);
}

export function stripUpdateManifest(body: string): string {
  return body.replace(/<!-- pairleaf-update-v1\n[\s\S]*?\n-->/g, '').trim();
}

export function appendUpdateManifest(notes: string, manifest: UpdateManifest): string {
  const data = validateUpdateManifest(manifest, manifest.version);
  const json = JSON.stringify(data);
  if (json.length > MAX_MANIFEST - START.length - END.length) throw new Error('Update manifest is too large');
  if (notes.includes(MARKER)) throw new Error('Release notes must not contain update metadata');
  return `${notes.trim()}\n\n${START}${json}${END}`;
}
