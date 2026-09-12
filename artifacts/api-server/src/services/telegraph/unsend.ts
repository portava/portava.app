/**
 * Telegraph §7 — receipts, and unsend-before-seen.
 *
 *   §7.3 "For direct chats, show Sent/Delivered/Seen. For groups, derive
 *         'Seen by N' and optionally list viewers when policy allows. Do not
 *         create permanent row-per-message-per-user receipt explosions."
 *   §7.4 "A sender may unsend only while no eligible recipient has seen the
 *         message. In a group, one recipient seeing the message closes the
 *         unseen-unsend window for everyone. The server resolves read-vs-unsend
 *         races transactionally."
 *
 * ── WHAT §7.4's ALGORITHM MAPS ONTO, AND WHAT IT DOES NOT ───────────────────
 * §7.4 is written against a schema this tree does not have:
 *
 *     assert maxRecipientSeenSequence < message.sequence
 *     set lifecycle = UNSENT
 *
 * There is no `sequence` column and no `lifecycle` column on `public.messages`
 * (baseline 20260819: id, thread_id, sender_id, body, …, edited_at, deleted_at,
 * msg_type, subtype, …). What EXISTS is `message_thread_members.last_read_at`,
 * a per-member timestamp, and `messages.created_at`. So the assertion becomes:
 *
 *     max(other active members' last_read_at) < message.created_at
 *
 * That is a faithful translation of the RULE — ordering by time instead of by
 * sequence — and it needs no migration, which is why the permission half of
 * §7.4 can be true on every deployment of this tree.
 *
 * The two halves §7.4 asks for that this translation does NOT deliver are
 * stated here rather than left to be discovered:
 *
 *   1. THERE IS NO `UNSENT` LIFECYCLE STATE. An unsent message is a tombstone —
 *      `deleted_at` set, `body` blanked — which is exactly what a delete
 *      produces. Nothing distinguishes them in storage because no column can
 *      hold the distinction. §7.1's six-state lifecycle stays unbuilt.
 *   2. "REMOVE FROM NORMAL RETRIEVAL" IS NOT ACHIEVED. The existing readers
 *      return a deleted row as a redacted slot, so an unsend leaves a visible
 *      gap rather than nothing. Changing that is a change to every reader, not
 *      to this file.
 *
 * ── THE RACE, AND WHY THIS IS STILL NOT "TRANSACTIONAL" ─────────────────────
 * §7.4 says the server resolves read-vs-unsend races transactionally. PostgREST
 * gives no transaction across two tables and no `SELECT … FOR UPDATE`; a lock
 * would need a SECURITY DEFINER function, i.e. a migration no database has.
 *
 * What is implemented instead is COMPENSATION, which is weaker and is described
 * as weaker: the caller re-reads the receipts after the write and, if a read
 * landed during the window, puts the message back — body and all. That closes
 * the outcome (a seen message is not left unsent) but not the window (a
 * recipient fetching inside it saw a tombstone). `planUnsend` and
 * `detectReadRace` below are the two halves; the route does the writing.
 */

/** One row of `message_thread_members`, as the receipt logic needs it. */
export interface ReceiptMember {
  user_id: string;
  last_read_at: string | null;
  left_at?: string | null;
}

/** The message columns §7 reasons about. */
export interface LifecycleMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  created_at: string;
  deleted_at?: string | null;
  edited_at?: string | null;
  body?: string | null;
}

/**
 * §7.3's receipt, derived rather than stored.
 *
 * `delivered` is deliberately `null` on every deployment: §7.1 has a DELIVERED
 * state and this tree has no delivery signal of any kind — no per-device ack,
 * no `lastDeliveredSequence`, nothing. Returning `null` with a reason is the
 * honest shape; returning `false` would assert a negative nobody measured, and
 * returning `true` would invent one.
 */
export interface MessageReceipt {
  messageId: string;
  /** SENT or SEEN. There is no DELIVERED to report. */
  status: "SENT" | "SEEN";
  delivered: null;
  deliveredUnavailableReason: string;
  /** How many eligible recipients have seen it. §7.3's "Seen by N". */
  seenBy: number;
  /** The eligible recipients, for a direct chat or a policy that allows it. */
  seenByUserIds: string[];
  /** Eligible recipients in total — the denominator behind "Seen by N". */
  recipientCount: number;
}

export const DELIVERED_UNAVAILABLE =
  "No delivery signal exists on this deployment: there is no per-device " +
  "acknowledgement and no lastDeliveredSequence column, so DELIVERED cannot be " +
  "reported as true or false.";

/**
 * The recipients a message is "eligible" for: active members of the thread who
 * are not the sender.
 *
 * A member who has LEFT is not an eligible recipient. That matters for §7.4 in
 * a direction that is easy to get backwards — a departed member's stale
 * `last_read_at` must not keep the unsend window closed forever.
 */
export function eligibleRecipients(members: ReceiptMember[], senderId: string): ReceiptMember[] {
  return members.filter(
    (m) => m.user_id !== senderId && (m.left_at === null || m.left_at === undefined),
  );
}

/**
 * §7.4's assertion, translated: has any eligible recipient read past this
 * message?
 *
 * Returns the user ids that have, so a refusal can say how many rather than
 * only that it happened. The comparison is `last_read_at >= created_at`:
 * `last_read_at` marks the moment the reader was caught up to, so a read
 * stamped at exactly the message's own timestamp includes it.
 */
export function seenByRecipients(
  message: LifecycleMessage,
  members: ReceiptMember[],
): string[] {
  const createdMs = Date.parse(message.created_at);
  if (Number.isNaN(createdMs)) return [];
  return eligibleRecipients(members, message.sender_id)
    .filter((m) => {
      if (!m.last_read_at) return false;
      const readMs = Date.parse(m.last_read_at);
      return !Number.isNaN(readMs) && readMs >= createdMs;
    })
    .map((m) => m.user_id);
}

/** §7.3's receipt for one message. */
export function receiptFor(message: LifecycleMessage, members: ReceiptMember[]): MessageReceipt {
  const seen = seenByRecipients(message, members);
  return {
    messageId: message.id,
    status: seen.length > 0 ? "SEEN" : "SENT",
    delivered: null,
    deliveredUnavailableReason: DELIVERED_UNAVAILABLE,
    seenBy: seen.length,
    seenByUserIds: seen,
    recipientCount: eligibleRecipients(members, message.sender_id).length,
  };
}

export type UnsendRefusal =
  | "not_sender"
  | "not_a_member"
  | "already_gone"
  | "seen_by_recipient";

export type UnsendPlan =
  | { eligible: true; seenBy: 0; recipientCount: number }
  | { eligible: false; refusal: UnsendRefusal; seenBy: number; recipientCount: number };

/**
 * §7.4's decision, as one pure function.
 *
 * The order of the checks is the authorization order: a non-sender is refused
 * before anything about seen-ness is computed, so the endpoint cannot be used
 * to probe whether someone else's message has been read.
 *
 * ONE RECIPIENT CLOSES IT FOR EVERYONE (§7.4, second sentence): the refusal is
 * `seenBy > 0`, not "all recipients have seen it". A naive implementation that
 * required every recipient to have seen the message would leave the window open
 * in exactly the case the spec closes it.
 */
export function planUnsend(input: {
  message: LifecycleMessage;
  members: ReceiptMember[];
  actorId: string;
  /** Whether the actor is still an active member of the thread. */
  actorIsActiveMember: boolean;
}): UnsendPlan {
  const { message, members, actorId, actorIsActiveMember } = input;
  const recipientCount = eligibleRecipients(members, message.sender_id).length;

  if (message.sender_id !== actorId) {
    return { eligible: false, refusal: "not_sender", seenBy: 0, recipientCount };
  }
  if (!actorIsActiveMember) {
    return { eligible: false, refusal: "not_a_member", seenBy: 0, recipientCount };
  }
  if (message.deleted_at) {
    return { eligible: false, refusal: "already_gone", seenBy: 0, recipientCount };
  }

  const seen = seenByRecipients(message, members);
  if (seen.length > 0) {
    return { eligible: false, refusal: "seen_by_recipient", seenBy: seen.length, recipientCount };
  }
  return { eligible: true, seenBy: 0, recipientCount };
}

/** Why a refusal happened, in words a sender can act on. */
export function unsendRefusalMessage(refusal: UnsendRefusal, seenBy: number): string {
  switch (refusal) {
    case "not_sender":
      return "Only the sender can unsend a message.";
    case "not_a_member":
      return "You no longer have access to this conversation.";
    case "already_gone":
      return "That message is already gone.";
    case "seen_by_recipient":
      return seenBy === 1
        ? "Someone has already seen this message, so it can no longer be unsent."
        : `${seenBy} people have already seen this message, so it can no longer be unsent.`;
    default:
      return "This message cannot be unsent.";
  }
}

/**
 * Did a read land while we were writing?
 *
 * `before` is the receipt state read before the write, `after` the state read
 * back afterwards. A race is a recipient who had NOT seen the message before
 * and HAS seen it after. Comparing sets rather than counts matters: one
 * recipient leaving and another reading would keep the count equal.
 */
export function detectReadRace(before: string[], after: string[]): string[] {
  const had = new Set(before);
  return after.filter((u) => !had.has(u));
}

/**
 * The columns an unsend writes.
 *
 * `body: ""` and not `null`: `messages.body` is `text NOT NULL`
 * (baseline 20260819), so a null write raises 23502 and the unsend fails
 * outright. Readers substitute `body: null` off `deleted_at`, so the empty
 * string never surfaces.
 */
export function unsentPatch(nowIso: string): Record<string, unknown> {
  return { deleted_at: nowIso, body: "" };
}

/** Putting it back, when a read beat us. The body is restored verbatim. */
export function restorePatch(originalBody: string): Record<string, unknown> {
  return { deleted_at: null, body: originalBody };
}
