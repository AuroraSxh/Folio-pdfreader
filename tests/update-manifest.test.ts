import assert from 'node:assert/strict';
import test from 'node:test';
import { appendUpdateManifest, readUpdateManifest, stripUpdateManifest, updatePartName, type UpdateManifest } from '../shared/update-manifest';

const manifest: UpdateManifest = { schema: 1, version: '0.7.0', assets: [{ name: 'Pairleaf-0.7.0-mac-universal.dmg', size: 123, sha256: 'ab'.repeat(32) }] };
test('release metadata round-trips separately from human release notes', () => {
  const body = appendUpdateManifest('Human release notes.\n中文说明。', manifest);
  assert.deepEqual(readUpdateManifest(body, '0.7.0'), manifest);
  assert.equal(stripUpdateManifest(body), 'Human release notes.\n中文说明。');
  assert.equal(readUpdateManifest('Ordinary notes', '0.7.0'), undefined);
});
test('mirrored parts are contiguous, individually hashed and bound to the complete installer size', () => {
  const asset = manifest.assets[0];
  const parts = [{ name: updatePartName(asset.name, 1), size: 100, sha256: '12'.repeat(32) }, { name: updatePartName(asset.name, 2), size: 23, sha256: '34'.repeat(32) }];
  const divided = { ...manifest, assets: [{ ...asset, parts }] };
  assert.deepEqual(readUpdateManifest(appendUpdateManifest('Notes', divided), manifest.version), divided);
  for (const wrong of [parts.slice(1), [...parts].reverse(), [parts[0], parts[0]], [parts[0], { ...parts[1], size: 24 }], [parts[0], { ...parts[1], sha256: '' }], [parts[0], { ...parts[1], name: '../part' }]]) {
    assert.throws(() => appendUpdateManifest('Notes', { ...manifest, assets: [{ ...asset, parts: wrong }] }));
  }
});
test('update metadata rejects duplicate, cross-version, malformed and unbounded integrity data', () => {
  const body = appendUpdateManifest('Notes', manifest);
  assert.throws(() => readUpdateManifest(body, '0.8.0'));
  assert.throws(() => readUpdateManifest(body + body, '0.7.0'));
  assert.throws(() => readUpdateManifest(body.replace('"schema":1', '"schema":2'), '0.7.0'));
  assert.throws(() => readUpdateManifest(body.slice(0, -3), '0.7.0'));
  for (const patch of [{ name: '../installer.exe' }, { name: 'evil.exe?key=secret' }, { size: 0 }, { size: Infinity }, { size: 2 ** 31 }, { sha256: 'md5:anything' }]) {
    assert.throws(() => appendUpdateManifest('Notes', { ...manifest, assets: [{ ...manifest.assets[0], ...patch }] }));
  }
  assert.throws(() => appendUpdateManifest('Notes', { ...manifest, assets: [manifest.assets[0], manifest.assets[0]] }));
});
