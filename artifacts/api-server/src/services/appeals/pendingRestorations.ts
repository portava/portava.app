/**
 * The pending-restoration queue — the OPERATOR-VISIBLE half of a deferred
 * appeal reversal.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * When an appeal is upheld but the restoration cannot be performed — the
 * `trip_members` / `event_rsvps` row was DELETED, and putting it back is an
 * INSERT whose role and capacity meaning is an OPEN owner decision — the appeal
 * still reaches `approved` and `resolveAppeal` answers `restore_requires_policy`
 * with `restored: false`. Routes/appeals.ts logs that loudly.
 *
 * A log line is not an operator surface. Nobody can be asked "what restorations
 * are we still holding?" and answer it by grepping a log shipper, and nothing
 * about a log line survives into a shift handover. The debt was real, recorded
 * nowhere queryable, and therefore invisible — which is how a queue of owed
 * restorations quietly becomes a queue of people who were told their appeal
 * succeeded and never got their trip back.
 *
 * WHY IT DERIVES INSTEAD OF LOGGING A ROW
 * =======================================
 * The obvious design is a `restorations_pending` ledger written at deferral
 * time. It was rejected for three reasons:
 *
 *   1. It needs a migration, and a ledger whose table does not exist yet is a
 *      write that fails at exactly the moment it matters.
 *   2. A ledger is a CLAIM about the world, and claims go stale: if the member
 *      is restored by any other path the ledger still says "pending", and if
 *      the deferral-time insert fails the ledger says "nothing pending" about
 *      a restoration that is owed. Both are the original defect again — a
 *      record that disagrees with the database it describes.
 *   3. The truth is already in the database and is cheap to ask for: an appeal
 *      in the terminal state `approved` whose membership row is STILL absent
 *      is, by definition, a restoration that was promised and not performed.
 *
 * So this reads ground truth, and it reaches the same verdict through the SAME
 * pure classifiers `resolveAppeal` uses (`classifyTripMembershipRestoration`,
 * `classifyEventMembershipRestoration`) — one judgement, two callers, no drift.
 * An entry leaves this queue only when the row it is about actually exists.
 *
 * FAIL-CLOSED
 * ===========
 * Every read error returns `{ ok: false }` for the WHOLE page. It never drops
 * the appeals it could not check and reports a shorter list: "the queue is
 * empty" and "the queue could not be read" must never look the same to an
 * operator, because the first is the answer that lets everyone go home.
 *
 * READ-ONLY: this module issues no INSERT, UPDATE, UPSERT or DELETE. In
 * particular it never touches `trip_members`, so listing the queue can never
 * perform, or half-perform, the restoration it is describing.
 */

import {
  MEMBERSHIP_RESTORE_TARGET_TYPES,
  classifyTripMembershipRestoration,
  classifyEventMembershipRestoration,
  type RestorationOwed,
} from "./resolveAppeal.js";

/** One restoration that was promised by an approved appeal and never performed. */
export interface PendingRestoration {
  appealId: string;
  appellantId: string;
  /** 'trip_membership' | 'event_membership'. */
  targetType: string;
  /** trip id or event id, per targetType. */
  targetId: string;
  /** The admin who approved the appeal, when the appeal recorded one. */
  moderatorId: string | null;
  resolutionNote: string | null;
  /** When the appeal was resolved — i.e. how long this has been owed. */
  approvedAt: string | null;
  /** Why it could not be done. Verbatim from the shared classifier. */
  reason: string;
  /** The command that would carry it, where one has been named. */
  requiredCommand: "ADMIN_RESTORE_PARTICIPANT" | null;
  /** The owner decision that must land first, where the block IS a decision. */
  blockedOn: string | null;
}

export interface PendingRestorationsPage {
  ok: true;
  pending: PendingRestoration[];
  /**
   * How many approved membership appeals this page examined. `pending.length`
   * smaller than `scanned` means the rest were genuinely restored or never
   * needed restoring — not that they were skipped.
   */
  scanned: number;
}

export interface PendingRestorationsFailure {
  ok: false;
  reason: string;
}

export type PendingRestorationsResult = PendingRestorationsPage | PendingRestorationsFailure;

export interface ListOptions {
  limit?: number;
  offset?: number;
}

const APPEAL_COLUMNS =
  "id, appellant_id, target_type, target_id, moderator_id, resolution_note, created_at, updated_at";

/**
 * Key for an exact (target, user) pair. NUL is the separator because it cannot
 * occur in either id, so no two distinct pairs can collide into one key — and
 * it is written as the ESCAPE `\u0000`, never as a raw byte, so this file stays
 * decodable UTF-8. `scripts/check-guard-coverage.mjs` refuses to classify a
 * source file it cannot decode (an unclassifiable file fails rather than
 * passing as exempt), and one raw NUL here fails that guard for the whole tree.
 */
function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

/**
 * List the restorations an approved appeal owes and the database does not show.
 *
 * Three reads, never one per appeal: the approved membership appeals, then one
 * membership lookup per table using `.in()` over the ids in the page. The
 * `.in()` pair is a superset (every trip in the page × every user in the page),
 * so matches are re-checked as exact (trip_id, user_id) pairs in memory before
 * a row is allowed to remove an appeal from the queue. Loosening that to "some
 * row for this trip exists" would silently clear other people's entries.
 */
export async function listPendingRestorations(
  sc: any,
  opts: ListOptions = {},
): Promise<PendingRestorationsResult> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);

  const { data: appealRows, error: appealsErr } = await sc
    .from("appeals")
    .select(APPEAL_COLUMNS)
    .eq("state", "approved")
    .in("target_type", [...MEMBERSHIP_RESTORE_TARGET_TYPES])
    .order("updated_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (appealsErr) {
    return { ok: false, reason: `approved appeal read failed: ${appealsErr.message ?? appealsErr}` };
  }

  const appeals: any[] = (appealRows as any[]) ?? [];
  if (appeals.length === 0) return { ok: true, pending: [], scanned: 0 };

  const tripAppeals  = appeals.filter((a) => a.target_type === "trip_membership");
  const eventAppeals = appeals.filter((a) => a.target_type === "event_membership");

  // ── trip_members presence ────────────────────────────────────────────────
  const tripMembers = new Map<string, { role: string | null }>();
  if (tripAppeals.length > 0) {
    const tripIds = [...new Set(tripAppeals.map((a) => a.target_id))];
    const userIds = [...new Set(tripAppeals.map((a) => a.appellant_id))];
    const { data, error } = await sc
      .from("trip_members")
      .select("trip_id, user_id, role")
      .in("trip_id", tripIds)
      .in("user_id", userIds);
    if (error) {
      // Not "no pending trip restorations" — unknown. Fail the whole page.
      return { ok: false, reason: `trip_members read failed: ${error.message ?? error}` };
    }
    for (const r of ((data as any[]) ?? [])) {
      tripMembers.set(pairKey(r.trip_id, r.user_id), { role: r.role ?? null });
    }
  }

  // ── event_rsvps presence ─────────────────────────────────────────────────
  const eventRsvps = new Map<string, { status: string | null }>();
  if (eventAppeals.length > 0) {
    const eventIds = [...new Set(eventAppeals.map((a) => a.target_id))];
    const userIds  = [...new Set(eventAppeals.map((a) => a.appellant_id))];
    const { data, error } = await sc
      .from("event_rsvps")
      .select("event_id, user_id, status")
      .in("event_id", eventIds)
      .in("user_id", userIds);
    if (error) {
      return { ok: false, reason: `event_rsvps read failed: ${error.message ?? error}` };
    }
    for (const r of ((data as any[]) ?? [])) {
      eventRsvps.set(pairKey(r.event_id, r.user_id), { status: r.status ?? null });
    }
  }

  const pending: PendingRestoration[] = [];
  for (const a of appeals) {
    const key = pairKey(a.target_id, a.appellant_id);
    const classified =
      a.target_type === "trip_membership"
        ? classifyTripMembershipRestoration(tripMembers.get(key) ?? null)
        : classifyEventMembershipRestoration(eventRsvps.get(key) ?? null);

    if (!classified.owed) continue;
    const owed = classified as RestorationOwed;
    pending.push({
      appealId:        a.id,
      appellantId:     a.appellant_id,
      targetType:      a.target_type,
      targetId:        a.target_id,
      moderatorId:     a.moderator_id ?? null,
      resolutionNote:  a.resolution_note ?? null,
      approvedAt:      a.updated_at ?? a.created_at ?? null,
      reason:          owed.reason,
      requiredCommand: owed.requiredCommand,
      blockedOn:       owed.blockedOn,
    });
  }

  return { ok: true, pending, scanned: appeals.length };
}
