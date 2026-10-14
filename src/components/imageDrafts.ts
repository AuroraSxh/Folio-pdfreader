import { MAX_CHAT_IMAGE_BYTES, validateDraftChatImages, type DraftChatImage, type ImageSourceDocument } from '../../shared/images';

export interface DraftImageItem { id: string; image: DraftChatImage }
export interface ImageSubmission { images: DraftChatImage[]; draftIds?: string[]; draftText?: string; scope?: ImageRequestScope }
export interface ImageRequestScope { workspaceId: string; conversationId: string }
export const sameImageScope = (a: ImageRequestScope, b: ImageRequestScope) => a.workspaceId === b.workspaceId && a.conversationId === b.conversationId;

/** Keep decoded validation buffers out of persistent React state and IPC. */
export function validatedDrafts(images: unknown, documents?: readonly ImageSourceDocument[]): DraftChatImage[] {
  return validateDraftChatImages(images, documents).map(({ dataUrl, name, source }) => ({ dataUrl, name, ...(source ? { source } : {}) }));
}
export function appendDraftImage(current: readonly DraftImageItem[], image: DraftChatImage, id: string, documents?: readonly ImageSourceDocument[]): DraftImageItem[] {
  const validated = validatedDrafts([...current.map(item => item.image), image], documents);
  return [...current, { id, image: validated[validated.length - 1] }];
}
/** A second capture made while startChat is awaiting acknowledgement must survive. */
export function removeSubmittedDrafts(current: readonly DraftImageItem[], submittedIds: readonly string[]): DraftImageItem[] {
  const sent = new Set(submittedIds);
  return current.filter(item => !sent.has(item.id));
}
/** Only an explicit composer submission or retry may attach pictures. */
export function submissionImages(submission: ImageSubmission | undefined, voice: boolean): DraftChatImage[] {
  return voice ? [] : submission?.images ?? [];
}
/** Never turn a stored-image read into a remote renderer image request. */
export function isLocalImagePreview(value: unknown): value is string {
  return typeof value === 'string' && value.length <= Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 + 32
    && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
