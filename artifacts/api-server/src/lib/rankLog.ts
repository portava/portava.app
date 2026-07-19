/**
 * rankLog — fire-and-forget impression logger for the Portava rank_events table.
 *
 * Spec §7: every rankCandidates() call in Pulse, Discovery, and Events must log
 * one `impression` row per served item so the outcome funnel
 * (impression → tap → save/join/rsvp → attended) can be reconstructed for
 * fitting v2 weights.
 *
 * Spec §8 privacy rule: precise GPS coordinates must never be stored.  This
 * module strips any `distanceKm`-adjacent raw-coordinate keys from features
 * before insert.  The computed scalar `distance` feature (already a float
 * 0–1 produced by the distance kernel) is safe and is retained.
 */

import { randomUUID } from "node:crypto";
import { getServiceClient } from "./supabase";
import type { ScoredCandidate, RankCandidate } from "./portavaRank";

/** Feature keys that carry or could carry raw GPS coordinates — strip on log. */
const COORDINATE_KEYS = new Set(["lat", "lng", "latitude", "longitude", "distanceKm"]);

function stripCoordinateKeys(features: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(features)) {
    if (!COORDINATE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Bulk-insert one `impression` row per scored candidate into `rank_events`.
 *
 * Fire-and-forget: call without `await` so a logging failure never blocks a
 * feed response.  All errors are swallowed silently.
 *
 * @param scored    Output of rankCandidates() — position is inferred from array order.
 * @param userId    Authenticated viewer.
 * @param surface   "pulse" | "discovery" | "events"
 * @param sessionId Optional session UUID for grouping a single open.
 */
export async function logImpression(
  scored: ScoredCandidate<RankCandidate>[],
  userId: string,
  surface: "pulse" | "discovery" | "events",
  sessionId?: string,
): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc || scored.length === 0) return;

    const servedAt = new Date().toISOString();
    // Generate one fallback session UUID for the whole batch so every row from
    // this invocation shares the same session_id — mirrors the "single open"
    // semantics callers rely on for funnel reconstruction.
    const effectiveSessionId = sessionId ?? randomUUID();

    const rows = scored.map((s, idx) => {
      const kind = s.candidate.kind;
      // Map CandidateKind → item_kind enum (collapse aliases)
      const itemKind: string =
        kind === "postcard" ? "post" :
        kind === "traveler" ? "buddy" :
        kind === "trip"     ? "plan" :
        kind;

      return {
        user_id:    userId,
        item_id:    s.candidate.id,
        item_kind:  itemKind,
        position:   idx,
        features:   stripCoordinateKeys(s.features),
        outcome:    "impression",
        served_at:  servedAt,
        surface,
        session_id: effectiveSessionId,
      };
    });

    await sc.from("rank_events").insert(rows);
  } catch {
    // Silent swallow — logging must never break the feed
  }
}

/**
 * Maps raw Compass item.type strings to the item_kind values allowed by the
 * rank_events CHECK constraint ('post','event','plan','buddy','place','gem').
 *
 * Types absent from this map (e.g. 'safety_tip', 'language_tip') are static
 * appended items, not ML-ranked candidates — they are filtered out before
 * insert so they never cause a constraint violation.
 */
const COMPASS_ITEM_KIND: Record<string, string> = {
  event:    "event",
  post:     "post",
  postcard: "post",     // Compass alias for post
  plan:     "plan",
  trip:     "plan",     // Compass alias for plan
  buddy:    "buddy",
  traveler: "buddy",    // Compass alias for buddy
  place:    "place",
  gem:      "gem",
};

/**
 * Log Compass recommendation impressions into rank_events.
 *
 * Accepts the lighter-weight Compass item shape (id + type) rather than the
 * full ScoredCandidate used by the portavaRank pipeline.  item.type values are
 * normalised to the schema-valid item_kind set; static items without a mapping
 * (safety_tip, language_tip, …) are silently skipped.
 *
 * Calls rank_events.insert unconditionally (even when all items are filtered
 * out) so that fire-and-forget behaviour can be verified in timing tests.
 *
 * Fire-and-forget: call without `await` so a logging failure never blocks the
 * recommendations response.  All errors are swallowed silently.
 *
 * @param items     Served recommendations — id + type from the Compass feed.
 * @param userId    Authenticated viewer.
 * @param sessionId Optional session UUID for grouping a single open.
 */
export async function logCompassImpression(
  items: Array<{ id: string; type: string }>,
  userId: string,
  sessionId?: string,
): Promise<void> {
  try {
    const sc = getServiceClient();
    if (!sc) return;

    const servedAt = new Date().toISOString();

    const rows = items.flatMap((item, idx) => {
      const itemKind = COMPASS_ITEM_KIND[item.type];
      if (!itemKind) return []; // static / unknown type — skip
      return [{
        user_id:    userId,
        item_id:    item.id,
        item_kind:  itemKind,
        position:   idx,
        features:   {},
        outcome:    "impression",
        served_at:  servedAt,
        surface:    "compass",
        session_id: sessionId ?? null,
      }];
    });

    await sc.from("rank_events").insert(rows);
  } catch {
    // Silent swallow — logging must never break the feed
  }
}
