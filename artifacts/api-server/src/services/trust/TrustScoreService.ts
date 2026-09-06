/**
 * TrustScoreService
 *
 * Recalculates all nine category scores plus the weighted overall score.
 * Applies:
 *   - Exponential time decay (recent events weighted more)
 *   - Active cap ceilings from trust_caps
 * Derives public trust level and persists to trust_profiles.
 *
 * Triggered after new events are applied or caps change.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrustCategory } from "./TrustEventService.js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "TrustScoreService" });

/**
 * A trust INPUT could not be read. Deliberately distinct from "the input is
 * empty", because the two used to be the same observation and the difference
 * decides whether a number may be written at all.
 *
 * ── WHY THIS IS AN EXCEPTION AND NOT A FLAG ─────────────────────────────────
 * `recalculateTrustScore` does not merely return a score, it PERSISTS one to
 * `trust_profiles` — the row that every display surface reads (getDisplayTrustScore,
 * lib/trustScore.computeTrustScore, TrustPrivacyGuard) and that
 * PassportProjectionService maps through LEVEL_RANK into capability grants. A
 * returned `degraded: true` would have been invisible: every production call site
 * discards the return value (`.catch(() => {})` in TrustAdminService and
 * routes/trust-admin.ts, `.then(() => {})` in the settings fan-out, and the
 * scheduler ignores it too). An exception is the only signal those call sites
 * already act on — the maintenance scheduler counts it as `recalcFailures` and
 * logs it, which is exactly the accounting this condition needs.
 *
 * The rule it enforces: WHEN AN INPUT CANNOT BE READ, WRITE NOTHING. A stale row
 * is a known-old measurement; a row computed from inputs that failed to load is
 * a fabricated one wearing a fresh `last_recalculated_at`.
 */
export class TrustInputUnavailableError extends Error {
  /** Which input failed — 'settings' | 'events' | 'caps'. */
  readonly input: TrustScoreInput;
  constructor(input: TrustScoreInput, detail: string) {
    super(`trust ${input} unavailable — refusing to persist a score: ${detail}`);
    this.name = "TrustInputUnavailableError";
    this.input = input;
  }
}

export type TrustScoreInput = "settings" | "events" | "caps";

/** Message text out of a PostgREST error object, for the exception detail. */
function describeDbError(error: any): string {
  return String(error?.message ?? error?.code ?? "db_error");
}

export type PublicTrustLevel =
  | "new_traveler"
  | "building_trust"
  | "reliable_traveler"
  | "trusted_traveler"
  | "highly_trusted"
  | "city_trusted";

const ALL_CATEGORIES: TrustCategory[] = [
  "plan_attendance","host_quality","communication","respect_safety",
  "location_honesty","content_quality","community_value",
  "guide_accuracy","passport_authenticity",
];

interface Settings {
  weight_plan_attendance:  number;
  weight_host_quality:     number;
  weight_communication:    number;
  weight_respect_safety:   number;
  weight_location_honesty: number;
  weight_content_quality:  number;
  weight_community_value:  number;
  weight_guide_accuracy:   number;
  weight_passport_auth:    number;
  decay_half_life_days:    number;
  level_building_trust:    number;
  level_reliable:          number;
  level_trusted:           number;
  level_highly_trusted:    number;
  level_city_trusted:      number;
}

const DEFAULT_SETTINGS: Settings = {
  weight_plan_attendance:  0.180,
  weight_host_quality:     0.120,
  weight_communication:    0.100,
  weight_respect_safety:   0.150,
  weight_location_honesty: 0.130,
  weight_content_quality:  0.080,
  weight_community_value:  0.080,
  weight_guide_accuracy:   0.080,
  weight_passport_auth:    0.080,
  decay_half_life_days:    90,
  level_building_trust:    35,
  level_reliable:          50,
  level_trusted:           65,
  level_highly_trusted:    78,
  level_city_trusted:      90,
};

async function loadSettings(db: SupabaseClient): Promise<Settings> {
  {
    const { data, error } = await db.from("trust_settings").select("*").eq("id", 1).maybeSingle();
    if (error) {
      // NOT "use defaults". The weights and the six level thresholds are what
      // turn nine category numbers into `overall_score` and `public_level`, and
      // `public_level` is a capability grant. Silently swapping an admin's
      // configured thresholds for the built-in ones and then WRITING the result
      // publishes a score computed under rules nobody chose. Absence of a row is
      // still legitimately "defaults" (see below) — a failed READ is not.
      logger.warn({ err: error }, "loadSettings failed — refusing to score");
      throw new TrustInputUnavailableError("settings", describeDbError(error));
    }
    // A missing row IS a legitimate "use the defaults": trust_settings is a
    // singleton whose columns all carry the same defaults this object holds.
    if (!data) return DEFAULT_SETTINGS;
    const d = data as any;
    // Fall back to the default ONLY when the stored value is null/absent/NaN —
    // NOT when it is a legitimate 0. `Number(x) || dflt` silently replaced an
    // admin-set 0 (e.g. a disabled weight) with the built-in default.
    const num = (v: unknown, dflt: number): number => {
      if (v === null || v === undefined) return dflt;
      const n = Number(v);
      return Number.isFinite(n) ? n : dflt;
    };
    return {
      weight_plan_attendance:  num(d.weight_plan_attendance,  0.180),
      weight_host_quality:     num(d.weight_host_quality,     0.120),
      weight_communication:    num(d.weight_communication,    0.100),
      weight_respect_safety:   num(d.weight_respect_safety,   0.150),
      weight_location_honesty: num(d.weight_location_honesty, 0.130),
      weight_content_quality:  num(d.weight_content_quality,  0.080),
      weight_community_value:  num(d.weight_community_value,  0.080),
      weight_guide_accuracy:   num(d.weight_guide_accuracy,   0.080),
      weight_passport_auth:    num(d.weight_passport_auth,    0.080),
      decay_half_life_days:    num(d.decay_half_life_days,    90),
      level_building_trust:    num(d.level_building_trust,    35),
      level_reliable:          num(d.level_reliable,          50),
      level_trusted:           num(d.level_trusted,           65),
      level_highly_trusted:    num(d.level_highly_trusted,    78),
      level_city_trusted:      num(d.level_city_trusted,      90),
    };
  }
}

/** Exponential decay weight for an event: w = 2^(-age_days / half_life) */
function decayWeight(createdAt: string, halfLifeDays: number): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(2, -ageDays / halfLifeDays);
}

/** Load applied+confirmed events for a user from the last year */
async function loadEvents(db: SupabaseClient, userId: string): Promise<any[]> {
  const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("trust_events")
    .select("category, delta, severity, status, created_at")
    .eq("user_id", userId)
    .in("status", ["applied", "confirmed"])
    .gt("created_at", since);
  if (error) {
    // THE MOST DANGEROUS OF THE THREE. Returning [] here did not produce "no
    // score" — it produced a CONFIDENT one. computeCategoryScore returns the
    // neutral 50 for a category with no events, the caller loops over the fixed
    // nine ALL_CATEGORIES, and the nine weights sum to exactly 1.000, so an empty
    // event list scores exactly 50.00 and `scoreToLevel` promotes it to
    // `reliable_traveler` (level_reliable is 50, compared with >=).
    //
    // That number was then UPSERTED over whatever was already there. So one
    // transient trust_events read failure rewrote a real, earned profile —
    // a city_trusted 92 or a capped 35 alike — to a fabricated 50/reliable, with
    // a fresh `last_recalculated_at` asserting it had just been measured. The
    // maintenance scheduler runs this every 6 hours over every dirty and stale
    // user, so a table-wide read failure would have flattened the whole
    // population to 50 and, via PassportProjectionService's LEVEL_RANK mapping,
    // handed canHostTrip / canUseCrewLocation / canContributeLiveIntel to every
    // account that had previously been below reliable.
    //
    // A user who genuinely has no events is a DIFFERENT case and is still
    // handled downstream — it reaches the caller as an empty array, not as this.
    logger.warn({ err: error, userId }, "loadEvents failed — refusing to score");
    throw new TrustInputUnavailableError("events", describeDbError(error));
  }
  return (data as any[]) ?? [];
}

/** Load active caps for a user */
async function loadCaps(
  db: SupabaseClient,
  userId: string,
): Promise<Record<string, number>> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("trust_caps")
    .select("category, ceiling_score")
    .eq("user_id", userId)
    .is("lifted_at", null)
    .or(`expires_at.is.null,expires_at.gt.${now}`);
  if (error) {
    // Caps are the ONLY thing that makes a serious finding survive a good
    // record: the ceiling clamps a category from above no matter how much
    // positive history surrounds it (see computeCategoryScore's note). Treating
    // an unreadable trust_caps as "no caps" therefore did not just lose
    // information — it computed the UNCLAMPED score and persisted it, laundering
    // a `fake_gps_confirmed` ceiling of 35 or a permanent `behavior_confirmed`
    // ceiling of 40 out of the profile, and re-granting the capabilities the
    // ceiling existed to withhold. Failing the whole recalculation is the only
    // safe direction: a stale capped row beats a fresh uncapped one.
    logger.warn({ err: error, userId }, "loadCaps failed — refusing to score");
    throw new TrustInputUnavailableError("caps", describeDbError(error));
  }
  const caps: Record<string, number> = {};
  for (const row of (data as any[]) ?? []) {
    const cur = caps[row.category];
    caps[row.category] = cur !== undefined ? Math.min(cur, row.ceiling_score) : row.ceiling_score;
  }
  return caps;
}

/** Compute score for one category from events, applying decay */
/**
 * Decay-weighted evidence required before a category earns FULL positive credit.
 *
 * Expressed in decayed-event-weight, not raw event count, so evidence erodes on
 * the same half-life as the score itself: trust has to be maintained, not banked
 * once and left. At the 90-day default half-life, five events today count as 5.0,
 * but the same five events count ~2.5 after 90 days and ~1.25 after 180.
 */
const EARN_CONFIDENCE_WEIGHT = 5;

/**
 * Category score, centred on a neutral 50.
 *
 * The mean (not the sum) of decayed deltas is used, so volume alone cannot
 * inflate a score — a thousand small positives land in the same place as one.
 *
 * Positive and negative movement are DELIBERATELY ASYMMETRIC:
 *
 *   - Positive movement is scaled by a confidence ramp, so a single good event
 *     no longer maxes a category. Previously one HOST_POSITIVE_REVIEW (delta +6)
 *     produced 50 + 6*5 = 80 — "trusted" off one review, on a brand-new account.
 *     Now that same lone event yields 50 + 30*(1/5) = 56, and reaching the full
 *     80 takes a sustained record rather than a single data point.
 *   - Negative movement applies at FULL strength immediately, with no ramp.
 *     One confirmed serious violation must bite on the first occurrence; making
 *     a user "earn" their way into a penalty would be perverse.
 *
 * That asymmetry is the whole point: slow to earn, immediate to lose. It is also
 * why the ramp must never be applied to the negative branch — doing so would
 * silently protect first-time offenders.
 *
 * Severity is not read here. It governs routing and ceilings, not the delta:
 * serious/severe events additionally impose a trust_caps ceiling (see
 * TrustCapService.applyEventCaps), which clamps the category from above no
 * matter how much positive history surrounds it. The ceiling — not the delta —
 * is what makes a severe finding survive an otherwise glowing record.
 */
function computeCategoryScore(
  events: any[],
  category: string,
  halfLifeDays: number,
): number {
  const relevant = events.filter((e) => e.category === category);
  if (relevant.length === 0) return 50; // neutral default

  let weightedSum = 0;
  let totalWeight = 0;
  for (const e of relevant) {
    const w = decayWeight(e.created_at, halfLifeDays);
    weightedSum += Number(e.delta ?? 0) * w;
    totalWeight += w;
  }

  // Centre on 50 then apply weighted change. Scale: 1 delta point ≈ 5 score points.
  const delta = totalWeight > 0 ? weightedSum / totalWeight : 0;
  let movement = delta * 5;

  if (movement > 0) {
    const confidence = Math.min(1, totalWeight / EARN_CONFIDENCE_WEIGHT);
    movement *= confidence;
  }

  return Math.min(100, Math.max(0, 50 + movement));
}

function scoreToLevel(score: number, s: Settings): PublicTrustLevel {
  if (score >= s.level_city_trusted)   return "city_trusted";
  if (score >= s.level_highly_trusted) return "highly_trusted";
  if (score >= s.level_trusted)        return "trusted_traveler";
  if (score >= s.level_reliable)       return "reliable_traveler";
  if (score >= s.level_building_trust) return "building_trust";
  return "new_traveler";
}

export interface TrustScoreResult {
  userId: string;
  overall_score: number;
  public_level: PublicTrustLevel;
  categories: Record<TrustCategory, number>;
  capsApplied: string[];
}

/** Recalculate all scores for a user and persist to trust_profiles */
export async function recalculateTrustScore(
  db: SupabaseClient,
  userId: string,
): Promise<TrustScoreResult> {
  const [settings, events, caps] = await Promise.all([
    loadSettings(db),
    loadEvents(db, userId),
    loadCaps(db, userId),
  ]);

  const halfLife = settings.decay_half_life_days;
  const categories: Record<string, number> = {};
  const capsApplied: string[] = [];

  for (const cat of ALL_CATEGORIES) {
    let score = computeCategoryScore(events, cat, halfLife);
    // Apply cap ceiling
    if (caps[cat] !== undefined && score > caps[cat]) {
      score = caps[cat];
      capsApplied.push(cat);
    }
    categories[cat] = Math.round(score * 100) / 100;
  }

  // Weighted overall score
  const overall = Math.round(
    (categories.plan_attendance  * settings.weight_plan_attendance +
     categories.host_quality     * settings.weight_host_quality +
     categories.communication    * settings.weight_communication +
     categories.respect_safety   * settings.weight_respect_safety +
     categories.location_honesty * settings.weight_location_honesty +
     categories.content_quality  * settings.weight_content_quality +
     categories.community_value  * settings.weight_community_value +
     categories.guide_accuracy   * settings.weight_guide_accuracy +
     categories.passport_authenticity * settings.weight_passport_auth) * 100
  ) / 100;

  const public_level = scoreToLevel(overall, settings);

  // Persist (non-fatal — return computed result even if persist fails)
  {
    const { error: upsertError } = await db.from("trust_profiles").upsert({
      user_id:               userId,
      overall_score:         overall,
      plan_attendance:       categories.plan_attendance,
      host_quality:          categories.host_quality,
      communication:         categories.communication,
      respect_safety:        categories.respect_safety,
      location_honesty:      categories.location_honesty,
      content_quality:       categories.content_quality,
      community_value:       categories.community_value,
      guide_accuracy:        categories.guide_accuracy,
      passport_authenticity: categories.passport_authenticity,
      public_level,
      last_recalculated_at:  new Date().toISOString(),
      updated_at:            new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (upsertError) logger.warn({ err: upsertError, userId }, "trust_profiles persist failed (non-fatal)");
  }

  return {
    userId,
    overall_score: overall,
    public_level,
    categories: categories as Record<TrustCategory, number>,
    capsApplied,
  };
}

/**
 * THE canonical display Trust number (0–100), rounded, or null when the user has
 * no persisted trust profile yet.
 *
 * This is the single source every Passport surface must read so the owner Home
 * identity card, TrustScreen and the Rent-a-Buddy card can never disagree: it
 * returns exactly `trust_profiles.overall_score` — the weighted, decay-aware,
 * cap-clamped number recalculateTrustScore persists — rounded to an integer for
 * display. It performs NO recalculation and NO write (safe on a GET path); a
 * user with no row yet reads `null` (rendered as the non-stigmatizing "New
 * Traveler" label, never a fabricated number).
 */
export async function getDisplayTrustScore(
  db: SupabaseClient,
  userId: string,
): Promise<number | null> {
  const profile = await getTrustProfile(db, userId);
  if (!profile || profile.overall_score === null || profile.overall_score === undefined) return null;
  const n = Number(profile.overall_score);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Load current trust profile without recalculating */
export async function getTrustProfile(
  db: SupabaseClient,
  userId: string,
): Promise<TrustScoreResult | null> {
  try {
    const { data } = await db
      .from("trust_profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return null;
    const d = data as any;
    return {
      userId,
      overall_score: d.overall_score,
      public_level:  d.public_level,
      capsApplied:   [],
      categories: {
        plan_attendance:       d.plan_attendance,
        host_quality:          d.host_quality,
        communication:         d.communication,
        respect_safety:        d.respect_safety,
        location_honesty:      d.location_honesty,
        content_quality:       d.content_quality,
        community_value:       d.community_value,
        guide_accuracy:        d.guide_accuracy,
        passport_authenticity: d.passport_authenticity,
      },
    };
  } catch {
    return null;
  }
}
