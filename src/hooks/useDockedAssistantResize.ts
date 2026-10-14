import { useLayoutEffect, useRef, type HTMLAttributes, type RefObject } from 'react';
import { ASSISTANT_LIMITS, clampAssistantWidth } from './floatingAssistantGeometry';

interface Options {
  panel: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  workspaceId?: string;
  width: number;
  onResize: (width: number) => void;
}

/** Docked resizing changes width only and never commits a cancelled gesture. */
export default function useDockedAssistantResize(options: Options): Pick<HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onKeyDown'> {
  const latest = useRef(options); latest.current = options;
  const stop = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => stop.current?.(), [options.enabled, options.workspaceId, options.width]);

  return {
    onPointerDown(event) {
      const current = latest.current, element = current.panel.current;
      if (!current.enabled || !element || stop.current || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      const handle = event.currentTarget, pointerId = event.pointerId, startX = event.clientX;
      const original = element.style.getPropertyValue('--assistant-width');
      const startWidth = element.getBoundingClientRect().width;
      let next = startWidth, frame = 0, finished = false;
      const paint = () => { frame = 0; if (!finished) element.style.setProperty('--assistant-width', `${next}px`); };
      const move = (pointer: PointerEvent) => {
        if (pointer.pointerId !== pointerId) return;
        next = clampAssistantWidth(startWidth + startX - pointer.clientX);
        if (!frame) frame = requestAnimationFrame(paint);
      };
      const finish = (commit: boolean) => {
        if (finished) return;
        finished = true; stop.current = null;
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', cancelPointer);
        window.removeEventListener('blur', cancel);
        window.removeEventListener('keydown', escape, true);
        handle.removeEventListener('lostpointercapture', cancelPointer);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        document.body.classList.remove('resizing-assistant');
        element.classList.remove('is-resizing'); delete element.dataset.resizeActive;
        if (commit) {
          element.style.setProperty('--assistant-width', `${next}px`);
          if (Math.abs(next - startWidth) > .01) current.onResize(next);
        } else if (original) element.style.setProperty('--assistant-width', original);
        else element.style.removeProperty('--assistant-width');
      };
      const end = (pointer: PointerEvent) => {
        if (pointer.pointerId !== pointerId) return;
        next = clampAssistantWidth(startWidth + startX - pointer.clientX); finish(true);
      };
      const cancel = () => finish(false);
      const cancelPointer = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(false); };
      const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(false); } };
      stop.current = cancel;
      document.body.classList.add('resizing-assistant');
      element.classList.add('is-resizing'); element.dataset.resizeActive = 'w';
      try { handle.setPointerCapture(pointerId); } catch { finish(false); return; }
      handle.addEventListener('lostpointercapture', cancelPointer);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', cancelPointer);
      window.addEventListener('blur', cancel);
      window.addEventListener('keydown', escape, true);
    },
    onKeyDown(event) {
      const current = latest.current;
      if (!current.enabled || stop.current || event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 40 : 20;
      current.onResize(event.key === 'Home' ? ASSISTANT_LIMITS.width : clampAssistantWidth(current.width + (event.key === 'ArrowLeft' ? step : -step)));
    },
  };
}
