import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { PDFPageProxy } from 'pdfjs-dist';
import { capturePoint, capturePdfRect, imageCapturePlan, renderPdfImage, type CaptureViewport } from '../src/pdf/imageCapture';
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGE_EDGE, MAX_CHAT_IMAGE_PIXELS } from '../shared/images';

function viewport(rotation = 0, scale = 1, box = [-20, 30, 80, 230]): CaptureViewport {
  const [x0, y0, x1, y1] = box, width = x1 - x0, height = y1 - y0;
  return {
    rotation, width: (rotation % 180 ? height : width) * scale, height: (rotation % 180 ? width : height) * scale,
    convertToViewportPoint: (x, y) => ({ 0: [x - x0, y1 - y], 90: [y - y0, x - x0], 180: [x1 - x, y - y0], 270: [y1 - y, x1 - x] }[rotation]!).map(value => value * scale),
    convertToPdfPoint: (x, y) => ({ 0: [x0 + x / scale, y1 - y / scale], 90: [x0 + y / scale, y0 + x / scale], 180: [x1 - x / scale, y0 + y / scale], 270: [x1 - y / scale, y1 - x / scale] }[rotation]!),
  };
}

test('all quarter-turn crops preserve original PDF coordinates including a nonzero, negative CropBox', () => {
  const rect: [number, number, number, number] = [10, 75, 70, 105];
  const expected = [
    { left: 30, top: 125, width: 60, height: 30 },
    { left: 45, top: 30, width: 30, height: 60 },
    { left: 10, top: 45, width: 60, height: 30 },
    { left: 125, top: 10, width: 30, height: 60 },
  ];
  for (const [index, rotation] of [0, 90, 180, 270].entries()) {
    const view = viewport(rotation), crop = imageCapturePlan(view, rect);
    for (const key of ['left', 'top', 'width', 'height'] as const) assert.equal(crop[key], expected[index][key]);
    const start = { x: crop.left / view.width, y: crop.top / view.height };
    const end = { x: (crop.left + crop.width) / view.width, y: (crop.top + crop.height) / view.height };
    assert.deepEqual(capturePdfRect(view, start, end), rect);
    assert.deepEqual(capturePdfRect(view, end, start), rect, 'Reverse dragging must capture the same PDF area');
  }
});

test('screen-to-PDF selection is invariant across CSS zoom, scrolling, and canvas DPR', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const original = capturePdfRect(viewport(rotation), { x: .2, y: .3 }, { x: .7, y: .8 });
    for (const scale of [.25, 1, 2.5, 10]) for (const dpr of [1, 2, 3]) {
      const view = viewport(rotation, scale);
      // The page's canvas backing store may be DPR times larger. Selection
      // intentionally uses the actual displayed bounds instead of that bitmap.
      const canvasPixels = [view.width * dpr, view.height * dpr];
      assert.ok(canvasPixels.every(value => value > 0));
      const bounds = { left: -470, top: -260, width: view.width * 1.75, height: view.height * 1.75 };
      const start = capturePoint(bounds.left + bounds.width * .2, bounds.top + bounds.height * .3, bounds)!;
      const end = capturePoint(bounds.left + bounds.width * .7, bounds.top + bounds.height * .8, bounds)!;
      const rect = capturePdfRect(view, start, end)!;
      rect.forEach((value, i) => assert.ok(Math.abs(value - original![i]) < 1e-8));
    }
  }
});

test('dragging outside the page clamps to that page and invalid or empty selections are rejected', () => {
  const bounds = { left: 100, top: 200, width: 300, height: 500 };
  assert.deepEqual(capturePoint(0, 0, bounds), { x: 0, y: 0 });
  assert.deepEqual(capturePoint(900, 900, bounds), { x: 1, y: 1 });
  assert.deepEqual(capturePdfRect(viewport(90), { x: -10, y: -10 }, { x: 10, y: 10 }), [-20, 30, 80, 230]);
  assert.equal(capturePoint(NaN, 0, bounds), null);
  assert.equal(capturePoint(0, 0, { ...bounds, width: 0 }), null);
  assert.equal(capturePdfRect(viewport(), { x: .2, y: .2 }, { x: .2, y: .8 }), null);
  assert.throws(() => imageCapturePlan(viewport(), [900, 900, 950, 950]), /outside/);
  assert.throws(() => imageCapturePlan(viewport(), [0, 0, NaN, 5]), /Invalid/);
});

test('full-page and tiny-area rendering always obey edge and pixel limits; crops allocate only the selected area', () => {
  for (const box of [[0, 0, 612, 792], [0, 0, 100000, 100000], [0, 0, 100000, 10], [0, 0, 10, 100000]]) {
    const plan = imageCapturePlan(viewport(0, 1, box));
    assert.ok(plan.pixelWidth <= MAX_CHAT_IMAGE_EDGE && plan.pixelHeight <= MAX_CHAT_IMAGE_EDGE);
    assert.ok(plan.pixelWidth * plan.pixelHeight <= MAX_CHAT_IMAGE_PIXELS);
  }
  const crop = imageCapturePlan(viewport(0, 1, [0, 0, 10000, 10000]), [250, 300, 450, 400]);
  assert.equal(crop.pixelWidth, 600); assert.equal(crop.pixelHeight, 300);
  assert.deepEqual(crop.transform, [1, 0, 0, 1, -750, -28800]);
});

function canvasHarness(t: TestContext, options: { oversizedPng?: boolean } = {}) {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const savedReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  const canvases: { width: number; height: number; toBlob: (callback: BlobCallback, type: string, quality?: number) => void }[] = [];
  const encodings: { type: string; quality?: number }[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => {
    assert.equal(tag, 'canvas');
    const canvas = { width: 0, height: 0, toBlob: (callback: BlobCallback, type: string, quality?: number) => {
      encodings.push({ type, quality });
      const size = options.oversizedPng && type === 'image/png' ? MAX_CHAT_IMAGE_BYTES + 1 : 128;
      queueMicrotask(() => callback(new Blob([new Uint8Array(size)], { type })));
    } };
    canvases.push(canvas); return canvas;
  } } });
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: class {
    result = ''; onload?: () => void; onerror?: () => void; onabort?: () => void; aborted = false;
    readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(bytes => { if (!this.aborted) { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload?.(); } }); }
    abort() { this.aborted = true; this.onabort?.(); }
  } });
  t.after(() => {
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument); else delete (globalThis as Record<string, unknown>).document;
    if (savedReader) Object.defineProperty(globalThis, 'FileReader', savedReader); else delete (globalThis as Record<string, unknown>).FileReader;
  });
  return { canvases, encodings };
}

test('capture renders a bounded raw-white crop at the requested rotation and frees its temporary canvas', async t => {
  const harness = canvasHarness(t); let renderCount = 0;
  const page = {
    getViewport: ({ rotation, scale }: { rotation: number; scale: number }) => viewport(rotation, scale),
    render: (options: any) => {
      renderCount++;
      assert.equal(options.background, 'rgb(255,255,255)');
      assert.equal(options.viewport.rotation, 90);
      assert.equal(options.canvas.width, 90); assert.equal(options.canvas.height, 180);
      assert.deepEqual(options.transform, [1, 0, 0, 1, -135, -90]);
      return { promise: Promise.resolve(), cancel: () => assert.fail('A completed task does not require cancellation') };
    },
    cleanup: () => assert.fail('Do not clean up a PDF page owned by the viewer'),
  } as unknown as PDFPageProxy;
  const image = await renderPdfImage(page, { rotation: 90, rect: [10, 75, 70, 105], signal: new AbortController().signal });
  assert.equal(renderCount, 1); assert.equal(image.width, 90); assert.equal(image.height, 180);
  assert.match(image.dataUrl, /^data:image\/png;base64,/);
  assert.ok(harness.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('PNG exceeding the byte budget is encoded as JPEG before any image is returned', async t => {
  const harness = canvasHarness(t, { oversizedPng: true });
  const page = { getViewport: ({ rotation, scale }: any) => viewport(rotation, scale), render: () => ({ promise: Promise.resolve(), cancel() {} }) } as unknown as PDFPageProxy;
  const image = await renderPdfImage(page, { rotation: 0, signal: new AbortController().signal });
  assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual(harness.encodings, [{ type: 'image/png', quality: undefined }, { type: 'image/jpeg', quality: .9 }]);
  assert.ok(harness.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('cancellation stops an active render and releases its canvas without emitting a draft', async t => {
  const harness = canvasHarness(t), controller = new AbortController(); let cancelled = 0;
  let rejectRender!: (error: Error) => void;
  const page = { getViewport: ({ rotation, scale }: any) => viewport(rotation, scale), render: () => ({
    promise: new Promise<void>((_resolve, reject) => { rejectRender = reject; }),
    cancel: () => { cancelled++; rejectRender(new DOMException('cancelled', 'AbortError')); },
  }) } as unknown as PDFPageProxy;
  const pending = renderPdfImage(page, { rotation: 270, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(cancelled >= 1); assert.equal(harness.encodings.length, 0);
  assert.ok(harness.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  await assert.rejects(renderPdfImage(page, { rotation: 0, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(harness.canvases.length, 1, 'Already-cancelled work must not allocate another canvas');
});
