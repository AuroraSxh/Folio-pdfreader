import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AnnotationEditorType, AnnotationMode, PasswordResponses, type PDFDocumentProxy, type PDFDocumentLoadingTask } from 'pdfjs-dist';
import { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookmarkPlus, Check, ChevronDown, ChevronLeft, ChevronRight, Columns2, Copy, Download, FileText, Highlighter, ListTree, LoaderCircle, LockKeyhole, MessageSquare, Minus, MousePointer2, MoveVertical, PanelLeft, Plus, Printer, RotateCw, Rows2, Search, Settings2, Sparkles, StickyNote, Strikethrough, Trash2, Underline, X } from 'lucide-react';
import type { Annotation, DocumentIndex, OutlineItem, PaperDocument, Settings, TextSelection, ViewState } from '../../shared/types';
import { changeOutline, locateOutline } from '../pdf/outline';
import { hasPdfIndex, loadPdf, readSharedPdfIndex } from '../pdf/documentIndex';
import { markupRect, viewportRectPercent, type MarkupKind } from '../pdf/markupGeometry';
import { beginAnnotationWrite, isAnnotationSaving, subscribeAnnotationWrites } from '../pdf/annotationWrites';
import { hasPrimaryModifier, shortcutLabel } from '../platform';
import { useI18n } from '../i18n';
import 'pdfjs-dist/web/pdf_viewer.css';
import './pdf-pane.css';

interface PdfPaneProps {
  workspaceId: string;
  document: PaperDocument;
  readingTheme: Settings['readingTheme'];
  annotationToolbar?: Settings['annotationToolbar'];
  annotationToolbarHost?: HTMLElement | null;
  annotationTool?: { color: string; armed: boolean; kind?: MarkupKind };
  onAnnotationToolChange?: (patch: Partial<{ color: string; armed: boolean; kind?: MarkupKind }>) => void;
  onAnnotationToolbarChange?: (mode: 'floating' | 'fixed') => void;
  active: boolean;
  editBusy?: boolean;
  navigation?: { page: number; nonce: number };
  onActivate: () => void;
  onDocumentPatch: (patch: Partial<Pick<PaperDocument, 'name' | 'role' | 'outline' | 'annotations' | 'view'>>) => void | Promise<void>;
  onIndexed: (index: DocumentIndex) => void;
  onSelection: (selection: TextSelection) => void;
  onAsk: (selection: TextSelection) => void;
  onSplit?: (direction: 'vertical' | 'horizontal' | 'none') => void;
  onError: (message: string) => void;
}

type SelectionBundle = { parts: TextSelection[]; text: string };
type SidebarTab = 'outline' | 'thumbnails' | 'annotations';
const COLORS = ['#f5ce65', '#a7d7b8', '#a7c7f1', '#d0b5e7', '#efaeb8'];
const COLOR_NAMES = [['黄色', 'Yellow'], ['绿色', 'Green'], ['蓝色', 'Blue'], ['紫色', 'Purple'], ['粉色', 'Pink']] as const;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const submitPatch = (callback: PdfPaneProps['onDocumentPatch'], patch: Parameters<PdfPaneProps['onDocumentPatch']>[0]) => {
  // App reports persistence errors. Consume its rethrow for ordinary UI actions;
  // the native-close flush deliberately returns that failure to the close guard.
  void Promise.resolve().then(() => callback(patch)).catch(() => {});
};

const Thumbnail = memo(function Thumbnail({ pdf, page, selected, onClick }: { pdf: PDFDocumentProxy; page: number; selected: boolean; onClick: () => void }) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!buttonRef.current) return;
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { root: buttonRef.current.closest('.pdf-sidebar-scroll'), rootMargin: '120px' });
    observer.observe(buttonRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) {
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; }
      return;
    }
    let cancelled = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    void (async () => {
      const pdfPage = await pdf.getPage(page);
      if (cancelled || !canvasRef.current) return;
      const scale = 136 / pdfPage.getViewport({ scale: 1 }).width;
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      task = pdfPage.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0], annotationMode: AnnotationMode.ENABLE });
      await task.promise;
    })().catch(error => { if (!cancelled && error?.name !== 'RenderingCancelledException') setFailed(true); });
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, page, visible]);
  return <button ref={buttonRef} className={`pdf-thumbnail ${selected ? 'is-current' : ''}`} onClick={onClick} title={t('前往第 {page} 页', 'Go to page {page}', { page })} aria-label={t('第 {page} 页缩略图', 'Page {page} thumbnail', { page })}>
    <span className="pdf-thumbnail-paper">{failed ? <FileText size={24} /> : <canvas ref={canvasRef} />}</span>
    <span>{page}</span>
  </button>;
}, (previous, next) => previous.pdf === next.pdf && previous.page === next.page && previous.selected === next.selected);

function OutlineTree({ items, selected, onSelect, collapsed, onToggle, level = 0 }: {
  items: OutlineItem[]; selected: string | null; onSelect: (item: OutlineItem) => void;
  collapsed: Set<string>; onToggle: (id: string) => void; level?: number;
}) {
  const { t } = useI18n();
  return <ul className="pdf-outline-tree" role={level ? 'group' : 'tree'}>{items.map(item => <li key={item.id} role="treeitem" aria-selected={selected === item.id} aria-expanded={item.children.length ? !collapsed.has(item.id) : undefined}>
    <div className={`pdf-outline-row ${selected === item.id ? 'is-selected' : ''}`} style={{ paddingLeft: `${8 + level * 13}px` }}>
      {item.children.length ? <button className="pdf-icon-button pdf-outline-toggle" title={collapsed.has(item.id) ? t("展开章节", "Expand section") : t("折叠章节", "Collapse section")} onClick={() => onToggle(item.id)}>{collapsed.has(item.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button> : <span className="pdf-outline-spacer" />}
      <button className="pdf-outline-link" title={t('{title} · 第 {page} 页', '{title} · Page {page}', { title: item.title, page: item.page })} onClick={() => onSelect(item)}><span>{item.title}</span><small>{item.page}</small></button>
    </div>
    {!!item.children.length && !collapsed.has(item.id) && <OutlineTree items={item.children} selected={selected} onSelect={onSelect} collapsed={collapsed} onToggle={onToggle} level={level + 1} />}
  </li>)}</ul>;
}

export default function PdfPane(props: PdfPaneProps) {
  const { t, locale } = useI18n();
  const MARKUP_TOOLS = [
    { kind: 'highlight', label: t('荧光笔', 'Highlighter'), menuLabel: t('荧光高亮', 'Highlight'), Icon: Highlighter },
    { kind: 'underline', label: t('下划线', 'Underline'), menuLabel: t('下划线', 'Underline'), Icon: Underline },
    { kind: 'strikeout', label: t('删除线', 'Strikethrough'), menuLabel: t('删除线', 'Strikethrough'), Icon: Strikethrough },
  ] as const;
  const { workspaceId, document: paper, readingTheme, annotationToolbar = 'floating', active, navigation } = props;
  const annotationWriteKey = `${workspaceId}:${paper.id}`;
  const annotationSaving = useSyncExternalStore(subscribeAnnotationWrites, () => isAnnotationSaving(annotationWriteKey));
  const annotationBusy = annotationSaving || !!props.editBusy;
  const latest = useRef({ ...props, t, locale });
  latest.current = { ...props, t, locale };
  const paneRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerElementRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const busRef = useRef<EventBus | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const annotationInputRef = useRef<HTMLTextAreaElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const captureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viewPending = useRef<ViewState | null>(null);
  const annotationGroups = useRef<{ source?: Annotation[]; pages: Map<number, { items: Annotation[]; signature: string }> }>({ pages: new Map() });
  const annotationLayers = useRef(new WeakMap<HTMLElement, { signature: string; rotation: number; locale: string; layer: HTMLElement }>());
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(paper.pageCount);
  const [page, setPage] = useState(paper.view.page);
  const [pageInput, setPageInput] = useState(String(paper.view.page));
  const [scale, setScale] = useState(paper.view.scale);
  const [scalePercent, setScalePercent] = useState(100);
  const [scrollMode, setScrollMode] = useState(paper.view.scrollMode);
  const [spreadMode, setSpreadMode] = useState(paper.view.spreadMode);
  const [status, setStatus] = useState<'opening' | 'unlocking' | 'password' | ''>('opening');
  const [failure, setFailure] = useState<{ message: string; name?: string; cancelled?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState(0);
  const [sidebar, setSidebar] = useState<SidebarTab | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matches, setMatches] = useState({ current: 0, total: 0 });
  const [findPending, setFindPending] = useState(false);
  const [outline, setOutline] = useState(paper.outline);
  const [outlineSelection, setOutlineSelection] = useState<string | null>(null);
  const [outlineTitle, setOutlineTitle] = useState('');
  const [outlinePage, setOutlinePage] = useState('1');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<SelectionBundle | null>(null);
  const [annotationId, setAnnotationId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [annotationKindDraft, setAnnotationKindDraft] = useState<MarkupKind>('highlight');
  const [annotationColorDraft, setAnnotationColorDraft] = useState(COLORS[0]);
  const [newComment, setNewComment] = useState(false);
  const [localHighlightColor, setLocalHighlightColor] = useState(COLORS[0]);
  const [localHighlightArmed, setLocalHighlightArmed] = useState(false);
  const [localMarkupKind, setLocalMarkupKind] = useState<MarkupKind>('highlight');
  const highlightColor = props.annotationTool?.color ?? localHighlightColor;
  const highlightArmed = props.annotationTool?.armed ?? localHighlightArmed;
  const markupKind = props.annotationTool?.kind ?? localMarkupKind;
  const sharedToolbar = Object.hasOwn(props, 'annotationToolbarHost');
  const setHighlightColor = (color: string) => props.onAnnotationToolChange ? props.onAnnotationToolChange({ color }) : setLocalHighlightColor(color);
  const setHighlightArmed = (armed: boolean) => props.onAnnotationToolChange ? props.onAnnotationToolChange({ armed }) : setLocalHighlightArmed(armed);
  const [passwordRequest, setPasswordRequest] = useState<{ update: (password: string) => void; cancel: () => void; incorrect: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string; selection: SelectionBundle | null; annotationId: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const submitAnnotations = (annotations: Annotation[]) => {
    if (latest.current.editBusy) return false;
    const callback = latest.current.onDocumentPatch;
    return beginAnnotationWrite(annotationWriteKey, () => callback({ annotations }));
  };

  const selectedText = useCallback(() => {
    const range = window.getSelection();
    if (!range || range.isCollapsed || !range.rangeCount || !containerRef.current?.contains(range.anchorNode) || !containerRef.current.contains(range.focusNode)) return '';
    return range.toString();
  }, []);

  const copyText = async (text: string) => {
    if (!text.trim()) return;
    try {
      await window.folio.copyText(text);
      if (!mounted.current) return;
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch (error) { latest.current.onError(latest.current.t('无法复制文字：{error}', 'Unable to copy text: {error}', { error: messageOf(error) })); }
  };

  const annotationAtPointer = (clientX: number, clientY: number, target: EventTarget | null) => {
    const element = target instanceof Element ? target : null;
    const annotations = latest.current.document.annotations;
    const pin = element?.closest<HTMLElement>('.folio-comment-pin[data-annotation-id]');
    if (pin && containerRef.current?.contains(pin)) return annotations.find(item => item.id === pin.dataset.annotationId)?.id ?? null;
    // Only hit-test at context-menu time. Markup stays pointer-transparent so
    // selecting/copying PDF text retains normal browser behavior.
    const pageElement = element?.closest<HTMLElement>('.page');
    if ((!clientX && !clientY) || !pageElement || !containerRef.current?.contains(pageElement)) return null;
    const pageNumber = Number(pageElement.dataset.pageNumber);
    const pageView = viewerRef.current?.getPageView(pageNumber - 1);
    if (!pageView?.viewport || !pageElement.clientWidth || !pageElement.clientHeight) return null;
    const bounds = pageElement.getBoundingClientRect();
    const [x, y] = pageView.viewport.convertToPdfPoint(
      (clientX - bounds.left - pageElement.clientLeft) * pageView.viewport.width / pageElement.clientWidth,
      (clientY - bounds.top - pageElement.clientTop) * pageView.viewport.height / pageElement.clientHeight,
    );
    // Last-painted annotation wins if a passage has overlapping marks.
    for (let index = annotations.length - 1; index >= 0; index--) {
      const item = annotations[index];
      if (item.page === pageNumber && item.rects.some(rect => rect.length === 4 && rect.every(Number.isFinite)
        && x >= Math.min(rect[0], rect[2]) && x <= Math.max(rect[0], rect[2])
        && y >= Math.min(rect[1], rect[3]) && y <= Math.max(rect[1], rect[3]))) return item.id;
    }
    return null;
  };

  const openContextMenu = (clientX: number, clientY: number, target: EventTarget | null) => {
    clearTimeout(captureTimer.current);
    props.onActivate();
    const bounds = target instanceof Element && target.closest('.folio-comment-pin')
      ? target.closest('.folio-comment-pin')!.getBoundingClientRect() : containerRef.current?.getBoundingClientRect();
    const x = clientX || (bounds?.left ?? 0) + 24;
    const y = clientY || (bounds?.top ?? 0) + 24;
    setContextMenu({ x, y, text: selectedText(), selection: readSelection(), annotationId: annotationAtPointer(clientX, clientY, target) });
    setOptionsOpen(false);
  };

  const closeContextMenu = (restoreFocus = false) => {
    setContextMenu(null);
    if (restoreFocus) containerRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(copyTimer.current); clearTimeout(captureTimer.current); };
  }, []);

  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!menu || !contextMenu) return;
    const bounds = menu.getBoundingClientRect();
    const x = clamp(contextMenu.x, 8, Math.max(8, window.innerWidth - bounds.width - 8));
    const y = clamp(contextMenu.y, 8, Math.max(8, window.innerHeight - bounds.height - 8));
    if (x !== contextMenu.x || y !== contextMenu.y) setContextMenu(previous => previous ? { ...previous, x, y } : null);
    if (!menu.contains(window.document.activeElement)) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [contextMenu, locale]);

  const hasContextMenu = !!contextMenu;
  useEffect(() => {
    if (!hasContextMenu) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const dismiss = () => setContextMenu(null);
    window.addEventListener('pointerdown', dismissOutside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('pointerdown', dismissOutside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [hasContextMenu]);

  useEffect(() => {
    if (!selection || newComment) return;
    const clearLostSelection = () => { if (!selectedText()) setSelection(null); };
    window.document.addEventListener('selectionchange', clearLostSelection);
    return () => window.document.removeEventListener('selectionchange', clearLostSelection);
  }, [selection, newComment, selectedText]);

  const goToPage = useCallback((target: number) => {
    const viewer = viewerRef.current;
    if (viewer?.pagesCount && Number.isFinite(target)) viewer.currentPageNumber = clamp(Math.round(target), 1, viewer.pagesCount);
  }, []);

  const openAnnotation = useCallback((annotation: Annotation) => {
    setAnnotationId(annotation.id); setCommentDraft(annotation.comment); setAnnotationKindDraft(annotation.kind ?? 'highlight'); setAnnotationColorDraft(annotation.color); setNewComment(false); setSidebar('annotations');
  }, []);

  const updatePageLabels = useCallback(() => {
    viewerElementRef.current?.querySelectorAll<HTMLElement>('.page[data-page-number]').forEach(element => {
      // Page labels belong to the application UI; PDF text and metadata remain untouched.
      // Remove PDF.js's English-only fallback marker before its localization observer runs.
      element.removeAttribute('data-l10n-id');
      element.removeAttribute('data-l10n-args');
      element.setAttribute('aria-label', latest.current.t('第 {page} 页', 'Page {page}', { page: element.dataset.pageNumber || '' }));
    });
  }, []);

  const renderAnnotations = useCallback((onlyPage?: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const { t, locale } = latest.current;
    const labelPin = (button: HTMLButtonElement, annotation: Annotation) => {
      const label = annotation.comment || t('查看标记笔记', 'View annotation');
      button.title = t('{comment}（右键可编辑或删除批注）', '{comment} (right-click to edit or delete annotation)', { comment: label });
      button.setAttribute('aria-label', label);
    };
    const annotations = latest.current.document.annotations;
    if (annotationGroups.current.source !== annotations) {
      const pages = new Map<number, { items: Annotation[]; signature: string }>();
      for (const annotation of annotations) {
        let group = pages.get(annotation.page);
        if (!group) { group = { items: [], signature: '' }; pages.set(annotation.page, group); }
        group.items.push(annotation);
      }
      for (const group of pages.values()) group.signature = JSON.stringify(group.items);
      annotationGroups.current = { source: annotations, pages };
    }
    const views = onlyPage ? [viewer.getPageView(onlyPage - 1)] : [...viewer.getCachedPageViews()];
    for (const pageView of views) {
      if (!pageView?.div || !pageView.viewport) continue;
      const group = annotationGroups.current.pages.get(pageView.id);
      const cached = annotationLayers.current.get(pageView.div);
      if (!group) { cached?.layer.remove(); annotationLayers.current.delete(pageView.div); continue; }
      // Percentage rectangles scale with the page; zooming doesn't require rebuilding them.
      if (cached?.signature === group.signature && cached.rotation === pageView.viewport.rotation && cached.layer.parentElement === pageView.div) {
        // Switching the interface language only changes labels, not page canvases or marks.
        if (cached.locale !== locale) {
          const byId = new Map(group.items.map(annotation => [annotation.id, annotation]));
          cached.layer.querySelectorAll<HTMLButtonElement>('.folio-comment-pin').forEach(button => {
            const annotation = byId.get(button.dataset.annotationId || '');
            if (annotation) labelPin(button, annotation);
          });
          cached.locale = locale;
        }
        continue;
      }
      cached?.layer.remove();
      const layer = window.document.createElement('div');
      layer.className = 'folio-annotation-layer';
      for (const annotation of group.items) {
        annotation.rects.forEach((rect, index) => {
          const geometry = markupRect(rect, annotation.kind ?? 'highlight');
          if (!geometry) return;
          const [x1, y1] = pageView.viewport.convertToViewportPoint(rect[0], rect[1]);
          const [x2, y2] = pageView.viewport.convertToViewportPoint(rect[2], rect[3]);
          const mark = window.document.createElement('span');
          mark.className = `folio-markup folio-${annotation.kind ?? 'highlight'}`;
          mark.dataset.annotationId = annotation.id;
          const position = viewportRectPercent(geometry, pageView.viewport);
          Object.assign(mark.style, { left: `${position.left}%`, top: `${position.top}%`, width: `${position.width}%`, height: `${position.height}%`, backgroundColor: annotation.color });
          layer.append(mark);
          if (index === 0) {
            const button = window.document.createElement('button');
            button.className = 'folio-comment-pin';
            button.dataset.annotationId = annotation.id;
            labelPin(button, annotation);
            button.textContent = annotation.comment ? '●' : '·';
            Object.assign(button.style, { left: `${100 * Math.max(x1, x2) / pageView.viewport.width}%`, top: `${100 * Math.min(y1, y2) / pageView.viewport.height}%`, backgroundColor: annotation.color });
            button.addEventListener('click', () => openAnnotation(annotation));
            layer.append(button);
          }
        });
      }
      pageView.div.append(layer);
      annotationLayers.current.set(pageView.div, { signature: group.signature, rotation: pageView.viewport.rotation, locale, layer });
    }
  }, [openAnnotation]);

  useEffect(() => { setOutline(paper.outline); }, [paper.outline]);
  useEffect(() => { renderAnnotations(); }, [paper.annotations, renderAnnotations, locale]);
  useEffect(() => { updatePageLabels(); }, [locale, updatePageLabels]);

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerElementRef.current;
    if (!container || !viewerElement) return;
    // PDF.js also writes this variable on :root; keep unequal split panes independent.
    container.style.setProperty('--viewer-container-height', `${container.clientHeight}px`);
    let disposed = false;
    let ready = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    const abortController = new AbortController();
    const initial = latest.current.document.view;
    const patchThisDocument = latest.current.onDocumentPatch;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer', ignoreDestinationZoom: true });
    const findController = new PDFFindController({ eventBus, linkService });
    // PDF.js supports abortSignal at runtime; its 6.3 declaration currently omits it.
    const viewerOptions = { container, viewer: viewerElement, eventBus, linkService, findController, textLayerMode: 1, annotationMode: AnnotationMode.ENABLE, annotationEditorMode: AnnotationEditorType.DISABLE, enableSelectionRendering: false, enableAutoLinking: true, maxCanvasPixels: 4_194_304, maxCanvasDim: 8192, capCanvasAreaFactor: 0, enableDetailCanvas: true, abortSignal: abortController.signal };
    const viewer = new PDFViewer(viewerOptions);
    linkService.setViewer(viewer);
    viewerRef.current = viewer;
    busRef.current = eventBus;
    setPdf(null); setFailure(null); setStatus('opening'); setPageCount(0); setSelection(null); setLocalHighlightArmed(false); setNewComment(false); setPasswordRequest(null); setOutlineSelection(null); setAnnotationId(null); setSearch(''); setMatches({ current: 0, total: 0 }); setIndexing(false); setContextMenu(null); setCopied(false);

    let lastViewKey = JSON.stringify(initial);
    const viewWrites = new Set<Promise<void>>();
    const saveView = (view: ViewState) => {
      const request = Promise.resolve().then(() => patchThisDocument({ view })).catch(error => {
        if (!disposed && !viewPending.current) viewPending.current = view;
        throw error;
      });
      viewWrites.add(request);
      void request.finally(() => viewWrites.delete(request)).catch(() => {});
      return request;
    };
    const persist = () => {
      if (!ready || disposed) return;
      const view = { page: viewer.currentPageNumber, scale: viewer.currentScaleValue || 'page-width', rotation: viewer.pagesRotation, scrollMode: viewer.scrollMode, spreadMode: viewer.spreadMode };
      const key = JSON.stringify(view);
      if (lastViewKey === key) return;
      lastViewKey = key;
      viewPending.current = view;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => { viewPending.current = null; if (!disposed) void saveView(view).catch(() => {}); }, 450);
    };
    window.addEventListener('folio:flush-notes', event => {
      if (disposed) return;
      const view = viewPending.current;
      clearTimeout(saveTimer.current);
      viewPending.current = null;
      if (view) void saveView(view).catch(() => {});
      const pending = (event as CustomEvent<Promise<void>[]>).detail;
      if (Array.isArray(pending)) pending.push(...viewWrites);
    }, { signal: abortController.signal });
    const onPage = ({ pageNumber }: { pageNumber: number }) => { if (disposed) return; setPage(pageNumber); setPageInput(String(pageNumber)); persist(); };
    const onScale = ({ scale: zoom, presetValue }: { scale: number; presetValue?: string }) => { if (disposed) return; setScale(presetValue || String(zoom)); setScalePercent(Math.round(zoom * 100)); persist(); };
    const onScrollMode = ({ mode }: { mode: number }) => { setScrollMode(mode); persist(); };
    const onSpreadMode = ({ mode }: { mode: number }) => { setSpreadMode(mode); persist(); };
    eventBus.on('pagechanging', onPage);
    eventBus.on('scalechanging', onScale);
    eventBus.on('rotationchanging', () => { persist(); requestAnimationFrame(() => !disposed && renderAnnotations()); });
    eventBus.on('scrollmodechanged', onScrollMode);
    eventBus.on('spreadmodechanged', onSpreadMode);
    eventBus.on('pagerendered', ({ pageNumber, error }: { pageNumber: number; error?: Error }) => {
      if (!disposed) { renderAnnotations(pageNumber); if (error) latest.current.onError(latest.current.t('第 {page} 页渲染失败：{error}', 'Unable to render page {page}: {error}', { page: pageNumber, error: error.message })); }
    });
    const updateMatches = (next: { current: number; total: number }) => setMatches(previous => previous.current === next.current && previous.total === next.total ? previous : next);
    eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => { if (!disposed) updateMatches(matchesCount); });
    eventBus.on('updatefindcontrolstate', ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => { if (!disposed) { setFindPending(state === 3); updateMatches(matchesCount); } });
    eventBus.on('pagesinit', () => {
      if (disposed) return;
      updatePageLabels();
      viewer.scrollMode = [0, 1, 2, 3].includes(initial.scrollMode) ? initial.scrollMode : 0;
      viewer.spreadMode = [0, 1, 2].includes(initial.spreadMode) ? initial.spreadMode : 0;
      viewer.pagesRotation = [0, 90, 180, 270].includes(initial.rotation) ? initial.rotation : 0;
      viewer.currentScaleValue = initial.scale || 'page-width';
      viewer.currentPageNumber = clamp(latest.current.navigation?.page || initial.page || 1, 1, viewer.pagesCount);
      ready = true;
      setStatus('');
      viewer.update();
    });
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastWidth = container.clientWidth, lastHeight = container.clientHeight;
    const resize = new ResizeObserver(() => {
      const width = container.clientWidth, height = container.clientHeight;
      if (width === lastWidth && height === lastHeight) return;
      if (height !== lastHeight) container.style.setProperty('--viewer-container-height', `${height}px`);
      lastWidth = width; lastHeight = height;
      if (!ready || disposed) return;
      clearTimeout(resizeTimer);
      // Resizing a divider/window produces many events. Render once after it settles.
      resizeTimer = setTimeout(() => {
        if (!ready || disposed) return;
        if (['page-width', 'page-fit', 'auto'].includes(viewer.currentScaleValue)) viewer.currentScaleValue = viewer.currentScaleValue;
        else viewer.update();
      }, 140);
    });
    resize.observe(container);

    let pinchFrame = 0;
    let pinchDelta = 0;
    let pinchClientX = 0, pinchClientY = 0;
    const applyPinch = () => {
      pinchFrame = 0;
      if (!ready || disposed) { pinchDelta = 0; return; }
      const scaleFactor = clamp(Math.exp(-pinchDelta * 0.01), 0.5, 2);
      pinchDelta = 0;
      const bounds = container.getBoundingClientRect();
      // PDFViewer's origin uses its offset-parent coordinates, not window coordinates.
      const origin = [pinchClientX - bounds.left + container.offsetLeft, pinchClientY - bounds.top + container.offsetTop];
      if (!latest.current.active) latest.current.onActivate();
      // Reuse the existing bitmap during the gesture; draw sharply after it settles.
      viewer.updateScale({ scaleFactor, origin, drawingDelay: 160 });
    };
    container.addEventListener('wheel', event => {
      // Chromium represents native macOS trackpad pinch as Ctrl+wheel. Ordinary
      // two-finger scrolling has no Ctrl modifier and retains its native behavior.
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!ready || disposed || !Number.isFinite(event.deltaY)) return;
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1;
      pinchDelta += event.deltaY * multiplier;
      pinchClientX = event.clientX; pinchClientY = event.clientY;
      if (!pinchFrame) pinchFrame = requestAnimationFrame(applyPinch);
    }, { passive: false, signal: abortController.signal });

    void (async () => {
      const bytes = await window.folio.readDocument(workspaceId, paper.id);
      if (disposed) return;
      loadingTask = loadPdf(bytes);
      loadingTask.onPassword = (update: (password: string) => void, reason: number) => {
        if (disposed) return;
        setStatus('password'); setPassword('');
        setPasswordRequest({ update, incorrect: reason === PasswordResponses.INCORRECT_PASSWORD, cancel: () => { setPasswordRequest(null); setStatus(''); setFailure({ message: '', cancelled: true }); void loadingTask?.destroy(); } });
      };
      const loaded = await loadingTask.promise;
      if (disposed) { await loadingTask.destroy(); return; }
      setPasswordRequest(null); setPdf(loaded); setPageCount(loaded.numPages);
      linkService.setDocument(loaded);
      viewer.setDocument(loaded);
      // Imported originals are immutable; their durable full-text index remains valid.
      if (hasPdfIndex(latest.current.document)) return;
      setIndexing(true); setIndexProgress(0);
      const index = await readSharedPdfIndex(`${workspaceId}:${paper.id}`, loaded, {
        outline: latest.current.document.outlineLoaded ? latest.current.document.outline : undefined,
        isCancelled: () => disposed,
        onOutline: items => { if (!latest.current.document.outlineLoaded) setOutline(items); },
        onProgress: setIndexProgress,
      });
      if (disposed) return;
      latest.current.onIndexed(index);
      setIndexing(false);
    })().catch(error => {
      if (disposed) return;
      setIndexing(false);
      if (viewer.pdfDocument) { latest.current.onError(latest.current.t('PDF 已打开，但文章文字索引未完成：{error}', 'The PDF is open, but its text index is incomplete: {error}', { error: messageOf(error) })); return; }
      setStatus(''); setPasswordRequest(null); setFailure(previous => previous?.cancelled ? previous : { message: messageOf(error), name: error?.name });
    });
    return () => {
      disposed = true; ready = false;
      clearTimeout(saveTimer.current);
      clearTimeout(resizeTimer);
      if (pinchFrame) cancelAnimationFrame(pinchFrame);
      if (viewPending.current) { submitPatch(patchThisDocument, { view: viewPending.current }); viewPending.current = null; }
      resize.disconnect();
      abortController.abort();
      viewerRef.current = null; busRef.current = null;
      // Runtime accepts null to release page views, listeners, and render tasks.
      viewer.setDocument(null as unknown as PDFDocumentProxy);
      linkService.setDocument(null);
      void loadingTask?.destroy();
    };
  }, [workspaceId, paper.id, attempt, renderAnnotations, updatePageLabels]);

  useEffect(() => { if (navigation && pdf) goToPage(navigation.page); }, [navigation?.nonce, pdf, goToPage]);
  useEffect(() => { if (passwordRequest) requestAnimationFrame(() => passwordInputRef.current?.focus()); }, [passwordRequest]);

  const find = useCallback((type = '', previous = false) => {
    busRef.current?.dispatch('find', { source: searchRef.current, type, query: search, phraseSearch: true, caseSensitive, entireWord: wholeWord, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  }, [search, caseSensitive, wholeWord]);
  useEffect(() => { if (pdf && searchOpen) find(); }, [search, caseSensitive, wholeWord, pdf, searchOpen, find]);
  useEffect(() => {
    if (!searchOpen) { busRef.current?.dispatch('findbarclose', {}); return; }
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!event.shiftKey && hasPrimaryModifier(event) && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); }); return; }
      if (event.key === 'Escape') { setSearchOpen(false); setSelection(null); setHighlightArmed(false); setNewComment(false); setOptionsOpen(false); return; }
      if ((event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'PageDown') { event.preventDefault(); viewerRef.current?.nextPage(); }
      if (event.key === 'PageUp') { event.preventDefault(); viewerRef.current?.previousPage(); }
      if (event.key === 'Home') { event.preventDefault(); goToPage(1); }
      if (event.key === 'End') { event.preventDefault(); goToPage(pageCount); }
      if (hasPrimaryModifier(event) && (event.key === '+' || event.key === '=')) { event.preventDefault(); viewerRef.current?.increaseScale(); }
      if (hasPrimaryModifier(event) && event.key === '-') { event.preventDefault(); viewerRef.current?.decreaseScale(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, goToPage, pageCount]);

  const readSelection = (): SelectionBundle | null => {
    const selected = window.getSelection();
    const viewer = viewerRef.current;
    if (!mounted.current || !selected || !viewer || selected.isCollapsed || !selected.rangeCount || !containerRef.current?.contains(selected.anchorNode) || !containerRef.current.contains(selected.focusNode)) return null;
    const text = selected.toString().trim();
    if (!text) return null;
    const range = selected.getRangeAt(0);
    const parts: TextSelection[] = [];
    for (const pageElement of containerRef.current.querySelectorAll<HTMLElement>('.page')) {
      const textLayer = pageElement.querySelector('.textLayer');
      if (!textLayer || !range.intersectsNode(textLayer)) continue;
      const pageNumber = Number(pageElement.dataset.pageNumber);
      const pageView = viewer.getPageView(pageNumber - 1);
      if (!pageView?.viewport) continue;
      const clipped = range.cloneRange();
      if (!textLayer.contains(range.startContainer)) clipped.setStart(textLayer, 0);
      if (!textLayer.contains(range.endContainer)) clipped.setEnd(textLayer, textLayer.childNodes.length);
      const pageRect = pageElement.getBoundingClientRect();
      const factorX = pageElement.clientWidth / pageView.viewport.width;
      const factorY = pageElement.clientHeight / pageView.viewport.height;
      const rects: number[][] = [];
      const seen = new Set<string>();
      for (const rect of clipped.getClientRects()) {
        const left = Math.max(rect.left, pageRect.left + pageElement.clientLeft);
        const top = Math.max(rect.top, pageRect.top + pageElement.clientTop);
        const right = Math.min(rect.right, pageRect.right - pageElement.clientLeft);
        const bottom = Math.min(rect.bottom, pageRect.bottom - pageElement.clientTop);
        if (right - left < 1 || bottom - top < 1 || (right - left) * (bottom - top) > pageRect.width * pageRect.height * .3) continue;
        const first = pageView.viewport.convertToPdfPoint((left - pageRect.left - pageElement.clientLeft) / factorX, (top - pageRect.top - pageElement.clientTop) / factorY);
        const second = pageView.viewport.convertToPdfPoint((right - pageRect.left - pageElement.clientLeft) / factorX, (bottom - pageRect.top - pageElement.clientTop) / factorY);
        const normalized = [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[0], second[0]), Math.max(first[1], second[1])];
        const key = normalized.map(value => value.toFixed(1)).join(',');
        if (!seen.has(key)) { rects.push(normalized); seen.add(key); }
      }
      if (rects.length) parts.push({ documentId: paper.id, documentName: paper.name, page: pageNumber, text: clipped.toString().trim(), rects });
    }
    if (!parts.length) return null;
    return { parts, text };
  };

  const captureSelection = (applyArmedMarkup = false) => {
    clearTimeout(captureTimer.current);
    captureTimer.current = setTimeout(() => {
      if (!mounted.current) return;
      const bundle = readSelection();
      setSelection(bundle); setNewComment(false);
      if (!bundle) return;
      latest.current.onSelection({ ...bundle.parts[0], text: bundle.text });
      if (applyArmedMarkup && highlightArmed && !annotationBusy) saveMarkup(markupKind, '', bundle);
    }, 0);
  };

  const saveMarkup = (kind = markupKind, comment = '', bundle = selection) => {
    if (!bundle || annotationBusy) return;
    const additions: Annotation[] = bundle.parts.map((part, index) => ({ id: crypto.randomUUID(), kind, page: part.page, text: part.text, comment: index === 0 ? comment : '', color: highlightColor, rects: part.rects, createdAt: Date.now() }));
    if (!submitAnnotations([...latest.current.document.annotations, ...additions])) return;
    setSelection(null); setNewComment(false); window.getSelection()?.removeAllRanges();
    if (comment) { setSidebar('annotations'); setAnnotationId(additions[0].id); setCommentDraft(comment); setAnnotationKindDraft(kind); setAnnotationColorDraft(highlightColor); }
  };

  const startComment = (bundle: SelectionBundle | null) => {
    if (!bundle || annotationBusy) return;
    clearTimeout(captureTimer.current);
    props.onActivate();
    setSelection(bundle);
    setHighlightArmed(false);
    setAnnotationId(null);
    setCommentDraft('');
    setNewComment(true);
  };

  const deleteAnnotation = (id: string) => {
    const annotations = latest.current.document.annotations;
    if (annotationBusy || !annotations.some(item => item.id === id)) return;
    if (submitAnnotations(annotations.filter(item => item.id !== id)) && annotationId === id) setAnnotationId(null);
  };

  const chooseMarkup = (kind: MarkupKind) => {
    const armed = selection ? true : !(highlightArmed && markupKind === kind);
    if (props.onAnnotationToolChange) props.onAnnotationToolChange({ kind, armed });
    else { setLocalMarkupKind(kind); setLocalHighlightArmed(armed); }
    if (selection) saveMarkup(kind);
  };
  const saveOutline = (next: OutlineItem[]) => { if (latest.current.editBusy) return; setOutline(next); submitPatch(props.onDocumentPatch, { outline: next }); };
  const chooseOutline = (item: OutlineItem) => { setOutlineSelection(item.id); setOutlineTitle(item.title); setOutlinePage(String(item.page)); goToPage(item.page); };
  const addOutline = () => {
    if (latest.current.editBusy) return;
    const item: OutlineItem = { id: crypto.randomUUID(), title: t('第 {page} 页', 'Page {page}', { page }), page, children: [] };
    saveOutline([...outline, item]); chooseOutline(item);
  };
  const editOutline = () => {
    if (!outlineSelection || latest.current.editBusy) return;
    const next = structuredClone(outline);
    const found = locateOutline(next, outlineSelection);
    if (found) { found.siblings[found.index].title = outlineTitle.trim() || t("未命名章节", "Untitled section"); found.siblings[found.index].page = clamp(Number(outlinePage) || 1, 1, pageCount); saveOutline(next); }
  };
  const exportOrPrint = async (kind: 'export' | 'print') => {
    setBusy(kind);
    try {
      const viewer = viewerRef.current;
      if (viewer?.pagesCount) {
        clearTimeout(saveTimer.current);
        viewPending.current = null;
        await props.onDocumentPatch({ view: { page: viewer.currentPageNumber, scale: viewer.currentScaleValue, rotation: viewer.pagesRotation, scrollMode: viewer.scrollMode, spreadMode: viewer.spreadMode } });
      }
      if (kind === 'print') await window.folio.printPdf(workspaceId, paper.id);
      else await window.folio.exportPdf(workspaceId, paper.id);
    }
    catch (error) { latest.current.onError(kind === 'print'
      ? latest.current.t('打印 PDF 失败：{error}', 'Unable to print PDF: {error}', { error: messageOf(error) })
      : latest.current.t('导出 PDF 失败：{error}', 'Unable to export PDF: {error}', { error: messageOf(error) })); }
    finally { setBusy(null); }
  };
  const selectedOutline = outlineSelection ? locateOutline(outline, outlineSelection) : undefined;
  const selectedAnnotation = paper.annotations.find(item => item.id === annotationId);
  const contextAnnotation = paper.annotations.find(item => item.id === contextMenu?.annotationId);
  const annotationTools = (annotationToolbar !== 'selection' || selection) && <div className={`pdf-selection-tools pdf-annotation-tools-${annotationToolbar}${sharedToolbar ? ' pdf-annotation-tools-shared' : ''}`} role="toolbar" aria-label={t("文字与批注工具", "Text and annotation tools")} aria-busy={annotationBusy} onMouseDown={event => event.preventDefault()}>
    {newComment && selection ? <form onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); saveMarkup(markupKind, commentDraft); }}>
      <label>{t("给这段文字添加批注", "Add a comment to this passage")}<textarea autoFocus aria-label={t("新批注", "New comment")} value={commentDraft} onChange={event => setCommentDraft(event.target.value)} placeholder={t("你的想法、疑问或发现…", "Your thoughts, questions, or findings…")} /></label>
      <div><button type="button" className="pdf-text-button" onClick={() => { setNewComment(false); setSelection(null); setCommentDraft(''); }}>{t("取消", "Cancel")}</button><button className="pdf-text-button" disabled={annotationBusy}><Check size={14} />{t("保存", "Save")}</button></div>
    </form> : <>
      <button title={t("选择和复制文字，退出文字标记模式", "Select and copy text; exit markup mode")} aria-label={t("选择文字", "Select text")} aria-pressed={!highlightArmed} className={!highlightArmed ? 'is-on' : ''} disabled={!pdf} onClick={() => setHighlightArmed(false)}><MousePointer2 size={15} /></button>
      <div className="pdf-highlight-colors" role="group" aria-label={t("标记颜色", "Markup color")}>{COLORS.map((color, colorIndex) => <button key={color} style={{ backgroundColor: color }} className={highlightColor === color ? 'is-chosen' : ''} onClick={() => setHighlightColor(color)} title={t('高亮颜色 {color}', '{name} markup ({color})', { color, name: t(COLOR_NAMES[colorIndex][0], COLOR_NAMES[colorIndex][1]) })} aria-label={t('高亮颜色 {color}', '{name} markup ({color})', { color, name: t(COLOR_NAMES[colorIndex][0], COLOR_NAMES[colorIndex][1]) })} aria-pressed={highlightColor === color} />)}</div>
      {MARKUP_TOOLS.map(({ kind, label, Icon }) => {
        const chosen = highlightArmed && markupKind === kind;
        return <button key={kind} title={chosen ? t('{tool}已开启：选中文字自动标记，再点一次或按 Esc 退出', '{tool} is on: select text to mark it. Click again or press Esc to exit.', { tool: label }) : t('开启{tool}，然后选中文字；已有选中文字时立即标记', 'Turn on {tool}, then select text. Selected text is marked immediately.', { tool: label })} aria-label={label} aria-pressed={chosen} className={chosen ? 'is-on' : ''} disabled={!pdf || annotationBusy} onClick={() => chooseMarkup(kind)}><Icon size={15} />{label}</button>;
      })}
      <button title={t('复制选中文字（{shortcut}）', 'Copy selected text ({shortcut})', { shortcut: shortcutLabel('C') })} aria-label={t("复制选中文字", "Copy selected text")} disabled={!selection} onClick={() => void copyText(selectedText() || selection?.text || '')}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? t("已复制", "Copied") : t("复制", "Copy")}</button>
      <button title={selection ? t("给选中文字添加批注", "Add a comment to the selected text") : t("先选中文字，再添加批注", "Select text first to add a comment")} disabled={!selection || annotationBusy} onClick={() => startComment(selection)}><MessageSquare size={15} />{t("批注", "Comment")}</button>
      <button title={selection ? t("针对选中文字向 AI 提问", "Ask AI about the selected text") : t("先选中文字，再向 AI 提问", "Select text first to ask AI")} className="pdf-ask-button" disabled={!selection} onClick={() => { if (selection) props.onAsk({ ...selection.parts[0], text: selection.text }); }}><Sparkles size={15} />{t("问 AI", "Ask AI")}</button>
      <button title={annotationToolbar === 'fixed' ? t("移到页面底部悬浮", "Float at the bottom of the page") : t("固定到顶部栏", "Dock at the top")} aria-label={t("切换工具栏位置", "Move annotation toolbar")} disabled={!props.onAnnotationToolbarChange} onClick={() => props.onAnnotationToolbarChange?.(annotationToolbar === 'fixed' ? 'floating' : 'fixed')}><MoveVertical size={15} /></button>
      {annotationBusy && <span className="pdf-markup-saving" role="status">{t("正在保存标记…", "Saving annotations…")}</span>}
      {annotationToolbar === 'selection' && <button title={t("关闭选中文字工具", "Close selection tools")} aria-label={t("关闭选中文字工具", "Close selection tools")} onClick={() => { setSelection(null); setHighlightArmed(false); }}><X size={14} /></button>}
    </>}
  </div>;

  return <section ref={paneRef} className={`pdf-pane ${active ? 'is-active' : ''} reading-${readingTheme}`} onPointerDown={props.onActivate} aria-label={t('{name} 阅读器', '{name} reader', { name: paper.name })}>
    <div className="pdf-document-heading"><FileText size={14} /><span title={paper.name}>{paper.name}</span><small>{paper.role === 'main' ? t("正文", "Main article") : t("补充材料", "Supplement")}</small></div>
    <div className="pdf-toolbar" role="toolbar" aria-label={t("PDF 阅读工具", "PDF reading tools")}>
      <button className={`pdf-icon-button ${sidebar ? 'is-on' : ''}`} title={t("目录、缩略图与批注", "Outline, thumbnails, and annotations")} aria-label={t("目录、缩略图与批注", "Outline, thumbnails, and annotations")} aria-pressed={!!sidebar} onClick={() => setSidebar(sidebar ? null : 'outline')}><PanelLeft size={17} /></button>
      <button className={`pdf-icon-button ${searchOpen ? 'is-on' : ''}`} title={t('搜索文章文字（{shortcut}）', 'Search article text ({shortcut})', { shortcut: shortcutLabel('F') })} aria-label={t("搜索文章文字", "Search article text")} onClick={() => setSearchOpen(!searchOpen)}><Search size={17} /></button>
      <span className="pdf-toolbar-divider" />
      <div className="pdf-page-control">
        <button className="pdf-icon-button" title={t("上一页", "Previous page")} aria-label={t("上一页", "Previous page")} disabled={!pdf || page <= 1} onClick={() => viewerRef.current?.previousPage()}><ChevronLeft size={16} /></button>
        <form onSubmit={event => { event.preventDefault(); goToPage(Number(pageInput)); setPageInput(String(clamp(Number(pageInput) || page, 1, pageCount || 1))); }}><input aria-label={t("当前页码", "Current page")} title={t("输入页码并回车跳转", "Enter a page number and press Enter")} value={pageInput} inputMode="numeric" onChange={event => setPageInput(event.target.value.replace(/[^0-9]/g, ''))} onBlur={() => setPageInput(String(page))} /><span>/ {pageCount || '—'}</span></form>
        <button className="pdf-icon-button" title={t("下一页", "Next page")} aria-label={t("下一页", "Next page")} disabled={!pdf || page >= pageCount} onClick={() => viewerRef.current?.nextPage()}><ChevronRight size={16} /></button>
      </div>
      <span className="pdf-toolbar-divider" />
      <div className="pdf-zoom-control" role="group" aria-label={t("此阅读区的独立缩放", "Independent zoom for this pane")}>
      <button className="pdf-icon-button pdf-zoom-step" title={t("缩小此阅读区", "Zoom out in this pane")} aria-label={t("缩小", "Zoom out")} disabled={!pdf} onClick={() => viewerRef.current?.decreaseScale()}><Minus size={15} /></button>
      <select className="pdf-zoom-select" aria-label={t("缩放比例", "Zoom level")} value={['page-width', 'page-fit', 'auto', '0.5', '0.75', '1', '1.25', '1.5', '2', '3'].includes(scale) ? scale : 'custom'} disabled={!pdf} onChange={event => { if (viewerRef.current && event.target.value !== 'custom') viewerRef.current.currentScaleValue = event.target.value; }}>
        <option value="page-width">{t("适合宽度", "Fit width")}</option><option value="page-fit">{t("适合页面", "Fit page")}</option><option value="auto">{t("自动缩放", "Auto zoom")}</option>
        {[['0.5', '50%'], ['0.75', '75%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%'], ['3', '300%']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        {!['page-width', 'page-fit', 'auto', '0.5', '0.75', '1', '1.25', '1.5', '2', '3'].includes(scale) && <option value="custom">{scalePercent}%</option>}
      </select>
      <button className="pdf-icon-button pdf-zoom-step" title={t("放大此阅读区", "Zoom in in this pane")} aria-label={t("放大", "Zoom in")} disabled={!pdf} onClick={() => viewerRef.current?.increaseScale()}><Plus size={15} /></button>
      </div>
      <div className="pdf-toolbar-spacer" />
      <button className={`pdf-icon-button ${optionsOpen ? 'is-on' : ''}`} title={t("阅读模式与导出", "Reading modes and export")} aria-label={t("阅读模式与导出", "Reading modes and export")} aria-expanded={optionsOpen} onClick={() => setOptionsOpen(!optionsOpen)}><Settings2 size={17} /></button>
    {optionsOpen && <div className="pdf-options">
      <div className="pdf-options-title"><strong>{t("阅读设置", "Reading settings")}</strong><button className="pdf-icon-button" aria-label={t("关闭阅读设置", "Close reading settings")} onClick={() => setOptionsOpen(false)}><X size={14} /></button></div>
      <label>{t("滚动方式", "Scrolling")}<select aria-label={t("滚动方式", "Scrolling")} value={scrollMode} disabled={!pdf} onChange={event => { if (viewerRef.current) viewerRef.current.scrollMode = Number(event.target.value); }}><option value={0}>{t("连续垂直", "Vertical scrolling")}</option><option value={1}>{t("连续水平", "Horizontal scrolling")}</option><option value={2}>{t("多行排列", "Wrapped scrolling")}</option><option value={3}>{t("单页翻阅", "Page by page")}</option></select></label>
      <label>{t("页面排列", "Page layout")}<select aria-label={t("页面排列", "Page layout")} value={spreadMode} disabled={!pdf || scrollMode === 1} onChange={event => { if (viewerRef.current) viewerRef.current.spreadMode = Number(event.target.value); }}><option value={0}>{t("单栏", "Single page")}</option><option value={1}>{t("双页", "Two pages")}</option><option value={2}>{t("双页 · 独立封面", "Two pages, separate cover")}</option></select></label>
      <label>{t("自定缩放", "Custom zoom")}<form onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('zoom') as HTMLInputElement; const zoom = Number(input.value); if (viewerRef.current && Number.isFinite(zoom)) viewerRef.current.currentScaleValue = String(clamp(zoom, 10, 1000) / 100); }}><input key={scalePercent} name="zoom" type="number" min="10" max="1000" defaultValue={scalePercent} aria-label={t("自定缩放百分比", "Custom zoom percentage")} /><span>%</span><button className="pdf-icon-button" title={t("应用缩放", "Apply zoom")} aria-label={t("应用缩放", "Apply zoom")} disabled={!pdf}><Check size={14} /></button></form></label>
      <button className="pdf-menu-action" disabled={!pdf} onClick={() => { if (viewerRef.current) viewerRef.current.pagesRotation = (viewerRef.current.pagesRotation + 90) % 360; }}><RotateCw size={15} />{t("顺时针旋转 90°", "Rotate 90° clockwise")}</button>
      <div className="pdf-options-separator" />
      <button className="pdf-menu-action" disabled={!!busy} onClick={() => void exportOrPrint('export')}>{busy === 'export' ? <LoaderCircle className="pdf-spin" size={15} /> : <Download size={15} />}{t("导出 PDF（含目录与批注）", "Export PDF with outline and annotations")}</button>
      <button className="pdf-menu-action" disabled={!!busy} onClick={() => void exportOrPrint('print')}>{busy === 'print' ? <LoaderCircle className="pdf-spin" size={15} /> : <Printer size={15} />}{t("打印 PDF", "Print PDF")}</button>
    </div>}
    </div>

    {searchOpen && <div className="pdf-search-bar">
      <div className="pdf-search-input"><Search size={14} /><input ref={searchRef} aria-label={t("搜索 PDF", "Search PDF")} placeholder={t("在文章中查找…", "Find in this article…")} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); find('again', event.shiftKey); } }} /><span aria-live="polite">{findPending ? t("查找中", "Searching") : search ? `${matches.current} / ${matches.total}` : ''}</span></div>
      <button className={`pdf-icon-button pdf-search-case ${caseSensitive ? 'is-on' : ''}`} title={t("区分大小写", "Match case")} aria-label={t("区分大小写", "Match case")} aria-pressed={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)}>Aa</button>
      <button className={`pdf-icon-button pdf-search-word ${wholeWord ? 'is-on' : ''}`} title={t("完整单词", "Whole words")} aria-label={t("完整单词", "Whole words")} aria-pressed={wholeWord} onClick={() => setWholeWord(!wholeWord)}>ab</button>
      <button className="pdf-icon-button" title={t("上一个结果", "Previous result")} aria-label={t("上一个结果", "Previous result")} onClick={() => find('again', true)}><ArrowUp size={14} /></button><button className="pdf-icon-button" title={t("下一个结果", "Next result")} aria-label={t("下一个结果", "Next result")} onClick={() => find('again')}><ArrowDown size={14} /></button>
      <button className="pdf-icon-button" title={t("关闭搜索", "Close search")} aria-label={t("关闭搜索", "Close search")} onClick={() => setSearchOpen(false)}><X size={14} /></button>
    </div>}

    {!sharedToolbar && annotationToolbar === 'fixed' && annotationTools}
    <div className="pdf-pane-body">
      {sidebar && <aside className="pdf-sidebar" aria-label={t("PDF 导航", "PDF navigation")}>
        <div className="pdf-sidebar-tabs">
          <button className={sidebar === 'outline' ? 'is-on' : ''} onClick={() => setSidebar('outline')} title={t("目录", "Outline")} aria-label={t("目录", "Outline")}><ListTree size={16} /></button>
          <button className={sidebar === 'thumbnails' ? 'is-on' : ''} onClick={() => setSidebar('thumbnails')} title={t("缩略图", "Thumbnails")} aria-label={t("缩略图", "Thumbnails")}><FileText size={16} /></button>
          <button className={sidebar === 'annotations' ? 'is-on' : ''} onClick={() => setSidebar('annotations')} title={t("高亮与批注", "Highlights and comments")} aria-label={t("高亮与批注", "Highlights and comments")}><StickyNote size={16} />{!!paper.annotations.length && <small>{paper.annotations.length}</small>}</button>
        </div>
        <div className="pdf-sidebar-caption"><span>{sidebar === 'outline' ? t("文章目录", "Article outline") : sidebar === 'thumbnails' ? t("页面缩略图", "Page thumbnails") : t("高亮与批注", "Highlights and comments")}</span>{sidebar === 'outline' && <button className="pdf-icon-button" title={t("将当前页加入目录", "Add current page to outline")} aria-label={t("将当前页加入目录", "Add current page to outline")} disabled={!pdf || props.editBusy} onClick={addOutline}><BookmarkPlus size={15} /></button>}</div>
        <div className="pdf-sidebar-scroll">
          {sidebar === 'outline' && (outline.length ? <OutlineTree items={outline} selected={outlineSelection} onSelect={chooseOutline} collapsed={collapsed} onToggle={id => setCollapsed(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; })} /> : <div className="pdf-sidebar-empty"><ListTree size={25} /><p>{t("还没有文章目录", "No outline yet")}</p><span>{t("在当前页添加章节，建立自己的阅读索引。", "Add a section at the current page to create your own outline.")}</span><button className="pdf-text-button" onClick={addOutline} disabled={!pdf || props.editBusy}><Plus size={13} />{t("添加当前页", "Add current page")}</button></div>)}
          {sidebar === 'thumbnails' && pdf && Array.from({ length: pageCount }, (_, index) => <Thumbnail key={`${paper.id}-${index}`} pdf={pdf} page={index + 1} selected={page === index + 1} onClick={() => goToPage(index + 1)} />)}
          {sidebar === 'annotations' && (!paper.annotations.length ? <div className="pdf-sidebar-empty"><Highlighter size={25} /><p>{t("留住阅读中的灵感", "Keep your reading insights")}</p><span>{t("选中 PDF 文字，即可高亮、批注或向 AI 提问。", "Select PDF text to highlight it, add a comment, or ask AI.")}</span></div> : [...paper.annotations].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt).map(annotation => <button key={annotation.id} className={`pdf-annotation-card ${annotationId === annotation.id ? 'is-selected' : ''}`} onClick={() => { openAnnotation(annotation); goToPage(annotation.page); }} style={{ '--annotation-color': annotation.color } as CSSProperties}><small>{t('第 {page} 页', 'Page {page}', { page: annotation.page })} {annotation.comment && t("· 批注", "· Comment")}</small><blockquote>{annotation.text || t("页面批注", "Page annotation")}</blockquote>{annotation.comment && <p>{annotation.comment}</p>}</button>))}
        </div>
        {sidebar === 'outline' && selectedOutline && <fieldset className="pdf-outline-editor" disabled={props.editBusy} aria-label={t("编辑目录项", "Edit outline entry")}><label>{t("章节名称", "Section title")}<input aria-label={t("章节名称", "Section title")} value={outlineTitle} onChange={event => setOutlineTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') editOutline(); }} /></label><label className="pdf-outline-page-label">{t("指向页码", "Target page")}<input type="number" aria-label={t("目录目标页码", "Outline target page")} min={1} max={pageCount} value={outlinePage} onChange={event => setOutlinePage(event.target.value)} /><button className="pdf-icon-button" title={t("保存目录项", "Save outline entry")} aria-label={t("保存目录项", "Save outline entry")} onClick={editOutline}><Check size={15} /></button></label>
          <div className="pdf-outline-actions">{([['up', t("上移章节", "Move section up"), ArrowUp], ['down', t("下移章节", "Move section down"), ArrowDown], ['outdent', t("提升层级", "Promote section"), ArrowLeft], ['indent', t("缩进层级", "Demote section"), ArrowRight], ['delete', t("删除章节及子目录", "Delete section and children"), Trash2]] as const).map(([action, title, Icon]) => <button key={action} className="pdf-icon-button" title={title} aria-label={title} disabled={(action === 'up' || action === 'indent') ? selectedOutline.index === 0 : action === 'down' ? selectedOutline.index === selectedOutline.siblings.length - 1 : action === 'outdent' ? !selectedOutline.parent : false} onClick={() => { saveOutline(changeOutline(outline, outlineSelection!, action)); if (action === 'delete') setOutlineSelection(null); }}><Icon size={14} /></button>)}</div>
        </fieldset>}
        {sidebar === 'annotations' && selectedAnnotation && <div className="pdf-comment-editor"><div className="pdf-markup-editor-options"><label>{t("标记类型", "Markup type")}<select aria-label={t("批注类型", "Annotation type")} value={annotationKindDraft} onChange={event => setAnnotationKindDraft(event.target.value as MarkupKind)}>{MARKUP_TOOLS.map(item => <option key={item.kind} value={item.kind}>{item.menuLabel}</option>)}</select></label><label>{t("颜色", "Color")}<input type="color" aria-label={t("批注颜色", "Annotation color")} value={annotationColorDraft} onChange={event => setAnnotationColorDraft(event.target.value)} /></label></div><label>{t("批注", "Comment")}<textarea ref={annotationInputRef} aria-label={t("批注内容", "Comment text")} placeholder={t("记录你的想法…", "Write your thoughts…")} value={commentDraft} onChange={event => setCommentDraft(event.target.value)} /></label><div className="pdf-comment-actions"><button className="pdf-text-button pdf-delete-annotation" title={t("删除这条批注及标记，可撤销", "Delete this comment and its mark; you can undo this")} aria-label={t("删除批注", "Delete annotation")} disabled={annotationBusy} onClick={() => deleteAnnotation(selectedAnnotation.id)}><Trash2 size={14} />{t("删除批注", "Delete annotation")}</button><button className="pdf-text-button" disabled={annotationBusy} onClick={() => { if (submitAnnotations(latest.current.document.annotations.map(item => item.id === annotationId ? { ...item, kind: annotationKindDraft, color: annotationColorDraft, comment: commentDraft } : item))) setAnnotationId(null); }}><Check size={13} />{t("保存批注", "Save annotation")}</button></div></div>}
      </aside>}
      <div className="pdf-canvas-area">
        <div ref={containerRef} className={`pdf-viewer-container ${highlightArmed ? 'pdf-highlighter-active' : ''}`} tabIndex={0} aria-label={t("PDF 页面", "PDF pages")} onMouseUp={event => { if (event.button === 0 && !event.ctrlKey) captureSelection(true); }} onKeyUp={event => { if (event.shiftKey || event.key === 'Shift') captureSelection(event.key === 'Shift'); }} onContextMenu={event => { event.preventDefault(); openContextMenu(event.clientX, event.clientY, event.target); }} onKeyDown={event => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openContextMenu(0, 0, event.target); }
        }} onClickCapture={event => {
          const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
          if (!link) return;
          const href = link.getAttribute('href') || '';
          if (href.startsWith('#')) return;
          event.preventDefault(); event.stopPropagation();
          if (/^https?:|^mailto:/i.test(href)) void window.folio.openExternal(href).catch(error => latest.current.onError(latest.current.t('无法打开链接：{error}', 'Unable to open link: {error}', { error: messageOf(error) })));
        }}><div ref={viewerElementRef} className="pdfViewer" /></div>
        {!!status && !passwordRequest && <div className="pdf-loading"><LoaderCircle size={25} className="pdf-spin" /><span>{status === 'opening' ? t('正在打开 PDF…', 'Opening PDF…') : status === 'unlocking' ? t('正在解锁 PDF…', 'Unlocking PDF…') : t('需要 PDF 密码', 'PDF password required')}</span></div>}
        {!!failure && <div className="pdf-loading pdf-error"><FileText size={30} /><strong>{t("暂时无法打开这份 PDF", "Unable to open this PDF")}</strong><p>{failure.cancelled ? t('已取消打开加密 PDF。', 'Opening the encrypted PDF was cancelled.') : failure.name === 'InvalidPDFException' ? t('PDF 文件无效或已损坏。', 'The PDF file is invalid or corrupted.') : failure.name === 'MissingPDFException' ? t('找不到 PDF 文件。', 'The PDF file could not be found.') : failure.name === 'PasswordException' ? t('无法使用此密码打开 PDF。', 'This password could not open the PDF.') : failure.message}</p><button className="pdf-text-button" onClick={() => setAttempt(attempt + 1)}>{t("重新打开", "Try again")}</button></div>}
        {!sharedToolbar && annotationToolbar !== 'fixed' && annotationTools}
        {copied && <div className="pdf-copy-feedback" role="status"><Check size={13} />{t("已复制到剪贴板", "Copied to clipboard")}</div>}
        {passwordRequest && <div className="pdf-password-backdrop"><form className="pdf-password-dialog" role="dialog" aria-modal="true" aria-labelledby={`password-title-${paper.id}`} onSubmit={event => { event.preventDefault(); passwordRequest.update(password); setPasswordRequest(null); setStatus('unlocking'); setPassword(''); }}><LockKeyhole size={27} /><h3 id={`password-title-${paper.id}`}>{t("这份 PDF 已加密", "This PDF is encrypted")}</h3><p>{passwordRequest.incorrect ? t("密码不正确，请重新输入。", "Incorrect password. Please try again.") : t("输入文档密码，继续阅读。密码不会保存。", "Enter the document password to continue. It will not be saved.")}</p><input ref={passwordInputRef} type="password" aria-label={t("PDF 文档密码", "PDF password")} value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" /><div><button type="button" className="pdf-text-button" onClick={passwordRequest.cancel}>{t("取消", "Cancel")}</button><button className="pdf-text-button pdf-primary-button" disabled={!password}>{t("打开 PDF", "Open PDF")}</button></div></form></div>}
      </div>
    </div>
    <footer className="pdf-status-bar"><span>{indexing ? t('正在准备文章索引 {progress}%', 'Preparing article index {progress}%', { progress: indexProgress }) : paper.textStatus === 'empty' ? t("扫描文档 · 暂无可提取文字", "Scanned document · No extractable text") : t('{count} 页 · 本地阅读', 'Pages: {count} · Local reading', { count: pageCount || '—' })}</span><span>{readingTheme === 'sepia' ? t("护眼纸色", "Sepia paper") : readingTheme === 'dark' ? t("夜间阅读", "Night reading") : t("原色显示", "Original colors")}<i />{scalePercent}%</span></footer>
    {sharedToolbar && active && props.annotationToolbarHost && createPortal(annotationTools, props.annotationToolbarHost)}
    {contextMenu && createPortal(<div ref={contextMenuRef} className="folio-pdf-context-menu" role="menu" aria-label={t("PDF 操作", "PDF actions")} style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={event => event.preventDefault()} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); closeContextMenu(true); return; }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const items = [...(contextMenuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const current = items.indexOf(window.document.activeElement as HTMLButtonElement);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[target]?.focus({ preventScroll: true });
    }}>
      {contextAnnotation && <>
        <button type="button" role="menuitem" disabled={annotationBusy} onClick={() => { openAnnotation(contextAnnotation); closeContextMenu(); requestAnimationFrame(() => annotationInputRef.current?.focus({ preventScroll: true })); }}><MessageSquare size={15} /><span>{t("编辑批注", "Edit annotation")}</span></button>
        <button type="button" role="menuitem" className="pdf-context-danger" disabled={annotationBusy} onClick={() => { deleteAnnotation(contextAnnotation.id); closeContextMenu(true); }}><Trash2 size={15} /><span>{t("删除批注", "Delete annotation")}</span></button>
        <div role="separator" />
      </>}
      <button type="button" role="menuitem" aria-label={t("复制选中文字", "Copy selected text")} disabled={!contextMenu.text.trim()} onClick={() => { void copyText(contextMenu.text); closeContextMenu(true); }}><Copy size={15} /><span>{t("复制选中文字", "Copy selected text")}</span><kbd>{shortcutLabel('C')}</kbd></button>
      <button type="button" role="menuitem" disabled={!contextMenu.selection || annotationBusy} onClick={() => { startComment(contextMenu.selection); closeContextMenu(); }}><MessageSquare size={15} /><span>{t("添加批注", "Add comment")}</span></button>
      <div role="separator" />
      {MARKUP_TOOLS.map(({ kind, menuLabel, Icon }) => <button key={kind} type="button" role="menuitem" disabled={!contextMenu.selection || annotationBusy} onClick={() => { saveMarkup(kind, '', contextMenu.selection); closeContextMenu(true); }}><Icon size={15} /><span>{menuLabel}</span></button>)}
      <div role="separator" />
      <button type="button" role="menuitem" disabled={!props.onSplit} onClick={() => { closeContextMenu(); props.onSplit?.('vertical'); }}><Columns2 size={15} /><span>{t("左右分栏", "Split left and right")}</span></button>
      <button type="button" role="menuitem" disabled={!props.onSplit} onClick={() => { closeContextMenu(); props.onSplit?.('horizontal'); }}><Rows2 size={15} /><span>{t("上下分栏", "Split top and bottom")}</span></button>
      <button type="button" role="menuitem" disabled={!props.onSplit} onClick={() => { closeContextMenu(); props.onSplit?.('none'); }}><FileText size={15} /><span>{t("取消分栏", "Close split view")}</span></button>
    </div>, window.document.body)}
  </section>;
}
