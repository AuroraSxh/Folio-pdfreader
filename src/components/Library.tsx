import { useMemo, useState } from 'react';
import { ArrowDownWideNarrow, ArrowRight, BookOpen, Check, Clock3, FileText, FolderOpen, Grid2X2, Layers3, List, LoaderCircle, Plus, Search, Sparkles, Star, Trash2, Upload, X } from 'lucide-react';
import type { Workspace } from '../../shared/types';
import { shortcutLabel } from '../platform';
import './ui-components.css';

interface Props {
  workspaces: Workspace[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDemo: () => void;
  onToggleFavorite: (ws: Workspace) => void;
  onDelete: (ws: Workspace) => void;
  filter: 'all' | 'favorites' | 'recent';
  busy: boolean;
}

const FILTER_TITLES = { all: '我的文献库', favorites: '收藏的论文', recent: '最近阅读' };

export default function Library({ workspaces, onOpen, onCreate, onDemo, onToggleFavorite, onDelete, filter, busy }: Props) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('recent');
  const papers = useMemo(() => workspaces
    .filter(ws => filter !== 'favorites' || ws.favorite)
    .filter(ws => filter !== 'recent' || ws.lastReadAt > 0)
    .filter(ws => `${ws.title} ${ws.authors} ${ws.journal} ${ws.tags.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'created' ? b.createdAt - a.createdAt : b.lastReadAt - a.lastReadAt || b.updatedAt - a.updatedAt), [workspaces, filter, query, sort]);
  const totalDocs = workspaces.reduce((n, ws) => n + ws.documents.length, 0);
  const withNotes = workspaces.filter(ws => ws.notes.trim() || ws.summary).length;
  const lastRead = [...workspaces].filter(ws => ws.lastReadAt > 0).sort((a, b) => b.lastReadAt - a.lastReadAt)[0];

  return <div className="fl-library">
    <section className="fl-library-intro">
      <div className="fl-library-title">
        <span className="fl-eyebrow"><span className="fl-small-dot" /> YOUR RESEARCH, CONNECTED</span>
        <h1>{FILTER_TITLES[filter]}<span>让思考，留在纸页之间。</span></h1>
        <p>正文、补充材料与每一次灵感，在同一个工作区相遇。</p>
      </div>
      <button className="fl-button fl-primary" onClick={onCreate} disabled={busy}>{busy ? <LoaderCircle size={17} className="fl-spin" /> : <Plus size={17} />} 导入论文 <kbd>{shortcutLabel('O')}</kbd></button>
    </section>

    {workspaces.length > 0 && <section className="fl-library-overview" aria-label="文献库概览">
      <div><span className="fl-overview-icon"><BookOpen size={19} /></span><strong>{workspaces.length}</strong><span>论文工作区</span></div>
      <div><span className="fl-overview-icon"><Layers3 size={19} /></span><strong>{totalDocs}</strong><span>PDF 文档</span></div>
      <div><span className="fl-overview-icon lavender"><FileText size={19} /></span><strong>{withNotes}</strong><span>已有阅读笔记</span></div>
      <div className="fl-overview-local"><span className="fl-small-dot" /> 文件保存在本机</div>
    </section>}

    {filter === 'all' && lastRead && !query && <button className="fl-continue" onClick={() => onOpen(lastRead.id)}>
      <span className="fl-continue-icon"><BookOpen size={23} /></span>
      <span className="fl-continue-copy"><span>接着上次的思考</span><strong>{lastRead.title}</strong></span>
      <span className="fl-continue-page">{lastRead.documents[0]?.pageCount ? `第 ${lastRead.documents[0].view.page} / ${lastRead.documents[0].pageCount} 页` : '打开工作区'}</span><ArrowRight size={18} />
    </button>}

    <div className="fl-library-toolbar">
      <div className="fl-library-section-title">{query ? '搜索结果' : filter === 'favorites' ? '我的收藏' : '论文工作区'}<span>{papers.length}</span></div>
      <div className="fl-library-controls">
        <label className="fl-search"><Search size={16} /><input aria-label="搜索文献" placeholder="搜索标题、作者或标签…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="fl-icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={14} /></button>}</label>
        <label className="fl-sort"><ArrowDownWideNarrow size={15} /><select aria-label="排序方式" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近阅读</option><option value="created">最近添加</option><option value="title">标题排序</option></select></label>
        <div className="fl-segmented"><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="网格视图" aria-pressed={view === 'grid'}><Grid2X2 size={16} /></button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="列表视图" aria-pressed={view === 'list'}><List size={17} /></button></div>
      </div>
    </div>

    {!workspaces.length ? <section className="fl-library-empty">
      <div className="fl-empty-art" aria-hidden="true">
        <div className="fl-paper-back"><div /><div /><div /></div>
        <div className="fl-paper-front"><div className="fl-paper-symbol"><BookOpen size={25} strokeWidth={1.3} /></div><span>Ideas start here.</span><div className="fl-paper-line" /><div className="fl-paper-line short" /><div className="fl-paper-columns"><i /><i /></div><div className="fl-paper-marker" /></div>
        <div className="fl-art-badge"><Sparkles size={15} /> 为好奇心留一页</div>
      </div>
      <span className="fl-eyebrow">A LITTLE SPACE FOR BIG IDEAS</span>
      <h2>下一篇好论文，从这里开始。</h2>
      <p>导入正文 PDF，创建论文专属工作区。<br />把补充材料一起收好，让阅读、对照和记录自然发生。</p>
      <div className="fl-empty-actions"><button className="fl-button fl-primary" onClick={onCreate} disabled={busy}>{busy ? <LoaderCircle size={17} className="fl-spin" /> : <Upload size={17} />} 导入第一篇论文</button><button className="fl-button fl-quiet" onClick={onDemo} disabled={busy}>体验示例工作区 <ArrowRight size={15} /></button></div>
      <div className="fl-empty-features"><span><Check size={13} /> 正文与补充材料分栏阅读</span><span><Check size={13} /> DeepSeek 辅助理解</span><span><Check size={13} /> 一键导出到 Obsidian</span></div>
    </section> : papers.length === 0 ? <section className="fl-filter-empty"><span className="fl-empty-icon">{filter === 'favorites' && !query ? <Star size={26} /> : <Search size={26} />}</span><h2>{query ? '还没有找到这篇论文' : filter === 'favorites' ? '把重要的论文留在这里' : '你的阅读足迹将出现在这里'}</h2><p>{query ? '试试标题中的几个词、作者姓名，或一个研究标签。' : filter === 'favorites' ? '点击论文卡片上的星标，即可加入收藏。' : '从文献库打开一篇论文，开始阅读。'}</p>{query && <button className="fl-button fl-secondary" onClick={() => setQuery('')}>清除搜索</button>}</section> : <div className={`fl-paper-grid ${view === 'list' ? 'is-list' : ''}`}>
      {papers.map((ws, index) => {
        const main = ws.documents.find(doc => doc.role === 'main') ?? ws.documents[0];
        const progress = main?.pageCount ? Math.min(100, Math.round(main.view.page / main.pageCount * 100)) : 0;
        return <article className={`fl-workspace-card fl-card-tone-${index % 4}`} key={ws.id}>
          <button className="fl-card-open" onClick={() => onOpen(ws.id)} aria-label={`打开 ${ws.title}`}>
            <div className="fl-card-cover"><div className="fl-cover-top"><span><FileText size={12} /> PDF</span>{ws.documents.length > 1 && <span><Layers3 size={12} /> +{ws.documents.length - 1}</span>}</div><div className="fl-cover-title">{ws.title}</div><div className="fl-cover-lines"><i /><i /><i /></div><span className="fl-cover-bottom">{ws.journal || 'RESEARCH PAPER'}</span></div>
            <div className="fl-card-content"><div className="fl-card-meta">{ws.journal || '论文工作区'}<span>{new Date(ws.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</span></div><h3>{ws.title}</h3><p>{ws.authors || `${ws.documents.length} 个 PDF 文档`}</p><div className="fl-card-tags">{ws.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}{ws.summary && <span className="fl-ai-tag"><Sparkles size={10} /> 已生成摘要</span>}</div><div className="fl-card-footer"><span><FolderOpen size={13} /> {ws.documents.length} 个文件</span><span>{main?.pageCount ? `${main.view.page} / ${main.pageCount} 页` : '开始阅读'}<ArrowRight size={13} /></span></div>{progress > 0 && <div className="fl-card-progress" title={`当前页位置 ${progress}%`}><i style={{ width: `${progress}%` }} /></div>}</div>
          </button>
          <div className="fl-card-actions"><button className={`fl-icon-button ${ws.favorite ? 'is-favorite' : ''}`} aria-label={ws.favorite ? '取消收藏' : '收藏论文'} title={ws.favorite ? '取消收藏' : '收藏论文'} onClick={() => onToggleFavorite(ws)}><Star size={15} fill={ws.favorite ? 'currentColor' : 'none'} /></button><button className="fl-icon-button fl-card-delete" title="移除工作区" aria-label={`移除 ${ws.title}`} onClick={() => onDelete(ws)}><Trash2 size={14} /></button></div>
        </article>;
      })}
      {view === 'grid' && <button className="fl-add-card" onClick={onCreate} disabled={busy}><span><Plus size={24} strokeWidth={1.2} /></span><strong>收下新的灵感</strong><small>导入 PDF，开始新的阅读</small></button>}
    </div>}
    <footer className="fl-library-bottom"><span>FOLIO · A PLACE TO THINK</span><span><Clock3 size={12} /> 每一页，都值得慢慢读。</span></footer>
  </div>;
}
