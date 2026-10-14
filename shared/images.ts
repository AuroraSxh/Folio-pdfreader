/** Image attachments are bounded, local PNG/JPEG data. This module is browser-safe. */
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CHAT_IMAGES_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_IMAGE_EDGE = 2048;
export const MAX_CHAT_IMAGE_PIXELS = 4_200_000;
export type ChatImageMimeType = 'image/png' | 'image/jpeg';
export interface ChatImageSource { documentId: string; documentName: string; page: number; rect?: number[] }
export interface DraftChatImage { dataUrl: string; name: string; source?: ChatImageSource }
export interface StoredChatImage { id: string; name: string; mimeType: ChatImageMimeType; width: number; height: number; byteSize: number; source?: ChatImageSource }
export interface ValidatedDraftChatImage extends DraftChatImage { mimeType: ChatImageMimeType; width: number; height: number; byteSize: number; bytes: Uint8Array }
export interface ImageSourceDocument { id: string; name: string; pageCount: number }
export const isChatImageId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
function validateName(value: unknown): asserts value is string {
  if (!text(value, 500) || /^\s*(?:data:|https?:|file:)/i.test(value)) throw new Error('图片名称无效 / Invalid image name.');
}
export function validateChatImageSource(value: unknown, documents?: readonly ImageSourceDocument[]): asserts value is ChatImageSource | undefined {
  if (value === undefined) return;
  if (!record(value) || Object.keys(value).some(key => !['documentId', 'documentName', 'page', 'rect'].includes(key))
    || typeof value.documentId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.documentId) || !text(value.documentName, 1000)
    || !Number.isSafeInteger(value.page) || Number(value.page) < 1 || Number(value.page) > 1_000_000) throw new Error('图片来源无效 / Invalid image source.');
  if (value.rect !== undefined && (!Array.isArray(value.rect) || value.rect.length !== 4 || !value.rect.every(item => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1_000_000)
    || value.rect[2] <= value.rect[0] || value.rect[3] <= value.rect[1])) throw new Error('图片框选范围无效 / Invalid image selection bounds.');
  if (documents) {
    const document = documents.find(item => item.id === value.documentId);
    if (!document || !Number.isSafeInteger(document.pageCount) || document.pageCount < Number(value.page)) throw new Error('图片来源不在当前论文或页码无效 / Image source is outside this paper or page range.');
  }
}
function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_CHAT_IMAGE_EDGE || height > MAX_CHAT_IMAGE_EDGE || width * height > MAX_CHAT_IMAGE_PIXELS) throw new Error('图片尺寸超限（最长边 2048） / Image dimensions exceed the 2048-pixel edge limit.');
  return { width, height };
}
const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes: Uint8Array, start: number, end: number) { let crc = 0xffffffff; for (let index = start; index < end; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export function inspectChatImageBytes(bytes: Uint8Array): { mimeType: ChatImageMimeType; width: number; height: number; byteSize: number } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > MAX_CHAT_IMAGE_BYTES) throw new Error('图片内容为空或超过 4 MiB / Image is empty or exceeds 4 MiB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = bytes.byteLength;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    let offset = 8, size: { width: number; height: number } | undefined, data = false, palette = false, color = -1;
    while (offset + 12 <= length) {
      const chunkLength = view.getUint32(offset), end = offset + 12 + chunkLength;
      if (end > length) throw new Error('PNG 文件不完整 / Truncated PNG image.');
      const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (!/^[A-Za-z]{4}$/.test(kind) || crc32(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) throw new Error('PNG 图片校验失败 / Invalid PNG checksum.');
      if (!size && kind !== 'IHDR') throw new Error('PNG 文件头无效 / Invalid PNG header.');
      if (kind === 'IHDR') {
        if (offset !== 8 || chunkLength !== 13) throw new Error('PNG 文件头无效 / Invalid PNG header.');
        size = dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
        const depth = bytes[offset + 16]; color = bytes[offset + 17];
        const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) throw new Error('PNG 编码无效 / Invalid PNG encoding.');
      } else if (kind === 'PLTE') { if (data || !chunkLength || chunkLength % 3 || chunkLength > 768) throw new Error('PNG 调色板无效 / Invalid PNG palette.'); palette = true; }
      else if (kind === 'IDAT') { if (color === 3 && !palette) throw new Error('PNG 缺少调色板 / Missing PNG palette.'); data ||= chunkLength > 0; }
      else if (kind === 'acTL') throw new Error('不支持动画图片 / Animated images are not supported.');
      else if (kind === 'IEND') {
        if (chunkLength || !data || end !== length || !size) throw new Error('PNG 文件不完整 / Invalid PNG image end.');
        return { mimeType: 'image/png', ...size, byteSize: length };
      }
      offset = end;
    }
    throw new Error('PNG 文件不完整 / Truncated PNG image.');
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[length - 2] === 0xff && bytes[length - 1] === 0xd9) {
    let offset = 2, size: { width: number; height: number } | undefined;
    while (offset + 4 <= length) {
      if (bytes[offset++] !== 0xff) throw new Error('JPEG 文件头无效 / Invalid JPEG marker.');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if ([0, 1, 0xd8, 0xd9].includes(marker) || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > length) throw new Error('JPEG 文件头无效 / Invalid JPEG header.');
      const segmentLength = view.getUint16(offset), end = offset + segmentLength;
      if (segmentLength < 2 || end > length - 2) throw new Error('JPEG 文件不完整 / Truncated JPEG image.');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size || segmentLength < 8 || bytes[offset + 2] !== 8 || ![1, 3, 4].includes(bytes[offset + 7]) || segmentLength !== 8 + 3 * bytes[offset + 7]) throw new Error('JPEG 编码无效 / Invalid JPEG encoding.');
        size = dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) throw new Error('不支持此 JPEG 编码 / Unsupported JPEG encoding.');
      if (marker === 0xda) {
        if (!size || segmentLength < 6 || end >= length - 2) throw new Error('JPEG 图片无有效图像内容 / Missing JPEG image content.');
        return { mimeType: 'image/jpeg', ...size, byteSize: length };
      }
      offset = end;
    }
  }
  throw new Error('只支持有效的 PNG 或 JPEG 图片 / Only valid PNG or JPEG images are supported.');
}
export function validateDraftChatImages(value: unknown, documents?: readonly ImageSourceDocument[]): ValidatedDraftChatImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_IMAGES) throw new Error('每轮最多 4 张图片 / At most 4 images are allowed per turn.');
  let total = 0;
  return value.map(item => {
    if (!record(item) || Object.keys(item).some(key => !['dataUrl', 'name', 'source'].includes(key))) throw new Error('图片附件格式无效 / Invalid image attachment.');
    validateName(item.name); validateChatImageSource(item.source, documents);
    if (typeof item.dataUrl !== 'string' || item.dataUrl.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 + 32) throw new Error('图片内容超限 / Image data exceeds the limit.');
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(item.dataUrl);
    if (!match || !match[2] || match[2].length % 4) throw new Error('图片必须是本地 PNG/JPEG 数据 / A local PNG/JPEG data URL is required.');
    let binary: string;
    try { binary = atob(match[2]); if (btoa(binary) !== match[2]) throw new Error(); } catch { throw new Error('图片 Base64 无效 / Invalid image base64.'); }
    if (binary.length > MAX_CHAT_IMAGE_BYTES || (total += binary.length) > MAX_CHAT_IMAGES_BYTES) throw new Error('图片最多 4 MiB，合计最多 8 MiB / Images must be at most 4 MiB each and 8 MiB per turn.');
    const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const metadata = inspectChatImageBytes(bytes);
    if (metadata.mimeType !== match[1]) throw new Error('图片 MIME 类型与内容不匹配 / Image MIME type does not match its content.');
    return { dataUrl: item.dataUrl, name: item.name.trim(), ...(item.source ? { source: structuredClone(item.source) } : {}), ...metadata, bytes };
  });
}
export function validateStoredChatImages(value: unknown, documents?: readonly ImageSourceDocument[]): asserts value is StoredChatImage[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_CHAT_IMAGES) throw new Error('已保存图片记录无效 / Invalid stored image records.');
  let total = 0; const ids = new Set<string>();
  for (const item of value) {
    if (!record(item) || Object.keys(item).some(key => !['id', 'name', 'mimeType', 'width', 'height', 'byteSize', 'source'].includes(key))
      || !isChatImageId(item.id) || ids.has(item.id) || !['image/png', 'image/jpeg'].includes(String(item.mimeType))
      || !Number.isSafeInteger(item.byteSize) || Number(item.byteSize) < 24 || Number(item.byteSize) > MAX_CHAT_IMAGE_BYTES || (total += Number(item.byteSize)) > MAX_CHAT_IMAGES_BYTES) throw new Error('已保存图片记录无效 / Invalid stored image records.');
    validateName(item.name); validateChatImageSource(item.source, documents); dimensions(Number(item.width), Number(item.height));
    if (typeof item.width !== 'number' || typeof item.height !== 'number') throw new Error('图片尺寸记录无效 / Invalid stored image dimensions.');
    ids.add(item.id);
  }
}
export function chatImageFilename(image: Pick<StoredChatImage, 'id' | 'mimeType'>): string {
  if (!isChatImageId(image.id) || !['image/png', 'image/jpeg'].includes(image.mimeType)) throw new Error('图片编号无效 / Invalid image identifier.');
  return image.id + (image.mimeType === 'image/png' ? '.png' : '.jpg');
}
