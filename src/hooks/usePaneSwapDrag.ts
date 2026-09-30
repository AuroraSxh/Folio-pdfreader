import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type DragEvent, type HTMLAttributes } from 'react';
import { useI18n } from '../i18n';
import {
  PANE_SWAP_MIME, canDropPaneSwap, isPaneSwapTransfer, matchesPaneSwapSession, parsePaneSwapSession,
  type PaneSide, type PaneSwapContext, type PaneSwapSession,
} from './paneSwapDrag';
import './pane-swap-drag.css';

export { isPaneSwapTransfer } from './paneSwapDrag';

interface Options extends PaneSwapContext {
  direction: 'vertical' | 'horizontal';
  onSwap: (from: PaneSide) => void;
}

interface PaneProps extends HTMLAttributes<HTMLElement> {
  'data-pane-swap-source'?: 'true';
  'data-pane-swap-target'?: 'true';
  'data-pane-swap-label': string;
}

interface HandleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'data-pane-swap-handle': 'true';
}

/** Native tab dragging never intercepts PDF text selection or external file drops. */
export function usePaneSwapDrag(options: Options) {
  const { t } = useI18n();
  const current = useRef(options);
  current.current = options;
  const session = useRef<PaneSwapSession | null>(null);
  const lastDragEnd = useRef(0);
  const [source, setSource] = useState<PaneSide | null>(null);
  const [target, setTarget] = useState<PaneSide | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const enabled = Boolean(options.workspaceId && options.identity && options.split && !options.disabled);

  const clear = useCallback(() => {
    if (session.current) lastDragEnd.current = Date.now();
    session.current = null;
    setSource(null);
    setTarget(null);
  }, []);

  useEffect(() => {
    clear();
    setAnnouncement('');
  }, [options.workspaceId, options.identity, options.split, options.disabled, options.direction, clear]);

  useEffect(() => {
    if (!source) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
    };
    const end = () => clear();
    window.addEventListener('keydown', cancel, true);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('keydown', cancel, true);
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
      window.removeEventListener('blur', end);
    };
  }, [source, clear]);

  const swapLabel = options.direction === 'horizontal'
    ? t('交换上下 PDF', 'Swap top and bottom PDFs')
    : t('交换左右 PDF', 'Swap left and right PDFs');
  const dragLabel = options.direction === 'horizontal'
    ? t('拖到另一阅读区交换上下 PDF，或点击交换', 'Drag to the other pane, or click to swap top and bottom PDFs')
    : t('拖到另一阅读区交换左右 PDF，或点击交换', 'Drag to the other pane, or click to swap left and right PDFs');
  const dropLabel = t('松开以交换两个 PDF', 'Drop to swap the two PDFs');

  const start = (event: DragEvent<HTMLElement>, side: PaneSide) => {
    const config = current.current;
    const element = event.target instanceof Element ? event.target : null;
    const control = element?.closest('button, select, input, textarea, a, [contenteditable="true"]');
    if (control && !control.hasAttribute('data-pane-swap-handle')) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    if (!config.split || config.disabled || !config.workspaceId || !config.identity) {
      event.preventDefault();
      return;
    }
    const next: PaneSwapSession = {
      version: 1, workspaceId: config.workspaceId, identity: config.identity, from: side,
      token: crypto.randomUUID(),
    };
    try {
      event.dataTransfer.setData(PANE_SWAP_MIME, JSON.stringify(next));
      event.dataTransfer.effectAllowed = 'move';
    } catch {
      event.preventDefault();
      clear();
      return;
    }
    session.current = next;
    setSource(side);
    setTarget(null);
    setAnnouncement(t('拖到另一个 PDF 阅读区，松开即可交换位置', 'Drag to the other PDF pane and release to swap positions'));
  };

  const over = (event: DragEvent<HTMLElement>, side: PaneSide) => {
    if (!isPaneSwapTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const allowed = canDropPaneSwap(session.current, current.current, side);
    event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
    setTarget(allowed ? side : null);
  };

  const paneProps = (side: PaneSide): PaneProps => ({
    'data-pane-swap-source': source === side ? 'true' : undefined,
    'data-pane-swap-target': target === side ? 'true' : undefined,
    'data-pane-swap-label': dropLabel,
    onDragEnterCapture: event => over(event, side),
    onDragOverCapture: event => over(event, side),
    onDragLeaveCapture: event => {
      if (!isPaneSwapTransfer(event.dataTransfer)) return;
      event.stopPropagation();
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setTarget(previous => previous === side ? null : previous);
    },
    onDropCapture: event => {
      if (!isPaneSwapTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const active = session.current;
      let payload: PaneSwapSession | null = null;
      try { payload = parsePaneSwapSession(event.dataTransfer.getData(PANE_SWAP_MIME)); } catch { /* Invalid local drag data. */ }
      const allowed = matchesPaneSwapSession(payload, active) && canDropPaneSwap(active, current.current, side);
      clear();
      if (allowed && active) {
        setAnnouncement(t('正在交换 PDF 阅读区', 'Swapping PDF panes'));
        current.current.onSwap(active.from);
      }
    },
  });

  const tabProps = (side: PaneSide): HTMLAttributes<HTMLElement> => ({
    draggable: enabled,
    onDragStart: event => start(event, side),
    onDragEnd: event => { event.stopPropagation(); clear(); },
  });

  const handleProps = (side: PaneSide): HandleProps => ({
    type: 'button',
    className: 'pane-swap-handle',
    'data-pane-swap-handle': 'true',
    'aria-label': swapLabel,
    title: dragLabel,
    disabled: !enabled,
    draggable: enabled,
    onDragStart: event => start(event, side),
    onDragEnd: event => { event.stopPropagation(); clear(); },
    onClick: event => {
      event.stopPropagation();
      if (!current.current.split || current.current.disabled || !current.current.workspaceId
        || !current.current.identity || (event.detail !== 0 && Date.now() - lastDragEnd.current < 200)) return;
      current.current.onSwap(side);
    },
  });

  return { paneProps, tabProps, handleProps, announcement };
}
