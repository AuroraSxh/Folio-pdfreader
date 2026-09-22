import { useMemo, useRef, useState } from 'react';
import { Archive, Clock3, FileText, LoaderCircle, RotateCcw, Search, Trash2, X } from 'lucide-react';
import type { RemovedWorkspace } from '../../shared/types';
import './ui-components.css';

interface Props {
  items: RemovedWorkspace[];
  onRestore: (id: string) => Promise<void>;
  onPurge: (id: string) => Promise<void>;
  busyId?: string;
}

const removalDate = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

export default function RemovedArticles({ items, onRestore, onPurge, busyId }: Props) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<{ id: string; action: 'restore' | 'purge' } | null>(null);
  const [error, setError] = useState('');
  const actionPending = useRef(false);
  const papers = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return items.filter(item => `${item.title} ${item.authors} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(search))
      .sort((a, b) => b.removedAt - a.removedAt || a.title.localeCompare(b.title));
  }, [items, query]);

  async function act(id: string, action: 'restore' | 'purge') {
    if (actionPending.current || busyId) return;
    actionPending.current = true;
    setPending({ id, action });
    setError('');
    try {
      await (action === 'restore' ? onRestore(id) : onPurge(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : action === 'restore' ? '恢复失败，请稍后重试。' : '彻底删除失败，请稍后重试。');
    } finally {
      actionPending.current = false;
      setPending(null);
    }
  }

  return <div className="fl-library fl-removed">
    <section className="fl-library-intro">
      <div className="fl-library-title">
        <span className="fl-eyebrow"><span className="fl-small-dot" /> ROOM TO RETURN</span>
        <h1>已移除文章<span>暂时放下的论文，也可以再找回。</span></h1>
        <p>管理移出的工作区，随时恢复完整的阅读记录。</p>
      </div>
      <span className="fl-removed-total"><Archive size={17} /><strong>{items.length}</strong> 篇保留中</span>
    </section>

    <div className="fl-removed-retention" role="note">
      <span className="fl-removed-retention-icon"><Clock3 size={21} strokeWidth={1.5} /></span>
      <div><strong>一直保留，直到你手动彻底删除</strong><p>没有自动清理，也不会定时彻底删除。恢复文章时，PDF、笔记和阅读对话会一起回到文献库。</p></div>
    </div>

    <div className="fl-library-toolbar">
      <div className="fl-library-section-title">{query.trim() ? '搜索结果' : '已移除的工作区'}<span>{papers.length}</span></div>
      <label className="fl-search fl-removed-search"><Search size={16} /><input aria-label="搜索已移除文章" placeholder="搜索标题、作者或标签…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="fl-icon-button" aria-label="清除已移除文章搜索" onClick={() => setQuery('')}><X size={14} /></button>}</label>
    </div>

    {error && <div className="fl-removed-error" role="alert"><span>{error}</span><button className="fl-icon-button" aria-label="关闭操作错误" onClick={() => setError('')}><X size={15} /></button></div>}

    {!papers.length ? <section className="fl-filter-empty fl-removed-empty">
      <span className="fl-empty-icon">{query.trim() ? <Search size={27} strokeWidth={1.4} /> : <Archive size={29} strokeWidth={1.4} />}</span>
      <h2>{query.trim() ? '没有找到这篇文章' : '这里还没有移除的文章'}</h2>
      <p>{query.trim() ? '试试标题中的几个词、作者姓名，或一个研究标签。' : '从文献库移除的工作区会保存在这里。\n需要时，可以把它们完整恢复。'}</p>
      {query.trim() && <button className="fl-button fl-secondary" onClick={() => setQuery('')}>清除搜索</button>}
    </section> : <div className="fl-removed-list" aria-label="已移除文章列表">
      {papers.map(item => {
        const validDate = Number.isFinite(item.removedAt) && !Number.isNaN(new Date(item.removedAt).getTime());
        const isPending = pending?.id === item.id;
        return <article className="fl-removed-row" key={item.id} aria-busy={isPending || busyId === item.id}>
          <span className="fl-removed-file-icon"><FileText size={23} strokeWidth={1.4} /></span>
          <div className="fl-removed-copy">
            <h2 title={item.title}>{item.title}</h2>
            {item.authors && <p className="fl-removed-authors" title={item.authors}>{item.authors}</p>}
            <div className="fl-removed-meta"><span><FileText size={12} /> {item.documentCount} 个 PDF</span><span><Clock3 size={12} /> 移除于 <time dateTime={validDate ? new Date(item.removedAt).toISOString() : undefined}>{validDate ? removalDate.format(item.removedAt) : '日期未知'}</time></span></div>
            {item.tags.length > 0 && <div className="fl-card-tags fl-removed-tags">{item.tags.slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}{item.tags.length > 4 && <span title={item.tags.slice(4).join('、')}>+{item.tags.length - 4}</span>}</div>}
          </div>
          <div className="fl-removed-actions">
            <button className="fl-button fl-secondary fl-removed-restore" aria-label={`恢复 ${item.title}`} disabled={!!pending || !!busyId} onClick={() => void act(item.id, 'restore')}>{isPending && pending.action === 'restore' ? <LoaderCircle size={15} className="fl-spin" /> : <RotateCcw size={15} />}恢复</button>
            <button className="fl-button fl-quiet fl-removed-purge" aria-label={`彻底删除 ${item.title}`} disabled={!!pending || !!busyId} onClick={() => void act(item.id, 'purge')}>{isPending && pending.action === 'purge' ? <LoaderCircle size={14} className="fl-spin" /> : <Trash2 size={14} />}彻底删除</button>
          </div>
        </article>;
      })}
    </div>}

    <footer className="fl-removed-footer"><Archive size={13} /><span>恢复会保留完整工作区；彻底删除需要再次确认，且无法恢复。</span></footer>
  </div>;
}
