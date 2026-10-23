import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import type { ProviderConfig } from '../shared/types';
import { translate, type Language } from '../shared/i18n';
import { qoderEndpoint, qoderReasoningFields } from '../shared/qoder';
import { safeWebSourceUrl, type QoderWebCallEvidence, type WebSearchResult, type WebSearchSource } from '../shared/web-search';

// Matches the local bridge's 600 s web execution/queue budget, with room for
// local transport. Core HTTP avoids fetch's separate 300 s headers timeout.
export const QODER_WEB_TIMEOUT_MS = 660_000;
export const QODER_CHAT_TIMEOUT_MS = 240_000;
export const QODER_MAX_STREAM_BYTES = 16 * 1024 * 1024;
export const QODER_MAX_FRAME_CHARACTERS = 1024 * 1024;
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 4 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
class QoderFailure extends Error {}
const fail = (language: Language, zh: string, en: string): never => { throw new QoderFailure(translate(language, zh, en)); };
const clean = (value: unknown, limit: number, key: string) => typeof value === 'string'
  ? (key ? value.split(key).join('[API Key]') : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
function sourceURL(value: unknown, key: string): string | null {
  const url = safeWebSourceUrl(value);
  return url && !(key && (url.includes(key) || url.includes(encodeURIComponent(key)))) ? url : null;
}

/** Only successful native tool records can attest a source. Answer prose,
 * failed calls and counters without matching calls cannot manufacture evidence.
 * WebFetch summaries stay explicitly labelled, never copied into snippets. */
export function normalizeQoderWebEvidence(input: unknown, query: string, key = '', language: Language = 'zh-CN', now = Date.now()): WebSearchResult {
  const invalid = () => fail(language, 'Qoder 没有返回可核对的联网记录，请重试；本次不能确认已搜索或读取网页。', 'Qoder returned no verifiable web evidence. Retry; this request cannot be confirmed as a completed search and page read.');
  if (!record(input) || input.enabled !== true || !Number.isInteger(input.maxCalls) || (input.maxCalls as number) < 1 || (input.maxCalls as number) > 8
    || !Array.isArray(input.calls) || input.calls.length > (input.maxCalls as number) || !Array.isArray(input.sources) || input.sources.length > 160) return invalid();
  const calls: QoderWebCallEvidence[] = [], ids = new Set<string>(), attested = new Set<string>();
  const summaries: { urls: string[]; text: string }[] = [];
  for (const raw of input.calls) {
    if (!record(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200 || ids.has(raw.id)
      || !['WebSearch', 'WebFetch'].includes(String(raw.name)) || !['success', 'error', 'pending'].includes(String(raw.status))
      || !Array.isArray(raw.sources) || raw.sources.length > 20) return invalid();
    ids.add(raw.id);
    const call: QoderWebCallEvidence = { id: clean(raw.id, 200, key), name: raw.name as QoderWebCallEvidence['name'], status: raw.status as QoderWebCallEvidence['status'],
      sources: [...new Set(raw.sources.map(value => sourceURL(value, key)).filter((value): value is string => !!value))] };
    if (call.name === 'WebSearch') {
      call.query = clean(raw.query, 2000, key);
      if (call.status === 'success' && (!call.query || !Number.isSafeInteger(raw.resultCount) || (raw.resultCount as number) < 0)) return invalid();
      if (Number.isSafeInteger(raw.resultCount) && (raw.resultCount as number) >= 0) call.resultCount = raw.resultCount as number;
    } else {
      call.url = sourceURL(raw.url, key) ?? undefined;
      if (call.status === 'success') {
        if (!call.url || !Number.isInteger(raw.statusCode) || (raw.statusCode as number) < 200 || (raw.statusCode as number) >= 300
          || raw.contentKind !== 'sdk_extracted_or_summarized_page' || typeof raw.summary !== 'string' || !raw.summary.trim()) return invalid();
        call.statusCode = raw.statusCode as number;
        call.contentKind = 'sdk_extracted_or_summarized_page';
        summaries.push({ urls: call.sources, text: clean(raw.summary, 8000, key) });
      }
    }
    if (call.status === 'success') call.sources.forEach(url => attested.add(url));
    calls.push(call);
  }
  const successfulSearches = calls.filter(call => call.name === 'WebSearch' && call.status === 'success').length;
  const successfulFetches = calls.filter(call => call.name === 'WebFetch' && call.status === 'success').length;
  if (!successfulSearches || !successfulFetches || successfulSearches !== input.successfulSearches || successfulFetches !== input.successfulFetches) return invalid();
  const sources: WebSearchSource[] = [], seen = new Set<string>();
  for (const raw of input.sources) {
    if (!record(raw)) continue;
    const url = sourceURL(raw.url, key);
    if (!url || !attested.has(url) || seen.has(url)) continue;
    seen.add(url);
    const publishedAt = clean(raw.publishedAt, 120, key);
    sources.push({ url, title: clean(raw.title, 240, key) || new URL(url).hostname, snippet: clean(raw.snippet, 1200, key),
      ...(publishedAt ? { publishedAt } : {}) });
    if (sources.length === 30) break;
  }
  const summaryParts = summaries.flatMap(item => {
    const url = item.urls.find(value => seen.has(value));
    return url && item.text ? [`${url}\n${item.text}`] : [];
  });
  const label = translate(language, 'Qoder WebFetch 提取或摘要（不是网页逐字原文，不代表已阅读全文）：', 'Qoder WebFetch extraction or summary (not verbatim page text; does not certify full-page reading):');
  return { query: clean(query, 2000, key), searchedAt: now, sources,
    ...(summaryParts.length ? { summary: `${label}\n${summaryParts.join('\n\n')}`.slice(0, 6000) } : {}),
    qoderEvidence: { maxCalls: input.maxCalls as number, successfulSearches, successfulFetches, calls } };
}

export interface QoderCompletion { text: string; finishReason?: string; webSearch?: WebSearchResult }
export interface QoderCompletionOptions { webSearch?: boolean; query?: string; language?: Language; timeoutMs?: number }

/** One selected model, one selected key and one completion. No search-specific
 * second model/request, no redirects, no external DNS or proxy discovery. */
export async function streamQoderCompletion(config: ProviderConfig, wireMessages: readonly unknown[], signal: AbortSignal,
  onDelta: (text: string) => void, options: QoderCompletionOptions = {}): Promise<QoderCompletion> {
  const language = options.language ?? 'zh-CN';
  const message = (zh: string, en: string) => new QoderFailure(translate(language, zh, en));
  if (config.id !== 'qoder') throw message('此调用只用于 Qoder 本机模型。', 'This request is only for the local Qoder provider.');
  const target = new URL(qoderEndpoint(config.baseURL, language));
  const key = config.apiKey?.trim();
  if (!key) throw message('请先保存当前 Qoder 模型的专用 Key。', 'Save the selected Qoder model’s dedicated key first.');
  if (!Array.isArray(wireMessages) || wireMessages.length < 1 || wireMessages.length > 100) throw message('Qoder 每次请求需要 1 至 100 条消息。', 'Qoder requests require between 1 and 100 messages.');
  const maxTokens = config.maxTokens || 8192;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 256 || maxTokens > 32000) throw message('Qoder 最大输出需在 256 至 32000 tokens 之间。', 'Qoder maximum output must be between 256 and 32,000 tokens.');
  const timeoutMs = options.timeoutMs ?? (options.webSearch ? QODER_WEB_TIMEOUT_MS : QODER_CHAT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > QODER_WEB_TIMEOUT_MS) throw message('Qoder 请求时限无效。', 'Invalid Qoder request timeout.');
  const reasoning = qoderReasoningFields(config, language);
  let payload: string;
  try { payload = JSON.stringify({ model: config.model, messages: wireMessages, stream: true, max_tokens: maxTokens,
    ...reasoning, ...(options.webSearch ? { web_search: 'required', web_fetch: 'required' } : {}) }); }
  catch { throw message('Qoder 请求格式无效。', 'Invalid Qoder request.'); }
  if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) throw message('Qoder 请求超过 24 MiB，请减少附图或上下文。', 'The Qoder request exceeds 24 MiB. Reduce attached images or context.');
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  return new Promise<QoderCompletion>((resolve, reject) => {
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, settled = false;
    const finish = (error?: Error, result?: QoderCompletion) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      response?.destroy(); request?.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const cancel = () => finish(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(message('Qoder 请求超时，已保留收到的部分内容。请重试或降低思考深度。', 'The Qoder request timed out. Received partial text was kept; retry or reduce thinking depth.')), timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    const invalid = () => message('Qoder 返回了不完整或无效的数据流，请重试。', 'Qoder returned an incomplete or invalid stream. Please try again.');
    const unavailable = () => message('无法连接 Qoder 本机代理，请确认服务正在运行、端口正确且登录仍有效。', 'Could not connect to the local Qoder bridge. Check that it is running, the port is correct, and the login is valid.');
    try {
      // Resolve the accepted localhost spelling ourselves, never through DNS.
      const hostname = target.hostname === 'localhost' ? '127.0.0.1' : target.hostname.replace(/^\[|\]$/g, '');
      request = http.request({ protocol: 'http:', hostname, port: target.port || 80, path: target.pathname, method: 'POST', agent: false,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(payload) } }, async incoming => {
        response = incoming;
        try {
          const status = incoming.statusCode ?? 0;
          if (status >= 300 && status < 400) throw message('Qoder 本机接口发生跳转，已停止请求。', 'The local Qoder endpoint redirected; the request was stopped.');
          if (status === 401 || status === 403) throw message('Qoder 认证失败，请检查当前型号对应的专用 Key。', 'Qoder authentication failed. Check the dedicated key for the selected model.');
          if (status === 429) throw message('Qoder 当前请求过多，请稍后再试。', 'Qoder is busy with too many requests. Try again shortly.');
          if (status < 200 || status >= 300) throw message(`Qoder 请求失败（HTTP ${status}），请检查模型设置及代理登录状态。`, `Qoder request failed (HTTP ${status}). Check model settings and the bridge login.`);
          if (!incoming.headers['content-type']?.toLowerCase().includes('text/event-stream')) throw invalid();
          const advertisedSize = Number(incoming.headers['content-length']);
          if (Number.isFinite(advertisedSize) && advertisedSize > QODER_MAX_STREAM_BYTES) throw invalid();
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let buffer = '', lines: string[] = [], frameSize = 0, totalBytes = 0, text = '', finishReason: string | undefined, evidence: unknown, done = false;
          const frame = (data: string) => {
            if (data === '[DONE]') { if (!finishReason) throw invalid(); done = true; return; }
            if (done) return;
            let value: unknown;
            try { value = JSON.parse(data); } catch { throw invalid(); }
            if (!record(value) || value.error) throw message('Qoder 未能完成本次请求；部分内容已保留，请检查代理状态后重试。', 'Qoder could not complete the request. Partial text was kept; check the bridge and retry.');
            if (value.model !== config.model || !Array.isArray(value.choices)) throw invalid();
            if (!value.choices.length && value.usage && finishReason) return;
            if (value.choices.length !== 1 || !record(value.choices[0]) || value.choices[0].index !== 0) throw invalid();
            const choice = value.choices[0];
            if (!record(choice.delta) || (Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length)) throw invalid();
            if (finishReason) throw invalid();
            const delta = choice.delta.content;
            if (delta !== undefined && delta !== null && typeof delta !== 'string') throw invalid();
            if (typeof delta === 'string' && delta) {
              text += delta; if (text.length > MAX_TEXT_CHARACTERS) throw invalid(); onDelta(delta);
            }
            if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
              if (!['stop', 'length'].includes(String(choice.finish_reason))) throw invalid();
              finishReason = choice.finish_reason as string;
              evidence = value.qoder_web;
            } else if (value.qoder_web !== undefined) throw invalid();
          };
          const line = (value: string) => {
            if (!value) {
              if (lines.length) frame(lines.join('\n'));
              lines = []; frameSize = 0; return;
            }
            if (value.startsWith(':')) return;
            const colon = value.indexOf(':'), name = colon < 0 ? value : value.slice(0, colon);
            const data = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
            if (name === 'data') { frameSize += data.length; if (frameSize > QODER_MAX_FRAME_CHARACTERS) throw invalid(); lines.push(data); }
          };
          const consume = (ended = false) => {
            let match: RegExpExecArray | null;
            while (!done && (match = /\r\n|\r|\n/.exec(buffer))) {
              if (!ended && match[0] === '\r' && match.index === buffer.length - 1) break;
              const value = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); line(value);
            }
            if (buffer.length > QODER_MAX_FRAME_CHARACTERS) throw invalid();
            if (ended && !done) { if (buffer) line(buffer); buffer = ''; line(''); }
          };
          for await (const chunk of incoming) {
            if (settled) return;
            totalBytes += chunk.length; if (totalBytes > QODER_MAX_STREAM_BYTES) throw invalid();
            buffer += decoder.decode(chunk, { stream: true }); consume();
            if (done) break;
          }
          if (settled) return;
          buffer += decoder.decode(); consume(true);
          if (!done || !finishReason || !text.trim()) throw invalid();
          if (options.webSearch && finishReason !== 'stop') throw message('Qoder 联网回答达到输出上限，已保留部分内容；请提高输出上限后重试。', 'The Qoder web answer reached its output limit. Partial text was kept; increase the output limit and retry.');
          const webSearch = options.webSearch ? normalizeQoderWebEvidence(evidence, options.query ?? '', key, language) : undefined;
          finish(undefined, { text, finishReason, ...(webSearch ? { webSearch } : {}) });
        } catch (error) {
          finish(error instanceof QoderFailure ? error : invalid());
        }
      });
      request.on('error', () => finish(unavailable()));
      request.end(payload);
    } catch { finish(unavailable()); }
  });
}
