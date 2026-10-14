import { useLayoutEffect, useRef, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useI18n } from '../i18n';
import { ASSISTANT_LIMITS, moveAssistantRect, preferredAssistantRect, resizeAssistantRect, type AssistantPosition, type AssistantRect, type AssistantResizeEdge } from './floatingAssistantGeometry';

interface Options {
  container: RefObject<HTMLDivElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  workspaceId?: string;
  position: AssistantPosition | null;
  width: number;
  height: number | null;
  onMove: (position: AssistantPosition | null) => void;
  onResize: (width: number, position?: AssistantPosition, height?: number) => void;
}
type ResizeHandleProps = HTMLAttributes<HTMLElement> & { 'data-assistant-resize': AssistantResizeEdge; 'data-resize-edge': AssistantResizeEdge };
const setPixel = (element: HTMLElement, property: string, value: number) => {
  const pixels = `${Math.round(value * 100) / 100}px`;
  if (element.style.getPropertyValue(property) !== pixels) element.style.setProperty(property, pixels);
};
const paintRect = (element: HTMLElement, rect: AssistantRect) => {
  setPixel(element, '--assistant-x', rect.x); setPixel(element, '--assistant-y', rect.y);
  setPixel(element, '--assistant-width', rect.width); setPixel(element, '--assistant-height', rect.height);
};

/** Pointer frames touch only this panel's CSS. Preferences are committed once. */
export default function useFloatingAssistant(options: Options) {
  const { t } = useI18n();
  const latest = useRef(options); latest.current = options;
  const active = useRef<{ finish: (commit: boolean) => void; refresh: () => void } | null>(null);
  const { enabled, workspaceId, position, width, height } = options;
  const place = () => {
    const current = latest.current, area = current.container.current, element = current.panel.current;
    if (!area || !element || !current.enabled) return;
    if (active.current) { active.current.refresh(); return; }
    paintRect(element, preferredAssistantRect(current.width, current.height, current.position, { width: area.clientWidth, height: area.clientHeight }));
  };
  useLayoutEffect(() => {
    const { container, panel } = latest.current;
    const element = panel.current;
    if (!enabled) {
      // Floating bounds must not leak into the docked width after a narrow window.
      if (element) { setPixel(element, '--assistant-width', width); element.style.removeProperty('--assistant-height'); }
      return;
    }
    if (!container.current || !element) return;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(container.current); observer.observe(element);
    return () => { observer.disconnect(); active.current?.finish(false); };
  }, [enabled, workspaceId, position?.x, position?.y, width, height]);

  const start = (event: ReactPointerEvent<HTMLElement>, edge?: AssistantResizeEdge) => {
    const current = latest.current;
    if (!current.enabled || event.button !== 0 || !event.isPrimary || active.current) return;
    if (!edge && (event.target as HTMLElement).closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
    const area = current.container.current, element = current.panel.current;
    if (!area || !element) return;
    event.preventDefault();
    const handle = event.currentTarget, pointerId = event.pointerId;
    const bounds = area.getBoundingClientRect(), box = element.getBoundingClientRect();
    const origin: AssistantRect = { x: box.left - bounds.left, y: box.top - bounds.top, width: box.width, height: box.height };
    const startX = event.clientX, startY = event.clientY;
    let delta = { x: 0, y: 0 }, frame = 0, finished = false;
    const compute = () => (edge ? resizeAssistantRect(origin, edge, delta, { width: area.clientWidth, height: area.clientHeight }) : moveAssistantRect(origin, delta, { width: area.clientWidth, height: area.clientHeight }));
    const paint = () => { frame = 0; if (!finished) paintRect(element, compute()); };
    const refresh = () => { if (!frame && !finished) frame = requestAnimationFrame(paint); };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      delta = { x: pointer.clientX - startX, y: pointer.clientY - startY };
      refresh();
    };
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true; active.current = null;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape, true);
      handle.removeEventListener('lostpointercapture', cancelPointer);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.classList.remove('moving-assistant', 'resizing-assistant');
      element.classList.remove('is-moving', 'is-resizing');
      delete element.dataset.resizeActive;
      if (commit && (delta.x !== 0 || delta.y !== 0)) {
        const next = compute(); paintRect(element, next);
        // Resizing only one axis must not replace the other axis's saved size
        // with a temporary viewport-clamped size.
        if (edge) current.onResize(/[ew]/.test(edge) && delta.x !== 0 ? next.width : current.width, { x: next.x, y: next.y }, /[ns]/.test(edge) && delta.y !== 0 ? next.height : undefined);
        else current.onMove({ x: next.x, y: next.y });
      } else {
        paintRect(element, preferredAssistantRect(current.width, current.height, current.position, { width: area.clientWidth, height: area.clientHeight }));
      }
    };
    const end = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      delta = { x: pointer.clientX - startX, y: pointer.clientY - startY };
      finish(true);
    };
    const cancel = () => finish(false);
    const cancelPointer = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(false); };
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(false); } };
    active.current = { finish, refresh };
    document.body.classList.add(edge ? 'resizing-assistant' : 'moving-assistant');
    element.classList.add('is-moving');
    if (edge) { element.classList.add('is-resizing'); element.dataset.resizeActive = edge; }
    // A disappearing/replaced handle can reject capture; never leave listeners
    // and body state armed in that case.
    try { handle.setPointerCapture(pointerId); } catch { finish(false); return; }
    handle.addEventListener('lostpointercapture', cancelPointer);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape, true);
  };
  const resizeHandleProps = (edge: AssistantResizeEdge): ResizeHandleProps => {
    const horizontal = /[ew]/.test(edge), vertical = /[ns]/.test(edge), corner = horizontal && vertical;
    const names: Record<AssistantResizeEdge, string> = {
      n: t('调整阅读伙伴上边缘', 'Resize companion top edge'), s: t('调整阅读伙伴下边缘', 'Resize companion bottom edge'),
      e: t('调整阅读伙伴右边缘', 'Resize companion right edge'), w: t('调整阅读伙伴左边缘', 'Resize companion left edge'),
      ne: t('调整阅读伙伴右上角', 'Resize companion top right corner'), nw: t('调整阅读伙伴左上角', 'Resize companion top left corner'),
      se: t('调整阅读伙伴右下角', 'Resize companion bottom right corner'), sw: t('调整阅读伙伴左下角', 'Resize companion bottom left corner'),
    };
    return {
      role: corner ? 'button' : 'separator', tabIndex: 0,
      'data-assistant-resize': edge, 'data-resize-edge': edge, 'aria-label': names[edge],
      ...(!corner ? { 'aria-orientation': horizontal ? 'vertical' as const : 'horizontal' as const,
        'aria-valuemin': horizontal ? ASSISTANT_LIMITS.minWidth : ASSISTANT_LIMITS.minHeight,
        'aria-valuemax': horizontal ? ASSISTANT_LIMITS.maxWidth : ASSISTANT_LIMITS.maxHeight,
        'aria-valuenow': horizontal ? width : height ?? ASSISTANT_LIMITS.height } : {}),
      title: t('拖动边框调整大小 · 方向键微调 · Shift 加速 · Home 复位', 'Drag to resize · arrow keys to adjust · Shift for larger steps · Home to reset'),
      onPointerDown: event => start(event, edge),
      onKeyDown: event => {
        if (event.target !== event.currentTarget || active.current || !latest.current.enabled) return;
        const key = event.key;
        if (!(horizontal && ['ArrowLeft', 'ArrowRight'].includes(key)) && !(vertical && ['ArrowUp', 'ArrowDown'].includes(key)) && key !== 'Home') return;
        const current = latest.current, area = current.container.current, element = current.panel.current;
        if (!area || !element) return;
        event.preventDefault(); event.stopPropagation();
        const box = element.getBoundingClientRect(), bounds = area.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
        const origin = { x: box.left - bounds.left, y: box.top - bounds.top, width: box.width, height: box.height };
        const delta = key === 'Home' ? {
          x: horizontal ? (ASSISTANT_LIMITS.width - box.width) * (edge.includes('w') ? -1 : 1) : 0,
          y: vertical ? (ASSISTANT_LIMITS.height - box.height) * (edge.includes('n') ? -1 : 1) : 0,
        } : { x: key === 'ArrowRight' ? step : key === 'ArrowLeft' ? -step : 0, y: key === 'ArrowDown' ? step : key === 'ArrowUp' ? -step : 0 };
        const next = resizeAssistantRect(origin, edge, delta, { width: area.clientWidth, height: area.clientHeight });
        paintRect(element, next);
        current.onResize(horizontal && (key === 'Home' || delta.x !== 0) ? next.width : current.width, { x: next.x, y: next.y }, vertical && (key === 'Home' || delta.y !== 0) ? next.height : undefined);
      },
    };
  };
  const dragHandleProps: HTMLAttributes<HTMLElement> | undefined = enabled ? {
    role: 'group', 'aria-label': t('移动阅读伙伴', 'Move reading companion'), tabIndex: 0,
    title: t('拖动标题栏移动 · 方向键微调 · Home 复位', 'Drag to move · arrow keys to adjust · Home to reset'),
    onPointerDown: event => start(event),
    onKeyDown: event => {
      if (event.target !== event.currentTarget || active.current) return;
      const current = latest.current;
      if (event.key === 'Home') { event.preventDefault(); current.onMove(null); return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const area = current.container.current, element = current.panel.current;
      if (!area || !element) return;
      event.preventDefault();
      const box = element.getBoundingClientRect(), bounds = area.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
      const next = moveAssistantRect({ x: box.left - bounds.left, y: box.top - bounds.top, width: box.width, height: box.height }, { x: event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0, y: event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0 }, { width: area.clientWidth, height: area.clientHeight });
      current.onMove({ x: next.x, y: next.y });
    },
  } : undefined;
  return { dragHandleProps, resizeHandleProps, resize: (event: ReactPointerEvent<HTMLElement>) => start(event, 'w') };
}
