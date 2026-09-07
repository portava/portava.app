/**
 * experienceTruth — the §5.1 truth block every server-built state carries, and
 * the ONE rule for composing several of them: weakest on every axis.
 *
 * ── WHY THIS IS NOT AN ExperienceState ───────────────────────────────────────
 * The §5.3 ExperienceState SHAPE for the Map is owned by lib/mapExperienceState
 * .ts (a pure fold over the live claims the gateway already reads). A second
 * shape here would be exactly the parallel contract §1 forbids, so this module
 * owns only what that fold — and any other producer — needs and does not
 * have: the metadata block, and the fail-weak composition of it.
 *
 * ── THE TRUTH RULE ───────────────────────────────────────────────────────────
 * When several facts feed one state, the state's truth is the WEAKEST of its
 * parts on every axis: weakest truth class (lib/truthClass), weakest
 * confidence band, oldest freshness, least coverage. Never the strongest,
 * never an average, never a vote. A predicted vibe folded onto an observed
 * crowd yields a PREDICTED composite; a surface that wants to show the crowd
 * as observed must show the crowd facet, which keeps its own block. This is
 * §20 "Inference confidence may only decrease through conflict unless new
 * evidence supports an increase" applied to composition, and the rule
 * lib/mapAggregation already applies to bands ("silence must not be read as
 * agreement").
 *
 * Note for the Map's fold: lib/mapExperienceState.foldCoverage takes the
 * WIDEST bucket any consensus-eligible claim carries — a per-SUBJECT reading
 * of "how much evidence is behind this place at all". composeTruth takes the
 * NARROWEST — a per-COMPOSITE reading of "how much evidence is behind this
 * combined value". Both are defensible for their question; they are recorded
 * here so nobody mistakes one for the other.
 *
 * PURE. No I/O, no clock, no labels for any number.
 */
import { CONFIDENCE_BANDS, type ConfidenceBand } from "./intelContracts.js";
import { FRESHNESS_STATES, type FreshnessState } from "./mapObjects.js";
import {
  weakestCoverage,
  weakestTruthClass,
  type CoverageBucket,
  type TruthClass,
} from "./truthClass.js";

/** §5.1's four fields plus provenance. */
export interface TruthMetadata {
  truthClass: TruthClass;
  confidence: ConfidenceBand;
  freshness: FreshnessState;
  coverage: CoverageBucket;
  /** Producer identifiers, e.g. "sensing_anon", "sensing_vibe_v1". Never a person. */
  provenance: readonly string[];
}

/**
 * §18.2's shared temporal semantics — observed_at · effective_from ·
 * effective_until · expires_at · freshness · predicted_for — as ONE envelope
 * any server-built state can carry. Census S110 found four of the six in the
 * tree and `effective_from`, `effective_until`, `predicted_for` nowhere, which
 * is why a forecast had no horizon (S45). "Use shared semantics where possible;
 * do not force all domains into one table" — this is the shared semantics, not
 * a table.
 *
 * Every field but freshness is nullable: absent is a fact. The one rule that is
 * enforced rather than documented: `predictedFor` is set IF AND ONLY IF the
 * state's truth class is `predicted` (§2 "Prediction ≠ current truth";
 * §5.1 "Prediction must never be rendered indistinguishably from observation").
 */
export interface TemporalEnvelope {
  /** When reality was observed (ISO), or null when nothing was. */
  observedAt: string | null;
  /** The window this state describes. */
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  /** When the state must no longer be served as current. */
  expiresAt: string | null;
  freshness: FreshnessState;
  /** The future instant a PREDICTED state is about. Null for anything observed or inferred. */
  predictedFor: string | null;
}

export type TemporalIncoherence =
  | "predicted_for_without_predicted_class"
  | "predicted_class_without_predicted_for"
  | "effective_window_inverted"
  | "expires_before_effective_until"
  | "unparseable_instant";

const ms = (s: string | null): number | null => {
  if (s === null) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
};

/**
 * The envelope's invariants. Returns the first violation, or null when
 * coherent. A producer that emits an incoherent envelope has a bug; a consumer
 * that receives one must treat the state as unknown, never as current.
 */
export function temporalIncoherence(t: TemporalEnvelope, truthClass: TruthClass): TemporalIncoherence | null {
  if (!t) return "unparseable_instant";
  const vals = [t.observedAt, t.effectiveFrom, t.effectiveUntil, t.expiresAt, t.predictedFor].map(ms);
  if (vals.some((v) => Number.isNaN(v))) return "unparseable_instant";
  const [, from, until, expires, predictedFor] = vals;
  if (predictedFor !== null && truthClass !== "predicted") return "predicted_for_without_predicted_class";
  if (predictedFor === null && truthClass === "predicted") return "predicted_class_without_predicted_for";
  if (from !== null && until !== null && from > until) return "effective_window_inverted";
  if (expires !== null && until !== null && expires < until) return "expires_before_effective_until";
  return null;
}

/** The floor. What an absent part contributes, and what an empty composite is. */
export const UNKNOWN_TRUTH: TruthMetadata = Object.freeze({
  truthClass: "unknown",
  confidence: "unverified",
  freshness: "unknown",
  coverage: "unknown",
  provenance: [],
}) as TruthMetadata;

function bandRank(b: ConfidenceBand): number {
  const i = (CONFIDENCE_BANDS as readonly string[]).indexOf(b);
  return i < 0 ? 0 : i;
}

/** Weakest confidence band. Empty / null / unrecognised ⇒ `unverified`. */
export function weakestConfidenceBand(bands: ReadonlyArray<ConfidenceBand | null | undefined>): ConfidenceBand {
  let weakest: ConfidenceBand | null = null;
  for (const b of bands) {
    const band: ConfidenceBand = b != null && (CONFIDENCE_BANDS as readonly string[]).includes(b) ? b : "unverified";
    if (weakest === null || bandRank(band) < bandRank(weakest)) weakest = band;
  }
  return weakest ?? "unverified";
}

/**
 * Freshness rank, oldest-first. `unknown` is the floor (nothing is known
 * about when), then historical … live. FRESHNESS_STATES lists them
 * freshest-first, so the rank is the reversed index with `unknown` pinned at 0.
 */
function freshnessRank(f: FreshnessState): number {
  if (f === "unknown") return 0;
  const i = (FRESHNESS_STATES as readonly string[]).indexOf(f);
  return i < 0 ? 0 : FRESHNESS_STATES.length - 1 - i;
}

/** Oldest freshness. Empty / null / unrecognised ⇒ `unknown`. */
export function weakestFreshness(states: ReadonlyArray<FreshnessState | null | undefined>): FreshnessState {
  let weakest: FreshnessState | null = null;
  for (const f of states) {
    const state: FreshnessState = f != null && (FRESHNESS_STATES as readonly string[]).includes(f) ? f : "unknown";
    if (weakest === null || freshnessRank(state) < freshnessRank(weakest)) weakest = state;
  }
  return weakest ?? "unknown";
}

/**
 * Compose several truth blocks into one: weakest on every axis, provenance
 * unioned and sorted. Nulls are skipped (an absent part is absent, not
 * unknown); an empty set is the floor.
 */
export function composeTruth(parts: ReadonlyArray<TruthMetadata | null | undefined>): TruthMetadata {
  const present = parts.filter((p): p is TruthMetadata => p != null);
  if (present.length === 0) return UNKNOWN_TRUTH;
  return {
    truthClass: weakestTruthClass(present.map((p) => p.truthClass)),
    confidence: weakestConfidenceBand(present.map((p) => p.confidence)),
    freshness: weakestFreshness(present.map((p) => p.freshness)),
    coverage: weakestCoverage(present.map((p) => p.coverage)),
    provenance: Array.from(new Set(present.flatMap((p) => p.provenance ?? []))).sort(),
  };
}
