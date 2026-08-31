/**
 * hiddenGemState — the semantic layer for Hidden Gems (Media v2 Phase 8, §16).
 *
 * PURE + DETERMINISTIC. Nothing in this module reads a database, a clock it did
 * not receive, an env var, or the network. Every function is a total function of
 * its arguments so it can be unit-tested exhaustively and replayed. The service
 * layer (HiddenGemContributionService) gathers the raw signals from Supabase and
 * hands them here; this module never gathers its own.
 *
 * Three things live here, and the spec's three hard rules with them:
 *
 *  1. deriveHiddenGemState — the §16 ten-state `HiddenGemState`. Derived at read
 *     time from EXISTING signals (status + verification + confirmation recency +
 *     crowd_level + structured contributions). It is NEVER a stored source of
 *     truth that can drift. A single structured contribution is an OBSERVATION,
 *     not a canonical flip (§16.3): every contribution-driven state requires
 *     CONTRIBUTION_FLIP_THRESHOLD independent observations before it changes the
 *     state, so no one report can move the gem.
 *
 *  2. deriveGemConfidence — a bounded 0..1 evidence score, reusing the intel
 *     confidence ladder (lib/confidenceScore). Confirmations, independence,
 *     freshness, verification and evidence raise it. **save_count and paid
 *     promotion never raise it** (§16.2 / §36): saveCount is accepted into the
 *     signal set and deliberately ignored, and a paid-promoted gem takes a
 *     commercial-risk PENALTY — promotion can only ever lower factual
 *     confidence, never lift it.
 *
 *  3. scoreGemForRanking — evidence / freshness / relevance ranking that is NOT
 *     popularity-first (§16.2). save_count and visit_count are not ranking
 *     inputs, and an overcrowded / fragile gem is DEMOTED so the system never
 *     aggressively recommends a small place that is being overloaded.
 */

import { scoreConfidence, type ConfidenceResult } from "./confidenceScore.js";

// ── The ten-state semantic enum (§16) ────────────────────────────────────────

export const HIDDEN_GEM_STATES = [
  "recently_confirmed",
  "still_hidden",
  "quiet_now",
  "getting_discovered",
  "seasonal",
  "hard_to_find",
  "access_changed",
  "temporarily_unavailable",
  "overcrowding_risk",
  "no_longer_hidden",
] as const;

export type HiddenGemState = (typeof HIDDEN_GEM_STATES)[number];

// ── The nine structured contribution types (§16.3) ───────────────────────────
// Each is an OBSERVATION recorded against a gem. It feeds confidence and state
// derivation; it is never on its own an immediate canonical state change.

export const GEM_CONTRIBUTION_TYPES = [
  "still_here",
  "still_worth_it",
  "access_changed",
  "closed",
  "too_crowded",
  "seasonal",
  "harder_to_reach",
  "better_entrance",
  "no_longer_hidden",
] as const;

export type GemContributionType = (typeof GEM_CONTRIBUTION_TYPES)[number];

/** Contributions that assert the gem is still good / still there (positive evidence). */
export const POSITIVE_CONTRIBUTIONS: ReadonlySet<GemContributionType> = new Set([
  "still_here",
  "still_worth_it",
]);

/** Contributions that assert the gem has degraded / gone (negative evidence). */
export const NEGATIVE_CONTRIBUTIONS: ReadonlySet<GemContributionType> = new Set([
  "closed",
  "no_longer_hidden",
  "access_changed",
]);

export function isGemContributionType(v: unknown): v is GemContributionType {
  return typeof v === "string" && (GEM_CONTRIBUTION_TYPES as readonly string[]).includes(v);
}

// ── Tunable, named thresholds (all in one place so a diff shows a policy change) ─

/**
 * How many INDEPENDENT observations of a contribution type are required before
 * it moves the derived state. This is the §16.3 guarantee in a single constant:
 * one contribution is an observation, not a canonical flip. Lowering this to 1
 * is exactly the mutation the test forbids.
 */
export const CONTRIBUTION_FLIP_THRESHOLD = 2;

/** A confirmation this many days old or fresher makes a gem "recently_confirmed". */
export const RECENTLY_CONFIRMED_DAYS = 30;

/** save/visit counts at/above which a gem has clearly "graduated" out of hidden. */
export const NO_LONGER_HIDDEN_SAVE_THRESHOLD = 250;
export const NO_LONGER_HIDDEN_VISIT_THRESHOLD = 100;

/** save count at/above which a gem is visibly "getting_discovered" (but not yet out). */
export const GETTING_DISCOVERED_SAVE_THRESHOLD = 60;

/** Confidence saturation points. */
export const PRESENCE_SATURATION = 5; // matches COMMUNITY_CONFIRMATIONS_NEEDED
export const INDEPENDENCE_SATURATION = 4;
export const FRESHNESS_HORIZON_DAYS = 365;

/** Paid promotion can only ever LOWER factual confidence, never raise it (§16.2/§36). */
export const PAID_PROMOTION_COMMERCIAL_RISK = 0.3;

// ── Crowd-level normalisation ────────────────────────────────────────────────
// Two crowd vocabularies exist in the wild: the live API zod enum
// (quiet|moderate|busy|very_busy, routes/hiddenGems.ts) and migration 2057's
// documented set (rarely_crowded|sometimes_crowded|often_crowded). Both are
// stored in the same free-text `crowd_level` column, so the deriver accepts
// either and normalises to one bucket. Anything else → "unknown".

export type CrowdBucket = "low" | "medium" | "high" | "very_high" | "unknown";

export function normalizeCrowdLevel(raw: string | null | undefined): CrowdBucket {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "quiet":
    case "rarely_crowded":
      return "low";
    case "moderate":
    case "sometimes_crowded":
      return "medium";
    case "busy":
    case "often_crowded":
      return "high";
    case "very_busy":
    case "very_crowded":
      return "very_high";
    default:
      return "unknown";
  }
}

/** High-crowd buckets that make a gem an overcrowding-suppression candidate. */
function isOvercrowded(bucket: CrowdBucket): boolean {
  return bucket === "high" || bucket === "very_high";
}

// ── State derivation ─────────────────────────────────────────────────────────

export interface GemStateSignals {
  /** Lifecycle status (pending|active|hidden|merged). */
  status?: string | null;
  /** Raw crowd_level column value (either vocabulary). */
  crowdLevel?: string | null;
  /** Days since the most recent approved confirmation/contribution, or null if never. */
  daysSinceLastConfirmation?: number | null;
  /** Count of approved confirmations (verify-visits + positive contributions). */
  confirmationCount?: number;
  /** save_count — used ONLY for the discovery-graduation states, never confidence. */
  saveCount?: number;
  /** visit_count — used ONLY for the discovery-graduation states, never confidence. */
  visitCount?: number;
  /** Independent-observation counts per structured contribution type. */
  contributionCounts?: Partial<Record<GemContributionType, number>>;
}

function contribCount(
  counts: Partial<Record<GemContributionType, number>> | undefined,
  type: GemContributionType,
): number {
  return Math.max(0, Math.floor(counts?.[type] ?? 0));
}

/**
 * Derive the current semantic state from existing signals. Deterministic and
 * total: the same signals always yield the same state, and every input is
 * optional (a brand-new gem with no signals derives cleanly to "still_hidden",
 * so an empty pre-launch corpus is handled gracefully — [[completeness-framing]]).
 *
 * Precedence (first match wins). Availability / protection states sit above
 * discovery states, which sit above ambient states, so the most decision-
 * relevant fact is what surfaces:
 *
 *   1  no_longer_hidden        — graduated out of hidden (discovery OR ≥threshold obs)
 *   2  overcrowding_risk       — high/very-high crowd, or ≥threshold "too_crowded"
 *   3  temporarily_unavailable — ≥threshold "closed" observations
 *   4  access_changed          — ≥threshold "access_changed" observations
 *   5  seasonal                — ≥threshold "seasonal" observations
 *   6  getting_discovered      — mid-band discovery pressure
 *   7  recently_confirmed      — a fresh confirmation
 *   8  quiet_now               — low crowd right now
 *   9  hard_to_find            — ≥threshold "harder_to_reach" observations
 *   10 still_hidden            — baseline
 */
export function deriveHiddenGemState(signals: GemStateSignals): HiddenGemState {
  const counts = signals.contributionCounts;
  const crowd = normalizeCrowdLevel(signals.crowdLevel);
  const saves = Math.max(0, Math.floor(signals.saveCount ?? 0));
  const visits = Math.max(0, Math.floor(signals.visitCount ?? 0));
  const confirmations = Math.max(0, Math.floor(signals.confirmationCount ?? 0));
  const days = signals.daysSinceLastConfirmation;

  const T = CONTRIBUTION_FLIP_THRESHOLD;

  // 1 — no_longer_hidden: heavy discovery pressure, or a corroborated set of
  //     "no_longer_hidden" observations. One such observation is NOT enough.
  const discoveredOut =
    saves >= NO_LONGER_HIDDEN_SAVE_THRESHOLD && visits >= NO_LONGER_HIDDEN_VISIT_THRESHOLD;
  if (discoveredOut || contribCount(counts, "no_longer_hidden") >= T) {
    return "no_longer_hidden";
  }

  // 2 — overcrowding_risk: the §16.2 suppression trigger. Either the captured
  //     crowd_level is high, or the community has corroborated "too_crowded".
  if (isOvercrowded(crowd) || contribCount(counts, "too_crowded") >= T) {
    return "overcrowding_risk";
  }

  // 3 — temporarily_unavailable: corroborated "closed" observations.
  if (contribCount(counts, "closed") >= T) {
    return "temporarily_unavailable";
  }

  // 4 — access_changed: corroborated "access_changed" observations.
  if (contribCount(counts, "access_changed") >= T) {
    return "access_changed";
  }

  // 5 — seasonal: corroborated "seasonal" observations.
  if (contribCount(counts, "seasonal") >= T) {
    return "seasonal";
  }

  // 6 — getting_discovered: mid-band discovery pressure (below the graduation
  //     line). This is a popularity-derived STATE, not a confidence input —
  //     surfacing "this is getting popular" never inflates factual confidence.
  if (saves >= GETTING_DISCOVERED_SAVE_THRESHOLD) {
    return "getting_discovered";
  }

  // 7 — recently_confirmed: a genuinely fresh confirmation.
  if (days != null && days <= RECENTLY_CONFIRMED_DAYS && confirmations >= 1) {
    return "recently_confirmed";
  }

  // 8 — quiet_now: low crowd right now.
  if (crowd === "low") {
    return "quiet_now";
  }

  // 9 — hard_to_find: corroborated "harder_to_reach" observations.
  if (contribCount(counts, "harder_to_reach") >= T) {
    return "hard_to_find";
  }

  // 10 — baseline.
  return "still_hidden";
}

// ── Confidence derivation ────────────────────────────────────────────────────

export interface GemConfidenceSignals {
  /** verification_level ladder (unverified|community|gps_verified|guide|admin). */
  verificationLevel?: string | null;
  /** Count of approved confirmations. */
  approvedConfirmations?: number;
  /** Number of DISTINCT users who have positively confirmed/contributed. */
  distinctConfirmers?: number;
  /** Days since the most recent approved confirmation, or null if never. */
  daysSinceLastConfirmation?: number | null;
  /** Fraction of visits flagged suspicious by anti-spoofing (0..1). */
  suspiciousVisitRatio?: number;
  /** Count of positive structured contributions (still_here / still_worth_it). */
  positiveContributions?: number;
  /** Count of negative structured contributions (closed / no_longer_hidden / access_changed). */
  negativeContributions?: number;
  hasCanonicalPlace?: boolean;
  hasCoords?: boolean;
  hasMedia?: boolean;
  /**
   * Whether the gem is paid-promoted. Present ONLY so its exclusion from the
   * positive evidence is explicit and testable — a paid gem can take a
   * commercial-risk penalty but can never gain positive confidence from money.
   */
  paidPromoted?: boolean;
  /**
   * save_count. Accepted into the signal set and DELIBERATELY IGNORED for
   * confidence (§16.2): popularity is not evidence a place is what it claims to
   * be. It exists here so "confidence does not move with saves" is a property a
   * test can pin, and so that wiring it in is a visible mutation.
   */
  saveCount?: number;
}

const VERIFICATION_RELIABILITY: Record<string, number> = {
  admin: 1.0,
  guide: 0.8,
  gps_verified: 0.6,
  community: 0.4,
  unverified: 0.0,
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Derive the numeric gem confidence, reusing the intel confidence formula
 * (lib/confidenceScore). Returns the full replayable ConfidenceResult so the
 * score can be reconstructed and audited — a number nobody can reconstruct is a
 * number nobody can correct.
 *
 * Confidence rises with confirmations, independent contributors, freshness,
 * verification level and evidence. It does NOT rise with save_count (ignored)
 * or paid promotion (a penalty, never a component).
 */
export function deriveGemConfidence(signals: GemConfidenceSignals): ConfidenceResult {
  const approved = Math.max(0, Math.floor(signals.approvedConfirmations ?? 0));
  const distinct = Math.max(0, Math.floor(signals.distinctConfirmers ?? 0));
  const days = signals.daysSinceLastConfirmation;
  const positive = Math.max(0, Math.floor(signals.positiveContributions ?? 0));
  const negative = Math.max(0, Math.floor(signals.negativeContributions ?? 0));
  const totalContribs = positive + negative;

  // presence — is the place actually there, per confirmations?
  const presence = clamp01(approved / PRESENCE_SATURATION);

  // freshness — decays from the last confirmation. Never confirmed → 0.
  let freshness = 0;
  if (days != null && Number.isFinite(days)) {
    freshness = clamp01(1 - Math.max(0, days) / FRESHNESS_HORIZON_DAYS);
  }

  // independence — distinct corroborating people (NOT distinct saves).
  const independence = clamp01(distinct / INDEPENDENCE_SATURATION);

  // sourceReliability — the verification ladder.
  const sourceReliability =
    VERIFICATION_RELIABILITY[(signals.verificationLevel ?? "unverified").toLowerCase()] ?? 0;

  // evidenceQuality — media + coordinate + canonical-place backing.
  const evidenceQuality = clamp01(
    (signals.hasMedia ? 0.5 : 0) +
      (signals.hasCoords ? 0.3 : 0) +
      (signals.hasCanonicalPlace ? 0.2 : 0),
  );

  // agreement — share of contributions that are positive. No contributions → 0.
  const agreement = totalContribs > 0 ? clamp01(positive / totalContribs) : 0;

  // specificity — is the gem pinned to a specific canonical place / coords?
  const specificity = signals.hasCanonicalPlace && signals.hasCoords
    ? 1
    : signals.hasCanonicalPlace || signals.hasCoords
      ? 0.5
      : 0;

  // Penalties.
  const manipulationRisk = clamp01(signals.suspiciousVisitRatio ?? 0);
  // Conflicting evidence (both positive and negative present) is instability.
  const instability = totalContribs > 0 && positive > 0 && negative > 0
    ? clamp01(negative / totalContribs)
    : 0;
  // A corroborated "closed"/"no_longer_hidden" set standing against positive
  // evidence is a material conflict.
  const materialConflict =
    negative >= CONTRIBUTION_FLIP_THRESHOLD && positive >= CONTRIBUTION_FLIP_THRESHOLD ? 0.5 : 0;
  // Paid promotion → commercial risk. NEVER a positive component.
  const commercialRisk = signals.paidPromoted ? PAID_PROMOTION_COMMERCIAL_RISK : 0;

  return scoreConfidence(
    { presence, freshness, independence, sourceReliability, evidenceQuality, agreement, specificity },
    { manipulationRisk, instability, materialConflict, commercialRisk },
  );
}

// ── Ranking (NOT popularity-first, §16.2) ────────────────────────────────────

export interface GemRankingInput {
  verification_level?: string | null;
  crowd_level?: string | null;
  updated_at?: string | null;
  vibe_tags?: string[] | null;
  // Coordinates already resolved by the caller (or raw, for proximity).
  latitude?: number | null;
  longitude?: number | null;
  approx_latitude?: number | null;
  approx_longitude?: number | null;
  // save_count / visit_count are intentionally NOT read by the ranker.
  [k: string]: unknown;
}

export interface RankingOptions {
  vibeTags?: string[];
  userLat?: number;
  userLng?: number;
  /** Injected for determinism/testability. Defaults to Date.now(). */
  nowMs?: number;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Score a gem for discovery ranking. Evidence + freshness + relevance, with an
 * overcrowding DEMOTION. Popularity (save_count / visit_count) is deliberately
 * absent: a fragile place with many saves must not out-rank a well-evidenced,
 * fresh, uncrowded one. Pure and deterministic given `opts.nowMs`.
 */
export function scoreGemForRanking(
  gem: GemRankingInput,
  opts: RankingOptions = {},
): { score: number; distanceKm: number | null } {
  // Evidence weight — the verification ladder is the primary signal.
  const evidence = (VERIFICATION_RELIABILITY[(gem.verification_level ?? "unverified").toLowerCase()] ?? 0) * 5;

  // Freshness — a recently-touched gem ranks a little higher. 0..2, decaying to
  // 0 over FRESHNESS_HORIZON_DAYS.
  let freshnessBonus = 0;
  const ts = gem.updated_at ? Date.parse(gem.updated_at) : NaN;
  if (Number.isFinite(ts)) {
    const now = opts.nowMs ?? Date.now();
    const days = Math.max(0, (now - ts) / 86_400_000);
    freshnessBonus = 2 * clamp01(1 - days / FRESHNESS_HORIZON_DAYS);
  }

  // Relevance — vibe-tag overlap (max +3).
  const wanted = opts.vibeTags ?? [];
  const gemTags = (gem.vibe_tags ?? []) as string[];
  const vibeBonus = Math.min(gemTags.filter((t) => wanted.includes(t)).length, 3);

  // Proximity — closer is better, 0..2, decaying to 0 at 50 km.
  let proximityBonus = 0;
  let distanceKm: number | null = null;
  if (opts.userLat != null && opts.userLng != null) {
    const lat = gem.latitude ?? gem.approx_latitude;
    const lng = gem.longitude ?? gem.approx_longitude;
    if (lat != null && lng != null) {
      distanceKm = haversineKm(opts.userLat, opts.userLng, lat as number, lng as number);
      proximityBonus = Math.max(0, 2 * (1 - distanceKm / 50));
    }
  }

  // Overcrowding demotion — the §16.2 anti-goal is aggressively recommending a
  // small place that is being overloaded. A busy gem is pushed down; a very
  // busy one is pushed down hard, enough to fall below any uncrowded peer.
  const crowd = normalizeCrowdLevel(gem.crowd_level);
  const overcrowdingPenalty = crowd === "very_high" ? 6 : crowd === "high" ? 3 : 0;

  const score = evidence + freshnessBonus + vibeBonus + proximityBonus - overcrowdingPenalty;
  return { score, distanceKm };
}

/**
 * Rank a set of gems by scoreGemForRanking, descending. Stable for equal
 * scores (preserves input order). Membership and filtering are the caller's
 * job — this only orders.
 */
export function rankGems<T extends GemRankingInput>(
  gems: T[],
  opts: RankingOptions = {},
): Array<{ gem: T; score: number; distanceKm: number | null }> {
  return gems
    .map((gem, i) => {
      const { score, distanceKm } = scoreGemForRanking(gem, opts);
      return { gem, score, distanceKm, _i: i };
    })
    .sort((a, b) => (b.score - a.score) || (a._i - b._i))
    .map(({ gem, score, distanceKm }) => ({ gem, score, distanceKm }));
}
