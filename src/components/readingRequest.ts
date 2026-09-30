import type { ChatRequest } from '../../shared/types';
import type { Language } from '../../shared/i18n';
import { getSummaryPrompt } from '../../shared/prompts';

/** Resolve before constructing ChatRequest so all typed, summary, retry and voice paths agree. */
export function resolveReadingRequest({ prompt, kind = 'chat', mode = 'smart', override, voice = false, language }: {
  prompt: string; kind?: ChatRequest['kind']; mode?: ChatRequest['readingMode'];
  override?: ChatRequest['readingMode']; voice?: boolean; language: Language;
}): Pick<ChatRequest, 'prompt' | 'kind' | 'readingMode'> {
  const readingMode = voice ? 'smart' : override ?? (kind === 'summary' ? 'deep' : mode);
  if (!prompt.trim() && readingMode === 'deep') return { prompt: getSummaryPrompt(language), kind: 'summary', readingMode };
  return { prompt: prompt.trim(), kind, readingMode };
}
