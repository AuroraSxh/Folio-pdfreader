import assert from 'node:assert/strict';
import test from 'node:test';
import { ownsCommentSelection, placeCommentPopover, projectCommentRect, type CommentBox } from '../src/pdf/commentPopover';

const bounds = { left: 600, top: 100, right: 1000, bottom: 780 };
const size = { width: 320, height: 210 };
function inside(anchor: CommentBox, pane = bounds, dimensions = size) {
  const result = placeCommentPopover(anchor, pane, dimensions);
  assert.ok(result);
  assert.ok(result.left >= pane.left && result.top >= pane.top);
  assert.ok(result.left + Math.min(result.maxWidth, dimensions.width) <= pane.right);
  assert.ok(result.top + Math.min(result.maxHeight, dimensions.height) <= pane.bottom);
  return result;
}

test('comment is adjacent to the passage and stays within each pane at all four corners', () => {
  const top = inside({ left: 640, top: 130, right: 760, bottom: 145 });
  assert.equal(top.placement, 'below'); assert.equal(top.top, 155); assert.equal(top.left, 640);
  const bottom = inside({ left: 650, top: 730, right: 900, bottom: 744 });
  assert.equal(bottom.placement, 'above'); assert.equal(bottom.top, 510);
  for (const left of [602, 980]) for (const top of [103, 760]) inside({ left, top, right: left + 15, bottom: top + 12 });
  const leftPane = inside({ left: 400, top: 400, right: 440, bottom: 415 }, { left: 50, top: 100, right: 500, bottom: 780 });
  assert.ok(leftPane.left + size.width < 500, 'A left-pane comment cannot cover the right PDF');
});

test('scrolling moves the comment with the saved passage and clamps an offscreen draft without losing it', () => {
  const before = inside({ left: 625, top: 350, right: 840, bottom: 365 });
  const after = inside({ left: 625, top: 280, right: 840, bottom: 295 });
  assert.equal(after.top, before.top - 70);
  inside({ left: 625, top: -700, right: 840, bottom: -685 });
  inside({ left: 625, top: 1800, right: 840, bottom: 1820 });
});

test('narrow/short panes and a resized editor stay bounded without negative dimensions', () => {
  const narrow = { left: 900, top: 300, right: 1070, bottom: 490 };
  const result = inside({ left: 950, top: 410, right: 1080, bottom: 430 }, narrow);
  assert.equal(result.maxWidth, 154); assert.equal(result.maxHeight, 174);
  inside({ left: 700, top: 720, right: 860, bottom: 735 }, bounds, { width: 380, height: 360 });
  assert.equal(placeCommentPopover(bounds, { ...bounds, right: bounds.left }, size), null);
  assert.equal(placeCommentPopover({ ...bounds, left: NaN }, bounds, size), null);
});

test('draft ownership cannot cross workspaces, documents, or mixed-document selection parts', () => {
  const selection = { workspaceId: 'paper-a', documentId: 'pdf-main', parts: [{ documentId: 'pdf-main' }, { documentId: 'pdf-main' }] };
  assert.equal(ownsCommentSelection(selection, 'paper-a', 'pdf-main'), true);
  assert.equal(ownsCommentSelection(selection, 'paper-b', 'pdf-main'), false);
  assert.equal(ownsCommentSelection(selection, 'paper-a', 'pdf-supplement'), false);
  assert.equal(ownsCommentSelection({ ...selection, parts: [{ documentId: 'pdf-supplement' }] }, 'paper-a', 'pdf-main'), false);
  assert.equal(ownsCommentSelection({ ...selection, parts: [] }, 'paper-a', 'pdf-main'), false);
  assert.equal(ownsCommentSelection(null, 'paper-a', 'pdf-main'), false);
});

test('PDF.js 6 point-only viewport projects the selected rectangle at every rotation and CSS zoom', () => {
  // This intentionally has no convertToViewportRectangle: PDF.js 6 removed it.
  const expected = [
    { left: 321, top: 372, right: 401, bottom: 412 },
    { left: 381, top: 112, right: 421, bottom: 192 },
    { left: 401, top: 172, right: 481, bottom: 212 },
    { left: 581, top: 192, right: 621, bottom: 272 },
  ];
  for (const [index, rotation] of [0, 90, 180, 270].entries()) for (const scale of [.5, 1, 4]) {
    const width = rotation % 180 ? 200 : 100, height = rotation % 180 ? 100 : 200;
    const viewport = Object.freeze({ width: width * scale, height: height * scale,
      convertToViewportPoint(x: number, y: number) {
        const point = { 0: [x, 200 - y], 90: [y, x], 180: [100 - x, y], 270: [200 - y, 100 - x] }[rotation]!;
        return point.map(value => value * scale);
      },
    });
    assert.equal('convertToViewportRectangle' in viewport, false);
    const page = { left: 300, top: 90, clientLeft: 1, clientTop: 2, clientWidth: width * 2, clientHeight: height * 2 };
    assert.deepEqual(projectCommentRect([10, 40, 50, 60], viewport, page), expected[index]);
    assert.equal(projectCommentRect([0, 0, NaN, 1], viewport, page), null);
    assert.equal(projectCommentRect([10, 40, 50, 60], viewport, { ...page, clientWidth: 0 }), null);
  }
});
