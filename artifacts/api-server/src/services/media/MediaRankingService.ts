/**
 * MediaRankingService — deterministic discovery ordering for the World shell.
 *
 * This ranks only signals already present on a candidate row. Missing signals
 * are neutral (never guessed), and the returned ROWS ARE UNCHANGED — this
 * module reorders, it never reshapes — so `projectCandidatesProtected` remains
 * the single privacy boundary and runs on exactly what it would have run on.
 *
 * NOT `services/ranking/MediaFeedRankingService`. That one ranks a already-
 * projected `MediaFeedItem` for the §18 feed with engagement, watch-completion,
 * creator caps and session fatigue. This one ranks a RAW `MediaCandidateRow`
 * before projection, for the World/experience shell, and is deliberately blind
 * to engagement: quality, provenance, the viewer's own explicit intent, trip
 * affinity, freshness. The two operate on different types at different stages
 * and neither subsumes the other.
 */
import type { MediaCandidateRow } from "../../lib/media/mediaProjection.js";

export interface MediaRankingContext {
  viewerId?: string | null;
  viewerTripIds?: ReadonlySet<string>;
  /** Bulk-loaded private intent rows for this viewer. */
  intentMediaIds?: ReadonlySet<string>;
  nowMs: number;
}

export interface MediaRankingScore {
  score: number;
  quality: number;
  provenance: number;
  intent: number;
  tripAffinity: number;
  freshness: number;
}

function profile(row: MediaCandidateRow): any {
  return Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
}

/** Authentic/official source signals outrank generated or derivative material. */
function provenanceScore(row: MediaCandidateRow): number {
  const p = profile(row);
  if (p?.is_official === true) return 1;
  if (p?.verified === true) return 0.9;
  return 0.5; // unknown is neutral, not a penalty
}

function freshnessScore(row: MediaCandidateRow, nowMs: number): number {
  const created = new Date(String(row.created_at ?? "")).getTime();
  if (!Number.isFinite(created)) return 0.5;
  const ageHours = Math.max(0, nowMs - created) / 3_600_000;
  return Math.exp(-ageHours / (24 * 7));
}

export function scoreMediaCandidate(row: MediaCandidateRow, context: MediaRankingContext): MediaRankingScore {
  const media = Array.isArray(row.post_media) ? row.post_media[0] : null;
  // Quality is derived from metadata selected by the projection loader. It is
  // deliberately independent of watch/completion or social engagement.
  const hasDimensions = typeof media?.width === "number" && typeof media?.height === "number";
  const quality = hasDimensions && media.width > 0 && media.height > 0 ? 1 : 0.5;
  const intent = context.intentMediaIds?.has(String(row.id)) ? 1 : 0;
  const tripId = typeof (row as any).trip_id === "string" ? String((row as any).trip_id) : null;
  const tripAffinity = tripId && context.viewerTripIds?.has(tripId) ? 1 : 0;
  const provenance = provenanceScore(row);
  const freshness = freshnessScore(row, context.nowMs);
  // Quality and authenticity are primary; explicit wants and trip relevance
  // are high-confidence intent signals; freshness breaks otherwise close ties.
  const score =
    quality * 0.32 +
    provenance * 0.24 +
    intent * 0.20 +
    tripAffinity * 0.16 +
    freshness * 0.08;
  return { score, quality, provenance, intent, tripAffinity, freshness };
}

/**
 * Stable greedy diversity pass. It prevents a prolific contributor/place or
 * repeated category from filling the shell while retaining score ordering.
 */
export function rankMediaCandidates(
  candidates: MediaCandidateRow[],
  context: MediaRankingContext,
): MediaCandidateRow[] {
  const scored = candidates.map((row, index) => ({ row, index, score: scoreMediaCandidate(row, context) }));
  const remaining = [...scored];
  const output: MediaCandidateRow[] = [];
  const placeCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  while (remaining.length > 0) {
    let best = 0;
    let bestAdjusted = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const entry = remaining[i];
      const place = String(entry.row.canonical_place_id ?? entry.row.location_name ?? "");
      const category = String(entry.row.category ?? "");
      const adjusted =
        entry.score.score -
        Math.min(0.18, (placeCounts.get(place) ?? 0) * 0.06) -
        Math.min(0.12, (categoryCounts.get(category) ?? 0) * 0.04);
      if (adjusted > bestAdjusted || (adjusted === bestAdjusted && entry.index < remaining[best].index)) {
        best = i;
        bestAdjusted = adjusted;
      }
    }
    const [chosen] = remaining.splice(best, 1);
    output.push(chosen.row);
    const place = String(chosen.row.canonical_place_id ?? chosen.row.location_name ?? "");
    const category = String(chosen.row.category ?? "");
    placeCounts.set(place, (placeCounts.get(place) ?? 0) + 1);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  return output;
}