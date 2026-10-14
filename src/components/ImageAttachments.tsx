import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Image as ImageIcon, X } from 'lucide-react';
import { MAX_CHAT_IMAGES, validateStoredChatImages, type ChatImageSource, type DraftChatImage, type StoredChatImage } from '../../shared/images';
import { useI18n } from '../i18n';
import { isLocalImagePreview, type DraftImageItem } from './imageDrafts';
import './image-attachments.css';

type Navigate = (id: string, page: number) => void;
interface Preview { image: DraftChatImage; opener: HTMLElement }
interface SharedProps { workspaceId: string; documentIds: readonly string[]; onNavigate: Navigate }

function ImageSource({ source, documentIds, onNavigate }: { source?: ChatImageSource; documentIds: readonly string[]; onNavigate: Navigate }) {
  const { t } = useI18n();
  if (!source) return null;
  const present = documentIds.includes(source.documentId);
  const label = t('{name} · 第 {page} 页', '{name} · p. {page}', { name: source.documentName, page: source.page });
  return <button type="button" className="fl-image-source" disabled={!present} title={present ? label : t('原 PDF 已移除，图像仍保留', 'The source PDF was removed; the image is still available')}
    aria-label={present ? t('查看图像来源：{source}', 'View image source: {source}', { source: label }) : t('原 PDF 已移除：{source}', 'Source PDF removed: {source}', { source: label })}
    onClick={() => { if (present) onNavigate(source.documentId, source.page); }}><FileText size={11} aria-hidden="true" /><span>{label}</span>{!present && <small>{t('已移除', 'Removed')}</small>}</button>;
}

function ImagePreview({ preview, documentIds, onNavigate, onClose }: { preview: Preview; documentIds: readonly string[]; onNavigate: Navigate; onClose: () => void }) {
  const { t } = useI18n(), titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal(); closeButton.current?.focus({ preventScroll: true });
    return () => { element?.close(); if (preview.opener.isConnected && preview.opener.getClientRects().length) preview.opener.focus({ preventScroll: true }); };
  }, [preview.opener]);
  return createPortal(<dialog ref={dialog} className="fl-image-dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onKeyDown={event => event.stopPropagation()}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="fl-image-dialog-content">
      <header><h3 id={titleId}>{t('图像预览', 'Image preview')}</h3><button ref={closeButton} type="button" className="fl-image-preview-close" aria-label={t('关闭图像预览', 'Close image preview')} onClick={onClose}><X size={18} /></button></header>
      <div className="fl-image-preview-canvas"><img src={preview.image.dataUrl} alt={preview.image.name} decoding="async" /></div>
      <footer><span>{preview.image.name}</span><ImageSource source={preview.image.source} documentIds={documentIds} onNavigate={(id, page) => { onClose(); onNavigate(id, page); }} /></footer>
    </div>
  </dialog>, document.body);
}

export const DraftImageAttachments = memo(function DraftImageAttachments({ items, onRemove, documentIds, onNavigate, pending = false }: SharedProps & {
  items: readonly DraftImageItem[]; onRemove?: (id: string) => void; pending?: boolean;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => { if (preview && !items.some(item => item.image === preview.image)) setPreview(null); }, [items, preview]);
  if (!items.length) return null;
  return <section className="fl-image-attachments" data-kind={pending ? 'pending' : 'draft'} role="group" aria-label={pending ? t('本轮附图', 'Images for this turn') : t('待发送的 PDF 图像', 'PDF images ready to send')}>
    {!pending && <header><ImageIcon size={13} aria-hidden="true" /><strong>{t('附图 {count}/{max}', 'Images {count}/{max}', { count: items.length, max: MAX_CHAT_IMAGES })}</strong><span>{t('发送前可预览或移除', 'Preview or remove before sending')}</span></header>}
    <div className="fl-image-grid">{items.map(item => <figure className="fl-image-card" key={item.id} data-image-id={item.id}>
      <button type="button" className="fl-image-preview-button" aria-label={t('预览图像：{name}', 'Preview image: {name}', { name: item.image.name })} onClick={event => setPreview({ image: item.image, opener: event.currentTarget })}><img src={item.image.dataUrl} alt={item.image.name} loading="lazy" decoding="async" /></button>
      {onRemove && <button type="button" className="fl-image-remove" aria-label={t('移除图像：{name}', 'Remove image: {name}', { name: item.image.name })} onClick={() => onRemove(item.id)}><X size={13} /></button>}
      <figcaption><span className="fl-image-name" title={item.image.name}>{item.image.name}</span><ImageSource source={item.image.source} documentIds={documentIds} onNavigate={onNavigate} /></figcaption>
    </figure>)}</div>
    {preview && <ImagePreview preview={preview} documentIds={documentIds} onNavigate={onNavigate} onClose={() => setPreview(null)} />}
  </section>;
});

function StoredImageCard({ image, visible, workspaceId, documentIds, onNavigate, onPreview }: SharedProps & {
  image: StoredChatImage; visible: boolean; onPreview: (preview: Preview) => void;
}) {
  const { t } = useI18n();
  const [dataUrl, setDataUrl] = useState<string>(), [failed, setFailed] = useState(false), [loading, setLoading] = useState(false);
  const epoch = useRef(0), dataRef = useRef<string | undefined>(undefined), pending = useRef<Promise<string | undefined> | null>(null);
  const load = useCallback(() => {
    if (dataRef.current) return Promise.resolve(dataRef.current);
    if (pending.current) return pending.current;
    const generation = epoch.current;
    setLoading(true); setFailed(false);
    const request = window.folio.readChatImage(workspaceId, image.id).then(value => {
      if (!isLocalImagePreview(value)) throw new Error('Invalid local image');
      if (generation !== epoch.current) return;
      dataRef.current = value; setDataUrl(value); return value;
    }).catch(() => { if (generation === epoch.current) setFailed(true); return undefined; })
      .finally(() => { if (generation === epoch.current) { pending.current = null; setLoading(false); } });
    pending.current = request; return request;
  }, [workspaceId, image.id]);
  useEffect(() => {
    if (visible) void load();
    else { dataRef.current = undefined; setDataUrl(undefined); setFailed(false); setLoading(false); }
    return () => { epoch.current++; pending.current = null; dataRef.current = undefined; };
  }, [visible, load]);
  return <figure className="fl-image-card" data-image-id={image.id} data-image-state={failed ? 'error' : dataUrl ? 'loaded' : loading ? 'loading' : 'idle'}>
    <button type="button" className="fl-image-preview-button" aria-label={t('预览图像：{name}', 'Preview image: {name}', { name: image.name })} aria-busy={loading}
      onClick={async event => { const opener = event.currentTarget, generation = epoch.current; const value = await load(); if (value && generation === epoch.current && opener.isConnected && opener.getClientRects().length) onPreview({ image: { dataUrl: value, name: image.name, source: image.source }, opener }); }}>
      {dataUrl ? <img src={dataUrl} alt={image.name} decoding="async" onError={() => { dataRef.current = undefined; setDataUrl(undefined); setFailed(true); }} /> : <span className="fl-image-placeholder"><ImageIcon size={22} aria-hidden="true" /><span>{failed ? t('图像暂不可用 · 点击重试', 'Image unavailable · Retry') : loading ? t('正在读取图像', 'Loading image') : t('点击预览', 'Preview image')}</span></span>}
    </button>
    <figcaption><span className="fl-image-name" title={image.name}>{image.name}</span><ImageSource source={image.source} documentIds={documentIds} onNavigate={onNavigate} /></figcaption>
  </figure>;
}

export const StoredImageAttachments = memo(function StoredImageAttachments({ images, workspaceId, documentIds, onNavigate }: SharedProps & { images?: StoredChatImage[] }) {
  const { t } = useI18n(), group = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false), [preview, setPreview] = useState<Preview | null>(null);
  let valid = true; try { validateStoredChatImages(images); } catch { valid = false; }
  useEffect(() => {
    if (!group.current || !images?.length || !valid || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '60px 0px' });
    observer.observe(group.current); return () => observer.disconnect();
  }, [images?.length, valid]);
  if (!images?.length) return null;
  if (!valid) return <p className="fl-image-notice" role="status">{t('这条消息的图像记录不可用；文字仍可阅读。', 'Image records for this message are unavailable; its text is still readable.')}</p>;
  return <section ref={group} className="fl-image-attachments" data-kind="history" role="group" aria-label={t('消息附图', 'Message images')}>
    <div className="fl-image-grid">{images.map(image => <StoredImageCard key={image.id} image={image} visible={visible || !!preview} workspaceId={workspaceId} documentIds={documentIds} onNavigate={onNavigate} onPreview={setPreview} />)}</div>
    {preview && <ImagePreview preview={preview} documentIds={documentIds} onNavigate={onNavigate} onClose={() => setPreview(null)} />}
  </section>;
});
