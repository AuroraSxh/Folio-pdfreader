import type { ReadingReport } from '../../shared/reading';

/** Older/imported workspace JSON may contain fields that predate schema checks. */
export function safeReadingReport(value: unknown): ReadingReport | undefined {
  if (!value || typeof value !== 'object') return;
  const report = value as ReadingReport;
  if (!['smart', 'deep'].includes(report.mode) || typeof report.complete !== 'boolean' || !Array.isArray(report.documents) || report.documents.length > 1_000) return;
  const integer = (number: unknown, maximum = 1_000_000): number is number => Number.isSafeInteger(number) && Number(number) >= 0 && Number(number) <= maximum;
  for (const field of [report.batches, report.cachedBatches]) if (field !== undefined && !integer(field)) return;
  const documents: ReadingReport['documents'] = [];
  for (const document of report.documents) {
    if (!document || typeof document !== 'object' || typeof document.documentId !== 'string' || typeof document.name !== 'string' || !integer(document.totalPages) || !integer(document.readablePages, document.totalPages || 1_000_000)) return;
    for (const pages of [document.includedPages, document.unavailablePages]) {
      if (!Array.isArray(pages) || pages.length > 100_000 || !pages.every(page => integer(page, document.totalPages || 1_000_000) && page > 0)) return;
    }
    const unavailable = new Set(document.unavailablePages), included = new Set(document.includedPages);
    if ([...included].some(page => unavailable.has(page))) return;
    documents.push({ ...document, includedPages: [...included], unavailablePages: [...unavailable] });
  }
  return { ...report, documents };
}

/** Keep long-paper coverage readable without enumerating hundreds of page labels. */
export function compactPageRanges(pages: readonly number[], maxRanges = 12): string {
  const sorted = [...new Set(pages.filter(page => Number.isSafeInteger(page) && page > 0))].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const start = sorted[index]; let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) end = sorted[++index];
    ranges.push(start === end ? String(start) : `${start}–${end}`);
  }
  const limit = Math.max(1, Math.floor(maxRanges));
  return ranges.slice(0, limit).join(', ') + (ranges.length > limit ? ', …' : '');
}
