/**
 * LayoverObservationAggregate — §17 L204's guard, written before the thing it
 * guards could exist.
 *
 * census-layover L204 — "Aggregated airport intelligence must not leak raw user
 * identifiers" — has read NOT-BUILT with the reason *"No aggregated airport
 * intelligence exists to leak from."* Under that census's own rule for
 * prohibitions that is `∅`, an UNGUARDED ABSENCE: the forbidden path does not
 * exist and nothing would refuse it if it were added.
 *
 * The path is one step from existing. `POST /airport/sessions/:id/observations`
 * is live and reachable (its only gate is `airport_mode_enabled`, TRUE in
 * production), migrations 2860 and 2982 are BOTH APPLIED to production, and
 * `airport_fact_observations` therefore accumulates real traveller reports with
 * a pseudonymous `tv1-…` observer handle on every row. The first thing that
 * folds those rows into a per-airport number creates the leak surface. This
 * module is that fold AND its refusal, in one place, so the two cannot drift.
 *
 * ── WHAT IS DE-IDENTIFIED AND WHAT WAS NEVER IDENTIFIED ──────────────────────
 * A raw `user_id` never reaches the store at all: 2860's
 * `airport_fact_observations_community_not_a_profile` CHECK forbids a bare UUID
 * in `observer_id` on a community row, and `LayoverObservationService` files
 * every traveller report under an HMAC handle instead.
 *
 * The handle is still an IDENTIFIER. It is stable per (traveller, airport) —
 * deliberately, because the corroboration floor and the rate limit both count
 * distinct observers and both break under rotation — so anyone holding the
 * table can see one unnamed person's reporting history at one airport. That is
 * acceptable INSIDE the store, which is service-role-only. It is not acceptable
 * in anything published, and "published" starts here.
 *
 * So the aggregate's TYPE has no field that can hold one, and
 * `assertNoObserverIdentifiers` walks the finished value and THROWS if a handle,
 * a bare UUID or a row id appears anywhere in it under any key. Both halves are
 * deliberate: the type is what stops a leak being written, and the assertion is
 * what stops a leak being written ANYWAY by a later field nobody re-read this
 * header for. A prohibition that rests only on nobody adding the wrong field is
 * the `∅` the census already scored.
 *
 * ── THE FLOOR THE SAMPLE FLOOR IS NOT ────────────────────────────────────────
 * `LayoverAirportTruth.buildHistoricalModel` withholds a band below
 * `MIN_SAMPLES_PER_BAND` (5) SAMPLES. That is the right floor for a claim about
 * a DISTRIBUTION and the wrong floor for a claim that is safe to PUBLISH:
 * `OBSERVATION_RATE_LIMIT` permits three reports per fifteen minutes, so one
 * traveller reaches five readings inside one local hour in half an hour of
 * button presses. The p90 of that band is one person's afternoon, published as
 * an airport-level fact and attributable to them by anyone who knows they were
 * in the terminal.
 *
 * `MIN_DISTINCT_OBSERVERS_PER_BAND` is therefore applied FIRST, per local hour,
 * and the sample floor applies on top of what survives. Both bounds, not either
 * — the same shape `readObservationCorpus` uses for expiry.
 *
 * ── FAIL-CLOSED, AND NO SWALLOWED READ ───────────────────────────────────────
 * An unreadable corpus is `{ ok: false }`. It is NEVER an aggregate of zero:
 * "nobody has reported anything at this airport" and "the table could not be
 * read" are opposite claims that render identically, which is the defect
 * census-layover has now recorded four times on this domain. A genuinely empty
 * airport IS `{ ok: true }` with zeroes, because absence is a fact and failure
 * is not.
 *
 * ── AND WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────
 * It does not feed a safety buffer. No number here reaches `liveConditionsFrom`
 * or a return deadline; the route that accepts these reports says in as many
 * words that wiring them into the buffer is an OWNER decision rather than a
 * side effect of giving travellers somewhere to report, and that decision is
 * untouched here. The only consumer is `layoverMaturityGate`, which uses the
 * COUNT — never a value — to decide which §22 rung an airport is on.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { localHour } from "../airport/AirportTime.js";
import {
  LAYOVER_TRUTH_VERSION,
  MIN_SAMPLES_PER_BAND,
  buildHistoricalModel,
  type AirportFactType,
  type AirportObservation,
  type HistoricalBand,
} from "../airport/LayoverAirportTruth.js";
import {
  TRAVELLER_SUBMITTABLE_FACT_TYPES,
  readObservationCorpus,
} from "./LayoverObservationService.js";

const logger = rootLogger.child({ service: "LayoverObservationAggregate" });

/**
 * How many DISTINCT observers must have contributed to one local-hour band
 * before that band may be published.
 *
 * Three, matching `MIN_COMMUNITY_CORROBORATION`'s reasoning rather than its
 * number by accident: the value that makes "one stranger cannot move a
 * deadline" true is the same value that makes "one stranger cannot BE the
 * distribution" true, and keeping them equal means a band that is publishable
 * is also a band the reconciler would have stood behind.
 */
export const MIN_DISTINCT_OBSERVERS_PER_BAND = 3;

/**
 * One fact type at one airport, aggregated.
 *
 * EVERY MEMBER IS A COUNT OR A PERCENTILE. There is no member that can hold an
 * observer, a row id, a token or a timestamp of an individual report, and that
 * is the point of writing the type out rather than returning the corpus with
 * fields removed.
 */
export interface AirportFactAggregate {
  factType: AirportFactType;
  /** Unexpired observations of this fact, before any floor. */
  observations: number;
  /** Distinct observers behind them. The k of the k-anonymity floor. */
  distinctObservers: number;
  /** Published per-local-hour bands. Identifier-free by construction. */
  bands: HistoricalBand[];
  /** Local hours that had readings and were NOT published. Counted, not silent. */
  withheldBands: number;
}

export interface AirportObservationAggregate {
  /** IATA code, or an airport profile id. An AIRPORT's id — never a person's. */
  airportRef: string;
  truthVersion: string;
  computedAt: string;
  minSamplesPerBand: number;
  minDistinctObserversPerBand: number;
  observations: number;
  distinctObservers: number;
  /**
   * The count §22's ladder may read, which is NOT `observations`.
   *
   * A rung that says "recent Portava operational observations available" is a
   * claim about the travelling public, and one determined person clearing the
   * rate limit for two hours is not the travelling public. Zero until the
   * corpus is corroborated by `MIN_DISTINCT_OBSERVERS_PER_BAND` distinct
   * observers; the full count after that.
   */
  maturityObservationCount: number;
  facts: AirportFactAggregate[];
}

export type AggregateRead =
  | { ok: true; aggregate: AirportObservationAggregate }
  | { ok: false; reason: "read_failed" };

/** `tv1-` + 40 hex — `travellerObserverHandle`'s shape, matched exactly. */
const OBSERVER_HANDLE = /\btv1-[0-9a-f]{40}\b/i;
/** A bare UUID: the thing 2860's CHECK exists to keep off a community row. */
const BARE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * Refuse an aggregate that carries an identity, under ANY key.
 *
 * Walks the finished value rather than the inputs, because the question is not
 * "did we mean to include one" — it is "is one there". `airportRef` is the one
 * exemption and it is by PATH, not by pattern: an airport without an IATA code
 * is filed under its profile id, which is a bare UUID belonging to an airport.
 * Exempting the pattern instead of the path would have reopened the hole for
 * every other field.
 *
 * THROWS. It does not strip and it does not log: a caller that quietly dropped
 * the offending field would publish the rest of an aggregate that a reviewer
 * has never seen, and the failure would be invisible in exactly the way this
 * whole module exists to prevent.
 */
export function assertNoObserverIdentifiers(aggregate: AirportObservationAggregate): void {
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      if (path === "airportRef") return;
      if (OBSERVER_HANDLE.test(node)) {
        throw new Error(
          `LayoverObservationAggregate: an observer identifier reached the aggregate at ${path}. ` +
            "An aggregate is published; a handle is correlatable at one airport. Remove the field.",
        );
      }
      if (BARE_UUID.test(node)) {
        throw new Error(
          `LayoverObservationAggregate: a bare UUID identifier reached the aggregate at ${path}. ` +
            "Migration 2860 forbids a profiles id on a community observation for the same reason.",
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(aggregate, "");
}

/**
 * The local hour an observation was made at the airport, or `null` when the
 * instant will not parse. An unplaceable reading is counted in `observations`
 * and belongs to no band, which is what `buildHistoricalModel` already does.
 */
function hourOf(tz: string, isoInstant: string): number | null {
  const at = new Date(isoInstant);
  if (Number.isNaN(at.getTime())) return null;
  const h = localHour(tz, at);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

/**
 * Drop every observation whose local hour has fewer than
 * `MIN_DISTINCT_OBSERVERS_PER_BAND` distinct observers behind it, and report
 * how many hours that removed.
 *
 * Applied BEFORE `buildHistoricalModel` rather than after, so the sample floor
 * and the percentiles are both computed over a set that has already cleared the
 * anonymity floor. Filtering afterwards would have computed a p90 over one
 * person's readings and then discarded it — correct output, and a value that
 * existed in memory for no reason.
 */
function corroboratedByHour(
  observations: AirportObservation[],
  tz: string,
): { kept: AirportObservation[]; withheldHours: number } {
  const byHour = new Map<number, AirportObservation[]>();
  for (const o of observations) {
    const h = hourOf(tz, o.observedAt);
    if (h === null) continue;
    const bucket = byHour.get(h) ?? [];
    bucket.push(o);
    byHour.set(h, bucket);
  }
  const kept: AirportObservation[] = [];
  let withheldHours = 0;
  for (const [, bucket] of byHour) {
    const distinct = new Set(bucket.map((o) => o.observerId)).size;
    if (distinct < MIN_DISTINCT_OBSERVERS_PER_BAND) {
      withheldHours += 1;
      continue;
    }
    kept.push(...bucket);
  }
  return { kept, withheldHours };
}

/**
 * The de-identified operational aggregate for one airport.
 *
 * Reads every traveller-submittable fact type — the corpus read is the one
 * `LayoverObservationService` already owns, so expiry, ordering and the
 * refusal-on-error all behave exactly as they do on the route.
 */
export async function readAirportObservationAggregate(
  db: SupabaseClient,
  airportRef: string,
  timezone: string,
  nowMs: number,
): Promise<AggregateRead> {
  const facts: AirportFactAggregate[] = [];
  const allObservers = new Set<string>();
  let totalObservations = 0;

  for (const factType of TRAVELLER_SUBMITTABLE_FACT_TYPES) {
    const read = await readObservationCorpus(db, airportRef, factType, nowMs);
    if (!read.ok) {
      logger.warn(
        { airportRef, factType },
        "observation aggregate refused — a failed corpus read must not publish as an empty airport",
      );
      return { ok: false, reason: "read_failed" };
    }
    const corpus = read.corpus;
    totalObservations += corpus.length;
    for (const o of corpus) allObservers.add(o.observerId);

    const { kept, withheldHours } = corroboratedByHour(corpus, timezone);
    const model = buildHistoricalModel(kept, {
      nowMs,
      factType,
      airportRef,
      localHourOf: (iso) => hourOf(timezone, iso) ?? -1,
    });

    facts.push({
      factType,
      observations: corpus.length,
      distinctObservers: new Set(corpus.map((o) => o.observerId)).size,
      bands: model.bands,
      withheldBands: withheldHours,
    });
  }

  const distinctObservers = allObservers.size;
  const aggregate: AirportObservationAggregate = {
    airportRef,
    truthVersion: LAYOVER_TRUTH_VERSION,
    computedAt: new Date(nowMs).toISOString(),
    minSamplesPerBand: MIN_SAMPLES_PER_BAND,
    minDistinctObserversPerBand: MIN_DISTINCT_OBSERVERS_PER_BAND,
    observations: totalObservations,
    distinctObservers,
    maturityObservationCount:
      distinctObservers >= MIN_DISTINCT_OBSERVERS_PER_BAND ? totalObservations : 0,
    facts,
  };

  // The last thing before it leaves this module, on every path.
  assertNoObserverIdentifiers(aggregate);
  return { ok: true, aggregate };
}
