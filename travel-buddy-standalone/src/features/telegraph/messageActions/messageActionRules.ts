/**
 * Telegraph WP-08 — when the message-action sheet OFFERS Edit and Edit history.
 *
 * These are affordance rules, not authorization: the server re-checks sender,
 * active membership, deletion and end-to-end encryption on every edit and
 * every history read. What they prevent is offering something the server is
 * certain to refuse, which a person meets as an error instead of learning it
 * from the menu.
 */
import type { Message } from '../../../services/messaging.ts';

type EditableShape = Pick<Message, 'body' | 'deleted' | 'msgType' | 'subtype'> &
  Partial<Pick<Message, 'mediaUrl' | 'ciphertext' | 'clientId' | 'deliveryStatus'>>;

/**
 * Edit is offered on your own, delivered, plain-text message in a thread that
 * is not end-to-end encrypted. Not on a structured kind (a plan, a place, a
 * voice note — its `body` is an envelope, not prose), not on media, not on a
 * message still sending (it has no server id yet), and never on E2EE: the
 * server refuses there, because an edit would put plaintext on the server.
 */
export function canEditMessage(msg: EditableShape | null | undefined, mine: boolean, threadIsE2ee: boolean): boolean {
  if (!msg || !mine || threadIsE2ee) return false;
  if (msg.deleted) return false;
  if (msg.msgType !== 'text' || msg.subtype) return false;
  if (msg.mediaUrl) return false;
  if (msg.ciphertext) return false;
  if (msg.deliveryStatus === 'sending' || msg.deliveryStatus === 'failed') return false;
  const body = (msg.body ?? '').trim();
  if (!body) return false;
  if (body.startsWith('{') && body.includes('"kind"')) return false;
  return true;
}

/** Edit history is offered for any visible message the server marked edited. */
export function canViewEditHistory(msg: Pick<Message, 'editedAt' | 'deleted'> | null | undefined): boolean {
  return !!msg && !msg.deleted && !!msg.editedAt;
}

/** The copy for a refused edit, keyed on the server's own error code. */
export function editErrorCopy(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case 'e2ee_thread': return 'Messages in an end-to-end encrypted conversation cannot be edited.';
    case 'forbidden': return 'You can no longer edit this message.';
    case 'not_found': return 'This message is no longer available.';
    case 'degraded_unavailable': return 'We could not verify this conversation right now. Your message is unchanged — please try again.';
    case 'network_unreachable': return 'You appear to be offline. Your message is unchanged.';
    default: return message ?? 'Your edit was not saved. The message is unchanged.';
  }
}

/**
 * What to say when a BLOCK did not go through (TELEGRAPH lane, 2026-10-03).
 *
 * Three Telegraph surfaces called `blockUser` and ignored its result: the
 * thread screen's Block (and its long-press "Block this person") navigated back
 * to the inbox as though the block had happened, and the inbox's request card
 * declined the request — so it disappeared — whatever the block returned. A
 * block that failed looked exactly like one that worked, and the person who
 * believed they were safe could still be messaged. The copy says the one thing
 * that matters: nothing changed.
 */
export function blockFailedCopy(error: string | undefined): string {
  const base = 'Nothing was changed — they can still message you. Please try again.';
  return error && error.trim().length > 0 ? `${error}. ${base}` : base;
}
