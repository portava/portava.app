/**
 * WatchStage24Ranking — the Watch feed ordered by the §24 Media Ranking stage
 * instead of the legacy watch-time ranker (census-media §34; owner decision F2;
 * MD11, MD215, MD402, MD435). Behind MEDIA_WATCH_STAGE24_RANKING_ENABLED,
 * seeded OFF by migration 3343.
 *
 * ── WHAT IT REPLACES, AND WHAT IT DOES NOT ───────────────────────────────────
 * GET /api/media/feed (routes/mediaFeed.ts) orders the page the eligibility
 * gate admitted with `services/ranking/MediaFeedRankingService.rankMediaFeed`,
 * whose step 2 multiplies every score by watch completion, qualified views and
 * re-watches, and whose saves/shares term adds the stamp count. That is the
 * "counts dominate" and "optimise for minutes watched" the census records
 * against MD215 and MD402, and the second Media ranker MD435 records.
 *
 * With the flag ON the same admitted page is ordered by
 * `MediaRankingService.rankCandidatesForViewer` — the §42 stage the World shell
 * already ranks every lens with, which reads no like, stamp, view, watch time
 * or completion rate (§26, §45). Nothing else about the request changes:
 *   • MEMBERSHIP. The stage only reorders the rows it is given — it returns the
 *     same objects — and this module maps them back by id, so it can neither
 *     drop, duplicate nor invent a row. The private-author guard, the limit, the
 *     cursor and hydration all run after it exactly as they run after the
 *     legacy ranker.
 *   • SIGNALS. The stage's loader reads the viewer's own rows and facts about
 *     the admitted page only (MediaRankingSignalLoader's header), and every
 *     read settles to neutral on error. A failed read reorders; it never widens.
 *   • The legacy ranker's master switch, MEDIA_RANKING_ENABLED, does not gate
 *     this. It is the legacy ranker's own switch (OFF there = chronological);
 *     the World shell's stage has no master switch, and turning this flag ON is
 *     itself the decision to rank Watch with the stage.
 *
 * With the flag OFF, absent or unreadable, `isWatchStage24RankingEnabled` is
 * false and the route calls rankMediaFeed exactly as before. That is the
 * seeded state and TODAY's ordering.
 *
 * ── WHAT IS LOGGED ───────────────────────────────────────────────────────────
 * Each impression's `features` are the §24 term values the page was ordered by
 * (`stage24Features`, keys prefixed `s24_` so no reader can mistake them for
 * the legacy ranker's). The legacy "Why This?" snapshot is not written for a
 * page the legacy ranker did not order.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { loadViewerTripIds } from "../../lib/mediaEligibility.js";
import type { MediaCandidateRow } from "../../lib/media/mediaProjection.js";
import { rankCandidatesForViewer, type MediaRankingScore } from "./MediaRankingService.js";

/** The flag's one reader. Fail-closed: absent, unreadable and FALSE are all `false`. */
export async function isWatchStage24RankingEnabled(sc: SupabaseClient | null): Promise<boolean> {
  if (!sc) return false;
  return isFlagEnabled(sc, "MEDIA_WATCH_STAGE24_RANKING_ENABLED");
}

export interface WatchStage24Viewer {
  viewerId: string;
  viewerCountry: string | null;
  /** Empty for the For You feed, which loads no follow graph; the stage's loader then reads it. */
  followedCreatorIds: Set<string>;
  /** Loaded by the Following feed only; when absent the viewer's trips are read here. */
  viewerTripIds?: Set<string>;
}

/**
 * The numeric §24 terms of one row's score, prefixed `s24_`, for the
 * impression log. `provenanceClass` is a label, not a number, and is recorded
 * as `s24_synthetic` (1 when the §2 partition placed it last).
 */
export function stage24Features(score: MediaRankingScore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(score)) {
    if (typeof value === "number" && Number.isFinite(value)) out[`s24_${key}`] = value;
  }
  out.s24_synthetic = score.provenanceClass === "synthetic" ? 1 : 0;
  return out;
}

/**
 * Order the Watch page the eligibility gate admitted with the §24 stage.
 * Returns the SAME candidate objects, each exactly once: whatever the stage
 * returns is mapped back by id, and any admitted row it did not return (it
 * never drops one; this is defence) keeps its input order at the end.
 */
export async function orderWatchCandidatesByStage24<T extends { id: string }>(
  sc: SupabaseClient,
  viewer: WatchStage24Viewer,
  eligible: readonly T[],
  nowMs: number,
  featuresOut?: Map<string, Record<string, number>>,
): Promise<T[]> {
  if (eligible.length === 0) return [];
  let viewerTripIds = viewer.viewerTripIds;
  if (!viewerTripIds) {
    try {
      viewerTripIds = await loadViewerTripIds(sc, viewer.viewerId);
    } catch {
      viewerTripIds = new Set(); // a ranking input: losing it is neutral, never wider
    }
  }
  const scores = new Map<string, MediaRankingScore>();
  const ordered = await rankCandidatesForViewer(
    sc,
    {
      viewerId: viewer.viewerId,
      viewerCountry: viewer.viewerCountry,
      followedCreatorIds: viewer.followedCreatorIds,
      viewerTripIds,
    },
    eligible as unknown as MediaCandidateRow[],
    { viewerId: viewer.viewerId, viewerTripIds, nowMs },
    scores,
  );
  if (featuresOut) for (const [id, score] of scores) featuresOut.set(id, stage24Features(score));

  const byId = new Map(eligible.map((c) => [String(c.id), c]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of ordered) {
    const id = String(row.id);
    const candidate = byId.get(id);
    if (candidate && !seen.has(id)) {
      out.push(candidate);
      seen.add(id);
    }
  }
  for (const c of eligible) if (!seen.has(String(c.id))) { out.push(c); seen.add(String(c.id)); }
  return out;
}
