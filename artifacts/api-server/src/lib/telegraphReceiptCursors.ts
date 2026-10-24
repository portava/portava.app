/**
 * Telegraph §7.3 / §12 — the per-member receipt cursors, WRITTEN (census-telegraph T72, T73, T69, T234).
 *
 *   §12 `conversation_members.lastDeliveredSequence / lastSeenSequence`
 *   §7.3 "Direct: Sent/Delivered/Seen."
 *
 * Migration 2810 added `message_thread_members.delivered_sequence` and `seen_sequence` and nothing wrote
 * them, so DELIVERED was an in-session observation the server forgot the moment it was made. This
 * module writes both, and only ever FORWARD:
 *
 *   delivered_sequence — set when the realtime bus observes that a member's open connection ACCEPTED a
 *     `message.created` that carries the message's per-conversation sequence. That is exactly the fact
 *     the bus already reports as `message.delivered` (lib/telegraphEvents.ts emitDeliveryReceipt): an
 *     open connection took it. Not that it reached device storage (no client acknowledgement exists),
 *     and not that anybody read it.
 *   seen_sequence — set when the member's read marker advances to a message that carries a sequence.
 *
 * ONE ROW PER MEMBER PER THREAD, as §7.3 asks and T74 requires: there is no row per message per user
 * anywhere here. Both writes are a single conditional UPDATE — `… where cursor is null or cursor < S` —
 * so concurrent writers can only move a cursor forward, never back. A message with no sequence (sent
 * before the kernel, or with the kernel off) writes nothing. A failed write is logged and changes
 * nothing; the receipt then reads as it did before (the cursor stays where it was).
 */
import { logger } from "./logger.js";

export type CursorWrite = "written" | "skipped" | "failed";

function validSequence(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function advance(
  sc: any,
  column: "delivered_sequence" | "seen_sequence",
  threadId: string,
  userIds: readonly string[],
  sequenceRaw: unknown,
): Promise<CursorWrite> {
  const sequence = validSequence(sequenceRaw);
  const ids = [...new Set(userIds.filter((u) => typeof u === "string" && u.length > 0))];
  if (!sc || !threadId || sequence === null || ids.length === 0) return "skipped";
  try {
    const { error } = column === "delivered_sequence"
      ? await sc.from("message_thread_members").update({ delivered_sequence: sequence }).eq("thread_id", threadId).in("user_id", ids).is("left_at", null).or(`delivered_sequence.is.null,delivered_sequence.lt.${sequence}`)
      : await sc.from("message_thread_members").update({ seen_sequence: sequence }).eq("thread_id", threadId).in("user_id", ids).is("left_at", null).or(`seen_sequence.is.null,seen_sequence.lt.${sequence}`);
    // Two STATIC statements, not one with a computed column, so the production column scan
    // (schemaColumnProductionScan.test.ts) reads every name this writes: 2810's delivered_sequence and
    // seen_sequence, each a forward-only conditional UPDATE of one row per active member (census T72).
    // Same line count as the single statement it replaced, so lines 63 and 68 keep their numbers.
    if (error) {
      logger.warn({ threadId, column, err: (error as { message?: string }).message }, "telegraph receipt cursor: write failed — the cursor stays where it was");
      return "failed";
    }
    return "written";
  } catch (err) {
    logger.warn({ threadId, column, err: String((err as Error)?.message ?? err) }, "telegraph receipt cursor: write threw — the cursor stays where it was");
    return "failed";
  }
}

/** §12 lastDeliveredSequence: these members' open connections took the message at `sequence`. */
export function advanceDeliveredSequence(sc: any, threadId: string, userIds: readonly string[], sequence: unknown): Promise<CursorWrite> {
  return advance(sc, "delivered_sequence", threadId, userIds, sequence);
}

/** §12 lastSeenSequence: this member's read marker reached the message at `sequence`. */
export function advanceSeenSequence(sc: any, threadId: string, userId: string, sequence: unknown): Promise<CursorWrite> {
  return advance(sc, "seen_sequence", threadId, [userId], sequence);
}

/** The cursor columns, named only where 2810 is in force (a database without it answers 42703). */
export function receiptCursorColumns(kernelOn: boolean): string {
  return kernelOn ? ", delivered_sequence, seen_sequence" : "";
}
