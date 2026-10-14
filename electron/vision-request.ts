import type { ChatMessage, ProviderConfig } from '../shared/types';
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGES_BYTES, validateDraftChatImages, type DraftChatImage, type StoredChatImage } from '../shared/images';
import { getVisionCapability, supportsVision } from '../shared/vision';
import { sanitizeData } from '../shared/prompts';
import { translate, type Language } from '../shared/i18n';

export interface VisionMessage { role: 'system' | 'user' | 'assistant'; content: string; images?: DraftChatImage[] }

export function imageLabels(images: DraftChatImage[], language: Language): string[] {
  return images.map((image, index) => {
    const name = sanitizeData(image.name).replace(/[\r\n\[\]]/g, ' ').slice(0, 180);
    const source = image.source ? `[${sanitizeData(image.source.documentName).replace(/[\r\n\[\]]/g, ' ').slice(0, 240)} p.${image.source.page}]` : '';
    return translate(language, '图片 {number}：{name} {source}{crop}', 'Image {number}: {name} {source}{crop}', {
      number: index + 1, name, source, crop: image.source?.rect ? translate(language, '（仅框选区域）', ' (selected region only)') : '',
    }).trim();
  });
}

/** Documented GLM examples use raw base64 as image_url.url. Other compatible
 * chat routes use a PNG/JPEG data URL; Anthropic uses native image blocks. */
function nativeGLM(config: ProviderConfig): boolean {
  try { const url = new URL(config.baseURL); return ['https://open.bigmodel.cn', 'https://api.z.ai'].includes(url.origin) && /^\/api\/paas\/v4(?:\/chat\/completions)?\/?$/.test(url.pathname); } catch { return false; }
}

export function serializeVisionMessages(config: ProviderConfig, messages: VisionMessage[], language: Language = 'zh-CN'): { role: VisionMessage['role']; content: string | Record<string, unknown>[] }[] {
  const attachments = messages.flatMap(message => message.images ?? []);
  if (!attachments.length) return messages.map(({ role, content }) => ({ role, content }));
  const capability = getVisionCapability(config);
  if (capability.status !== 'supported') throw new Error(`${capability.reason[language]} ${capability.suggestion[language]}`);
  validateDraftChatImages(attachments); // Bounds apply to the whole outgoing request, including history.
  return messages.map(message => {
    if (!message.images?.length) return { role: message.role, content: message.content };
    if (message.role !== 'user') throw new Error(translate(language, '图片只能附在用户消息中。', 'Images can only be attached to user messages.'));
    const labels = imageLabels(message.images, language), content: Record<string, unknown>[] = [];
    message.images.forEach((image, index) => {
      const comma = image.dataUrl.indexOf(','), base64 = image.dataUrl.slice(comma + 1), mime = image.dataUrl.slice(5, image.dataUrl.indexOf(';'));
      content.push({ type: 'text', text: labels[index] });
      content.push(config.id === 'anthropic'
        ? { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } }
        : { type: 'image_url', image_url: { url: nativeGLM(config) ? base64 : image.dataUrl } });
    });
    content.push({ type: 'text', text: message.content });
    return { role: message.role, content };
  });
}

/** Kimi preserved-thinking models require full hidden thinking for native
 * assistant continuation. We instead send visible history as reference data. */
export function needsVisibleKimiHistory(config: ProviderConfig): boolean {
  try { return ['https://api.moonshot.ai', 'https://api.moonshot.cn'].includes(new URL(config.baseURL).origin)
    && ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'].includes(config.model); } catch { return false; }
}

/** Only the latest image-bearing user turn, in a short recent conversation
 * window, can be recalled. A new attached image takes precedence unless the
 * question explicitly asks to compare with an earlier image. */
export function previousImageTurn(messages: ChatMessage[], prompt: string, currentCount: number): StoredChatImage[] {
  const comparePrevious = /\b(?:compare|previous|earlier|first image|last image)\b|比较|对比|前一|上一|之前|刚才/i.test(prompt);
  if (currentCount && !comparePrevious) return [];
  if (/\b(?:new topic|unrelated question|switch(?:ing)? topics)\b|换个话题|另一个问题/.test(prompt)) return [];
  const blocked = new Set(messages.filter(message => message.interrupted && message.turnId).map(message => message.turnId));
  const recent = messages.filter((message, index) => !message.interrupted && !(message.turnId && blocked.has(message.turnId))
    && !(message.role === 'user' && messages[index + 1]?.role === 'assistant' && messages[index + 1].interrupted)).slice(-8);
  const latestUser = [...recent].reverse().find(message => message.role === 'user');
  const visualFollowup = comparePrevious || /\b(?:image|figure|chart|panel|plot|line|legend|axis|axes|bar|color|colour|p.value|this|that|it|they|these|those)\b|图|表|曲线|坐标|颜色|这个|那个|这些|那些|它|还有|那么/i.test(prompt);
  if (!latestUser?.images?.length && !visualFollowup) return [];
  return [...recent].reverse().find(message => message.role === 'user' && message.images?.length)?.images ?? [];
}

export async function recallHistoryImages(options: {
  candidates: StoredChatImage[]; current: DraftChatImage[]; config: ProviderConfig;
  read?: (imageId: string) => Promise<string>; signal: AbortSignal; language: Language;
}): Promise<{ images: DraftChatImage[]; warnings: string[] }> {
  const { candidates, current, config, read, signal, language } = options;
  const t = (zh: string, en: string) => translate(language, zh, en);
  if (!candidates.length) return { images: [], warnings: [] };
  if (!supportsVision(config)) return { images: [], warnings: [t('当前模型未启用图片能力，本轮没有重发历史图片；只能参考已保存的文字对话。', 'Image input is unavailable for the current model. Earlier images were not resent; only the saved text conversation is available.')] };
  const currentValidated = validateDraftChatImages(current);
  let bytes = currentValidated.reduce((sum, image) => sum + image.byteSize, 0), missing = 0, omitted = 0;
  const images: DraftChatImage[] = [];
  for (const image of candidates) {
    signal.throwIfAborted();
    if (current.length + images.length >= MAX_CHAT_IMAGES || bytes + image.byteSize > MAX_CHAT_IMAGES_BYTES) { omitted++; continue; }
    if (!read) { missing++; continue; }
    try {
      const dataUrl = await read(image.id); signal.throwIfAborted();
      const draft: DraftChatImage = { dataUrl, name: image.name, ...(image.source ? { source: image.source } : {}) };
      const validated = validateDraftChatImages([draft])[0];
      if (validated.byteSize !== image.byteSize || validated.width !== image.width || validated.height !== image.height || validated.mimeType !== image.mimeType) throw new Error('Image metadata mismatch');
      if (bytes + validated.byteSize > MAX_CHAT_IMAGES_BYTES) { omitted++; continue; }
      bytes += validated.byteSize;
      images.push({ ...draft, name: t('历史图片：', 'Earlier image: ') + image.name.slice(0, 400) });
    } catch { signal.throwIfAborted(); missing++; }
  }
  const warnings: string[] = [];
  if (images.length) warnings.push(t('本轮重发了最近相关对话中的图片，用于理解追问；图片会计入本轮用量。', 'Images from the most recent relevant exchange were resent for this follow-up and count toward this request’s usage.'));
  if (missing) warnings.push(t('部分历史图片缺失或无法读取，本轮未发送这些图片；请重新附图后再询问其视觉细节。', 'Some earlier images are missing or unreadable and were not sent. Attach them again to ask about their visual details.'));
  if (omitted) warnings.push(t('部分历史图片因本轮图片额度而未发送；仅分析实际附带的图片。', 'Some earlier images were omitted due to this request’s image limits. Only the attached images can be analyzed.'));
  return { images, warnings };
}
