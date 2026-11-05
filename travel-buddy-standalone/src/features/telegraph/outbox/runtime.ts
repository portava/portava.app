import type { Message } from '../../../services/messaging.ts';
import { MessageOutbox } from './engine.ts';
import { encryptedOutboxStorage } from './storage.ts';
export const messageOutbox = new MessageOutbox<Message>(encryptedOutboxStorage);
/** Call before completing sign-out or account replacement. Invalidates in-flight
 * queue writes before erasing this account's device-local pending messages. */
export function clearTelegraphOutboxForOwner(ownerId: string): Promise<void> {
  return messageOutbox.clearOwner(ownerId);
}
