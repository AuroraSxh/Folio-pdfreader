import { memo, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { safeWebSourceUrl } from '../../shared/web-search';
import { useI18n } from '../i18n';
import { webSourceDomain, webSourcePopoverBounds, type WebSourceCitationMatch } from './web-source-utils';
import './web-source-citation.css';

export { findWebSourceCitation } from './web-source-utils';
export type { WebSourceCitationMatch } from './web-source-utils';

/** A native top-layer popover avoids scroll clipping while retaining the
 * assistant's theme variables. The source URL is opened only by the inner link.
 */
export const WebSourceCitation = memo(function WebSourceCitation({ citation, onError }: {
  citation: WebSourceCitationMatch; onError: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const { source, index } = citation;
  const url = safeWebSourceUrl(source.url);
  const domain = url ? webSourceDomain(url) : '';
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLSpanElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pointerWasOpen = useRef(false);
  const id = useId();
  const close = useCallback((restoreFocus = false) => {
    const popup = popupRef.current;
    if (popup?.matches(':popover-open')) popup.hidePopover();
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!open || !url) return;
    const popup = popupRef.current, button = buttonRef.current;
    if (!popup || !button) return;
    const panel = button.closest('.fl-assistant') ?? button.closest('.assistant-shell');
    const position = () => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const panelBounds = panel?.getBoundingClientRect() ?? { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
      const anchor = button.getBoundingClientRect();
      const initial = webSourcePopoverBounds(anchor, panelBounds, viewport);
      Object.assign(popup.style, { width: `${initial.width}px`, maxHeight: `${initial.maxHeight}px` });
      const final = webSourcePopoverBounds(anchor, panelBounds, viewport, popup.getBoundingClientRect().height);
      Object.assign(popup.style, { left: `${final.left}px`, top: `${final.top}px` });
    };
    popup.showPopover();
    position();
    closeRef.current?.focus({ preventScroll: true });
    const dismiss = () => close();
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popup.contains(event.target)) close(); };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    const observer = new ResizeObserver(position);
    if (panel) observer.observe(panel);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
      observer.disconnect();
    };
  }, [open, url, close]);

  if (!url || !Number.isInteger(index) || index < 1) return null;
  const openExternal = () => {
    const safe = safeWebSourceUrl(source.url);
    if (safe) void window.folio.openExternal(safe).catch(cause => onError(cause instanceof Error ? cause.message : String(cause)));
  };
  return <span className="fl-web-citation" onClick={event => event.stopPropagation()} onBlur={event => {
    if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close();
  }}>
    <button ref={buttonRef} type="button" className="fl-web-citation-chip" data-web-source-index={index}
      aria-label={t('查看网页来源 {number}：{domain}', 'View web source {number}: {domain}', { number: index, domain })}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onPointerDown={() => { pointerWasOpen.current = open; }}
      onClick={event => { if (event.detail > 0 ? pointerWasOpen.current : open) close(); else setOpen(true); pointerWasOpen.current = false; }}>
      <span className="fl-web-citation-number">{index}</span><span className="fl-web-citation-domain">{domain}</span>
    </button>
    {open && <span ref={popupRef} id={id} popover="auto" className="fl-web-citation-popover" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`}
      onToggle={event => { if ((event.nativeEvent as ToggleEvent).newState === 'closed') setOpen(false); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}>
      <span className="fl-web-citation-heading"><span>{t('网页来源 {number}', 'Web source {number}', { number: index })}</span><button ref={closeRef} type="button" aria-label={t('关闭网页来源', 'Close web source')} onClick={() => close(true)}><X size={14} aria-hidden="true" /></button></span>
      <strong id={`${id}-title`} className="fl-web-citation-title">{source.title}</strong>
      <span className="fl-web-citation-meta">{domain}{source.publishedAt && <> · {new Date(source.publishedAt).toLocaleDateString(locale)}</>}</span>
      {source.snippet && <span className="fl-web-citation-snippet">{source.snippet}</span>}
      <a className="fl-web-citation-open" href={url} rel="noreferrer noopener" title={url}
        onClick={event => { event.preventDefault(); openExternal(); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); openExternal(); } }}>
        <span>{t('打开网页', 'Open webpage')}</span><ExternalLink size={13} aria-hidden="true" /><small>{url}</small>
      </a>
    </span>}
  </span>;
});
