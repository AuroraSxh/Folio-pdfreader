import type { ChatMessage } from './types';

export interface ChatTurn { start: number; end: number; messages: ChatMessage[]; turnIds: string[] }

/** Locate the containing user question and all replies before the next user.
 * Imported orphan assistant messages are independent deletable entries. Indices
 * are derived from the latest snapshot, never trusted from a renderer. */
export function findChatTurn(messages: ChatMessage[], messageId: string): ChatTurn | undefined {
  const selected = messages.findIndex(message => message.id === messageId);
  if (selected < 0) return;
  let start = selected;
  while (start > 0 && messages[start].role !== 'user') start--;
  if (messages[start].role !== 'user') start = selected;
  let end = start + 1;
  if (messages[start].role === 'user') while (end < messages.length && messages[end].role !== 'user') end++;
  const selectedMessages = messages.slice(start, end);
  return { start, end, messages: selectedMessages, turnIds: [...new Set(selectedMessages.flatMap(message => message.turnId ? [message.turnId] : []))] };
}
