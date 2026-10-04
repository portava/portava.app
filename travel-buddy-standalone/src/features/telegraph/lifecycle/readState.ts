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
  /** Local, and the server did not accept it. `failure` says why, when the server did. */
  | { kind: 'failed'; failure?: SendFailure | null }
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
  deliveryStatus?: 'sending' | 'sent' | 'failed' | null; sendFailure?: SendFailure | null;
  receipt?: MessageReceipt | null;
  receiptsState: ReceiptsState;
  delivery?: DeliveryObservation | null;
}): OwnMessageStatus {
  if (input.deliveryStatus === 'sending') return { kind: 'sending' };
  if (input.deliveryStatus === 'failed') return input.sendFailure ? { kind: 'failed', failure: input.sendFailure } : { kind: 'failed' };
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
    case 'failed': return `Not sent · ${failedSendCopy(status.failure).toLowerCase()}`;
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

/* ───────────────────── why a send was not accepted ─────────────────────
 *
 * A failed send used to be one state with one instruction: "Tap to retry".
 * That is the right instruction for a dropped connection and the WRONG one for
 * the server's burst limit (Telegraph §22), where retrying at once is refused
 * again and each refusal reads as the app being broken. Since the limit now
 * applies at every send door, it is a refusal a real person can meet, and the
 * row under their message has to tell them what happened and when to come back.
 *
 * Only `rate_limited` is modelled. Every other failure keeps the words it had:
 * this module does not claim to know why a send failed unless the server said.
 */

/** Why the server did not accept one of the caller's own messages, when it said. */
export interface SendFailure {
  kind: 'rate_limited';
  /** Seconds the server asked for (`Retry-After`), or null when it gave none. */
  retryAfterSeconds: number | null;
}

/**
 * `Retry-After` as whole seconds, or null when the server sent none or sent
 * something this cannot read. Only the delta-seconds form is produced by this
 * API; an HTTP-date is treated as "not stated" rather than guessed at, because
 * a wrong wait shown to a person is worse than "in a moment".
 */
export function parseRetryAfterSeconds(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The failure a send result carries, or null when it carries no stated reason. */
export function sendFailureFrom(res: { ok: boolean; errorKind?: string; retryAfterSeconds?: number | null }): SendFailure | null {
  if (res.ok || res.errorKind !== 'rate_limited') return null;
  const s = res.retryAfterSeconds;
  return { kind: 'rate_limited', retryAfterSeconds: typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : null };
}

/**
 * The words on the row under a message the server did not accept.
 *
 * The wait is rounded UP and coarsened — "about 4 min", never "237 s" — because
 * the number is the server's window, not a countdown this screen keeps, and a
 * precise figure that then turns out a few seconds wrong is a small lie.
 */
export function failedSendCopy(failure: SendFailure | null | undefined): string {
  if (!failure || failure.kind !== 'rate_limited') return 'Tap to retry';
  const s = failure.retryAfterSeconds;
  if (s === null) return 'Sending too fast · try again in a moment';
  if (s < 60) return 'Sending too fast · try again in under a minute';
  return `Sending too fast · try again in about ${Math.ceil(s / 60)} min`;
}
