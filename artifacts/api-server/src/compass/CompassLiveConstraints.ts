/**
 * CompassLiveConstraints — IG-07: live intelligence as HARD CONSTRAINTS that run
 * BEFORE ranking, an arrival forecast, grounded "Why this" lines, and Plan B.
 *
 * Spec anchors: §1 "Hard feasibility, safety, privacy, accessibility, budget and
 * consent constraints run before ranking"; §1 "Every recommendation answers: Why
 * this? Why now? Can I trust it? What can I do next?"; Table 2 "Compass/Journey
 * Decision — constraints, arrival forecast, ranking, explanation and Plan B";
 * AT-14 "Hard accessibility constraint — ranking cannot override it".
 *
 * WHAT THIS CONSUMES, AND THROUGH WHICH SEAM. Intel reaches Compass ONLY through
 * lib/liveClaimRead's client-facing envelope (`readLiveClaimEnvelopes`), which is
 * fail-closed end to end: flag chain, kill switch, per-scope promotion, freshness,
 * privacy eligibility and the truth boundary (mayRenderAsLive) are all applied
 * there, and it returns [] whenever anything is off. This module never reads a
 * snapshot, claim or observation row itself, and it never sees a contributor id —
 * the envelope carries derived intelligence only.
 *
 * THE TRUTH BOUNDARY, RESTATED FOR RANKING. An envelope is a HARD FACT for
 * ranking only when its evidence qualifies as Live: `state === 'live'`, band
 * live/strong, an observation class (mayRenderAsLive) and unexpired at `now`.
 * That set — and nothing weaker — may exclude or demote a candidate. An
 * 'emerging' envelope (cleared the serve floor, not yet live-qualified) may
 * nudge the score by EMERGING_SOFT_PENALTY at most; it can never exclude.
 * 'typical'/'unknown' are given NO influence here (a pattern is not a current
 * state). Predictions and historical patterns are dropped by the read path, and
 * re-checked here so a hostile or test-built envelope cannot slip through.
 *
 * WHY THE CONSTRAINT STAGE SITS BEFORE SCORING. runPipeline used to be
 * Safety → Eligibility → Privacy → Scoring. The live stage is inserted after
 * Eligibility and before Privacy/Scoring, so an excluded candidate is never
 * scored (scoreItem writes a compass_recommendation_scores audit row — an
 * excluded item must not leave one) and no score can lift it back in. AT-14 is
 * a property of ORDER, not of weights.
 *
 * GATE. Two independent gates, both default OFF:
 *   • COMPASS_LIVE_CONSTRAINTS_ENABLED — an env-guarded constant (this unit has
 *     no migration lane, so no feature_flags row is seeded; an env var that is
 *     absent or anything but "true" keeps the stage inert and the pipeline
 *     byte-for-byte as before).
 *   • the IG Live-label gates inside the read seam (`liveLabelsServable`) — with
 *     Live off there are no envelopes and therefore no constraints.
 *
 * ARRIVAL FORECAST is a Portava PREDICTION (Table 8: portava_prediction may
 * support "arrival forecast and trajectory", never an observed fact) and is
 * labelled as such in every line it produces. Its horizon is the EARLIER of the
 * envelope's validUntil and observedAt + the claim type's TTL from
 * lib/freshnessPolicy (migration 2128 rows) — never the later.
 *
 * RUNTIME EFFECT of this module on its own: NONE — pure functions plus one
 * async stage builder that the pipeline calls only when the gate is on.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONFIDENCE_BAND_FLOOR,
  MIN_BAND_FOR_LIVE_STATE,
  SOURCE_CLASS_LABELS,
  mayRenderAsLive,
  type ConfidenceBand,
  type SourceClass,
} from "../lib/intelContracts.js";
import {
  liveLabelsServable,
  readLiveClaimEnvelopes,
  type LiveClaimEnvelope,
  type SourceCountBucket,
} from "../lib/liveClaimRead.js";
import { getPolicy } from "../lib/freshnessPolicy.js";
import { logger } from "../lib/logger.js";
import type { CompassItem, CompassProfile } from "./types.js";
import type { RankingFactor } from "./CompassRecommendationEngine.js";

// ── Gate ─────────────────────────────────────────────────────────────────────

/** Env-guarded constant (no migration lane ⇒ no feature_flags row). Default OFF. */
export const COMPASS_LIVE_CONSTRAINTS_ENV = "COMPASS_LIVE_CONSTRAINTS_ENABLED";

/** True only when the env var is literally "true" (case-insensitive). Anything else is OFF. */
export function liveConstraintsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[COMPASS_LIVE_CONSTRAINTS_ENV] ?? "").trim().toLowerCase() === "true";
}

// ── Tunables (documented weights — see header) ───────────────────────────────

/** Walking-speed ETA estimate when the item carries only a distance. */
export const WALKING_SPEED_KMH = 5;
/** Viewer queue tolerance when the profile carries no explicit one. */
export const DEFAULT_QUEUE_TOLERANCE_MINUTES = 30;
/** finalScore penalty (0–100 scale) per distinct Live demotion reason. */
export const LIVE_DEMOTE_PENALTY = 15;
/** Maximum distinct Live demotion reasons that stack. */
export const LIVE_DEMOTE_MAX_REASONS = 2;
/** finalScore nudge per 'emerging' (below-Live) influence. Never excludes. */
export const EMERGING_SOFT_PENALTY = 2;
/** Maximum 'emerging' influences that stack. */
export const EMERGING_SOFT_MAX = 2;
/** Distinct subjects read per pipeline call (each read is a gated seam call). */
export const LIVE_INTEL_MAX_SUBJECTS = 40;
/** Parallel seam reads. */
export const LIVE_INTEL_CONCURRENCY = 8;
/** Plan B entries surfaced per pipeline call. */
export const PLAN_B_MAX = 5;
/** Travel-style tokens that express a 'quiet' intent. */
export const QUIET_INTENT_STYLE_TOKENS: readonly string[] = [
  "quiet", "calm", "relaxed", "chill", "peaceful", "slow", "mellow",
];
/** Crowd levels that conflict with a 'quiet' intent. */
export const PACKED_CROWD_LEVELS: readonly string[] = ["packed", "unsafe_density"];

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * `closed_now` is a JOURNEY-ONLY code and is listed here for ONE reason: so a
 * §36 Phase-6 recovery entry can be a real {@link LiveConstraintDecision} and
 * go through {@link computePlanB} rather than growing a parallel Plan B beside
 * it. `constraintReasonFor` below NEVER produces it, so the Compass pipeline's
 * behaviour is byte-for-byte unchanged by its presence: nothing in this file
 * reads a `closure.state` claim, and adding the code does not make it do so.
 * Its only producer is lib/journeyRecovery, which applies the same
 * {@link isLiveConstraintEligible} truth boundary before emitting one.
 */
export type LiveConstraintReasonCode =
  | "walk_in_denied"
  | "queue_exceeds_tolerance"
  | "packed_vs_quiet_intent"
  | "closed_now";

export type LiveConstraintKind = "exclude" | "demote";

/**
 * Derived-only provenance carried on every decision, influence and forecast.
 * `claimRef` is the SNAPSHOT id (the provenance pointer the "why" surface uses);
 * it is never a contributor id, and it is never interpolated into text.
 */
export interface LiveIntelRef {
  claimRef: string;
  claimType: string;
  sourceClass: SourceClass;
  /** SOURCE_CLASS_LABELS[sourceClass] — the user-facing label. */
  sourceLabel: string;
  band: ConfidenceBand;
  sourceCountBucket: SourceCountBucket | null;
  observedAt: string;
  validUntil: string;
}

export interface LiveConstraintDecision extends LiveIntelRef {
  kind: LiveConstraintKind;
  reasonCode: LiveConstraintReasonCode;
  /** Human-readable reason — derived intelligence only, no identity. */
  reason: string;
  /** finalScore penalty for a demotion; 0 for an exclusion (never scored). */
  penalty: number;
}

export interface SoftLiveInfluence extends LiveIntelRef {
  reasonCode: LiveConstraintReasonCode;
  state: "emerging";
  penalty: number;
}

export type ArrivalForecastLabel = "likely_still" | "may_have_changed";

export interface ArrivalForecast extends LiveIntelRef {
  label: ArrivalForecastLabel;
  /** Labelled as a Portava prediction — never phrased as an observation. */
  text: string;
  etaMinutes: number;
  arrivalAt: string;
  /** min(validUntil, observedAt + TTL) — the earlier horizon. */
  horizonAt: string;
}

export interface ViewerLiveTolerances {
  maxQueueWaitMinutes: number;
  intent: "quiet" | null;
}

export interface LiveConstraintEvaluation {
  exclusion: LiveConstraintDecision | null;
  demotions: LiveConstraintDecision[];
  soft: SoftLiveInfluence[];
  /** Total finalScore penalty (demotions + soft). 0 when excluded. */
  penalty: number;
}

export interface LiveIntelAnnotation {
  /** The strongest decision: the exclusion, else the first demotion, else null. */
  constraint: LiveConstraintDecision | null;
  demotions: LiveConstraintDecision[];
  soft: SoftLiveInfluence[];
  forecasts: ArrivalForecast[];
  /** Grounded ranking factors — what buildWhyThisText renders. */
  factors: RankingFactor[];
  /** "Why this" lines, one per cited claim (+ caveats). */
  lines: string[];
  penalty: number;
}

export interface PlanBEntry {
  forItemId: string;
  forItemType: string;
  category: string;
  reasonCode: LiveConstraintReasonCode;
  reason: string;
  claimRef: string;
  alternativeItemId: string;
  /** Index of the alternative in the ranked results. */
  alternativeRank: number;
}

// ── Value readers (tolerant; unknown shapes ⇒ null, never a guess) ───────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** access.walk_in → accepted? Capture writes `{ accepted: boolean }` (lib/quickSignal). */
export function walkInAccepted(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (isObj(value)) {
    if (typeof value.accepted === "boolean") return value.accepted;
    // Spec vocabulary (Table 6): accepted, limited, paused, denied, unknown.
    const state = typeof value.state === "string" ? value.state : typeof value.status === "string" ? value.status : null;
    if (state === "accepted" || state === "limited") return true;
    if (state === "denied" || state === "paused") return false;
  }
  return null;
}

/** queue.wait → minutes. Capture writes `{ minMinutes, maxMinutes|null }`. */
export function queueWaitMinutes(value: unknown): { min: number; max: number | null } | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return { min: value, max: value };
  if (!isObj(value)) return null;
  const min =
    typeof value.minMinutes === "number" ? value.minMinutes :
    typeof value.min === "number" ? value.min : null;
  if (min === null || !Number.isFinite(min) || min < 0) return null;
  const rawMax =
    typeof value.maxMinutes === "number" ? value.maxMinutes :
    typeof value.max === "number" ? value.max : null;
  const max = rawMax !== null && Number.isFinite(rawMax) && rawMax >= min ? rawMax : null;
  return { min, max };
}

/** crowd.level → level string. Capture writes `{ level }`. */
export function crowdLevelOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isObj(value) && typeof value.level === "string") return value.level;
  return null;
}

// ── Eligibility (the truth boundary, applied to ranking) ─────────────────────

function unexpiredAt(env: LiveClaimEnvelope, nowMs: number): boolean {
  const until = Date.parse(env.validUntil);
  return Number.isFinite(until) && until > nowMs;
}

/**
 * May this envelope act as a HARD FACT for ranking? Every clause is re-checked
 * here even though the read seam already enforces them — a test-built or
 * future-producer envelope must not be trusted on its `state` alone.
 */
export function isLiveConstraintEligible(env: LiveClaimEnvelope, nowMs: number): boolean {
  if (!env || typeof env !== "object") return false;
  if (env.state !== "live") return false;
  if (!(env.band === "live" || env.band === "strong")) return false;
  if (!mayRenderAsLive(env.sourceClass)) return false;
  return unexpiredAt(env, nowMs);
}

/**
 * May this envelope SOFTLY influence ranking? 'emerging' only: cleared the serve
 * floor, an observation class, unexpired. Never a constraint.
 */
export function isEmergingInfluenceEligible(env: LiveClaimEnvelope, nowMs: number): boolean {
  if (!env || typeof env !== "object") return false;
  if (env.state !== "emerging") return false;
  const floor = CONFIDENCE_BAND_FLOOR[env.band];
  if (typeof floor !== "number" || floor < CONFIDENCE_BAND_FLOOR[MIN_BAND_FOR_LIVE_STATE]) return false;
  if (!mayRenderAsLive(env.sourceClass)) return false;
  return unexpiredAt(env, nowMs);
}

// ── Description (the lib/mapProjection describeClaim pattern) ────────────────

/** SOURCE_CLASS_LABELS lookup that refuses to invent a label for an unknown class. */
export function sourceLabelOf(sourceClass: SourceClass): string {
  return Object.prototype.hasOwnProperty.call(SOURCE_CLASS_LABELS, sourceClass)
    ? SOURCE_CLASS_LABELS[sourceClass]
    : "Source not attributed";
}

/**
 * "<source-class label> · <cohort bucket>" — the cohort phrase is withheld when
 * the bucket is null (one party talking about itself is not a crowd).
 */
export function describeLiveIntelSource(
  env: Pick<LiveClaimEnvelope, "sourceClass" | "sourceCountBucket">,
): string {
  const label = sourceLabelOf(env.sourceClass);
  if (env.sourceCountBucket === null || env.sourceCountBucket === undefined) return label;
  const cohort =
    env.sourceCountBucket === "many" ? "many recent traveler reports" :
    env.sourceCountBucket === "several" ? "several recent traveler reports" :
    "a few recent traveler reports";
  return `${label} · ${cohort}`;
}

function waitPhrase(w: { min: number; max: number | null }): string {
  if (w.max === 0 && w.min === 0) return "no line";
  if (w.max === null) return `${Math.round(w.min)}+ min line`;
  if (w.max === w.min) return `${Math.round(w.min)} min line`;
  return `${Math.round(w.min)}–${Math.round(w.max)} min line`;
}

/** The claim's VALUE as a short phrase. Unknown shapes describe the type only. */
export function describeLiveClaimValue(env: Pick<LiveClaimEnvelope, "claimType" | "value">): string {
  switch (env.claimType) {
    case "access.walk_in": {
      const a = walkInAccepted(env.value);
      return a === true ? "walk-ins accepted" : a === false ? "walk-ins not accepted" : "walk-in status reported";
    }
    case "queue.wait": {
      const w = queueWaitMinutes(env.value);
      return w ? waitPhrase(w) : "line reported";
    }
    case "crowd.level": {
      const l = crowdLevelOf(env.value);
      return l ? `${l.replace(/_/g, " ")} right now` : "crowd level reported";
    }
    case "crowd.trajectory": {
      const t = isObj(env.value) && typeof env.value.trajectory === "string" ? env.value.trajectory : null;
      return t ? `crowd ${t.replace(/_/g, " ")}` : "crowd trend reported";
    }
    default:
      return `${env.claimType} reported`;
  }
}

function refOf(env: LiveClaimEnvelope): LiveIntelRef {
  return {
    claimRef: env.id,
    claimType: env.claimType,
    sourceClass: env.sourceClass,
    sourceLabel: sourceLabelOf(env.sourceClass),
    band: env.band,
    sourceCountBucket: env.sourceCountBucket ?? null,
    observedAt: env.observedAt,
    validUntil: env.validUntil,
  };
}

// ── Viewer tolerances ────────────────────────────────────────────────────────

/**
 * Derive the viewer's live tolerances from the profile. 'quiet' intent is read
 * from travel-style tokens (QUIET_INTENT_STYLE_TOKENS); queue tolerance is the
 * documented default. Callers with an explicit tolerance pass it through the
 * pipeline override instead.
 */
export function deriveViewerLiveTolerances(profile: Pick<CompassProfile, "travelStyles">): ViewerLiveTolerances {
  const styles = (profile.travelStyles ?? []).map((s) => String(s).toLowerCase());
  const quiet = styles.some((s) => QUIET_INTENT_STYLE_TOKENS.includes(s));
  return { maxQueueWaitMinutes: DEFAULT_QUEUE_TOLERANCE_MINUTES, intent: quiet ? "quiet" : null };
}

// ── Constraint evaluation (pure) ─────────────────────────────────────────────

/**
 * The one constraint rule table, applied to one envelope. Returns the reason
 * that fires, or null. Used for both hard (live) and soft (emerging) passes so
 * the two can never disagree about WHAT is a constraint — only about how much
 * it may do.
 */
function constraintReasonFor(
  env: LiveClaimEnvelope,
  tol: ViewerLiveTolerances,
): { code: LiveConstraintReasonCode; kind: LiveConstraintKind; reason: string } | null {
  switch (env.claimType) {
    case "access.walk_in": {
      if (walkInAccepted(env.value) === false) {
        return { code: "walk_in_denied", kind: "exclude", reason: "Walk-ins are not being accepted right now" };
      }
      return null;
    }
    case "queue.wait": {
      const w = queueWaitMinutes(env.value);
      if (!w) return null;
      // The wait the viewer MIGHT face: the upper bound when reported, else the
      // lower. Demotion is soft (never an exclusion), so erring toward demoting
      // is the viewer-protective direction.
      const expected = w.max ?? w.min;
      if (expected > tol.maxQueueWaitMinutes) {
        return {
          code: "queue_exceeds_tolerance",
          kind: "demote",
          reason: `${waitPhrase(w)} reported — above your ${tol.maxQueueWaitMinutes}-minute limit`,
        };
      }
      return null;
    }
    case "crowd.level": {
      const level = crowdLevelOf(env.value);
      if (level && PACKED_CROWD_LEVELS.includes(level) && tol.intent === "quiet") {
        return {
          code: "packed_vs_quiet_intent",
          kind: "demote",
          reason: `Reported ${level.replace(/_/g, " ")} right now — you asked for somewhere quiet`,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Evaluate one subject's envelopes against the viewer's tolerances.
 *
 *   Live (hard):   access.walk_in=false → EXCLUDE; queue above tolerance →
 *                  DEMOTE; crowd packed vs quiet intent → DEMOTE.
 *   Emerging:      same rules, but only as a SoftLiveInfluence worth
 *                  EMERGING_SOFT_PENALTY — never an exclusion.
 *   Anything else: no influence.
 *
 * Envelopes arrive in the read seam's best/current-first order, so the first
 * demotion is the strongest one. Pure and deterministic.
 */
export function evaluateLiveConstraints(
  envelopes: readonly LiveClaimEnvelope[],
  tolerances: ViewerLiveTolerances,
  nowMs: number,
): LiveConstraintEvaluation {
  let exclusion: LiveConstraintDecision | null = null;
  const demotions: LiveConstraintDecision[] = [];
  const soft: SoftLiveInfluence[] = [];
  const seenDemote = new Set<LiveConstraintReasonCode>();
  const seenSoft = new Set<LiveConstraintReasonCode>();

  for (const env of envelopes ?? []) {
    if (isLiveConstraintEligible(env, nowMs)) {
      const hit = constraintReasonFor(env, tolerances);
      if (!hit) continue;
      if (hit.kind === "exclude") {
        if (!exclusion) exclusion = { ...refOf(env), kind: "exclude", reasonCode: hit.code, reason: hit.reason, penalty: 0 };
      } else if (!seenDemote.has(hit.code)) {
        seenDemote.add(hit.code);
        demotions.push({ ...refOf(env), kind: "demote", reasonCode: hit.code, reason: hit.reason, penalty: LIVE_DEMOTE_PENALTY });
      }
      continue;
    }
    if (isEmergingInfluenceEligible(env, nowMs)) {
      const hit = constraintReasonFor(env, tolerances);
      if (!hit || seenSoft.has(hit.code)) continue;
      seenSoft.add(hit.code);
      // An emerging walk-in denial is a NUDGE, not a wall: exclusion is
      // reserved for Live evidence (see header).
      soft.push({ ...refOf(env), reasonCode: hit.code, state: "emerging", penalty: EMERGING_SOFT_PENALTY });
    }
  }

  if (exclusion) return { exclusion, demotions, soft, penalty: 0 };
  const demotePenalty = Math.min(demotions.length, LIVE_DEMOTE_MAX_REASONS) * LIVE_DEMOTE_PENALTY;
  const softPenalty = Math.min(soft.length, EMERGING_SOFT_MAX) * EMERGING_SOFT_PENALTY;
  return { exclusion: null, demotions, soft, penalty: demotePenalty + softPenalty };
}

// ── Arrival forecast (a Portava prediction) ──────────────────────────────────

/**
 * ETA in minutes for an item: an explicit `etaMinutes` if the producer set one,
 * else a walking-speed estimate from `distanceKm`. Null when neither exists —
 * without an ETA no forecast is made (never "likely still" on a guess).
 */
export function etaMinutesForItem(item: CompassItem, walkingSpeedKmh: number = WALKING_SPEED_KMH): number | null {
  const explicit = typeof item.etaMinutes === "number" ? (item.etaMinutes as number) : null;
  if (explicit !== null && Number.isFinite(explicit) && explicit >= 0) return Math.ceil(explicit);
  const km = typeof item.distanceKm === "number" ? (item.distanceKm as number) : null;
  if (km === null || !Number.isFinite(km) || km < 0 || walkingSpeedKmh <= 0) return null;
  return Math.ceil((km / walkingSpeedKmh) * 60);
}

/**
 * Will the claim still be within TTL when the viewer arrives?
 *
 * horizon = min(validUntil, observedAt + ttlSeconds) — the EARLIER of the
 * projection's expiry and the freshness-policy TTL. Arrival at or after the
 * horizon is "may have changed" (inclusive, matching freshnessPolicy.isStale).
 * Only a Live-eligible envelope is forecast; a forecast on weaker evidence
 * would overstate it. Returns null when there is nothing honest to say.
 */
export function forecastArrival(
  env: LiveClaimEnvelope,
  etaMinutes: number,
  nowMs: number,
  ttlSeconds: number | null,
): ArrivalForecast | null {
  if (!isLiveConstraintEligible(env, nowMs)) return null;
  if (!Number.isFinite(etaMinutes) || etaMinutes < 0) return null;
  const validUntilMs = Date.parse(env.validUntil);
  const observedMs = Date.parse(env.observedAt);
  let horizonMs = validUntilMs;
  if (ttlSeconds !== null && Number.isFinite(ttlSeconds) && ttlSeconds >= 0 && Number.isFinite(observedMs)) {
    horizonMs = Math.min(horizonMs, observedMs + ttlSeconds * 1000);
  }
  if (!Number.isFinite(horizonMs)) return null;
  const arrivalMs = nowMs + etaMinutes * 60_000;
  const label: ArrivalForecastLabel = arrivalMs < horizonMs ? "likely_still" : "may_have_changed";
  const eta = `~${etaMinutes} min away`;
  const value = describeLiveClaimValue(env);
  const text =
    label === "likely_still"
      ? `${SOURCE_CLASS_LABELS.portava_prediction}: likely still ${value} at arrival (${eta})`
      : `${SOURCE_CLASS_LABELS.portava_prediction}: may have changed by arrival (${eta})`;
  return {
    ...refOf(env),
    label,
    text,
    etaMinutes,
    arrivalAt: new Date(arrivalMs).toISOString(),
    horizonAt: new Date(horizonMs).toISOString(),
  };
}

// ── Explanation (grounded factors + lines) ───────────────────────────────────

function bandWeight(band: ConfidenceBand): number {
  return band === "strong" ? 1 : band === "live" ? 0.8 : 0.3;
}

/**
 * Annotate one item with everything the live stage knows about it. Async only
 * because the TTL comes from the freshness-policy table; the injected
 * `ttlSecondsFor` is fail-soft (an error ⇒ null ⇒ horizon = validUntil).
 */
export async function annotateLiveIntel(
  item: CompassItem,
  envelopes: readonly LiveClaimEnvelope[],
  tolerances: ViewerLiveTolerances,
  nowMs: number,
  ttlSecondsFor: (claimType: string) => Promise<number | null>,
): Promise<LiveIntelAnnotation> {
  const evaluation = evaluateLiveConstraints(envelopes, tolerances, nowMs);
  const eta = etaMinutesForItem(item);
  const forecasts: ArrivalForecast[] = [];
  const factors: RankingFactor[] = [];
  const lines: string[] = [];

  for (const env of envelopes ?? []) {
    const live = isLiveConstraintEligible(env, nowMs);
    const emerging = !live && isEmergingInfluenceEligible(env, nowMs);
    if (!live && !emerging) continue;

    let forecast: ArrivalForecast | null = null;
    if (live && eta !== null) {
      let ttl: number | null = null;
      try { ttl = await ttlSecondsFor(env.claimType); } catch { ttl = null; }
      forecast = forecastArrival(env, eta, nowMs, ttl);
      if (forecast) forecasts.push(forecast);
    }

    const value = describeLiveClaimValue(env);
    const source = describeLiveIntelSource(env);
    const prefix = live ? "Live" : "Emerging";
    const detail = forecast ? `${source}; ${forecast.text}` : source;
    factors.push({
      key: `live_intel:${env.claimType}`,
      label: `${prefix}: ${value}`,
      weight: bandWeight(env.band),
      detail,
    });
    lines.push(`${prefix}: ${value} — ${detail}`);
  }

  const constraint = evaluation.exclusion ?? evaluation.demotions[0] ?? null;
  for (const d of evaluation.demotions) {
    const source = describeLiveIntelSource(d);
    factors.push({ key: `live_caveat:${d.reasonCode}`, label: `Heads-up: ${d.reason}`, weight: 0.6, detail: source });
    lines.push(`Heads-up: ${d.reason} — ${source}`);
  }
  if (evaluation.exclusion) {
    lines.push(`Not recommended right now: ${evaluation.exclusion.reason} — ${describeLiveIntelSource(evaluation.exclusion)}`);
  }

  return {
    constraint,
    demotions: evaluation.demotions,
    soft: evaluation.soft,
    forecasts,
    factors,
    lines,
    penalty: evaluation.penalty,
  };
}

// ── Subject resolution (id-space bridge) ─────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map pipeline items to the CANONICAL subject the intel read seam is keyed on —
 * public.places(id). The id spaces differ per item type (the "demand id-space
 * trap"):
 *   • an explicit `canonicalPlaceId` on the item wins (a producer that knows);
 *   • post.placeId is posts.canonical_place_id → places(id): used directly;
 *   • place.placeId is discovery_places.id, and suggestion ids are
 *     `discovery:<discovery_places.id>`: bridged through
 *     discovery_places.canonical_location_id → places(id) in ONE query;
 *   • hidden_gem.placeId is hidden_gems.id — no canonical link: no subject.
 * Non-fatal: an unreadable bridge resolves to "no subject" (⇒ no constraint,
 * exactly today's behaviour), never a wrong subject.
 */
export async function resolveLiveSubjects(
  db: Pick<SupabaseClient, "from"> | null,
  items: readonly CompassItem[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dpToItems = new Map<string, string[]>();

  for (const item of items) {
    const explicit = typeof item.canonicalPlaceId === "string" && UUID_RE.test(item.canonicalPlaceId as string)
      ? (item.canonicalPlaceId as string) : null;
    if (explicit) { out.set(item.id, explicit); continue; }

    const pid = typeof item.placeId === "string" && UUID_RE.test(item.placeId) ? item.placeId : null;
    if (item.type === "post" && pid) { out.set(item.id, pid); continue; }

    let dp: string | null = null;
    if (item.type === "place" && pid) dp = pid;
    else if (item.type === "suggestion" && typeof item.id === "string" && item.id.startsWith("discovery:")) {
      const raw = item.id.slice("discovery:".length);
      if (UUID_RE.test(raw)) dp = raw;
    }
    if (dp) {
      const list = dpToItems.get(dp) ?? [];
      list.push(item.id);
      dpToItems.set(dp, list);
    }
  }

  if (dpToItems.size > 0 && db) {
    try {
      const { data, error } = await db
        .from("discovery_places")
        .select("id, canonical_location_id")
        .in("id", [...dpToItems.keys()]);
      if (!error && Array.isArray(data)) {
        for (const row of data as Array<{ id?: string | null; canonical_location_id?: string | null }>) {
          const canon = row.canonical_location_id;
          if (!row.id || typeof canon !== "string" || !UUID_RE.test(canon)) continue;
          for (const itemId of dpToItems.get(row.id) ?? []) out.set(itemId, canon);
        }
      }
    } catch {
      /* non-fatal — unresolved items get no live constraint */
    }
  }
  return out;
}

// ── Plan B (pure) ────────────────────────────────────────────────────────────

/** Category keys: fine = type + category (when present), coarse = type. */
export function categoryKeysOf(item: CompassItem): { fine: string; coarse: string } {
  const coarse = String(item.type);
  const cat = typeof item.category === "string" && item.category ? (item.category as string).toLowerCase() : null;
  return { fine: cat ? `${coarse}:${cat}` : coarse, coarse };
}

export interface PlanBConstrainedCandidate {
  item: CompassItem;
  decision: LiveConstraintDecision;
  /** finalScore after the demotion; null for an excluded item (never scored). */
  finalScore: number | null;
  /** What the score would have been without the live penalty; null when excluded. */
  unconstrainedScore: number | null;
}

export interface PlanBRankedCandidate {
  item: CompassItem;
  finalScore: number;
  /** True when this result itself carries a hard live constraint (demoted). */
  hasHardConstraint: boolean;
}

/**
 * Plan B: for each candidate a LIVE constraint took out of, or down in, its
 * category, the next-best unconstrained alternative in the SAME category (fine
 * key first, coarse type as fallback).
 *
 *   excluded → always (it cannot be shown, whatever its score would have been);
 *   demoted  → only when the demotion CHANGED the pick: it would have outranked
 *              the alternative without the penalty and no longer does.
 *
 * Capped at PLAN_B_MAX, in the order the constrained candidates are supplied
 * (exclusions first, then demotions in rank order).
 */
/**
 * The next-best UNCONSTRAINED alternative to `item` in the SAME category —
 * fine key (type:category) first, coarse type as the fallback — and its index
 * in the ranked list.
 *
 * EXTRACTED FROM {@link computePlanB}, WHICH STILL CALLS IT, so the selection
 * rule has exactly one definition. §36 Phase-6 recovery (lib/journeyRecovery)
 * needs the same rule for a stop whose planned WINDOW has passed — a schedule
 * fact with no live claim behind it, which therefore cannot be expressed as a
 * `LiveConstraintDecision` and cannot go through `computePlanB`. Exporting the
 * selector is how that case reuses the rule instead of restating it.
 */
export function bestSameCategoryAlternative(
  item: CompassItem,
  ranked: readonly PlanBRankedCandidate[],
): { candidate: PlanBRankedCandidate; rank: number } | null {
  const keys = categoryKeysOf(item);
  for (const want of [keys.fine, keys.coarse]) {
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i]!;
      if (r.hasHardConstraint || r.item.id === item.id) continue;
      const k = categoryKeysOf(r.item);
      if (want === keys.fine ? k.fine === want : k.coarse === want) return { candidate: r, rank: i };
    }
  }
  return null;
}

export function computePlanB(
  constrained: readonly PlanBConstrainedCandidate[],
  ranked: readonly PlanBRankedCandidate[],
): PlanBEntry[] {
  const out: PlanBEntry[] = [];
  const bestAlternative = (item: CompassItem): { r: PlanBRankedCandidate; rank: number } | null => {
    const found = bestSameCategoryAlternative(item, ranked);
    return found ? { r: found.candidate, rank: found.rank } : null;
  };

  for (const c of constrained) {
    if (out.length >= PLAN_B_MAX) break;
    const alt = bestAlternative(c.item);
    if (!alt) continue;
    if (c.finalScore !== null) {
      // Demoted: emit only when the constraint changed the category's pick.
      const would = c.unconstrainedScore ?? c.finalScore;
      if (!(would >= alt.r.finalScore && c.finalScore < alt.r.finalScore)) continue;
    }
    out.push({
      forItemId: c.item.id,
      forItemType: String(c.item.type),
      category: categoryKeysOf(c.item).fine,
      reasonCode: c.decision.reasonCode,
      reason: c.decision.reason,
      claimRef: c.decision.claimRef,
      alternativeItemId: alt.r.item.id,
      alternativeRank: alt.rank,
    });
  }
  return out;
}

// ── The pipeline stage (async; called by runPipeline only when gated on) ─────

/** Injectable pieces for tests — synthetic envelopes, fixed clock, tolerances. */
export interface LiveIntelStageOverrides {
  /** Overrides the env gate. */
  enabled?: boolean;
  now?: Date;
  tolerances?: ViewerLiveTolerances;
  /** Item id → canonical subject id. Replaces the discovery_places bridge. */
  resolveSubjects?: (items: readonly CompassItem[]) => Promise<Map<string, string>>;
  /** Subject id → envelopes. Replaces the gated read seam. */
  readEnvelopes?: (subjectId: string) => Promise<LiveClaimEnvelope[]>;
  /** Claim type → TTL seconds (null = unknown). Replaces freshnessPolicy. */
  ttlSecondsFor?: (claimType: string) => Promise<number | null>;
}

export interface LiveIntelStage {
  now: Date;
  tolerances: ViewerLiveTolerances;
  /** Item id → annotation, only for items with at least one served envelope. */
  annotations: Map<string, LiveIntelAnnotation>;
  subjectsChecked: number;
  /** Subjects beyond LIVE_INTEL_MAX_SUBJECTS that were NOT read (coverage note). */
  subjectsSkipped: number;
}

async function mapWithConcurrency<T, R>(
  inputs: readonly T[],
  limit: number,
  fn: (input: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(inputs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      const i = next++;
      results[i] = await fn(inputs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, inputs.length)) }, worker));
  return results;
}

/**
 * Build the live stage for one pipeline call, or null when it must not run:
 * gate off, no reader, or the IG Live-label gates closed. Every failure inside
 * is contained per subject (an unreadable subject has no envelopes ⇒ no
 * constraint), so this can never take the feed down or fabricate a claim.
 */
export async function prepareLiveIntelStage(
  db: SupabaseClient | null,
  items: readonly CompassItem[],
  profile: CompassProfile,
  overrides?: LiveIntelStageOverrides,
): Promise<LiveIntelStage | null> {
  const enabled = overrides?.enabled ?? liveConstraintsEnabled();
  if (!enabled) return null;

  const now = overrides?.now ?? new Date();
  const nowMs = now.getTime();
  const tolerances = overrides?.tolerances ?? deriveViewerLiveTolerances(profile);

  let readEnvelopes = overrides?.readEnvelopes ?? null;
  if (!readEnvelopes) {
    if (!db) return null;
    // Short-circuit the whole stage when Live may not be served at all (the
    // seam re-checks per subject; this saves the per-subject reads when off).
    if (!(await liveLabelsServable(db))) return null;
    const sc = db;
    readEnvelopes = (subjectId) => readLiveClaimEnvelopes(sc, subjectId, { now });
  }
  const ttlSecondsFor: (claimType: string) => Promise<number | null> =
    overrides?.ttlSecondsFor ??
    (db
      ? async (claimType) => (await getPolicy(db, claimType))?.ttlSeconds ?? null
      : async () => null);

  const subjectByItem = overrides?.resolveSubjects
    ? await overrides.resolveSubjects(items)
    : await resolveLiveSubjects(db, items);

  const distinctSubjects = [...new Set(subjectByItem.values())];
  const toRead = distinctSubjects.slice(0, LIVE_INTEL_MAX_SUBJECTS);
  const subjectsSkipped = distinctSubjects.length - toRead.length;
  if (subjectsSkipped > 0) {
    logger.warn({ subjectsSkipped, cap: LIVE_INTEL_MAX_SUBJECTS }, "compass live constraints: subject cap reached — remaining candidates get no live constraint");
  }

  const reader = readEnvelopes;
  const envelopesBySubject = new Map<string, LiveClaimEnvelope[]>();
  const read = await mapWithConcurrency(toRead, LIVE_INTEL_CONCURRENCY, async (subjectId) => {
    try {
      const env = await reader(subjectId);
      return Array.isArray(env) ? env : [];
    } catch (err) {
      logger.warn({ err }, "compass live constraints: envelope read threw — subject treated as unknown");
      return [];
    }
  });
  toRead.forEach((subjectId, i) => envelopesBySubject.set(subjectId, read[i] ?? []));

  const annotations = new Map<string, LiveIntelAnnotation>();
  for (const item of items) {
    const subjectId = subjectByItem.get(item.id);
    if (!subjectId) continue;
    const envelopes = envelopesBySubject.get(subjectId);
    if (!envelopes || envelopes.length === 0) continue;
    try {
      annotations.set(item.id, await annotateLiveIntel(item, envelopes, tolerances, nowMs, ttlSecondsFor));
    } catch (err) {
      logger.warn({ err }, "compass live constraints: annotation failed — item treated as unknown");
    }
  }

  return { now, tolerances, annotations, subjectsChecked: toRead.length, subjectsSkipped };
}
