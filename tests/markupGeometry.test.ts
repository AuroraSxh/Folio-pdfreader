import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markupRect, viewportRectPercent } from '../src/pdf/markupGeometry';

const close = (actual: number, expected: number) => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const viewport = (rotation: number, scale = 1) => ({
  width: (rotation % 180 ? 200 : 100) * scale,
  height: (rotation % 180 ? 100 : 200) * scale,
  convertToViewportPoint: (x: number, y: number) => ({
    0: [x, 200 - y], 90: [y, x], 180: [100 - x, y], 270: [200 - y, 100 - x],
  }[rotation]!).map(value => value * scale),
});

test('old highlights preserve the full PDF-space rectangle; malformed marks are ignored', () => {
  assert.deepEqual(markupRect([10, 40, 60, 60]), [10, 40, 60, 60]);
  assert.deepEqual(markupRect([60, 60, 10, 40]), [10, 40, 60, 60]);
  for (const rect of [[0, 0, 0, 10], [0, 0, NaN, 10], [0, 0, 5], [0, 0, 5, Infinity]]) assert.equal(markupRect(rect), null);
});

test('underline sits near the text baseline, strikeout crosses the center, with bounded thickness', () => {
  const underline = markupRect([10, 40, 60, 60], 'underline')!;
  const strikeout = markupRect([10, 40, 60, 60], 'strikeout')!;
  close((underline[1] + underline[3]) / 2, 41.6);
  close((strikeout[1] + strikeout[3]) / 2, 50);
  close(strikeout[3] - strikeout[1], 1.3);
  const small = markupRect([0, 0, 20, 5], 'underline')!;
  const large = markupRect([0, 0, 200, 100], 'strikeout')!;
  close(small[3] - small[1], .75);
  close(large[3] - large[1], 2.5);
});

test('PDF-space decorations rotate with text at all quarter-turns', () => {
  const band = markupRect([10, 40, 60, 60], 'strikeout')!;
  const expected = [
    { left: 10, top: 74.675, width: 50, height: .65 },
    { left: 24.675, top: 10, width: .65, height: 50 },
    { left: 40, top: 24.675, width: 50, height: .65 },
    { left: 74.675, top: 40, width: .65, height: 50 },
  ];
  [0, 90, 180, 270].forEach((rotation, i) => {
    const actual = viewportRectPercent(band, viewport(rotation));
    for (const key of ['left', 'top', 'width', 'height'] as const) close(actual[key], expected[i][key]);
  });
});

test('percentage geometry is invariant across zooms, avoiding overlay rebuilds on scale changes', () => {
  for (const kind of ['highlight', 'underline', 'strikeout'] as const) {
    const rect = markupRect([10, 40, 60, 60], kind)!;
    for (const rotation of [0, 90, 180, 270]) {
      const original = viewportRectPercent(rect, viewport(rotation));
      for (const zoom of [.25, 1.5, 3, 10]) {
        const resized = viewportRectPercent(rect, viewport(rotation, zoom));
        for (const key of ['left', 'top', 'width', 'height'] as const) close(resized[key], original[key]);
      }
    }
  }
});
