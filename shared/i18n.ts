export type Language = 'zh-CN' | 'en';
export type TranslationValues = Record<string, string | number>;
export type Translator = (chinese: string, english: string, values?: TranslationValues) => string;

export function normalizeLanguage(value: unknown): Language {
  return value === 'en' ? 'en' : 'zh-CN';
}

export function translate(language: Language, chinese: string, english: string, values?: TranslationValues): string {
  const text = language === 'en' ? english : chinese;
  return values ? text.replace(/\{(\w+)\}/g, (match, key) => Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match) : text;
}
