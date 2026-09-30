import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ReadingCacheStore } from '../electron/reading-cache';

test('evidence notes survive restart and are isolated by paper and input digest', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-reading-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = 'a'.repeat(64), cache = new ReadingCacheStore(root);
  await cache.set('paper-one', key, 'Finding [Main.pdf p.60 ｜ Original source words]');
  const reopened = new ReadingCacheStore(root);
  assert.match((await reopened.get('paper-one', key))!, /p\.60/);
  assert.equal(await reopened.get('paper-two', key), undefined);
  assert.equal(await reopened.get('paper-one', 'b'.repeat(64)), undefined);
  const entry = JSON.parse(await readFile(path.join(root, 'paper-one', '.reading-cache', key + '.json'), 'utf8'));
  assert.deepEqual(Object.keys(entry).sort(), ['text', 'version']);
});

test('corrupted and oversized caches are misses, and writes reject unsafe paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-reading-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = 'b'.repeat(64), cache = new ReadingCacheStore(root);
  await cache.set('paper', key, 'Small completed evidence note.');
  const file = path.join(root, 'paper', '.reading-cache', key + '.json');
  await writeFile(file, '{incomplete');
  assert.equal(await cache.get('paper', key), undefined);
  await writeFile(file, JSON.stringify({ version: 1, text: 'x'.repeat(130_000) }));
  assert.equal(await cache.get('paper', key), undefined);
  await cache.set('paper', 'c'.repeat(64), 'x'.repeat(24_001));
  assert.equal(await cache.get('paper', 'c'.repeat(64)), undefined);
  await assert.rejects(cache.set('../outside', key, 'note'), /workspace/);
  await assert.rejects(cache.set('paper', '../outside', 'note'), /cache key/);
  assert.deepEqual(await readdir(root), ['paper']);
});

test('the per-paper evidence cache has a fixed file bound', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pairleaf-reading-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new ReadingCacheStore(root);
  for (let i = 0; i < 258; i++) await cache.set('paper', i.toString(16).padStart(64, '0'), `Evidence ${i}`);
  const files = await readdir(path.join(root, 'paper', '.reading-cache'));
  assert.equal(files.length, 256);
  assert.equal(await cache.get('paper', (257).toString(16).padStart(64, '0')), 'Evidence 257');
});
