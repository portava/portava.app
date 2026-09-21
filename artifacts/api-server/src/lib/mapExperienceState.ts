/**
 * mapExperienceState — the server-built `ExperienceState` Sensing §7 places on
 * the Map ("Add server-built ExperienceState to place/event Map projections
 * rather than separate overlapping vibe pins"), in the §5.3 shape.
 *
 * ── WHAT THIS IS BUILT FROM, AND WHAT IT IS NOT ──────────────────────────────
 * It is a PURE FOLD over the live claims the gateway ALREADY reads for a
 * subject (`mapProjection.enrichWithLiveClaims` → `readLiveClaims`). It opens
 * no new read path: every value here is derived from a `LiveClaimLike[]` that
 * `applyLiveClaims` was already handed, and the same fold accepts claims from
 * any future provider (the anonymous sensing aggregate, when an owner decides
 * to wire it) through the same injected `read` seam. There is no VibeState
 * engine, no behavior engine and no anomaly engine in this repository
 * (Sensing S4 is unbuilt — docs/architecture/sensing-s0-reuse-map.md §13,
 * "ExperienceState … TRULY MISSING"), so the leaves those engines would own
 * are `null` and stay `null`. Sensing §1: "Preserve null / unknown when
 * canonical fact is unavailable" — a leaf is never defaulted to a plausible
 * value to make the tree look complete (§20 "No product surface may fabricate
 * world state to make UI look complete").
 *
 * ── WHERE THE VALUES COME FROM ───────────────────────────────────────────────
 * Each populated leaf names its ONE claim type, and the value vocabulary is the
 * claim's own (lib/intelContracts, validated by lib/quickSignal
 * VALUE_VALIDATORS), never a re-spelling:
 *
 *   crowd.density     crowd.level        → §7 ActivityLevel, via the SAME table
 *                                          `applyLiveClaims` uses
 *                                          (`crowdValueToActivity`). unsafe_density
 *                                          → null: a safety claim, not a density
 *                                          (SPECIALIST_ONLY_CROWD_LEVELS).
 *   crowd.momentum    crowd.trajectory   → §7 TrendState (`crowdValueToTrend`).
 *   vibe.energy       vibe.state         → VIBE_STATES verbatim.
 *   friction.queue    queue.wait         → {minMinutes, maxMinutes}.
 *   friction.access   access.walk_in     → {walkIn: boolean}; access.reservation
 *                                          → {reservation}.
 *   friction.wait     service.wait       → {minMinutes, maxMinutes}.
 *   friction.transport transit.condition → TRANSIT_CONDITIONS verbatim.
 *   dynamics.*        crowd.trajectory   → heating_up / peaking / cooling as
 *                                          booleans; ALL THREE null when no
 *                                          trajectory claim exists (unknown ≠
 *                                          false).
 *   truth.*           the fold           → §5.1 truth class, band, coverage
 *                                          bucket, freshness, attributed source.
 *
 * ── TRUTH IS DERIVED, NEVER UPGRADED ─────────────────────────────────────────
 * `truthClass` comes from lib/wallProjection.deriveWallTruthClass — the Wall's
 * Sensing §5.1 derivation, reused rather than re-implemented, so the map and
 * the Wall cannot disagree about whether a sponsored claim is an observation
 * (it is not: `inferred`). Coverage is the read path's own cohort bucket
 * (`sourceCountBucket`, withheld as null for non-independent classes), folded
 * to the WIDEST bucket any consensus-eligible claim carries; a subject whose
 * every claim is a business talking about itself has coverage `unknown`, not
 * `few` — Sensing §2 "Promotional claim ≠ observed reality".
 *
 * PURE. No I/O, no clock of its own (`now` is injected), no privacy decision:
 * the claims it receives have already passed readLiveClaims' gates, and §24
 * strips the whole payload key on a protected location
 * (protectedLocations.COARSENED_PAYLOAD_KEYS).
 */
import {
  TRANSIT_CONDITIONS,
  VIBE_STATES,
  RESERVATION_STATES,
  mayCountAsConsensus,
  type TransitCondition,
  type VibeState,
  type ReservationState,
} from "./intelContracts.js";
import { deriveWallTruthClass } from "./wallProjection.js";
import type {
  ActivityLevel,
  ConfidenceState,
  CoverageState,
  FreshnessState,
  SourceClass,
  TrendState,
  TruthClass,
} from "./mapObjects.js";

/**
 * The subset of `mapProjection.LiveClaimLike` this fold reads. Declared here
 * (structurally, not imported) so the two modules have no import cycle —
 * mapProjection imports THIS file.
 */
export interface ExperienceClaimLike {
  id: string;
  claimType: string;
  value: unknown;
  band: ConfidenceState;
  sourceClass: SourceClass;
  sourceCountBucket: "few" | "several" | "many" | null;
  conflictState?: "none" | "minor" | "material" | null;
}

/** Sensing §5.3's tree. Every leaf is nullable; null means UNKNOWN. */
export interface ExperienceState {
  /** Always the literal below: this state is folded from live claims. */
  basis: "live_claims";
  crowd: {
    density: ActivityLevel | null;
    momentum: TrendState | null;
    /** Place-level flow has no producer; zone flow is `crowd_flow`'s own kind. */
    flow: null;
  };
  vibe: {
    energy: VibeState | null;
    /** No VibeState engine exists (Sensing S4). Always null today. */
    sociality: null;
    dance_likelihood: null;
    momentum: null;
  };
  behavior: {
    /** No behavior engine exists. All four always null today. */
    dwell: null;
    stickiness: null;
    conversion: null;
    departures: null;
  };
  friction: {
    queue: { minMinutes: number; maxMinutes: number | null } | null;
    access: { walkIn: boolean | null; reservation: ReservationState | null } | null;
    wait: { minMinutes: number; maxMinutes: number | null } | null;
    transport: TransitCondition | null;
  };
  dynamics: {
    heating_up: boolean | null;
    peaking: boolean | null;
    cooling: boolean | null;
    /** No anomaly producer at place level. Always null today. */
    anomaly: null;
  };
  truth: {
    truthClass: TruthClass;
    confidence: ConfidenceState;
    coverage: CoverageState;
    freshness: FreshnessState;
    /** The attributed speaker, or null when unrecognised — never a default. */
    provenance: SourceClass | null;
  };
  /** Snapshot ids that fed the fold. Opaque; never a contributor. */
  claimRefs: string[];
}

export interface BuildExperienceStateInput {
  claims: readonly ExperienceClaimLike[];
  /** The §7 axes `applyLiveClaims` already derived — reused, never recomputed. */
  activity: ActivityLevel | undefined;
  trend: TrendState | undefined;
  /** The primary claim's band and the object's freshness, as applyLiveClaims set them. */
  confidence: ConfidenceState;
  freshness: FreshnessState;
  /** The fold's attributed class (`attributedSourceClass`), or undefined. */
  sourceClass: SourceClass | undefined;
}

const COVERAGE_RANK: Record<Exclude<CoverageState, "unknown">, number> = { few: 1, several: 2, many: 3 };

/**
 * The widest coverage bucket any consensus-eligible claim carries. A bucket is
 * only ever present on a claim `mayCountAsConsensus` admits (the read path
 * withholds it otherwise), and the check is repeated here so a caller that
 * hand-builds a claim cannot slip a bucket past the §37 rule.
 */
export function foldCoverage(claims: readonly ExperienceClaimLike[]): CoverageState {
  let best: Exclude<CoverageState, "unknown"> | null = null;
  for (const c of claims) {
    const b = c.sourceCountBucket;
    if (b !== "few" && b !== "several" && b !== "many") continue;
    if (!mayCountAsConsensus(c.sourceClass)) continue;
    if (best === null || COVERAGE_RANK[b] > COVERAGE_RANK[best]) best = b;
  }
  return best ?? "unknown";
}

/**
 * The §5.1 truth class for a folded object. Delegates to the Wall's derivation
 * with the map's freshness mapped onto the Wall's narrower vocabulary: the
 * map's `historical` (expired) is the Wall's `stale` (a horizon that passed).
 * The Wall's rule order — stale, conflicting, predicted, inferred, corroborated,
 * observed, unknown — is therefore the map's too.
 */
export function deriveMapTruthClass(input: {
  sourceClass: string | null | undefined;
  conflictState: "none" | "minor" | "material" | null | undefined;
  freshness: FreshnessState | null | undefined;
  coverage: CoverageState | null | undefined;
}): TruthClass {
  const f = input.freshness;
  return deriveWallTruthClass({
    sourceClass: input.sourceClass ?? null,
    conflictState: input.conflictState ?? null,
    freshness: f === "historical" ? "stale" : f ?? null,
    coverage: input.coverage ?? null,
  });
}

function scalar(value: unknown, key: string): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function first(claims: readonly ExperienceClaimLike[], claimType: string): ExperienceClaimLike | undefined {
  return claims.find((c) => c.claimType === claimType);
}

function minutes(value: unknown): { minMinutes: number; maxMinutes: number | null } | null {
  const min = scalar(value, "minMinutes");
  const max = scalar(value, "maxMinutes");
  if (typeof min !== "number" || !Number.isFinite(min) || min < 0) return null;
  if (max !== null && max !== undefined && (typeof max !== "number" || !Number.isFinite(max) || max < min)) return null;
  return { minMinutes: min, maxMinutes: typeof max === "number" ? max : null };
}

/**
 * Fold one subject's claims into Sensing §5.3's tree. Deterministic and total:
 * an unrecognised value leaves its leaf null, never a guess.
 */
export function buildExperienceState(input: BuildExperienceStateInput): ExperienceState {
  const { claims } = input;

  // dynamics — from the RAW trajectory, not the folded trend: `peaking` maps to
  // `stable` on §7's Trend axis (a deliberate choice recorded in
  // mapProjection.TRAJECTORY_TO_TREND) and would be invisible through it.
  const trajectoryClaim = first(claims, "crowd.trajectory");
  const trajectory = trajectoryClaim ? scalar(trajectoryClaim.value, "trajectory") : undefined;
  let heatingUp: boolean | null = null;
  let peaking: boolean | null = null;
  let cooling: boolean | null = null;
  if (typeof trajectory === "string") {
    const up = trajectory === "emerging" || trajectory === "building";
    const apex = trajectory === "peaking";
    const down =
      trajectory === "declining" ||
      trajectory === "fragmenting" ||
      trajectory === "ending" ||
      trajectory === "relocating";
    if (up || apex || down || trajectory === "stable") {
      heatingUp = up;
      peaking = apex;
      cooling = down;
    }
  }

  const vibeClaim = first(claims, "vibe.state");
  const vibeRaw = vibeClaim ? scalar(vibeClaim.value, "state") : undefined;
  const energy: VibeState | null =
    typeof vibeRaw === "string" && (VIBE_STATES as readonly string[]).includes(vibeRaw)
      ? (vibeRaw as VibeState)
      : null;

  const queueClaim = first(claims, "queue.wait");
  const waitClaim = first(claims, "service.wait");
  const walkInClaim = first(claims, "access.walk_in");
  const reservationClaim = first(claims, "access.reservation");
  const transitClaim = first(claims, "transit.condition");

  const walkInRaw = walkInClaim ? scalar(walkInClaim.value, "accepted") : undefined;
  const reservationRaw = reservationClaim ? scalar(reservationClaim.value, "reservation") : undefined;
  const walkIn: boolean | null = typeof walkInRaw === "boolean" ? walkInRaw : null;
  const reservation: ReservationState | null =
    typeof reservationRaw === "string" && (RESERVATION_STATES as readonly string[]).includes(reservationRaw)
      ? (reservationRaw as ReservationState)
      : null;
  const access = walkIn === null && reservation === null ? null : { walkIn, reservation };

  const transitRaw = transitClaim ? scalar(transitClaim.value, "condition") : undefined;
  const transport: TransitCondition | null =
    typeof transitRaw === "string" && (TRANSIT_CONDITIONS as readonly string[]).includes(transitRaw)
      ? (transitRaw as TransitCondition)
      : null;

  const coverage = foldCoverage(claims);
  const primary = claims[0];
  const truthClass = deriveMapTruthClass({
    sourceClass: input.sourceClass ?? null,
    conflictState: primary?.conflictState ?? null,
    freshness: input.freshness,
    coverage,
  });

  return {
    basis: "live_claims",
    crowd: {
      density: input.activity ?? null,
      momentum: input.trend ?? null,
      flow: null,
    },
    vibe: { energy, sociality: null, dance_likelihood: null, momentum: null },
    behavior: { dwell: null, stickiness: null, conversion: null, departures: null },
    friction: {
      queue: queueClaim ? minutes(queueClaim.value) : null,
      access,
      wait: waitClaim ? minutes(waitClaim.value) : null,
      transport,
    },
    dynamics: { heating_up: heatingUp, peaking, cooling, anomaly: null },
    truth: {
      truthClass,
      confidence: input.confidence,
      coverage,
      freshness: input.freshness,
      provenance: input.sourceClass ?? null,
    },
    claimRefs: claims.map((c) => c.id),
  };
}
