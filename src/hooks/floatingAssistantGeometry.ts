export interface AssistantPosition { x: number; y: number }
export interface AssistantSize { width: number; height: number }
export interface AssistantRect extends AssistantPosition, AssistantSize {}
export type AssistantResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const ASSISTANT_LIMITS = { margin: 12, minWidth: 320, maxWidth: 600, minHeight: 400, maxHeight: 1600, width: 360, height: 640 } as const;
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, finite(value, low)));
export const clampAssistantWidth = (width: number) => Math.round(clamp(width, ASSISTANT_LIMITS.minWidth, ASSISTANT_LIMITS.maxWidth));
export const clampAssistantHeight = (height: number) => Math.round(clamp(height, ASSISTANT_LIMITS.minHeight, ASSISTANT_LIMITS.maxHeight));

/** Margins collapse only for a container too small to contain them. */
export function assistantBounds(area: AssistantSize) {
  const width = Math.max(0, finite(area.width)), height = Math.max(0, finite(area.height));
  const x = Math.min(ASSISTANT_LIMITS.margin, width / 2), y = Math.min(ASSISTANT_LIMITS.margin, height / 2);
  return { left: x, top: y, right: width - x, bottom: height - y };
}

/** Fitting is temporary: callers keep the original preference when windows shrink. */
export function fitAssistantRect(rect: AssistantRect, area: AssistantSize): AssistantRect {
  const bounds = assistantBounds(area);
  const width = Math.min(clampAssistantWidth(rect.width), bounds.right - bounds.left);
  const height = Math.min(clampAssistantHeight(rect.height), bounds.bottom - bounds.top);
  return { x: clamp(rect.x, bounds.left, bounds.right - width), y: clamp(rect.y, bounds.top, bounds.bottom - height), width, height };
}

export function preferredAssistantRect(width: number, height: number | null, position: AssistantPosition | null, area: AssistantSize): AssistantRect {
  const preferredHeight = height ?? Math.min(ASSISTANT_LIMITS.height, Math.max(0, area.height - 48));
  return fitAssistantRect({ width, height: preferredHeight, x: position?.x ?? area.width - width - ASSISTANT_LIMITS.margin, y: position?.y ?? ASSISTANT_LIMITS.margin }, area);
}

/** Resize from the gesture origin, keeping the opposite edge/corner stationary. */
export function resizeAssistantRect(origin: AssistantRect, edge: AssistantResizeEdge, delta: AssistantPosition, area: AssistantSize): AssistantRect {
  const fitted = fitAssistantRect(origin, area), bounds = assistantBounds(area);
  let { x, y, width, height } = fitted;
  if (edge.includes('w')) {
    const right = x + width, maximum = Math.min(ASSISTANT_LIMITS.maxWidth, right - bounds.left);
    width = clamp(width - delta.x, Math.min(ASSISTANT_LIMITS.minWidth, maximum), maximum);
    x = right - width;
  } else if (edge.includes('e')) {
    const maximum = Math.min(ASSISTANT_LIMITS.maxWidth, bounds.right - x);
    width = clamp(width + delta.x, Math.min(ASSISTANT_LIMITS.minWidth, maximum), maximum);
  }
  if (edge.includes('n')) {
    const bottom = y + height, maximum = Math.min(ASSISTANT_LIMITS.maxHeight, bottom - bounds.top);
    height = clamp(height - delta.y, Math.min(ASSISTANT_LIMITS.minHeight, maximum), maximum);
    y = bottom - height;
  } else if (edge.includes('s')) {
    const maximum = Math.min(ASSISTANT_LIMITS.maxHeight, bounds.bottom - y);
    height = clamp(height + delta.y, Math.min(ASSISTANT_LIMITS.minHeight, maximum), maximum);
  }
  return { x, y, width, height };
}

export function moveAssistantRect(origin: AssistantRect, delta: AssistantPosition, area: AssistantSize): AssistantRect {
  return fitAssistantRect({ ...origin, x: origin.x + delta.x, y: origin.y + delta.y }, area);
}
