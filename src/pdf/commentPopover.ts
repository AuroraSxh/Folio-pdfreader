export interface CommentBox { left: number; top: number; right: number; bottom: number }
export interface CommentSelectionOwner {
  workspaceId: string;
  documentId: string;
  parts: readonly { documentId: string }[];
}

export function ownsCommentSelection(selection: CommentSelectionOwner | null, workspaceId: string, documentId: string): boolean {
  return !!selection && selection.workspaceId === workspaceId && selection.documentId === documentId
    && selection.parts.length > 0 && selection.parts.every(part => part.documentId === documentId);
}

interface CommentViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}
interface CommentPageGeometry {
  left: number; top: number; clientWidth: number; clientHeight: number; clientLeft: number; clientTop: number;
}

/** PDF.js 6 exposes point conversion; do not depend on its removed rectangle API. */
export function projectCommentRect(rect: number[], viewport: CommentViewport, page: CommentPageGeometry): CommentBox | null {
  if (rect.length !== 4 || !rect.every(Number.isFinite) || ![viewport.width, viewport.height, ...Object.values(page)].every(Number.isFinite)
    || viewport.width <= 0 || viewport.height <= 0 || page.clientWidth <= 0 || page.clientHeight <= 0) return null;
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const factorX = page.clientWidth / viewport.width, factorY = page.clientHeight / viewport.height;
  return {
    left: page.left + page.clientLeft + Math.min(x1, x2) * factorX,
    top: page.top + page.clientTop + Math.min(y1, y2) * factorY,
    right: page.left + page.clientLeft + Math.max(x1, x2) * factorX,
    bottom: page.top + page.clientTop + Math.max(y1, y2) * factorY,
  };
}

/** Viewport coordinates; scrolling/rotation are handled by the PDF viewport before placement. */
export function placeCommentPopover(anchor: CommentBox, bounds: CommentBox, size: { width: number; height: number }) {
  if (![...Object.values(anchor), ...Object.values(bounds), size.width, size.height].every(Number.isFinite)
    || bounds.right <= bounds.left || bounds.bottom <= bounds.top || size.width <= 0 || size.height <= 0) return null;
  const inset = Math.min(8, (bounds.right - bounds.left) / 4, (bounds.bottom - bounds.top) / 4);
  const leftEdge = bounds.left + inset, rightEdge = bounds.right - inset;
  const topEdge = bounds.top + inset, bottomEdge = bounds.bottom - inset;
  const maxWidth = rightEdge - leftEdge, maxHeight = bottomEdge - topEdge;
  const width = Math.min(size.width, maxWidth), height = Math.min(size.height, maxHeight);
  const limit = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  // Keep an offscreen passage's draft reachable at the nearest pane edge.
  const anchorTop = limit(Math.min(anchor.top, anchor.bottom), topEdge, bottomEdge);
  const anchorBottom = limit(Math.max(anchor.top, anchor.bottom), topEdge, bottomEdge);
  const below = bottomEdge - anchorBottom - 10, above = anchorTop - topEdge - 10;
  const placement = below >= height || below >= above ? 'below' : 'above';
  return {
    left: limit(Math.min(anchor.left, anchor.right), leftEdge, rightEdge - width),
    top: limit(placement === 'below' ? anchorBottom + 10 : anchorTop - height - 10, topEdge, bottomEdge - height),
    maxWidth, maxHeight, placement,
  };
}
