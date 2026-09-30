import type { OutlineItem, TextSelection, Workspace } from './types';
import { sanitizeData } from './prompts';
import { translate, type Language } from './i18n';

export type ReadingMode = 'smart' | 'deep';
export interface ReadingCoverage {
  documentId: string; name: string; totalPages: number; readablePages: number;
  includedPages: number[]; unavailablePages: number[];
}
export interface ReadingReport {
  mode: ReadingMode; documents: ReadingCoverage[]; complete: boolean;
  batches?: number; cachedBatches?: number;
}
export interface ReadingSource {
  id: string; name: string; pages: string[]; pageCount?: number;
  outline?: OutlineItem[]; role?: 'main' | 'supplement';
}
export interface ReadingContextResult {
  content: string; warnings: string[]; hasText: boolean; report: ReadingReport;
  strategy: 'full' | 'retrieval' | 'overview'; needsQueryRewrite: boolean;
}
/** UTF-16 offsets in the original extracted page, including whitespace. */
export interface ReadingSegment { documentId: string; name: string; page: number; start: number; end: number }
export interface DeepReadingBatch { id: string; content: string; sources: ReadingSegment[] }
export interface DeepReadingPlan { batches: DeepReadingBatch[]; report: ReadingReport; warnings: string[]; hasText: boolean }

const MIN_BUDGET = 1000;
const OPEN = '<paper_content>\n', CLOSE = '\n</paper_content>';
const CHUNK_SIZE = 1600, OVERLAP = 160;
const STOP = new Set(('a an the and or of to in on at for from by as is are was were be been with without this that these those it its what which who how why when where can could would should do does did describe explain discuss tell please paper article study result results shown show figure fig supplementary supplement main').split(' '));
const HAN_STOP = new Set(['请问','论文','文章','如何','什么','哪些','这个','作者','请解','解释','说明','分析','结果','研究','是否','一下','主要']);
const ALIASES = [
  ['tumor','tumour'], ['mice','mouse'], ['human','humans'], ['cell','cells'],
  ['knockout','ko','deficient','deletion'], ['increase','increased','increasing','elevated'],
  ['decrease','decreased','decreasing','reduced'], ['supplementary','supplemental','supporting'],
];

function budget(value: number): number {
  if (!Number.isFinite(value) || value < MIN_BUDGET) throw new Error('Reading context budget must be at least 1,000 characters.');
  return Math.floor(value);
}
function label(doc: Pick<ReadingSource, 'name'>, page: number): string {
  return `[${sanitizeData(doc.name).replace(/[\[\]\r\n]/g, ' ')} p.${page}]\n`;
}
function coverage(documents: ReadingSource[], included: Map<string, Set<number>>, mode: ReadingMode, complete: boolean, selection?: TextSelection): ReadingReport {
  return { mode, complete, documents: documents.map(doc => {
    const totalPages = Math.max(doc.pages.length, Number.isInteger(doc.pageCount) && doc.pageCount! > 0 ? doc.pageCount! : 0);
    const unavailablePages: number[] = []; let readablePages = 0;
    for (let page = 1; page <= totalPages; page++) {
      if (doc.pages[page - 1]?.trim() || (selection?.documentId === doc.id && selection.page === page && selection.text.trim())) readablePages++; else unavailablePages.push(page);
    }
    if (!totalPages && selection?.documentId === doc.id && selection.text.trim()) readablePages = 1;
    return { documentId: doc.id, name: doc.name, totalPages, readablePages,
      includedPages: [...(included.get(doc.id) ?? [])].sort((a, b) => a - b), unavailablePages };
  }) };
}
function unavailableWarnings(report: ReadingReport, language: Language): string[] {
  return report.documents.filter(doc => doc.unavailablePages.length).map(doc => translate(language,
    '{name}：{count} 页没有可提取文字（空白、扫描页或索引缺失），无法作为已阅读内容。',
    '{name}: {count} pages have no extractable text (blank, scanned or missing from the index) and cannot be counted as read.',
    { name: doc.name, count: doc.unavailablePages.length }));
}
function addIncluded(map: Map<string, Set<number>>, id: string, page: number) {
  const pages = map.get(id) ?? new Set<number>(); pages.add(page); map.set(id, pages);
}
function safeEnd(text: string, end: number): number {
  return end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') ? end - 1 : end;
}
/** Prefer paragraph / line / sentence boundaries without dropping a character. */
function splitEnd(text: string, start: number, capacity: number): number {
  const limit = safeEnd(text, Math.min(text.length, start + capacity));
  if (limit >= text.length) return text.length;
  const earliest = start + Math.floor((limit - start) * .55);
  for (const delimiter of ['\n\n', '\n']) {
    const found = text.lastIndexOf(delimiter, limit - delimiter.length);
    if (found >= earliest) return found + delimiter.length;
  }
  const tail = text.slice(earliest, limit); let boundary = -1;
  for (const match of tail.matchAll(/[.!?。！？](?:\s+|$)/g)) boundary = earliest + match.index! + match[0].length;
  if (boundary > earliest) return boundary;
  const space = text.lastIndexOf(' ', limit - 1);
  return space >= earliest ? space + 1 : limit;
}
function terms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const words = (normalized.match(/[a-z\d]+(?:[._/+−-][a-z\d]+)*(?:[+−-])?/g) ?? []).filter(word => word.length > 1 && !STOP.has(word));
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) { const pair = chars[i] + chars[i + 1]; if (!HAN_STOP.has(pair)) words.push(pair); }
  }
  return words;
}
function queryTerms(query: string, expanded?: string): Set<string> {
  const result = new Set(terms(`${query.slice(0, 2000)} ${expanded?.slice(0, 2000) ?? ''}`).slice(0, 100));
  for (const group of ALIASES) if (group.some(word => result.has(word))) for (const word of group) result.add(word);
  return result;
}
function pageReferences(query: string): Set<number> {
  const pages = new Set<number>();
  for (const match of query.matchAll(/(?:\bp(?:age)?\.?\s*|第\s*)(\d{1,5})(?:\s*[-–—]\s*(\d{1,5}))?\s*(?:页)?/gi)) {
    const start = Number(match[1]), end = Math.min(Number(match[2] ?? start), start + 49);
    for (let page = start; page <= end && pages.size < 100; page++) if (page > 0) pages.add(page);
  }
  return pages;
}
function figureReferences(query: string): Set<string> {
  const refs = new Set<string>();
  for (const match of query.matchAll(/(?:figure|fig\.?|图|补充(?:材料)?)\s*(s?\s*\d+[a-z]?)/gi)) refs.add(match[1].replace(/\s/g, '').toLowerCase());
  return refs;
}
interface IndexedChunk { page: number; start: number; end: number; text: string; frequencies: Map<string, number>; length: number }
interface CachedDocument { name: string; fingerprint: string; pages: string[]; chunks: IndexedChunk[]; bytes: number }
const MAX_CACHE_BYTES = 10 * 1024 * 1024, MAX_CACHE_WORKSPACES = 3;
const textIndexes = new Map<string, Map<string, CachedDocument>>();
let cachedBytes = 0, cacheHits = 0, cacheMisses = 0;
/** Only a bounded, in-memory text index is cached; there is no model, timer or
 * background work. Byte accounting includes original text, chunks and maps. */
export function clearReadingCache(workspaceId?: string): void {
  if (workspaceId === undefined) { textIndexes.clear();cachedBytes = 0;cacheHits = 0;cacheMisses = 0;return; }
  const workspace = textIndexes.get(workspaceId);
  if (workspace) for (const document of workspace.values()) cachedBytes -= document.bytes;
  textIndexes.delete(workspaceId);
}
export function getReadingCacheStats() {
  return { workspaces: textIndexes.size, documents: [...textIndexes.values()].reduce((sum, docs) => sum + docs.size, 0), estimatedBytes: cachedBytes, hits: cacheHits, misses: cacheMisses };
}
function fingerprint(parts: Iterable<string>): string {
  let first = 2166136261, second = 2246822519;
  for (const part of parts) {
    first = Math.imul(first ^ part.length, 16777619);second = Math.imul(second ^ part.length, 3266489917);
    for (let i = 0; i < part.length; i++) { first = Math.imul(first ^ part.charCodeAt(i), 16777619);second = Math.imul(second ^ part.charCodeAt(i), 3266489917); }
  }
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
}
function indexedChunks(workspaceId: string, doc: ReadingSource): IndexedChunk[] {
  const signature = fingerprint([doc.name, ...doc.pages]);
  let workspace = textIndexes.get(workspaceId);
  const existing = workspace?.get(doc.id);
  // The exact comparison prevents a hash collision from reusing stale text.
  if (existing?.fingerprint === signature && existing.name === doc.name && existing.pages.length === doc.pages.length && existing.pages.every((text, index) => text === doc.pages[index])) {
    cacheHits++;workspace!.delete(doc.id);workspace!.set(doc.id, existing);
    textIndexes.delete(workspaceId);textIndexes.set(workspaceId, workspace!);return existing.chunks;
  }
  cacheMisses++;
  if (existing) { cachedBytes -= existing.bytes;workspace!.delete(doc.id); }
  const chunks: IndexedChunk[] = [];
  let bytes = 256 + (doc.id.length + doc.name.length) * 2 + doc.pages.reduce((sum, page) => sum + page.length * 2 + 16, 0);
  doc.pages.forEach((text, pageIndex) => {
    if (!text.trim()) return;
    for (let start = 0; start < text.length;) {
      const end = splitEnd(text, start, CHUNK_SIZE), part = text.slice(start, end), tokens = terms(part), frequencies = new Map<string, number>();
      for (const word of tokens) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
      chunks.push({ page: pageIndex + 1, start, end, text: part, frequencies, length: tokens.length || 1 });
      bytes += 160 + part.length * 2;
      for (const word of frequencies.keys()) bytes += 80 + word.length * 2;
      if (end >= text.length) break;
      start = Math.max(start + 1, safeEnd(text, end - OVERLAP));
    }
  });
  if (bytes <= MAX_CACHE_BYTES) {
    workspace ??= new Map();workspace.set(doc.id, { name: doc.name, fingerprint: signature, pages: [...doc.pages], chunks, bytes });cachedBytes += bytes;
    textIndexes.delete(workspaceId);textIndexes.set(workspaceId, workspace);
    while (textIndexes.size > MAX_CACHE_WORKSPACES) clearReadingCache(textIndexes.keys().next().value!);
    while (cachedBytes > MAX_CACHE_BYTES) {
      const oldestWorkspaceId = textIndexes.keys().next().value!, oldestWorkspace = textIndexes.get(oldestWorkspaceId)!;
      const oldestDocumentId = oldestWorkspace.keys().next().value!, oldest = oldestWorkspace.get(oldestDocumentId)!;
      cachedBytes -= oldest.bytes;oldestWorkspace.delete(oldestDocumentId);
      if (!oldestWorkspace.size) textIndexes.delete(oldestWorkspaceId);
    }
  } else if (workspace && !workspace.size) textIndexes.delete(workspaceId);
  return chunks;
}
interface Chunk { doc: ReadingSource; order: number; page: number; start: number; end: number; text: string; score: number; direct: boolean; counts: Map<string, number>; length: number }
function makeChunks(workspaceId: string, documents: ReadingSource[], wanted: Set<string>): Chunk[] {
  const chunks: Chunk[] = [];
  documents.forEach((doc, order) => {
    for (const entry of indexedChunks(workspaceId, doc)) {
      const counts = new Map<string, number>();
      for (const term of wanted) { const count = entry.frequencies.get(term);if (count) counts.set(term, count); }
      chunks.push({ doc, order, page: entry.page, start: entry.start, end: entry.end, text: entry.text, length: entry.length, counts, score: 0, direct: false });
    }
  });
  return chunks;
}
function ordered(chunks: Chunk[]): Chunk[] { return [...chunks].sort((a, b) => a.order - b.order || a.page - b.page || a.start - b.start); }
function passages(chunks: Chunk[]): { doc: ReadingSource; page: number; start: number; end: number }[] {
  const result: { doc: ReadingSource; page: number; start: number; end: number }[] = [];
  for (const chunk of ordered(chunks)) {
    const previous = result.at(-1);
    if (previous?.doc.id === chunk.doc.id && previous.page === chunk.page && chunk.start <= previous.end) previous.end = Math.max(previous.end, chunk.end);
    else result.push({ doc: chunk.doc, page: chunk.page, start: chunk.start, end: chunk.end });
  }
  return result;
}

export function buildSmartContext(workspace: Workspace, documents: ReadingSource[], maxChars: number, query: string, selection?: TextSelection, language: Language = 'zh-CN', expandedQuery?: string): ReadingContextResult {
  const limit = budget(maxChars), warnings: string[] = [];
  const metadata = JSON.stringify({ title: sanitizeData(workspace.title).slice(0, 240), authors: sanitizeData(workspace.authors).slice(0, 100), doi: sanitizeData(workspace.doi).slice(0, 100) });
  const header = `${OPEN}${metadata}\n`, footer = CLOSE;
  let selectionText = '';
  if (selection?.text.trim()) {
    const selectionDoc = documents.find(doc => doc.id === selection.documentId);
    const selectionLabel = label({ name: selectionDoc?.name ?? selection.documentName }, selection.page);
    const room = Math.max(0, Math.min(16000, Math.floor((limit - header.length - footer.length - selectionLabel.length - 30) / 3)));
    let fragment = selection.text.slice(0, safeEnd(selection.text, room));
    while (sanitizeData(fragment).length > room) fragment = fragment.slice(0, safeEnd(fragment, fragment.length - 1));
    selectionText = `<selection>\n${selectionLabel}${sanitizeData(fragment)}\n</selection>\n`;
    if (fragment.length < selection.text.length) warnings.push(translate(language, '选中文字超过本次上下文预算，已截断。', 'The selected passage exceeds this request’s context budget and has been truncated.'));
  }
  const prefix = `${header}${selectionText}`;
  if (prefix.length + footer.length > limit) throw new Error('The document name is too long for this reading context budget.');
  const includeSelection = (included: Map<string, Set<number>>) => {
    if (!selectionText || !selection || !Number.isInteger(selection.page) || selection.page < 1) return;
    const doc = documents.find(source => source.id === selection.documentId);
    if (!doc) return;
    const knownTotal = Math.max(doc.pages.length, doc.pageCount ?? 0);
    if (knownTotal > 0 && selection.page > knownTotal) return;
    addIncluded(included, doc.id, selection.page);
    if (!doc.pages[selection.page - 1]?.trim()) warnings.push(translate(language,
      knownTotal ? '本次包含第 {page} 页的选中文字，但该页完整文字索引尚不可用，不能视为已读完整页面。' : '本次包含第 {page} 页的选中文字；全文索引和总页数尚未就绪，不能视为已读全文。',
      knownTotal ? 'This request includes the selected passage on page {page}, but its full page text is unavailable; the whole page has not been read.' : 'This request includes the selected passage on page {page}; the full-text index and total page count are not ready, so this is not a complete reading.',
      { page: selection.page }));
  };
  const render = (selected: Chunk[]) => prefix + passages(selected).map(part => `${label(part.doc, part.page)}${sanitizeData(part.doc.pages[part.page - 1].slice(part.start, part.end))}\n`).join('\n') + footer;
  const totalChars = documents.reduce((sum, doc) => sum + doc.pages.reduce((n, page) => n + page.length, 0), 0);
  const baseReport = coverage(documents, new Map(), 'smart', false), hasText = baseReport.documents.some(doc => doc.readablePages > 0) || !!selection?.text.trim();
  // The overwhelmingly common short-paper case needs no ranking or truncation.
  if (totalChars <= limit - prefix.length - footer.length) {
    const full: Chunk[] = [];
    documents.forEach((doc, order) => doc.pages.forEach((text, index) => { if (text.trim()) full.push({ doc, order, page: index + 1, start: 0, end: text.length, text, score: 0, direct: false, counts: new Map(), length: 0 }); }));
    const content = render(full);
    if (content.length <= limit) {
      const included = new Map<string, Set<number>>();for (const chunk of full) addIncluded(included, chunk.doc.id, chunk.page);
      includeSelection(included);
      const selectedPageReady = !selection || !!documents.find(doc => doc.id === selection.documentId)?.pages[selection.page - 1]?.trim();
      const report = coverage(documents, included, 'smart', full.length > 0 && selectedPageReady, selection);
      return { content, warnings: [...warnings, ...unavailableWarnings(report, language)], hasText, report, strategy: 'full', needsQueryRewrite: false };
    }
  }
  const wanted = queryTerms(query, expandedQuery), pageRefs = pageReferences(query), figureRefs = figureReferences(query);
  const chunks = makeChunks(workspace.id, documents, wanted), df = new Map<string, number>();
  let totalLength = 0;
  for (const chunk of chunks) { totalLength += chunk.length; for (const term of chunk.counts.keys()) df.set(term, (df.get(term) ?? 0) + 1); }
  const averageLength = totalLength / Math.max(1, chunks.length);
  const supplementHint = /\b(?:supplement(?:ary|al)?|supporting)\b|补充|附图/i.test(query), mainHint = /\bmain\b|正文/i.test(query);
  const named = documents.filter(doc => doc.name.replace(/\.pdf$/i, '').length >= 4 && query.toLowerCase().includes(doc.name.replace(/\.pdf$/i, '').toLowerCase()));
  for (const chunk of chunks) {
    const supplement = chunk.doc.role ? chunk.doc.role === 'supplement' : /supp|support|补充/i.test(chunk.doc.name);
    // A comparison mentioning both scopes includes both, and an explicitly
    // named document is more precise than words appearing in its filename.
    const scoped = named.length ? named.some(doc => doc.id === chunk.doc.id)
      : supplementHint === mainHint || (supplementHint ? supplement : !supplement);
    if (scoped && pageRefs.has(chunk.page)) { chunk.score += 100; chunk.direct = true; }
    if (figureRefs.size) {
      const refs = figureReferences(chunk.text);
      if ([...refs].some(ref => figureRefs.has(ref)) && scoped) { chunk.score += 80; chunk.direct = true; }
    }
    for (const [term, count] of chunk.counts) {
      const frequency = df.get(term)!;
      const idf = Math.log(1 + (chunks.length - frequency + .5) / (frequency + .5));
      chunk.score += idf * count * 2.2 / (count + 1.2 * (.25 + .75 * chunk.length / averageLength));
    }
    if (chunk.score && scoped && (named.length || supplementHint || mainHint)) chunk.score *= 1.25;
  }
  const ranked = chunks.filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score || a.order - b.order || a.page - b.page || a.start - b.start);
  const selected: Chunk[] = [], selectedSet = new Set<Chunk>();
  let content = prefix + footer;
  const add = (chunk: Chunk, allowPartial = false): boolean => {
    if (selectedSet.has(chunk)) return true;
    const next = render([...selected, chunk]);
    if (next.length <= limit) { selected.push(chunk); selectedSet.add(chunk); content = next; return true; }
    if (!allowPartial) return false;
    let length = Math.min(chunk.end - chunk.start, limit - content.length - label(chunk.doc, chunk.page).length - 4);
    while (length >= 80) {
      const end = splitEnd(chunk.doc.pages[chunk.page - 1], chunk.start, length), partial = { ...chunk, end };
      const candidate = render([...selected, partial]);
      if (candidate.length <= limit) { selected.push(partial); selectedSet.add(chunk); content = candidate; return true; }
      length -= Math.max(1, candidate.length - limit);
    }
    return false;
  };
  if (ranked.length) {
    // Strongest evidence goes first, then allow each other matching document a
    // place. There is no equal fixed quota and short supplements waste no room.
    add(ranked[0], true);
    const firstByDocument = new Map<string, Chunk>();
    for (const chunk of ranked) if (!firstByDocument.has(chunk.doc.id)) firstByDocument.set(chunk.doc.id, chunk);
    for (const chunk of firstByDocument.values()) if (chunk !== ranked[0]) add(chunk);
    for (const chunk of ranked) {
      if (limit - content.length < 100) break;
      if (!add(chunk)) continue;
      // Adjacent snippets retain qualifications and definitions around a hit.
      if (chunk === ranked[0] || chunk.direct) {
        const index = chunks.indexOf(chunk);
        for (const adjacent of [chunks[index - 1], chunks[index + 1]]) if (adjacent?.doc.id === chunk.doc.id && Math.abs(adjacent.page - chunk.page) <= 1) add(adjacent);
      }
    }
  } else {
    // An overview is explicitly labelled as such, never claimed as a relevant
    // retrieval hit. Include the ending too instead of repeating front pages.
    for (const doc of documents) {
      const own = chunks.filter(chunk => chunk.doc.id === doc.id);
      if (own[0]) add(own[0], !selected.length);
      if (own.length > 1) add(own[own.length - 1]);
    }
    warnings.push(translate(language, '未找到与问题明确匹配的原文片段；本次仅提供开头和结尾导览，不能据此认定全文没有相关内容。请指定术语、图号或页码后重试。', 'No passages clearly matched the question. Only opening and closing excerpts are provided as an overview; this does not establish that the full paper lacks relevant evidence. Specify a term, figure or page and try again.'));
  }
  const included = new Map<string, Set<number>>();for (const chunk of selected) addIncluded(included, chunk.doc.id, chunk.page);
  includeSelection(included);
  const report = coverage(documents, included, 'smart', false, selection);
  warnings.push(...unavailableWarnings(report, language));
  warnings.push(translate(language, '本次按问题从全文中选择片段，未将整篇文章的全部文字发送给 AI；完整逐段分析请使用整篇精读。', 'This request selects passages from the full text for your question; it does not send every word of the paper. Use full-paper reading for a complete section-by-section analysis.'));
  const sample = documents.flatMap(doc => doc.pages.filter(page => page.trim()).slice(0, 3).map(page => page.slice(0, 1000))).join('');
  const english = (sample.match(/[a-z]/gi) ?? []).length > sample.length * .35;
  return { content, warnings, hasText, report, strategy: ranked.length ? 'retrieval' : 'overview', needsQueryRewrite: !expandedQuery?.trim() && /\p{Script=Han}/u.test(query) && english && !pageRefs.size };
}

/** Stable deterministic identity, not a cryptographic trust boundary. The caller
 * includes model/prompt versions and an input digest in its persistent cache. */
function batchId(content: string, sources: ReadingSegment[]): string {
  return `reading-${fingerprint([JSON.stringify(sources), content])}`;
}

export function planDeepReading(documents: ReadingSource[], maxChars: number, language: Language = 'zh-CN'): DeepReadingPlan {
  const limit = budget(maxChars), batches: DeepReadingBatch[] = [], included = new Map<string, Set<number>>();
  let parts: string[] = [], sources: ReadingSegment[] = [], length = OPEN.length + CLOSE.length;
  const flush = () => {
    if (!sources.length) return;
    const content = OPEN + parts.join('') + CLOSE;
    batches.push({ id: batchId(content, sources), content, sources });parts = [];sources = [];length = OPEN.length + CLOSE.length;
  };
  for (const doc of documents) {
    const sectionPages = new Set<number>();
    const visit = (items: OutlineItem[]) => { for (const item of items) { sectionPages.add(item.page);visit(item.children); } };
    visit(doc.outline ?? []);
    for (let index = 0; index < doc.pages.length; index++) {
      const text = doc.pages[index];if (!text.trim()) continue;
      const page = index + 1, prefix = label(doc, page);
      if (prefix.length + OPEN.length + CLOSE.length + 80 > limit) throw new Error('The document name is too long for this reading context budget.');
      // Keep section starts together when a mostly filled batch cannot fit the
      // next page; a large page is still split safely and fully visited below.
      if (sectionPages.has(page) && sources.length && length > limit * .5 && length + prefix.length + sanitizeData(text).length + 1 > limit) flush();
      for (let start = 0; start < text.length;) {
        let room = limit - length - prefix.length - 1;
        if (room < 80 && sources.length) { flush();room = limit - length - prefix.length - 1; }
        let end = splitEnd(text, start, Math.max(1, room));
        let fragment = sanitizeData(text.slice(start, end));
        while (fragment.length > room && end > start) {
          end = safeEnd(text, Math.max(start, end - Math.max(1, fragment.length - room)));
          fragment = sanitizeData(text.slice(start, end));
        }
        if (end <= start) { if (sources.length) { flush();continue; } throw new Error('Cannot fit a page fragment within the reading context budget.'); }
        const part = `${prefix}${fragment}\n`;parts.push(part);length += part.length;
        sources.push({ documentId: doc.id, name: doc.name, page, start, end });addIncluded(included, doc.id, page);
        start = end;if (start < text.length) flush();
      }
    }
  }
  flush();
  const report = coverage(documents, included, 'deep', batches.length > 0);report.batches = batches.length;
  return { batches, report, warnings: unavailableWarnings(report, language), hasText: batches.length > 0 };
}
