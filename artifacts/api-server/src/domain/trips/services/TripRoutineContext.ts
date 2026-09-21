/**
 * Trips spec §23 "Long-stay 45 days" — the READ side of the recurrence
 * subsystem: `trip_commitment_recurrences` (2797) rows turned into the pure
 * module's `RecurrenceRule`s, plus the §11.1/§12.1 routine-aware context the
 * scenario's second clause names (census-trips TR427).
 *
 * WHY THE READ IS THREE-VALUED AND NOT A REFUSAL
 * ==============================================
 * Every other read in TripFreedomProjection refuses the whole projection when
 * it fails, and that is right for them: a freedom window computed over "no
 * commitments" is the most confident wrong answer that file can give. This read
 * is different in ONE way that matters — 2797 is a NEW migration and is on no
 * database yet, so "the table is not there" is the ordinary state of every
 * deployment for as long as it takes an operator to apply it. Refusing on that
 * would turn the freedom, health and Today projections off everywhere the day
 * this merges, in exchange for a feature none of those deployments can use yet.
 *
 * So the read distinguishes three answers, in the shape TripMapProjection
 * already uses for its missing layers:
 *
 *   no_source  the table does not exist (42P01 / PGRST205). A FACT about this
 *              deployment, stated with the migration named. A retry will not
 *              help and the projection proceeds WITHOUT routine, saying so.
 *   unread     the read failed for any other reason. Retryable. The projection
 *              proceeds and says the routine is unknown — it does NOT claim
 *              there is none.
 *   ok         the rules, possibly zero of them.
 *
 * An empty `ok` and a `no_source` are different facts and the difference is
 * load-bearing: "this traveller has no routine" and "this database cannot hold
 * one" produce the same empty list and must never produce the same sentence.
 *
 * This module does NOT consult `trip_operational_projections_enabled`. Its
 * callers already did — they are inside that gate — and a second read of the
 * same flag would be a second thing to get out of step.
 */
import { logger } from "../../../lib/logger.js";
import { noSource, ok as okLayer, unread, type Layer } from "../projections/TripMapProjection.js";
import {
  expandRecurrences, nextOccurrenceAfter, summariseRoutine, RecurrenceHorizonError,
  type ExpansionResult, type RecurrenceOccurrence, type RecurrenceRule, type RoutineSummary,
} from "../invariants/TripRecurrence.js";

const log = logger.child({ mod: "tripRoutineContext" });

/** Named here so a refusal can say what to apply, exactly as the capability gate's message does. */
export const RECURRENCE_MIGRATION = "2797_trip_commitment_recurrences.sql";
export const RECURRENCE_ABSENT_REASON =
  `this deployment has no trip_commitment_recurrences table (apply ${RECURRENCE_MIGRATION}); recurring commitments cannot exist here`;

/** The columns 2797 defines that the expander reads. */
const SELECT_COLUMNS =
  "id, trip_id, stage_id, type, label, timezone, freq, interval_count, by_weekday, local_time, " +
  "duration, arrival_lead, lateness_tolerance, prep_duration, place_id, flexibility, confidence, " +
  "effective_from, effective_until, skip_dates";

/** PostgREST and PostgreSQL both have a way of saying "no such table"; this is both of them. */
function looksLikeMissingTable(err: { code?: string | null; message?: string | null } | null): boolean {
  const code = String(err?.code ?? "");
  if (code === "42P01" || code === "PGRST205" || code === "PGRST200") return true;
  return /relation .* does not exist|could not find the table/i.test(String(err?.message ?? ""));
}

/**
 * `interval` comes back from PostgREST as ISO-8601 (`PT20M`) or as PostgreSQL's
 * own text (`00:20:00`), depending on the server's `IntervalStyle`. Both are
 * handled; anything else is null, which the expander reads as "the rule does not
 * say" rather than as zero.
 */
export function intervalToMinutes(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  let m = /^(-?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(s);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    return sign * ((Number(m[2] ?? 0) * 1440) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0) + Number(m[5] ?? 0) / 60);
  }
  m = /^(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(s);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 60);
  }
  m = /^(-?\d+(?:\.\d+)?)\s*(minute|minutes|min|hour|hours|day|days)$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    return unit.startsWith("hour") ? n * 60 : unit.startsWith("day") ? n * 1440 : n;
  }
  return null;
}

/** `YYYY-MM-DD`, whatever shape the driver hands back a `date` in. */
function toLocalDate(v: unknown): string {
  const s = String(v ?? "");
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export function rowToRule(r: Record<string, unknown>): RecurrenceRule {
  const weekdays = Array.isArray(r.by_weekday)
    ? (r.by_weekday as unknown[]).map(Number).filter((n) => Number.isInteger(n))
    : typeof r.by_weekday === "string" && r.by_weekday.startsWith("{")
      // PostgreSQL array literal, which some drivers do not parse for smallint[].
      ? r.by_weekday.slice(1, -1).split(",").map(Number).filter((n) => Number.isInteger(n))
      : null;
  const skips = Array.isArray(r.skip_dates)
    ? (r.skip_dates as unknown[]).map(toLocalDate)
    : typeof r.skip_dates === "string" && r.skip_dates.startsWith("{")
      ? r.skip_dates.slice(1, -1).split(",").filter(Boolean).map((s) => toLocalDate(s.replace(/"/g, "")))
      : [];
  return {
    id: String(r.id),
    tripId: r.trip_id == null ? null : String(r.trip_id),
    stageId: r.stage_id == null ? null : String(r.stage_id),
    type: String(r.type ?? "other"),
    label: r.label == null ? null : String(r.label),
    timezone: String(r.timezone ?? ""),
    freq: r.freq === "daily" ? "daily" : "weekly",
    intervalCount: Number(r.interval_count ?? 1),
    byWeekday: weekdays && weekdays.length ? weekdays : null,
    localTime: String(r.local_time ?? ""),
    durationMinutes: intervalToMinutes(r.duration),
    arrivalLeadMinutes: intervalToMinutes(r.arrival_lead),
    latenessToleranceMinutes: intervalToMinutes(r.lateness_tolerance),
    prepMinutes: intervalToMinutes(r.prep_duration),
    placeId: r.place_id == null ? null : String(r.place_id),
    flexibility: r.flexibility == null ? "flexible" : String(r.flexibility),
    confidence: r.confidence == null ? null : Number(r.confidence),
    effectiveFrom: toLocalDate(r.effective_from),
    effectiveUntil: toLocalDate(r.effective_until),
    skipDates: skips,
  };
}

/** The rules of one trip, as a three-valued layer. See the header. */
export async function readTripRecurrences(sc: any, tripId: string): Promise<Layer<RecurrenceRule>> {
  let res: { data?: unknown; error?: { code?: string; message?: string } | null };
  try {
    res = await sc.from("trip_commitment_recurrences").select(SELECT_COLUMNS).eq("trip_id", tripId);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (looksLikeMissingTable(err)) return noSource<RecurrenceRule>(RECURRENCE_ABSENT_REASON);
    log.warn({ err: err?.message, tripId }, "routine: the recurrence read threw");
    return unread<RecurrenceRule>(`trip_commitment_recurrences could not be read: ${err?.message ?? "unknown error"}`);
  }
  if (res?.error) {
    if (looksLikeMissingTable(res.error)) return noSource<RecurrenceRule>(RECURRENCE_ABSENT_REASON);
    log.warn({ err: res.error.message, tripId }, "routine: trip_commitment_recurrences unreadable");
    return unread<RecurrenceRule>(`trip_commitment_recurrences could not be read: ${res.error.message}`);
  }
  const rows = Array.isArray(res?.data) ? (res.data as Record<string, unknown>[]) : [];
  return okLayer(rows.map(rowToRule));
}

/**
 * §11.1 / §12.1 routine-aware context for one trip over one instant range.
 *
 * `occurrences` is the expansion the freedom engine consumes; `summary` is the
 * PATTERN, derived from the rules and independent of the horizon (see
 * summariseRoutine's header for why that distinction is the point).
 */
export interface TripRoutineContext {
  /** The rules layer, so a consumer can tell "no routine" from "no table" from "read failed". */
  rules: Layer<RecurrenceRule>;
  summary: RoutineSummary | null;
  occurrences: RecurrenceOccurrence[];
  expansion: Pick<ExpansionResult, "truncated" | "inactiveRuleIds" | "rejected" | "horizonDays"> | null;
  /** Set when the caller asked for a range longer than the expander will serve. The refusal is the guarantee, not a failure. */
  horizonRefused: string | null;
  reading: string;
}

export const ROUTINE_CONTEXT_READING =
  "§23 long-stay: recurring commitments are RULES (2797). Occurrences below are computed for THIS read's range only and are " +
  "never stored; their ids are `rec:<ruleId>:<localDate>` and are not commitment ids. An occurrence cannot be marked at risk " +
  "(2785 takes a row) — skip it and add a real commitment instead.";

export async function buildTripRoutineContext(
  sc: any,
  tripId: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<TripRoutineContext> {
  const rules = await readTripRecurrences(sc, tripId);
  if (rules.status !== "ok") {
    return { rules, summary: null, occurrences: [], expansion: null, horizonRefused: null, reading: ROUTINE_CONTEXT_READING };
  }
  const summary = summariseRoutine(rules.items, rangeStart);
  try {
    const e = expandRecurrences(rules.items, rangeStart, rangeEnd);
    return {
      rules, summary, occurrences: e.occurrences,
      expansion: { truncated: e.truncated, inactiveRuleIds: e.inactiveRuleIds, rejected: e.rejected, horizonDays: e.horizonDays },
      horizonRefused: null, reading: ROUTINE_CONTEXT_READING,
    };
  } catch (e) {
    if (e instanceof RecurrenceHorizonError) {
      // NOT an error state: the cap is the "no bloated itinerary model" clause
      // doing its job. The summary still answers "what is the routine"; only
      // the expansion is withheld, and the caller is told which it lost.
      log.info({ tripId, days: e.days }, "routine: expansion refused, horizon too long");
      return { rules, summary, occurrences: [], expansion: null, horizonRefused: e.message, reading: ROUTINE_CONTEXT_READING };
    }
    throw e;
  }
}

/** The next routine occurrence strictly after `after`, without expanding a horizon. Today's question. */
export function nextRoutineOccurrence(ctx: TripRoutineContext, after: Date, lookaheadDays = 14): RecurrenceOccurrence | null {
  if (ctx.rules.status !== "ok") return null;
  return nextOccurrenceAfter(ctx.rules.items, after, lookaheadDays);
}
