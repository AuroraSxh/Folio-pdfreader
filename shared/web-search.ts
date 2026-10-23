import type { ProviderConfig } from './types';
import { getQoderModel, isQoderEndpoint } from './qoder';

export interface WebSearchSource { title: string; url: string; snippet: string; publishedAt?: string }
export interface QoderWebCallEvidence {
  id: string; name: 'WebSearch' | 'WebFetch'; status: 'success' | 'error' | 'pending';
  sources: string[]; query?: string; url?: string; resultCount?: number; statusCode?: number;
  contentKind?: 'sdk_extracted_or_summarized_page';
}
export interface QoderWebEvidence { maxCalls: number; successfulSearches: number; successfulFetches: number; calls: QoderWebCallEvidence[] }
export interface WebSearchResult { query: string; sources: WebSearchSource[]; searchedAt: number; /** Provider-generated search summary, never a raw webpage excerpt. */ summary?: string; qoderEvidence?: QoderWebEvidence }
export type NativeWebSearchProvider = 'deepseek' | 'openai' | 'anthropic' | 'kimi' | 'glm' | 'qoder';
type SearchConfig = Pick<ProviderConfig, 'id' | 'baseURL'> & Partial<Pick<ProviderConfig, 'model'>>;

/** Keep credentials on the selected provider's official route; never infer a gateway's capabilities. */
export function webSearchProvider(config: SearchConfig | null | undefined): NativeWebSearchProvider | null {
  if (!config) return null;
  if (config.id === 'qoder') return isQoderEndpoint(config.baseURL) && getQoderModel(config.model) ? 'qoder' : null;
  try {
    const url = new URL(config.baseURL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/+$/, '');
    if (['', '/v1'].includes(path)) {
      if (config.id === 'deepseek' && url.origin === 'https://api.deepseek.com') return 'deepseek';
      if (config.id === 'openai' && url.origin === 'https://api.openai.com') return 'openai';
      if (config.id === 'anthropic' && url.origin === 'https://api.anthropic.com') return 'anthropic';
      if (config.id === 'custom' && ['https://api.moonshot.ai', 'https://api.moonshot.cn'].includes(url.origin) && config.model === 'kimi-k3') return 'kimi';
    }
    if (config.id === 'custom' && path === '/api/paas/v4' && ['https://open.bigmodel.cn', 'https://api.z.ai'].includes(url.origin)) return 'glm';
    return null;
  } catch { return null; }
}

export function supportsWebSearch(config: SearchConfig | null | undefined): boolean { return webSearchProvider(config) !== null; }

function privateIPv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function privateIPv6(host: string): boolean {
  const parts = host.slice(1, -1).split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const words = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].map(word => parseInt(word, 16));
  if (words.length !== 8 || words.some(word => !Number.isFinite(word))) return true;
  const first = words[0];
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return true;
  if (words.slice(0, 6).every(word => word === 0)) return true; // Unspecified, loopback and obsolete IPv4-compatible addresses.
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return privateIPv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
  }
  return false;
}

/** Validate links only; no page fetch or DNS lookup is performed. */
export function safeWebSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host === 'local' || host.endsWith('.local')
      || host === 'internal' || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home')
      || host === 'home.arpa' || host.endsWith('.home.arpa') || (!host.includes('.') && !host.startsWith('['))) return null;
    if (host.startsWith('[') ? privateIPv6(host) : /^\d+\.\d+\.\d+\.\d+$/.test(host) && privateIPv4(host.split('.').map(Number))) return null;
    return url.href;
  } catch { return null; }
}
