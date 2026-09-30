import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Check, LoaderCircle, X } from 'lucide-react';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import type { Workspace } from '../../shared/types';
import { useI18n } from '../i18n';
import { loadPdf } from '../pdf/documentIndex';
import { credibleMetadataTitle, detectPaperTitle, MAX_PAPER_TITLE_LENGTH, titleFromFilename, type DetectedPaperTitle } from '../pdf/titleDetection';
import './import-title-dialog.css';

interface Props {
  workspace: Workspace;
  onConfirm: (title: string) => Promise<void>;
  onDefer: () => void;
}

/** The suggestion is a draft: only the user's confirmation writes an article title. */
export default function ImportTitleDialog({ workspace, onConfirm, onDefer }: Props) {
  const { t } = useI18n();
  const mainDocument = workspace.documents.find(document => document.role === 'main') ?? workspace.documents[0];
  const [title, setTitle] = useState(() => (workspace.title || titleFromFilename(mainDocument?.name ?? '')).slice(0, MAX_PAPER_TITLE_LENGTH));
  const [source, setSource] = useState<DetectedPaperTitle['source'] | 'manual'>('filename');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = useRef(false);
  const submitting = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const cancelDetection = useRef<() => void>(() => {});
  const current = useRef({ onConfirm, onDefer, busy });
  current.current = { onConfirm, onDefer, busy };
  const id = useId();

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    const cancel = () => { cancelled = true; void task?.destroy().catch(() => {}); };
    cancelDetection.current = cancel;
    void (async () => {
      try {
        if (!mainDocument) return;
        const bytes = await window.folio.readDocument(workspace.id, mainDocument.id);
        if (cancelled) return;
        task = loadPdf(bytes);
        // Encrypted PDFs reject without requesting a password behind this modal.
        const pdf = await task.promise;
        if (cancelled) return;
        const [metadata, page] = await Promise.all([pdf.getMetadata().catch(() => null), pdf.getPage(1)]);
        if (cancelled) return;
        const text = await page.getTextContent();
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1 });
        const result = detectPaperTitle({
          metadataTitle: credibleMetadataTitle((metadata?.info as { Title?: unknown } | undefined)?.Title) ?? metadata?.metadata?.get('dc:title'),
          // fileName is the internal stored path and includes a random ID prefix.
          filename: mainDocument.name,
          pageWidth: viewport.width,
          pageHeight: viewport.height,
          items: text.items.flatMap(item => {
            if (!('str' in item)) return [];
            const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            const fontSize = Math.hypot(item.transform[2], item.transform[3]);
            return [{ str: item.str, x, y: y - fontSize, width: item.width, fontSize }];
          }),
        });
        if (!cancelled && !dirty.current && !submitting.current) { setTitle(result.title); setSource(result.source); }
      } catch {
        // Scanned, damaged, or password-protected files keep the editable filename fallback.
      } finally {
        if (!cancelled) setLoading(false);
        await task?.destroy().catch(() => {});
      }
    })();
    return cancel;
  }, [workspace.id, mainDocument?.id]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    input.current?.select();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!submitting.current) { cancelDetection.current(); current.current.onDefer(); }
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
      if (!nodes?.length) { event.preventDefault(); return; }
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const containFocus = (event: FocusEvent) => {
      if (!dialog.current?.contains(event.target as Node)) (input.current?.disabled ? dialog.current : input.current)?.focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', containFocus);
    return () => { document.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', containFocus); if (previous?.isConnected) previous.focus(); };
  }, []);

  const confirm = async () => {
    const value = title.replace(/\s+/g, ' ').trim();
    if (!value || submitting.current) return;
    submitting.current = true; cancelDetection.current(); setLoading(false); setBusy(true); setError('');
    try { await current.current.onConfirm(value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const defer = () => { if (!submitting.current) { cancelDetection.current(); current.current.onDefer(); } };
  const status = loading
    ? t('正在读取 PDF 首页，识别文章名称…', 'Reading the first PDF page to identify the title…')
    : source === 'manual'
      ? t('已保留你输入的名称，确认后保存。', 'Your edited title will be saved when you confirm.')
      : source === 'metadata'
        ? t('已从 PDF 信息中识别名称，请核对后确认。', 'A title was found in the PDF information. Please check it before confirming.')
        : source === 'first-page'
          ? t('已从 PDF 首页识别名称，请核对后确认。', 'A title was found on the first PDF page. Please check it before confirming.')
          : t('暂未识别到可靠标题，已填入文件名。你可以修改后确认。', 'No reliable title was found, so the filename is shown. You can edit it before confirming.');

  return <div className="import-title-backdrop">
    <div className="import-title-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-heading`} aria-describedby={`${id}-description`} tabIndex={-1}>
      <header><span className="import-title-icon"><BookOpen size={21} /></span><div><h2 id={`${id}-heading`}>{t('确认文章名称', 'Confirm paper title')}</h2><p id={`${id}-description`}>{t('识别结果可编辑，确认后用于文献库和工作区。', 'Edit the suggestion, then confirm the title for your library and workspace.')}</p></div><button type="button" className="import-title-close" aria-label={t('稍后确认', 'Confirm later')} disabled={busy} onClick={defer}><X size={18} /></button></header>
      <form onSubmit={event => { event.preventDefault(); void confirm(); }}>
        <div className="import-title-content">
          <p className="import-title-filename" title={mainDocument?.name}>{mainDocument?.name}</p>
          <label htmlFor={`${id}-input`}>{t('文章名称', 'Paper title')}</label>
          <textarea id={`${id}-input`} ref={input} value={title} maxLength={MAX_PAPER_TITLE_LENGTH} rows={3} disabled={busy} aria-describedby={`${id}-status`} onChange={event => { dirty.current = true; setSource('manual'); setTitle(event.target.value); setError(''); }} />
          <p className="import-title-status" id={`${id}-status`} role="status">{loading && <LoaderCircle size={14} className="import-title-spin" />}{status}</p>
          <small>{t('仅在本机读取 PDF，不上传文件，也不调用 AI。', 'The PDF is read on this device. No upload or AI request is needed.')}</small>
          {error && <p className="import-title-error" role="alert">{error}</p>}
        </div>
        <footer><button type="button" className="import-title-secondary" disabled={busy} onClick={defer}>{t('稍后确认', 'Confirm later')}</button><button type="submit" className="import-title-primary" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={15} className="import-title-spin" /> : <Check size={15} />}{t('确认名称', 'Confirm title')}</button></footer>
      </form>
    </div>
  </div>;
}
