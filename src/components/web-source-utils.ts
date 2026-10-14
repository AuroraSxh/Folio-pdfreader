import { safeWebSourceUrl, type WebSearchResult, type WebSearchSource } from '../../shared/web-search';

/** Imported conversations require the same checks as a fresh provider result. */
export function visibleWebSearchResult(input: unknown): WebSearchResult | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<WebSearchResult>;
  if (typeof value.query !== 'string' || !Array.isArray(value.sources) || typeof value.searchedAt !== 'number' || !Number.isFinite(new Date(value.searchedAt).getTime())) return null;
  const sources: WebSearchSource[] = [], seen = new Set<string>();
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

export interface WebSourceCitationMatch { source: WebSearchSource; index: number }

/** Only the message's actual search metadata can promote a link to a citation.
 * Keep path/query/fragment identity; a model-invented URL on the same domain is
 * still an ordinary link, never an attributed search result.
 */
export function findWebSourceCitation(href: unknown, input?: unknown): WebSourceCitationMatch | null {
  const url = safeWebSourceUrl(href), result = visibleWebSearchResult(input);
  if (!url || !result) return null;
  const index = result.sources.findIndex(source => source.url === url);
  return index < 0 ? null : { source: result.sources[index], index: index + 1 };
}

export const webSourceDomain = (url: string) => new URL(url).hostname.replace(/^www\./i, '');

interface Edges { left: number; right: number; top: number; bottom: number }
/** Bound the top-layer card to the visible assistant, including a narrow float. */
export function webSourcePopoverBounds(anchor: Edges, panel: Edges, viewport: { width: number; height: number }, height = 300) {
  const inset = 12;
  const leftEdge = Math.max(inset, panel.left + inset), rightEdge = Math.min(viewport.width - inset, panel.right - inset);
  const topEdge = Math.max(inset, panel.top + inset), bottomEdge = Math.min(viewport.height - inset, panel.bottom - inset);
  const width = Math.max(1, Math.min(360, rightEdge - leftEdge));
  const maxHeight = Math.max(1, bottomEdge - topEdge);
  const cardHeight = Math.min(maxHeight, Math.max(1, height));
  const left = Math.min(Math.max(anchor.left, leftEdge), Math.max(leftEdge, rightEdge - width));
  const below = anchor.bottom + 7;
  const top = below + cardHeight <= bottomEdge ? Math.max(topEdge, below)
    : Math.max(topEdge, Math.min(anchor.top - cardHeight - 7, bottomEdge - cardHeight));
  return { left, top, width, maxHeight };
}
