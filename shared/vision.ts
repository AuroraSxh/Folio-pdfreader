import type { ProviderConfig } from './types';
import { getQoderModel, isQoderEndpoint } from './qoder';

export interface VisionCapability {
  status: 'supported' | 'unsupported' | 'unknown';
  reason: { 'zh-CN': string; en: string };
  suggestion: { 'zh-CN': string; en: string };
  docs?: string;
}
type Config = Pick<ProviderConfig, 'id' | 'baseURL' | 'model' | 'vision'>;
const bilingual = (zh: string, en: string) => ({ 'zh-CN': zh, en });
// Exact aliases/snapshots from the image guide and each /api/docs/models/{id}
// page (input modalities=image, supported endpoints=chat_completions). Do not
// infer future model suffixes or dates from a family name.
const openAIVisionModels = new Set([
  'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.5-2026-04-23',
  'gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17', 'gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17',
  'gpt-5.2', 'gpt-5.2-2025-12-11', 'gpt-5.1', 'gpt-5.1-2025-11-13',
  'gpt-5', 'gpt-5-2025-08-07', 'gpt-5-mini', 'gpt-5-mini-2025-08-07', 'gpt-5-nano', 'gpt-5-nano-2025-08-07',
  'gpt-5-chat-latest', 'gpt-5.1-chat-latest', 'gpt-5.2-chat-latest', 'gpt-5.3-chat-latest',
  'gpt-4.1', 'gpt-4.1-2025-04-14', 'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-4.1-nano', 'gpt-4.1-nano-2025-04-14',
  'gpt-4o', 'gpt-4o-2024-11-20', 'gpt-4o-2024-08-06', 'gpt-4o-2024-05-13', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18',
  'o1', 'o1-2024-12-17', 'o3', 'o3-2025-04-16', 'o4-mini', 'o4-mini-2025-04-16',
]);
// Active / not-yet-retired IDs and documented convenience aliases:
// https://platform.claude.com/docs/en/about-claude/model-deprecations
// https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
const claudeVisionModels = new Set([
  'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
  'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6',
  'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
]);

/** Official documentation checked 2026-10-14. Capability is tied to the selected
 * model and route; it never changes the model, provider, endpoint or key.
 * https://api-docs.deepseek.com/guides/vision/
 * https://developers.openai.com/api/docs/guides/images-vision
 * https://platform.claude.com/docs/en/build-with-claude/vision
 * https://platform.kimi.ai/docs/guide/use-kimi-vision-model
 * https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5v-turbo
 * https://docs.z.ai/guides/vlm/glm-4.6v
 */
export function getVisionCapability(config: Config | null | undefined): VisionCapability {
  const generic = bilingual('请在设置中选择支持图片的模型；未知的兼容接口需先确认图片能力并手动启用。', 'Choose a vision-capable model in Settings. For an unknown compatible endpoint, confirm image support and explicitly enable it.');
  const result = (status: VisionCapability['status'], zh: string, en: string, docs?: string, suggestion = generic): VisionCapability => ({ status, reason: bilingual(zh, en), suggestion, ...(docs ? { docs } : {}) });
  if (!config || !config.model?.trim()) return result('unsupported', '尚未选择模型。', 'No model is selected.');
  if (config.vision === 'disabled') return result('unsupported', '此服务配置已关闭图片输入。', 'Image input is disabled for this configuration.');
  if (config.id === 'qoder') {
    if (!isQoderEndpoint(config.baseURL)) return result('unsupported','Qoder 图片输入仅允许已配置的本机 HTTP 回环接口。','Qoder image input requires the configured local HTTP loopback endpoint.');
    const model = getQoderModel(config.model);
    if (!model) return result('unknown','尚未确认此 Qoder 型号的图片能力，请选择模型目录中的型号。','Image support for this Qoder model is unknown. Choose a catalog model.');
    return model.vision
      ? result('supported','本机 Qoder 模型目录声明此型号支持图片输入。','The local Qoder model catalog advertises image input for this model.',undefined,bilingual('图片使用当前型号与其对应密钥，经本机代理发送至 Qoder 上游服务。','Images use the selected model and its matching key, through the local proxy to Qoder’s upstream service.'))
      : result('unsupported','本机 Qoder 目录未为此型号启用图片输入。','The local Qoder catalog does not enable image input for this model.');
  }
  let origin = '', pathname = '';
  try { const url = new URL(config.baseURL); if (!url.username && !url.password && !url.search && !url.hash && url.protocol === 'https:') { origin = url.origin; pathname = url.pathname.replace(/\/+$/, ''); } } catch { /* Unknown endpoint requires explicit confirmation. */ }
  const model = config.model.trim().toLowerCase();
  let docs: string | undefined, supported = false, unsupported = false, retired = false;
  if (origin === 'https://api.deepseek.com' && ['', '/v1', '/chat/completions', '/v1/chat/completions'].includes(pathname) && config.id !== 'anthropic') {
    docs = 'https://api-docs.deepseek.com/guides/vision/';
    supported = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model);
    unsupported = ['deepseek-chat', 'deepseek-reasoner'].includes(model);
  } else if (origin === 'https://api.openai.com' && ['/v1', '/v1/chat/completions'].includes(pathname) && config.id !== 'anthropic') {
    docs = 'https://developers.openai.com/api/docs/guides/images-vision';
    supported = openAIVisionModels.has(model);
    unsupported = /^(?:gpt-3\.5(?:-|$)|gpt-4$|gpt-4-0[36]14$|o1-(?:mini|preview)(?:-|$)|o3-mini(?:-|$))/.test(model);
  } else if (origin === 'https://api.anthropic.com' && ['', '/v1', '/v1/messages'].includes(pathname) && config.id === 'anthropic') {
    docs = 'https://platform.claude.com/docs/en/build-with-claude/vision';
    supported = claudeVisionModels.has(model);
    unsupported = /^(?:claude-2(?:\.|$)|claude-instant(?:-|$))/.test(model);
  } else if (['https://api.moonshot.ai', 'https://api.moonshot.cn'].includes(origin) && ['/v1', '/v1/chat/completions'].includes(pathname) && config.id !== 'anthropic') {
    docs = 'https://platform.kimi.ai/docs/guide/use-kimi-vision-model';
    supported = ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'].includes(model);
    // K2.5 and moonshot-v1 vision models did support images historically. Their
    // official endpoint retired them on 2026-08-31; this is not a vision claim.
    // https://platform.kimi.ai/docs/models
    retired = /^(?:moonshot-v1-|kimi-k2(?:-|$)|kimi-k2\.5$|kimi-latest$|kimi-thinking-preview$)/.test(model);
  } else if (['https://open.bigmodel.cn', 'https://api.z.ai'].includes(origin) && ['/api/paas/v4', '/api/paas/v4/chat/completions'].includes(pathname) && config.id !== 'anthropic') {
    docs = origin.includes('bigmodel') ? 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5v-turbo' : 'https://docs.z.ai/guides/vlm/glm-5v-turbo';
    supported = ['glm-5v-turbo', 'glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx'].includes(model);
    // GLM-4V-Flash is URL-only; local image uploads are not supported by this adapter.
    unsupported = /^(?:glm-4(?:\.[0-9]+)?(?:-(?:plus|air|airx|flash|flashx|long|alltools))?|glm-5(?:\.[0-9]+)?(?:-turbo)?|glm-4v-flash)$/.test(model);
  }
  if (retired) return result('unsupported', '官方接口已停止提供此型号；这不代表该型号过去不支持图片。', 'The official endpoint has retired this model; this does not mean it lacked image support historically.', 'https://platform.kimi.ai/docs/models');
  if (unsupported) return result('unsupported', '当前模型不支持此应用的本地图片输入，或已停止服务。', 'This model does not support this app’s local image input, or has been retired.', docs);
  if (supported) return result('supported', '当前官方模型支持图片输入。', 'The selected official model supports image input.', docs,
    bilingual('将以当前模型发送你选择的图片；图片会计入服务商用量。', 'Selected images use the current model and count toward provider usage.'));
  if (config.vision === 'enabled') return result('supported', '已按你的明确设置启用兼容接口图片输入，实际能力由该模型和服务端决定。', 'Image input is explicitly enabled for this compatible endpoint; actual support depends on its model and server.', docs);
  return result('unknown', '尚未确认此模型与接口组合的图片能力。', 'Image support for this model and endpoint has not been confirmed.', docs);
}

export function supportsVision(config: Config | null | undefined): boolean { return getVisionCapability(config).status === 'supported'; }
