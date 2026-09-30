import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactPageRanges, safeReadingReport } from '../src/components/readingPageRanges';

test('coverage compacts a hundred-page paper and handles disjoint ranges', () => {
  assert.equal(compactPageRanges(Array.from({ length: 100 }, (_, index) => index + 1)), '1–100');
  assert.equal(compactPageRanges([8, 2, 1, 2, 3, 10, 9, 14]), '1–3, 8–10, 14');
});
test('coverage excludes invalid page numbers and bounds sparse lists', () => {
  assert.equal(compactPageRanges([0, -1, NaN, Infinity, 2.5]), '');
  assert.equal(compactPageRanges([1, 3, 5, 7, 9, 11], 3), '1, 3, 5, …');
  assert.equal(compactPageRanges([]), '');
});

test('malformed imported coverage never reaches the renderer or claims completion', () => {
  for (const report of [null, {}, { mode: 'deep', complete: true, documents: [null] }, { mode: 'deep', complete: 'true', documents: [] }, { mode: 'smart', complete: false, documents: [{ name: 'Bad PDF', includedPages: '1–100' }] }]) assert.equal(safeReadingReport(report), undefined);
  const valid = { mode: 'deep', complete: true, documents: [{ documentId: 'paper', name: 'Paper.pdf', totalPages: 3, readablePages: 2, includedPages: [1, 2, 2], unavailablePages: [3] }] };
  assert.deepEqual(safeReadingReport(valid)?.documents[0].includedPages, [1, 2]);
  assert.equal(safeReadingReport({ ...valid, documents: [{ ...valid.documents[0], includedPages: [1, 4] }] }), undefined);
  assert.equal(safeReadingReport({ ...valid, documents: [{ ...valid.documents[0], includedPages: [1, 3] }] }), undefined);
});

test('selection-only coverage accepts a known selected page before total page count is available', () => {
  const report = { mode: 'smart', complete: false, documents: [{ documentId: 'paper', name: 'Paper.pdf', totalPages: 0, readablePages: 1, includedPages: [60], unavailablePages: [] }] };
  assert.deepEqual(safeReadingReport(report)?.documents[0].includedPages, [60]);
  assert.equal(safeReadingReport({ ...report, documents: [{ ...report.documents[0], includedPages: [1_000_001] }] }), undefined);
});
