/** Citation anchors carry evidence, never inferred coordinates or translated text. */
export interface CitationDocument { id: string; name: string; fileName?: string; pageCount?: number }
export interface SourceCitation { documentId: string; name: string; page: number; quote?: string }
export interface CitationLabel { name: string; page: number; quote?: string }
export const MAX_CITATION_QUOTE = 400;
export const CITATION_PATTERN = /\[([^\[\]\r\n]{1,1600})\]/g;

export function parseCitationLabel(label: string): CitationLabel | undefined {
  // Fullwidth ｜ is table-safe Markdown. Accept earlier halfwidth/escaped forms too.
  const match = /^(.+?)\s+(?:p\.?\s*|第\s*)([1-9]\d{0,5})(?:\s*页)?(?:\s*\\?[|｜]\s*(.*))?$/i.exec(label.trim());
  if (!match || Number(match[2]) > 100000) return;
  const name = match[1].trim(), rawQuote = match[3]?.trim();
  if (!name || /[\x00-\x1f\x7f]/.test(label)) return;
  // An invalid excerpt must never be partially highlighted. Its page is still useful.
  const quote = rawQuote && rawQuote.length <= MAX_CITATION_QUOTE ? rawQuote : undefined;
  return { name, page: Number(match[2]), ...(quote ? { quote } : {}) };
}

export function createCitationResolver(documents: readonly CitationDocument[]) {
  const byId = new Map(documents.map(document => [document.id, document]));
  const byName = new Map<string, Set<string>>();
  for (const document of documents) for (const name of [document.name, document.fileName]) {
    if (!name) continue;
    // Prompt page labels remove brackets/newlines from document names.
    for (const alias of new Set([name.trim(), name.replace(/[\[\]\r\n]/g, ' ').trim()])) {
      const ids = byName.get(alias) ?? new Set<string>(); ids.add(document.id); byName.set(alias, ids);
    }
  }
  const fromId = (id: string, page: number, quote?: string): SourceCitation | undefined => {
    const document = byId.get(id);
    if (!document || !Number.isSafeInteger(page) || page < 1 || page > 100000 || (document.pageCount && page > document.pageCount)) return;
    const validQuote = quote?.trim();
    return { documentId: id, name: document.name, page, ...(validQuote && validQuote.length <= MAX_CITATION_QUOTE && !/[\x00-\x1f\x7f]/.test(validQuote) ? { quote: validQuote } : {}) };
  };
  return {
    fromLabel(label: string): SourceCitation | undefined {
      const citation = parseCitationLabel(label); if (!citation) return;
      const ids = byName.get(citation.name); if (ids?.size !== 1) return;
      return fromId([...ids][0], citation.page, citation.quote);
    },
    fromURL(url: string): SourceCitation | undefined {
      const match = /^folio-cite:\/\/([^/?#]+)\/([1-9]\d{0,5})(?:\?quote=([^#]*))?$/.exec(url);
      if (!match) return;
      try { return fromId(decodeURIComponent(match[1]), Number(match[2]), match[3] === undefined ? undefined : decodeURIComponent(match[3])); } catch { return; }
    },
  };
}

export function citationURL(citation: SourceCitation): string {
  return `folio-cite://${encodeURIComponent(citation.documentId)}/${citation.page}${citation.quote ? `?quote=${encodeURIComponent(citation.quote)}` : ''}`;
}

/** Keep copied/exported answers readable, while persisted messages retain anchors. */
export function readableCitations(text: string, documents: readonly CitationDocument[]): string {
  const resolver = createCitationResolver(documents);
  return text.replace(CITATION_PATTERN, (original, label: string) => {
    const citation = resolver.fromLabel(label);
    return citation ? `[${citation.name} p.${citation.page}]` : original;
  });
}
