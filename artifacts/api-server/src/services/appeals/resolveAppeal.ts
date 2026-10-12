/**
 * Appeal reversal handler.
 *
 * Called when an admin approves an appeal (state → approved).
 * Dispatches the correct reversal action by target_type.
 * Unknown target_types return a no-op with a log warning — never throw.
 */

import { randomUUID } from "node:crypto";
import { recordTrustEvent } from "../trust/TrustEventService.js";
import { executeTripCommand, tripKernelClient } from "../../domain/trips/commands/tripKernel.js";

export interface Appeal {
  id: string;
  appellant_id: string;
  target_type: string;
  target_id: string;
  resolution_note: string | null; /** The approving moderator: recorded as the actor of a lift (trust_restrictions.lifted_by). */ moderator_id?: string | null;
}

/** The reversal ran and did what `action` says it did. */
export interface ReversalApplied {
  ok: true;
  action: string;
  /** Absent means "the action name is the whole truth". */
  restored?: true; /** This appeal's restoration had already happened (a replay): nothing new was written. */ replayed?: true;
}

/**
 * The appeal RESOLVES, but the restoration itself did NOT happen and cannot be
 * performed by this code. `action` is deliberately NOT a `*_restored` name, and
 * `restored` is explicitly false so no caller can mistake this for a success by
 * reading `ok` alone.
 */
export interface ReversalDeferred {
  ok: true;
  action: "restore_requires_policy" | "restore_pending_crew_full"; // the second: owner ruling 2026-10-12, a full crew keeps the restore pending
  restored: false;
  reason: string; /** Set when the restore is pending on a cause that can clear (a full crew) and an operator can re-drive it. */ pending?: RestorationPending;
  /** What an operator needs to act on this by hand. */
  evidence: { appealId: string; targetType: string; targetId: string; userId: string };
}

/** The reversal could not be attempted or failed outright. */
export interface ReversalNoop {
  ok: false;
  action: "noop";
  reason: string;
}

export type ReversalResult = ReversalApplied | ReversalDeferred | ReversalNoop;

/** True when the appeal resolves but nothing was restored. */
export function isDeferred(r: ReversalResult): r is ReversalDeferred {
  return r.ok === true && (r as ReversalDeferred).restored === false;
}

/**
 * How many rows a mutation ACTUALLY touched.
 *
 * supabase-js does not report an affected-row count unless the statement is
 * made RETURNING with `.select()`; without it, `data` is null on success and a
 * statement that matched NOTHING is indistinguishable from one that matched
 * everything — both resolve `{ data: null, error: null }`. Every restoration
 * below therefore selects, and every one of them reads this before claiming it
 * restored anything.
 */
function affectedRows(data: unknown): number {
  if (data == null) return 0;
  return Array.isArray(data) ? data.length : 1;
}

/**
 * The reversal statement matched no row: the target does not exist, or it is
 * not the appellant's. Either way NOTHING was reversed, so this is a failure —
 * the route holds the appeal in `under_review` rather than closing it on a
 * restoration that did not happen.
 */
function matchedNothing(
  appeal: Appeal,
  what: string,
): ReversalNoop {
  console.error(
    `[resolveAppeal] ${what} matched no row — nothing reversed. ` +
    `appeal=${appeal.id} target_type=${appeal.target_type} target=${appeal.target_id} user=${appeal.appellant_id}`,
  );
  return {
    ok: false,
    action: "noop",
    reason: `${what} matched no row (target missing, already gone, or not owned by the appellant)`,
  };
}

// ── Restoration classification ───────────────────────────────────────────────
// These are PURE and READ-ONLY, and they are the single place that decides
// whether a membership restoration is still owed. `resolveAppeal` uses them to
// answer one appeal; `pendingRestorations.ts` uses the SAME functions to build
// the operator queue. Two copies of this judgement would drift, and the shape
// of the drift would be a queue that says "nothing pending" about an appeal
// whose restoration never happened — the same class of lie as the original
// defect, one layer up.

/** The owner decision (taken 2026-10-04, OD-TRIP-1) that governs trip-membership restoration. */
export const RESTORE_SEMANTICS_DECISION = "APPEAL_RESTORE_SEMANTICS";

/**
 * The target types whose moderated action is a DELETE rather than a flag, so
 * no UPDATE can ever reverse one. These are the only appeals that can end
 * `approved` with the restoration still owed.
 */
export const MEMBERSHIP_RESTORE_TARGET_TYPES = ["trip_membership", "event_membership"] as const;
export type MembershipRestoreTargetType = (typeof MEMBERSHIP_RESTORE_TARGET_TYPES)[number];

/** The restoration has NOT happened and this code cannot perform it. */
export interface RestorationOwed {
  owed: true;
  reason: string;
  /** The command that would carry it — named only where one has been named. */
  requiredCommand: "ADMIN_RESTORE_PARTICIPANT" | null;
  /** The owner decision that must land first, where the block IS a decision. */
  blockedOn: typeof RESTORE_SEMANTICS_DECISION | null;
}

export type RestorationClassification = { owed: false } | RestorationOwed;

/**
 * Is a trip-membership restoration still owed, given the member row (or its
 * absence)? Never writes, never picks a role.
 *
 *   row absent          the member really was removed. Putting them back is an
 *                       INSERT — ADMIN_RESTORE_PARTICIPANT (3974/3979) — in the
 *                       role at removal (APPEAL_RESTORE_SEMANTICS, decided 2026-10-04).
 *   row restored by THIS appeal (`permissions.restored_by_appeal`): restored, not owed.
 *   row present, other  not removed; rewriting that role would be the role
 *   than 'member'       invention this must not do. Owed, for a person to look at.
 *   row present,
 *   role 'member'       nothing was removed and nothing is owed.
 */
export function classifyTripMembershipRestoration(
  memberRow: { role?: string | null; permissions?: unknown } | null | undefined, appealId?: string,
): RestorationClassification {
  if (memberRow == null) {
    return {
      owed: true,
      requiredCommand: "ADMIN_RESTORE_PARTICIPANT",
      blockedOn: null, // decided 2026-10-04 (adminRestoreParticipant.ts APPEAL_RESTORE_RULING); the kernel command carries it (3974/3979)
      reason:
        "trip_members row absent (member was removed by DELETE); only the Trip Kernel command ADMIN_RESTORE_PARTICIPANT " +
        `restores it (${RESTORE_SEMANTICS_DECISION}, decided 2026-10-04: the role at removal), and it has not restored this member`,
    };
  }
  const role = memberRow.role ?? null; if (appealId && restoredByAppeal(memberRow) === appealId) return { owed: false };
  if (role !== "member") {
    return {
      owed: true,
      requiredCommand: "ADMIN_RESTORE_PARTICIPANT",
      blockedOn: null, // no removal is recorded for a member who is still present, so nothing is restorable under the ruling
      reason:
        `trip_members row present with role '${role}' — nothing was removed, and rewriting ` +
        `that role would be inventing a restoration the ${RESTORE_SEMANTICS_DECISION} ruling (restore exactly what was removed) does not cover`,
    };
  }
  return { owed: false };
}

/**
 * The event twin. Removal DELETEs the RSVP row, so an absent row means the
 * restoration is owed — and re-creating it is an INSERT whose capacity and
 * waitlist meaning is a product decision, not one this code may take.
 * No command has been named for it, hence `requiredCommand: null`.
 */
export function classifyEventMembershipRestoration(
  rsvpRow: { status?: string | null } | null | undefined,
): RestorationClassification {
  if (rsvpRow == null) {
    return {
      owed: true,
      requiredCommand: null,
      blockedOn: null,
      reason:
        "event_rsvps row absent (the RSVP was removed by DELETE); re-creating it is an INSERT " +
        "whose capacity and waitlist semantics are not decided here",
    };
  }
  return { owed: false };
}

/**
 * Build the deferred result and say so where an operator can see it. The
 * `action` is deliberately not a `*_restored` name and `restored` is an
 * explicit `false`, so no caller can read success out of `ok` alone.
 */
function deferRestoration(appeal: Appeal, reason: string): ReversalDeferred {
  console.error(
    `[resolveAppeal] restore_requires_policy appeal=${appeal.id} ` +
    `target_type=${appeal.target_type} target=${appeal.target_id} user=${appeal.appellant_id} — ${reason}`,
  );
  return {
    ok: true,
    action: "restore_requires_policy",
    restored: false,
    reason,
    evidence: {
      appealId:   appeal.id,
      targetType: appeal.target_type,
      targetId:   appeal.target_id,
      userId:     appeal.appellant_id,
    },
  };
}

export async function resolveAppeal(
  sc: any,
  appeal: Appeal,
): Promise<ReversalResult> {
  const { appellant_id, target_type, target_id } = appeal;

  switch (target_type) {
    // ── Content restoration ─────────────────────────────────────────────────

    case "post": {
      const { data, error } = await sc
        .from("posts")
        .update({ deleted_at: null, updated_at: new Date().toISOString() })
        .eq("id", target_id)
        // author_id, not user_id: `posts` has no user_id column (see the
        // canonical POST_COLUMNS list in routes/posts.ts). The old filter made
        // every post-appeal restore fail with an undefined-column error, which
        // this function then reported as a silent "noop" — the appeal resolved
        // while the post stayed deleted. The sibling memory case already uses
        // that table's own owner_id, so the per-table naming was known.
        .eq("author_id", appellant_id)
        .select("id");
      if (error) return { ok: false, action: "noop", reason: `post restore failed: ${error.message}` };
      // Zero matched rows resolves as `error: null`, so the ownership filter
      // above fails SILENTLY: the post is someone else's, or gone. The old code
      // read only `error` and answered "post_restored" either way.
      if (affectedRows(data) === 0) return matchedNothing(appeal, "post restore");
      return { ok: true, action: "post_restored" };
    }

    case "memory": {
      const { data, error } = await sc
        .from("memories")
        .update({ state: "published", updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("owner_id", appellant_id)
        .select("id");
      if (error) return { ok: false, action: "noop", reason: `memory restore failed: ${error.message}` };
      if (affectedRows(data) === 0) return matchedNothing(appeal, "memory restore");
      return { ok: true, action: "memory_restored" };
    }

    case "highlight": {
      const { data, error } = await sc
        .from("highlights")
        .update({ deleted_at: null, updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("owner_id", appellant_id)
        .select("id");
      if (error) return { ok: false, action: "noop", reason: `highlight restore failed: ${error.message}` };
      if (affectedRows(data) === 0) return matchedNothing(appeal, "highlight restore");
      return { ok: true, action: "highlight_restored" };
    }

    // ── Trust Score reversal ────────────────────────────────────────────────

    case "trust_score_event": {
      // Dismiss the offending trust event so TrustScoreService excludes it
      const { data, error } = await sc
        .from("trust_events")
        .update({
          status:      "dismissed",
          reviewed_by: null,
        })
        .eq("id", target_id)
        .eq("user_id", appellant_id)
        .select("id");
      if (error) return { ok: false, action: "noop", reason: `trust event dismiss failed: ${error.message}` };
      // The trust event was never dismissed — it is not the appellant's, or it
      // is gone. Returning here also stops the compensating +2 below from being
      // awarded for an offence that was never actually reversed.
      if (affectedRows(data) === 0) return matchedNothing(appeal, "trust event dismiss");

      // Counter-event: small positive signal to offset the appeal friction
      await recordTrustEvent(sc, {
        userId:     appellant_id,
        eventType:  "appeal_approved",
        category:   "community_value",
        delta:      2,
        severity:   "minor",
        sourceType: "appeal",
        sourceId:   target_id,
      }).catch(() => {});

      return { ok: true, action: "trust_event_dismissed" };
    }

    // ── No-show reversal ────────────────────────────────────────────────────

    case "no_show": {
      // target_id is event_attendee_states row identified by event+user
      // We update by event_id stored as target_id — look up and clear no_show_at
      const { data, error } = await sc
        .from("event_attendee_states")
        .update({ no_show_at: null, no_show_by: null, updated_at: new Date().toISOString() })
        .eq("event_id", target_id)
        .eq("user_id", appellant_id)
        .select("event_id, user_id");
      if (error) {
        return { ok: false, action: "noop", reason: `no_show clear failed: ${error.message}` };
      }
      // No attendee-state row for this (event, user): the no-show this appeal
      // contests is not recorded where the clear looked, so nothing was cleared.
      if (affectedRows(data) === 0) return matchedNothing(appeal, "no_show clear");
      return { ok: true, action: "no_show_cleared" };
    }

    // ── Membership restoration ──────────────────────────────────────────────

    case "event_membership": {
      // The EXACT twin of the trip_membership defect below: removing an
      // attendee DELETES the RSVP row (routes/events.ts host-removal, leave and
      // cancel paths all `.from("event_rsvps").delete()`), so this UPDATE
      // matches zero rows in precisely the case the appeal is about — and zero
      // matched rows resolves as `error: null`, which the old code reported as
      // "event_membership_restored".
      const { data, error } = await sc
        .from("event_rsvps")
        .update({ status: "attending", updated_at: new Date().toISOString() })
        .eq("event_id", target_id)
        .eq("user_id", appellant_id)
        .select("event_id, user_id, status");
      if (error) return { ok: false, action: "noop", reason: `event rsvp restore failed: ${error.message}` };
      if (affectedRows(data) === 0) {
        // No RSVP row: re-creating one is an INSERT, and what an insert means
        // here — does event capacity still apply, does the appellant land on
        // the waitlist, does a closed event reopen for them — is a product
        // decision this function must not make on a moderator's behalf.
        const owed = classifyEventMembershipRestoration(null) as RestorationOwed;
        return deferRestoration(appeal, owed.reason);
      }
      return { ok: true, action: "event_membership_restored" };
    }

    case "trip_membership": {
      // ── AN UPHELD REMOVAL APPEAL RESTORES THROUGH THE TRIP KERNEL ─────────
      // The moderated action a `trip_membership` appeal contests is REMOVAL,
      // and removal DELETES the trip_members row (REMOVE_PARTICIPANT,
      // migrations 2450/2500/2590, and its flag-off twins in routes/trips.ts
      // and routes/requests.ts). Putting the member back is therefore an
      // INSERT, and the ONLY writer allowed to make it is the Trip Kernel
      // command ADMIN_RESTORE_PARTICIPANT (migration 3974, re-issued as 3979),
      // sent by domain/trips/commands/adminRestoreTripParticipant.ts. This case
      // issues NO direct write to trip_members, and there is no legacy twin.
      //
      // The owner's ruling (OD-TRIP-1 = APPEAL_RESTORE_SEMANTICS, 2026-10-04):
      // "If an appeal succeeds, restore the access and permissions removed by
      // that decision. Don't recreate missed live activity or location
      // sharing; if a trip has ended, restore access to its retained record
      // only." planAppealRestoration (adminRestoreParticipant.ts) turns the
      // kernel's own removal record into that plan; the kernel re-checks every
      // claim against its ledger, stops any surviving location session, and
      // writes the row, the event and the receipt in ONE transaction.
      //
      // Outcomes (restoreTripMembershipOnAppeal, at the foot of this file):
      //   restored               ok: `trip_membership_restored` (live trip) or
      //                          `trip_record_access_restored` (ended trip).
      //   can never be done      DEFERRED: the ledger holds no restorable
      //                          removal (no event, a pre-2450 role, not the
      //                          latest removal, an unknown status). A person
      //                          must look; the appeal resolves, restored:false.
      //   cannot be done NOW     NOOP: kernel off, command not installed (3979
      //                          unapplied answers TRIP_COMMAND_UNKNOWN_TYPE
      //                          before any write), ledger unreadable, approver
      //                          not an admin: held under_review, re-driven. CREW
      //                          FULL: upheld, restore PENDING + retry (2026-10-12).
      // Idempotent: the kernel key is the APPEAL, and a row the kernel already
      // restored for THIS appeal is recognised before any command is sent.
      const { data: memberRow, error: readErr } = await sc
        .from("trip_members")
        .select("role, status, permissions")
        .eq("trip_id", target_id)
        .eq("user_id", appellant_id)
        .maybeSingle();
      if (readErr) {
        return { ok: false, action: "noop", reason: `trip member read failed: ${readErr.message}` };
      }

      if (memberRow != null) {
        // Replay: this appeal's restoration already happened (the kernel
        // stamps permissions.restored_by_appeal on the row it inserts).
        if (restoredByAppeal(memberRow) === appeal.id) {
          return { ok: true, action: "trip_membership_restored", restored: true, replayed: true };
        }
        // Present in another role: refused by the shared classifier that also
        // builds the operator queue, so the two can never disagree. Present
        // as 'member': nothing was removed and nothing is restored, and NO
        // write runs. (The old `SET role='member'` here was the Trip Kernel
        // ratchet's last ungated writer, and on a row that already said
        // 'member' it changed nothing.)
        const classified = classifyTripMembershipRestoration(memberRow as any, appeal.id);
        if (classified.owed) return deferRestoration(appeal, classified.reason);
        return { ok: true, action: "trip_membership_already_present" };
      }

      // Row absent: the removal this appeal contests really happened. The
      // restore is one kernel command or it is nothing — every refusal on the
      // way (actor, ledger, trip, plan, kernel) returns before any write.
      return restoreTripMembershipOnAppeal(sc, appeal);
      // (No statement follows: the success, the replay and every refusal are
      // returned above. This block keeps the cited line numbers below fixed —
      // census-trust.md cites the trust_restriction case by line.)
      // ────────────────────────────────────────────────────────────────────
    }

    // ── Moderated event/trip restoration ────────────────────────────────────
    // When a moderator removed an event or trip, appeal approval restores it
    // to a safe draft/open state so the owner can review before re-publishing.

    case "event": {
      const { data, error } = await sc
        .from("events")
        .update({ state: "open", updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("host_id", appellant_id)
        .select("id");
      if (error) return { ok: false, action: "noop", reason: `event restore failed: ${error.message}` };
      // The `host_id` filter is authorization, and a failed authorization here
      // matched zero rows without an error — the appeal closed reporting
      // "event_restored" for an event the appellant does not host.
      if (affectedRows(data) === 0) return matchedNothing(appeal, "event restore");
      return { ok: true, action: "event_restored" };
    }

    case "trip": {
      // Restoring a moderated trip is a change to the Trip aggregate: it moves
      // trips.status, which every crew member reads and which domain/trips/invariants/tripStatus.ts
      // and the lifecycle rules in §3.1 govern. It is a Trip Command.
      //
      // UPDATE_TRIP is the command, and its `owner` capability is EXACTLY the
      // authorization the legacy statement expressed as `.eq("owner_id",
      // appellant_id)` — the appellant restores their own trip, nobody else's.
      // So the actor is the appellant, actor_role 'user'; this is not an admin
      // command (the admin approved the appeal, they are not the one changing
      // the trip) and there is no admin-family restore command to use.
      //
      // expectedTripVersion is null on purpose. There is no client holding a
      // version here — the trigger is an admin approving an appeal, out of band
      // — so an If-Match would mean "abandon the restore if anyone touched the
      // trip since we read it", which is not what an appeal resolution should
      // do. The idempotency key is the APPEAL, so re-resolving the same appeal
      // replays the receipt instead of emitting a second trip.updated.
      const kernel = await tripKernelClient(sc);
      if (kernel) {
        const r = await executeTripCommand(kernel, {
          commandId: randomUUID(),
          tripId: target_id,
          actorUserId: appellant_id,
          actorRole: "user",
          expectedTripVersion: null,
          idempotencyKey: `appeal:${appeal.id}:trip`,
          type: "UPDATE_TRIP",
          payload: { patch: { status: "planning" }, updated_at: new Date().toISOString() },
        });
        // Two rejections are LOUDER than the legacy write, not weaker, and both
        // are reported as the noop this function already has a contract for:
        //   TRIP_AUTH_NOT_OWNER          the appellant does not own the trip —
        //     the legacy UPDATE matched 0 rows and still answered
        //     "trip_restored", so the appeal closed while nothing was restored.
        //   TRIP_LIFECYCLE_INVALID_TRANSITION  the trip is cancelled or
        //     archived. §3.1 makes those terminal; the legacy UPDATE walked
        //     straight out of them, which is a state the kernel refuses to
        //     produce and no other code path can produce either.
        if (!r.ok) return { ok: false, action: "noop", reason: `trip restore refused: ${r.reason}` };
        return { ok: true, action: "trip_restored" };
      }
      // trip-kernel:legacy-path — the flag-off twin of UPDATE_TRIP above.
      const { data, error } = await sc
        .from("trips")
        .update({ status: "planning", updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("owner_id", appellant_id)
        .select("id");
      if (error) return { ok: false, action: "noop", reason: `trip restore failed: ${error.message}` };
      // The kernel path above refuses a non-owner with TRIP_AUTH_NOT_OWNER; with
      // the flag OFF the same refusal has to come from the affected-row count,
      // or the legacy twin stays a false success while the gated one is honest.
      if (affectedRows(data) === 0) return matchedNothing(appeal, "trip restore");
      return { ok: true, action: "trip_restored" };
    }

    // ── Review restoration ──────────────────────────────────────────────────

    case "review": {
      const { data, error } = await sc
        .from("reviews")
        .update({ state: "published", updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("reviewer_id", appellant_id)
        .select("id");
      if (error) return { ok: false, action: "noop", reason: `review restore failed: ${error.message}` };
      if (affectedRows(data) === 0) return matchedNothing(appeal, "review restore");
      return { ok: true, action: "review_restored" };
    }

    // ── Account warning — no automated action ──────────────────────────────

    case "account_warning": {
      // Account warnings require manual moderator action; approval is an acknowledgement
      return { ok: true, action: "account_warning_acknowledged" };
    }

    // ── Trust restriction (3933, lane B wave 3) ─────────────────────────────
    // The owner's appeal ruling: an upheld appeal restores exactly the access
    // that decision removed. Lift THIS restriction, only if it is the
    // appellant's own and still active, and nothing else.

    case "trust_restriction": { if (!appeal.moderator_id) return { ok: false, action: "noop", reason: "trust restriction lift needs the approving moderator (lifted_by)" }; // every lift is attributed
      // services/trust owns trust_restrictions (check:trust-table-ownership): the lift is ITS write, matched on id + appellant + still active.
      const lift = await liftOwnRestrictionOnAppeal(sc, { restrictionId: target_id, userId: appellant_id, liftedBy: appeal.moderator_id });
      if (lift.state === "failed") return { ok: false, action: "noop", reason: `trust restriction lift failed: ${lift.reason}` };
      if (lift.state === "matched_nothing") return matchedNothing(appeal, "trust restriction lift");
      return { ok: true, action: "trust_restriction_lifted" };
    }

    // ── Unknown ────────────────────────────────────────────────────────────

    default: {
      console.warn(`[resolveAppeal] Unknown target_type="${target_type}" for appeal ${appeal.id} — no-op`);
      return { ok: false, action: "noop", reason: `unknown target_type: ${target_type}` };
    }
  }
}

import { liftOwnRestrictionOnAppeal } from "../trust/TrustRestrictionService.js"; // foot: every cited line above keeps its number

// ── trip_membership: the restore through ADMIN_RESTORE_PARTICIPANT ───────────
// Appended below the foot so that no cited line above moves (census-trips §91).
import { adminRestoreTripParticipant } from "../../domain/trips/commands/adminRestoreTripParticipant.js";
import { authorizeAdminRestoreParticipant, planAppealRestoration } from "./adminRestoreParticipant.js";
import { recoverRoleAtRemoval } from "./roleAtRemoval.js";

/** The appeal a kernel restore stamped on the row it inserted (3974/3979: permissions.restored_by_appeal), else null. */
function restoredByAppeal(row: { permissions?: unknown } | null | undefined): string | null {
  const p = row?.permissions;
  if (!p || typeof p !== "object") return null;
  const v = (p as Record<string, unknown>).restored_by_appeal;
  return typeof v === "string" ? v : null;
}

/**
 * Kernel refusals no retry can change: the ledger holds no restorable removal
 * of this person. These DEFER (the appeal resolves, restored:false, and the
 * operator queue lists it). A full crew is upheld with the restore PENDING and
 * a retry path (crewFullPending, below). Every other refusal is a NOOP — the
 * appeal is held under_review and can be re-driven once the cause is gone.
 */
const RESTORE_REFUSALS_FOR_A_PERSON: ReadonlySet<string> = new Set([
  "TRIP_RESTORE_REMOVAL_NOT_RECORDED",
  "TRIP_RESTORE_NOT_LATEST_REMOVAL",
  "TRIP_RESTORE_TRIP_STATUS_UNKNOWN",
]);

/**
 * The appellant is not on the trip. Restore what the removal took, through the
 * kernel, or refuse — never a direct write, never a partial one. Order:
 *   1. actor   the approving moderator must be an admin (fail closed; the
 *              kernel re-checks actor_role 'admin' + profiles.role = 'admin');
 *   2. plan    the role at removal from the kernel's append-only ledger and the
 *              trip's status now (planAppealRestoration: the owner's ruling);
 *   3. write   ADMIN_RESTORE_PARTICIPANT, keyed by the appeal. The command is
 *              one transaction: if it is absent (3979 unapplied) the database
 *              answers TRIP_COMMAND_UNKNOWN_TYPE having written nothing; with
 *              trip_kernel_enabled off nothing is sent at all.
 */
async function restoreTripMembershipOnAppeal(sc: any, appeal: Appeal): Promise<ReversalResult> {
  const { appellant_id, target_id } = appeal;
  const adminActor = appeal.moderator_id ?? null;
  if (!adminActor) {
    return { ok: false, action: "noop", reason: "trip membership restore needs the approving admin (the kernel command's actor)" };
  }
  const auth = await authorizeAdminRestoreParticipant(sc, adminActor);
  if (!auth.authorized) {
    return { ok: false, action: "noop", reason: `trip membership restore refused: ${auth.reason}` };
  }

  const removal = await recoverRoleAtRemoval(sc, target_id, appellant_id);
  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("id, status")
    .eq("id", target_id)
    .maybeSingle();
  if (tripErr) return { ok: false, action: "noop", reason: `trip read failed: ${tripErr.message}` };
  if (!trip) return deferRestoration(appeal, "the trip no longer exists: there is no membership or retained record to restore");

  const plan = planAppealRestoration(removal, String((trip as { status?: unknown }).status ?? ""));
  if (!plan.restore) {
    // An unreadable ledger is "we do not know", not "nothing to restore": retry.
    if (plan.reason === "removal_record_unreadable") {
      return { ok: false, action: "noop", reason: `removal record unreadable: ${plan.detail}` };
    }
    return deferRestoration(appeal, `nothing restorable under ${RESTORE_SEMANTICS_DECISION}: ${plan.reason} (${plan.detail})`);
  }

  const r = await adminRestoreTripParticipant(sc, {
    tripId: target_id,
    userId: appellant_id,
    role: plan.role,
    access: plan.access,
    appealId: appeal.id,
    removalEventId: plan.removalEventId,
    adminActor,
    reason: appeal.resolution_note?.trim() || `appeal ${appeal.id} upheld`,
    idempotencyKey: `appeal:${appeal.id}:trip_membership`,
    expectedVersion: null,
  });
  if (r.ok) { if (r.duplicate) { const { data: again } = await sc.from("trip_members").select("role, status, permissions").eq("trip_id", target_id).eq("user_id", appellant_id).maybeSingle(); if (again != null && restoredByAppeal(again) === appeal.id) return { ok: true, action: "trip_membership_restored", restored: true, replayed: true }; } if (r.duplicate) return deferRestoration(appeal, "the kernel replayed this appeal's recorded restore, but the member is absent again (a later removal or leave): nothing more is restorable under this appeal"); // a receipt replay writes nothing
    return { ok: true, action: plan.access === "membership" ? "trip_membership_restored" : "trip_record_access_restored", restored: true };
  }
  if (r.reason === "TRIP_PARTICIPANT_ALREADY_EXISTS") {
    // A row appeared between the read and the command. Nothing was written;
    // judge the row the kernel saw exactly as a row read above is judged.
    const classified = classifyTripMembershipRestoration({ role: (r as { currentRole?: string }).currentRole ?? null }, appeal.id);
    if (classified.owed) return deferRestoration(appeal, classified.reason);
    return { ok: true, action: "trip_membership_already_present" };
  }
  const detail = (r as { detail?: string }).detail;
  if (RESTORE_REFUSALS_FOR_A_PERSON.has(r.reason)) {
    return deferRestoration(appeal, `ADMIN_RESTORE_PARTICIPANT refused: ${r.reason}${detail ? ` (${detail})` : ""}`);
  }
  if (r.reason === "TRIP_PARTICIPANT_CAPACITY_REACHED") {
    // Owner ruling 2026-10-12: the cap holds and nobody is displaced. The
    // kernel refused inside its transaction (no row, no event, no receipt), so
    // the same appeal key re-drives cleanly once a place frees up.
    return crewFullPending(appeal);
  }
  const why =
    r.reason === "TRIP_COMMAND_UNKNOWN_TYPE"
      ? " — the database does not have ADMIN_RESTORE_PARTICIPANT (migration 3979 unapplied); nothing was written"
      : detail ? ` (${detail})` : "";
  return { ok: false, action: "noop", reason: `trip membership restore not performed: ${r.reason}${why}` };
}

// ── A full crew: the restore stays PENDING (owner ruling 2026-10-12) ─────────
// "An upheld appeal does not override the crew cap or displace another member.
//  Keep restoration pending with a clear explanation and an operator retry path."
// The appeal is upheld (the route commits 'approved'); the restoration is owed
// and stays visible in GET /api/appeals/restorations/pending until the member
// row exists. POST /api/appeals/:id/restoration/retry re-runs this whole path —
// admin check, ledger, plan, flag, and the kernel command (which re-checks the
// cap and the ledger and refuses before any write if 3979 is absent).

/** Why a restoration is still owed although the appeal was upheld, and how an operator re-drives it. */
export interface RestorationPending {
  /** Machine-readable cause. 'crew_full': the trip is at trips.max_members. */
  code: "crew_full";
  /** The cause can clear without anyone deciding anything; the retry path below re-attempts it. */
  retryable: true;
  /** For the operator. */
  message: string;
  /** For the appellant (the approval notice). */
  appellantMessage: string;
  /** The operator's re-drive: idempotent, admin-only, every check re-run. */
  retry: { method: "POST"; path: string };
}

export const CREW_FULL_RESTORE_PENDING = "crew_full" as const;

/** The operator's re-drive for one upheld trip_membership appeal. */
export function restorationRetryPath(appealId: string): string {
  return `/api/appeals/${appealId}/restoration/retry`;
}

function crewFullPending(appeal: Appeal): ReversalDeferred {
  const retry = { method: "POST" as const, path: restorationRetryPath(appeal.id) };
  const message =
    "The trip's crew is full (trips.max_members), so the member was not added back. An upheld appeal does not " +
    "override the crew cap and no one was removed to make room; nothing was written. The restoration stays pending: " +
    `retry it with ${retry.method} ${retry.path} once a place frees up.`;
  const d = deferRestoration(appeal, message);
  return {
    ...d,
    action: "restore_pending_crew_full",
    pending: {
      code: CREW_FULL_RESTORE_PENDING,
      retryable: true,
      message,
      appellantMessage:
        "The trip's crew is full right now, so you have not been added back yet. Nobody will be removed to make room; " +
        "a moderator will restore your place once one frees up.",
      retry,
    },
  };
}
