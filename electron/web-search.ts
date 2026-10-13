import type { ProviderConfig } from '../shared/types';
import { translate, type Language } from '../shared/i18n';
import { safeWebSourceUrl, webSearchProvider, type NativeWebSearchProvider, type WebSearchResult, type WebSearchSource } from '../shared/web-search';

// Official native search contract, verified 2026-10-13:
// https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/#using-web-search-in-claude-code
// https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/src/provider.ts
export const WEB_SEARCH_TIMEOUT_MS = 90_000;
export const WEB_SEARCH_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_QUERY_CHARACTERS = 2000;
class SearchFailure extends Error {}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const labels: Record<NativeWebSearchProvider, string> = { deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic', kimi: 'Kimi', glm: 'GLM' };
const cleanText = (value: unknown, limit: number, key: string): string => typeof value === 'string'
  ? value.split(key).join('[API Key]').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(new DOMException('Aborted', 'AbortError')); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readBoundedJSON(response: Response, signal: AbortSignal, language: Language): Promise<unknown> {
  const failure = () => new SearchFailure(translate(language, '联网搜索返回的数据过大或格式不正确，请重试。', 'Web search returned an oversized or invalid response. Please try again.'));
  const size = Number(response.headers.get('content-length'));
  if (size > WEB_SEARCH_MAX_RESPONSE_BYTES || !response.body) { void response.body?.cancel().catch(() => {}); throw failure(); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > WEB_SEARCH_MAX_RESPONSE_BYTES) throw failure();
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw failure(); }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function searchSources(payload: unknown, key: string, language: Language): WebSearchSource[] {
  const failure = (zh: string, en: string) => new SearchFailure(translate(language, zh, en));
  if (!record(payload) || !Array.isArray(payload.content) || payload.error) throw failure('联网搜索返回了无效结果，请重试。', 'Web search returned an invalid result. Please try again.');
  if (payload.stop_reason === 'pause_turn') throw failure('联网搜索尚未完成，请重试。', 'Web search has not completed. Please try again.');
  const blocks = payload.content.filter(record);
  const results = blocks.filter(block => block.type === 'web_search_tool_result');
  if (!results.length) throw failure('当前模型未返回实际搜索结果，请重试或关闭联网搜索。', 'The current model returned no actual search results. Retry or turn off web search.');
  const clean = (value: unknown, limit: number) => cleanText(value, limit, key);
  const snippets = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== 'text' || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations) {
      if (!record(citation)) continue;
      const url = safeWebSourceUrl(citation.url), snippet = clean(citation.cited_text, 1200);
      if (url && snippet && !snippets.has(url)) snippets.set(url, snippet);
    }
  }
  const sources: WebSearchSource[] = [], seen = new Set<string>();
  for (const block of results) {
    if (!Array.isArray(block.content)) {
      if (record(block.content) && block.content.type === 'web_search_tool_result_error') throw failure('联网搜索暂时不可用或已达到搜索限制，请稍后重试。', 'Web search is unavailable or its search limit was reached. Please try again later.');
      throw failure('联网搜索结果格式不正确，请重试。', 'Web search results have an invalid format. Please try again.');
    }
    for (const item of block.content) {
      if (!record(item) || item.type !== 'web_search_result') continue;
      const url = safeWebSourceUrl(item.url);
      if (!url || url.includes(key) || url.includes(encodeURIComponent(key)) || seen.has(url)) continue;
      seen.add(url);
      const publishedAt = clean(item.page_age, 120);
      sources.push({ url, title: clean(item.title, 240) || new URL(url).hostname, snippet: snippets.get(url) ?? '', ...(publishedAt ? { publishedAt } : {}) });
    }
  }
  return sources.slice(0, 8);
}

function normalizedSources(items: RecordValue[], key: string): WebSearchSource[] {
  const byUrl = new Map<string, WebSearchSource>();
  for (const item of items) {
    const url = safeWebSourceUrl(item.url);
    if (!url || url.includes(key) || url.includes(encodeURIComponent(key))) continue;
    const title = cleanText(item.title, 240, key), snippet = cleanText(item.snippet, 1200, key), publishedAt = cleanText(item.publishedAt, 120, key);
    const previous = byUrl.get(url);
    if (previous) {
      if (title && previous.title === new URL(url).hostname) previous.title = title;
      if (snippet && !previous.snippet) previous.snippet = snippet;
      continue;
    }
    byUrl.set(url, { url, title: title || new URL(url).hostname, snippet, ...(publishedAt ? { publishedAt } : {}) });
  }
  return [...byUrl.values()].slice(0, 8);
}

/** Responses URLs come from server tool metadata, never from links found in model prose. */
function responsesSources(payload: unknown, key: string, language: Language, provider: 'openai' | 'kimi'): Pick<WebSearchResult, 'sources' | 'summary'> {
  const fail = (zh: string, en: string) => new SearchFailure(translate(language, zh, en));
  if (!record(payload) || payload.error || !Array.isArray(payload.output)) throw fail('联网搜索返回了无效结果，请重试。', 'Web search returned an invalid result. Please try again.');
  if (payload.status !== 'completed') throw fail('联网搜索未完成，请重试或调整当前模型设置。', 'Web search did not complete. Retry or adjust the current model settings.');
  const output = payload.output.filter(record), searches = output.filter(item => item.type === 'web_search_call');
  if (!searches.length) throw fail('当前模型没有实际执行联网搜索，请重试。', 'The current model did not perform an actual web search. Please try again.');
  if (searches.some(item => item.status !== 'completed')) throw fail('联网搜索工具未完成，请稍后重试。', 'The web search tool did not complete. Please try again later.');
  const raw: RecordValue[] = [], text: string[] = [];
  let sourceMetadataFound = false;
  for (const search of searches) {
    if (!record(search.action) || !Array.isArray(search.action.sources)) continue;
    sourceMetadataFound = true;
    for (const source of search.action.sources) if (record(source) && source.type === 'url') raw.push(source);
  }
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!record(part) || part.type !== 'output_text') continue;
      if (typeof part.text === 'string') text.push(part.text);
      // OpenAI documents url_citation; Kimi only guarantees action.sources.
      if (provider !== 'openai' || !Array.isArray(part.annotations)) continue;
      for (const annotation of part.annotations) {
        if (!record(annotation) || annotation.type !== 'url_citation') continue;
        sourceMetadataFound = true;
        raw.push({ url: annotation.url, title: annotation.title });
      }
    }
  }
  if (!sourceMetadataFound) throw fail('联网搜索没有返回可核对的来源信息，请重试。', 'Web search returned no verifiable source metadata. Please try again.');
  const sources = normalizedSources(raw, key), summary = cleanText(text.join('\n\n'), 6000, key);
  return { sources, ...(sources.length && summary ? { summary } : {}) };
}

function glmSources(payload: unknown, key: string, language: Language): WebSearchSource[] {
  if (!record(payload) || payload.error || !Array.isArray(payload.web_search)) throw new SearchFailure(translate(language, 'GLM 没有返回实际搜索来源，当前模型或接口可能不支持联网搜索。', 'GLM returned no actual search sources. This model or endpoint may not support web search.'));
  return normalizedSources(payload.web_search.filter(record).map(item => ({ url: item.link, title: item.title, snippet: item.content, publishedAt: item.publish_date })), key);
}

/** Each adapter keeps the selected model, key and official origin. No secondary search model/key. */
function nativeRequest(config: ProviderConfig, provider: NativeWebSearchProvider, query: string, key: string): { endpoint: string; headers: Record<string, string>; body: RecordValue } {
  const origin = new URL(config.baseURL).origin;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const prompt = `Perform a web search for the query: ${query}`;
  if (provider === 'deepseek' || provider === 'anthropic') {
    headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
    return { endpoint: provider === 'deepseek' ? `${origin}/anthropic/v1/messages` : `${origin}/v1/messages`, headers,
      body: { model: config.model, max_tokens: 4096,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      } };
  }
  headers.authorization = `Bearer ${key}`;
  // https://developers.openai.com/api/docs/guides/tools-web-search
  // https://platform.kimi.ai/docs/api/responses — only kimi-k3; no forced tool choice or legacy $web_search.
  if (provider === 'openai' || provider === 'kimi') return {
    endpoint: `${origin}/v1/responses`, headers,
    body: { model: config.model, input: prompt, max_output_tokens: 4096,
      tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'],
      ...(provider === 'openai' ? { store: false } : {}),
      ...(provider === 'kimi' && config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
    },
  };
  // Native chat schemas, not the separate search endpoint or Coding Plan MCP.
  // https://docs.bigmodel.cn/cn/guide/tools/web-search
  // https://docs.z.ai/api-reference/llm/chat-completion.md (search_pro_jina in current API schema)
  return { endpoint: `${origin}/api/paas/v4/chat/completions`, headers,
    body: { model: config.model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search', web_search: { enable: true, search_result: true, require_search: true,
        search_engine: origin === 'https://open.bigmodel.cn' ? 'search_pro' : 'search_pro_jina', search_query: query, count: 8,
      } }],
    },
  };
}

/** One bounded native search call using only the selected provider's model and credentials. */
export async function searchWeb(config: ProviderConfig, query: string, signal: AbortSignal, language: Language = 'zh-CN'): Promise<WebSearchResult> {
  const t = (zh: string, en: string) => translate(language, zh, en);
  const provider = webSearchProvider(config);
  if (!provider) throw new SearchFailure(t('当前服务商、模型或地址暂不支持原生联网搜索，请使用受支持的官方配置。', 'The current provider, model or endpoint does not support native web search. Use a supported official configuration.'));
  const label = labels[provider];
  const key = config.apiKey?.trim();
  if (!key) throw new SearchFailure(t(`请先在设置中输入 ${label} API Key。`, `Enter your ${label} API key in Settings first.`));
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY_CHARACTERS) throw new SearchFailure(t('搜索内容不能为空，且不能超过 2000 个字符。', 'A search query must contain between 1 and 2000 characters.'));
  const normalizedQuery = query.trim();
  if (signal.aborted) throw new SearchFailure(t('联网搜索已取消。', 'Web search was cancelled.'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, WEB_SEARCH_TIMEOUT_MS);
  try {
    const request = nativeRequest(config, provider, normalizedQuery, key);
    const response = await abortable(fetch(request.endpoint, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: request.headers, body: JSON.stringify(request.body),
    }), controller.signal);
    if (response.redirected || (response.url && response.url !== request.endpoint)) {
      void response.body?.cancel().catch(() => {});
      throw new SearchFailure(t('联网搜索地址发生跳转，已停止请求。', 'Web search stopped because the endpoint redirected.'));
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new SearchFailure(t(`${label} 联网搜索认证失败，请检查 API Key。`, `${label} web search authentication failed. Check your API key.`));
      if (response.status === 402) throw new SearchFailure(t(`${label} 余额不足，无法进行联网搜索。`, `Your ${label} balance is insufficient for web search.`));
      if (response.status === 429) throw new SearchFailure(t(`${label} 联网搜索请求过于频繁，请稍后重试。`, `${label} web search is rate limited. Please try again later.`));
      if (response.status === 400) throw new SearchFailure(t(`${label} 拒绝了联网搜索请求，请确认当前模型支持原生搜索且账号已启用该功能。`, `${label} rejected the web search request. Check that the current model supports native search and your account has it enabled.`));
      throw new SearchFailure(t(`${label} 联网搜索失败（HTTP ${response.status}），请稍后重试。`, `${label} web search failed (HTTP ${response.status}). Please try again later.`));
    }
    const payload = await readBoundedJSON(response, controller.signal, language);
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const found = provider === 'openai' || provider === 'kimi' ? responsesSources(payload, key, language, provider)
      : { sources: provider === 'glm' ? glmSources(payload, key, language) : searchSources(payload, key, language) };
    return { query: normalizedQuery, ...found, searchedAt: Date.now() };
  } catch (error) {
    if (controller.signal.aborted) throw new SearchFailure(signal.aborted ? t('联网搜索已取消。', 'Web search was cancelled.') : t('联网搜索超时，请稍后重试。', 'Web search timed out. Please try again later.'));
    if (error instanceof SearchFailure) throw error;
    // Never echo provider bodies, transport diagnostics or an AbortSignal reason: they may contain credentials.
    throw new SearchFailure(t(`无法连接 ${label} 联网搜索，请检查网络后重试。`, `Could not connect to ${label} web search. Check your connection and try again.`));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
