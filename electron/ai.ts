import { randomUUID } from 'node:crypto';
import type { ChatEvent, ChatMessage, ChatRequest, Memory, MemoryType, ProviderConfig, Settings, Workspace } from '../shared/types';
import { buildMemoryContext, buildReadingContext, CHAT_SYSTEM, INDEX_SYSTEM, isDuplicateTitle, MEMORY_SYSTEM, sanitizeData, SELECTION_SYSTEM, SUMMARY_SYSTEM } from '../shared/prompts';

export interface AIHost {
  getWorkspace(id: string): Workspace;
  listWorkspaces(): Workspace[];
  getSettings(): Settings;
  getDocumentPages(workspaceId: string, documentId: string): Promise<string[]>;
  mutateWorkspace(id: string, fn: (workspace: Workspace) => void): Promise<Workspace>;
  emit(event: ChatEvent): void;
}
export interface LLMMessage { role: 'system' | 'user' | 'assistant'; content: string }
interface Completion { text: string; finishReason?: string }

function safeError(error: unknown, key = ''): string {
  const message = error instanceof Error ? error.message : String(error);
  return (key ? message.split(key).join('[API Key]') : message).replace(/\bsk-[A-Za-z\d_-]{8,}/g, '[API Key]').slice(0, 700);
}

function endpoint(config: ProviderConfig): string {
  const url = new URL(config.baseURL);
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含用户名、密码、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('API 地址必须使用 HTTPS（本机服务可用 HTTP）。');
  let path = url.pathname.replace(/\/+$/, '');
  if (config.id === 'anthropic') {
    if (!path.endsWith('/messages')) path += path.endsWith('/v1') ? '/messages' : '/v1/messages';
  } else if (!path.endsWith('/chat/completions')) path += '/chat/completions';
  url.pathname = path;
  return url.toString();
}

/** WHATWG SSE, incremental UTF-8 decoding, split CRLF, multiline data, and final frame. */
export async function* readSSE(response: Response): AsyncGenerator<{ event?: string; data: string }> {
  if (!response.body) throw new Error('API 未返回数据流。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let lines: string[] = [];
  const consume = (line: string): { event?: string; data: string } | undefined => {
    if (line === '') {
      const result = lines.length ? { event, data: lines.join('\n') } : undefined;
      lines = []; event = undefined;
      return result;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') lines.push(value);
    if (field === 'event') event = value;
  };
  try {
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      finished = done;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error('API 数据流单帧过大。');
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const result = consume(line);
        if (result) yield result;
      }
      if (done) {
        if (buffer) { const result = consume(buffer); if (result) yield result; }
        const result = consume('');
        if (result) yield result;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** DeepSeek official API verified 2026-09-21:
 * https://api-docs.deepseek.com/api/create-chat-completion/
 * https://api-docs.deepseek.com/guides/thinking_mode/
 * No tools are sent, so reasoning_content need not be retained or replayed.
 */
export async function streamCompletion(config: ProviderConfig, messages: LLMMessage[], signal: AbortSignal, onDelta: (text: string) => void, timeoutMs = 240_000): Promise<Completion> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const anthropic = config.id === 'anthropic';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  const body: Record<string, unknown> = { model: config.model, stream: true, max_tokens: config.maxTokens || 8192 };
  if (anthropic) {
    headers['x-api-key'] = config.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
    body.system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    body.messages = messages.filter(m => m.role !== 'system');
  } else {
    headers.Authorization = `Bearer ${config.apiKey || ''}`;
    body.messages = messages;
    if (config.id === 'deepseek') {
      body.thinking = { type: config.thinking === false ? 'disabled' : 'enabled' };
      if (config.thinking !== false) body.reasoning_effort = config.reasoningEffort || 'high';
    }
  }
  let text = '';
  let finishReason: string | undefined;
  let complete = false;
  try {
    const response = await fetch(endpoint(config), { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      const raw = await response.text();
      let detail = raw.slice(0, 500);
      try { const json = JSON.parse(raw); detail = json?.error?.message || json?.message || detail; } catch { /* Plain errors are also shown. */ }
      throw new Error(`API 请求失败（HTTP ${response.status}）：${detail}`);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('API 未返回 SSE 数据流，请检查服务商和 API 地址。');
    for await (const event of readSSE(response)) {
      controller.signal.throwIfAborted();
      if (event.data.trim() === '[DONE]') { complete = true; break; }
      if (!event.data.trim()) continue;
      let json: any;
      try { json = JSON.parse(event.data); } catch { throw new Error('API 数据流格式损坏，请重试。'); }
      if (json.error || json.type === 'error') throw new Error(json.error?.message || 'API 数据流返回错误。');
      let delta: unknown;
      if (anthropic) {
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') delta = json.delta.text;
        if (json.type === 'message_delta') { finishReason = json.delta?.stop_reason; if (finishReason) complete = true; }
        if (json.type === 'message_stop') { complete = true; break; }
      } else {
        // Drop reasoning_content entirely: never emit it, persist it, or include it in memory extraction.
        delta = json.choices?.[0]?.delta?.content;
        if (json.choices?.[0]?.finish_reason) { finishReason = json.choices[0].finish_reason; complete = true; }
      }
      if (typeof delta === 'string' && delta) { text += delta; onDelta(delta); }
    }
    if (!complete) throw new Error('连接在回答完成前中断；已保留接收到的部分内容。');
    if (!text.trim()) throw new Error('模型未返回可见答案。若已开启深度思考，请增加最大输出 token 后重试。');
    if (finishReason === 'content_filter') throw new Error('服务商拦截了本次回答。');
    return { text, finishReason };
  } catch (error) {
    if (timedOut) throw new Error('API 请求超时；已保留接收到的部分内容，可重试或降低思考深度。');
    if (signal.aborted) throw error;
    throw new Error(safeError(error, config.apiKey));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

const MEMORY_TYPES: MemoryType[] = ['finding', 'interpretation', 'question', 'user-note', 'cross-ref'];
export function parseMemories(raw: string): Omit<Memory, 'id' | 'source' | 'createdAt'>[] {
  const start = raw.indexOf('['), end = raw.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(m => m && MEMORY_TYPES.includes(m.type) && typeof m.title === 'string' && m.title.trim() && typeof m.body === 'string' && m.body.trim())
      .slice(0, 10).map(m => ({
        type: m.type, title: sanitizeData(m.title).slice(0, 120), body: sanitizeData(m.body).slice(0, 1500),
        tags: Array.isArray(m.tags) ? [...new Set<string>(m.tags.filter((t: unknown): t is string => typeof t === 'string').map((t: string) => sanitizeData(t).trim().slice(0, 80)).filter(Boolean))].slice(0, 8) : [],
      }));
  } catch { return []; }
}

export function createAIService(host: AIHost) {
  const active = new Map<string, { workspaceId: string; controller: AbortController; task: Promise<void> }>();
  let disposed = false;
  const emit = (event: ChatEvent) => { if (!disposed) host.emit(event); };

  async function updateMemory(request: ChatRequest, config: ProviderConfig, signal: AbortSignal) {
    signal.throwIfAborted();
    const workspace = host.getWorkspace(request.workspaceId);
    const conversation = workspace.conversations.find(c => c.id === request.conversationId)!;
    // Keep factual final answers only; reasoning deltas are discarded before this layer.
    const data = { article: { title: workspace.title, doi: workspace.doi }, avoid_titles: workspace.memories.map(m => m.title), recent_conversation: conversation.messages.slice(-2).map(m => ({ role: m.role, content: m.content })) };
    const extracted = await streamCompletion(config, [{ role: 'system', content: MEMORY_SYSTEM }, { role: 'user', content: sanitizeData(JSON.stringify(data)) }], signal, () => {}, 60_000);
    signal.throwIfAborted();
    const candidates = parseMemories(extracted.text);
    let updated = await host.mutateWorkspace(workspace.id, ws => {
      if (signal.aborted) return;
      for (const candidate of candidates) {
        const duplicate = ws.memories.find(m => m.type === candidate.type && isDuplicateTitle(m.title, candidate.title));
        if (duplicate) {
          if (duplicate.source !== 'user') { duplicate.body = candidate.body; duplicate.tags = [...new Set([...duplicate.tags, ...candidate.tags])]; }
        } else ws.memories.push({ ...candidate, id: randomUUID(), createdAt: Date.now(), source: 'ai' });
      }
    });
    signal.throwIfAborted();
    const turns = updated.conversations.reduce((sum, c) => sum + c.messages.filter(m => m.role === 'assistant' && !m.interrupted).length, 0);
    if (updated.memories.length && (!updated.memoryIndex.trim() || turns % 6 === 0)) {
      let index: string;
      try {
        const result = await streamCompletion(config, [{ role: 'system', content: INDEX_SYSTEM }, { role: 'user', content: sanitizeData(JSON.stringify(updated.memories.map(m => ({ type: m.type, title: m.title, body: m.body })))) }], signal, () => {}, 60_000);
        index = result.text.split('\n').filter(line => /^\s*[-*]\s+/.test(line)).slice(0, 12).join('\n');
      } catch (error) {
        if (signal.aborted) throw error;
        emit({ requestId: request.requestId, workspaceId: workspace.id, type: 'status', text: `记忆已保存；压缩索引未完成，使用标题索引。${safeError(error, config.apiKey)}` });
        index = '';
      }
      signal.throwIfAborted();
      const finalIndex = sanitizeData(index || updated.memories.slice(0, 12).map(m => `- [${m.type}] ${m.title}`).join('\n'));
      updated = await host.mutateWorkspace(workspace.id, ws => { if (!signal.aborted) ws.memoryIndex = finalIndex; });
    }
    signal.throwIfAborted();
    emit({ requestId: request.requestId, workspaceId: workspace.id, type: 'memory', workspace: updated });
  }

  async function run(request: ChatRequest, settings: Settings, config: ProviderConfig, signal: AbortSignal) {
    const base = { requestId: request.requestId, workspaceId: request.workspaceId };
    let partial = '';
    let saved = false;
    let warnings: string[] = [];
    try {
      const user: ChatMessage = { id: randomUUID(), role: 'user', content: request.prompt || '请生成论文阅读总结。', createdAt: Date.now() };
      let workspace = await host.mutateWorkspace(request.workspaceId, ws => {
        signal.throwIfAborted();
        const conversation = ws.conversations.find(c => c.id === request.conversationId)!;
        conversation.messages.push(user);
        if (conversation.messages.length === 1) conversation.title = user.content.slice(0, 40);
      });
      emit({ ...base, type: 'status', text: '正在读取所选 PDF 的页面文字…', workspace });
      const documents = await Promise.all(request.documentIds.map(async id => {
        const doc = workspace.documents.find(d => d.id === id)!;
        return { id, name: doc.name, pages: await host.getDocumentPages(workspace.id, id) };
      }));
      signal.throwIfAborted();
      const context = buildReadingContext(workspace, documents, settings.contextMaxChars, request.selection);
      warnings = context.warnings;
      if (!context.hasText) throw new Error('所选 PDF 没有可提取文字。请等待文档索引完成，或先对扫描件进行 OCR，再使用 AI 阅读。');
      const memory = buildMemoryContext(workspace, host.listWorkspaces());
      const memoryLimit = Math.max(2000, Math.floor(settings.contextMaxChars / 4));
      let memoryContext = memory;
      if (memory.length > memoryLimit) {
        // Wrap truncated data anew so no structural boundary is left open.
        memoryContext = `<memory_excerpt>\n${sanitizeData(memory.slice(0, memoryLimit))}\n[记忆与笔记上下文已截断]\n</memory_excerpt>`;
        warnings.push('记忆与笔记上下文超过本次配额，已截断。');
      }
      const prior = workspace.conversations.find(c => c.id === request.conversationId)!.messages.slice(0, -1).filter(m => !m.interrupted);
      const history: LLMMessage[] = [];
      let historySize = 0;
      const historyLimit = Math.max(4000, Math.floor(settings.contextMaxChars / 2));
      for (let i = prior.length - 1; i >= 0; i--) {
        const item = prior[i];
        if (historySize + item.content.length > historyLimit) break;
        history.unshift({ role: item.role, content: item.content }); historySize += item.content.length;
      }
      // Anthropic conversations must begin with a user turn.
      while (history[0]?.role === 'assistant') history.shift();
      if (history.length < prior.length) warnings.push(`本次仅附带最近 ${history.length} 条对话，较早对话未发送。`);
      const instruction = request.kind === 'summary' ? SUMMARY_SYSTEM : request.selection ? SELECTION_SYSTEM : CHAT_SYSTEM;
      const messages: LLMMessage[] = [
        { role: 'system', content: instruction },
        { role: 'user', content: `${context.content}\n\n${memoryContext}\n\n以上为本次阅读的参考数据。` },
        ...history,
        { role: 'user', content: request.prompt || '请生成论文阅读总结。' },
      ];
      emit({ ...base, type: 'status', text: warnings.length ? warnings.join('\n') : '正在生成回答…' });
      const result = await streamCompletion(config, messages, signal, delta => { partial += delta; emit({ ...base, type: 'delta', text: delta }); });
      signal.throwIfAborted();
      if (['length', 'max_tokens'].includes(result.finishReason || '')) warnings.push('达到最大输出 token，回答可能尚未完整；可提高上限后继续提问。');
      const content = result.text + (warnings.length ? `\n\n> 上下文与输出说明：${warnings.join(' ')}` : '');
      workspace = await host.mutateWorkspace(workspace.id, ws => {
        signal.throwIfAborted();
        ws.conversations.find(c => c.id === request.conversationId)!.messages.push({ id: randomUUID(), role: 'assistant', content, createdAt: Date.now(), provider: config.id, model: config.model });
        if (request.kind === 'summary') ws.summary = { content, provider: config.id, model: config.model, createdAt: Date.now() };
      });
      saved = true;
      if (settings.autoMemory) {
        emit({ ...base, type: 'status', text: '回答已保存，正在提取长期记忆…', workspace });
        try { await updateMemory(request, config, signal); }
        catch (error) {
          if (!signal.aborted) emit({ ...base, type: 'status', text: `回答已保存；本次记忆提取失败：${safeError(error, config.apiKey)}` });
        }
      }
      emit({ ...base, type: 'done', workspace: host.getWorkspace(workspace.id) });
    } catch (error) {
      let workspace: Workspace | undefined;
      if (partial && !saved) {
        try {
          workspace = await host.mutateWorkspace(request.workspaceId, ws => {
            ws.conversations.find(c => c.id === request.conversationId)?.messages.push({ id: randomUUID(), role: 'assistant', content: partial + '\n\n> 回答已中断，以上为部分内容。', createdAt: Date.now(), provider: config.id, model: config.model, interrupted: true });
          });
        } catch { /* A workspace may have been deleted during cancellation. */ }
      }
      if (!workspace) { try { workspace = host.getWorkspace(request.workspaceId); } catch { /* Deleted. */ } }
      if (signal.aborted) emit({ ...base, type: 'done', workspace, interrupted: !saved, text: saved ? '回答已保存，已停止记忆提取。' : '已停止生成。' });
      else emit({ ...base, type: 'error', workspace, text: safeError(error, config.apiKey) });
    } finally {
      active.delete(request.requestId);
    }
  }

  const drain = async () => { await Promise.allSettled([...active.values()].map(item => item.task)); };
  return {
    async start(request: ChatRequest): Promise<void> {
      if (disposed) throw new Error('AI 服务已关闭。');
      if (!request.requestId || active.has(request.requestId)) throw new Error('请求编号无效或重复。');
      const workspace = host.getWorkspace(request.workspaceId);
      if ([...active.values()].some(item => item.workspaceId === workspace.id)) throw new Error('此论文已有生成任务，请等待完成或先停止。');
      if (!workspace.conversations.some(c => c.id === request.conversationId)) throw new Error('会话不存在，请重新打开论文。');
      if (request.kind !== 'chat' && request.kind !== 'summary') throw new Error('请求类型无效。');
      if (request.kind === 'chat' && !request.prompt.trim()) throw new Error('请输入问题。');
      if (!request.documentIds.length || request.documentIds.some(id => !workspace.documents.some(d => d.id === id))) throw new Error('请选择此论文工作区中的 PDF。');
      if (request.selection && (!request.documentIds.includes(request.selection.documentId) || !Number.isInteger(request.selection.page) || request.selection.page < 1)) throw new Error('选段不属于所选 PDF，或页码无效。');
      const indexing = workspace.documents.filter(doc => request.documentIds.includes(doc.id) && !doc.textStatus && !(request.selection?.documentId === doc.id && request.selection.text.trim()));
      if (indexing.length) throw new Error(`所选 PDF 的文字索引尚未完成：${indexing.map(doc => doc.name).join('、')}。请等待索引完成后重试；加密 PDF 请先打开并输入密码。`);
      const settings = structuredClone(host.getSettings());
      const config = settings.providers[settings.activeProvider];
      if (!config?.apiKey?.trim()) throw new Error('请先在设置中输入 API Key。');
      if (!config.model?.trim()) throw new Error('请先在设置中选择模型。');
      endpoint(config);
      if (!Number.isFinite(settings.contextMaxChars) || settings.contextMaxChars < 1000) throw new Error('上下文字符上限必须至少为 1000。');
      if (!Number.isInteger(config.maxTokens) || config.maxTokens < 1 || config.maxTokens > 393216) throw new Error('最大输出 token 必须介于 1 和 393216。');
      const controller = new AbortController();
      const job = { workspaceId: workspace.id, controller, task: Promise.resolve() };
      active.set(request.requestId, job);
      // Reserve synchronously; IPC returns immediately, then all lifecycle events carry request + workspace ids.
      job.task = run(structuredClone({ ...request, documentIds: [...new Set(request.documentIds)] }), settings, config, controller.signal);
    },
    abort(requestId: string) { active.get(requestId)?.controller.abort(); },
    async cancelWorkspace(workspaceId: string) {
      const jobs = [...active.values()].filter(item => item.workspaceId === workspaceId);
      for (const job of jobs) job.controller.abort();
      await Promise.allSettled(jobs.map(job => job.task));
    },
    drain,
    async dispose() { disposed = true; for (const item of active.values()) item.controller.abort(); await drain(); },
  };
}
