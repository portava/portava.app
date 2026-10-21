/**
 * layoverMaturity — §22's airport maturity model, and the feature gate the
 * census says is missing.
 *
 * Spec §22 L243–L250. The census's two BUILT-BUT-WRONG verdicts on this
 * section share one sentence: the rungs exist as DATA and gate NOTHING.
 * `airport_profiles.verified` "changes a badge and adds a nudge"; a session on
 * a generic fallback profile "still receives landside recommendations … and a
 * `yes, you can leave` verdict"; and a curated airport and a generic one
 * "present identical confidence".
 *
 * ── THE TWO THINGS THIS MODULE IS ────────────────────────────────────────────
 *   1. A CLASSIFIER. Signals in, one of six rungs out, with the evidence that
 *      put it there.
 *   2. A POLICY. Which features a rung is allowed to offer, and what a surface
 *      must disclose at it.
 *
 * ── AND THE ONE THING IT WAS NOT, UNTIL 2026-09-22 ───────────────────────────
 * THIS BLOCK USED TO READ "IT IS NOT WIRED. Nothing consults `featureAllowedAt`
 * before generating a landside recommendation — that decision lives in
 * `LayoverRecommendationService.ts`, which this work does not own." That is no
 * longer true. `services/airport/layoverMaturityGate.ts` is the consumer, and
 * `generateRecommendations` applies its answer to both landside gates.
 *
 * AFTER 3874, curated profiles enforce L1 in every flag state. Bare airport
 * values carry no provenance and cannot advance the ladder. The upper rungs
 * consume screened fresh official/licensed evidence from the certified live
 * record, the de-identified observation count, and unexpired calibration.
 * The migration, live-signal switch, human curation and real evidence must
 * still exist in a deployment; reachable code does not assert that they do.
 *
 * ── WHY THE LADDER DOES NOT SKIP ─────────────────────────────────────────────
 * A rung is reached only when every rung below it is. "Reliable live signals"
 * (L2) on an airport nobody has mapped (L1) is not L2 intelligence: a live
 * queue figure is only actionable if the topology it applies to is modelled.
 * Letting a single strong signal jump the ladder is how a maturity model starts
 * certifying airports it knows nothing about.
 */
import type { LayoverReasonCode } from "./LayoverSafetyEngine.js";

/**
 * §22's six rungs, in the order the spec lists them. Spelled with the L-number
 * prefix so a log line is readable without the table beside it.
 */
export const AIRPORT_MATURITY_LEVELS = [
  "L0_GENERIC",
  "L1_MAPPED",
  "L2_EXTERNAL_LIVE",
  "L3_PORTAVA_OBSERVED",
  "L4_CALIBRATED",
  "L5_DENSE_LIVE",
] as const;
export type AirportMaturityLevel = (typeof AIRPORT_MATURITY_LEVELS)[number];

const LEVEL_INDEX: Record<AirportMaturityLevel, number> = Object.fromEntries(
  AIRPORT_MATURITY_LEVELS.map((l, i) => [l, i]),
) as Record<AirportMaturityLevel, number>;

/**
 * What a classifier needs to know. Every field is a FACT ABOUT DATA, never a
 * judgement: "does an airport row exist", not "is this airport good".
 */
export interface MaturitySignals {
  /** An `airport_profiles` row addressed to this airport, vs the fallback. */
  hasAirportRow: boolean;
  /** `airport_profiles.verified`. Measured 2026-09-07: TRUE for 0 of 3,206. */
  verified: boolean;
  /** `airport_profiles.terminal_info` carries a topology. Measured: 0 rows do. */
  hasTerminalTopology: boolean;
  /** A modelled transport mode from the airport to the city. */
  hasKnownTransportModel: boolean;
  /** A reliable external live flight/transport/airport feed is connected. */
  hasExternalLiveFeed: boolean;
  /** Recent de-identified Portava operational observations for this airport. */
  portavaObservationCount: number;
  /** Prediction error has been measured and the model calibrated by time band. */
  hasCalibration: boolean;
}

/** Observations below this are anecdotes, not an operational signal. */
export const MIN_PORTAVA_OBSERVATIONS = 20;
/** L5 is DENSE live intelligence, not merely present live intelligence. */
export const DENSE_OBSERVATIONS = 200;

export interface MaturityAssessment {
  level: AirportMaturityLevel;
  /** Which signals put it here, in the order the ladder consulted them. */
  evidence: string[];
  /** The first signal that was absent — why it is not one rung higher. */
  cappedBy: string | null;
}

/**
 * Classify an airport.
 *
 * Walks the ladder from the bottom and stops at the first missing rung. The
 * stop reason is published: "L0, capped by no airport row" is actionable and
 * "L0" alone is not.
 */
export function airportMaturity(signals: MaturitySignals): MaturityAssessment {
  const evidence: string[] = [];

  if (!signals.hasAirportRow) {
    return { level: "L0_GENERIC", evidence, cappedBy: "no airport_profiles row — the buffers are code constants" };
  }
  evidence.push("airport_profiles row exists");

  const mapped =
    signals.verified && signals.hasTerminalTopology && signals.hasKnownTransportModel;
  if (!mapped) {
    const missing = [
      signals.verified ? null : "airport_profiles.verified is false",
      signals.hasTerminalTopology ? null : "airport_profiles.terminal_info carries no topology",
      signals.hasKnownTransportModel ? null : "no modelled airport-to-city transport",
    ].filter(Boolean) as string[];
    return { level: "L0_GENERIC", evidence, cappedBy: missing.join("; ") };
  }
  evidence.push("verified row with terminal topology and a transport model");

  if (!signals.hasExternalLiveFeed) {
    return { level: "L1_MAPPED", evidence, cappedBy: "no external live feed connected" };
  }
  evidence.push("external live feed");

  if (signals.portavaObservationCount < MIN_PORTAVA_OBSERVATIONS) {
    return {
      level: "L2_EXTERNAL_LIVE",
      evidence,
      cappedBy: `only ${signals.portavaObservationCount} Portava observations (need ${MIN_PORTAVA_OBSERVATIONS})`,
    };
  }
  evidence.push(`${signals.portavaObservationCount} Portava observations`);

  if (!signals.hasCalibration) {
    return { level: "L3_PORTAVA_OBSERVED", evidence, cappedBy: "prediction error has never been measured" };
  }
  evidence.push("calibrated against measured prediction error");

  if (signals.portavaObservationCount < DENSE_OBSERVATIONS) {
    return {
      level: "L4_CALIBRATED",
      evidence,
      cappedBy: `observation density ${signals.portavaObservationCount} below ${DENSE_OBSERVATIONS}`,
    };
  }
  evidence.push("dense observation coverage");
  return { level: "L5_DENSE_LIVE", evidence, cappedBy: null };
}

/**
 * Which rungs any airport on this tree can actually reach today, and what
 * blocks the rest.
 *
 * DECLARED SEPARATELY FROM THE CLASSIFIER ON PURPOSE. The classifier must be
 * able to map a hypothetical signal set — otherwise the ladder could not be
 * tested at all, and a ladder whose upper rungs are untestable is a ladder
 * whose upper rungs are decoration. What "unreachable" means here is narrower
 * and checkable: NO PRODUCER ON THIS TREE SETS THAT SIGNAL.
 */
export const MATURITY_LEVEL_REACHABILITY: Record<
  AirportMaturityLevel,
  { reachable: boolean; blockedBy: string | null }
> = {
  L0_GENERIC: { reachable: true, blockedBy: null },
  L1_MAPPED: {
    // Reachable in principle — the columns exist. Measured 2026-09-07: 0 of
    // 3,206 production rows are verified and 0 carry terminal_info, so no
    // production airport is on this rung today.
    reachable: true,
    blockedBy: null,
  },
  L2_EXTERNAL_LIVE: {
    reachable: true,
    blockedBy: null,
  },
  L3_PORTAVA_OBSERVED: {
    // CORRECTED 2026-09-22. This entry used to read `reachable: false`, blocked
    // by "no observation ingest writer … no route accepts one and no table
    // stores one". Both clauses are FALSE at this commit:
    // `POST /airport/sessions/:id/observations` accepts one (its only gate is
    // `airport_mode_enabled`, TRUE in production), `airport_fact_observations`
    // stores it, and migrations 2860 and 2982 are BOTH APPLIED to production.
    // The signal reaches this ladder through
    // `LayoverObservationAggregate.maturityObservationCount`.
    //
    // Reachable does NOT mean reached. The ladder does not skip, so no airport
    // gets here until it is L2 — and L2 is still blocked below.
    reachable: true,
    blockedBy: null,
  },
  L4_CALIBRATED: {
    reachable: true,
    blockedBy: null,
  },
  L5_DENSE_LIVE: {
    reachable: true,
    blockedBy: null,
  },
};

export interface MaturityFeature {
  feature: string;
  minimumLevel: AirportMaturityLevel;
  why: string;
}

/**
 * L249 — which features a rung may offer.
 *
 * THE LINE THAT MATTERS IS `landside_recommendations` AT L1. Spec §22 L243
 * says L0 Generic is "airport-side guidance only by default", and the census
 * records the divergence: a generic-fallback airport issues landside cards and
 * a "yes, you can leave" verdict off constants that are not about that airport.
 * `layoverMaturityGate.ts` now consults this table on every generation — the
 * sentence that used to stand here, "nothing consults this table", is false as
 * of 2026-09-22 — but the gate is seeded FALSE, so the divergence is closable
 * rather than closed.
 */
export const MATURITY_FEATURES: readonly MaturityFeature[] = [
  {
    feature: "airside_guidance",
    minimumLevel: "L0_GENERIC",
    why: "terminal advice needs no airport-specific intelligence and is the L0 product.",
  },
  {
    feature: "window_and_deadline",
    minimumLevel: "L0_GENERIC",
    why: "the conservative generic timing IS the L0 offering; withholding it would leave nothing.",
  },
  {
    feature: "maturity_disclosure",
    minimumLevel: "L0_GENERIC",
    why: "L250 — 'limited intelligence' must be sayable at the rung where it applies.",
  },
  {
    feature: "landside_recommendations",
    minimumLevel: "L1_MAPPED",
    why: "L243 — leaving the airport needs a modelled airport and a modelled way back.",
  },
  {
    feature: "routed_travel_estimates",
    minimumLevel: "L1_MAPPED",
    why: "a routed estimate needs the transport model L1 asserts.",
  },
  {
    feature: "live_condition_buffers",
    minimumLevel: "L2_EXTERNAL_LIVE",
    why: "folding an observed queue into a deadline requires the feed to be reliable.",
  },
  {
    feature: "community_observations",
    minimumLevel: "L3_PORTAVA_OBSERVED",
    why: "trust-weighting needs a corpus to weigh against.",
  },
  {
    feature: "calibrated_percentiles",
    minimumLevel: "L4_CALIBRATED",
    why: "a percentile above p50 is a claim about a distribution nobody has measured below L4.",
  },
  {
    feature: "dynamic_replanning",
    minimumLevel: "L5_DENSE_LIVE",
    why: "L248 — high-confidence replanning needs dense live intelligence; replanning on sparse signals moves a traveller's deadline on noise.",
  },
];

const FEATURE_INDEX = new Map(MATURITY_FEATURES.map((f) => [f.feature, f]));

/**
 * May this feature be offered at this rung?
 *
 * FAILS CLOSED. An undeclared feature is refused at every level rather than
 * permitted: a gate whose default is "allow" is not a gate, and the failure
 * mode is silent — a new feature ships ungated and nobody sees a refusal.
 */
export function featureAllowedAt(feature: string, level: AirportMaturityLevel): boolean {
  const def = FEATURE_INDEX.get(feature);
  if (!def) return false;
  return LEVEL_INDEX[level] >= LEVEL_INDEX[def.minimumLevel];
}

export interface MaturityDisclosure {
  headline: string;
  detail: string;
  /** Coarse confidence word a surface may show beside the numbers. */
  confidence: "limited" | "basic" | "good" | "high";
  /** Appendix A code, when the rung is one a traveller should be warned about. */
  reasonCode: LayoverReasonCode | null;
}

/**
 * L250 — what a surface must be able to say at this rung.
 *
 * Every rung gets a DIFFERENT headline and a different confidence word. That is
 * the whole requirement: the census's L250 divergence is not that the product
 * lies, it is that "a curated airport and a generic-fallback one present
 * identical confidence", so the honest disclaimer the product already shows
 * carries no information about THIS airport.
 */
export function maturityDisclosure(level: AirportMaturityLevel): MaturityDisclosure {
  switch (level) {
    case "L0_GENERIC":
      return {
        headline: "Limited intelligence for this airport",
        detail:
          "These timings are conservative defaults that are not specific to this airport — nobody has " +
          "measured its terminals, its transport or its queues.",
        confidence: "limited",
        reasonCode: "AIRPORT_MATURITY_LIMITED",
      };
    case "L1_MAPPED":
      return {
        headline: "This airport is mapped",
        detail:
          "Terminal layout and the way into the city are modelled for this airport, but nothing live is " +
          "being read right now.",
        confidence: "basic",
        reasonCode: "AIRPORT_MATURITY_LIMITED",
      };
    case "L2_EXTERNAL_LIVE":
      return {
        headline: "Live signals available",
        detail: "Live flight and transport signals are being read for this airport.",
        confidence: "good",
        reasonCode: null,
      };
    case "L3_PORTAVA_OBSERVED":
      return {
        headline: "Recently observed by travellers",
        detail:
          "Recent operational observations from Portava travellers at this airport are folded into these " +
          "timings.",
        confidence: "good",
        reasonCode: null,
      };
    case "L4_CALIBRATED":
      return {
        headline: "Calibrated for this airport and time of day",
        detail:
          "These timings have been checked against what actually happened here, and corrected by airport " +
          "and time band.",
        confidence: "high",
        reasonCode: null,
      };
    case "L5_DENSE_LIVE":
      return {
        headline: "Dense live intelligence",
        detail:
          "This airport has continuous live coverage, so plans here are re-checked as conditions change.",
        confidence: "high",
        reasonCode: null,
      };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYOVER 165, lane B2-CURATE (2026-10-18) — the rung is computed from CURATED,
// VALIDATED, UNEXPIRED data, and the landside threshold is ENFORCED.
//
// Owner decision 2026-10-18: "Restrict airport-specific recommendations to
// airports whose data meets the required maturity threshold" and "Unknown or
// conflicting critical safety information must fail closed". Spec §22 L243: L0
// Generic is "airport-side guidance only by default". So the threshold below
// holds in EVERY flag state: `layover_maturity_gate_enabled` (2977) can no longer
// relax it (see layoverMaturityGate.ts).
//
// The L0/L1 boundary needs no I/O: §22 L1 is "Terminal/topology and known
// transport modeled", and with 3874 that is three PUBLISHED, UNEXPIRED curated
// facts (timing assumptions, terminal topology, ground transport) that the
// airport row already projects. So the landside decision is a pure function of
// the profile and an instant, and it is a NAMED INPUT of the certified record
// (`FeasibilityInputs.maturity`): replay reproduces it, the input hash moves
// when an authoritative change moves it, and every surface that reads the
// record — the dashboard, Compass, the map, the recommendation list, the
// lifecycle guard — reads the same closure.
// ═════════════════════════════════════════════════════════════════════════════

import { curatedLive, type AirportCurationProjection } from "./airportCurationPolicy.js";

/** The rung the landside threshold names. `landside_recommendations` sits here (MATURITY_FEATURES). */
export const LANDSIDE_MATURITY_THRESHOLD: AirportMaturityLevel = "L1_MAPPED";

/** What the certified record carries about the airport's maturity. Part of `inputHash`. */
export interface LandsideMaturityInput {
  /** The rung as far as the landside threshold can see it: L0, or L1 (= "L1 or above"). */
  rung: "L0_GENERIC" | "L1_MAPPED";
  /** featureAllowedAt("landside_recommendations", rung). */
  landsideAllowed: boolean;
  /** Why it is not one rung higher, or null at L1. */
  cappedBy: string | null;
  /** Which of the three L1 facts are published and unexpired at the record's instant. */
  curated: { timing: boolean; topology: boolean; transport: boolean };
  /** 3874's topology_version: an authoritative change moves it, and with it the record's hash. */
  topologyVersion: number;
}

/** §22's signals from the curation projection, at an instant. The upper rungs' signals are supplied by the caller. */
export function curatedMaturitySignals(
  airport: { id: string | null | undefined; curation: AirportCurationProjection },
  nowMs: number,
  upper: { hasExternalLiveFeed?: boolean; portavaObservationCount?: number } = {},
): MaturitySignals {
  const c = airport.curation;
  return {
    hasAirportRow: airport.id !== null && airport.id !== undefined,
    verified: curatedLive(c.timing, nowMs),
    hasTerminalTopology: curatedLive(c.topology, nowMs),
    hasKnownTransportModel: curatedLive(c.transport, nowMs),
    hasExternalLiveFeed: upper.hasExternalLiveFeed ?? false,
    portavaObservationCount: upper.portavaObservationCount ?? 0,
    hasCalibration: c.calibration !== null && Date.parse(c.calibration.expiresAt) > nowMs,
  };
}

/** Plain words for the missing L1 facts (the curated reading of `airportMaturity`'s cap). */
export function curatedCappedBy(s: MaturitySignals): string | null {
  if (!s.hasAirportRow) return "no airport_profiles row — the buffers are code constants";
  const missing = [
    s.verified ? null : "no published, unexpired timing assumptions",
    s.hasTerminalTopology ? null : "no published, unexpired terminal topology",
    s.hasKnownTransportModel ? null : "no published, unexpired ground-transport model",
  ].filter(Boolean) as string[];
  return missing.length > 0 ? missing.join("; ") : null;
}

/**
 * The record's maturity input, or `undefined` for a profile that carries no
 * curation projection (a hand-built object: the legacy arm, which no production
 * mapper produces — `AirportProfileService` sets `curation` on every profile).
 */
export function landsideMaturityInput(
  airport: { id: string | null | undefined; curation?: AirportCurationProjection | null },
  nowMs: number,
): LandsideMaturityInput | undefined {
  if (!airport.curation) return undefined;
  const signals = curatedMaturitySignals({ id: airport.id, curation: airport.curation }, nowMs);
  const mapped = airportMaturity({ ...signals, hasExternalLiveFeed: false, portavaObservationCount: 0, hasCalibration: false });
  const rung = mapped.level === "L1_MAPPED" ? "L1_MAPPED" : "L0_GENERIC";
  return {
    rung,
    landsideAllowed: featureAllowedAt("landside_recommendations", rung),
    cappedBy: rung === "L1_MAPPED" ? null : curatedCappedBy(signals),
    curated: { timing: signals.verified, topology: signals.hasTerminalTopology, transport: signals.hasKnownTransportModel },
    topologyVersion: airport.curation.topologyVersion,
  };
}

/** The sentence a traveller reads when the airport's data maturity closes landside (Appendix A AIRPORT_MATURITY_LIMITED). */
export const MATURITY_LIMITED_REASON =
  "We don't have checked information about this airport's terminals, transport and timings yet, so we only suggest things to do inside the airport.";
