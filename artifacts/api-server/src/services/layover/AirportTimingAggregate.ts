/**
 * AirportTimingAggregate — census-layover L161, "Aggregate airport timing —
 * may persist after de-identification/aggregation" (spec line 544).
 *
 * ── WHAT WAS TRUE BEFORE THIS FILE ───────────────────────────────────────────
 * `airport_fact_observations` (2860, applied to production) accumulates real
 * traveller queue and checkpoint reports, each under a pseudonymous `tv1-…`
 * observer handle, with an `expires_at` 45 minutes out and an index left "for
 * the read a retention sweep makes" (2860:216). NO JOB SWEPT IT: an expired
 * report was hidden from every read and kept forever, handle and all. And the
 * only fold of those rows (`LayoverObservationAggregate.ts`) is computed per
 * request over UNEXPIRED rows and never stored, so when a report expired its
 * timing was simply lost.
 *
 * ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────
 * Each pass (lib/layoverOperationalRetentionScheduler.ts, hourly) takes the
 * community observations whose `expires_at` has passed, folds the TIMING ones
 * of every CLOSED local hour into per-airport, per-fact bands — one band per
 * local hour on one local day — and hands the bands AND the raw row ids to
 * `airport_timing_fold_commit` (3790), which writes the bands and deletes
 * exactly those raw rows in ONE transaction. A raw row goes only once its
 * hour's fold is written.
 *
 * ── A BAND IS A WHOLE LOCAL HOUR, NEVER WHAT ONE PASS HAPPENED TO CUT ─────────
 * Fix round 1 (verifier V-732, fix 4). A reading expires 45 minutes after it is
 * made and the pass is hourly, so "everything expired now" cuts most local
 * hours in two. Folding the cut pieces applied the k floor to each piece: 15
 * distinct observers in one hour, read 7 + 8 by two passes at :11, stored NO
 * band and deleted all 15 readings. So a (fact, local hour) bucket is folded
 * only when it is CLOSED — it ended at least one reading lifetime ago
 * (`bucket end + TRAVELLER_READING_TTL_MS <= now`), so every reading it can
 * hold has expired and been read. The expired readings of a still-open hour are
 * HELD: not folded, not deleted, taken by the next pass (every reader already
 * hides them). The hold is bounded: at most one hour past a reading's own
 * expiry, plus the tick. OQ-5's "raw deleted at expiry" is kept in spirit —
 * nothing unexpired is ever touched — and the stricter reading (delete each row
 * the instant it expires) would publish nothing honest, which is what the
 * verifier measured.
 *
 * ── A PAGE IS AT MOST 1 000 ROWS, AND A CUT PAGE CLOSES LESS ─────────────────
 * Supabase's PostgREST answers at most `db-max-rows` (1 000) rows and says
 * nothing when it truncates, so the batch is 1 000 and `complete` is true only
 * for a page SHORTER than what was asked for. The page is ordered by airport,
 * then reading time: every airport but the last one in a full page is whole,
 * and for that last one only the hours that ended before its last read reading
 * are closed (the rest of the hour may be on the next page). If ONE airport's
 * ONE hour fills a whole page, its in-page part is folded anyway so the pass
 * cannot stall forever on it — at 1 000 readings and the write-time rate limit
 * (3 per observer per 15 minutes) that part carries at least 84 observers.
 *
 * ── DE-IDENTIFICATION, THREE TIMES ───────────────────────────────────────────
 * 1. The TYPE: `AirportTimingFold` and `AirportTimingAggregateRow` have no
 *    member that can hold an observer, a row id or an instant finer than the
 *    hour. The row type mirrors 3790's column list, and a test pins the two
 *    equal.
 * 2. The ASSERTION: every fold goes through `assertNoObserverIdentifiers`, the
 *    same walk the live aggregate uses, which THROWS on a handle or a bare UUID
 *    anywhere but the root `airportRef`.
 * 3. The FLOOR: a band is published only with at least
 *    `PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS` (10) distinct observers behind
 *    it. Ten, not the live aggregate's three, because a STORED band outlives
 *    the people in it: OQ-5 asks k = 5 or 10 and the stricter holds until the
 *    owner answers. The database re-counts it from the raw rows inside the same
 *    transaction (3790) and its CHECK refuses anything below ten, so a caller
 *    that miscounted is refused, not trusted.
 *    Below the floor a CLOSED hour is WITHHELD: counted, never written, and
 *    its raw rows are deleted with the rest. A closed hour is not kept back to
 *    "wait for a tenth observer": nothing more can arrive in it.
 *    Two things the floor does NOT do, stated for OQ-5 rather than decided:
 *    the stored fold applies no per-observer rate limit (the live model screens
 *    3 per 15 minutes; the write path already enforced it), so a band of 10
 *    observers can be mostly one person's readings; and with exactly 10
 *    observers each nearest-rank percentile IS one person's exact reading.
 *
 * ── WHAT IS NOT FOLDED, AND STILL DELETED ────────────────────────────────────
 * `closure_reported` is a state (0/1), not a timing: it is deleted at expiry
 * and aggregated into nothing. A reading that is not finite, is outside the
 * plausible range, has no parseable instant, or belongs to an airport whose
 * timezone cannot be established (no such airport) cannot be placed in a local
 * hour honestly, so it is counted as unusable and deleted. Non-community rows
 * (feeds, sensors, official) are never read or deleted here: they are not a
 * person's, nothing in this tree produces them, and their fate is not this
 * row's.
 *
 * ── WHAT A FAILURE DOES ──────────────────────────────────────────────────────
 * Nothing. A failed read is `failed`, never "nothing due". An airport whose
 * timezone could not be READ (the profile store answered an error) is skipped
 * whole: no aggregate, no delete, retried next pass. A commit the database
 * refuses rolls back entirely, so a failed fold deletes nothing and a failed
 * delete writes nothing. Logs carry counts; a failure line names the AIRPORT
 * (never an observation id, handle or value) so an operator can find it.
 *
 * ── THE WINDOW ───────────────────────────────────────────────────────────────
 * Each band carries the hour-aligned UTC window covering its local hour: the
 * hour itself where the airport's offset is whole hours, the two UTC hours it
 * straddles where it is not (India, +5:30). Nothing finer than the hour is
 * stored, and the database refuses a window that is not hour-aligned.
 *
 * ── WHAT THIS DOES NOT DO — AND MUST NOT ─────────────────────────────────────
 * IT FEEDS NOTHING. No safety buffer, return deadline, rating, ranking,
 * recommendation or maturity rung reads `airport_timing_aggregates` or anything
 * exported from this file. Whether a stored band may ever inform a buffer is an
 * OWNER decision — the observation route says so in as many words — and it is
 * untouched here. `src/test/airportTimingAggregate.test.ts` fails if anything
 * under services/airport/ (or any other non-test file outside this file and its
 * registries) names the table or imports this module.
 * It states NO retention period for the aggregates (OQ-5): none is approved and
 * none is invented, so nothing here deletes an aggregate.
 *
 * ── THE GATE ─────────────────────────────────────────────────────────────────
 * `airport_timing_aggregate_enabled`, seeded FALSE by 3790. OFF, absent or
 * unreadable: the pass reads that one flag and nothing else — no observation is
 * read, nothing is written, nothing is deleted. The database function checks
 * the same flag again and writes nothing while it is OFF.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { localHourMinute } from "../airport/AirportTime.js";
import { resolveStaticByIata } from "../airport/StaticAirportData.js";
import {
  FACT_CLASS_TTL_MIN,
  LAYOVER_TRUTH_VERSION,
  MIN_SAMPLES_PER_BAND,
  isImplausible,
  type AirportFactType,
} from "../airport/LayoverAirportTruth.js";
import { TRAVELLER_SUBMITTABLE_FACT_TYPES } from "./LayoverObservationService.js";
import { assertNoObserverIdentifiers } from "./LayoverObservationAggregate.js";

const logger = rootLogger.child({ service: "AirportTimingAggregate" });

/** 3790's flag. Spelled as a literal at the read below so check:flag-polarity can resolve it. */
export const AIRPORT_TIMING_AGGREGATE_FLAG = "airport_timing_aggregate_enabled";

/**
 * The distinct-observer floor for a STORED band. OQ-5 (L261 proposal Q8) asks
 * k = 5 or 10; 10 is the fail-closed default until the owner answers, and 3790's
 * CHECK holds the database to the same number.
 */
export const PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS = 10;

/**
 * The TIMING facts a traveller can report — the traveller-submittable set
 * minus the one state fact. 3790's CHECK admits exactly these, and the test
 * suite pins the two lists equal.
 */
export const AIRPORT_TIMING_FACT_TYPES = ["checkpoint_timing_minutes", "queue_report_minutes"] as const satisfies readonly AirportFactType[];
export type AirportTimingFactType = (typeof AIRPORT_TIMING_FACT_TYPES)[number];

/**
 * Rows one pass may take: Supabase's PostgREST `db-max-rows`, 1 000. A larger
 * `.limit()` is silently truncated to it (accountDeletionRowPagination.test.ts:
 * "an explicit limit above db-max-rows is a no-op dressed as a bound"), so a
 * caller's larger request is clamped, and only a SHORT page reports `complete`.
 */
export const AIRPORT_TIMING_FOLD_BATCH_SIZE = 1000;

/** How long a traveller reading lives: its writer sets `expires_at` = made + this (FACT_CLASS_TTL_MIN). */
export const TRAVELLER_READING_TTL_MS = FACT_CLASS_TTL_MIN.TRAVELER_OBSERVATION * 60_000;

const HOUR_MS = 60 * 60_000;

/** One expired community observation, as the pass reads it. In memory only; never stored or logged. */
export interface DueObservationRow {
  id: string;
  airport_ref: string;
  fact_type: string;
  value: number | string;
  observer_id: string;
  observed_at: string;
}

/** One published band. Counts, an hour-aligned window and percentiles — nothing else. */
export interface AirportTimingBand {
  factType: AirportTimingFactType;
  /** Local hour at the airport, 0-23. */
  localHour: number;
  windowStart: string;
  windowEnd: string;
  samples: number;
  distinctObservers: number;
  p50: number;
  p75: number;
  p90: number;
}

/** One airport's fold. Walked by `assertNoObserverIdentifiers` before anything leaves this module. */
export interface AirportTimingFold {
  /** IATA code or an airport profile id — an AIRPORT's, never a person's. */
  airportRef: string;
  truthVersion: string;
  minDistinctObserversPerBand: number;
  minSamplesPerBand: number;
  bands: AirportTimingBand[];
  /** CLOSED (fact, local hour) buckets that had readings and were NOT published (below the floor). */
  withheldBands: number;
  /** Rows deleted without contributing: not timing, not finite, implausible, unplaceable. */
  unusable: number;
  /** Readings of a still-OPEN hour: neither folded nor deleted; the next pass takes them. */
  held: number;
}

/** A row of `airport_timing_aggregates` as this module writes it. `id` and `folded_at` are the database's. */
export interface AirportTimingAggregateRow {
  airport_ref: string;
  fact_type: AirportTimingFactType;
  local_hour: number;
  window_start: string;
  window_end: string;
  sample_count: number;
  distinct_observers: number;
  p50_minutes: number;
  p75_minutes: number;
  p90_minutes: number;
  truth_version: string;
}

/** The pure fold's output: the publishable fold, plus what the database needs to verify and delete. */
export interface FoldedWindow {
  fold: AirportTimingFold;
  /** evidence[i] = the raw row ids behind fold.bands[i]. Sent to the commit for re-counting; never stored. */
  evidence: string[][];
  /** The rows deleted with the fold: every reading of a closed hour (published or withheld) and every unusable row. Held rows are NOT here. */
  observationIds: string[];
}

/** When a bucket may be folded. */
export interface FoldOptions {
  /** A (fact, local hour) bucket is folded only if it ENDED at or before this instant (epoch ms). */
  closedBefore: number;
  /** The pass's progress guarantee: when NO bucket is closed, fold the oldest one's readings anyway (one airport-hour larger than a page). */
  forceOldest?: boolean;
}

/** The local hour a reading falls in: its start and end instants (epoch ms) and its local hour of day. */
export function localHourBucket(tz: string, atMs: number): { startMs: number; endMs: number; hour: number } {
  const { hour, minute } = localHourMinute(tz, new Date(atMs));
  // Offsets are whole minutes, so the local second is the UTC second.
  const startMs = atMs - (((atMs % 60_000) + 60_000) % 60_000) - minute * 60_000;
  return { startMs, endMs: startMs + HOUR_MS, hour };
}

function isTimingFact(t: string): t is AirportTimingFactType {
  return (AIRPORT_TIMING_FACT_TYPES as readonly string[]).includes(t);
}

/** `LayoverAirportTruth`'s nearest-rank percentile, so a stored band reads like a live one. */
function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** True when `tz` is a zone this runtime can format in. `localHour` silently answers UTC otherwise. */
export function isUsableTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fold one airport's due rows. PURE: no clock, no database.
 *
 * Readings are bucketed by (fact, local-hour INSTANCE). A bucket that ended at
 * or before `opts.closedBefore` is folded — published at k >= 10, withheld
 * below — and its readings are listed for deletion. A bucket still open is
 * HELD: neither folded nor listed. Unusable rows (not timing, not finite,
 * implausible, no parseable instant, or an airport whose zone cannot be
 * established) contribute to no bucket and are listed for deletion.
 */
export function foldAirportTimingWindow(
  airportRef: string,
  rows: readonly DueObservationRow[],
  timezone: string | null,
  opts: FoldOptions,
): FoldedWindow {
  const tz = isUsableTimezone(timezone) ? timezone : null;
  type Reading = { id: string; observer: string; value: number };
  type Bucket = { factType: AirportTimingFactType; hour: number; startMs: number; endMs: number; readings: Reading[] };
  const buckets = new Map<string, Bucket>();
  const unusableIds: string[] = [];
  for (const r of rows) {
    if (r.airport_ref !== airportRef) throw new Error("foldAirportTimingWindow: a row of another airport was handed to this fold");
    const at = Date.parse(r.observed_at);
    const value = Number(r.value);
    if (tz === null || !isTimingFact(r.fact_type) || !Number.isFinite(at) || !Number.isFinite(value) || isImplausible(r.fact_type, value)) {
      unusableIds.push(r.id);
      continue;
    }
    const b = localHourBucket(tz, at);
    if (!Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23) {
      unusableIds.push(r.id);
      continue;
    }
    const key = `${r.fact_type}|${b.startMs}`;
    const g = buckets.get(key) ?? { factType: r.fact_type, hour: b.hour, startMs: b.startMs, endMs: b.endMs, readings: [] };
    g.readings.push({ id: r.id, observer: r.observer_id, value });
    buckets.set(key, g);
  }

  const all = [...buckets.values()].sort((a, b) => a.startMs - b.startMs || a.factType.localeCompare(b.factType));
  let closed = all.filter((g) => g.endMs <= opts.closedBefore);
  if (closed.length === 0 && opts.forceOldest && all.length > 0) closed = all.filter((g) => g.startMs === all[0]!.startMs);
  const closedSet = new Set(closed);

  const bands: AirportTimingBand[] = [];
  const evidence: string[][] = [];
  const folded: string[] = [];
  let withheldBands = 0;
  let held = 0;
  for (const g of all) {
    if (!closedSet.has(g)) {
      held += g.readings.length;
      continue;
    }
    folded.push(...g.readings.map((x) => x.id));
    const distinct = new Set(g.readings.map((x) => x.observer)).size;
    if (distinct < PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS || g.readings.length < MIN_SAMPLES_PER_BAND) {
      withheldBands += 1;
      continue;
    }
    const sorted = g.readings.map((x) => x.value).sort((a, b) => a - b);
    bands.push({
      factType: g.factType,
      localHour: g.hour,
      windowStart: new Date(Math.floor(g.startMs / HOUR_MS) * HOUR_MS).toISOString(),
      windowEnd: new Date(Math.ceil(g.endMs / HOUR_MS) * HOUR_MS).toISOString(),
      samples: g.readings.length,
      distinctObservers: distinct,
      p50: nearestRank(sorted, 50),
      p75: nearestRank(sorted, 75),
      p90: nearestRank(sorted, 90),
    });
    evidence.push(g.readings.map((x) => x.id));
  }

  const fold: AirportTimingFold = {
    airportRef,
    truthVersion: LAYOVER_TRUTH_VERSION,
    minDistinctObserversPerBand: PERSISTED_TIMING_MIN_DISTINCT_OBSERVERS,
    minSamplesPerBand: MIN_SAMPLES_PER_BAND,
    bands,
    withheldBands,
    unusable: unusableIds.length,
    held,
  };
  // The last thing before it leaves the pure half, on every path.
  assertNoObserverIdentifiers(fold);
  return { fold, evidence, observationIds: [...folded, ...unusableIds] };
}

/** The rows 3790 stores, field for field. Nothing is copied that the type does not name. */
export function timingAggregateRowsFor(fold: AirportTimingFold): AirportTimingAggregateRow[] {
  assertNoObserverIdentifiers(fold);
  return fold.bands.map((b) => ({
    airport_ref: fold.airportRef,
    fact_type: b.factType,
    local_hour: b.localHour,
    window_start: b.windowStart,
    window_end: b.windowEnd,
    sample_count: b.samples,
    distinct_observers: b.distinctObservers,
    p50_minutes: b.p50,
    p75_minutes: b.p75,
    p90_minutes: b.p90,
    truth_version: fold.truthVersion,
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TimezoneRead = { ok: true; timezone: string | null } | { ok: false };

/**
 * The airport's zone, the way the observation route names the airport: IATA
 * when there is one, the profile id otherwise. `{ ok: true, timezone: null }`
 * is "no such airport" (a fact); `{ ok: false }` is "the profile store could
 * not be read and nothing else answers" (not a fact, so nothing is deleted on
 * it).
 *
 * Its own two reads rather than `AirportProfileService.lookupByIata`: that
 * resolver counts every static-dataset answer as a stale fallback (census L215),
 * and an hourly background pass would pour its own lookups into a metric about
 * what TRAVELLERS were served. The static dataset is still a real answer here,
 * as it is there; a profile row without a zone is not read as "UTC".
 */
export async function resolveAirportTimezone(db: SupabaseClient, airportRef: string): Promise<TimezoneRead> {
  try {
    if (UUID.test(airportRef)) {
      const { data, error } = await db.from("airport_profiles").select("timezone").eq("id", airportRef).maybeSingle();
      if (error) return { ok: false };
      const tz = (data as { timezone?: unknown } | null)?.timezone;
      return { ok: true, timezone: typeof tz === "string" && isUsableTimezone(tz) ? tz : null };
    }
    if (/^[A-Za-z]{3}$/.test(airportRef)) {
      const { data, error } = await db.from("airport_profiles").select("timezone").ilike("iata_code", airportRef).maybeSingle();
      const tz = (data as { timezone?: unknown } | null)?.timezone;
      if (!error && typeof tz === "string" && isUsableTimezone(tz)) return { ok: true, timezone: tz };
      const s = resolveStaticByIata(airportRef);
      if (s && isUsableTimezone(s.timezone)) return { ok: true, timezone: s.timezone };
      return error ? { ok: false } : { ok: true, timezone: null };
    }
    return { ok: true, timezone: null };
  } catch {
    return { ok: false };
  }
}

// ── the pass ─────────────────────────────────────────────────────────────────

export type AirportTimingFoldOutcome = "disabled" | "idle" | "folded" | "partial" | "failed" | "refused";

export interface AirportTimingFoldResult {
  outcome: AirportTimingFoldOutcome;
  reason: "no_client" | "read_failed" | "airport_failed" | null;
  /** Due rows read this pass. */
  read: number;
  airports: number;
  /** Airports whose commit the database accepted. */
  airportsCommitted: number;
  /** Airports skipped (timezone unreadable) or whose commit the database refused. Nothing of theirs moved. */
  airportsFailed: number;
  aggregatesWritten: number;
  observationsDeleted: number;
  bandsWithheld: number;
  unusable: number;
  /** Expired readings of still-open hours: read, neither folded nor deleted; the next pass takes them. */
  held: number;
  /** True only for a page SHORTER than the one asked for, with no airport failed. */
  complete: boolean;
}

function emptyResult(outcome: AirportTimingFoldOutcome, reason: AirportTimingFoldResult["reason"]): AirportTimingFoldResult {
  return {
    outcome, reason, read: 0, airports: 0, airportsCommitted: 0, airportsFailed: 0,
    aggregatesWritten: 0, observationsDeleted: 0, bandsWithheld: 0, unusable: 0, held: 0, complete: outcome === "disabled" || outcome === "idle",
  };
}

/**
 * One fold-then-delete pass, deterministic in its instant: `opts.now` IS the
 * cutoff. Never throws.
 *
 * The read takes due readings made before `now - TRAVELLER_READING_TTL_MS`
 * (for a standard reading that is every due one), ordered by airport and then
 * reading time, at most one page. Per airport, a local hour that ended before
 * that instant is CLOSED — except for the last airport of a FULL page, whose
 * closure stops at its last read reading, because the rest of its hour may be
 * on the next page.
 */
export async function runAirportTimingFoldPhase(
  opts: { client: any; now: Date; batchSize?: number },
): Promise<AirportTimingFoldResult> {
  const db = opts.client;
  if (!db) return emptyResult("refused", "no_client");
  try {
    if (!(await isFlagEnabled(db, "airport_timing_aggregate_enabled"))) return emptyResult("disabled", null);
  } catch {
    return emptyResult("disabled", null);
  }

  const limit = Math.max(1, Math.min(opts.batchSize ?? AIRPORT_TIMING_FOLD_BATCH_SIZE, AIRPORT_TIMING_FOLD_BATCH_SIZE));
  const cutoff = opts.now.toISOString();
  const closedBefore = opts.now.getTime() - TRAVELLER_READING_TTL_MS;
  let read: { data: unknown; error: unknown };
  try {
    read = await db
      .from("airport_fact_observations")
      .select("id,airport_ref,fact_type,value,observer_id,observed_at")
      .eq("observer_kind", "community")
      .in("fact_type", [...TRAVELLER_SUBMITTABLE_FACT_TYPES])
      .lte("expires_at", cutoff)
      .lt("observed_at", new Date(closedBefore).toISOString())
      .order("airport_ref", { ascending: true })
      .order("observed_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);
  } catch (err) {
    read = { data: null, error: err };
  }
  if (read.error) {
    logger.warn({ code: (read.error as { code?: unknown })?.code ?? null }, "airport timing fold: due observations unreadable — nothing folded, nothing deleted");
    return emptyResult("failed", "read_failed");
  }
  const rows = ((read.data ?? []) as DueObservationRow[]).filter((r) => r && typeof r.id === "string" && typeof r.airport_ref === "string");
  if (rows.length === 0) return emptyResult("idle", null);

  const byAirport = new Map<string, DueObservationRow[]>();
  for (const r of rows) {
    const list = byAirport.get(r.airport_ref) ?? [];
    list.push(r);
    byAirport.set(r.airport_ref, list);
  }
  // A FULL page may have cut its last airport: that airport's closure stops at
  // its last read reading. A page that is ONE airport and closes nothing is the
  // one case folded anyway (see the header), or the pass would stall on it.
  const pageFull = rows.length >= limit;
  const last = rows[rows.length - 1]!;
  const lastReadAt = Date.parse(last.observed_at);

  const result: AirportTimingFoldResult = {
    outcome: "folded", reason: null, read: rows.length, airports: byAirport.size, airportsCommitted: 0, airportsFailed: 0,
    aggregatesWritten: 0, observationsDeleted: 0, bandsWithheld: 0, unusable: 0, held: 0, complete: !pageFull,
  };

  for (const [airportRef, airportRows] of byAirport) {
    const cut = pageFull && airportRef === last.airport_ref;
    const fold: FoldOptions = {
      closedBefore: cut && Number.isFinite(lastReadAt) ? Math.min(closedBefore, lastReadAt) : closedBefore,
      forceOldest: cut && byAirport.size === 1,
    };
    const tz = await resolveAirportTimezone(db, airportRef);
    if (!tz.ok) {
      result.airportsFailed += 1;
      logger.warn({ airportRef }, "airport timing fold: airport timezone unreadable — this airport's rows are neither folded nor deleted this pass");
      continue;
    }
    let folded: FoldedWindow;
    try {
      folded = foldAirportTimingWindow(airportRef, airportRows, tz.timezone, fold);
    } catch (err) {
      result.airportsFailed += 1;
      logger.error({ airportRef, err: (err as Error)?.message }, "airport timing fold: the fold refused itself — nothing of this airport is written or deleted");
      continue;
    }
    result.held += folded.fold.held;
    if (folded.observationIds.length === 0) continue; // every reading is in a still-open hour: nothing to commit yet
    const aggregates = timingAggregateRowsFor(folded.fold);
    let commit: { data: unknown; error: unknown };
    try {
      commit = await db.rpc("airport_timing_fold_commit", {
        p_aggregates: aggregates,
        p_evidence: folded.evidence,
        p_observation_ids: folded.observationIds,
        p_cutoff: cutoff,
      });
    } catch (err) {
      commit = { data: null, error: err };
    }
    const answer = (commit.data ?? null) as { status?: unknown; inserted?: unknown; deleted?: unknown } | null;
    if (commit.error || !answer || (answer.status !== "committed" && answer.status !== "disabled")) {
      result.airportsFailed += 1;
      logger.warn(
        { airportRef, code: (commit.error as { code?: unknown } | null)?.code ?? null },
        "airport timing fold: commit refused — nothing of this airport was written or deleted (one transaction)",
      );
      continue;
    }
    if (answer.status === "disabled") {
      // The flag went OFF between the read above and the database's own check.
      // Nothing was written; stop here rather than ask again for every airport.
      return { ...emptyResult("disabled", null), read: result.read, airports: result.airports };
    }
    result.airportsCommitted += 1;
    result.aggregatesWritten += Number(answer.inserted) || 0;
    result.observationsDeleted += Number(answer.deleted) || 0;
    result.bandsWithheld += folded.fold.withheldBands;
    result.unusable += folded.fold.unusable;
  }

  if (result.airportsFailed > 0) {
    result.complete = false;
    result.outcome = result.airportsCommitted > 0 ? "partial" : "failed";
    result.reason = "airport_failed";
  }
  // Counts only: no airport, no id, no value.
  logger.info(
    {
      outcome: result.outcome, read: result.read, airports: result.airports, airportsCommitted: result.airportsCommitted,
      airportsFailed: result.airportsFailed, aggregatesWritten: result.aggregatesWritten,
      observationsDeleted: result.observationsDeleted, bandsWithheld: result.bandsWithheld, unusable: result.unusable,
      held: result.held, complete: result.complete,
    },
    "airport timing fold pass",
  );
  return result;
}
