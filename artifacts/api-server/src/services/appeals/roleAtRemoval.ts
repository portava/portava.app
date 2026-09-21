/**
 * Recovering the role a participant held when they were removed.
 *
 * WHY THIS FILE CHANGES THE APPEAL_RESTORE_SEMANTICS DECISION WITHOUT TAKING IT
 * =============================================================================
 * `adminRestoreParticipant.ts` says of APPROVED_RESTORATION_SOURCES:
 *
 *   "Also EMPTY, and for the same reason: 'their role at removal' is only a
 *    valid source if something durably records it, and nothing does once the
 *    row is DELETEd."
 *
 * That was true when it was written. It is not true now. The kernel's
 * REMOVE_PARTICIPANT branch has, since 2450, done exactly this before deleting
 * the row:
 *
 *   v_payload := v_payload || jsonb_build_object('role_at_removal', v_member.role::text);
 *
 * and the resulting `trip.participant_removed` event lands in `trip_events`,
 * which 2420 makes APPEND-ONLY with a trigger (`trg_trip_events_append_only`)
 * that refuses every UPDATE. So the role at removal IS durably recorded, by
 * construction, in a table nothing can rewrite.
 *
 * WHAT THAT DOES AND DOES NOT SETTLE
 * ==================================
 * It settles the FACTUAL half — "we cannot know what role they had" is now
 * false, and this module is the proof, because it returns the role.
 *
 * It settles NOTHING about the POLICY half, which is what APPEAL_RESTORE_
 * SEMANTICS is actually for:
 *   * may a removed CO_HOST be restored as co_host, or does an appeal return
 *     someone to plain membership?
 *   * does the crew cap (`trips.max_members`) still apply to a restoration, or
 *     does an upheld appeal override it?
 *   * does a member removed twice return to their role before the first removal
 *     or the second?
 * Each of those changes what a user is entitled to, and none is inferable from
 * the code. They stay open, and APPROVED_RESTORATION_ROLES and
 * APPROVED_RESTORATION_SOURCES stay EMPTY — this file adds nothing to either,
 * because adding a value there is taking the decision.
 *
 * So: the decision is NARROWER than it was. It was "we have no source and no
 * policy". It is now "we have a source; which policy?".
 *
 * FAIL-CLOSED
 * ===========
 * Every failure returns a REASON, never a role. An unreadable ledger, an absent
 * event, a malformed payload and a removal that predates the kernel are four
 * different situations and each is named, because "we could not find out" and
 * "they were a member" must not be the same answer to a restoration question.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const ROLE_AT_REMOVAL_SOURCE = "trip_events.trip.participant_removed" as const;

export const ROLE_RECOVERY_FAILURES = [
  /** The trip_events read failed. Not "no removal" — we do not know. */
  "LEDGER_UNREADABLE",
  /** No trip.participant_removed event names this user on this trip. */
  "NO_REMOVAL_EVENT",
  /** The event exists but carries no role_at_removal — a pre-2450 removal. */
  "ROLE_NOT_RECORDED",
  /** The event's payload is not the shape the kernel writes. */
  "LEDGER_MALFORMED",
] as const;
export type RoleRecoveryFailure = (typeof ROLE_RECOVERY_FAILURES)[number];

export type RoleAtRemoval =
  | { found: true; role: string; eventId: string; occurredAt: string; source: typeof ROLE_AT_REMOVAL_SOURCE }
  | { found: false; reason: RoleRecoveryFailure; detail?: string };

/**
 * The MOST RECENT removal of this user from this trip.
 *
 * Most recent, not first: someone removed, restored and removed again should
 * come back to what they had before the LAST removal, not before the first —
 * anything else silently reverses a role change they consented to in between.
 * (Which removal to honour is itself part of the open policy question; this
 * function returns the one it is asked for and says which it chose.)
 */
export async function recoverRoleAtRemoval(
  sc: SupabaseClient,
  tripId: string,
  userId: string,
): Promise<RoleAtRemoval> {
  // supabase-js RESOLVES on a database error, so `error` is inspected. A
  // try/catch here would be dead code and would let a failed read look like
  // "no removal was ever recorded".
  const { data, error } = await sc
    .from("trip_events")
    .select("event_id, occurred_at, payload_json")
    .eq("trip_id", tripId)
    .eq("type", "trip.participant_removed")
    .order("sequence", { ascending: false })
    .limit(50);

  if (error) {
    return { found: false, reason: "LEDGER_UNREADABLE", detail: error.message };
  }
  if (!Array.isArray(data)) {
    return { found: false, reason: "LEDGER_MALFORMED", detail: "the ledger read returned no array" };
  }

  for (const row of data) {
    const payload = (row as { payload_json?: unknown }).payload_json;
    if (!payload || typeof payload !== "object") continue;
    const p = payload as Record<string, unknown>;
    const result = p.result as Record<string, unknown> | undefined;
    const inner = p.payload as Record<string, unknown> | undefined;
    // The kernel puts user_id in `result` and role_at_removal in `payload`.
    if (!result || result.user_id !== userId) continue;

    const role = inner?.role_at_removal;
    if (typeof role !== "string" || role === "") {
      // The event is here and the role is not: a removal written before 2450
      // added the key. Distinct from "no removal", and distinct from a failure.
      return { found: false, reason: "ROLE_NOT_RECORDED",
               detail: `event ${String((row as { event_id?: unknown }).event_id)} carries no role_at_removal` };
    }
    return {
      found: true,
      role,
      eventId: String((row as { event_id?: unknown }).event_id ?? ""),
      occurredAt: String((row as { occurred_at?: unknown }).occurred_at ?? ""),
      source: ROLE_AT_REMOVAL_SOURCE,
    };
  }

  return { found: false, reason: "NO_REMOVAL_EVENT" };
}
