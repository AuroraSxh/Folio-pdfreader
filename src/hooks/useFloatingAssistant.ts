import { useLayoutEffect, useRef, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { AssistantPosition } from './useReadingLayout';
import { useI18n } from '../i18n';

interface Options {
  container: RefObject<HTMLDivElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  workspaceId?: string;
  position: AssistantPosition | null;
  onMove: (position: AssistantPosition | null) => void;
  onResize: (width: number, position?: AssistantPosition) => void;
}
const margin = 12;
const limit = (value: number, size: number, panelSize: number) => {
  const maximum = Math.max(0, size - panelSize - margin);
  return Math.max(Math.min(margin, maximum), Math.min(maximum, value));
};

/** Only the floating panel moves. Pointer frames never update React or PDF state. */
export default function useFloatingAssistant({ container, panel, enabled, workspaceId, position, onMove, onResize }: Options) {
  const {t}=useI18n();
  const stop = useRef<((commit: boolean) => void) | null>(null);
  const place = () => {
    const area = container.current, element = panel.current;
    if (!area || !element || !enabled || stop.current) return;
    element.style.setProperty('--assistant-x', `${limit(position?.x ?? area.clientWidth - element.offsetWidth - margin, area.clientWidth, element.offsetWidth)}px`);
    element.style.setProperty('--assistant-y', `${limit(position?.y ?? margin, area.clientHeight, element.offsetHeight)}px`);
  };
  useLayoutEffect(() => {
    if (!enabled || !container.current || !panel.current) return;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(container.current); observer.observe(panel.current);
    return () => { observer.disconnect(); stop.current?.(false); };
  }, [enabled, workspaceId, position?.x, position?.y]);

  const start = (event: ReactPointerEvent<HTMLElement>, resizing = false) => {
    if (!enabled || event.button !== 0 || !event.isPrimary || stop.current) return;
    if (!resizing && (event.target as HTMLElement).closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
    const area = container.current, element = panel.current;
    if (!area || !element) return;
    event.preventDefault();
    const handle = event.currentTarget, pointerId = event.pointerId;
    const bounds = area.getBoundingClientRect(), box = element.getBoundingClientRect();
    const origin = { x: box.left - bounds.left, y: box.top - bounds.top };
    const startX = event.clientX, startY = event.clientY, originalWidth = element.style.getPropertyValue('--assistant-width');
    let next = origin, width = box.width, frame = 0;
    const paint = () => {
      frame = 0;
      element.style.setProperty('--assistant-x', `${next.x}px`);
      element.style.setProperty('--assistant-y', `${next.y}px`);
      if (resizing) element.style.setProperty('--assistant-width', `${width}px`);
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (resizing) {
        // Keep the opposite edge still, including after the panel has been moved.
        const right = origin.x + box.width;
        width = Math.max(Math.min(320, right - margin), Math.min(600, right - margin, box.width + startX - pointer.clientX));
        next = { x: right - width, y: origin.y };
      } else next = {
        x: limit(origin.x + pointer.clientX - startX, area.clientWidth, box.width),
        y: limit(origin.y + pointer.clientY - startY, area.clientHeight, box.height),
      };
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const finish = (commit: boolean) => {
      stop.current = null;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape, true);
      handle.removeEventListener('lostpointercapture', cancel);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.classList.remove('moving-assistant', 'resizing-assistant');
      element.classList.remove('is-moving');
      if (commit) {
        paint();
        next = { x: limit(next.x, area.clientWidth, element.offsetWidth), y: limit(next.y, area.clientHeight, element.offsetHeight) };
        paint();
        if (resizing) onResize(width, next); else onMove(next);
      } else {
        element.style.setProperty('--assistant-width', originalWidth);
        element.style.setProperty('--assistant-x', `${limit(origin.x, area.clientWidth, element.offsetWidth)}px`);
        element.style.setProperty('--assistant-y', `${limit(origin.y, area.clientHeight, element.offsetHeight)}px`);
      }
    };
    const end = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(true); };
    const cancel = () => finish(false);
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(false); } };
    stop.current = finish;
    document.body.classList.add(resizing ? 'resizing-assistant' : 'moving-assistant');
    element.classList.add('is-moving');
    handle.setPointerCapture(pointerId);
    handle.addEventListener('lostpointercapture', cancel);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape, true);
  };
  const dragHandleProps: HTMLAttributes<HTMLElement> | undefined = enabled ? {
    role: 'group', 'aria-label': t('移动阅读伙伴','Move reading companion'), tabIndex: 0,
    title: t('拖动标题栏移动 · 方向键微调 · Home 复位','Drag to move · arrow keys to adjust · Home to reset'),
    onPointerDown: event => start(event),
    onKeyDown: event => {
      if (event.target !== event.currentTarget || stop.current) return;
      if (event.key === 'Home') { event.preventDefault(); onMove(null); return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const area = container.current, element = panel.current;
      if (!area || !element) return;
      event.preventDefault();
      const box = element.getBoundingClientRect(), bounds = area.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
      onMove({
        x: limit(box.left - bounds.left + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), area.clientWidth, box.width),
        y: limit(box.top - bounds.top + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0), area.clientHeight, box.height),
      });
    },
  } : undefined;
  return { dragHandleProps, resize: (event: ReactPointerEvent<HTMLElement>) => start(event, true) };
}
