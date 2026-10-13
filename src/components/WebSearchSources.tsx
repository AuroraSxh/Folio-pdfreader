import { memo, useMemo } from 'react';
import { ExternalLink, Globe } from 'lucide-react';
import { safeWebSourceUrl, type WebSearchResult } from '../../shared/web-search';
import { useI18n } from '../i18n';
import './web-search-sources.css';

/** Imported conversation data need the same link checks as fresh results. */
export function visibleWebSearchResult(input: unknown): WebSearchResult | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<WebSearchResult>;
  if (typeof value.query !== 'string' || !Array.isArray(value.sources) || typeof value.searchedAt !== 'number' || !Number.isFinite(new Date(value.searchedAt).getTime())) return null;
  const sources: WebSearchResult['sources'] = [];
  const seen = new Set<string>();
  for (const candidate of value.sources.slice(0, 30)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const url = safeWebSourceUrl(candidate.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      title: typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim().slice(0, 400) : new URL(url).hostname,
      snippet: typeof candidate.snippet === 'string' ? candidate.snippet.slice(0, 2000) : '',
      ...(typeof candidate.publishedAt === 'string' && Number.isFinite(new Date(candidate.publishedAt).getTime()) ? { publishedAt: candidate.publishedAt } : {}),
    });
  }
  return { query: value.query.slice(0, 1000), searchedAt: value.searchedAt, sources };
}

export const WebSearchSources = memo(function WebSearchSources({ result: input, onError }: {
  result?: WebSearchResult; onError: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const result = useMemo(() => visibleWebSearchResult(input), [input]);
  if (!result) return null;
  const open = (url: string) => {
    const safe = safeWebSourceUrl(url);
    if (!safe) return;
    void window.folio.openExternal(safe).catch(cause => onError(cause instanceof Error ? cause.message : String(cause)));
  };
  return <section className="fl-web-sources" aria-label={t('网页来源', 'Web sources')}>
    <header><Globe size={12} /><strong>{t('网页来源', 'Web sources')}</strong><span>{result.sources.length}</span></header>
    {result.query && <p className="fl-web-query" title={result.query}>{t('搜索：{query}', 'Search: {query}', { query: result.query })}</p>}
    {result.sources.length ? <ol className="fl-web-source-list">{result.sources.map((source, index) => <li key={source.url}>
      <a href={source.url} title={source.url} rel="noreferrer noopener" onClick={event => { event.preventDefault(); open(source.url); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); open(source.url); } }}>
        <span className="fl-web-source-number">{index + 1}</span><span><strong>{source.title}</strong><small>{new URL(source.url).hostname}{source.publishedAt && <> · {new Date(source.publishedAt).toLocaleDateString(locale)}</>}</small></span><ExternalLink size={12} />
      </a>
      {source.snippet && <p>{source.snippet}</p>}
    </li>)}</ol> : <p className="fl-web-empty">{t('本次搜索没有返回可用的网页来源。', 'This search returned no usable web sources.')}</p>}
    <footer>{t('搜索于 {date} · 网页内容可能更新', 'Searched {date} · Web content can change', { date: new Date(result.searchedAt).toLocaleDateString(locale) })}</footer>
  </section>;
});
