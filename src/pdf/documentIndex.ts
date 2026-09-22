import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { DocumentIndex, OutlineItem } from '../../shared/types';

GlobalWorkerOptions.workerSrc = pdfWorker;

export const hasPdfIndex = (document: { textStatus?: 'ready' | 'empty'; outlineLoaded: boolean }) => !!document.textStatus && document.outlineLoaded;

interface IndexOptions {
  outline?: OutlineItem[];
  isCancelled?: () => boolean;
  onOutline?: (outline: OutlineItem[]) => void;
  onProgress?: (percent: number) => void;
}

// Only pending work is retained: extracted full-text strings are released after delivery.
const pendingIndexes = new Map<string, { promise: Promise<DocumentIndex>; isCancelled: () => boolean }>();
let textQueue: Promise<unknown> = Promise.resolve();

function scheduleTextBatch<T>(work: () => Promise<T>): Promise<T> {
  const result = textQueue.then(async () => {
    // Yield between batches so rendering and user input take priority over extraction.
    await new Promise<void>(resolve => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 200 });
      else setTimeout(resolve, 0);
    });
    return work();
  });
  textQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Share extraction across two panes, retrying with a live PDF if its owner closes. */
export async function readSharedPdfIndex(key: string, pdf: PDFDocumentProxy, options: IndexOptions = {}): Promise<DocumentIndex> {
  if (options.isCancelled?.()) throw new DOMException('PDF indexing was cancelled', 'AbortError');
  const pending = pendingIndexes.get(key);
  if (pending) {
    try {
      const index = await pending.promise;
      if (options.isCancelled?.()) throw new DOMException('PDF indexing was cancelled', 'AbortError');
      options.onOutline?.(index.outline);
      options.onProgress?.(100);
      return index;
    } catch (error) {
      if (!pending.isCancelled() || options.isCancelled?.()) throw error;
      // A different pane can finish from its own still-open document.
      return readSharedPdfIndex(key, pdf, options);
    }
  }
  const entry = { promise: Promise.resolve(null as unknown as DocumentIndex), isCancelled: options.isCancelled ?? (() => false) };
  entry.promise = readPdfIndex(pdf, options).finally(() => { if (pendingIndexes.get(key) === entry) pendingIndexes.delete(key); });
  pendingIndexes.set(key, entry);
  return entry.promise;
}

export function loadPdf(bytes: Uint8Array) {
  const assets = `${import.meta.env.BASE_URL}pdf-assets/`;
  return getDocument({ data: new Uint8Array(bytes), cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/`, enableXfa: false });
}

export async function readPdfOutline(pdf: PDFDocumentProxy): Promise<OutlineItem[]> {
  const outline = await pdf.getOutline();
  const map = async (items: NonNullable<typeof outline>): Promise<OutlineItem[]> => Promise.all(items.map(async item => {
    let page = 1;
    try {
      const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
      if (destination?.[0] !== undefined) page = typeof destination[0] === 'number' ? destination[0] + 1 : (await pdf.getPageIndex(destination[0])) + 1;
    } catch { /* Preserve malformed destinations as editable entries. */ }
    return { id: crypto.randomUUID(), title: item.title || '未命名章节', page: Math.min(pdf.numPages, Math.max(1, page)), children: await map(item.items || []) };
  }));
  return outline ? map(outline) : [];
}

/** Extract in small batches so a long supplement doesn't monopolize the worker. */
export async function readPdfIndex(pdf: PDFDocumentProxy, options: IndexOptions = {}): Promise<DocumentIndex> {
  const assertActive = () => { if (options.isCancelled?.()) throw new DOMException('PDF indexing was cancelled', 'AbortError'); };
  assertActive();
  const outline = options.outline ?? await readPdfOutline(pdf);
  assertActive();
  options.onOutline?.(outline);
  const pages: string[] = [];
  for (let start = 1; start <= pdf.numPages; start += 3) {
    assertActive();
    const chunk = await scheduleTextBatch(async () => {
      assertActive();
      return Promise.all(Array.from({ length: Math.min(3, pdf.numPages - start + 1) }, async (_, offset) => {
        const page = await pdf.getPage(start + offset);
        const text = await page.getTextContent();
        return text.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
      }));
    });
    assertActive();
    pages.push(...chunk);
    options.onProgress?.(Math.round(pages.length * 100 / pdf.numPages));
  }
  const metadata = await pdf.getMetadata().catch(() => null);
  assertActive();
  const info = metadata?.info as { Title?: string; Author?: string } | undefined;
  return { pageCount: pdf.numPages, outline, pages, title: info?.Title, authors: info?.Author };
}
