import type { Message } from '../../../services/messaging.ts';
import type { OutboxEntry } from './types.ts';
export function pendingMessage(entry: OutboxEntry): Message {
  return {
    id: entry.clientId, clientId: entry.clientId, threadId: entry.threadId,
    senderId: entry.ownerId, senderHandle: null, senderName: null, senderAvatarUrl: null,
    body: entry.display.body, displayBody: entry.display.body, originalBody: entry.display.body,
    originalLanguage: null, deleted: false, createdAt: entry.createdAt, editedAt: null,
    translated: false, translationStatus: null, translationLabel: null, canShowOriginal: false,
    msgType: entry.display.msgType, subtype: entry.display.subtype, replyToId: entry.display.replyToId,
    deliveryStatus: 'failed', pendingIsE2ee: entry.display.isE2ee, pendingRetryAt: entry.nextAttemptAt,
  };
}
/** A confirmed id/clientId wins over its optimistic placeholder. Loading another
 * page never silently discards a failed or in-flight send. */
export function mergePendingMessages(confirmed: Message[], previous: Message[]): Message[] {
  const ids = new Set(confirmed.map((message) => message.id));
  const clients = new Set(confirmed.flatMap((message) => message.clientId ? [message.clientId] : []));
  const pending = previous.filter((message) => (message.deliveryStatus === 'sending' || message.deliveryStatus === 'failed') && !ids.has(message.id) && (!message.clientId || !clients.has(message.clientId)));
  return [...confirmed, ...pending];
}
