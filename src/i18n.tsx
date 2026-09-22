import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { normalizeLanguage, translate, type Language, type Translator } from '../shared/i18n';

interface I18n { language: Language; locale: 'zh-CN' | 'en-US'; t: Translator }
const I18nContext = createContext<I18n>({ language: 'zh-CN', locale: 'zh-CN', t: (zh, en, values) => translate('zh-CN', zh, en, values) });

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo<I18n>(() => ({
    language: normalizeLanguage(language), locale: language === 'en' ? 'en-US' : 'zh-CN',
    t: (zh, en, values) => translate(normalizeLanguage(language), zh, en, values),
  }), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
