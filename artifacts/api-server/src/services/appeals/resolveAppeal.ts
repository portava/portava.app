/**
 * Appeal reversal handler.
 *
 * Called when an admin approves an appeal (state → approved).
 * Dispatches the correct reversal action by target_type.
 * Unknown target_types return a no-op with a log warning — never throw.
 */

import { recordTrustEvent } from "../trust/TrustEventService.js";

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
