import { useMemo, useRef, useState } from 'react';
import { Archive, Clock3, FileText, LoaderCircle, RotateCcw, Search, Trash2, X } from 'lucide-react';
import type { RemovedWorkspace } from '../../shared/types';
import { useI18n } from '../i18n';
import './ui-components.css';

interface Props {
  items: RemovedWorkspace[];
  onRestore: (id: string) => Promise<void>;
  onPurge: (id: string) => Promise<void>;
  busyId?: string;
}

export default function RemovedArticles({ items, onRestore, onPurge, busyId }: Props) {
  const {t,locale}=useI18n();
  const removalDate=useMemo(()=>new Intl.DateTimeFormat(locale,{
    year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',
  }),[locale]);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<{ id: string; action: 'restore' | 'purge' } | null>(null);
  const [error, setError] = useState('');
  const actionPending = useRef(false);
  const papers = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return items.filter(item => `${item.title} ${item.authors} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(search))
      .sort((a, b) => b.removedAt - a.removedAt || a.title.localeCompare(b.title,locale));
  }, [items, query, locale]);

  async function act(id: string, action: 'restore' | 'purge') {
    if (actionPending.current || busyId) return;
    actionPending.current = true;
    setPending({ id, action });
    setError('');
    try {
      await (action === 'restore' ? onRestore(id) : onPurge(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : action === 'restore' ? t("恢复失败，请稍后重试。","Could not restore the paper. Please try again.") : t("彻底删除失败，请稍后重试。","Could not permanently delete the paper. Please try again."));
    } finally {
      actionPending.current = false;
      setPending(null);
    }
  }

  return <div className="fl-library fl-removed">
    <section className="fl-library-intro">
      <div className="fl-library-title">
        <span className="fl-eyebrow"><span className="fl-small-dot" /> ROOM TO RETURN</span>
        <h1>{t("已移除文章","Removed Papers")}<span>{t("暂时放下的论文，也可以再找回。","Papers you put aside are still here.")}</span></h1>
        <p>{t("管理移出的工作区，随时恢复完整的阅读记录。","Restore removed workspaces with all their reading records.")}</p>
      </div>
      <span className="fl-removed-total"><Archive size={17} /><strong>{items.length}</strong>{t(" 篇保留中"," papers kept")}</span>
    </section>

    <div className="fl-removed-retention" role="note">
      <span className="fl-removed-retention-icon"><Clock3 size={21} strokeWidth={1.5} /></span>
      <div><strong>{t("一直保留，直到你手动彻底删除","Kept until you permanently delete them")}</strong><p>{t("没有自动清理，也不会定时彻底删除。恢复文章时，PDF、笔记和阅读对话会一起回到文献库。","Nothing is deleted automatically. Restoring a paper brings its PDFs, notes, and conversations back to your library.")}</p></div>
    </div>

    <div className="fl-library-toolbar">
      <div className="fl-library-section-title">{query.trim() ? t("搜索结果","Search results") : t("已移除的工作区","Removed workspaces")}<span>{papers.length}</span></div>
      <label className="fl-search fl-removed-search"><Search size={16} /><input aria-label={t("搜索已移除文章","Search removed papers")} placeholder={t("搜索标题、作者或标签…","Search titles, authors, or tags…")} value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="fl-icon-button" aria-label={t("清除已移除文章搜索","Clear removed-paper search")} onClick={() => setQuery('')}><X size={14} /></button>}</label>
    </div>

    {error && <div className="fl-removed-error" role="alert"><span>{error}</span><button className="fl-icon-button" aria-label={t("关闭操作错误","Dismiss error")} onClick={() => setError('')}><X size={15} /></button></div>}

    {!papers.length ? <section className="fl-filter-empty fl-removed-empty">
      <span className="fl-empty-icon">{query.trim() ? <Search size={27} strokeWidth={1.4} /> : <Archive size={29} strokeWidth={1.4} />}</span>
      <h2>{query.trim() ? t("没有找到这篇文章","No matching papers") : t("这里还没有移除的文章","No removed papers")}</h2>
      <p>{query.trim() ? t("试试标题中的几个词、作者姓名，或一个研究标签。","Try a few words from the title, an author name, or a tag.") : t("从文献库移除的工作区会保存在这里。\n需要时，可以把它们完整恢复。","Workspaces removed from your library are kept here.\nYou can restore them whenever you need them.")}</p>
      {query.trim() && <button className="fl-button fl-secondary" onClick={() => setQuery('')}>{t("清除搜索","Clear search")}</button>}
    </section> : <div className="fl-removed-list" aria-label={t("已移除文章列表","Removed papers")}>
      {papers.map(item => {
        const validDate = Number.isFinite(item.removedAt) && !Number.isNaN(new Date(item.removedAt).getTime());
        const isPending = pending?.id === item.id;
        return <article className="fl-removed-row" key={item.id} aria-busy={isPending || busyId === item.id}>
          <span className="fl-removed-file-icon"><FileText size={23} strokeWidth={1.4} /></span>
          <div className="fl-removed-copy">
            <h2 title={item.title}>{item.title}</h2>
            {item.authors && <p className="fl-removed-authors" title={item.authors}>{item.authors}</p>}
            <div className="fl-removed-meta"><span><FileText size={12} /> {item.documentCount}{t(" 个 PDF"," PDFs")}</span><span><Clock3 size={12} />{t(" 移除于 "," Removed on ")}<time dateTime={validDate ? new Date(item.removedAt).toISOString() : undefined}>{validDate ? removalDate.format(item.removedAt) : t("日期未知","Unknown date")}</time></span></div>
            {item.tags.length > 0 && <div className="fl-card-tags fl-removed-tags">{item.tags.slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}{item.tags.length > 4 && <span title={item.tags.slice(4).join('、')}>+{item.tags.length - 4}</span>}</div>}
          </div>
          <div className="fl-removed-actions">
            <button className="fl-button fl-secondary fl-removed-restore" aria-label={t("恢复 {v0}","Restore {v0}",{v0:(item.title)})} disabled={!!pending || !!busyId} onClick={() => void act(item.id, 'restore')}>{isPending && pending.action === 'restore' ? <LoaderCircle size={15} className="fl-spin" /> : <RotateCcw size={15} />}{t("恢复","Restore")}</button>
            <button className="fl-button fl-quiet fl-removed-purge" aria-label={t("彻底删除 {v0}","Permanently delete {v0}",{v0:(item.title)})} disabled={!!pending || !!busyId} onClick={() => void act(item.id, 'purge')}>{isPending && pending.action === 'purge' ? <LoaderCircle size={14} className="fl-spin" /> : <Trash2 size={14} />}{t("彻底删除","Delete permanently")}</button>
          </div>
        </article>;
      })}
    </div>}

    <footer className="fl-removed-footer"><Archive size={13} /><span>{t("恢复会保留完整工作区；彻底删除需要再次确认，且无法恢复。","Restore keeps the full workspace. Permanent deletion requires confirmation and cannot be undone.")}</span></footer>
  </div>;
}
