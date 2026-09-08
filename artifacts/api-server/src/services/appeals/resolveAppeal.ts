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

type ReversalResult =
  | { ok: true; action: string }
  | { ok: false; action: "noop"; reason: string };

export async function resolveAppeal(
  sc: any,
  appeal: Appeal,
): Promise<ReversalResult> {
  const { appellant_id, target_type, target_id } = appeal;

  switch (target_type) {
    // ── Content restoration ─────────────────────────────────────────────────

    case "post": {
      const { error } = await sc
        .from("posts")
        .update({ deleted_at: null, updated_at: new Date().toISOString() })
        .eq("id", target_id)
        // author_id, not user_id: `posts` has no user_id column (see the
        // canonical POST_COLUMNS list in routes/posts.ts). The old filter made
        // every post-appeal restore fail with an undefined-column error, which
        // this function then reported as a silent "noop" — the appeal resolved
        // while the post stayed deleted. The sibling memory case already uses
        // that table's own owner_id, so the per-table naming was known.
        .eq("author_id", appellant_id);
      if (error) return { ok: false, action: "noop", reason: `post restore failed: ${error.message}` };
      return { ok: true, action: "post_restored" };
    }

    case "memory": {
      const { error } = await sc
        .from("memories")
        .update({ state: "published", updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("owner_id", appellant_id);
      if (error) return { ok: false, action: "noop", reason: `memory restore failed: ${error.message}` };
      return { ok: true, action: "memory_restored" };
    }

    case "highlight": {
      const { error } = await sc
        .from("highlights")
        .update({ deleted_at: null, updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("owner_id", appellant_id);
      if (error) return { ok: false, action: "noop", reason: `highlight restore failed: ${error.message}` };
      return { ok: true, action: "highlight_restored" };
    }

    // ── Trust Score reversal ────────────────────────────────────────────────

    case "trust_score_event": {
      // Dismiss the offending trust event so TrustScoreService excludes it
      const { error } = await sc
        .from("trust_events")
        .update({
          status:      "dismissed",
          reviewed_by: null,
        })
        .eq("id", target_id)
        .eq("user_id", appellant_id);
      if (error) return { ok: false, action: "noop", reason: `trust event dismiss failed: ${error.message}` };

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
      const { error } = await sc
        .from("event_attendee_states")
        .update({ no_show_at: null, no_show_by: null, updated_at: new Date().toISOString() })
        .eq("event_id", target_id)
        .eq("user_id", appellant_id);
      if (error) {
        // Fallback: try filtering by user_id + event_id encoded as target_id
        return { ok: false, action: "noop", reason: `no_show clear failed: ${error.message}` };
      }
      return { ok: true, action: "no_show_cleared" };
    }

    // ── Membership restoration ──────────────────────────────────────────────

    case "event_membership": {
      // Restore removed RSVP to attending
      const { error } = await sc
        .from("event_rsvps")
        .update({ status: "attending", updated_at: new Date().toISOString() })
        .eq("event_id", target_id)
        .eq("user_id", appellant_id);
      if (error) return { ok: false, action: "noop", reason: `event rsvp restore failed: ${error.message}` };
      return { ok: true, action: "event_membership_restored" };
    }

    case "trip_membership": {
      // Restore removed trip member
      const { error } = await sc
        .from("trip_members")
        .update({ role: "member" })
        .eq("trip_id", target_id)
        .eq("user_id", appellant_id);
      if (error) return { ok: false, action: "noop", reason: `trip member restore failed: ${error.message}` };
      return { ok: true, action: "trip_membership_restored" };
    }

    // ── Moderated event/trip restoration ────────────────────────────────────
    // When a moderator removed an event or trip, appeal approval restores it
    // to a safe draft/open state so the owner can review before re-publishing.

    case "event": {
      const { error } = await sc
        .from("events")
        .update({ state: "open", updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("host_id", appellant_id);
      if (error) return { ok: false, action: "noop", reason: `event restore failed: ${error.message}` };
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
      const { error } = await sc
        .from("trips")
        .update({ status: "planning", updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("owner_id", appellant_id);
      if (error) return { ok: false, action: "noop", reason: `trip restore failed: ${error.message}` };
      return { ok: true, action: "trip_restored" };
    }

    // ── Review restoration ──────────────────────────────────────────────────

    case "review": {
      const { error } = await sc
        .from("reviews")
        .update({ state: "published", updated_at: new Date().toISOString() })
        .eq("id", target_id)
        .eq("reviewer_id", appellant_id);
      if (error) return { ok: false, action: "noop", reason: `review restore failed: ${error.message}` };
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
