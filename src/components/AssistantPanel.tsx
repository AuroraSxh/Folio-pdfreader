import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownToLine, ArrowUp, ArrowUpRight, BookOpen, Brain, Check, CheckCheck, ChevronDown, Clipboard, Copy, FileText, FlaskConical, Highlighter, History, Lightbulb, LoaderCircle, MessageSquare, NotebookPen, Plus, RefreshCw, Settings2, Sparkles, Square, Trash2, X } from 'lucide-react';
import type { ChatRequest, Settings, TextSelection, Workspace } from '../../shared/types';
import { useI18n } from '../i18n';
import { getSummaryPrompt } from '../../shared/prompts';
import './ui-components.css';

type UiNotice = { zh: string; en: string; values?: Record<string, string | number> };
interface Props {
  workspace: Workspace; settings: Settings; selection: TextSelection | null;
  onClearSelection: () => void; onWorkspace: (ws: Workspace) => void;
  onSettings: () => void; onError: (message: string) => void;
  onNavigate: (docId: string, page: number) => void;
  focusRequest?: { workspaceId: string; nonce: number };
  panelControls?: ReactNode;
  dragHandleProps?: HTMLAttributes<HTMLElement>;
}
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
  const { t } = useI18n();
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
    img: ({ alt }) => <span className="fl-markdown-image">{t("[图片：{alt}]", "[Image: {alt}]", { alt: alt || t("外部图片", "External image") })}</span>,
  }), [onNavigate, onError, t]);
  return <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} urlTransform={markdownURL} components={components}>{withCitations}</ReactMarkdown>;
});

export default function AssistantPanel({ workspace, settings, selection, onClearSelection, onWorkspace, onSettings, onError, onNavigate, focusRequest, panelControls, dragHandleProps }: Props) {
  const { language, locale, t } = useI18n();
  const STARTERS = useMemo(() => [
  { title: t("总结这篇论文", "Summarize this paper"), detail: t("抓住问题、方法与核心发现", "Questions, methods, and key findings"), icon: Sparkles, prompt: getSummaryPrompt(language), kind: 'summary' },
  { title: t("拆解研究方法", "Explore the methods"), detail: t("理解实验设计与分析路径", "Study design and analysis, explained"), icon: FlaskConical, prompt: t("请详细解释这篇论文的方法和实验设计，逐步拆解流程，说明关键假设、对照组、统计方法与可重复性，并标明引用页码。", "Explain the methods and experimental design step by step, including key assumptions, controls, statistical methods, and reproducibility. Cite the relevant page numbers."), kind: 'chat' },
  { title: t("读懂结果与图表", "Understand the results"), detail: t("联系正文与补充材料", "Connect the paper and supplements"), icon: BookOpen, prompt: t("请根据 PDF 中可提取的图注和正文，整理关键图表对应的研究问题、结果和结论，并结合补充材料分析；不能看到图像细节时请明确说明，不要猜测，并引用页码。", "Using the extracted PDF text and figure captions, explain the research questions, results, and conclusions behind the key figures and tables, alongside supplementary material. State clearly when image details are unavailable, do not guess, and cite page numbers."), kind: 'chat' },
  { title: t("找出值得追问的点", "Find the next questions"), detail: t("局限、证据与下一步研究", "Limitations, evidence, and next steps"), icon: Lightbulb, prompt: t("请批判性分析这篇论文的证据强度、潜在偏倚和局限，区分作者结论与推测，并提出三个值得进一步研究的问题。请引用页码。", "Critically assess the strength of evidence, potential biases, and limitations. Distinguish the authors’ conclusions from speculation, propose three questions for further research, and cite page numbers."), kind: 'chat' },
] as const, [language, t]);
  const memoryLabels = useMemo(() => ({ finding: t('研究发现', 'Findings'), interpretation: t('分析解读', 'Interpretations'), question: t('待解问题', 'Open questions'), 'user-note': t('个人关注', 'Personal interests'), 'cross-ref': t('跨文关联', 'Cross-paper links') }), [t]);
  const [tab, setTab] = useState<'chat' | 'notes' | 'memory'>('chat');
  const [input, setInput] = useState('');
  const [source, setSource] = useState('all');
  const [stream, setStream] = useState('');
  const [pendingPrompt, setPendingPrompt] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | UiNotice>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<UiNotice | null>(null);
  const [notes, setNotes] = useState(workspace.notes);
  const [notesStatus, setNotesStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [notesPreview, setNotesPreview] = useState(false);
  const [clipboardSelection, setClipboardSelection] = useState<TextSelection | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [memoryType, setMemoryType] = useState('all');
  const currentRef = useRef({ workspace, settings, onWorkspace, onError, onNavigate, onClearSelection, t });
  currentRef.current = { workspace, settings, onWorkspace, onError, onNavigate, onClearSelection, t };
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
      } catch (cause) { if (mounted.current) setNotesStatus('error'); currentRef.current.onError(currentRef.current.t("笔记保存失败：{error}", "Could not save notes: {error}", { error: errorText(cause) })); throw cause; }
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
      setStatus(event.text || { zh: "正在阅读论文…", en: "Reading the paper…" });
      if (event.workspace) { mergeSnapshot(event.workspace); setPendingPrompt(''); if (event.workspace.conversations.find(item => item.id === requestRef.current?.conversationId)?.messages.at(-1)?.role === 'assistant') streamAccumulator.clear(); }
    }
    if (event.type === 'done' || event.type === 'error') {
      // Persisted completion is authoritative, including the last buffered token.
      // If a transport error has no snapshot, keep all received partial text.
      if (event.workspace) { mergeSnapshot(event.workspace); setPendingPrompt(''); streamAccumulator.clear(); }
      else streamAccumulator.flush();
      if (event.type === 'error') setError(event.text || currentRef.current.t("请求失败，请检查 API 设置后重试。", "Request failed. Check your API settings and try again."));
      if (event.interrupted) setNotice({ zh: "已停止生成", en: "Generation stopped" });
      requestRef.current = null; setRequestId(null); setStatus('');
    }
  }), [mergeSnapshot, streamAccumulator]);

  const send = useCallback(async (promptText: string, kind: ChatRequest['kind'] = 'chat', selectionOverride?: TextSelection | null, sourceOverride?: string[]) => {
    if (!promptText.trim() || requestRef.current) return;
    const current = currentRef.current;
    const active = current.settings.providers[current.settings.activeProvider];
    if (!active.hasKey && !active.apiKey) { setError(current.t("请先在设置中填写 API Key。", "Add your API key in Settings first.")); return; }
    const id = crypto.randomUUID();
    const preliminary: ChatRequest = { requestId: id, workspaceId: current.workspace.id, conversationId: current.workspace.activeConversationId, prompt: promptText.trim(), kind, documentIds: sourceOverride ?? (source === 'all' ? current.workspace.documents.map(doc => doc.id) : [source]), selection: selectionOverride !== undefined ? selectionOverride ?? undefined : chosenSelection ?? undefined };
    requestRef.current = preliminary; lastRequest.current = preliminary;
    followStream.current = true;
    streamAccumulator.clear();
    setRequestId(id); setPendingPrompt(promptText.trim()); setError(''); setNotice(null); setStatus({ zh: "正在准备论文上下文…", en: "Preparing paper context…" }); setInput(''); setTab('chat');
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
    void send(getSummaryPrompt(currentRef.current.settings.language), 'summary', null, workspace.documents.map(doc => doc.id));
  }, [settings.autoSummary, hasKey, workspace.summary, workspace.documents, messages.length, send, language]);

  const runAction = async (action: () => Promise<void>) => {
    setActionBusy(true); setError(''); setNotice(null);
    try { await action(); } catch (cause) { setError(errorText(cause)); } finally { if (mounted.current) setActionBusy(false); }
  };
  const exportNotes = (target: 'file' | 'obsidian') => runAction(async () => {
    await flushNotes();
    if (target === 'obsidian' && !settings.vaultPath) { onSettings(); return; }
    const result = await window.folio.exportMarkdown(workspace.id, target);
    if (result) setNotice({ zh: "已导出：{path}", en: "Exported: {path}", values: { path: result.path } });
  });
  const addToNotes = (text: string) => { setNotes(previous => `${previous.trim()}${previous.trim() ? '\n\n---\n\n' : ''}${text}`); setNotesStatus('saving'); setNotice({ zh: "已加入个人笔记", en: "Added to personal notes" }); };
  const copyText = async (text: string) => { try { await navigator.clipboard.writeText(text); setNotice({ zh: "已复制", en: "Copied" }); } catch (cause) { setError(errorText(cause)); } };
  const stopGeneration = () => {
    const activeRequest = requestRef.current;
    if (!activeRequest) return;
    streamAccumulator.flush();
    void window.folio.abortChat(activeRequest.requestId).catch(cause => setError(errorText(cause)));
  };
  const md = (text: string) => <MemoMarkdown text={text} citationKey={citationKey} onNavigate={navigateCitation} onError={markdownError} />;

  return <aside className="fl-assistant" aria-label={t("论文阅读助手", "Paper reading assistant")}>
    <header className="fl-assistant-header" data-draggable={Boolean(dragHandleProps)} {...dragHandleProps}><span className="fl-assistant-logo"><Sparkles size={18} /></span><div><strong>{t("阅读伙伴", "Reading companion")}</strong><span>{dragHandleProps?t("拖动标题栏，自由移动", "Drag the header to move"):t("让理解，再深入一点。", "Take your understanding further.")}</span></div><span className="assistant-panel-controls"><button className="fl-icon-button" aria-label={t("AI 设置", "AI settings")} title={t("AI 设置", "AI settings")} onClick={onSettings}><Settings2 size={16} /></button>{panelControls}</span></header>
    <div className="fl-assistant-tabs" role="tablist">{[{ id: 'chat', label: t("对话", "Chat"), icon: MessageSquare }, { id: 'notes', label: t("笔记", "Notes"), icon: NotebookPen }, { id: 'memory', label: t("记忆", "Memory"), icon: Brain }].map(item => <button role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => setTab(item.id as typeof tab)}><item.icon size={14} />{item.label}{item.id === 'memory' && workspace.memories.length > 0 && <span>{workspace.memories.length}</span>}</button>)}</div>

    {tab === 'chat' && <>
      <div className="fl-conversation-bar"><History size={13} /><select aria-label={t("历史对话", "Conversation history")} value={conversation?.id ?? ''} disabled={!!requestId || actionBusy} onChange={event => void runAction(async () => { const next = await window.folio.updateWorkspace(workspace.id, { activeConversationId: event.target.value }); mergeSnapshot(next); setPendingPrompt(''); streamAccumulator.clear(); })}>{!conversation && <option value="">{t("新的阅读对话", "New reading conversation")}</option>}{workspace.conversations.map(item => <option key={item.id} value={item.id}>{item.title || t("新的阅读对话", "New reading conversation")}</option>)}</select><button className="fl-icon-button" title={t("新建对话", "New conversation")} aria-label={t("新建对话", "New conversation")} disabled={!!requestId || actionBusy} onClick={() => void runAction(async () => { const next = await window.folio.newConversation(workspace.id); mergeSnapshot(next); setPendingPrompt(''); streamAccumulator.clear(); })}><Plus size={15} /></button></div>
      <div className="fl-chat-scroll" ref={scrollRef} onScroll={event => { const element = event.currentTarget; followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
        {!messages.length && !pendingPrompt && <div className="fl-chat-welcome"><div className="fl-ai-orb"><Sparkles size={24} strokeWidth={1.3} /></div><h3>{t("一起，读懂这篇论文。", "Read this paper together.")}</h3><p>{t("从一个问题开始。也可以在 PDF 中选中一段，让我们从那里深入。", "Start with a question, or select a passage in the PDF to explore it together.")}</p>{!hasKey && <button className="fl-key-cta" onClick={onSettings}><span><Settings2 size={15} /><strong>{t("连接你的 AI 服务", "Connect your AI service")}</strong><small>{t("填写 API Key 后开始对话", "Add your API key to start chatting")}</small></span><ArrowUpRight size={17} /></button>}<div className="fl-starters">{STARTERS.map(item => <button key={item.title} disabled={!!requestId} onClick={() => hasKey ? void send(item.prompt, item.kind) : onSettings()}><item.icon size={16} /><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowUpRight size={13} /></button>)}</div><div className="fl-context-note"><FileText size={12} /> {t("结合本文与补充材料，回答附带页码。", "Answers draw on the paper and supplements, with page citations.")}</div></div>}
        {messages.map(message => <article className={`fl-message ${message.role}`} key={message.id}>{message.role === 'assistant' && <div className="fl-message-author"><span><Sparkles size={12} /></span>Folio <small>{message.model}</small></div>}<div className={message.role === 'assistant' ? 'fl-markdown' : 'fl-user-message'}>{message.role === 'assistant' ? md(message.content) : message.content}</div>{message.interrupted && <span className="fl-interrupted">{t("已停止生成", "Generation stopped")}</span>}{message.role === 'assistant' && message.content && <div className="fl-message-actions"><button title={t("复制回复", "Copy response")} onClick={() => void copyText(message.content)}><Copy size={12} /> {t("复制", "Copy")}</button><button title={t("添加到个人笔记", "Add to personal notes")} onClick={() => addToNotes(message.content)}><NotebookPen size={12} /> {t("存为笔记", "Save to notes")}</button></div>}</article>)}
        {pendingPrompt && <article className="fl-message user"><div className="fl-user-message">{pendingPrompt}</div></article>}
        {(requestId || stream) && <article className="fl-message assistant"><div className="fl-message-author"><span><Sparkles size={12} /></span>Folio <small>{provider.model}</small></div>{stream ? <div className="fl-markdown fl-streaming">{md(stream)}</div> : <div className="fl-thinking"><span /><span /><span /><small>{(status ? typeof status === "string" ? status : t(status.zh, status.en, status.values) : t("正在思考…", "Thinking…"))}</small></div>}</article>}
        {error && <div className="fl-inline-error" role="alert"><span>{error}</span>{!requestId && lastRequest.current && <button onClick={() => { const previous = lastRequest.current; if (previous) void send(previous.prompt, previous.kind, previous.selection, previous.documentIds); }}><RefreshCw size={12} /> {t("重试", "Retry")}</button>}</div>}
      </div>
      <div className="fl-composer-area">
        {chosenSelection && <div className="fl-selection-context"><div><Highlighter size={12} /><span>{t('{name} · 第 {page} 页', '{name} · p. {page}', { name: chosenSelection.documentName, page: chosenSelection.page })}</span><button className="fl-icon-button" aria-label={t("清除选中文字", "Clear selected text")} onClick={() => { onClearSelection(); setClipboardSelection(null); }}><X size={12} /></button></div><blockquote>{chosenSelection.text}</blockquote></div>}
        <div className="fl-composer"><textarea ref={inputRef} value={input} onChange={event => setInput(event.target.value)} aria-label={t("向 AI 提问", "Ask AI")} placeholder={hasKey ? t("关于这篇论文，你想了解什么？", "What would you like to know about this paper?") : t("先连接 AI 服务，再开始讨论…", "Connect an AI service to start discussing…")} rows={3} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!requestId) void send(input); } if (event.key === 'Escape' && requestRef.current) stopGeneration(); }} /><div className="fl-composer-bottom"><label className="fl-source-picker"><LayersIcon /><select aria-label={t("AI 引用文档范围", "AI source documents")} value={source} onChange={event => setSource(event.target.value)}><option value="all">{t('全部文档 · {count}', 'All documents · {count}', { count: workspace.documents.length })}</option>{workspace.documents.map(doc => <option value={doc.id} key={doc.id}>{doc.role === 'main' ? t("正文", "Main") : t("补充", "Supplement")} · {doc.name}</option>)}</select><ChevronDown size={10} /></label><button className="fl-icon-button" title={t("粘贴剪贴板文字作为引用", "Paste clipboard text as a quote")} aria-label={t("粘贴引用", "Paste quote")} disabled={!!requestId} onClick={() => void runAction(async () => { const text = await navigator.clipboard.readText(); if (!text.trim()) throw new Error(t("剪贴板为空，请先复制需要讨论的文字。", "The clipboard is empty. Copy the passage you want to discuss first.")); const doc = workspace.documents.find(item => item.id === workspace.layout.leftId) ?? workspace.documents[0]; if (!doc) throw new Error(t("请先导入 PDF 文档。", "Import a PDF first.")); setClipboardSelection({ text, documentId: doc.id, documentName: doc.name, page: doc.view.page, rects: [] }); })}><Clipboard size={14} /></button>{requestId ? <button className="fl-send-button stopping" aria-label={t("停止生成", "Stop generation")} title={t("停止生成", "Stop generation")} onClick={stopGeneration}><Square size={13} fill="currentColor" /></button> : <button className="fl-send-button" aria-label={t("发送问题", "Send question")} title={t("发送 · Enter", "Send · Enter")} disabled={!input.trim() || !hasKey || actionBusy} onClick={() => void send(input)}><ArrowUp size={17} /></button>}</div></div>
        <div className="fl-composer-caption"><button onClick={onSettings}><span className={`fl-small-dot ${hasKey ? '' : 'muted'}`} />{provider.model}{provider.thinking !== false && settings.activeProvider === 'deepseek' && t(" · 思考", " · Thinking")}</button><span>{t("↵ 发送 · ⇧↵ 换行", "↵ Send · ⇧↵ New line")}</span></div>
      </div>
    </>}

    {tab === 'notes' && <div className="fl-notes-panel">
      <div className="fl-panel-scroll">
        <div className="fl-notes-heading"><div><span className="fl-eyebrow">THINK IN YOUR OWN WORDS</span><h3>{t("把理解，写下来。", "Put your understanding into words.")}</h3></div><span className={`fl-notes-status ${notesStatus === 'error' ? 'error' : ''}`}>{notesStatus === 'saving' ? <><LoaderCircle size={11} className="fl-spin" /> {t("保存中", "Saving")}</> : notesStatus === 'error' ? t("保存失败", "Save failed") : <><CheckCheck size={12} /> {t("已保存", "Saved")}</>}</span></div>
        <div className="fl-note-editor-heading"><strong>{t("我的笔记", "My notes")}</strong><div className="fl-segmented"><button className={!notesPreview ? 'active' : ''} onClick={() => setNotesPreview(false)}>{t("编辑", "Edit")}</button><button className={notesPreview ? 'active' : ''} onClick={() => setNotesPreview(true)}>{t("预览", "Preview")}</button></div></div>
        {notesPreview ? <div className="fl-note-preview fl-markdown">{notes.trim() ? md(notes) : <p className="fl-muted">{t("还没有笔记，写下第一个想法吧。", "No notes yet. Write down your first thought.")}</p>}</div> : <textarea className="fl-notes-editor" aria-label={t("个人阅读笔记", "Personal reading notes")} value={notes} onChange={event => { setNotes(event.target.value); setNotesStatus('saving'); }} onBlur={() => void flushNotes().catch(() => {})} placeholder={t("这篇论文让我想到…\n\n## 核心发现\n\n## 我的疑问\n\n## 下一步\n\n支持 Markdown，输入后自动保存。", "This paper makes me think…\n\n## Key findings\n\n## My questions\n\n## Next steps\n\nMarkdown supported. Notes save automatically.")} />}
        <p className="fl-note-hint"><Brain size={12} /> {t("笔记会作为上下文参与后续 AI 对话。", "Your notes provide context for future AI conversations.")}</p>
        <section className="fl-summary-section"><div><span><Sparkles size={14} /><strong>{t("AI 阅读摘要", "AI paper summary")}</strong></span><button className="fl-text-link" disabled={!!requestId || !hasKey} onClick={() => void send(STARTERS[0].prompt, 'summary')}>{workspace.summary ? t("重新生成", "Regenerate") : t("生成摘要", "Generate summary")}<ArrowUpRight size={12} /></button></div>{workspace.summary ? <><div className="fl-markdown">{md(workspace.summary.content)}</div><span className="fl-summary-meta">{workspace.summary.model} · {new Date(workspace.summary.createdAt).toLocaleDateString(locale)}</span></> : <p>{t("生成一份结构化摘要，提炼研究问题、方法与主要结论。", "Generate a structured summary of the research question, methods, and main conclusions.")}</p>}</section>
      </div>
      <div className="fl-notes-export"><button className="fl-button fl-obsidian-button" disabled={actionBusy} onClick={() => void exportNotes('obsidian')}><span>◇</span> {t("导出到 Obsidian", "Export to Obsidian")} <ArrowUpRight size={14} /></button><button className="fl-icon-button" aria-label={t("导出 Markdown 文件", "Export Markdown file")} title={t("导出 Markdown", "Export Markdown")} disabled={actionBusy} onClick={() => void exportNotes('file')}><ArrowDownToLine size={17} /></button></div>
    </div>}

    {tab === 'memory' && <div className="fl-memory-panel fl-panel-scroll"><div className="fl-notes-heading"><div><span className="fl-eyebrow">IDEAS THAT STAY WITH YOU</span><h3>{t("阅读，会留下痕迹。", "Keep the ideas that matter.")}</h3></div><Brain size={21} /></div><p className="fl-memory-intro">{t("对话中的发现与问题会沉淀在这里，在下一次讨论中继续生长。", "Findings and questions from your conversations stay here for your next discussion.")}</p>{!settings.autoMemory && <button className="fl-memory-off" onClick={onSettings}>{t("自动记忆当前已关闭", "Automatic memory is off")} <Settings2 size={12} /></button>}{workspace.memoryIndex && <details className="fl-memory-index"><summary><Brain size={14} /> {t("阅读记忆索引", "Reading memory index")}<ChevronDown size={12} /></summary><div className="fl-markdown">{md(workspace.memoryIndex)}</div></details>}{workspace.memories.length > 0 ? <><div className="fl-memory-filters"><button className={memoryType === 'all' ? 'active' : ''} onClick={() => setMemoryType('all')}>{t('全部 {count}', 'All {count}', { count: workspace.memories.length })}</button>{Object.entries(memoryLabels).filter(([type]) => workspace.memories.some(item => item.type === type)).map(([type, label]) => <button key={type} className={memoryType === type ? 'active' : ''} onClick={() => setMemoryType(type)}>{label}</button>)}</div><div className="fl-memory-list">{workspace.memories.filter(item => memoryType === 'all' || item.type === memoryType).map(item => <article className={`fl-memory-card ${item.type}`} key={item.id}><div><span>{memoryLabels[item.type]}</span><button className="fl-icon-button" aria-label={t("删除记忆 {title}", "Delete memory {title}", { title: item.title })} title={t("删除此条记忆", "Delete this memory")} disabled={actionBusy} onClick={() => void runAction(async () => { const next = await window.folio.deleteMemory(workspace.id, item.id); mergeSnapshot(next); })}><Trash2 size={12} /></button></div><h4>{item.title}</h4><div className="fl-markdown">{md(item.body)}</div>{item.tags.length > 0 && <footer>{item.tags.map(tag => <span key={tag}>#{tag}</span>)}</footer>}</article>)}</div></> : <div className="fl-memory-empty"><div><Brain size={30} strokeWidth={1.2} /></div><h4>{t("灵感正在酝酿", "Ideas will grow here")}</h4><p>{t("开启自动记忆，与 AI 讨论论文后，", "Enable automatic memory and discuss the paper with AI.")}<br />{t("研究发现和待解问题会逐渐积累。", "Findings and open questions will collect here.")}</p><button className="fl-button fl-secondary" onClick={() => setTab('chat')}>{t("开始一段对话", "Start a conversation")} <ArrowUpRight size={13} /></button></div>}</div>}
    {(notice || (error && tab !== 'chat')) && <div className={`fl-assistant-notice ${error && tab !== 'chat' ? 'error' : ''}`} role="status"><span>{error && tab !== 'chat' ? error : <><Check size={12} />{notice && t(notice.zh, notice.en, notice.values)}</>}</span><button className="fl-icon-button" aria-label={t("关闭提示", "Dismiss notification")} onClick={() => { setNotice(null); setError(''); }}><X size={12} /></button></div>}
  </aside>;
}
function LayersIcon() { return <FileText size={12} />; }
