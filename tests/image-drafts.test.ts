import assert from 'node:assert/strict';
import test from 'node:test';
import { appendDraftImage, isLocalImagePreview, removeSubmittedDrafts, sameImageScope, submissionImages, validatedDrafts } from '../src/components/imageDrafts';
import { imageDraft, syntheticPNG } from './image-fixtures';

test('renderer image drafts enforce bounds before append and do not keep decoded buffers in IPC values', () => {
  const images = validatedDrafts([{ ...imageDraft(), name: '  Figure A  ' }]);
  assert.deepEqual(Object.keys(images[0]).sort(), ['dataUrl', 'name']);
  assert.equal(images[0].name, 'Figure A');
  const original = Array.from({ length: 4 }, (_, index) => ({ id: String(index), image: imageDraft() }));
  assert.throws(() => appendDraftImage(original, imageDraft(), 'fifth'), /4/);
  assert.equal(original.length, 4);
  const large = imageDraft(syntheticPNG(1, 1, 3 * 1024 * 1024));
  assert.throws(() => appendDraftImage([{ id: '1', image: large }, { id: '2', image: large }], large, '3'), /8 MiB/);
});

test('an acknowledged send clears exactly its captured draft IDs and preserves newly captured pictures', () => {
  const first = appendDraftImage([], imageDraft(), 'old');
  const sentIds = first.map(item => item.id);
  const capturedDuringAwait = appendDraftImage(first, imageDraft(), 'new');
  assert.deepEqual(removeSubmittedDrafts(capturedDuringAwait, sentIds).map(item => item.id), ['new']);
  // The pending snapshot remains readable for retry after an IPC/API failure.
  assert.equal(first[0].image.dataUrl, imageDraft().dataUrl);
  assert.deepEqual(removeSubmittedDrafts(capturedDuringAwait, []), capturedDuringAwait);
});

test('voice and implicit automatic-summary submissions never inherit unconfirmed draft pictures', () => {
  const images = [imageDraft()];
  assert.deepEqual(submissionImages(undefined, false), []);
  assert.deepEqual(submissionImages({ images, draftIds: ['a'] }, true), []);
  assert.deepEqual(submissionImages({ images, draftIds: ['a'] }, false), images);
  const retry = { images: [imageDraft(syntheticPNG(12, 8))] };
  assert.deepEqual(submissionImages(retry, false), retry.images);
  assert.notEqual(submissionImages(retry, false)[0].dataUrl, images[0].dataUrl);
});

test('delayed image requests are scoped to both paper and conversation, including an empty initial conversation', () => {
  const origin = { workspaceId: 'paper-a', conversationId: 'chat-a' };
  assert.equal(sameImageScope(origin, { ...origin }), true);
  assert.equal(sameImageScope(origin, { ...origin, workspaceId: 'paper-b' }), false);
  assert.equal(sameImageScope(origin, { ...origin, conversationId: 'chat-b' }), false);
  assert.equal(sameImageScope({ ...origin, conversationId: '' }, origin), false);
  const documents = [{ id: 'doc-a', name: 'Original.pdf', pageCount: 2 }];
  const image = { ...imageDraft(), source: { documentId: 'doc-a', documentName: 'Original.pdf', page: 2 } };
  assert.equal(appendDraftImage([], image, 'capture', documents)[0].image.source?.page, 2);
  assert.throws(() => appendDraftImage([], image, 'late-capture', []), /source|来源/);
});

test('history previews cannot create remote image requests or load SVG/oversized data', () => {
  assert.equal(isLocalImagePreview(imageDraft().dataUrl), true);
  for (const value of ['https://example.org/private.png', 'file:///tmp/secret.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,AAAA\n', 'data:image/png;base64,' + 'A'.repeat(6_000_000), null, {}]) assert.equal(isLocalImagePreview(value), false);
});
