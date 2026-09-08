/**
 * Appeal reversal handler.
 *
 * Called when an admin approves an appeal (state → approved).
 * Dispatches the correct reversal action by target_type.
 * Unknown target_types return a no-op with a log warning — never throw.
 */

import { randomUUID } from "node:crypto";
import { recordTrustEvent } from "../trust/TrustEventService.js";
import { executeTripCommand, tripKernelClient } from "../../lib/tripKernel.js";

export interface Appeal {
  id: string;
  appellant_id: string;
  target_type: string;
  target_id: string;
  resolution_note: string | null;
}

/** The reversal ran and did what `action` says it did. */
export interface ReversalApplied {
  ok: true;
  action: string;
  /** Absent means "the action name is the whole truth". */
  restored?: true;
}

/**
 * The appeal RESOLVES, but the restoration itself did NOT happen and cannot be
 * performed by this code. `action` is deliberately NOT a `*_restored` name, and
 * `restored` is explicitly false so no caller can mistake this for a success by
 * reading `ok` alone.
 */
export interface ReversalDeferred {
  ok: true;
  action: "restore_requires_policy";
  restored: false;
  reason: string;
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

/** The OPEN owner decision that blocks trip-membership restoration. */
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
 *                       INSERT — ADMIN_RESTORE_PARTICIPANT — and the role they
 *                       return to is APPEAL_RESTORE_SEMANTICS, still open.
 *   row present, other  they were never removed, and the legacy
 *   than 'member'       `SET role='member'` would DEMOTE them. Rewriting that
 *                       role is exactly the role invention this must not do.
 *   row present,
 *   role 'member'       nothing was removed and nothing is owed.
 */
export function classifyTripMembershipRestoration(
  memberRow: { role?: string | null } | null | undefined,
): RestorationClassification {
  if (memberRow == null) {
    return {
      owed: true,
      requiredCommand: "ADMIN_RESTORE_PARTICIPANT",
      blockedOn: RESTORE_SEMANTICS_DECISION,
      reason:
        "trip_members row absent (member was removed by DELETE); restoring it requires " +
        `ADMIN_RESTORE_PARTICIPANT and the owner decision ${RESTORE_SEMANTICS_DECISION}`,
    };
  }
  const role = memberRow.role ?? null;
  if (role !== "member") {
    return {
      owed: true,
      requiredCommand: "ADMIN_RESTORE_PARTICIPANT",
      blockedOn: RESTORE_SEMANTICS_DECISION,
      reason:
        `trip_members row present with role '${role}' — nothing was removed, and rewriting ` +
        `that role would be choosing a restoration role (owner decision ${RESTORE_SEMANTICS_DECISION})`,
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
      // ── WHY THIS CASE CANNOT RESTORE ANYTHING ───────────────────────────
      // The moderated action a `trip_membership` appeal contests is REMOVAL,
      // and removal DELETES the trip_members row — the kernel's
      // REMOVE_PARTICIPANT does `DELETE FROM public.trip_members` (migrations
      // 2450/2500/2590) and so does its flag-off twin in routes/trips.ts and
      // routes/requests.ts. So the row this case wants to update is GONE in
      // exactly the situation the case exists for.
      //
      // supabase-js reports "matched zero rows" as `{ error: null }` — the same
      // shape a successful update returns. The previous code read only `error`
      // and answered `trip_membership_restored`, so every appeal of this type
      // closed, notified the appellant that the removal had been reversed, and
      // restored NOTHING. That is the defect.
      //
      // Restoring a deleted member means RE-INSERTING the row, which is the
      // command ADMIN_RESTORE_PARTICIPANT — it does not exist, and the role a
      // removed member returns to (their role at removal? 'member'? does the
      // crew cap still apply?) is the OPEN owner decision
      // APPEAL_RESTORE_SEMANTICS. Nothing below decides it: this case reports
      // that the restoration is owed, it does not perform one.
      //
      // The UPDATE below is the site the Trip Kernel ratchet reports as the one
      // remaining UNGATED writer of a canonical trip table. It stays, and it
      // stays ungated, because the ratchet entry IS the visible record of that
      // unresolved decision.
      const { data: memberRow, error: readErr } = await sc
        .from("trip_members")
        .select("role, status")
        .eq("trip_id", target_id)
        .eq("user_id", appellant_id)
        .maybeSingle();
      if (readErr) {
        return { ok: false, action: "noop", reason: `trip member read failed: ${readErr.message}` };
      }

      // Both refusals below — "row is gone" and "row holds another role, and
      // rewriting it would be inventing one" — come from the shared classifier
      // that also builds the operator queue, so the queue and this answer can
      // never disagree about whether a restoration is still owed.
      const classified = classifyTripMembershipRestoration(memberRow as any);
      if (classified.owed) return deferRestoration(appeal, classified.reason);

      // Role is already 'member': the legacy UPDATE cannot change it, so it is
      // safe to run, and its RETURNING rows are the affected-row count this
      // function used to assume. `.select()` is what makes the update RETURNING;
      // without it `data` is null on success and zero-matched is indetectable.
      const { data: touched, error } = await sc
        .from("trip_members")
        .update({ role: "member" })
        .eq("trip_id", target_id)
        .eq("user_id", appellant_id)
        .select("trip_id, user_id, role");
      if (error) return { ok: false, action: "noop", reason: `trip member restore failed: ${error.message}` };

      const affected = Array.isArray(touched) ? touched.length : touched == null ? 0 : 1;
      if (affected === 0) {
        // The row was deleted between the read and the write. Still not a
        // restoration, and still not ours to invent a role for.
        return deferRestoration(
          appeal,
          "trip_members row disappeared between read and write; the update matched zero rows " +
          `(restoring it requires ADMIN_RESTORE_PARTICIPANT and the owner decision ${RESTORE_SEMANTICS_DECISION})`,
        );
      }

      // The membership is intact and was already 'member'. Nothing was removed
      // and nothing was restored — and this must not be reported as a restore.
      return { ok: true, action: "trip_membership_already_present" };
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
      // trips.status, which every crew member reads and which lib/tripStatus.ts
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

    // ── Unknown ────────────────────────────────────────────────────────────

    default: {
      console.warn(`[resolveAppeal] Unknown target_type="${target_type}" for appeal ${appeal.id} — no-op`);
      return { ok: false, action: "noop", reason: `unknown target_type: ${target_type}` };
    }
  }
}
