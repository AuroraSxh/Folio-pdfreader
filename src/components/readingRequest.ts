import type { ChatRequest, TextSelection } from '../../shared/types';
import type { Language } from '../../shared/i18n';
import { getSummaryPrompt } from '../../shared/prompts';

/** Resolve before constructing ChatRequest so all typed, summary, retry and voice paths agree. */
export function resolveReadingRequest({ prompt, kind = 'chat', mode = 'smart', override, voice = false, language, webSearch = false, webSearchOverride }: {
  prompt: string; kind?: ChatRequest['kind']; mode?: ChatRequest['readingMode'];
  override?: ChatRequest['readingMode']; voice?: boolean; language: Language;
  webSearch?: boolean; webSearchOverride?: boolean;
}): Pick<ChatRequest, 'prompt' | 'kind' | 'readingMode' | 'webSearch'> {
  const readingMode = voice ? 'smart' : override ?? (kind === 'summary' ? 'deep' : mode);
  const search = webSearchOverride ?? webSearch;
  if (!prompt.trim() && readingMode === 'deep') return { prompt: getSummaryPrompt(language), kind: 'summary', readingMode, webSearch: search };
  return { prompt: prompt.trim(), kind, readingMode, webSearch: search };
}

/** A quoted passage remains part of this question even when the source picker
 * names another PDF. Explicit request sources (retry/summary) must never pick up
 * a newer live selection. Reject a stale quote instead of silently dropping it. */
export function resolveReadingSources({ documents, source, selection, sourceOverride, selectionOverride }: {
  documents: readonly { id: string }[];
  source: string;
  selection?: TextSelection | null;
  sourceOverride?: readonly string[];
  selectionOverride?: TextSelection | null;
}): Pick<ChatRequest, 'documentIds' | 'selection'> & { addedSelectionDocument: boolean; selectionUnavailable: boolean } {
  const documentIds = sourceOverride !== undefined ? [...sourceOverride] : source === 'all' ? documents.map(doc => doc.id) : [source];
  const requestSelection = selectionOverride !== undefined ? selectionOverride ?? undefined : sourceOverride !== undefined ? undefined : selection ?? undefined;
  if (requestSelection && !documents.some(doc => doc.id === requestSelection.documentId)) {
    return { documentIds, selection: undefined, addedSelectionDocument: false, selectionUnavailable: true };
  }
  const addedSelectionDocument = Boolean(requestSelection && !documentIds.includes(requestSelection.documentId));
  if (addedSelectionDocument) documentIds.push(requestSelection!.documentId);
  return { documentIds, selection: requestSelection, addedSelectionDocument, selectionUnavailable: false };
}
