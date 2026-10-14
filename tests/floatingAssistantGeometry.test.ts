import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantBounds, ASSISTANT_LIMITS, fitAssistantRect, moveAssistantRect, preferredAssistantRect, resizeAssistantRect, type AssistantRect, type AssistantResizeEdge, type AssistantSize } from '../src/hooks/floatingAssistantGeometry';
import { parseReadingLayout } from '../src/hooks/readingLayoutPreferences';

const area = { width: 1400, height: 1000 };
const original = { x: 300, y: 150, width: 400, height: 500 };
const edges: AssistantResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .001, `${actual} != ${expected}`);
function bounded(rect: AssistantRect, size: AssistantSize) {
  const bounds = assistantBounds(size);
  for (const value of Object.values(rect)) assert.ok(Number.isFinite(value));
  assert.ok(rect.width >= 0 && rect.height >= 0);
  assert.ok(rect.x >= bounds.left && rect.y >= bounds.top);
  assert.ok(rect.x + rect.width <= bounds.right + .001);
  assert.ok(rect.y + rect.height <= bounds.bottom + .001);
}

test('all four edges and four corners retain their opposite edge and unaffected axis', () => {
  for (const edge of edges) {
    const next = resizeAssistantRect(original, edge, { x: 45, y: 35 }, area);
    bounded(next, area);
    if (edge.includes('w')) { near(next.x, original.x + 45); near(next.x + next.width, original.x + original.width); }
    else { near(next.x, original.x); near(next.width, original.width + (edge.includes('e') ? 45 : 0)); }
    if (edge.includes('n')) { near(next.y, original.y + 35); near(next.y + next.height, original.y + original.height); }
    else { near(next.y, original.y); near(next.height, original.height + (edge.includes('s') ? 35 : 0)); }
  }
});

test('overshooting an edge cannot invert a panel or exceed size and container limits', () => {
  for (const edge of edges) for (const delta of [-100000, 100000]) {
    const next = resizeAssistantRect(original, edge, { x: delta, y: delta }, area);
    bounded(next, area);
    assert.ok(next.width >= ASSISTANT_LIMITS.minWidth && next.width <= ASSISTANT_LIMITS.maxWidth);
    assert.ok(next.height >= ASSISTANT_LIMITS.minHeight && next.height <= ASSISTANT_LIMITS.maxHeight);
    if (edge.includes('w')) near(next.x + next.width, original.x + original.width);
    if (edge.includes('n')) near(next.y + next.height, original.y + original.height);
  }
});

test('a bottom-right panel expands north-west without moving its far edges', () => {
  const origin = { x: 1028, y: 488, width: 360, height: 500 };
  const next = resizeAssistantRect(origin, 'nw', { x: -240, y: -1000 }, area);
  assert.deepEqual(next, { x: 788, y: 12, width: 600, height: 976 });
});

test('moving a resized panel retains its dimensions and clamps every boundary', () => {
  for (const x of [-10000, 10000]) for (const y of [-10000, 10000]) {
    const next = moveAssistantRect(original, { x, y }, area);
    bounded(next, area); near(next.width, original.width); near(next.height, original.height);
  }
});

test('window shrink, gesture cancellation, and later growth preserve preferred height and position', () => {
  const preferred = { width: 520, height: 850, x: 700, y: 90 };
  const small = { width: 450, height: 350 };
  const smallResult = preferredAssistantRect(preferred.width, preferred.height, preferred, small);
  bounded(smallResult, small);
  assert.deepEqual(smallResult, { x: 12, y: 12, width: 426, height: 326 });
  // Cancel uses the unchanged preference and current bounds, not stale DOM dimensions.
  assert.deepEqual(preferredAssistantRect(preferred.width, preferred.height, preferred, small), smallResult);
  assert.deepEqual(preferredAssistantRect(preferred.width, preferred.height, preferred, area), preferred);
  assert.deepEqual(preferred, { width: 520, height: 850, x: 700, y: 90 });
});

test('a container resized during a gesture is re-clamped on every axis', () => {
  const small = { width: 290, height: 250 };
  for (const edge of edges) for (const x of [-1000, 1000]) for (const y of [-1000, 1000]) bounded(resizeAssistantRect(original, edge, { x, y }, small), small);
});

test('automatic placement stays at top-right and auto height adapts without persisting it', () => {
  assert.deepEqual(preferredAssistantRect(360, null, null, area), { x: 1028, y: 12, width: 360, height: 640 });
  const lower = preferredAssistantRect(360, null, null, { width: 800, height: 600 });
  assert.deepEqual(lower, { x: 428, y: 12, width: 360, height: 552 });
  const restored = preferredAssistantRect(360, null, null, area);
  assert.equal(restored.height, 640);
});

test('zero, hidden and tiny containers never produce negative or non-finite geometry', () => {
  for (const size of [{ width: 0, height: 0 }, { width: 12, height: 10 }, { width: 320, height: 100 }, { width: NaN, height: Infinity }]) {
    const safe = { width: Number.isFinite(size.width) ? size.width : 0, height: Number.isFinite(size.height) ? size.height : 0 };
    bounded(fitAssistantRect({ x: Infinity, y: NaN, width: NaN, height: Infinity }, size), safe);
    for (const edge of edges) bounded(resizeAssistantRect(original, edge, { x: 100, y: -100 }, size), safe);
  }
});

test('representative dimensions, positions and pointer deltas satisfy viewport bounds', () => {
  for (const width of [100, 340, 650, 1600]) for (const height of [150, 440, 900]) {
    const size = { width, height };
    for (const x of [-900, 12, 700]) for (const y of [-400, 12, 800]) for (const edge of edges) {
      bounded(resizeAssistantRect({ ...original, x, y }, edge, { x: -227, y: 317 }, size), size);
    }
  }
});

test('v1 preferences without height migrate to automatic height and preserve existing fields', () => {
  assert.deepEqual(parseReadingLayout({ navigation: 'expanded', assistantOpen: true, assistantMode: 'docked', assistantWidth: 480, assistantPosition: { x: 128, y: 52 } }), {
    navigation: 'expanded', assistantOpen: true, assistantMode: 'docked', assistantWidth: 480, assistantHeight: null, assistantPosition: { x: 128, y: 52 },
  });
});

test('saved height survives close, docking and JSON round trip without sharing current window dimensions', () => {
  const saved = parseReadingLayout({ assistantWidth: 440, assistantHeight: 810, assistantPosition: { x: 25, y: 30 } });
  const reopened = parseReadingLayout(JSON.parse(JSON.stringify({ ...saved, assistantOpen: true, assistantMode: 'docked' })));
  assert.equal(reopened.assistantHeight, 810); assert.equal(reopened.assistantWidth, 440);
  assert.deepEqual(reopened.assistantPosition, { x: 25, y: 30 });
});

test('invalid stored values are sanitized while unavailable height stays automatic', () => {
  for (const input of [null, [], 3, 'broken', { assistantHeight: Infinity, assistantWidth: NaN, assistantPosition: { x: Infinity, y: 12 } }]) {
    const saved = parseReadingLayout(input);
    assert.equal(saved.assistantWidth, 360); assert.equal(saved.assistantHeight, null); assert.equal(saved.assistantPosition, null);
  }
  assert.equal(parseReadingLayout({ assistantHeight: 1 }).assistantHeight, 400);
  assert.equal(parseReadingLayout({ assistantHeight: 100000 }).assistantHeight, 1600);
  assert.equal(parseReadingLayout({ assistantHeight: 623.7 }).assistantHeight, 624);
});
