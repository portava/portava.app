/**
 * CompassActiveUserRewardEngine — Phase 3 active-user visibility rewards.
 *
 * Computes an ActiveUserScore (separate from Trust Score) using time-windowed
 * sums of positive activity events. Applies a Trust Multiplier so safety flags
 * suppress rewards. Writes results to `compass_active_user_scores`.
 * Assigns tier and badge eligibility. Respects the user's
 * "boost_visibility_enabled" preference.
 *
 * Time windows:
 *   24h   — very recent activity (highest weight)
 *   7d    — this week
 *   30d   — this month
 *   90d   — this quarter
 *   lifetime — all-time signal
 *
 * ActiveVisibilityBoost formula (from spec):
 *   score = (w24 * s24 + w7 * s7 + w30 * s30 + w90 * s90 + wL * sL) * trustMultiplier
 *
 * Trust Multiplier:
 *   - severe_safety_flag present → 0.0 (zero boost)
 *   - trust_caps active → 0.5
 *   - trust_score < 30    → 0.6
 *   - trust_score < 50    → 0.8
 *   - otherwise           → 1.0
 *
 * Tiers:
 *   score < 15  → active_traveler
 *   score < 35  → local_guide
 *   score < 60  → city_connector
 *   score >= 60 → city_ambassador_candidate
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassProfile } from "./types.js";

// ── Window weights ────────────────────────────────────────────────────────────

const WINDOW_WEIGHTS = {
  w24:  3.0,
  w7:   2.0,
  w30:  1.0,
  w90:  0.5,
  wL:   0.2,
};

// ── Event weights ─────────────────────────────────────────────────────────────

const EVENT_WEIGHTS: Record<string, number> = {
  booking_completed:        3.0,
  event_attended:           2.5,
  buddy_session_completed:  3.5,
  trip_created:             1.5,
  review_posted:            2.0,
  post_published:           1.0,
  stamp_earned:             1.5,
  no_show:                 -5.0,  // penalty
  dispute_raised:          -4.0,  // penalty
  report_received:         -6.0,  // penalty
};

// ── Trust Multiplier thresholds ───────────────────────────────────────────────

const TRUST_MULTIPLIER_SEVERE = 0.0;
const TRUST_MULTIPLIER_CAPPED = 0.5;
const TRUST_MULTIPLIER_LOW    = 0.6;
const TRUST_MULTIPLIER_MID    = 0.8;
const TRUST_MULTIPLIER_FULL   = 1.0;

// ── Tier boundaries ───────────────────────────────────────────────────────────

const TIER_LOCAL_GUIDE  = 15;
const TIER_CITY_CONN    = 35;
const TIER_AMBASSADOR   = 60;

export type ActiveUserTier =
  | "active_traveler"
  | "local_guide"
  | "city_connector"
  | "city_ambassador_candidate";

export interface ActiveUserScoreResult {
  userId:           string;
  score24h:         number;
  score7d:          number;
  score30d:         number;
  score90d:         number;
  scoreLifetime:    number;
  activeUserScore:  number;
  trustMultiplier:  number;
  tier:             ActiveUserTier;
  boostEligible:    boolean;
  boostVisibilityEnabled: boolean;
  badgeEligibility: string[];
}

function nowMinus(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}

function scoreEvents(events: any[], windowStart: Date): number {
  let total = 0;
  for (const e of events) {
    const ts = new Date(e.created_at);
    if (ts >= windowStart) {
      const w = EVENT_WEIGHTS[e.event_type] ?? 0;
      total += w * (Number(e.weight) || 1);
    }
  }
  return Math.max(total, 0); // floor at 0 (negative windows not allowed)
}

function computeTrustMultiplier(
  trustScore: number | null,
  hasSevereSafetyFlag: boolean,
  hasTrustCap: boolean,
): number {
  if (hasSevereSafetyFlag) return TRUST_MULTIPLIER_SEVERE;
  if (hasTrustCap)          return TRUST_MULTIPLIER_CAPPED;
  if (trustScore === null)  return TRUST_MULTIPLIER_MID;
  if (trustScore < 30)      return TRUST_MULTIPLIER_LOW;
  if (trustScore < 50)      return TRUST_MULTIPLIER_MID;
  return TRUST_MULTIPLIER_FULL;
}

function computeTier(score: number): ActiveUserTier {
  if (score >= TIER_AMBASSADOR) return "city_ambassador_candidate";
  if (score >= TIER_CITY_CONN)  return "city_connector";
  if (score >= TIER_LOCAL_GUIDE) return "local_guide";
  return "active_traveler";
}

function computeBadgeEligibility(
  tier: ActiveUserTier,
  events: any[],
  score24h: number,
  trustMultiplier: number,
): string[] {
  const badges: string[] = [];
  if (trustMultiplier === 0) return badges; // no badges with severe safety flag

  if (tier === "city_ambassador_candidate") badges.push("city_ambassador_candidate");
  if (tier === "city_connector" || tier === "city_ambassador_candidate") {
    badges.push("social_connector");
  }

  const reviewCount = events.filter((e) => e.event_type === "review_posted").length;
  if (reviewCount >= 5) badges.push("trusted_guide");

  const noShowCount = events.filter((e) => e.event_type === "no_show").length;
  if (noShowCount === 0 && events.length >= 3) badges.push("safety_champion");

  if (score24h > 5) badges.push("consistent_explorer");

  return [...new Set(badges)];
}

/** Load active user events from DB for a given user. Never throws. */
async function loadEvents(
  db: SupabaseClient,
  userId: string,
): Promise<any[]> {
  try {
    const since = nowMinus(365).toISOString();
    const { data } = await db
      .from("compass_active_user_events")
      .select("event_type, weight, city, category, created_at")
      .eq("user_id", userId)
      .gt("created_at", since)
      .order("created_at", { ascending: false });
    return (data as any[]) ?? [];
  } catch {
    return [];
  }
}

/** Check if user has an active trust cap. Never throws. */
async function hasActiveTrustCap(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    const { data } = await db
      .from("trust_caps")
      .select("id")
      .eq("user_id", userId)
      .is("lifted_at", null)
      .or(`expires_at.is.null,expires_at.gt.${now}`)
      .limit(1);
    return ((data as any[]) ?? []).length > 0;
  } catch {
    return false;
  }
}

/** Load boost_visibility_enabled preference from profiles. Never throws. */
async function loadBoostPreference(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    const { data } = await db
      .from("profiles")
      .select("boost_visibility_enabled")
      .eq("id", userId)
      .maybeSingle();
    // Default to true when column absent or null
    return (data as any)?.boost_visibility_enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Compute the ActiveUserScore for a single user and write it to the DB.
 * Never throws. Returns null on unexpected error.
 */
export async function computeActiveUserScore(
  db: SupabaseClient,
  userId: string,
  profile: CompassProfile,
  options: {
    hasSevereSafetyFlag?: boolean;
  } = {},
): Promise<ActiveUserScoreResult | null> {
  try {
    const [events, trustCapActive, boostPref] = await Promise.all([
      loadEvents(db, userId),
      hasActiveTrustCap(db, userId),
      loadBoostPreference(db, userId),
    ]);

    const hasSevereSafetyFlag = options.hasSevereSafetyFlag ?? false;
    const trustMultiplier = computeTrustMultiplier(
      profile.trustScore,
      hasSevereSafetyFlag,
      trustCapActive,
    );

    const score24h     = scoreEvents(events, nowMinus(1));
    const score7d      = scoreEvents(events, nowMinus(7));
    const score30d     = scoreEvents(events, nowMinus(30));
    const score90d     = scoreEvents(events, nowMinus(90));
    const scoreLifetime = scoreEvents(events, new Date(0));

    const { w24, w7, w30, w90, wL } = WINDOW_WEIGHTS;
    const rawScore =
      w24 * score24h +
      w7  * score7d  +
      w30 * score30d +
      w90 * score90d +
      wL  * scoreLifetime;

    const activeUserScore = Math.round(rawScore * trustMultiplier * 100) / 100;
    const tier            = computeTier(activeUserScore);
    const boostEligible   = boostPref && activeUserScore >= TIER_LOCAL_GUIDE && trustMultiplier > 0;
    const badgeEligibility = computeBadgeEligibility(tier, events, score24h, trustMultiplier);

    const result: ActiveUserScoreResult = {
      userId,
      score24h,
      score7d,
      score30d,
      score90d,
      scoreLifetime,
      activeUserScore,
      trustMultiplier,
      tier,
      boostEligible,
      boostVisibilityEnabled: boostPref,
      badgeEligibility,
    };

    // Persist (fire-and-forget)
    db.from("compass_active_user_scores")
      .upsert(
        {
          user_id:               userId,
          score_24h:             score24h,
          score_7d:              score7d,
          score_30d:             score30d,
          score_90d:             score90d,
          score_lifetime:        scoreLifetime,
          active_user_score:     activeUserScore,
          trust_multiplier:      trustMultiplier,
          tier,
          boost_eligible:        boostEligible,
          boost_visibility_enabled: boostPref,
          last_computed_at:      new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .then(() => {}, () => {});

    // Badge eligibility upsert (fire-and-forget)
    for (const badge of badgeEligibility) {
      db.from("compass_active_user_badges")
        .upsert(
          {
            user_id:    userId,
            badge_type: badge,
            eligible:   true,
          },
          { onConflict: "user_id,badge_type" },
        )
        .then(() => {}, () => {});
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Compute a visibility boost delta for a pipeline item based on its author's
 * ActiveUserScore. Returns a score modifier in [0, MAX_BOOST].
 *
 * If boost_visibility_enabled is false for the author → returns 0.
 * If trustMultiplier is 0 (severe safety flag) → returns 0.
 */
const MAX_BOOST = 5.0;

export function computeItemVisibilityBoost(
  authorScore: ActiveUserScoreResult | null,
): number {
  if (!authorScore) return 0;
  if (!authorScore.boostVisibilityEnabled) return 0;
  if (authorScore.trustMultiplier === 0)   return 0;
  if (!authorScore.boostEligible)          return 0;
  // Normalise: city_ambassador_candidate gets full MAX_BOOST
  const tierMultiplier =
    authorScore.tier === "city_ambassador_candidate" ? 1.0 :
    authorScore.tier === "city_connector"            ? 0.7 :
    authorScore.tier === "local_guide"               ? 0.4 : 0.0;
  return Math.round(MAX_BOOST * tierMultiplier * authorScore.trustMultiplier * 100) / 100;
}

/**
 * Append an activity event for a user to `compass_active_user_events`.
 * Fire-and-forget — never throws.
 */
export function recordActivityEvent(
  db:        SupabaseClient | null,
  userId:    string,
  eventType: keyof typeof EVENT_WEIGHTS,
  meta:      { city?: string; category?: string; weight?: number } = {},
): void {
  if (!db) return;
  const weight = meta.weight ?? EVENT_WEIGHTS[eventType] ?? 1;
  if (Math.abs(weight) < 0.01) return; // unknown event type
  db.from("compass_active_user_events")
    .insert({
      user_id:    userId,
      event_type: eventType,
      weight:     Math.abs(weight), // always positive; sign is embedded in EVENT_WEIGHTS
      city:       meta.city ?? null,
      category:   meta.category ?? null,
    })
    .then(() => {}, () => {});
}
