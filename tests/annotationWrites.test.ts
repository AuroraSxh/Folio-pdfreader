import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginAnnotationWrite, isAnnotationSaving, subscribeAnnotationWrites } from '../src/pdf/annotationWrites';

const drain = () => new Promise<void>(resolve => setImmediate(resolve));

test('mirrored panes cannot overwrite an annotation list while its first save is pending', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  assert.equal(beginAnnotationWrite('workspace:shared', async () => { writes++; await gate; }), true);
  assert.equal(isAnnotationSaving('workspace:shared'), true);
  assert.equal(beginAnnotationWrite('workspace:shared', () => { writes++; }), false);
  assert.equal(beginAnnotationWrite('workspace:other', () => { writes++; }), true);
  await drain();
  assert.equal(writes, 2);
  assert.equal(isAnnotationSaving('workspace:shared'), true);
  assert.equal(isAnnotationSaving('workspace:other'), false);
  release(); await drain();
  assert.equal(isAnnotationSaving('workspace:shared'), false);
  assert.equal(beginAnnotationWrite('workspace:shared', () => { writes++; }), true);
  await drain(); assert.equal(writes, 3);
});

test('failed saves release the shared lock and subscriptions are event-driven', async () => {
  const states: boolean[] = [];
  const unsubscribe = subscribeAnnotationWrites(() => states.push(isAnnotationSaving('workspace:failure')));
  beginAnnotationWrite('workspace:failure', () => { throw new Error('disk write failed'); });
  await drain();
  assert.deepEqual(states, [true, false]);
  unsubscribe();
  beginAnnotationWrite('workspace:failure', async () => {});
  await drain();
  assert.deepEqual(states, [true, false]);
  assert.equal(isAnnotationSaving('workspace:failure'), false);
});
