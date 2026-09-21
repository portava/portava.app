/**
 * Trips §10 — the presence READ surface.
 *
 * WHY THIS FILE IS BEING ADDED AFTER THE WHOLE FEATURE
 * ===================================================
 * §10 presence was built end to end and could not be read. Migration 2763
 * created `trip_presence`; 2767 gave it the spec's eight states and a `source`
 * vocabulary; 2768 gave the kernel SET_PRESENCE and CLEAR_PRESENCE; 2776 added
 * the freshness computation and the `trip_presence_current` view; 2777 stopped
 * a delayed observation overwriting a newer one. Measured 2026-09-09: NO route
 * in this server, and no client file in the app, read any of it.
 *
 * A presence row nobody can read is not presence. This route is the missing
 * half, and its whole job is to hand the reader the labels §10.2 requires
 * WITHOUT deciding for them.
 *
 * WHAT THIS ROUTE DOES NOT DO, DELIBERATELY
 * =========================================
 * It does not filter expired rows out. `trip_presence_current`'s own comment
 * says why and this route obeys it: "we know where they were an hour ago" and
 * "we have never known where they are" are different facts, and a filtered row
 * cannot express the difference. §10.4 depends on that distinction — last-known
 * data may remain useful but is not live truth. So OFFLINE rows are returned,
 * labelled, and it is the client's business what to draw.
 *
 * It also does not invent a row for a crew member with no presence. Absent
 * means never observed, and that is `noPresence`, listed separately, not an
 * `unknown` state — `unknown` is a state a traveller can actually BE in (they
 * reported it), and conflating the two would let "we have no idea" render as
 * "they told us they don't know".
 *
 * VISIBILITY
 * ==========
 * §10.3's `visibility` is enforced here rather than left to RLS, because RLS
 * grants the whole crew SELECT on the table. `private` rows are visible only
 * to their own subject. `participants` and `crew` both resolve to the accepted
 * crew, which is who this route already requires the caller to be — the two
 * are kept apart in the response rather than merged, because they are
 * different declarations even where they currently coincide, and merging them
 * here would quietly lose the distinction the moment they stop coinciding.
 *
 * FAIL-CLOSED
 * ===========
 * A read that fails is 503. It is NOT an empty presence list: an empty list
 * says "nobody on this trip has reported where they are", which is a claim
 * about the crew, and a query that did not answer has not established it.
 */
import { Router } from "express";

import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const router = Router();
const log = logger.child({ mod: "tripPresence" });

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** §10.2's four freshness labels, in the order they degrade. */
export const PRESENCE_FRESHNESS = ["live", "recent", "last_known", "offline"] as const;
export type PresenceFreshness = (typeof PRESENCE_FRESHNESS)[number];

/**
 * Freshness values a reader may treat as CURRENT. `last_known` and `offline`
 * are deliberately excluded: §10.2's rule is that the map must never draw a
 * stale location as if it were current, and this is the one place that says
 * where the line is.
 */
export const CURRENT_FRESHNESS: ReadonlySet<string> = new Set(["live", "recent"]);

interface PresenceRow {
  trip_id: string;
  user_id: string;
  presence_state: string;
  visibility: string;
  source: string | null;
  confidence: number | null;
  observed_at: string;
  expires_at: string;
  freshness: string;
  expired: boolean;
  observed_seconds_ago: number;
}

/**
 * May `viewer` see `row`? §10.3.
 *
 * Exported and pure so the rule is testable without a database. It is a
 * whitelist: a visibility value this code does not recognise is NOT shown.
 * A vocabulary can grow, and the safe direction to be wrong in when it does is
 * withholding a row, not publishing a location.
 */
export function presenceVisibleTo(row: { user_id: string; visibility: string }, viewerId: string): boolean {
  if (row.user_id === viewerId) return true;          // your own row, always
  if (row.visibility === "crew") return true;         // the caller is crew
  if (row.visibility === "participants") return true; // ditto, kept distinct
  return false;                                        // 'private', and anything new
}

router.get("/trips/:tripId/presence", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid trip id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a trip member"); return; }

  const { data, error } = await sc
    .from("trip_presence_current")
    .select("trip_id, user_id, presence_state, visibility, source, confidence, observed_at, expires_at, freshness, expired, observed_seconds_ago")
    .eq("trip_id", tripId);

  if (error) {
    // NOT an empty list. "Nobody has reported where they are" is a claim about
    // the crew; a failed read has not established it.
    log.warn({ err: error.message, tripId }, "presence read failed");
    sendError(res, "degraded_unavailable", "Could not read this trip's presence");
    return;
  }

  const rows = ((data ?? []) as PresenceRow[]).filter((r) => presenceVisibleTo(r, user.id));

  // Who is on the trip but has never been observed. Separate from the rows
  // above on purpose — see the header on why this is not an 'unknown' state.
  const { data: crew, error: crewErr } = await sc
    .from("trip_members")
    .select("user_id, status, role")
    .eq("trip_id", tripId);

  if (crewErr) {
    // The presence rows are readable and the crew list is not, so the SET of
    // people with no presence cannot be computed. Refusing the whole response
    // is the honest option: returning the rows with an empty `noPresence`
    // would assert that everyone has reported, which is the opposite.
    log.warn({ err: crewErr.message, tripId }, "presence: crew read failed");
    sendError(res, "degraded_unavailable", "Could not read this trip's crew");
    return;
  }

  const accepted = ((crew ?? []) as Array<{ user_id: string; status: string | null; role: string | null }>)
    .filter((m) => m.status === "accepted" || m.role === "owner")
    .map((m) => m.user_id);
  const observed = new Set(rows.map((r) => r.user_id));
  const noPresence = accepted.filter((id) => !observed.has(id));

  res.json({
    tripId,
    /** Server clock at read time. A client computing its own staleness against
     *  a skewed device clock is how a stale row becomes a fresh-looking one. */
    asOf: new Date().toISOString(),
    presence: rows.map((r) => ({
      userId: r.user_id,
      state: r.presence_state,
      visibility: r.visibility,
      /** §10.3 provenance. Null when the row predates 2767's `source` column —
       *  which is "we do not know how this was observed", not "self-reported". */
      source: r.source,
      confidence: r.confidence,
      observedAt: r.observed_at,
      expiresAt: r.expires_at,
      /** live | recent | last_known | offline — computed by the database from
       *  the same clock the expiry uses. */
      freshness: r.freshness,
      expired: r.expired,
      observedSecondsAgo: r.observed_seconds_ago,
      /** The §10.2 decision, made once here rather than in every client. */
      isCurrent: CURRENT_FRESHNESS.has(r.freshness),
    })),
    /** Accepted crew with NO presence row at all — never observed, which is
     *  not the same as having reported the 'unknown' state. */
    noPresence,
  });
}));

export default router;
