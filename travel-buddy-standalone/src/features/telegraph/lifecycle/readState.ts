/**
 * Telegraph §7.1–§7.3 and §30A.15 on the client — what this device may
 * truthfully say about one of the caller's OWN messages, and which message the
 * caller has actually SEEN.
 *
 * §30A.15 asks the client to "distinguish local unsent, server accepted,
 * recipient offline, receipt unavailable". Each state below is backed by
 * something that was measured, and the two this module adds are the two the
 * screens could not say before:
 *
 *   - `receipt_unavailable` — the receipts read FAILED. The screens used to
 *     render that as "Sent", which is a claim that nobody has read the message:
 *     a negative nobody measured. A receipt already read as SEEN stays SEEN
 *     through a later failure, because the read marker only ever moves forward
 *     (`POST /threads/:id/seen` refuses to move it back), so a SEEN fact cannot
 *     go stale; a SENT one can, and is not repeated.
 *   - `delivered` / `recipient_offline` — the server's own live delivery
 *     receipt (`message.delivered`, sent to the sender only by the realtime
 *     bus). It says whether a recipient's open connection took the message,
 *     never that anyone read it, and it is not stored anywhere: it is shown
 *     only for messages whose receipt this device saw arrive. "Offline" is said
 *     only when the server could name a single recipient, no connection took
 *     the message, and no other server instance could have held one — and it is
 *     said in the past tense, because the recipient may come online a second
 *     later and the receipt will not be re-sent.
 *
 * This module is pure. The hook that feeds it is `useThreadReadState`.
 */

import type { MessageReceipt } from './lifecycleApi.ts';

/** Every state one of the caller's own messages can be in, as far as this device knows. */
export type OwnMessageStatus =
  /** Local, not yet accepted by the server. */
  | { kind: 'sending' }
  /** Local, and the server did not accept it. */
  | { kind: 'failed' }
  /** Accepted by the server; nothing more is known. */
  | { kind: 'sent' }
  /** A recipient's open connection took it (observed live on this device). */
  | { kind: 'delivered' }
  /** Accepted; when it was sent, the one recipient had no open connection. */
  | { kind: 'recipient_offline' }
  /** At least one recipient's read marker has passed it. */
  | { kind: 'seen'; seenBy: number; recipientCount: number }
  /** Accepted, and whether it has been read could not be established. */
  | { kind: 'receipt_unavailable' };

export type ReceiptsState = 'idle' | 'loading' | 'ready' | 'unavailable';

/** The parts of a `message.delivered` payload a sender's screen may use. */
export interface DeliveryObservation {
  deliveredCount: number;
  audienceCount: number;
  crossInstance: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether an id is a SERVER message id. Optimistic messages carry the
 * client-generated `clientId` as their id until the server answers; those were
 * never accepted, so nobody can have seen them and they cannot be a seen
 * threshold.
 */
export function isServerMessageId(id: string | null | undefined): boolean {
  return typeof id === 'string' && UUID.test(id);
}

export function ownMessageStatus(input: {
  deliveryStatus?: 'sending' | 'sent' | 'failed' | null;
  receipt?: MessageReceipt | null;
  receiptsState: ReceiptsState;
  delivery?: DeliveryObservation | null;
}): OwnMessageStatus {
  if (input.deliveryStatus === 'sending') return { kind: 'sending' };
  if (input.deliveryStatus === 'failed') return { kind: 'failed' };
  const r = input.receipt;
  if (r && r.status === 'SEEN' && r.seenBy > 0) {
    return { kind: 'seen', seenBy: r.seenBy, recipientCount: r.recipientCount };
  }
  if (input.receiptsState === 'unavailable') return { kind: 'receipt_unavailable' };
  const d = input.delivery;
  if (d && d.deliveredCount > 0) return { kind: 'delivered' };
  if (d && d.deliveredCount === 0 && !d.crossInstance && d.audienceCount === 1) {
    return { kind: 'recipient_offline' };
  }
  return { kind: 'sent' };
}

/**
 * The words for a status. "Seen by N" only in a group with more than one
 * recipient — §7.3's two shapes. Nothing here says "Delivered" unless a
 * delivery was observed.
 */
export function ownMessageStatusLabel(status: OwnMessageStatus, opts: { isGroup: boolean }): string {
  switch (status.kind) {
    case 'sending': return 'Sending…';
    case 'failed': return 'Not sent · tap to retry';
    case 'sent': return 'Sent';
    case 'delivered': return 'Delivered';
    case 'recipient_offline': return 'Sent · they were offline';
    case 'seen':
      return opts.isGroup && status.recipientCount > 1 ? `Seen by ${status.seenBy}` : 'Seen';
    case 'receipt_unavailable': return 'Sent · read status unavailable';
  }
}

/** The minimum a message needs for the seen threshold to be chosen from it. */
export interface SeenCandidate {
  id: string;
  createdAt: string;
  deleted?: boolean;
  deliveryStatus?: 'sending' | 'sent' | 'failed' | null;
}

/**
 * §7.2's threshold: the newest message ON SCREEN that the server holds and can
 * check — not deleted (the server refuses a tombstone), not optimistic (never
 * accepted). Returns null when there is none, so nothing is marked from an
 * empty or failed load.
 */
export function seenThreshold(messages: readonly SeenCandidate[]): string | null {
  let best: SeenCandidate | null = null;
  let bestAt = -Infinity;
  for (const m of messages) {
    if (m.deleted) continue;
    if (m.deliveryStatus === 'sending' || m.deliveryStatus === 'failed') continue;
    if (!isServerMessageId(m.id)) continue;
    const at = Date.parse(m.createdAt);
    if (Number.isNaN(at)) continue;
    if (at >= bestAt) { best = m; bestAt = at; }
  }
  return best ? best.id : null;
}

/** Read a `message.delivered` payload, or null when it is not one this screen can attribute. */
export function deliveryFromPayload(payload: Record<string, unknown> | undefined | null):
  { messageId: string; observation: DeliveryObservation } | null {
  if (!payload) return null;
  const messageId = payload.messageId;
  const delivered = payload.deliveredCount;
  const audience = payload.audienceCount;
  if (typeof messageId !== 'string' || typeof delivered !== 'number' || typeof audience !== 'number') return null;
  return {
    messageId,
    // `crossInstance` licenses "they were offline" only when the server SAID false:
    // a payload that omits or garbles it is read as "another instance may hold
    // the socket", so the absence is never turned into a claim.
    observation: { deliveredCount: delivered, audienceCount: audience, crossInstance: payload.crossInstance !== false },
  };
}

/**
 * Apply a server-published read to receipts already held, so "Seen" appears
 * the moment the server says a read happened rather than on the next refetch.
 * Only ever UPGRADES (SENT → SEEN, or one more reader): a read event cannot
 * un-see anything. `crossed(receipt)` says whether this reader's new marker has
 * passed that message.
 */
export function applyReadToReceipts(
  receipts: ReadonlyMap<string, MessageReceipt>,
  readerId: string,
  crossed: (r: MessageReceipt) => boolean,
): Map<string, MessageReceipt> {
  const out = new Map(receipts);
  for (const [id, r] of receipts) {
    if (r.seenByUserIds.includes(readerId)) continue;
    if (!crossed(r)) continue;
    out.set(id, {
      ...r,
      status: 'SEEN',
      seenBy: r.seenBy + 1,
      seenByUserIds: [...r.seenByUserIds, readerId],
    });
  }
  return out;
}
