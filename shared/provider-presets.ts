import type { ProviderConfig } from './types';

/** Official standard API endpoints, checked 2026-10-13. Regional accounts and
 * Coding Plan endpoints are deliberately kept separate. Presets change only
 * the address; the user retains control of the model and supplies its key. */
export const CUSTOM_PROVIDER_PRESETS = [
  { id: 'kimi-cn', zh: 'Kimi · 中国平台', en: 'Kimi · China', baseURL: 'https://api.moonshot.cn/v1',
    docs: 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart', modelExample: 'kimi-k3' },
  { id: 'kimi-global', zh: 'Kimi · 国际平台', en: 'Kimi · Global', baseURL: 'https://api.moonshot.ai/v1',
    docs: 'https://platform.kimi.ai/docs/guide/kimi-k3-quickstart', modelExample: 'kimi-k3' },
  { id: 'glm-cn', zh: 'GLM · 智谱中国平台', en: 'GLM · China', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    docs: 'https://docs.bigmodel.cn/cn/guide/tools/web-search', modelExample: 'glm-5.3' },
  { id: 'glm-global', zh: 'GLM · Z.ai 国际平台', en: 'GLM · Z.ai Global', baseURL: 'https://api.z.ai/api/paas/v4',
    docs: 'https://docs.z.ai/', modelExample: '' },
] as const;

export function apiOrigin(baseURL: string): string | undefined {
  try {
    const url = new URL(baseURL.trim());
    return ['https:', 'http:'].includes(url.protocol) ? url.origin : undefined;
  } catch { return undefined; }
}

export function hasAPIOriginChanged(before: string, after: string): boolean {
  return apiOrigin(before) !== apiOrigin(after);
}

/** Clear any entered draft credential as soon as its destination changes. The
 * saved hasKey flag stays truthful until a replacement is explicitly saved. */
export function withProviderBaseURL(config: ProviderConfig, baseURL: string): ProviderConfig {
  return { ...config, baseURL, ...(hasAPIOriginChanged(config.baseURL, baseURL) ? { apiKey: undefined } : {}) };
}

export function requiresReplacementKey(saved: ProviderConfig, draft: ProviderConfig): boolean {
  return Boolean((saved.hasKey || saved.apiKey?.trim()) && hasAPIOriginChanged(saved.baseURL, draft.baseURL) && !draft.apiKey?.trim());
}

export function customPresetForURL(baseURL: string) {
  try {
    const url = new URL(baseURL.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    const endpoint = url.origin + url.pathname.replace(/\/+$/, '');
    return CUSTOM_PROVIDER_PRESETS.find(preset => preset.baseURL === endpoint);
  } catch { return undefined; }
}
