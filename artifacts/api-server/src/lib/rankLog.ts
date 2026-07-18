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
        session_id: sessionId ?? null,
      };
    });

    await sc.from("rank_events").insert(rows);
  } catch {
    // Silent swallow — logging must never break the feed
  }
}
