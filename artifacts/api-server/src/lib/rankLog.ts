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

// ── Fatigue tracking ──────────────────────────────────────────────────────────
// Fire-and-forget upsert into viewer_creator_fatigue for impression batches.
// Gated by the CREATOR_FATIGUE_ENABLED feature flag (fail-open: skipped when flag
// is unreachable). Deduplicates creator IDs within each batch (batch-at-most-once
// per session per creator) to avoid write amplification.

let _fatigueFlagCachedAt   = 0;
let _fatigueFlagEnabled    = false;
const FATIGUE_FLAG_TTL_MS  = 60_000; // 60 s TTL matching rankingConfig cache

async function isFatigueEnabled(sc: any): Promise<boolean> {
  if (Date.now() - _fatigueFlagCachedAt < FATIGUE_FLAG_TTL_MS) return _fatigueFlagEnabled;
  try {
    const { data } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "CREATOR_FATIGUE_ENABLED")
      .maybeSingle();
    _fatigueFlagEnabled  = Boolean((data as any)?.enabled);
    _fatigueFlagCachedAt = Date.now();
  } catch { /* fail-open: keep previous value */ }
  return _fatigueFlagEnabled;
}

function upsertCreatorFatigueAsync(
  sc:         any,
  viewerId:   string,
  creatorIds: string[],
): void {
  const unique = [...new Set(creatorIds.filter(Boolean))];
  if (unique.length === 0) return;
  // Validate UUIDs — the RPC parameter is UUID[]; non-UUID OSM IDs must be filtered.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidIds = unique.filter((id) => UUID_RE.test(id));
  if (uuidIds.length === 0) return;

  void sc
    .rpc("increment_creator_fatigue_batch", {
      p_viewer_id:  viewerId,
      p_creator_ids: uuidIds,
    })
    .then(() => {}, () => {});
}

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

    // Fatigue tracking — fire-and-forget, gated by feature flag
    const fatigueEnabled = await isFatigueEnabled(sc).catch(() => false);
    if (fatigueEnabled) {
      const creatorIds = scored
        .map((s) => s.candidate.authorId as string | null | undefined)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      upsertCreatorFatigueAsync(sc, userId, creatorIds);
    }
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
