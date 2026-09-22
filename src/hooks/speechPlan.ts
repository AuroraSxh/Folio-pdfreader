import { pronounceAcademicText } from './speechPronunciation';
import { speechCitations, type SpeechSource } from './speechCitations';
import type { VoiceSpeakSegment } from '../../shared/voice';

export interface SpeechPreferences {
  locale: 'zh-CN' | 'en-US';
  readingMode: 'auto' | 'zh-CN' | 'en-US';
  chineseVoiceId: string;
  englishVoiceId: string;
}

/** Only the disposable speech copy is cleaned. Stored answers remain verbatim. */
export function spokenText(markdown: string): string {
  return markdown.replace(/```[^\n]*\n[\s\S]*?```/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/(?:https?:\/\/|doi:\s*)[^\s<>()\[\]，。！？；：\p{Script=Han}]+/giu, url => url.match(/[.,;!?]+$/)?.[0] ?? '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Scientific identifiers, decimal points and common abbreviations are not
 * sentence boundaries. Scan once; no language model or background work. */
function sentenceParts(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!'.!?。！？;；\n'.includes(char)) continue;
    if (char === '.') {
      if (/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) continue;
      const token = text.slice(Math.max(start, i - 18), i + 1);
      if (/(?:\b(?:figs?|eqs?|refs?|dr|mr|mrs|ms|prof|vs|no|vol|approx|al)\.|\b(?:[a-z]\.){2,}|\b[A-Z]\.)$/i.test(token)) continue;
      if (text[i + 1] && !/[\s\u3400-\u9fff"”’')\]]/.test(text[i + 1])) continue;
    }
    let end = i + 1;
    // Keep closing quotes, repeated punctuation, and paragraph spacing together.
    while (end < text.length && /[!?。！？;；"”’')\]\s]/.test(text[end])) end++;
    const part = text.slice(start, end);
    if (part.trim()) parts.push(part);
    start = end; i = end - 1;
  }
  if (text.slice(start).trim()) parts.push(text.slice(start));
  return parts;
}

function sentenceLocale(text: string, fallback: SpeechPreferences['locale']): SpeechPreferences['locale'] {
  // Short Latin terms inside a Chinese sentence keep the Chinese speaker.
  if (/\p{Script=Han}/u.test(text)) return 'zh-CN';
  if (/[A-Za-z]{2}/.test(text)) return 'en-US';
  return fallback;
}

function pronounce(text: string, locale: string): string {
  // Only unambiguous, common reading conventions. Never spell every capitalized
  // identifier: e.g. gene names, units and acronyms may have domain pronunciations.
  return text.replace(/\b(Figs?|Eq|Eqs)\.\s*(?=\d)/gi, (_match, word: string) =>
    locale === 'zh-CN' ? (/^fig/i.test(word) ? '图 ' : '公式 ') : (/^fig/i.test(word) ? 'Figure ' : 'Equation '));
}

// Preserve words, biomedical identifiers and consecutive English terms as a
// single pronunciation unit. No per-letter conversion or identifier rewriting.
const ENGLISH_TERM = /[A-Za-z][A-Za-z0-9]*(?:[.\/\-‐‑–’'][A-Za-z0-9α-ωΑ-Ω]+)*\+?(?:[ \t]+[A-Za-z0-9][A-Za-z0-9]*(?:[.\/\-‐‑–’'][A-Za-z0-9α-ωΑ-Ω]+)*\+?)*/g;

export function buildSpeechPlan(markdown: string, preferences: SpeechPreferences, sources: SpeechSource[] = []): { text: string; locale: string; segments: VoiceSpeakSegment[] } {
  const clean = pronounceAcademicText(spokenText(speechCitations(markdown, sources, preferences.locale)));
  const baseLocale = preferences.readingMode === 'auto' ? sentenceLocale(clean, preferences.locale) : preferences.readingMode;
  const parts = sentenceParts(clean);
  const segments: VoiceSpeakSegment[] = [];
  let previousLocale = baseLocale;
  const add = (text: string, language: SpeechPreferences['locale']) => {
    if (!text) return;
    const previous = segments.at(-1);
    // Punctuation-only tails belong to the preceding word, never a separate
    // utterance which could introduce a gap or fail to synthesize.
    if (previous && !/[A-Za-z\p{Script=Han}\d]/u.test(text)) { previous.text += text; return; }
    if (previous && ((previous.locale === language && !previous.pauseAfter) || segments.length >= 256)) {
      previous.text += text;
    } else {
      const voiceId = language === 'zh-CN' ? preferences.chineseVoiceId : preferences.englishVoiceId;
      segments.push({ text, locale: language, ...(voiceId ? { voiceId } : {}), pauseAfter: 0 });
    }
  };
  for (const part of parts) {
    const language = preferences.readingMode === 'auto' ? sentenceLocale(part, previousLocale) : preferences.readingMode;
    const text = pronounce(part, language);
    if (preferences.readingMode === 'auto' && /\p{Script=Han}/u.test(text)) {
      let offset = 0;
      for (const match of text.matchAll(ENGLISH_TERM)) {
        add(text.slice(offset, match.index), language);
        add(match[0], 'en-US');
        offset = match.index + match[0].length;
      }
      add(text.slice(offset), language);
    } else add(text, language);
    const last = segments.at(-1);
    if (last) last.pauseAfter = /\n\s*\n/.test(part.slice(part.trimEnd().length)) ? 0.12 : 0;
    previousLocale = language;
  }
  if (segments.length) segments[segments.length - 1].pauseAfter = 0;
  return { text: segments.map(segment => segment.text).join(''), locale: baseLocale, segments };
}
