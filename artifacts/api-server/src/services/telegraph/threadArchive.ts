/**
 * Owner ruling 2026-10-17 — "Allow users to unarchive conversations."
 *
 * ARCHIVE IS PER MEMBER: `message_thread_members.archived_at` (baseline; in the
 * production capture). The only archiver is Rent-a-Buddy booking completion
 * (routes/rentABuddy.ts, the two `.update({ archived_at })` sites), which
 * archives the booking's thread for every member unless BOTH parties chose
 * "stay connected". A help request is not routed to a member whose archived_at
 * is set (services/telegraph/safetyNotifications.ts, archivedRecipients), and
 * GET /me/threads returns it as `archivedAt`. Members cannot write the table
 * themselves (no client UPDATE policy), so this — through the service client —
 * is the only way back.
 *
 * WHAT AN UNARCHIVE IS: the caller's OWN membership row loses its archived_at.
 * Nothing else is read or written —
 *   - not another member's row: the write names the caller's user_id, so an
 *     unarchive never reopens the conversation for anyone else;
 *   - not a membership the caller LEFT: the read and the write both require
 *     left_at IS NULL, so a member who left is refused exactly like a
 *     non-member and the conversation is not resurrected for them;
 *   - not a block: `blocks` is not consulted, and the answer does not depend on
 *     one — a refusal that did would tell the caller they are blocked (§11.1).
 *     A block keeps refusing what it refused (the send gates read it);
 *   - not a booking: `rent_buddy_bookings` is not read or written, so a
 *     completed booking's post-completion rules (calls only when both chose
 *     stay-connected, isRabBookingCallEligible) are exactly what they were;
 *   - not `message_threads.status`, which is per THREAD.
 *
 * IDEMPOTENT: a membership that is not archived answers `changed: false` and
 * writes nothing. The success answer is the READ-BACK of the row the write
 * returned. An unreadable membership is `unreadable` (a retryable 503 at the
 * route), never "not a member" and never a write.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type UnarchiveOutcome =
  | { kind: "unarchived"; changed: boolean }
  | { kind: "not_member" }
  | { kind: "unreadable"; error: unknown }
  | { kind: "write_failed"; error: unknown };

export async function unarchiveOwnMembership(
  sc: SupabaseClient,
  threadId: string,
  userId: string,
): Promise<UnarchiveOutcome> {
  const { data: own, error: readErr } = await sc
    .from("message_thread_members")
    .select("user_id, archived_at")
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .is("left_at", null)
    .maybeSingle();
  if (readErr) return { kind: "unreadable", error: readErr };
  if (!own) return { kind: "not_member" };
  if ((own as { archived_at?: unknown }).archived_at == null) return { kind: "unarchived", changed: false };

  const { data: written, error: writeErr } = await sc
    .from("message_thread_members")
    .update({ archived_at: null })
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .is("left_at", null)
    .select("user_id, archived_at");
  if (writeErr) return { kind: "write_failed", error: writeErr };
  const rows = Array.isArray(written) ? (written as Array<{ user_id?: unknown; archived_at?: unknown }>) : [];
  // Zero rows: the caller left between the read and the write. Not "unarchived".
  if (rows.length === 0) return { kind: "not_member" };
  if (rows.length !== 1 || rows[0]!.user_id !== userId || rows[0]!.archived_at != null) {
    return { kind: "write_failed", error: { message: "the read-back does not show this member unarchived" } };
  }
  return { kind: "unarchived", changed: true };
}
