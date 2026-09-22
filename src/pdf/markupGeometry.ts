export type MarkupKind = 'highlight' | 'underline' | 'strikeout';

interface ViewportGeometry {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

/** Work in PDF coordinates so text decorations follow page rotation and zoom. */
export function markupRect(rect: number[], kind: MarkupKind = 'highlight'): [number, number, number, number] | null {
  if (rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  const left = Math.min(rect[0], rect[2]), right = Math.max(rect[0], rect[2]);
  const bottom = Math.min(rect[1], rect[3]), top = Math.max(rect[1], rect[3]);
  if (right <= left || top <= bottom) return null;
  if (kind === 'highlight') return [left, bottom, right, top];
  const thickness = Math.max(.75, Math.min(2.5, (top - bottom) * .065));
  const center = kind === 'underline' ? bottom + (top - bottom) * .08 : (bottom + top) / 2;
  return [left, center - thickness / 2, right, center + thickness / 2];
}

export function viewportRectPercent(rect: number[], viewport: ViewportGeometry) {
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return {
    left: 100 * Math.min(x1, x2) / viewport.width,
    top: 100 * Math.min(y1, y2) / viewport.height,
    width: 100 * Math.abs(x2 - x1) / viewport.width,
    height: 100 * Math.abs(y2 - y1) / viewport.height,
  };
}
