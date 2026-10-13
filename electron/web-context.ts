import { sanitizeData } from '../shared/prompts';
import type { WebSearchResult } from '../shared/web-search';
import { translate, type Language } from '../shared/i18n';

/** Keep whole source URLs and JSON boundaries intact under the shared budget. */
export function webSearchContext(result: WebSearchResult, maxChars: number, language: Language = 'zh-CN'): string {
  // Sanitize individual text fields. Sanitizing serialized JSON can treat '<'
  // in one title and '>' in another field as a tag and swallow a source URL.
  const available = result.sources.map(source => ({ ...source, title: sanitizeData(source.title), snippet: sanitizeData(source.snippet), ...(source.publishedAt ? { publishedAt: sanitizeData(source.publishedAt) } : {}) }));
  const fullSummary = sanitizeData(result.summary ?? '');
  const wrap = (sources: WebSearchResult['sources'], summary = '', snippetsTruncated = false) => `<web_sources>\n${JSON.stringify({
    query: sanitizeData(result.query.slice(0, 400)), searchedAt: new Date(result.searchedAt).toISOString(), sources,
    sources_omitted: available.length - sources.length, snippets_truncated: snippetsTruncated,
    summary_truncated: summary.length < fullSummary.length,
    ...(summary ? { provider_generated_search_summary: summary } : {}),
  })}\n</web_sources>`;
  const trim = (text: string, length: number) => text.slice(0, length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1] ?? '') ? length - 1 : length);
  // Fit serialized data, including JSON escapes and omission flags, without
  // splitting a Unicode surrogate pair or cutting a URL / JSON boundary.
  const fitPrefix = (value: string, fits: (candidate: string) => boolean): string => {
    let low = 0, high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(trim(value, middle))) low = middle; else high = middle - 1;
    }
    return trim(value, low);
  };
  const candidateSummary = available.length ? trim(fullSummary, Math.min(6000, fullSummary.length)) : '';
  // Responses providers return their factual search content in this labelled
  // summary, with no source snippets. Protect roughly half the budget before
  // filling it with titles and URLs, then give any spare space back to summary.
  let reservedSummary = fitPrefix(candidateSummary, summary => wrap([], summary).length - wrap([]).length <= Math.floor(maxChars / 2));
  if (reservedSummary && !available.some(source => wrap([{ ...source, snippet: '' }], reservedSummary, !!source.snippet).length <= maxChars)) {
    const firstFitting = available.find(source => wrap([{ ...source, snippet: '' }], '', !!source.snippet).length <= maxChars);
    reservedSummary = firstFitting ? fitPrefix(reservedSummary, summary => wrap([{ ...firstFitting, snippet: '' }], summary, !!firstFitting.snippet).length <= maxChars) : '';
  }
  const sources: WebSearchResult['sources'] = [];
  let snippetsTruncated = false;
  for (const source of available) {
    const fits = (snippet: string) => wrap([...sources, { ...source, snippet }], reservedSummary, snippetsTruncated || snippet.length < source.snippet.length).length <= maxChars;
    if (!fits('')) continue;
    const snippet = fitPrefix(source.snippet, fits);
    sources.push({ ...source, snippet });
    snippetsTruncated ||= snippet.length < source.snippet.length;
  }
  if (available.length && !sources.length) throw new Error(translate(language, '网页来源超出本次上下文额度，请提高阅读预算后重试。', 'Web sources exceed the context budget. Increase the reading budget and retry.'));
  const summary = fitPrefix(candidateSummary, candidate => wrap(sources, candidate, snippetsTruncated).length <= maxChars);
  const content = wrap(sources, summary, snippetsTruncated);
  if (content.length > maxChars) throw new Error(translate(language, '搜索资料超出本次上下文额度，请提高阅读预算后重试。', 'Web search metadata exceeds the context budget. Increase the reading budget and retry.'));
  return content;
}
