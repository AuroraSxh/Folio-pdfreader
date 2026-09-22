import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownToLine, ArrowUp, ArrowUpRight, BookOpen, Brain, Check, CheckCheck, ChevronDown, Clipboard, Copy, FileText, FlaskConical, Highlighter, History, Lightbulb, LoaderCircle, MessageSquare, NotebookPen, Plus, RefreshCw, Settings2, Sparkles, Square, Trash2, X } from 'lucide-react';
import { MEMORY_LABELS, type ChatRequest, type Settings, type TextSelection, type Workspace } from '../../shared/types';
import './ui-components.css';

interface Props {
  workspace: Workspace; settings: Settings; selection: TextSelection | null;
  onClearSelection: () => void; onWorkspace: (ws: Workspace) => void;
  onSettings: () => void; onError: (message: string) => void;
  onNavigate: (docId: string, page: number) => void;
  focusRequest?: { workspaceId: string; nonce: number };
  panelControls?: ReactNode;
  dragHandleProps?: HTMLAttributes<HTMLElement>;
}
const STARTERS = [
  { title: '总结这篇论文', detail: '抓住问题、方法与核心发现', icon: Sparkles, prompt: '请用中文系统总结这篇论文，涵盖研究背景、科学问题、方法、关键结果、创新点和局限；在论据后标明文档名与页码。', kind: 'summary' },
  { title: '拆解研究方法', detail: '理解实验设计与分析路径', icon: FlaskConical, prompt: '请详细解释这篇论文的方法和实验设计，逐步拆解流程，说明关键假设、对照组、统计方法与可重复性，并标明引用页码。', kind: 'chat' },
  { title: '读懂结果与图表', detail: '联系正文与补充材料', icon: BookOpen, prompt: '请根据 PDF 中可提取的图注和正文，整理关键图表对应的研究问题、结果和结论，并结合补充材料分析；不能看到图像细节时请明确说明，不要猜测，并引用页码。', kind: 'chat' },
  { title: '找出值得追问的点', detail: '局限、证据与下一步研究', icon: Lightbulb, prompt: '请批判性分析这篇论文的证据强度、潜在偏倚和局限，区分作者结论与推测，并提出三个值得进一步研究的问题。请引用页码。', kind: 'chat' },
] as const;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Batch SSE tokens without an idle interval. A generation guard also rejects
 * callbacks already queued before completion, cancellation, or the next reply. */
export function createStreamAccumulator(
  emit: (text: string) => void,
  delay = 90,
  schedule: typeof setTimeout = setTimeout,
  cancel: typeof clearTimeout = clearTimeout,
) {
  let text = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const cancelPending = () => { generation++; if (timer !== null) cancel(timer); timer = null; };
  return {
    append(chunk: string) {
      if (!chunk) return;
      text += chunk;
      if (timer !== null) return;
      const queuedGeneration = generation;
      timer = schedule(() => {
        if (queuedGeneration !== generation) return;
        timer = null;
        emit(text);
      }, delay);
    },
    flush() { cancelPending(); emit(text); },
    clear() { cancelPending(); text = ''; emit(''); },
    dispose() { cancelPending(); text = ''; },
  };
}

const MARKDOWN_PLUGINS = [remarkGfm];
const markdownURL = (url: string) => url.startsWith('folio-cite://') ? url : defaultUrlTransform(url);
interface MarkdownProps { text: string; citationKey: string; onNavigate: (id: string, page: number) => void; onError: (message: string) => void }
const MemoMarkdown = memo(function MemoMarkdown({ text, citationKey, onNavigate, onError }: MarkdownProps) {
  const documents = useMemo(() => {
    const byName = new Map<string, string>();
    for (const [id, name, fileName] of JSON.parse(citationKey) as string[][]) for (const value of [name, fileName]) if (!byName.has(value)) byName.set(value, id);
    return byName;
  }, [citationKey]);
  const withCitations = useMemo(() => text.replace(/\[([^\]\n]+?)\s+(?:p\.?\s*|第\s*)(\d+)(?:\s*页)?\]/gi, (original, name: string, page: string) => {
    const id = documents.get(name.trim());
    return id ? `[${name} p.${page}](folio-cite://${id}/${page})` : original;
  }), [text, documents]);
  const components = useMemo<NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>>(() => ({
    a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (!href) return; if (href.startsWith('folio-cite://')) { const match = href.match(/^folio-cite:\/\/([^/]+)\/(\d+)/); if (match) onNavigate(match[1], Number(match[2])); } else void window.folio.openExternal(href).catch(cause => onError(errorText(cause))); }}>{children}</a>,
    img: ({ alt }) => <span className="fl-markdown-image">[图片：{alt || '外部图片'}]</span>,
  }), [onNavigate, onError]);
  return <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} urlTransform={markdownURL} components={components}>{withCitations}</ReactMarkdown>;
});

export default function AssistantPanel({ workspace, settings, selection, onClearSelection, onWorkspace, onSettings, onError, onNavigate, focusRequest, panelControls, dragHandleProps }: Props) {
  const [tab, setTab] = useState<'chat' | 'notes' | 'memory'>('chat');
  const [input, setInput] = useState('');
  const [source, setSource] = useState('all');
  const [stream, setStream] = useState('');
  const [pendingPrompt, setPendingPrompt] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [notes, setNotes] = useState(workspace.notes);
  const [notesStatus, setNotesStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [notesPreview, setNotesPreview] = useState(false);
  const [clipboardSelection, setClipboardSelection] = useState<TextSelection | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [memoryType, setMemoryType] = useState('all');
  const currentRef = useRef({ workspace, settings, onWorkspace, onError, onNavigate, onClearSelection });
  currentRef.current = { workspace, settings, onWorkspace, onError, onNavigate, onClearSelection };
  const notesRef = useRef(notes); notesRef.current = notes;
  const savedNotes = useRef(workspace.notes);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const [streamAccumulator] = useState(() => createStreamAccumulator(text => { if (mounted.current) setStream(text); }));
  const requestRef = useRef<ChatRequest | null>(null);
  const lastRequest = useRef<ChatRequest | null>(null);
  const autoStarted = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followStream = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastFocusRequest = useRef<{ workspaceId: string; nonce: number } | null>(null);
  const chosenSelection = selection ?? clipboardSelection;
  const provider = settings.providers[settings.activeProvider];
  const hasKey = Boolean(provider.hasKey || provider.apiKey);
  const conversation = workspace.conversations.find(item => item.id === workspace.activeConversationId) ?? workspace.conversations[0];
  const messages = conversation?.messages ?? [];
  // Page, zoom, annotation and layout updates do not invalidate Markdown.
  const citationKey = JSON.stringify(workspace.documents.map(doc => [doc.id, doc.name, doc.fileName]));
  const navigateCitation = useCallback((id: string, page: number) => currentRef.current.onNavigate(id, page), []);
  const markdownError = useCallback((message: string) => currentRef.current.onError(message), []);

  const mergeSnapshot = useCallback((incoming: Workspace) => {
    const current = currentRef.current.workspace;
    const next = { ...(incoming.updatedAt >= current.updatedAt ? incoming : current), notes: notesRef.current };
    // Update the ref as well as React state: several IPC events can arrive before
    // React commits a render, so subsequent events must see the latest revision.
    currentRef.current.workspace = next;
    currentRef.current.onWorkspace(next);
  }, []);

  const flushNotes = useCallback(() => {
    const value = notesRef.current;
    const workspaceId = currentRef.current.workspace.id;
    saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      if (value === savedNotes.current) return;
      if (mounted.current) setNotesStatus('saving');
      try {
        const result = await window.folio.updateWorkspace(workspaceId, { notes: value });
        savedNotes.current = value;
        if (mounted.current) {
          setNotesStatus(notesRef.current === value ? 'saved' : 'saving');
          mergeSnapshot(result);
        }
      } catch (cause) { if (mounted.current) setNotesStatus('error'); currentRef.current.onError(`笔记保存失败：${errorText(cause)}`); throw cause; }
    });
    return saveQueue.current;
  }, [mergeSnapshot]);

  useEffect(() => { const timer = window.setTimeout(() => { void flushNotes().catch(() => {}); }, 700); return () => window.clearTimeout(timer); }, [notes, flushNotes]);
  useEffect(() => {
    const handleFlush = (event: Event) => { (event as CustomEvent<Promise<void>[]>).detail.push(flushNotes()); };
    window.addEventListener('folio:flush-notes', handleFlush);
    return () => window.removeEventListener('folio:flush-notes', handleFlush);
  }, [flushNotes]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; streamAccumulator.dispose(); void flushNotes().catch(() => {}); if (requestRef.current) void window.folio.abortChat(requestRef.current.requestId).catch(() => {}); };
  }, [flushNotes, streamAccumulator]);
  useEffect(() => {
    if (notesRef.current === savedNotes.current && workspace.notes !== savedNotes.current) { savedNotes.current = workspace.notes; notesRef.current = workspace.notes; setNotes(workspace.notes); }
  }, [workspace.notes]);
  // Ordinary PDF selection must keep its native Range and the current tab.
  // Only an explicit “问 AI” action may move focus into the composer.
  useLayoutEffect(() => {
    if (!focusRequest || focusRequest.workspaceId !== workspace.id) return;
    if (lastFocusRequest.current?.workspaceId === focusRequest.workspaceId && lastFocusRequest.current.nonce === focusRequest.nonce) return;
    if (tab !== 'chat') { setTab('chat'); return; }
    if (!inputRef.current) return;
    inputRef.current.focus({ preventScroll: true });
    lastFocusRequest.current = { ...focusRequest };
  }, [focusRequest?.workspaceId, focusRequest?.nonce, workspace.id, tab]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (!messages.length && !pendingPrompt && !stream) { scroller.scrollTo({ top: 0 }); followStream.current = true; }
    else if (followStream.current) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
  }, [messages.length, stream, pendingPrompt, tab, conversation?.id]);

  useEffect(() => window.folio.onChat(event => {
    if (event.workspaceId !== currentRef.current.workspace.id) return;
    if (event.type === 'memory') { if (event.workspace) mergeSnapshot(event.workspace); return; }
    if (event.requestId !== requestRef.current?.requestId) return;
    if (event.type === 'delta') streamAccumulator.append(event.text ?? '');
    if (event.type === 'status') {
      setStatus(event.text ?? '正在阅读论文…');
      if (event.workspace) { mergeSnapshot(event.workspace); setPendingPrompt(''); if (event.workspace.conversations.find(item => item.id === requestRef.current?.conversationId)?.messages.at(-1)?.role === 'assistant') streamAccumulator.clear(); }
    }
    if (event.type === 'done' || event.type === 'error') {
      // Persisted completion is authoritative, including the last buffered token.
      // If a transport error has no snapshot, keep all received partial text.
      if (event.workspace) { mergeSnapshot(event.workspace); setPendingPrompt(''); streamAccumulator.clear(); }
      else streamAccumulator.flush();
      if (event.type === 'error') setError(event.text || '请求失败，请检查 API 设置后重试。');
      if (event.interrupted) setNotice('已停止生成');
      requestRef.current = null; setRequestId(null); setStatus('');
    }
  }), [mergeSnapshot, streamAccumulator]);

  const send = useCallback(async (promptText: string, kind: ChatRequest['kind'] = 'chat', selectionOverride?: TextSelection | null, sourceOverride?: string[]) => {
    if (!promptText.trim() || requestRef.current) return;
    const current = currentRef.current;
    const active = current.settings.providers[current.settings.activeProvider];
    if (!active.hasKey && !active.apiKey) { setError('请先在设置中填写 API Key。'); return; }
    const id = crypto.randomUUID();
    const preliminary: ChatRequest = { requestId: id, workspaceId: current.workspace.id, conversationId: current.workspace.activeConversationId, prompt: promptText.trim(), kind, documentIds: sourceOverride ?? (source === 'all' ? current.workspace.documents.map(doc => doc.id) : [source]), selection: selectionOverride !== undefined ? selectionOverride ?? undefined : chosenSelection ?? undefined };
    requestRef.current = preliminary; lastRequest.current = preliminary;
    followStream.current = true;
    streamAccumulator.clear();
    setRequestId(id); setPendingPrompt(promptText.trim()); setError(''); setNotice(''); setStatus('正在准备论文上下文…'); setInput(''); setTab('chat');
    try {
      await flushNotes();
      if (!preliminary.conversationId) { const next = await window.folio.newConversation(current.workspace.id); preliminary.conversationId = next.activeConversationId; mergeSnapshot(next); }
      current.onClearSelection(); setClipboardSelection(null);
      await window.folio.startChat(preliminary);
    } catch (cause) { if (mounted.current) { streamAccumulator.flush(); requestRef.current = null; setRequestId(null); setStatus(''); setError(errorText(cause)); } }
  }, [source, chosenSelection, flushNotes, mergeSnapshot, streamAccumulator]);

  useEffect(() => {
    const indexed = workspace.documents.length > 0 && workspace.documents.every(doc => doc.textStatus !== undefined);
    const readable = workspace.documents.some(doc => doc.textStatus === 'ready');
    if (!settings.autoSummary || !hasKey || workspace.summary || !indexed || !readable || autoStarted.current || requestRef.current || messages.length > 0) return;
    autoStarted.current = true;
    void send(STARTERS[0].prompt, 'summary', null, workspace.documents.map(doc => doc.id));
  }, [settings.autoSummary, hasKey, workspace.summary, workspace.documents, messages.length, send]);

  const runAction = async (action: () => Promise<void>) => {
    setActionBusy(true); setError(''); setNotice('');
    try { await action(); } catch (cause) { setError(errorText(cause)); } finally { if (mounted.current) setActionBusy(false); }
  };
  const exportNotes = (target: 'file' | 'obsidian') => runAction(async () => {
    await flushNotes();
    if (target === 'obsidian' && !settings.vaultPath) { onSettings(); return; }
    const result = await window.folio.exportMarkdown(workspace.id, target);
    if (result) setNotice(`已导出：${result.path}`);
  });
  const addToNotes = (text: string) => { setNotes(previous => `${previous.trim()}${previous.trim() ? '\n\n---\n\n' : ''}${text}`); setNotesStatus('saving'); setNotice('已加入个人笔记'); };
  const copyText = async (text: string) => { try { await navigator.clipboard.writeText(text); setNotice('已复制'); } catch (cause) { setError(errorText(cause)); } };
  const stopGeneration = () => {
    const activeRequest = requestRef.current;
    if (!activeRequest) return;
    streamAccumulator.flush();
    void window.folio.abortChat(activeRequest.requestId).catch(cause => setError(errorText(cause)));
  };
  const md = (text: string) => <MemoMarkdown text={text} citationKey={citationKey} onNavigate={navigateCitation} onError={markdownError} />;

  return <aside className="fl-assistant" aria-label="论文阅读助手">
    <header className="fl-assistant-header" data-draggable={Boolean(dragHandleProps)} {...dragHandleProps}><span className="fl-assistant-logo"><Sparkles size={18} /></span><div><strong>阅读伙伴</strong><span>{dragHandleProps?'拖动标题栏，自由移动':'让理解，再深入一点。'}</span></div><span className="assistant-panel-controls"><button className="fl-icon-button" aria-label="AI 设置" title="AI 设置" onClick={onSettings}><Settings2 size={16} /></button>{panelControls}</span></header>
    <div className="fl-assistant-tabs" role="tablist">{[{ id: 'chat', label: '对话', icon: MessageSquare }, { id: 'notes', label: '笔记', icon: NotebookPen }, { id: 'memory', label: '记忆', icon: Brain }].map(item => <button role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => setTab(item.id as typeof tab)}><item.icon size={14} />{item.label}{item.id === 'memory' && workspace.memories.length > 0 && <span>{workspace.memories.length}</span>}</button>)}</div>

    {tab === 'chat' && <>
      <div className="fl-conversation-bar"><History size={13} /><select aria-label="历史对话" value={conversation?.id ?? ''} disabled={!!requestId || actionBusy} onChange={event => void runAction(async () => { const next = await window.folio.updateWorkspace(workspace.id, { activeConversationId: event.target.value }); mergeSnapshot(next); setPendingPrompt(''); streamAccumulator.clear(); })}>{!conversation && <option value="">新的阅读对话</option>}{workspace.conversations.map(item => <option key={item.id} value={item.id}>{item.title || '新的阅读对话'}</option>)}</select><button className="fl-icon-button" title="新建对话" aria-label="新建对话" disabled={!!requestId || actionBusy} onClick={() => void runAction(async () => { const next = await window.folio.newConversation(workspace.id); mergeSnapshot(next); setPendingPrompt(''); streamAccumulator.clear(); })}><Plus size={15} /></button></div>
      <div className="fl-chat-scroll" ref={scrollRef} onScroll={event => { const element = event.currentTarget; followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
        {!messages.length && !pendingPrompt && <div className="fl-chat-welcome"><div className="fl-ai-orb"><Sparkles size={24} strokeWidth={1.3} /></div><h3>一起，读懂这篇论文。</h3><p>从一个问题开始。也可以在 PDF 中选中一段，让我们从那里深入。</p>{!hasKey && <button className="fl-key-cta" onClick={onSettings}><span><Settings2 size={15} /><strong>连接你的 AI 服务</strong><small>填写 API Key 后开始对话</small></span><ArrowUpRight size={17} /></button>}<div className="fl-starters">{STARTERS.map(item => <button key={item.title} disabled={!!requestId} onClick={() => hasKey ? void send(item.prompt, item.kind) : onSettings()}><item.icon size={16} /><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowUpRight size={13} /></button>)}</div><div className="fl-context-note"><FileText size={12} /> 结合本文与补充材料，回答附带页码。</div></div>}
        {messages.map(message => <article className={`fl-message ${message.role}`} key={message.id}>{message.role === 'assistant' && <div className="fl-message-author"><span><Sparkles size={12} /></span>Folio <small>{message.model}</small></div>}<div className={message.role === 'assistant' ? 'fl-markdown' : 'fl-user-message'}>{message.role === 'assistant' ? md(message.content) : message.content}</div>{message.interrupted && <span className="fl-interrupted">已停止生成</span>}{message.role === 'assistant' && message.content && <div className="fl-message-actions"><button title="复制回复" onClick={() => void copyText(message.content)}><Copy size={12} /> 复制</button><button title="添加到个人笔记" onClick={() => addToNotes(message.content)}><NotebookPen size={12} /> 存为笔记</button></div>}</article>)}
        {pendingPrompt && <article className="fl-message user"><div className="fl-user-message">{pendingPrompt}</div></article>}
        {(requestId || stream) && <article className="fl-message assistant"><div className="fl-message-author"><span><Sparkles size={12} /></span>Folio <small>{provider.model}</small></div>{stream ? <div className="fl-markdown fl-streaming">{md(stream)}</div> : <div className="fl-thinking"><span /><span /><span /><small>{status || '正在思考…'}</small></div>}</article>}
        {error && <div className="fl-inline-error" role="alert"><span>{error}</span>{!requestId && lastRequest.current && <button onClick={() => { const previous = lastRequest.current; if (previous) void send(previous.prompt, previous.kind, previous.selection, previous.documentIds); }}><RefreshCw size={12} /> 重试</button>}</div>}
      </div>
      <div className="fl-composer-area">
        {chosenSelection && <div className="fl-selection-context"><div><Highlighter size={12} /><span>{chosenSelection.documentName} · 第 {chosenSelection.page} 页</span><button className="fl-icon-button" aria-label="清除选中文字" onClick={() => { onClearSelection(); setClipboardSelection(null); }}><X size={12} /></button></div><blockquote>{chosenSelection.text}</blockquote></div>}
        <div className="fl-composer"><textarea ref={inputRef} value={input} onChange={event => setInput(event.target.value)} aria-label="向 AI 提问" placeholder={hasKey ? '关于这篇论文，你想了解什么？' : '先连接 AI 服务，再开始讨论…'} rows={3} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!requestId) void send(input); } if (event.key === 'Escape' && requestRef.current) stopGeneration(); }} /><div className="fl-composer-bottom"><label className="fl-source-picker"><LayersIcon /><select aria-label="AI 引用文档范围" value={source} onChange={event => setSource(event.target.value)}><option value="all">全部文档 · {workspace.documents.length}</option>{workspace.documents.map(doc => <option value={doc.id} key={doc.id}>{doc.role === 'main' ? '正文' : '补充'} · {doc.name}</option>)}</select><ChevronDown size={10} /></label><button className="fl-icon-button" title="粘贴剪贴板文字作为引用" aria-label="粘贴引用" disabled={!!requestId} onClick={() => void runAction(async () => { const text = await navigator.clipboard.readText(); if (!text.trim()) throw new Error('剪贴板为空，请先复制需要讨论的文字。'); const doc = workspace.documents.find(item => item.id === workspace.layout.leftId) ?? workspace.documents[0]; if (!doc) throw new Error('请先导入 PDF 文档。'); setClipboardSelection({ text, documentId: doc.id, documentName: doc.name, page: doc.view.page, rects: [] }); })}><Clipboard size={14} /></button>{requestId ? <button className="fl-send-button stopping" aria-label="停止生成" title="停止生成" onClick={stopGeneration}><Square size={13} fill="currentColor" /></button> : <button className="fl-send-button" aria-label="发送问题" title="发送 · Enter" disabled={!input.trim() || !hasKey || actionBusy} onClick={() => void send(input)}><ArrowUp size={17} /></button>}</div></div>
        <div className="fl-composer-caption"><button onClick={onSettings}><span className={`fl-small-dot ${hasKey ? '' : 'muted'}`} />{provider.model}{provider.thinking !== false && settings.activeProvider === 'deepseek' && ' · 思考'}</button><span>↵ 发送 · ⇧↵ 换行</span></div>
      </div>
    </>}

    {tab === 'notes' && <div className="fl-notes-panel">
      <div className="fl-panel-scroll">
        <div className="fl-notes-heading"><div><span className="fl-eyebrow">THINK IN YOUR OWN WORDS</span><h3>把理解，写下来。</h3></div><span className={`fl-notes-status ${notesStatus === 'error' ? 'error' : ''}`}>{notesStatus === 'saving' ? <><LoaderCircle size={11} className="fl-spin" /> 保存中</> : notesStatus === 'error' ? '保存失败' : <><CheckCheck size={12} /> 已保存</>}</span></div>
        <div className="fl-note-editor-heading"><strong>我的笔记</strong><div className="fl-segmented"><button className={!notesPreview ? 'active' : ''} onClick={() => setNotesPreview(false)}>编辑</button><button className={notesPreview ? 'active' : ''} onClick={() => setNotesPreview(true)}>预览</button></div></div>
        {notesPreview ? <div className="fl-note-preview fl-markdown">{notes.trim() ? md(notes) : <p className="fl-muted">还没有笔记，写下第一个想法吧。</p>}</div> : <textarea className="fl-notes-editor" aria-label="个人阅读笔记" value={notes} onChange={event => { setNotes(event.target.value); setNotesStatus('saving'); }} onBlur={() => void flushNotes().catch(() => {})} placeholder={'这篇论文让我想到…\n\n## 核心发现\n\n## 我的疑问\n\n## 下一步\n\n支持 Markdown，输入后自动保存。'} />}
        <p className="fl-note-hint"><Brain size={12} /> 笔记会作为上下文参与后续 AI 对话。</p>
        <section className="fl-summary-section"><div><span><Sparkles size={14} /><strong>AI 阅读摘要</strong></span><button className="fl-text-link" disabled={!!requestId || !hasKey} onClick={() => void send(STARTERS[0].prompt, 'summary')}>{workspace.summary ? '重新生成' : '生成摘要'}<ArrowUpRight size={12} /></button></div>{workspace.summary ? <><div className="fl-markdown">{md(workspace.summary.content)}</div><span className="fl-summary-meta">{workspace.summary.model} · {new Date(workspace.summary.createdAt).toLocaleDateString('zh-CN')}</span></> : <p>生成一份结构化摘要，提炼研究问题、方法与主要结论。</p>}</section>
      </div>
      <div className="fl-notes-export"><button className="fl-button fl-obsidian-button" disabled={actionBusy} onClick={() => void exportNotes('obsidian')}><span>◇</span> 导出到 Obsidian <ArrowUpRight size={14} /></button><button className="fl-icon-button" aria-label="导出 Markdown 文件" title="导出 Markdown" disabled={actionBusy} onClick={() => void exportNotes('file')}><ArrowDownToLine size={17} /></button></div>
    </div>}

    {tab === 'memory' && <div className="fl-memory-panel fl-panel-scroll"><div className="fl-notes-heading"><div><span className="fl-eyebrow">IDEAS THAT STAY WITH YOU</span><h3>阅读，会留下痕迹。</h3></div><Brain size={21} /></div><p className="fl-memory-intro">对话中的发现与问题会沉淀在这里，在下一次讨论中继续生长。</p>{!settings.autoMemory && <button className="fl-memory-off" onClick={onSettings}>自动记忆当前已关闭 <Settings2 size={12} /></button>}{workspace.memoryIndex && <details className="fl-memory-index"><summary><Brain size={14} /> 阅读记忆索引<ChevronDown size={12} /></summary><div className="fl-markdown">{md(workspace.memoryIndex)}</div></details>}{workspace.memories.length > 0 ? <><div className="fl-memory-filters"><button className={memoryType === 'all' ? 'active' : ''} onClick={() => setMemoryType('all')}>全部 {workspace.memories.length}</button>{Object.entries(MEMORY_LABELS).filter(([type]) => workspace.memories.some(item => item.type === type)).map(([type, label]) => <button key={type} className={memoryType === type ? 'active' : ''} onClick={() => setMemoryType(type)}>{label}</button>)}</div><div className="fl-memory-list">{workspace.memories.filter(item => memoryType === 'all' || item.type === memoryType).map(item => <article className={`fl-memory-card ${item.type}`} key={item.id}><div><span>{MEMORY_LABELS[item.type]}</span><button className="fl-icon-button" aria-label={`删除记忆 ${item.title}`} title="删除此条记忆" disabled={actionBusy} onClick={() => void runAction(async () => { const next = await window.folio.deleteMemory(workspace.id, item.id); mergeSnapshot(next); })}><Trash2 size={12} /></button></div><h4>{item.title}</h4><div className="fl-markdown">{md(item.body)}</div>{item.tags.length > 0 && <footer>{item.tags.map(tag => <span key={tag}>#{tag}</span>)}</footer>}</article>)}</div></> : <div className="fl-memory-empty"><div><Brain size={30} strokeWidth={1.2} /></div><h4>灵感正在酝酿</h4><p>开启自动记忆，与 AI 讨论论文后，<br />研究发现和待解问题会逐渐积累。</p><button className="fl-button fl-secondary" onClick={() => setTab('chat')}>开始一段对话 <ArrowUpRight size={13} /></button></div>}</div>}
    {(notice || (error && tab !== 'chat')) && <div className={`fl-assistant-notice ${error && tab !== 'chat' ? 'error' : ''}`} role="status"><span>{error && tab !== 'chat' ? error : <><Check size={12} />{notice}</>}</span><button className="fl-icon-button" aria-label="关闭提示" onClick={() => { setNotice(''); setError(''); }}><X size={12} /></button></div>}
  </aside>;
}
function LayersIcon() { return <FileText size={12} />; }
