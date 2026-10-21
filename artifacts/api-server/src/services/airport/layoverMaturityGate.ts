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
 * ── CORRECTED 2026-10-18 (LAYOVER 165, lane B2-CURATE): ENFORCED, NOT FLAGGED ─
 * This block used to say the gate sat behind `layover_maturity_gate_enabled`
 * (2977, seeded FALSE), that OFF meant ALLOW, and that turning it on was an
 * owner decision. The owner made it on 2026-10-18: "Restrict airport-specific
 * recommendations to airports whose data meets the required maturity
 * threshold", and "Unknown or conflicting critical safety information must
 * fail closed". So the threshold (`landside_recommendations` at L1_MAPPED,
 * spec §22 L243 "airport-side guidance only by default") is ENFORCED in every
 * flag state; the flag is read only to record its value in the audit event.
 *
 * And the rung is no longer read off bare columns. With migration 3874 an
 * airport is L1 only when its timing assumptions, terminal topology and ground
 * transport are PUBLISHED, VALIDATED and UNEXPIRED curated facts
 * (`airportCurationPolicy`, `airport_curated_facts`); the bare `verified` and
 * `terminal_info` values carry no provenance and count for nothing. Production
 * has no curated airport today, so every production airport is L0 and offers
 * airport-side guidance only until a human curator validates and publishes its
 * facts. That is the honest state, and it is the owner's decision.
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
import type { LiveConditions } from "./LayoverSafetyEngine.js";
import { hasFreshAuthoritativeLiveEvidence } from "./layoverLiveMaturity.js";
import { readValue, readDegraded, type LayoverRead } from "../layover/layoverRead.js";
import {
  airportMaturity,
  curatedCappedBy,
  curatedMaturitySignals,
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
 * After 3874 this is audit-only; the curated threshold holds in every flag
 * state. Unmigrated database rows retain the legacy flag-governed policy.
 */
export const LAYOVER_MATURITY_GATE_FLAG = "layover_maturity_gate_enabled";

/** The §22 feature name this gate decides. Declared in `MATURITY_FEATURES`. */
export const LANDSIDE_FEATURE = "landside_recommendations";

export interface LandsideMaturityDecision {
  /**
   * The value of `layover_maturity_gate_enabled` at this instant — RECORDED FOR
   * AUDIT ONLY. Since 2026-10-18 the threshold is enforced in every flag state.
   */
  flagOn: boolean;
  level: AirportMaturityLevel;
  /** May a landside recommendation be offered? featureAllowedAt(landside, level), in every flag state. */
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
    /** The instant curated facts are judged at. Required for a curated profile (expiry is a fact about NOW). */
    nowMs?: number;
  },
): MaturitySignals {
  // LAYOVER 165 B2-CURATE: a profile from AirportProfileService carries its
  // curation projection, and THEN every L1 signal is a published, unexpired,
  // validated fact — never the bare `verified` / `terminal_info` columns, which
  // carry no provenance (census L14). The routed-provider shortcut below no
  // longer counts for such a profile: a provider being switched on says nothing
  // about THIS airport's transport.
  if (airport.curation) {
    const s = curatedMaturitySignals({ id: airport.id, curation: airport.curation }, opts.nowMs ?? Number.NaN, {
      hasExternalLiveFeed: opts.hasExternalLiveFeed,
      portavaObservationCount: opts.observationCount,
    });
    return opts.hasCalibration === undefined ? s : { ...s, hasCalibration: opts.hasCalibration };
  }
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
  curated: boolean,
): LandsideMaturityDecision {
  const { level, cappedBy } = airportMaturity(signals);
  return {
    flagOn,
    level,
    // ENFORCED IN EVERY FLAG STATE after migration 3874 supplies the curation
    // projection (owner decision 2026-10-18; spec §22 L243). Static and fallback
    // profiles are explicitly uncurated and therefore restricted too.
    // The migration press is required: an unmigrated database row or a legacy
    // hand-built fixture has no projection and retains the old flag policy.
    // `flagOn` is recorded for audit; it does not relax a curated profile.
    // No stored bare `verified` value can substitute for published provenance.
    allowed: curated || flagOn ? featureAllowedAt(LANDSIDE_FEATURE, level) : true,
    // A curated profile's L0 cap names the missing CURATED facts, not bare columns.
    cappedBy: curated && level === "L0_GENERIC" && signals.hasAirportRow ? (curatedCappedBy(signals) ?? cappedBy) : cappedBy,
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
 * same airport. The certified record carries the same threshold as a NAMED
 * INPUT (`FeasibilityInputs.maturity`, layoverMaturity.landsideMaturityInput),
 * so every other surface reads the same answer off the record.
 *
 * ── LAYOVER 165 B2-CURATE: THE FLAG NO LONGER RELAXES IT ─────────────────────
 * `layover_maturity_gate_enabled` (2977) used to make OFF mean ALLOW. Under the
 * owner's 2026-10-18 decision ("restrict airport-specific recommendations to
 * airports whose data meets the required maturity threshold"; unknown critical
 * safety information fails closed) the threshold holds whatever the flag says:
 * absent, FALSE, TRUE or unreadable. The flag is still read, and its value is
 * published as `flagOn` for the audit event, so a stored card says which regime
 * produced it; it has no other effect.
 *
 * The observation corpus is read on every call now (it is what lets the count
 * reach the ladder, census L246). An unreadable corpus is ZERO observations
 * with `signalsReadable: false` — never an assumed rung — and a read that
 * throws is the same answer.
 */
export async function landsideMaturityDecision(
  db: SupabaseClient,
  airport: AirportProfile,
  nowMs: number,
  overrides: {
    routedTransportModelAvailable?: boolean;
    hasExternalLiveFeed?: boolean;
    hasCalibration?: boolean;
    liveConditions?: LiveConditions | null;
  } = {},
): Promise<LayoverRead<LandsideMaturityDecision>> {
  const evidence = { ...overrides, hasExternalLiveFeed: overrides.hasExternalLiveFeed ?? hasFreshAuthoritativeLiveEvidence(overrides.liveConditions, nowMs) };
  let flagOn = false;
  try {
    flagOn = await isFlagEnabled(db as any, LAYOVER_MATURITY_GATE_FLAG);
  } catch {
    flagOn = false;
  }

  if (!airport.curation && !flagOn) {
    // The LEGACY arm (an unmigrated DB row or hand-built fixture) with the
    // flag off: exactly the old behaviour — allow, and read no corpus.
    return readValue(decide(maturitySignalsFor(airport, { observationCount: 0, nowMs, ...evidence }), false, null, true, false));
  }

  const airportRef = observationAirportRef(airport);
  if (airportRef === null) {
    // The generic fallback profile. There is no airport to have been observed,
    // and pooling every unidentified airport's reports under one ref is what
    // the route already refuses to do.
    return readValue(decide(maturitySignalsFor(airport, { observationCount: 0, nowMs, ...evidence }), flagOn, 0, true, Boolean(airport.curation)));
  }

  let read: Awaited<ReturnType<typeof readAirportObservationAggregate>>;
  try {
    read = await readAirportObservationAggregate(db, airportRef, airport.timezone, nowMs);
  } catch (err) {
    logger.warn({ err, airportRef }, "maturity gate: observation aggregate threw — the rung is computed with ZERO observations, never assumed");
    return readDegraded(decide(maturitySignalsFor(airport, { observationCount: 0, nowMs, ...evidence }), flagOn, 0, false, Boolean(airport.curation)), ["maturity_observations_read_threw"]);
  }
  if (!read.ok) {
    logger.warn(
      { airportRef, reason: read.reason },
      "maturity gate: observation aggregate unreadable — the rung is computed with ZERO observations, never assumed",
    );
    return readDegraded(decide(maturitySignalsFor(airport, { observationCount: 0, nowMs, ...evidence }), flagOn, 0, false, Boolean(airport.curation)), [`maturity_observations_${read.reason}`]);
  }

  const count = read.aggregate.maturityObservationCount;
  return readValue(decide(maturitySignalsFor(airport, { observationCount: count, nowMs, ...evidence }), flagOn, count, true, Boolean(airport.curation)));
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
