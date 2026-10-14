import type { PDFPageProxy } from 'pdfjs-dist';
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGE_EDGE, MAX_CHAT_IMAGE_PIXELS } from '../../shared/images';

export interface CapturePoint { x: number; y: number }
export interface CaptureBounds { left: number; top: number; width: number; height: number }
export interface CaptureViewport {
  width: number; height: number; rotation: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}
export type CaptureRect = [number, number, number, number];
const clamp = (value: number, max = 1) => Math.min(max, Math.max(0, value));
const finite = (...values: number[]) => values.every(Number.isFinite);

/** Fractions of the displayed page, independent of CSS zoom, scrolling and DPR. */
export function capturePoint(clientX: number, clientY: number, bounds: CaptureBounds): CapturePoint | null {
  if (!finite(clientX, clientY, bounds.left, bounds.top, bounds.width, bounds.height) || bounds.width <= 0 || bounds.height <= 0) return null;
  return { x: clamp((clientX - bounds.left) / bounds.width), y: clamp((clientY - bounds.top) / bounds.height) };
}

/** Transform all four visual corners back into original PDF CropBox coordinates. */
export function capturePdfRect(viewport: CaptureViewport, start: CapturePoint, end: CapturePoint): CaptureRect | null {
  if (!finite(viewport.width, viewport.height, start.x, start.y, end.x, end.y) || viewport.width <= 0 || viewport.height <= 0) return null;
  const points = [[start.x, start.y], [end.x, start.y], [start.x, end.y], [end.x, end.y]]
    .map(([x, y]) => viewport.convertToPdfPoint(clamp(x) * viewport.width, clamp(y) * viewport.height));
  if (points.some(point => point.length !== 2 || !point.every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000))) return null;
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const rect: CaptureRect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return rect[2] > rect[0] && rect[3] > rect[1] ? rect : null;
}

export function imageCapturePlan(viewport: CaptureViewport, rect?: CaptureRect) {
  if (!finite(viewport.width, viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error('Invalid PDF page dimensions.');
  let left = 0, top = 0, right = viewport.width, bottom = viewport.height;
  if (rect) {
    if (!rect.every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1]) throw new Error('Invalid PDF image selection.');
    const corners = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[0], rect[3]], [rect[2], rect[3]]]
      .map(([x, y]) => viewport.convertToViewportPoint(x, y));
    if (corners.some(point => !point.every(Number.isFinite))) throw new Error('Invalid PDF image selection.');
    left = clamp(Math.min(...corners.map(point => point[0])), viewport.width);
    right = clamp(Math.max(...corners.map(point => point[0])), viewport.width);
    top = clamp(Math.min(...corners.map(point => point[1])), viewport.height);
    bottom = clamp(Math.max(...corners.map(point => point[1])), viewport.height);
  }
  const width = right - left, height = bottom - top;
  if (width <= 0 || height <= 0) throw new Error('The selected area is outside the PDF page.');
  const scale = Math.min(3, MAX_CHAT_IMAGE_EDGE / width, MAX_CHAT_IMAGE_EDGE / height, Math.sqrt(MAX_CHAT_IMAGE_PIXELS / (width * height)));
  return { left, top, width, height, scale,
    pixelWidth: Math.max(1, Math.min(MAX_CHAT_IMAGE_EDGE, Math.ceil(width * scale))),
    pixelHeight: Math.max(1, Math.min(MAX_CHAT_IMAGE_EDGE, Math.ceil(height * scale))),
    transform: [1, 0, 0, 1, -left * scale, -top * scale],
  };
}

function checkAbort(signal: AbortSignal) { if (signal.aborted) throw new DOMException('Image capture cancelled.', 'AbortError'); }
function canvasBlob(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality?: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Unable to encode the PDF image.')), type, quality));
}
function blobDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => { signal.removeEventListener('abort', abort); reader.onload = reader.onerror = reader.onabort = null; };
    const abort = () => reader.abort();
    reader.onload = () => { const result = String(reader.result); cleanup(); resolve(result); };
    reader.onerror = () => { cleanup(); reject(new Error('Unable to read the PDF image.')); };
    reader.onabort = () => { cleanup(); reject(new DOMException('Image capture cancelled.', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(blob);
  });
}

/** Render directly into a bounded crop canvas; no screen capture or themed canvas reuse. */
export async function renderPdfImage(page: PDFPageProxy, options: { rotation: number; rect?: CaptureRect; signal: AbortSignal }) {
  const { signal, rotation, rect } = options;
  checkAbort(signal);
  const base = page.getViewport({ scale: 1, rotation });
  const plan = imageCapturePlan(base, rect);
  const canvas = document.createElement('canvas');
  const canvases = [canvas];
  let task: ReturnType<PDFPageProxy['render']> | undefined;
  const abort = () => task?.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    canvas.width = plan.pixelWidth; canvas.height = plan.pixelHeight;
    task = page.render({ canvas, viewport: page.getViewport({ scale: plan.scale, rotation }),
      transform: plan.transform, background: 'rgb(255,255,255)' });
    await task.promise;
    task = undefined;
    checkAbort(signal);
    let current = canvas;
    for (let downsample = 0; downsample < 5; downsample++) {
      for (const [mimeType, quality] of [['image/png', undefined], ['image/jpeg', .9], ['image/jpeg', .75], ['image/jpeg', .6]] as const) {
        checkAbort(signal);
        const blob = await canvasBlob(current, mimeType, quality);
        checkAbort(signal);
        if (blob.size <= MAX_CHAT_IMAGE_BYTES) {
          const dataUrl = await blobDataUrl(blob, signal);
          checkAbort(signal);
          return { dataUrl, mimeType: blob.type, width: current.width, height: current.height };
        }
      }
      const reduced = document.createElement('canvas');
      canvases.push(reduced);
      reduced.width = Math.max(1, Math.floor(current.width * .7)); reduced.height = Math.max(1, Math.floor(current.height * .7));
      const context = reduced.getContext('2d');
      if (!context) throw new Error('Unable to create an image canvas.');
      context.fillStyle = '#fff'; context.fillRect(0, 0, reduced.width, reduced.height);
      context.drawImage(current, 0, 0, reduced.width, reduced.height);
      current.width = 0; current.height = 0;
      current = reduced;
    }
    throw new Error('The PDF image exceeds the 4 MiB limit.');
  } finally {
    signal.removeEventListener('abort', abort);
    task?.cancel();
    // The PDF page is shared with its viewer; release only our temporary canvases.
    for (const item of canvases) { item.width = 0; item.height = 0; }
  }
}
