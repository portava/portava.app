/**
 * vibeInference — §5.2's Vibe engine, as a guarded PURE inference with explicit
 * truth metadata. It owns "energy / social / dance-likelihood inference" and
 * "must not claim literal behavior without sufficient evidence" (§5).
 *
 * ── WHY THE OUTPUT IS NOT NAMED VibeState ────────────────────────────────────
 * lib/intelContracts already exports `VibeState` — a FIVE-VALUE HUMAN TAP
 * ("dead" … "going_off") captured by lib/quickSignal from a contributor. That
 * is an observation someone made. This module's output is an INFERENCE the
 * platform made from motion features, which is a different truth class, so it
 * is `SensingVibeState`, its truth class is always `inferred`, and it can never
 * be mistaken for the tap at a call site.
 *
 * ── THE INPUTS DO NOT EXIST YET, AND THIS FILE SAYS SO ───────────────────────
 * §4.1's on-device features (motion_energy, periodicity, dwell_bucket, …) are
 * produced by NOTHING in this tree today: no client captures motion, and the
 * anonymous store carries one unlabelled ordinal. So this is S4's contract and
 * its invariants — the part the spec says to "mutation/property test" — built
 * so that when a feature pipeline exists (an owner decision: sensing-input-gap
 * .md §3.2 "Client capture at all", "What signal_bucket means") it plugs into a
 * guarded engine rather than an unguarded one. Until then it is called by
 * nothing. It reads no store and no clock.
 *
 * ── THE INVARIANTS (§2, §5.2, §20) ───────────────────────────────────────────
 *   Rapid movement ≠ dancing   High motion energy with LOW or UNKNOWN
 *                              periodicity, or with UNBOUNDED movement, cannot
 *                              raise dance_likelihood. Unknown periodicity ⇒
 *                              dance_likelihood is null (we do not know), not
 *                              a number. Contradicting evidence ⇒ ≤ 0.1.
 *   No coverage ≠ quiet        coverage `unknown` ⇒ every output is null and
 *                              the truth class is `unknown`. Never a zero.
 *   Inference ≠ observation    truth class is ALWAYS `inferred`, and the
 *                              confidence band can never reach
 *                              MIN_BAND_FOR_LIVE_STATE, so no Live label can
 *                              be backed by this engine's output alone.
 *   Context is not evidence    A nightclub context with no motion evidence
 *                              raises nothing; it may only nudge a likelihood
 *                              that periodic, bounded motion already supports.
 *   Acoustic needs permission  §4.1: "coarse acoustic energy/rhythm ONLY under
 *                              separate explicit permission". An acoustic
 *                              feature presented without that flag is REFUSED
 *                              outright — not ignored, because ignoring it
 *                              would let a client learn the permission is not
 *                              enforced.
 *   Never certain              No likelihood exceeds 0.9. An inference that
 *                              says 1.0 is a claim of fact.
 *
 * The heuristic weights below are v1 shadow-mode heuristics (S11 calibration
 * has nothing to calibrate against yet) and are versioned in `provenance` so a
 * later calibration is a lineage change, not a silent one.
 */
import { MIN_BAND_FOR_LIVE_STATE, CONFIDENCE_BANDS, type ConfidenceBand } from "./intelContracts.js";
import { deriveFreshness } from "./mapObjects.js";
import type { TemporalEnvelope, TruthMetadata } from "./experienceTruth.js";
import type { CoverageBucket } from "./truthClass.js";

export const VIBE_INFERENCE_VERSION = "sensing_vibe_v1";

/** The ceiling on any inferred likelihood. */
export const VIBE_MAX_LIKELIHOOD = 0.9;
/** Below this periodicity, motion is not rhythmic enough to be called dancing. */
export const VIBE_MIN_PERIODICITY_FOR_DANCE = 0.5;
/** What contradicting evidence caps dance_likelihood at. */
export const VIBE_CONTRADICTED_DANCE_CEILING = 0.1;

export type VenueContext = "nightlife" | "dining" | "transit" | "outdoor" | "none";

/** §4.1's normalised features, every one nullable: absent is a fact, not a zero. */
export interface VibeFeatureInput {
  /** 0..1 accelerometer-derived energy. */
  motionEnergy: number | null;
  /** 0..1 rhythmic periodicity of movement. */
  periodicity: number | null;
  /** True when movement stays within a small area (dwelling, not transiting). */
  boundedMovement: boolean | null;
  /** 0..4 dwell bucket. */
  dwellBucket: number | null;
  /** 0..1 arrival rate. */
  arrivalVelocity: number | null;
  /** 0..1 departure rate. */
  departureVelocity: number | null;
  /** Coverage behind these features — from the aggregate, never from one device. */
  coverage: CoverageBucket;
  /** Venue/event context, where legitimately sourced. */
  venueContext: VenueContext | null;
  /** 0..1 coarse acoustic energy. Only with `acousticPermissionGranted`. */
  acousticEnergy?: number | null;
  acousticPermissionGranted?: boolean;
  /** When the features were observed; drives freshness. */
  observedAt: string | number | null;
}

export interface SensingVibeState {
  kind: "sensing_vibe";
  energy: number | null;
  sociality: number | null;
  danceLikelihood: number | null;
  volatility: number | null;
  /** −1..1: arrivals minus departures. */
  momentum: number | null;
  /** Context tags, only where legitimately sourced. Never a behaviour claim. */
  contextTags: readonly string[];
  truth: TruthMetadata;
  /** §18.2 envelope. `predictedFor` is always null: an inference is about now, never a forecast. */
  temporal: TemporalEnvelope;
}

export type VibeInferenceReason = "input_required" | "invalid_input" | "acoustic_without_permission";

export type VibeInferenceResult =
  | { ok: true; state: SensingVibeState }
  | { ok: false; reason: VibeInferenceReason; field?: string };

function unit(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}
function unitOrNull(v: unknown, field: string): { ok: true; v: number | null } | { ok: false; field: string } {
  if (v === null || v === undefined) return { ok: true, v: null };
  return unit(v) ? { ok: true, v } : { ok: false, field };
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const COVERAGE_WEIGHT: Readonly<Record<CoverageBucket, number | null>> = {
  unknown: null,
  few: 0.33,
  several: 0.66,
  many: 1,
};

/**
 * The only band an inference may carry. Structurally BELOW
 * MIN_BAND_FOR_LIVE_STATE so this engine cannot back a Live label by itself:
 * `provisional` with broad coverage, `unverified` otherwise.
 */
export function inferredConfidenceBand(coverage: CoverageBucket): ConfidenceBand {
  const band: ConfidenceBand = coverage === "several" || coverage === "many" ? "provisional" : "unverified";
  // Defence in depth: if the band vocabulary ever changes so that provisional
  // outranks the live floor, fall to the floor rather than promote.
  const bands = CONFIDENCE_BANDS as readonly string[];
  return bands.indexOf(band) < bands.indexOf(MIN_BAND_FOR_LIVE_STATE) ? band : "unverified";
}

/** Infer a vibe state from features. PURE — takes its instant. */
export function inferVibe(features: VibeFeatureInput, nowMs: number): VibeInferenceResult {
  if (!features || !Number.isFinite(nowMs)) return { ok: false, reason: "input_required" };

  // Acoustic features are refused without the separate permission, before
  // anything is computed, so the refusal cannot depend on what else was sent.
  const acousticPresent = features.acousticEnergy !== null && features.acousticEnergy !== undefined;
  if (acousticPresent && features.acousticPermissionGranted !== true) {
    return { ok: false, reason: "acoustic_without_permission" };
  }

  const checks: Array<[unknown, string]> = [
    [features.motionEnergy, "motionEnergy"],
    [features.periodicity, "periodicity"],
    [features.arrivalVelocity, "arrivalVelocity"],
    [features.departureVelocity, "departureVelocity"],
    [features.acousticEnergy ?? null, "acousticEnergy"],
  ];
  for (const [v, field] of checks) {
    const r = unitOrNull(v, field);
    if (!r.ok) return { ok: false, reason: "invalid_input", field };
  }
  if (features.dwellBucket !== null && features.dwellBucket !== undefined) {
    if (!Number.isInteger(features.dwellBucket) || features.dwellBucket < 0 || features.dwellBucket > 4) {
      return { ok: false, reason: "invalid_input", field: "dwellBucket" };
    }
  }
  if (features.boundedMovement !== null && features.boundedMovement !== undefined && typeof features.boundedMovement !== "boolean") {
    return { ok: false, reason: "invalid_input", field: "boundedMovement" };
  }
  const coverageWeight = COVERAGE_WEIGHT[features.coverage];
  if (coverageWeight === undefined) return { ok: false, reason: "invalid_input", field: "coverage" };

  const freshness = deriveFreshness(features.observedAt, null, nowMs);
  const observedAtMs = features.observedAt === null ? NaN : new Date(features.observedAt).getTime();
  const temporal: TemporalEnvelope = {
    observedAt: Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : null,
    effectiveFrom: null,
    effectiveUntil: null,
    expiresAt: null,
    freshness,
    predictedFor: null,
  };

  // No coverage ≠ quiet. Nothing is inferred from nothing: every output is
  // null and the truth class is unknown — not `inferred`, because nothing was.
  if (coverageWeight === null) {
    return {
      ok: true,
      state: {
        kind: "sensing_vibe",
        energy: null,
        sociality: null,
        danceLikelihood: null,
        volatility: null,
        momentum: null,
        contextTags: [],
        truth: {
          truthClass: "unknown",
          confidence: "unverified",
          freshness,
          coverage: "unknown",
          provenance: [VIBE_INFERENCE_VERSION],
        },
        temporal,
      },
    };
  }

  const motion = features.motionEnergy;
  const periodicity = features.periodicity;
  const bounded = features.boundedMovement ?? null;
  const dwell = features.dwellBucket ?? null;
  const acoustic = acousticPresent ? (features.acousticEnergy as number) : null;

  // Energy: motion, blended with permitted acoustic energy. Null if neither.
  let energy: number | null = null;
  if (motion !== null && acoustic !== null) energy = (motion + acoustic) / 2;
  else if (motion !== null) energy = motion;
  else if (acoustic !== null) energy = acoustic;

  // Sociality: how many independent people are here and how long they stay.
  // Coverage is the base; dwell scales it. Null when dwell is unknown AND
  // coverage is the only signal? No — coverage alone is a legitimate, weak
  // sociality signal, so it stands, scaled by the neutral 0.5.
  const dwellFactor = dwell === null ? 0.5 : 0.5 + 0.5 * (dwell / 4);
  const sociality = clamp(coverageWeight * dwellFactor, 0, VIBE_MAX_LIKELIHOOD);

  // Dance likelihood — the guarded one.
  let danceLikelihood: number | null;
  if (motion === null || periodicity === null || bounded === null) {
    // Any of the three load-bearing features unknown ⇒ we do not know.
    danceLikelihood = null;
  } else if (bounded === false || periodicity < VIBE_MIN_PERIODICITY_FOR_DANCE) {
    // Rapid movement ≠ dancing: fast but unbounded (transit) or arrhythmic
    // motion is contradicting evidence, and context cannot rescue it.
    danceLikelihood = clamp(motion * VIBE_CONTRADICTED_DANCE_CEILING, 0, VIBE_CONTRADICTED_DANCE_CEILING);
  } else {
    let d = 0.3 * motion + 0.4 * periodicity;
    if (dwell !== null && dwell >= 2) d += 0.1;
    if (features.venueContext === "nightlife") d += 0.15; // a nudge on top of evidence, never a source of it
    danceLikelihood = clamp(d, 0, VIBE_MAX_LIKELIHOOD);
  }

  // Momentum and volatility need both velocities; otherwise unknown.
  const arr = features.arrivalVelocity;
  const dep = features.departureVelocity;
  const momentum = arr !== null && dep !== null ? clamp(arr - dep, -1, 1) : null;
  const volatility = arr !== null && dep !== null ? clamp(Math.max(arr, dep), 0, VIBE_MAX_LIKELIHOOD) : null;

  const contextTags: string[] = [];
  if (features.venueContext && features.venueContext !== "none") contextTags.push(features.venueContext);

  return {
    ok: true,
    state: {
      kind: "sensing_vibe",
      energy: energy === null ? null : clamp(energy, 0, VIBE_MAX_LIKELIHOOD),
      sociality,
      danceLikelihood,
      volatility,
      momentum,
      contextTags,
      truth: {
        truthClass: "inferred",
        confidence: inferredConfidenceBand(features.coverage),
        freshness,
        coverage: features.coverage,
        provenance: [VIBE_INFERENCE_VERSION],
      },
      temporal,
    },
  };
}
