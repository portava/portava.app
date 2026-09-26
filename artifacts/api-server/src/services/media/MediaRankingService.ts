/**
 * MediaRankingService — the §24 ranker for the World shell (§41
 * MediaRankingService, §42 "Media Ranking" stage).
 *
 * It ranks a page of RAW `MediaCandidateRow`s AFTER eligibility and BEFORE the
 * location/gem choke point (`MediaProjectionService.rankAndProject`). The rows
 * it returns are the SAME objects, in a new order — it reorders, it never
 * reshapes, filters or copies — so `projectCandidatesProtected` stays the single
 * privacy boundary and runs on exactly the set it would have run on.
 *
 * NOT `services/ranking/MediaFeedRankingService`. That one ranks an already-
 * projected `MediaFeedItem` for the legacy Watch feed with watch-completion,
 * creator caps and session fatigue. This one is deliberately blind to
 * engagement: no like, stamp, view, watch time or completion rate reaches any
 * term here (§26, §45). The two operate on different types at different stages
 * and neither subsumes the other.
 *
 * ── §24, TERM BY TERM ────────────────────────────────────────────────────────
 * `SPEC_24_COVERAGE` below maps every one of §24's seventeen inputs and eight
 * objective terms to the term, gate or pass that implements it, and the proof
 * suite asserts the mapping is total and that every weight it names is live.
 * The term DEFINITIONS live in `lib/mediaRankingSignals.ts`, one header each.
 *
 * ── §2 "AUTHENTIC MEDIA OUTRANKS GENERATED FALLBACK MEDIA" ───────────────────
 * Not a weight — a weight can be outvoted. After scoring and the diversity
 * pass, the ordering is stably PARTITIONED: every row whose displayed asset is
 * `synthetic` (generated / derivative / generatively altered) is placed after
 * every row that is not, whatever either scored. Provenance is read from
 * `canonical_media` only; a row without it is `unknown`, which is neither
 * promoted nor demoted.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaCandidateRow } from "../../lib/media/mediaProjection.js";
import {
  EMPTY_MEDIA_RANKING_SIGNALS,
  authorTrustTerm,
  availabilityTerm,
  buildRankingPage,
  contributionTerm,
  discoveryTerm,
  experienceFitTerm,
  followTerm,
  freshnessTerm,
  intentTerm,
  liveTerm,
  locationTerm,
  lowConfidenceLiveTerm,
  mediaQualityOf,
  narrativeTerm,
  placeRelevanceTerm,
  preferenceTerm,
  provenanceClassOf,
  provenanceTerm,
  socialTerm,
  tripContextTerm,
  usefulSocialTerm,
  utilityTerm,
  type MediaRankingPage,
  type MediaRankingSignals,
  type ProvenanceClass,
} from "../../lib/mediaRankingSignals.js";

export interface MediaRankingContext {
  viewerId?: string | null;
  viewerTripIds?: ReadonlySet<string>;
  /** Bulk-loaded private intent rows for this viewer over the page (legacy input; still honoured). */
  intentMediaIds?: ReadonlySet<string>;
  followedCreatorIds?: ReadonlySet<string>;
  /** Everything `loadMediaRankingSignals` read. Absent ⇒ every loaded term is neutral. */
  signals?: MediaRankingSignals;
  nowMs: number;
}

export interface MediaRankingScore {
  score: number;
  // §24 inputs
  intent: number;
  /** §24 Trip context. Kept under its original name. */
  tripAffinity: number;
  location: number;
  availability: number;
  preference: number;
  follow: number;
  discovery: number;
  live: number;
  freshness: number;
  placeRelevance: number;
  quality: number;
  /** §24 Trust / provenance — the ASSET's provenance class, scored. */
  provenance: number;
  /** §24 Trust / provenance — the AUTHOR's standing. */
  authorTrust: number;
  social: number;
  // §24 objectives
  utility: number;
  experienceFit: number;
  usefulSocial: number;
  contribution: number;
  narrative: number;
  // §24 penalty objective
  lowConfidenceLive: number;
  provenanceClass: ProvenanceClass;
}

/**
 * The weights. Positive terms sum to 1.0, so a score reads as a share of the
 * best possible perspective. No single term exceeds 0.12: §24 is a blend of
 * twenty-five things, and a ranker in which one of them dominates would be a
 * one-signal ranker with twenty-four decorations.
 */
export const MEDIA_RANKING_WEIGHTS = {
  intent: 0.12,
  tripAffinity: 0.08,
  location: 0.04,
  availability: 0.04,
  preference: 0.05,
  follow: 0.04,
  discovery: 0.04,
  live: 0.06,
  freshness: 0.07,
  placeRelevance: 0.03,
  quality: 0.08,
  provenance: 0.06,
  authorTrust: 0.03,
  social: 0.03,
  utility: 0.08,
  experienceFit: 0.05,
  usefulSocial: 0.04,
  contribution: 0.03,
  narrative: 0.03,
  /** Subtracted. */
  lowConfidenceLive: 0.08,
} as const;

export type MediaRankingWeightKey = keyof typeof MEDIA_RANKING_WEIGHTS;

/** Diversity pass — per-repeat penalties and their caps (§24 Diversity, − Repetition, Novelty). */
export const DIVERSITY_PENALTY = {
  place: { perRepeat: 0.06, cap: 0.18 },
  category: { perRepeat: 0.04, cap: 0.12 },
  author: { perRepeat: 0.05, cap: 0.15 },
} as const;

/**
 * Every §24 input and objective, and what implements it here. `weight:<key>`
 * is a scored term (its weight must be non-zero); `gate:` runs before ranking
 * and removes rather than reorders; `pass:` is the post-scoring diversity pass.
 */
export const SPEC_24_COVERAGE: ReadonlyArray<{ spec: string; kind: "input" | "objective"; by: string }> = [
  { spec: "Viewer intent", kind: "input", by: "weight:intent" },
  { spec: "Current location", kind: "input", by: "weight:location" },
  { spec: "Trip context", kind: "input", by: "weight:tripAffinity" },
  { spec: "Availability", kind: "input", by: "weight:availability" },
  { spec: "Travel preferences", kind: "input", by: "weight:preference" },
  { spec: "Follow graph", kind: "input", by: "weight:follow" },
  { spec: "Discovery behavior", kind: "input", by: "weight:discovery" },
  { spec: "Live state", kind: "input", by: "weight:live" },
  { spec: "Freshness", kind: "input", by: "weight:freshness" },
  { spec: "Place relevance", kind: "input", by: "weight:placeRelevance" },
  { spec: "Media quality", kind: "input", by: "weight:quality" },
  { spec: "Trust / provenance", kind: "input", by: "weight:provenance+weight:authorTrust" },
  { spec: "Social relevance", kind: "input", by: "weight:social" },
  { spec: "Novelty", kind: "input", by: "pass:diversity" },
  { spec: "Privacy", kind: "input", by: "gate:lib/mediaEligibility, lib/mediaLocationVisibility" },
  { spec: "Safety", kind: "input", by: "gate:lib/mediaEligibility moderation deny-list" },
  { spec: "Diversity", kind: "input", by: "pass:diversity" },
  { spec: "Expected Real-World Utility", kind: "objective", by: "weight:utility" },
  { spec: "Experience Fit", kind: "objective", by: "weight:experienceFit" },
  { spec: "Useful Social Connection", kind: "objective", by: "weight:usefulSocial" },
  { spec: "Contribution Value", kind: "objective", by: "weight:contribution" },
  { spec: "Narrative Value", kind: "objective", by: "weight:narrative" },
  { spec: "- Repetition", kind: "objective", by: "pass:diversity" },
  { spec: "- Staleness", kind: "objective", by: "weight:freshness" },
  { spec: "- Low-confidence Live Claims", kind: "objective", by: "weight:lowConfidenceLive" },
];

export function scoreMediaCandidate(
  row: MediaCandidateRow,
  context: MediaRankingContext,
  page: MediaRankingPage = buildRankingPage([row], context.nowMs),
): MediaRankingScore {
  const s = context.signals ?? EMPTY_MEDIA_RANKING_SIGNALS;
  const nowMs = context.nowMs;
  const followed = context.followedCreatorIds;
  const t: Omit<MediaRankingScore, "score" | "provenanceClass"> = {
    intent: intentTerm(row, s, context.intentMediaIds),
    tripAffinity: tripContextTerm(row, s, context.viewerTripIds, nowMs),
    location: locationTerm(row, s, nowMs),
    availability: availabilityTerm(row, s, nowMs),
    preference: preferenceTerm(row, s),
    follow: followTerm(row, s, followed),
    discovery: discoveryTerm(row, s),
    live: liveTerm(row, s),
    freshness: freshnessTerm(row, nowMs),
    placeRelevance: placeRelevanceTerm(row),
    quality: mediaQualityOf(row).score,
    provenance: provenanceTerm(row),
    authorTrust: authorTrustTerm(row),
    social: socialTerm(row, s, page, followed),
    utility: utilityTerm(row, s),
    experienceFit: experienceFitTerm(row, s, nowMs),
    usefulSocial: usefulSocialTerm(row, s, nowMs, followed),
    contribution: contributionTerm(row, s, page, nowMs),
    narrative: narrativeTerm(row, s),
    lowConfidenceLive: lowConfidenceLiveTerm(row, s),
  };
  let score = 0;
  for (const key of Object.keys(MEDIA_RANKING_WEIGHTS) as MediaRankingWeightKey[]) {
    const w = MEDIA_RANKING_WEIGHTS[key];
    score += key === "lowConfidenceLive" ? -w * t[key] : w * t[key];
  }
  return { score, ...t, provenanceClass: provenanceClassOf(row) };
}

/**
 * Score, diversify, then partition generated media last (§2). Stable: exact
 * ties keep input order.
 */
export function rankMediaCandidates(
  candidates: MediaCandidateRow[],
  context: MediaRankingContext, scoresOut?: Map<string, MediaRankingScore>,
): MediaCandidateRow[] {
  const page = buildRankingPage(candidates, context.nowMs);
  const scored = candidates.map((row, index) => ({ row, index, score: scoreMediaCandidate(row, context, page) })); for (const e of scored) scoresOut?.set(String(e.row.id), e.score);
  const remaining = [...scored];
  const output: typeof scored = [];
  const placeCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  const keyOf = (row: MediaCandidateRow) => ({
    place: String(row.canonical_place_id ?? row.location_name ?? ""),
    category: String(row.category ?? ""),
    author: String(row.author_id ?? ""),
  });

  while (remaining.length > 0) {
    let best = 0;
    let bestAdjusted = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const entry = remaining[i];
      const k = keyOf(entry.row);
      const adjusted =
        entry.score.score -
        Math.min(DIVERSITY_PENALTY.place.cap, (placeCounts.get(k.place) ?? 0) * DIVERSITY_PENALTY.place.perRepeat) -
        Math.min(DIVERSITY_PENALTY.category.cap, (categoryCounts.get(k.category) ?? 0) * DIVERSITY_PENALTY.category.perRepeat) -
        Math.min(DIVERSITY_PENALTY.author.cap, (authorCounts.get(k.author) ?? 0) * DIVERSITY_PENALTY.author.perRepeat);
      if (adjusted > bestAdjusted || (adjusted === bestAdjusted && entry.index < remaining[best].index)) {
        best = i;
        bestAdjusted = adjusted;
      }
    }
    const [chosen] = remaining.splice(best, 1);
    output.push(chosen);
    const k = keyOf(chosen.row);
    placeCounts.set(k.place, (placeCounts.get(k.place) ?? 0) + 1);
    categoryCounts.set(k.category, (categoryCounts.get(k.category) ?? 0) + 1);
    authorCounts.set(k.author, (authorCounts.get(k.author) ?? 0) + 1);
  }

  // §2: authentic (and unknown) before generated, whatever the scores said.
  const kept = output.filter((e) => e.score.provenanceClass !== "synthetic");
  const demoted = output.filter((e) => e.score.provenanceClass === "synthetic");
  return [...kept, ...demoted].map((e) => e.row);
}

/** The viewer fields the ranker reads. `ViewerResolved` satisfies it. */
export interface RankingViewer {
  viewerId: string;
  viewerCountry: string | null;
  followedCreatorIds: Set<string>;
  viewerTripIds: Set<string>;
  intentMediaIds?: Set<string>;
}

/**
 * The §42 Media Ranking stage as the World-shell builders call it: load the
 * page's §24 signals (fail-soft, every unreadable one neutral), then rank. The
 * loader is imported lazily because it reads helpers from
 * MediaProjectionService, which imports this module.
 */
export async function rankCandidatesForViewer(
  sc: SupabaseClient,
  viewer: RankingViewer,
  candidates: MediaCandidateRow[],
  context: MediaRankingContext, scoresOut?: Map<string, MediaRankingScore>,
): Promise<MediaCandidateRow[]> {
  if (candidates.length === 0) return candidates;
  let signals: MediaRankingSignals = EMPTY_MEDIA_RANKING_SIGNALS;
  try {
    const { loadMediaRankingSignals } = await import("../ranking/MediaRankingSignalLoader.js");
    signals = await loadMediaRankingSignals(sc, viewer, candidates, context.nowMs);
  } catch {
    // A ranking input, never an authorization one: losing it reorders a page,
    // it never widens one. Neutral signals, same membership.
  }
  return rankMediaCandidates(candidates, {
    ...context,
    followedCreatorIds: context.followedCreatorIds ?? viewer.followedCreatorIds,
    signals,
  }, scoresOut);
}

/*
 * ── `scoresOut`: the per-term values each row was ranked on (§47) ───────────
 * `rankMediaCandidates` and `rankCandidatesForViewer` take an optional
 * `scoresOut` map. When one is passed it receives, keyed by row id, the SAME
 * `MediaRankingScore` object the row was ordered by: the term values
 * `MEDIA_RANKING_WEIGHTS` multiplies, before the diversity pass and the §2
 * partition. `services/media/MediaExplanationService` explains a World item
 * from exactly these numbers, so an explanation cannot come from a second
 * computation that disagrees with the ranking (census-media §25). Passing it
 * changes neither the order nor the set.
 */
