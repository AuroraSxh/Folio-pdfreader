import { memo, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, Globe } from 'lucide-react';
import { safeWebSourceUrl, type WebSearchResult } from '../../shared/web-search';
import { visibleWebSearchResult } from './web-source-utils';
import { useI18n } from '../i18n';
import './web-search-sources.css';

export { visibleWebSearchResult } from './web-source-utils';

export const WebSearchSources = memo(function WebSearchSources({ result: input, onError }: {
  result?: WebSearchResult; onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const result = useMemo(() => visibleWebSearchResult(input), [input]);
  const [expanded, setExpanded] = useState(false);
  if (!result) return null;
  return <section className="fl-web-sources" aria-label={t('网页来源', 'Web sources')}>
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary aria-expanded={expanded}><Globe size={12} aria-hidden="true" /><strong>{t('网页来源', 'Web sources')}</strong><span className="fl-web-source-count">{result.sources.length}</span><ChevronDown size={12} className="fl-web-sources-chevron" aria-hidden="true" /></summary>
      {expanded && <WebSearchSourceDetails result={result} onError={onError} />}
    </details>
  </section>;
});

/** Mounted only by an expanded disclosure; useful independently of chat layout. */
export function WebSearchSourceDetails({ result: input, onError }: { result: WebSearchResult; onError: (message: string) => void }) {
  const { t, locale } = useI18n();
  const result = useMemo(() => visibleWebSearchResult(input), [input]);
  if (!result) return null;
  const open = (url: string) => {
    const safe = safeWebSourceUrl(url);
    if (!safe) return;
    void window.folio.openExternal(safe).catch(cause => onError(cause instanceof Error ? cause.message : String(cause)));
  };
  return <div className="fl-web-source-details">
    {result.query && <p className="fl-web-query" title={result.query}>{t('搜索：{query}', 'Search: {query}', { query: result.query })}</p>}
    {result.sources.length ? <ol className="fl-web-source-list">{result.sources.map((source, index) => <li key={source.url}>
      <a href={source.url} title={source.url} rel="noreferrer noopener" onClick={event => { event.preventDefault(); open(source.url); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); open(source.url); } }}>
        <span className="fl-web-source-number">{index + 1}</span><span><strong>{source.title}</strong><small>{new URL(source.url).hostname}{source.publishedAt && <> · {new Date(source.publishedAt).toLocaleDateString(locale)}</>}</small></span><ExternalLink size={12} />
      </a>
      {source.snippet && <p>{source.snippet}</p>}
    </li>)}</ol> : <p className="fl-web-empty">{t('本次搜索没有返回可用的网页来源。', 'This search returned no usable web sources.')}</p>}
    <footer>{t('搜索于 {date} · 网页内容可能更新', 'Searched {date} · Web content can change', { date: new Date(result.searchedAt).toLocaleDateString(locale) })}</footer>
  </div>;
}
