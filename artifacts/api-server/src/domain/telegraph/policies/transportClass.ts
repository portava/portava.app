/**
 * Telegraph §30A.12 — conversation scale classes.
 *
 * Spec §30A.12, verbatim:
 *   "Explicitly distinguish PRIVATE_CONVERSATION, SMALL_GROUP, LARGE_GROUP, and
 *    BROADCAST transport classes.
 *    Large Event conversations must not use small-group fanout, presence, or
 *    per-recipient Seen UI without bounded strategies."
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * census-telegraph T415: "`message_threads.thread_type` is `direct|trip|circle`
 * — a CONTEXT discriminator, not a scale class — and the fanout path is
 * byte-identical for all three." §30A.12's bounded fan-out (T416) put two size
 * bounds on `publishToThread`, but as two bare comparisons on one path: nothing
 * named the class a conversation was in, and the other two strategies the spec
 * names — presence and per-recipient Seen — had no bound at all on the receipt
 * routes. A 900-member conversation would have been served every member's read
 * position, and every reader's id under every message.
 *
 * ── THE CLASS IS DERIVED, NOT STORED ────────────────────────────────────────
 * A stored class would go stale the moment a roster grew. The class is a pure
 * function of the conversation's context (a 1:1 kind is PRIVATE however it is
 * counted) and its ACTIVE roster size, and every strategy decision reads the
 * class through `strategyFor` — so the fan-out path, the receipt routes and the
 * capabilities projection cannot disagree about what a conversation is.
 *
 * ── BROADCAST IS DECLARED, AND NEVER ASSIGNED ───────────────────────────────
 * No broadcast primitive exists, by policy (`canBroadcast` is permanently false,
 * census T204, INTENDED_BY_DECISION). The class is in the vocabulary so the
 * strategy table is complete, and `transportClassFor` never returns it: a
 * conversation does not become a broadcast by growing.
 */

export const TRANSPORT_CLASSES = ["PRIVATE_CONVERSATION", "SMALL_GROUP", "LARGE_GROUP", "BROADCAST"] as const;
export type TransportClass = (typeof TRANSPORT_CLASSES)[number];

/** Thread types that are 1:1 by construction. */
export const PRIVATE_THREAD_TYPES: readonly string[] = ["direct", "rent_buddy_booking"];

/**
 * The largest SMALL_GROUP. Above it a group is LARGE. Fifty sits above every
 * conversation this repository can create today (a trip crew, a circle) and
 * below any plausible event conversation, so the bound is real, not decorative.
 */
export const SMALL_GROUP_MAX = 50;

/** Above this many members, even a MESSAGE degrades to a single poll signal. */
export const LARGE_GROUP_POLL_SIGNAL_ABOVE = 500;

/** At most this many reader ids are named per message in a LARGE_GROUP; the count stays exact. */
export const LARGE_GROUP_SEEN_SAMPLE = 20;

/** Why BROADCAST is never assigned. */
export const BROADCAST_UNASSIGNED_REASON =
  "No broadcast primitive exists: canBroadcast is false by policy (census T204), so no " +
  "conversation is ever classed BROADCAST — growing is not broadcasting.";

export interface TransportStrategy {
  /** Presence-class events (typing, read/seen/delivered signals). */
  readonly presence: "fan_out" | "shed";
  /** Message-class events. `poll_signal` = one `thread.updated` per member, no payload. */
  readonly messages: "fan_out" | "poll_signal";
  /** Per-recipient Seen: every reader named, or an exact count with a bounded sample. */
  readonly seen: "per_recipient" | "count_with_sample";
}

export function transportClassFor(input: { threadType: string | null | undefined; activeMembers: number }): TransportClass {
  if (input.threadType && PRIVATE_THREAD_TYPES.includes(input.threadType)) return "PRIVATE_CONVERSATION";
  return input.activeMembers > SMALL_GROUP_MAX ? "LARGE_GROUP" : "SMALL_GROUP";
}

/**
 * The strategy for a class. `activeMembers` refines LARGE_GROUP's message
 * strategy: a large group still receives its messages in full until the hard
 * bound, above which they degrade to a poll signal rather than to silence.
 */
export function strategyFor(cls: TransportClass, activeMembers: number): TransportStrategy {
  switch (cls) {
    case "PRIVATE_CONVERSATION":
    case "SMALL_GROUP":
      return { presence: "fan_out", messages: "fan_out", seen: "per_recipient" };
    case "LARGE_GROUP":
      return {
        presence: "shed",
        messages: activeMembers > LARGE_GROUP_POLL_SIGNAL_ABOVE ? "poll_signal" : "fan_out",
        seen: "count_with_sample",
      };
    case "BROADCAST":
      // Unreachable through transportClassFor; stated so the table is total.
      return { presence: "shed", messages: "poll_signal", seen: "count_with_sample" };
  }
}

/** Convenience for the paths that know the roster but not the thread type. */
export function strategyForAudience(activeMembers: number, threadType: string | null = null): TransportStrategy {
  return strategyFor(transportClassFor({ threadType, activeMembers }), activeMembers);
}

/** Apply a `seen` strategy to one message's reader ids. The count is never sampled. */
export function boundSeenReaders(
  readerIds: readonly string[],
  strategy: TransportStrategy,
): { seenBy: number; seenByUserIds: string[]; seenByUserIdsSampled: boolean } {
  if (strategy.seen === "per_recipient" || readerIds.length <= LARGE_GROUP_SEEN_SAMPLE) {
    return { seenBy: readerIds.length, seenByUserIds: [...readerIds], seenByUserIdsSampled: false };
  }
  return {
    seenBy: readerIds.length,
    seenByUserIds: readerIds.slice(0, LARGE_GROUP_SEEN_SAMPLE),
    seenByUserIdsSampled: true,
  };
}
