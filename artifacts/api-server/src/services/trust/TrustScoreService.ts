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
 *
 * FAIL-CLOSED ON READ: if trust_settings, trust_events or trust_caps cannot be
 * read, `recalculateTrustScore` THROWS and writes nothing. Every caller already
 * treats a rejection as "this recalculation did not happen" (the scheduler
 * counts it in recalcFailures; the admin paths `.catch(() => {})`). The
 * alternative — score against empty inputs — persists a neutral, uncapped,
 * "measured and empty" profile over a real one.
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
  /**
   * The message keeps the `trust_<input> read failed` wording the three throw
   * sites already used, because that is what callers and tests read it by. The
   * CLASS is the addition: `input` says which read failed without parsing prose,
   * and `instanceof` lets a caller separate "could not read" from any other
   * throw. Anything catching a plain Error is unaffected.
   */
  constructor(input: TrustScoreInput, detail: string, userId?: string) {
    super(
      `recalculateTrustScore: trust_${input} read failed` +
      (userId ? ` for ${userId}` : "") +
      ` — ${detail} (refusing to persist a score)`,
    );
    this.name = "TrustInputUnavailableError";
    this.input = input;
  }
}

export type TrustScoreInput = "settings" | "events" | "caps";

/** Message text out of a PostgREST error object, for the exception detail. */
function describeDbError(error: any): string {
  return String(error?.message ?? error?.code ?? "db_error");
}

/**
 * The public trust levels, as a RUNTIME vocabulary.
 *
 * The union used to exist only in the type system, so nothing could ask at
 * runtime "is this string one of the six?" — and `publicTrustLabel` answers an
 * unrecognised level with the "New Traveler" default rather than complaining.
 * That combination means a writer persisting a level outside this list degrades
 * every reader's label silently. Exported so a test can assert the writer's
 * output against the declared set instead of against `typeof x === "string"`,
 * which is the assertion that let the question go unasked.
 */
export const PUBLIC_TRUST_LEVELS = [
  "new_traveler",
  "building_trust",
  "reliable_traveler",
  "trusted_traveler",
  "highly_trusted",
  "city_trusted",
] as const;

export type PublicTrustLevel = (typeof PUBLIC_TRUST_LEVELS)[number];

/** Narrow an arbitrary persisted value to a declared public trust level. */
export function isPublicTrustLevel(value: unknown): value is PublicTrustLevel {
  return typeof value === "string" && (PUBLIC_TRUST_LEVELS as readonly string[]).includes(value);
}

export const ALL_CATEGORIES: TrustCategory[] = [
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
      // A failed read is NOT "use the defaults". The defaults are what the
      // engine ships with; the row is what an admin has set. The weights and
      // the six level thresholds are what turn nine category numbers into
      // `overall_score` and `public_level`, and `public_level` is a capability
      // grant — so scoring against the wrong weights and persisting the result
      // publishes a score computed under rules nobody chose, silently. The
      // recalculation aborts and the existing profile stands.
      logger.warn({ err: error }, "loadSettings failed — refusing to score");
      throw new TrustInputUnavailableError("settings", describeDbError(error));
    }
    // A missing row IS a legitimate "use the defaults" (the seed migration not
    // yet run): trust_settings is a singleton whose columns all carry the same
    // defaults this object holds, so there is nothing to disagree with.
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
    // Since migration 2371 it is worse still: the fabricated row also records
    // evidence_count = 0, which means MEASURED AND EMPTY — the read failure is
    // stamped as a measurement.
    //
    // A user who genuinely has no events is a DIFFERENT case and is still
    // handled downstream — it reaches the caller as an empty array, not as this.
    // The recalculation aborts; the previous profile stays as it was, and the
    // scheduler counts the failure and retries next pass.
    logger.warn({ err: error, userId }, "loadEvents failed — refusing to score");
    throw new TrustInputUnavailableError("events", describeDbError(error), userId);
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
    // Abort instead; the capped profile stands.
    logger.warn({ err: error, userId }, "loadCaps failed — refusing to score");
    throw new TrustInputUnavailableError("caps", describeDbError(error), userId);
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
  /**
   * False when the user had NO qualifying trust events, in which case nothing was
   * persisted and the numbers above are arithmetic only — never a measurement.
   * See the persist block for why an unscored user must have no row at all.
   */
  persisted: boolean;
  /**
   * How much evidence stands behind the scores (Passport §9 "Trust Confidence",
   * §10 "an 82 with high evidence is not equivalent to an 82 with little").
   *
   *   evidenceWeight — decay-weighted count of the applied/confirmed events in
   *                    the 365-day scoring window: the same quantity, decay and
   *                    window the category scores are built from.
   *   evidenceCount  — the undecayed count of those events.
   *
   * `null` means NOT YET MEASURED — a profile written before migration 2371 or
   * by a build that predates it — and must not be read as zero. `0` means
   * measured and empty: every score on the row is the neutral 50 with nothing
   * behind it. Banding into words is the presenting surface's decision.
   */
  evidenceWeight?: number | null;
  evidenceCount?: number | null;
}

/**
 * Total decayed weight and raw count of the events a recalculation scored.
 * Exported for tests; the numbers are persisted by recalculateTrustScore.
 */
export function measureEvidence(events: readonly any[], halfLifeDays: number): { weight: number; count: number } {
  let weight = 0;
  for (const e of events) weight += decayWeight(e.created_at, halfLifeDays);
  return { weight: Math.round(weight * 1000) / 1000, count: events.length };
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
  const evidence = measureEvidence(events, halfLife);

  // ── NO EVIDENCE IS NOT NEUTRAL EARNED TRUST ────────────────────────────────
  //
  // computeCategoryScore returns 50 for a category with no events, the loop above
  // walks the fixed nine ALL_CATEGORIES rather than the categories actually
  // present, and the nine weights sum to exactly 1.000 — so a user with zero
  // events scores exactly 50.00. `level_reliable` is 50 and scoreToLevel compares
  // with >=, so that user is promoted to `reliable_traveler`, rung 3 of 6.
  //
  // That is not a cosmetic badge. PassportProjectionService maps public_level
  // through LEVEL_RANK into capability grants, so persisting this row hands
  // canHostTrip, canUseCrewLocation and canContributeLiveIntel to a user who has
  // done nothing. On the first enable of `trust_engine_enabled` — against a
  // trust_events table that is empty because the ingest lane was off — that would
  // be every user in the system at once.
  //
  // The canonical way to say "no earned trust" already exists and is honoured
  // everywhere else: ABSENCE OF A ROW. getDisplayTrustScore returns null for a
  // user with no profile (documented at its own definition), lib/trustScore
  // types the score as `number | null` explicitly "rather than a fabricated
  // number", TrustPrivacyGuard falls back to the `new_traveler` label, and the
  // client already branches on that via hasScore. Writing a fabricated row is
  // what DESTROYS that representation.
  //
  // So: compute, but do not persist. The result is returned with
  // persisted:false so a caller can tell arithmetic from measurement.
  //
  // KNOWN LIMIT, deliberately not papered over: a user who HAS a row and whose
  // events have since been removed keeps their last evidence-derived row. It is
  // stale, but it is not fabricated, and clearing it would need a decision about
  // whether an erased-evidence user should read null or a floor. Recorded as a
  // contract gap rather than guessed at. The related per-category gap is the
  // same shape: trust_profiles' nine category columns and overall_score are all
  // `numeric(5,2) NOT NULL DEFAULT 50.00`, so there is no way to persist "this
  // one category is unscored" — a user with evidence in one category still
  // carries eight fabricated 50s into the weighted overall.
  // SCOPE: only a user who has NEVER been scored. A user who already HAS a row
  // and whose events have since decayed out is refreshed as before — that case
  // is deliberately pinned by trustAsymmetryAndMaintenance.test.ts ("refreshes a
  // stale profile even with no new events"), and it is a different problem: a
  // stale 60 really is wrong, and leaving it would be its own defect. Narrowing
  // here fixes the dangerous case — every user at once on first enable — without
  // silently reversing a decision someone already made and tested.
  //
  // A TRUST_CAPS ROW IS ALSO EVIDENCE, and is excluded from the skip. A cap is
  // deliberate recorded state about this specific user — a moderation ceiling
  // or an admin's ruling — not the untouched population this block exists to
  // protect, and a ceiling can only ever pull a score DOWN (trust_caps has no
  // floor column), so keeping a capped user's row promotes nobody. It matters
  // because `main` made the admin cap lane read its result back off
  // trust_profiles and throw when the read is not `ok`
  // (TrustAdminService.adminOverrideScore and confirmOverrideRemoved), so that
  // an override can never be reported or audited as applied without being
  // observed. Skipping the persist for a capped user would turn every such
  // override — and every lift of one — into a hard failure: a different defect,
  // not this one's fix. LIFTED caps count too: the lift path recalculates after
  // the ceiling is gone, and the user is still one an admin has deliberately
  // touched.
  if (events.length === 0) {
    const { data: existing, error: existingError } = await db
      .from("trust_profiles")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (existingError) {
      // Same rule as the trust_caps read below, and the same rule main's
      // loaders now follow: supabase-js RESOLVES on a DB error, so an unread
      // `error` here makes an unreachable table look like "this user has never
      // been scored". That answer decides to write nothing AND reports
      // `persisted: false` to callers that discard the result, so the outage
      // would be invisible — every recalculation silently a no-op. A throw is
      // the signal the call sites already act on: every production caller
      // discards the return value, and the maintenance scheduler counts a throw
      // as `recalcFailures`. A `degraded` field would be read by none of them.
      throw new Error(
        `recalculateTrustScore: trust_profiles existence read failed for ${userId} — ${(existingError as any).message ?? (existingError as any).code ?? "db_error"}`,
      );
    }
    const { data: capRows, error: capRowsError } = await db
      .from("trust_caps")
      .select("id")
      .eq("user_id", userId)
      .limit(1);
    if (capRowsError) {
      // Same rule as loadCaps: "no caps" on a failed read is a guess, and here
      // it would decide to write nothing at all. Refuse instead.
      throw new Error(
        `recalculateTrustScore: trust_caps history read failed for ${userId} — ${(capRowsError as any).message ?? (capRowsError as any).code ?? "db_error"}`,
      );
    }
    const everCapped = ((capRows as any[]) ?? []).length > 0;
    if (!existing && !everCapped) {
      return {
        userId,
        overall_score: overall,
        public_level,
        categories: categories as Record<TrustCategory, number>,
        capsApplied,
        persisted: false,
        evidenceWeight: evidence.weight,
        evidenceCount: evidence.count,
      };
    }
  }

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
    else {
      // The evidence columns are written in a SEPARATE statement on purpose.
      // Migration 2371 adds them; a database that has not applied it (production
      // at the time of writing) rejects a statement that names them (PGRST204)
      // — and PostgREST rejects the WHOLE statement. Folding them into the
      // upsert above would therefore stop every score persist on such a
      // database, silently, exactly as lib/mediaAssets did for three weeks
      // (see migration 2336's header). Here only the evidence write is lost,
      // it is logged with the migration number, and the score still lands.
      const { error: evidenceError } = await db
        .from("trust_profiles")
        .update({ evidence_weight: evidence.weight, evidence_count: evidence.count })
        .eq("user_id", userId);
      if (evidenceError) {
        logger.warn(
          { err: evidenceError, userId },
          "trust_profiles evidence persist failed (non-fatal) — is migration 2371_trust_profiles_evidence applied?",
        );
      }
    }
  }

  return {
    userId,
    overall_score: overall,
    public_level,
    categories: categories as Record<TrustCategory, number>,
    capsApplied,
    persisted: true,
    evidenceWeight: evidence.weight,
    evidenceCount: evidence.count,
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
 * display. It performs NO recalculation and NO write (safe on a GET path).
 *
 * `null` MEANS TWO THINGS AND THE DOCBLOCK USED TO NAME ONLY ONE. It said "a
 * user with no row yet reads null (rendered as the non-stigmatizing 'New
 * Traveler' label, never a fabricated number)". An UNREADABLE `trust_profiles`
 * also reads `null`, and "New Traveler" is then a fabricated fact about a person
 * — exactly the number the sentence promised never to invent, wearing a label
 * instead of a digit.
 *
 * The return type stays `number | null` because both callers
 * (`lib/trustScore.computeTrustScore` and
 * `PassportProjectionService.buildTrustSummary`) ALREADY establish the third
 * state for themselves — one through `getTrustProfileResult`, the other through
 * `SafeTrustSummary.profileUnavailable` — and widen it into a `degraded` flag on
 * their own responses. Widening this signature would churn both for a state they
 * already hold. What was genuinely missing is that an outage passed through here
 * SILENTLY: nothing logged, so a null from a broken database looked exactly like
 * a null from a new account in the logs as well as in the type.
 *
 * A caller that does NOT separately establish the state must use
 * `getTrustProfileResult` directly. There is a test pinning that both current
 * callers do.
 */
export async function getDisplayTrustScore(
  db: SupabaseClient,
  userId: string,
): Promise<number | null> {
  const read = await getTrustProfileResult(db, userId);
  if (read.state === "unavailable") {
    logger.warn(
      { userId, reason: read.reason },
      "getDisplayTrustScore: trust_profiles unreadable — returning null, which a caller that has not " +
        "established the state for itself will render as 'New Traveler'",
    );
    return null;
  }
  if (read.state !== "ok") return null;
  const profile = read.profile;
  if (profile.overall_score === null || profile.overall_score === undefined) return null;
  const n = Number(profile.overall_score);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * The BATCH display read — many users, one query, three states.
 *
 * ── WHY THE SERVICE HAD TO GROW THIS ─────────────────────────────────────────
 *
 * `TrustScoreService:353-364` names `getDisplayTrustScore` "the single source
 * every Passport surface must read", and census-trust A17 records eleven direct
 * `trust_profiles` / `trust_caps` reads outside `services/trust` that ignore it.
 * Three of those eleven are LIST paths — an events host list, the buddy
 * marketplace, the pulse feed — and they read the table directly for a reason
 * the rule did not answer: the canonical helper is per-user, so obeying it on a
 * fifty-row feed meant fifty round trips. There was no honest way to comply.
 *
 * So the seam is widened rather than the rule waived, exactly as
 * `listRestrictionsForAudit` did for the restriction table.
 *
 * ── AND IT REFUSES, BECAUSE ALL THREE CALLERS FAILED OPEN ────────────────────
 *
 * Every one of those three wrote `const { data: trustRows } = await …` with the
 * error unbound. supabase-js RESOLVES on a database failure, so an unreadable
 * `trust_profiles` produced an empty result — "nobody has any trust" — and two
 * of the three then substituted the neutral 50 for every missing user, which is
 * census-passport P45's defect ("every user is described as an Established
 * member") reproduced three more times. A map that cannot be built is reported
 * as unavailable; a map that is genuinely empty is reported as an empty map.
 */
export type DisplayTrustScoresRead =
  | { state: "ok"; scores: Map<string, number> }
  | { state: "unavailable"; reason: string };

export async function getDisplayTrustScores(
  db: SupabaseClient,
  userIds: readonly string[],
): Promise<DisplayTrustScoresRead> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return { state: "ok", scores: new Map() };

  const { data, error } = await db
    .from("trust_profiles")
    .select("user_id, overall_score")
    .in("user_id", ids);

  if (error) {
    logger.warn(
      { err: error, count: ids.length },
      "getDisplayTrustScores: trust_profiles unreadable — reporting unavailable rather than an empty score map",
    );
    return { state: "unavailable", reason: String((error as any).message ?? (error as any).code ?? "db_error") };
  }

  const scores = new Map<string, number>();
  for (const r of ((data as Array<{ user_id: string; overall_score: unknown }>) ?? [])) {
    // A row whose score is null or unparseable is NOT a zero and NOT a 50: it is
    // a user with no usable score, and it stays absent from the map so the caller
    // makes that decision explicitly.
    //
    // The null check is separate and comes FIRST because `Number(null)` is 0 and
    // `Number.isFinite(0)` is true — so the obvious one-liner turns a null score
    // into a hard zero, which is a fabricated measurement of the worst kind: the
    // lowest one available. Caught by src/test/trustSeamOwnership.test.ts on the
    // seam's first run, in the seam written to stop exactly this.
    const raw = r.overall_score;
    if (raw === null || raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) scores.set(r.user_id, Math.round(n));
  }
  return { state: "ok", scores };
}

/**
 * The THREE-state read of `trust_profiles`: the profile was READ, the user has
 * no profile yet, or the row could not be read AT ALL.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `lib/http.ts` and `services/ranking/CreatorActivityScoreService.ts` both cite
 * `TrustProfileRead` / `getTrustProfileResult` HERE as the canonical union for
 * exactly this distinction ("ok | absent | unavailable, with the failure
 * carrying its own reason") and copy it. It did not exist. `getTrustProfile`
 * was a TWO-state read: supabase-js RESOLVES on a database error, `.error` was
 * never bound, and `if (!data) return null` collapsed an unreadable row onto
 * the same `null` a brand-new account produces. Every consumer then applied the
 * new-account default, so an unreadable `trust_profiles` displayed a Highly
 * Trusted traveller as "New Traveler" — a downgrade shown to their peers as
 * fact, built out of a database hiccup, with nothing logged.
 *
 * `getTrustProfile` keeps its `| null` signature (both non-ok states collapse to
 * null) so callers that cannot express the difference are unchanged; callers
 * that CAN read this instead.
 */
export type TrustProfileRead =
  | { state: "ok"; profile: TrustScoreResult }
  | { state: "absent" }
  | { state: "unavailable"; reason: string };

export async function getTrustProfileResult(
  db: SupabaseClient,
  userId: string,
): Promise<TrustProfileRead> {
  const { data, error } = await db
    .from("trust_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    const reason = String((error as any).message ?? (error as any).code ?? "db_error");
    logger.warn({ err: error, userId }, "trust_profiles unreadable — not a new account");
    return { state: "unavailable", reason };
  }
  if (!data) return { state: "absent" };
  return { state: "ok", profile: shapeProfile(userId, data) };
}

/** Load current trust profile without recalculating. `null` for absent OR unreadable. */
export async function getTrustProfile(
  db: SupabaseClient,
  userId: string,
): Promise<TrustScoreResult | null> {
  const read = await getTrustProfileResult(db, userId);
  return read.state === "ok" ? read.profile : null;
}

function shapeProfile(userId: string, data: unknown): TrustScoreResult {
  {
    const d = data as any;
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      userId,
      overall_score: d.overall_score,
      public_level:  d.public_level,
      capsApplied:   [],
      // A row exists, so by definition this IS persisted state.
      persisted:     true,
      // NULL (pre-2371 row, or a database without the columns) stays null:
      // "not measured" is a different answer from "measured, nothing there".
      evidenceWeight: num(d.evidence_weight),
      evidenceCount:  num(d.evidence_count),
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
  }
}
