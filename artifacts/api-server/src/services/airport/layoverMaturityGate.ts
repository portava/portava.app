/**
 * layoverMaturityGate — §22 L249's missing consumer.
 *
 * `layoverMaturity.ts` has carried this sentence about itself since it was
 * written: *"IT IS NOT WIRED. Nothing consults `featureAllowedAt` before
 * generating a landside recommendation — that decision lives in
 * `LayoverRecommendationService.ts`, which this work does not own."*
 * census-layover L249 scores the same absence NOT-BUILT.
 *
 * This module is the consumer. It turns an `AirportProfile` plus the airport's
 * own de-identified observation count into one of the spec's six rungs, asks
 * `featureAllowedAt` whether that rung may offer a landside recommendation, and
 * hands the answer — with its evidence — to `generateRecommendations`.
 *
 * ── IT IS SEEDED OFF, AND OFF IS THE WHOLE PRODUCT TODAY ─────────────────────
 * `layover_maturity_gate_enabled` is created FALSE by migration 2977 and can
 * only be changed through `toggle_feature_flag_with_audit`. That is not
 * timidity; it is the shape of the decision. Production holds 3,206
 * `airport_profiles` rows, of which **0 are verified and 0 carry
 * `terminal_info`** — so every single one classifies `L0_GENERIC`, and
 * `MATURITY_FEATURES` puts `landside_recommendations` at `L1_MAPPED`. Turning
 * this flag on withdraws the landside half of the Layover product from every
 * airport on earth until somebody curates one.
 *
 * That withdrawal is EXACTLY what spec §22 L243 asks for — "airport-side
 * guidance only by default" — and census L243 has scored the divergence
 * BUILT-BUT-WRONG for as long as the row has existed. It is still an owner's
 * decision about what travellers are shown, so the code makes it POSSIBLE and
 * does not make it.
 *
 * ── WITH THE FLAG OFF, NOTHING IS READ ───────────────────────────────────────
 * Not "the answer is discarded" — the observation corpus is not queried at all.
 * `generateRecommendations` runs on the dashboard's hot path; a gate that costs
 * a round trip per load while changing nothing is a cost with no buyer, and it
 * would also make the gate's own performance profile depend on a flag whose
 * whole claim is that it changes nothing.
 *
 * The CLASSIFICATION still happens, because it is free — every signal but the
 * observation count is a field already in hand — and because L250 ("do not
 * imply equivalent intelligence globally") is a different requirement from
 * L249. A surface may want to SAY which rung it is on while the enforcement is
 * off. Withholding the rung because enforcement is off would conflate the two.
 *
 * ── AN OUTAGE MAY NOT PROMOTE, AND MAY NOT DEMOTE EITHER ─────────────────────
 * An unreadable corpus counts as ZERO observations, never as "assume the rung".
 * A rung claimed on a corpus nobody could read is a claim about an airport
 * nobody has observed, which is the failure the ladder exists to prevent.
 *
 * It is equally not allowed to take away a rung the airport had already earned
 * on other evidence: the count is one signal among seven, the ladder does not
 * skip, and an airport that is L1 on its own `airport_profiles` row stays L1
 * through an observation outage. `signalsReadable: false` is published so the
 * difference between "zero reports" and "could not ask" is visible to the
 * caller rather than collapsed — the defect census-layover has recorded four
 * times on this domain.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { enablementRefusal } from "../../lib/providers/providerRefusal.js";
import { ENABLEMENT_ENV } from "../../lib/providers/googleRoutesCorridorProvider.js";
import { readAirportObservationAggregate } from "../layover/LayoverObservationAggregate.js";
import type { AirportProfile } from "./AirportProfileService.js";
import {
  airportMaturity,
  featureAllowedAt,
  maturityDisclosure,
  type AirportMaturityLevel,
  type MaturityDisclosure,
  type MaturitySignals,
} from "./layoverMaturity.js";

const logger = rootLogger.child({ service: "layoverMaturityGate" });

/**
 * Literal name so `check-flag-polarity` resolves the read. `*_enabled` ⇒ a
 * CAPABILITY gate, fail-closed: an unreadable `feature_flags` leaves it off.
 *
 * Off means "do not enforce the maturity policy", which is the behaviour every
 * database has today. Seeded by `2977_layover_maturity_gate_flag.sql`.
 */
export const LAYOVER_MATURITY_GATE_FLAG = "layover_maturity_gate_enabled";

/** The §22 feature name this gate decides. Declared in `MATURITY_FEATURES`. */
export const LANDSIDE_FEATURE = "landside_recommendations";

export interface LandsideMaturityDecision {
  /** Was the gate actually enforcing? False on every database today. */
  flagOn: boolean;
  level: AirportMaturityLevel;
  /** May a landside recommendation be offered? True whenever `flagOn` is false. */
  allowed: boolean;
  /** The first signal the ladder found missing. Why it is not one rung higher. */
  cappedBy: string | null;
  /** L250 — what a surface may say about THIS airport's intelligence. */
  disclosure: MaturityDisclosure;
  /**
   * The corroborated observation count the ladder read, or `null` when the gate
   * was off and nothing was read. `0` with `signalsReadable: false` means the
   * corpus could not be asked — a different fact from an airport nobody has
   * reported from.
   */
  observationCount: number | null;
  signalsReadable: boolean;
}

/**
 * Is there a modelled way from this airport into its city?
 *
 * Asked of the ROUTED CORRIDOR's own enablement gate rather than guessed from
 * the airport row, because that gate is the only thing on this tree that can
 * produce a transport model at all: `LAYOVER_TRAVEL_TIME_PROVIDER` is a
 * corridor adapter that refuses with `PROVIDER_NOT_ENABLED` before a request
 * body is built unless `LAYOVER_ROUTED_CORRIDOR_ENABLED` is affirmative. It is
 * affirmative nowhere, so this is `false` everywhere — which is why `L1_MAPPED`
 * is unreachable in practice even for an airport somebody verifies.
 *
 * Reading the same env var through the same helper, rather than re-parsing it,
 * is what keeps "the provider will answer" and "we claim a transport model"
 * from drifting into disagreement.
 */
export function routedTransportModelAvailable(): boolean {
  return enablementRefusal("layoverMaturityGate", ENABLEMENT_ENV) === null;
}

/**
 * `MaturitySignals` for one airport.
 *
 * Every field is a FACT ABOUT DATA and two of them are hard-coded FALSE with a
 * reason, which is the honest form of a signal nothing produces:
 *
 *   `hasExternalLiveFeed` — nothing on this tree produces `LiveConditions`
 *     outside tests and `airport_profiles` has no feed-reference column.
 *   `hasCalibration` — `measureCalibration` measures error and adjusts
 *     nothing, and no prediction and outcome are stored together to measure.
 *
 * Both are overridable ONLY through `overrides`, which exists so the ladder's
 * upper rungs stay testable. A ladder whose upper rungs cannot be exercised is
 * a ladder whose upper rungs are decoration.
 */
export function maturitySignalsFor(
  airport: AirportProfile,
  opts: {
    observationCount: number;
    routedTransportModelAvailable?: boolean;
    hasExternalLiveFeed?: boolean;
    hasCalibration?: boolean;
  },
): MaturitySignals {
  const topology = airport.terminalInfo;
  return {
    hasAirportRow: airport.id !== null && airport.id !== undefined,
    verified: airport.verified === true,
    // `terminal_info` DEFAULTS to `'{}'` and all 3,206 production rows carry
    // that default. An empty object is the ABSENCE of a topology, not a small
    // one, and treating it as data is how every airport would silently promote.
    hasTerminalTopology:
      topology !== null && topology !== undefined && Object.keys(topology).length > 0,
    hasKnownTransportModel:
      opts.routedTransportModelAvailable ?? routedTransportModelAvailable(),
    hasExternalLiveFeed: opts.hasExternalLiveFeed ?? false,
    portavaObservationCount: opts.observationCount,
    hasCalibration: opts.hasCalibration ?? false,
  };
}

function decide(
  signals: MaturitySignals,
  flagOn: boolean,
  observationCount: number | null,
  signalsReadable: boolean,
): LandsideMaturityDecision {
  const { level, cappedBy } = airportMaturity(signals);
  return {
    flagOn,
    level,
    // OFF is ALLOW, unconditionally and by construction: the enforcement half
    // of this module is the only half the flag governs.
    allowed: flagOn ? featureAllowedAt(LANDSIDE_FEATURE, level) : true,
    cappedBy,
    disclosure: maturityDisclosure(level),
    observationCount,
    signalsReadable,
  };
}

/**
 * May this airport offer landside recommendations, and on what evidence?
 *
 * The one entry point. `generateRecommendations` calls it once per request and
 * applies `allowed` to both landside gates — the Discovery candidates and the
 * city-escape card — so the two cannot come to different conclusions about the
 * same airport.
 */
export async function landsideMaturityDecision(
  db: SupabaseClient,
  airport: AirportProfile,
  nowMs: number,
  overrides: {
    routedTransportModelAvailable?: boolean;
    hasExternalLiveFeed?: boolean;
    hasCalibration?: boolean;
  } = {},
): Promise<LandsideMaturityDecision> {
  let flagOn = false;
  try {
    flagOn = await isFlagEnabled(db as any, LAYOVER_MATURITY_GATE_FLAG);
  } catch {
    flagOn = false;
  }

  if (!flagOn) {
    // No corpus read. See the header: off must cost nothing.
    return decide(
      maturitySignalsFor(airport, { observationCount: 0, ...overrides }),
      false,
      null,
      true,
    );
  }

  const airportRef = observationAirportRef(airport);
  if (airportRef === null) {
    // The generic fallback profile. There is no airport to have been observed,
    // and pooling every unidentified airport's reports under one ref is what
    // the route already refuses to do.
    return decide(
      maturitySignalsFor(airport, { observationCount: 0, ...overrides }),
      true,
      0,
      true,
    );
  }

  const read = await readAirportObservationAggregate(db, airportRef, airport.timezone, nowMs);
  if (!read.ok) {
    logger.warn(
      { airportRef },
      "maturity gate: observation aggregate unreadable — the rung is computed with ZERO observations, never assumed",
    );
    return decide(
      maturitySignalsFor(airport, { observationCount: 0, ...overrides }),
      true,
      0,
      false,
    );
  }

  const count = read.aggregate.maturityObservationCount;
  return decide(maturitySignalsFor(airport, { observationCount: count, ...overrides }), true, count, true);
}

/**
 * The string an observation about this airport is filed under.
 *
 * Same rule as the submission route: IATA when there is one, the profile id
 * otherwise, and `null` for the generic fallback — `UNK` is not an airport, it
 * is the absence of one.
 */
function observationAirportRef(airport: AirportProfile): string | null {
  if (airport.iataCode && airport.iataCode !== "UNK") return airport.iataCode;
  if (airport.id) return airport.id;
  return null;
}
