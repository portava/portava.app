/**
 * crowdState — Sensing §5's CROWD engine, as the object its table names:
 *
 *   Owns:          density · momentum · arrival-departure balance
 *   Must not claim: safety or quality
 *   Primary output: CrowdState
 *
 * Census S40 found the vocabulary (CROWD_LEVELS, TRAJECTORIES,
 * CROWD_DIRECTIONS) and the must-not-claim half already enforced, and no
 * object: "density is a claim value, momentum is a trend label, and
 * arrival/departure balance is a human tap, not a computed balance". This is
 * the object, and it is a PURE FOLD over the live-claim envelopes the ONE read
 * path (lib/liveClaimRead) already serves every surface — no new read, no new
 * vocabulary, no second aggregation.
 *
 * ── THE THREE AXES, AND WHY THEY STAY THREE ──────────────────────────────────
 *   density   `crowd.level`      CROWD_LEVELS verbatim, minus `unsafe_density`
 *                                (below).
 *   momentum  `crowd.trajectory` TRAJECTORIES verbatim — the INTENSITY axis.
 *   balance   `crowd.direction`  CROWD_DIRECTIONS verbatim — the FLOW axis,
 *                                plus the net-arrival reading of it.
 * intelContracts:271-285 states the rule this module obeys: trajectory and
 * direction are independent and "storing one as the other publishes an
 * inference the contributor never made". A missing axis is `null`, never a
 * value borrowed from another axis and never a plausible default: §20
 * "Insufficient coverage ≠ quiet".
 *
 * ── MUST NOT CLAIM SAFETY (§2 "Crowded ≠ unsafe") ────────────────────────────
 * `unsafe_density` is a SPECIALIST-ONLY safety claim (intelContracts:256-257),
 * not the top of the density ladder. It never becomes a density here: the
 * level is dropped and the refusal `unsafe_density_is_a_safety_claim` is
 * recorded, so a reader can tell "no density" from "a density we declined to
 * publish". The state has no safety field at all — a surface that needs the
 * safety reading reads the claim, or lib/safetyCandidate's pipeline.
 *
 * ── MUST NOT CLAIM QUALITY (§2 "Busy ≠ good") ────────────────────────────────
 * There is no score, rating, recommendation or "good/bad" field, and none may
 * be added: CROWD_STATE_VALUE_KEYS is the closed set of value-bearing keys and
 * `crowdStateForeignKeys` names anything else a caller stamped on, which the
 * suite asserts is empty. Density is an ordinal for ordering crowds, never for
 * ordering places.
 *
 * ── TRUTH AND TIME ARE THE EVIDENCE'S OWN ────────────────────────────────────
 * The §5.1 block is lib/liveEnvelopeTruth's weakest-on-every-axis composition
 * over exactly the envelopes that populated an axis, and the §18.2 envelope is
 * built from their observed_at / valid_until — never from the clock alone.
 *
 * PURE. No I/O, no clock of its own (`nowMs` is injected), no identity: nothing
 * here reads a contributor, a count or a coordinate, because the envelope
 * carries none.
 */
import {
  CROWD_DIRECTIONS,
  CROWD_LEVELS,
  SPECIALIST_ONLY_CROWD_LEVELS,
  TRAJECTORIES,
  type CrowdDirection,
  type CrowdLevel,
  type Trajectory,
} from "./intelContracts.js";
import type { LiveClaimEnvelope } from "./liveClaimRead.js";
import { truthOfEnvelopes } from "./liveEnvelopeTruth.js";
import { UNKNOWN_TRUTH, type TemporalEnvelope, type TruthMetadata } from "./experienceTruth.js";
import { deriveFreshness } from "./mapObjects.js";

/** The density ladder, weakest to strongest. `unsafe_density` is NOT on it. */
export const DENSITY_LADDER: readonly CrowdDensity[] = CROWD_LEVELS.filter(
  (l) => !(SPECIALIST_ONLY_CROWD_LEVELS as readonly string[]).includes(l),
) as readonly CrowdDensity[];

/** A density is a crowd level that is not a safety claim. */
export type CrowdDensity = Exclude<CrowdLevel, "unsafe_density">;

/** Net accumulation implied by the flow direction. Never a count of people. */
export const NET_ARRIVALS = ["positive", "neutral", "negative"] as const;
export type NetArrival = (typeof NET_ARRIVALS)[number];

/** direction → net accumulation. `passing_through` accumulates nothing. */
export const NET_ARRIVAL_OF: Readonly<Record<CrowdDirection, NetArrival>> = Object.freeze({
  arriving: "positive",
  dispersing: "negative",
  holding: "neutral",
  passing_through: "neutral",
});

export type CrowdStateRefusal =
  | "unsafe_density_is_a_safety_claim"
  | "unrecognised_density"
  | "unrecognised_trajectory"
  | "unrecognised_direction";

export interface CrowdBalance {
  /** The contributor's own word (CROWD_DIRECTIONS), never re-spelt. */
  direction: CrowdDirection;
  /** What that word implies about accumulation. Never a rate and never a count. */
  netArrival: NetArrival;
}

/** Sensing §5 / §19 `CrowdState`. Every axis nullable; null means UNKNOWN. */
export interface CrowdState {
  /** Always the literal below: this state is folded from live claims, nothing else. */
  basis: "live_claims";
  density: CrowdDensity | null;
  momentum: Trajectory | null;
  balance: CrowdBalance | null;
  /** Why an axis is null when a claim existed and was declined. */
  refusals: CrowdStateRefusal[];
  truth: TruthMetadata;
  temporal: TemporalEnvelope;
  /** Snapshot ids that fed the fold. Opaque; never a contributor. */
  claimRefs: string[];
}

/**
 * The closed set of value-bearing keys. A quality score, a safety verdict or a
 * headcount would each be a new key here, which is why the set is exported and
 * asserted rather than merely documented.
 */
export const CROWD_STATE_VALUE_KEYS = ["density", "momentum", "balance"] as const;

/** Keys a caller stamped onto a state that the contract does not define. Empty, always. */
export function crowdStateForeignKeys(state: Record<string, unknown>): string[] {
  const known = new Set<string>([...CROWD_STATE_VALUE_KEYS, "basis", "refusals", "truth", "temporal", "claimRefs"]);
  return Object.keys(state).filter((k) => !known.has(k));
}

const CLAIM_TYPES = Object.freeze({
  level: "crowd.level",
  trajectory: "crowd.trajectory",
  direction: "crowd.direction",
});

/** The only claim types this engine reads. Anything else is not crowd evidence. */
export const CROWD_STATE_CLAIM_TYPES: readonly string[] = Object.freeze([
  CLAIM_TYPES.level,
  CLAIM_TYPES.trajectory,
  CLAIM_TYPES.direction,
]) as readonly string[];

function scalar(value: unknown, key: string): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = (value as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  }
  return null;
}

function newest(envelopes: readonly LiveClaimEnvelope[]): LiveClaimEnvelope | null {
  let best: LiveClaimEnvelope | null = null;
  for (const e of envelopes) {
    const t = Date.parse(e.observedAt);
    if (!Number.isFinite(t)) continue;
    if (best === null || t > Date.parse(best.observedAt)) best = e;
  }
  return best;
}

/** Earliest expiry among the contributing claims — the window closes with its first support. */
function earliestValidUntil(envelopes: readonly LiveClaimEnvelope[]): string | null {
  let best: number | null = null;
  let iso: string | null = null;
  for (const e of envelopes) {
    const t = Date.parse(e.validUntil);
    if (!Number.isFinite(t)) continue;
    if (best === null || t < best) {
      best = t;
      iso = e.validUntil;
    }
  }
  return iso;
}

/**
 * The §18.2 envelope a SET of live-claim envelopes supports: the newest
 * observation, the EARLIEST expiry among them (a window closes with its first
 * support, never its last), and the freshness of the newest. Never a window of
 * this engine's invention, and never a predicted_for — an observation has none.
 *
 * Exported because the kernel's reader needs the same envelope over a slightly
 * wider evidence set (live-qualified OR emerging-eligible) and must not grow a
 * second answer to "when is this true".
 */
export function envelopeTemporal(envelopes: readonly LiveClaimEnvelope[], nowMs: number): TemporalEnvelope {
  const observedEnv = newest(envelopes);
  const validUntil = earliestValidUntil(envelopes);
  return {
    observedAt: observedEnv ? observedEnv.observedAt : null,
    effectiveFrom: observedEnv ? observedEnv.observedAt : null,
    effectiveUntil: validUntil,
    expiresAt: validUntil,
    freshness: observedEnv ? deriveFreshness(observedEnv.observedAt, observedEnv.validUntil, nowMs) : "unknown",
    predictedFor: null,
  };
}

export interface BuildCrowdStateInput {
  /** Envelopes for ONE subject, already gated by the read path. */
  envelopes: readonly LiveClaimEnvelope[];
  /**
   * The Live-qualification predicate the caller's surface uses (Compass's
   * `isLiveConstraintEligible`, the Wall's, …). Injected so this engine cannot
   * invent a second answer to "is this claim current"; when omitted every
   * envelope handed in is taken as already qualified by the caller.
   */
  qualifies?: (e: LiveClaimEnvelope, nowMs: number) => boolean;
}

/**
 * Fold one subject's crowd claims into a `CrowdState`. Deterministic and
 * total: an unrecognised value leaves its axis null WITH a refusal, never a
 * guess; no claim at all leaves it null with no refusal (nothing was declined).
 */
export function buildCrowdState(input: BuildCrowdStateInput, nowMs: number): CrowdState {
  const qualifies = input.qualifies ?? (() => true);
  const all = (input.envelopes ?? []).filter((e) => CROWD_STATE_CLAIM_TYPES.includes(e.claimType) && qualifies(e, nowMs));

  const refusals: CrowdStateRefusal[] = [];
  const used: LiveClaimEnvelope[] = [];

  // density — the safety level is refused, never promoted to the top of the ladder.
  let density: CrowdDensity | null = null;
  const levelEnv = newest(all.filter((e) => e.claimType === CLAIM_TYPES.level));
  if (levelEnv) {
    const raw = scalar(levelEnv.value, "level");
    if (raw !== null && (SPECIALIST_ONLY_CROWD_LEVELS as readonly string[]).includes(raw)) {
      refusals.push("unsafe_density_is_a_safety_claim");
    } else if (raw !== null && (DENSITY_LADDER as readonly string[]).includes(raw)) {
      density = raw as CrowdDensity;
      used.push(levelEnv);
    } else {
      refusals.push("unrecognised_density");
    }
  }

  // momentum — the intensity axis.
  let momentum: Trajectory | null = null;
  const trajEnv = newest(all.filter((e) => e.claimType === CLAIM_TYPES.trajectory));
  if (trajEnv) {
    const raw = scalar(trajEnv.value, "trajectory");
    if (raw !== null && (TRAJECTORIES as readonly string[]).includes(raw)) {
      momentum = raw as Trajectory;
      used.push(trajEnv);
    } else {
      refusals.push("unrecognised_trajectory");
    }
  }

  // balance — the flow axis. Never derived from the trajectory.
  let balance: CrowdBalance | null = null;
  const dirEnv = newest(all.filter((e) => e.claimType === CLAIM_TYPES.direction));
  if (dirEnv) {
    const raw = scalar(dirEnv.value, "direction");
    if (raw !== null && (CROWD_DIRECTIONS as readonly string[]).includes(raw)) {
      const direction = raw as CrowdDirection;
      balance = { direction, netArrival: NET_ARRIVAL_OF[direction] };
      used.push(dirEnv);
    } else {
      refusals.push("unrecognised_direction");
    }
  }

  const truth = used.length > 0 ? truthOfEnvelopes(used, nowMs) : UNKNOWN_TRUTH;
  const temporal = envelopeTemporal(used, nowMs);

  return {
    basis: "live_claims",
    density,
    momentum,
    balance,
    refusals,
    truth,
    temporal,
    claimRefs: used.map((e) => e.id),
  };
}

/** True when nothing at all is known — every axis null. A caller must not render this as "quiet". */
export function crowdStateIsEmpty(state: CrowdState): boolean {
  return state.density === null && state.momentum === null && state.balance === null;
}
