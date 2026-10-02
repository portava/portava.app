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
 * ── THE RACE, AND HOW IT IS CLOSED NOW ──────────────────────────────────────
 * §7.4 says the server resolves read-vs-unsend races transactionally, and this
 * file used to say that was impossible here: PostgREST gives no transaction
 * across two tables and no `SELECT … FOR UPDATE`, so a lock would need a
 * SECURITY DEFINER function, "i.e. a migration no database has".
 *
 * That migration exists. 2325 created
 * `telegraph_unsend_message_before_seen`, which takes FOR UPDATE locks on the
 * recipient receipt rows BEFORE reading them, and 3000 made it write the whole
 * row. Nothing called it: two route handlers each did their own read-then-write
 * instead, and each produced a different row. `unsendBeforeSeen` below is now
 * the only path, for both of them.
 *
 * So the COMPENSATION scheme this file used to carry is gone, and with it the
 * two outcomes that only existed because of it — a window in which a recipient
 * could fetch a tombstone that was about to be put back, and the `unverifiable`
 * refusal for when the re-read failed. The lock has no window to be unsure
 * about. `detectReadRace` and `restorePatch` were its two halves and are
 * deleted rather than left where a future handler could reach for them.
 *
 * `planUnsend` stays, and is no longer a decision: it is the same rule stated
 * in TypeScript, over data a caller already has, for the places that need to
 * say WHY before calling — and it is what the §7.3 receipts endpoint's own
 * vocabulary is built from. The authoritative answer is the function's.
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
  /**
   * Set by the unsend function alongside `deleted_at`, never on its own. It is
   * optional here because most §7.3 receipt callers select the delivery columns
   * and not this one; an absent field means "not selected", which `planUnsend`
   * treats the same as "not unsent" only because it also tests `deleted_at`,
   * which those callers do select.
   */
  unsent_at?: string | null;
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
 * §7.4's decision, as one pure function — a SECOND OPINION, not the answer.
 *
 * The authoritative answer is `telegraph_unsend_message_before_seen`'s, because
 * only the function holds the locks. This states the same rule over data a
 * caller already has, for the places that need to say WHY before calling, and
 * it is what §7.3's receipts vocabulary is built from.
 *
 * "The same rule" is a claim, so it is CHECKED: `telegraphUnsendFunctionFake`
 * pins the modelled outcome order against migration 3000's SQL, and a test
 * there drives the same fixtures through both this function and the model and
 * requires them to agree via `refusalForOutcome`. That check is why the order
 * below changed on 2026-09-23: this function used to refuse a departed sender
 * BEFORE noticing the message was already gone, and the function refuses in the
 * other order. An already-unsent message is a no-op whatever the actor's
 * membership, and answering the no-op is both friendlier and what the live
 * route now does; the disagreement was here, not in the SQL.
 *
 * The order of the checks is still the authorization order where it matters: a
 * non-sender is refused first, before anything about seen-ness is computed, so
 * the endpoint cannot be used to probe whether someone else's message has been
 * read.
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
  // Gone before membership, matching the function: `unsent_at` is tested before
  // `deleted_at` there because the write sets BOTH, so an already-unsent row
  // carries both and testing deleted first would call every repeat unsend a
  // delete. Here the two collapse into one refusal, so one test covers them.
  if (message.unsent_at || message.deleted_at) {
    return { eligible: false, refusal: "already_gone", seenBy: 0, recipientCount };
  }
  if (!actorIsActiveMember) {
    return { eligible: false, refusal: "not_a_member", seenBy: 0, recipientCount };
  }

  const seen = seenByRecipients(message, members);
  if (seen.length > 0) {
    return { eligible: false, refusal: "seen_by_recipient", seenBy: seen.length, recipientCount };
  }
  return { eligible: true, seenBy: 0, recipientCount };
}

/**
 * The function's outcome, as this file's refusal vocabulary.
 *
 * ONE copy, because there were two: the lifecycle route mapped outcomes to
 * refusals inline, and nothing tied that mapping to `planUnsend`'s. Both now
 * go through here, which is what makes "the same rule" checkable rather than
 * asserted.
 *
 * `unsent` and `not_found` are absent deliberately. Neither is a refusal: the
 * first is the success, and the second is a 404 the caller answers before it
 * reaches refusal vocabulary at all.
 */
export function refusalForOutcome(
  outcome: Exclude<UnsendOutcome, "unsent" | "not_found">,
): UnsendRefusal {
  switch (outcome) {
    case "not_sender":
      return "not_sender";
    case "not_member":
      return "not_a_member";
    case "already_unsent":
    case "already_deleted":
      return "already_gone";
    case "seen":
      return "seen_by_recipient";
  }
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

/* ══════════════════════════════════════════════════════════════════════════
 * THE AUTHORITATIVE UNSEND
 *
 * One caller-visible function, wrapping one database function. Everything above
 * this line describes the rule; this is the only thing that applies it.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every outcome `telegraph_unsend_message_before_seen` can return.
 *
 * This list is closed on purpose. An outcome the function might grow later and
 * this code does not know is NOT a success and NOT a refusal — see
 * `unsendBeforeSeen`.
 */
export const UNSEND_OUTCOMES = [
  "unsent",
  "not_found",
  "not_sender",
  "not_member",
  "already_deleted",
  "already_unsent",
  "seen",
] as const;

export type UnsendOutcome = (typeof UNSEND_OUTCOMES)[number];

export interface UnsendResult {
  outcome: UnsendOutcome;
  /** Present on `unsent` and `already_unsent`. */
  unsentAt?: string;
  /** Recipients who had seen it. Present on `seen`, and 0 on `unsent`. */
  seenBy: number;
  /** Eligible recipients, counted inside the lock. */
  recipientCount: number;
}

const isUnsendOutcome = (v: unknown): v is UnsendOutcome =>
  typeof v === "string" && (UNSEND_OUTCOMES as readonly string[]).includes(v);

/**
 * §7.4, decided and written in one locked statement pair.
 *
 * Returns `null` for a FAILURE — the call errored, or came back as something
 * this code cannot read. A failure is not a refusal: the caller must answer
 * "we could not do this" rather than "you may not", because the two send a
 * person to different places and only one of them is true.
 *
 * Three ways to get `null`, all of them deliberate:
 *
 *   * `error` is set. `supabase-js` RESOLVES `{ data, error }`, so this has to
 *     be read; a `.rpc()` whose error goes unchecked reads as `data: null`,
 *     which is the shape a missing function also has.
 *   * `data` is not an object, or carries no `outcome`.
 *   * `outcome` is a string this build does not know. A future migration adding
 *     an outcome must not have it silently treated as either answer — the
 *     safe reading of an unknown verdict is that there is no verdict.
 */
export async function unsendBeforeSeen(
  sc: {
    // PromiseLike, not Promise: supabase-js hands back a builder that is
    // awaitable but has no `catch`. Demanding a Promise here would make every
    // real client fail to typecheck and push callers to `any`.
    rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  },
  input: { messageId: string; actorId: string; threadId: string },
): Promise<UnsendResult | null> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await sc.rpc("telegraph_unsend_message_before_seen", {
      p_message_id: input.messageId,
      p_actor_id: input.actorId,
      p_thread_id: input.threadId,
    }));
  } catch {
    // A THROWN failure is the same fact as a returned one. Both mean the
    // verdict is unknown.
    return null;
  }
  if (error) return null;
  if (typeof data !== "object" || data === null) return null;

  const row = data as Record<string, unknown>;
  if (!isUnsendOutcome(row["outcome"])) return null;

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const result: UnsendResult = {
    outcome: row["outcome"],
    seenBy: num(row["seenBy"]),
    recipientCount: num(row["recipientCount"]),
  };
  if (typeof row["unsentAt"] === "string") result.unsentAt = row["unsentAt"];
  return result;
}
