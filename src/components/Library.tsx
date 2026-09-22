import { useMemo, useState } from 'react';
import { ArrowDownWideNarrow, ArrowRight, BookOpen, Check, Clock3, FileText, FolderOpen, Grid2X2, Layers3, List, LoaderCircle, Plus, Search, Sparkles, Star, Trash2, Upload, X } from 'lucide-react';
import type { Workspace } from '../../shared/types';
import { shortcutLabel } from '../platform';
import { useI18n } from '../i18n';
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

export default function Library({ workspaces, onOpen, onCreate, onDemo, onToggleFavorite, onDelete, filter, busy }: Props) {
  const {t,locale}=useI18n();
  const FILTER_TITLES = { all: t("我的文献库","My Library"), favorites: t("收藏的论文","Favorite Papers"), recent: t("最近阅读","Recently Read") };
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('recent');
  const papers = useMemo(() => workspaces
    .filter(ws => filter !== 'favorites' || ws.favorite)
    .filter(ws => filter !== 'recent' || ws.lastReadAt > 0)
    .filter(ws => `${ws.title} ${ws.authors} ${ws.journal} ${ws.tags.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title,locale) : sort === 'created' ? b.createdAt - a.createdAt : b.lastReadAt - a.lastReadAt || b.updatedAt - a.updatedAt), [workspaces, filter, query, sort, locale]);
  const totalDocs = workspaces.reduce((n, ws) => n + ws.documents.length, 0);
  const withNotes = workspaces.filter(ws => ws.notes.trim() || ws.summary).length;
  const lastRead = [...workspaces].filter(ws => ws.lastReadAt > 0).sort((a, b) => b.lastReadAt - a.lastReadAt)[0];

  return <div className="fl-library">
    <section className="fl-library-intro">
      <div className="fl-library-title">
        <span className="fl-eyebrow"><span className="fl-small-dot" /> YOUR RESEARCH, CONNECTED</span>
        <h1>{FILTER_TITLES[filter]}<span>{t("让思考，留在纸页之间。","A place for your reading and ideas.")}</span></h1>
        <p>{t("正文、补充材料与每一次灵感，在同一个工作区相遇。","Keep papers, supplements, and notes together.")}</p>
      </div>
      <button className="fl-button fl-primary" onClick={onCreate} disabled={busy}>{busy ? <LoaderCircle size={17} className="fl-spin" /> : <Plus size={17} />}{t(" 导入论文 "," Import paper ")}<kbd>{shortcutLabel('O')}</kbd></button>
    </section>

    {workspaces.length > 0 && <section className="fl-library-overview" aria-label={t("文献库概览","Library overview")}>
      <div><span className="fl-overview-icon"><BookOpen size={19} /></span><strong>{workspaces.length}</strong><span>{t("论文工作区","Paper workspaces")}</span></div>
      <div><span className="fl-overview-icon"><Layers3 size={19} /></span><strong>{totalDocs}</strong><span>{t("PDF 文档","PDF documents")}</span></div>
      <div><span className="fl-overview-icon lavender"><FileText size={19} /></span><strong>{withNotes}</strong><span>{t("已有阅读笔记","With reading notes")}</span></div>
      <div className="fl-overview-local"><span className="fl-small-dot" />{t(" 文件保存在本机"," Files stored locally")}</div>
    </section>}

    {filter === 'all' && lastRead && !query && <button className="fl-continue" onClick={() => onOpen(lastRead.id)}>
      <span className="fl-continue-icon"><BookOpen size={23} /></span>
      <span className="fl-continue-copy"><span>{t("接着上次的思考","Continue reading")}</span><strong>{lastRead.title}</strong></span>
      <span className="fl-continue-page">{lastRead.documents[0]?.pageCount ? t("第 {v0} / {v1} 页","Page {v0} of {v1}",{v0:(lastRead.documents[0].view.page),v1:(lastRead.documents[0].pageCount)}) : t("打开工作区","Open workspace")}</span><ArrowRight size={18} />
    </button>}

    <div className="fl-library-toolbar">
      <div className="fl-library-section-title">{query ? t("搜索结果","Search results") : filter === 'favorites' ? t("我的收藏","Favorites") : t("论文工作区","Paper workspaces")}<span>{papers.length}</span></div>
      <div className="fl-library-controls">
        <label className="fl-search"><Search size={16} /><input aria-label={t("搜索文献","Search papers")} placeholder={t("搜索标题、作者或标签…","Search titles, authors, or tags…")} value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="fl-icon-button" aria-label={t("清除搜索","Clear search")} onClick={() => setQuery('')}><X size={14} /></button>}</label>
        <label className="fl-sort"><ArrowDownWideNarrow size={15} /><select aria-label={t("排序方式","Sort by")} value={sort} onChange={e => setSort(e.target.value)}><option value="recent">{t("最近阅读","Recently Read")}</option><option value="created">{t("最近添加","Recently added")}</option><option value="title">{t("标题排序","Title")}</option></select></label>
        <div className="fl-segmented"><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label={t("网格视图","Grid view")} aria-pressed={view === 'grid'}><Grid2X2 size={16} /></button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label={t("列表视图","List view")} aria-pressed={view === 'list'}><List size={17} /></button></div>
      </div>
    </div>

    {!workspaces.length ? <section className="fl-library-empty">
      <div className="fl-empty-art" aria-hidden="true">
        <div className="fl-paper-back"><div /><div /><div /></div>
        <div className="fl-paper-front"><div className="fl-paper-symbol"><BookOpen size={25} strokeWidth={1.3} /></div><span>Ideas start here.</span><div className="fl-paper-line" /><div className="fl-paper-line short" /><div className="fl-paper-columns"><i /><i /></div><div className="fl-paper-marker" /></div>
        <div className="fl-art-badge"><Sparkles size={15} />{t(" 为好奇心留一页"," Room for curiosity")}</div>
      </div>
      <span className="fl-eyebrow">A LITTLE SPACE FOR BIG IDEAS</span>
      <h2>{t("下一篇好论文，从这里开始。","Your next paper starts here.")}</h2>
      <p>{t("导入正文 PDF，创建论文专属工作区。","Import a PDF to create a workspace for your paper.")}<br />{t("把补充材料一起收好，让阅读、对照和记录自然发生。","Add the supplements, compare pages, and keep your notes close.")}</p>
      <div className="fl-empty-actions"><button className="fl-button fl-primary" onClick={onCreate} disabled={busy}>{busy ? <LoaderCircle size={17} className="fl-spin" /> : <Upload size={17} />}{t(" 导入第一篇论文"," Import your first paper")}</button><button className="fl-button fl-quiet" onClick={onDemo} disabled={busy}>{t("体验示例工作区 ","Try a demo workspace ")}<ArrowRight size={15} /></button></div>
      <div className="fl-empty-features"><span><Check size={13} />{t(" 正文与补充材料分栏阅读"," Read papers and supplements together")}</span><span><Check size={13} />{t(" DeepSeek 辅助理解"," AI help with DeepSeek")}</span><span><Check size={13} />{t(" 一键导出到 Obsidian"," Export to Obsidian")}</span></div>
    </section> : papers.length === 0 ? <section className="fl-filter-empty"><span className="fl-empty-icon">{filter === 'favorites' && !query ? <Star size={26} /> : <Search size={26} />}</span><h2>{query ? t("还没有找到这篇论文","No matching papers") : filter === 'favorites' ? t("把重要的论文留在这里","Keep your favorite papers here") : t("你的阅读足迹将出现在这里","Your recently read papers will appear here")}</h2><p>{query ? t("试试标题中的几个词、作者姓名，或一个研究标签。","Try a few words from the title, an author name, or a tag.") : filter === 'favorites' ? t("点击论文卡片上的星标，即可加入收藏。","Click the star on a paper to add it to favorites.") : t("从文献库打开一篇论文，开始阅读。","Open a paper from your library to start reading.")}</p>{query && <button className="fl-button fl-secondary" onClick={() => setQuery('')}>{t("清除搜索","Clear search")}</button>}</section> : <div className={`fl-paper-grid ${view === 'list' ? 'is-list' : ''}`}>
      {papers.map((ws, index) => {
        const main = ws.documents.find(doc => doc.role === 'main') ?? ws.documents[0];
        const progress = main?.pageCount ? Math.min(100, Math.round(main.view.page / main.pageCount * 100)) : 0;
        return <article className={`fl-workspace-card fl-card-tone-${index % 4}`} key={ws.id}>
          <button className="fl-card-open" onClick={() => onOpen(ws.id)} aria-label={t("打开 {v0}","Open {v0}",{v0:(ws.title)})}>
            <div className="fl-card-cover"><div className="fl-cover-top"><span><FileText size={12} /> PDF</span>{ws.documents.length > 1 && <span><Layers3 size={12} /> +{ws.documents.length - 1}</span>}</div><div className="fl-cover-title">{ws.title}</div><div className="fl-cover-lines"><i /><i /><i /></div><span className="fl-cover-bottom">{ws.journal || 'RESEARCH PAPER'}</span></div>
            <div className="fl-card-content"><div className="fl-card-meta">{ws.journal || t("论文工作区","Paper workspaces")}<span>{new Date(ws.createdAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span></div><h3>{ws.title}</h3><p>{ws.authors || t("{v0} 个 PDF 文档","{v0} PDF documents",{v0:(ws.documents.length)})}</p><div className="fl-card-tags">{ws.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}{ws.summary && <span className="fl-ai-tag"><Sparkles size={10} />{t(" 已生成摘要"," Summary ready")}</span>}</div><div className="fl-card-footer"><span><FolderOpen size={13} /> {ws.documents.length}{t(" 个文件"," files")}</span><span>{main?.pageCount ? t("{v0} / {v1} 页","Page {v0} of {v1}",{v0:(main.view.page),v1:(main.pageCount)}) : t("开始阅读","Start reading")}<ArrowRight size={13} /></span></div>{progress > 0 && <div className="fl-card-progress" title={t("当前页位置 {v0}%","Current page position: {v0}%",{v0:(progress)})}><i style={{ width: `${progress}%` }} /></div>}</div>
          </button>
          <div className="fl-card-actions"><button className={`fl-icon-button ${ws.favorite ? 'is-favorite' : ''}`} aria-label={ws.favorite ? t("取消收藏","Remove from favorites") : t("收藏论文","Add to favorites")} title={ws.favorite ? t("取消收藏","Remove from favorites") : t("收藏论文","Add to favorites")} onClick={() => onToggleFavorite(ws)}><Star size={15} fill={ws.favorite ? 'currentColor' : 'none'} /></button><button className="fl-icon-button fl-card-delete" title={t("移除工作区","Remove workspace")} aria-label={t("移除 {v0}","Remove {v0}",{v0:(ws.title)})} onClick={() => onDelete(ws)}><Trash2 size={14} /></button></div>
        </article>;
      })}
      {view === 'grid' && <button className="fl-add-card" onClick={onCreate} disabled={busy}><span><Plus size={24} strokeWidth={1.2} /></span><strong>{t("收下新的灵感","Add a new paper")}</strong><small>{t("导入 PDF，开始新的阅读","Import a PDF to get started")}</small></button>}
    </div>}
    <footer className="fl-library-bottom"><span>PAIRLEAF · A PLACE TO THINK</span><span><Clock3 size={12} />{t(" 每一页，都值得慢慢读。"," Take your time with each page.")}</span></footer>
  </div>;
}
