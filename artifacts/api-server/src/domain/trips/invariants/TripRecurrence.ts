/**
 * Trips spec §23 certification scenario "Long-stay 45 days" —
 *
 *     "Recurring commitments, routine-aware context, no bloated itinerary
 *      model."
 *
 * census-trips TR427 graded that row **W** with the note "Recurring commitments
 * and routine-aware context do not exist", and §71.5 named the blocker:
 * "Recurring commitments and routine-aware context are a schema change.
 * Migration." The schema is 2797; this is the half that turns a stored RULE
 * into the occurrences every §7/§11 reader already knows how to consume.
 *
 * PURE. No DB calls, no clock of its own (every entry point takes the range or
 * the instant it works over), no I/O — the same contract
 * domain/trips/invariants/tripStatus.ts and TripFreedomEngine.ts hold, and for
 * the same reason: this is arithmetic over a calendar, it is where the hard
 * cases are, and arithmetic is testable only when nothing else is in the way.
 *
 * THE THREE THINGS THIS FILE IS, IN ORDER OF HOW EASY THEY ARE TO GET WRONG
 * ========================================================================
 *
 * 1. A LOCAL WALL-CLOCK TO INSTANT CONVERSION IN AN IANA ZONE.
 *    "Every weekday at 09:00" is a statement about a clock in a place. There is
 *    no `Date` constructor that takes (localDate, localTime, ianaZone), so the
 *    conversion is done the only way the platform allows without a tz library:
 *    guess the UTC instant, ask `Intl.DateTimeFormat` what local time that
 *    instant IS in the zone, and correct by the difference. Twice, because the
 *    first correction can step across a DST boundary and change the offset
 *    again. tripStatus.ts already establishes `Intl` with an explicit
 *    `timeZone` as this codebase's timezone primitive; this extends it from
 *    "which local date is it" to "which instant is this local date-time".
 *
 *    The two DST edge cases are NOT swept under the rug, because on a 45-day
 *    stay they are not hypothetical:
 *      * SPRING FORWARD — 01:30 on the transition day does not exist. The
 *        occurrence is SHIFTED FORWARD BY THE LENGTH OF THE GAP (01:30 becomes
 *        02:30 local) and carries `dst: "skipped_forward"`. That is Luxon's and
 *        java.time's convention; the alternatives (drop it, or clamp it to the
 *        transition) either lose an obligation or silently move two different
 *        rules onto the same instant.
 *      * FALL BACK — 02:30 happens twice. The EARLIER one is chosen (the
 *        pre-transition offset) and the occurrence carries `dst: "ambiguous"`.
 *    Both are reported on the occurrence rather than resolved silently: a
 *    traveller whose standing 02:30 obligation moved deserves to be told, and a
 *    consumer that does not care can ignore a field.
 *
 * 2. A BOUNDED EXPANSION. This is the "no bloated itinerary model" clause, and
 *    it is enforced HERE because it cannot be enforced in the schema: 2797
 *    guarantees nothing is materialised, and this file guarantees nothing
 *    materialises it at read time either. `expandRecurrences` REQUIRES a finite
 *    range, refuses a range longer than MAX_HORIZON_DAYS, and stops at
 *    MAX_OCCURRENCES with `truncated: true` rather than returning whatever it
 *    was asked for. A reader that wants 45 days of a daily routine gets 45
 *    occurrences; a reader that asks for ten years is refused, not obliged.
 *
 * 3. A ROUTINE SUMMARY — the "routine-aware context" clause. See
 *    `summariseRoutine`. The distinction that makes it worth having: a routine
 *    occurrence is NOT NEWS. Thirty-three identical 09:00 classes must not
 *    produce thirty-three notifications, and a Today surface that reports "next:
 *    Vietnamese class, 09:00" for the thirty-third time has told the traveller
 *    nothing. §11.4's attention ladder is the mechanism, and
 *    `routineAttentionEvent` produces the input it takes.
 *
 * OCCURRENCE IDENTITY
 * ===================
 * An occurrence's id is `rec:<ruleId>:<YYYY-MM-DD>` — deterministic (the same
 * rule and the same local date always produce the same id, so two reads agree
 * and a client can key a list on it) and DELIBERATELY NOT A UUID. It cannot be
 * mistaken for a `trip_commitments.id`: a command that tried to UPDATE_COMMITMENT
 * with one is refused by the uuid cast, by the database, without anyone having
 * to remember the rule. What an occurrence therefore CANNOT do is carry
 * anything a commitment row carries — 2785's at-risk marking above all. The
 * model's answer is 2797's: skip the occurrence and add a real commitment.
 */

/** ISO-8601 weekday numbers, as 2797 stores them. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ISO_WEEKDAY_NAMES: Readonly<Record<IsoWeekday, string>> = {
  1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun",
};

/**
 * The read-time half of the anti-bloat guarantee. 400 days is 2798's write-time
 * cap; a READER never needs that much at once — the freedom projection works a
 * stage at a time and Today works a day at a time — so the horizon is tighter
 * than the rule's own range on purpose. Asking for more is a caller bug and is
 * refused rather than served.
 */
export const MAX_HORIZON_DAYS = 120;
/**
 * The hard stop. 120 days of a daily rule is 120; of five rules, 600. The cap
 * is per CALL, across all rules, because the thing being bounded is the array
 * that comes back, not any one pattern.
 */
export const MAX_OCCURRENCES = 1000;

/** A rule as 2797 stores it, with the columns this module needs. */
export interface RecurrenceRule {
  id: string;
  tripId?: string | null;
  stageId?: string | null;
  type: string;
  label?: string | null;
  /** IANA. The rule's local_time is read in THIS zone and nothing else. */
  timezone: string;
  freq: "daily" | "weekly";
  intervalCount: number;
  /** ISO weekdays, ascending. null for daily. */
  byWeekday?: readonly number[] | null;
  /** `HH:MM` or `HH:MM:SS`, local wall clock. */
  localTime: string;
  /** Minutes. null when the rule does not say. */
  durationMinutes?: number | null;
  /** Minutes before localTime the traveller must ARRIVE (§7.1 requiredArrivalAt). */
  arrivalLeadMinutes?: number | null;
  latenessToleranceMinutes?: number | null;
  prepMinutes?: number | null;
  placeId?: string | null;
  flexibility?: string | null;
  confidence?: number | null;
  /** `YYYY-MM-DD`, local calendar dates. */
  effectiveFrom: string;
  effectiveUntil: string;
  /** `YYYY-MM-DD`, local calendar dates this rule does not occur on. */
  skipDates?: readonly string[] | null;
}

export type OccurrenceDst = "normal" | "skipped_forward" | "ambiguous";

export interface RecurrenceOccurrence {
  /** `rec:<ruleId>:<localDate>`. Deterministic, and NOT a uuid — see the header. */
  id: string;
  recurrenceId: string;
  /** `YYYY-MM-DD` in the rule's zone. */
  localDate: string;
  type: string;
  label: string | null;
  stageId: string | null;
  placeId: string | null;
  flexibility: string;
  confidence: number | null;
  /** The instant `localDate` at `localTime` in `timezone`. */
  startsAt: Date;
  /** startsAt minus arrivalLeadMinutes, or startsAt when the rule gives no lead. */
  requiredArrivalAt: Date;
  /** startsAt plus durationMinutes, or null when the rule gives no duration. */
  endsAt: Date | null;
  prepMinutes: number;
  latenessToleranceMinutes: number;
  /** What the zone did to this occurrence. See the header's DST section. */
  dst: OccurrenceDst;
  timezone: string;
}

export interface ExpansionResult {
  occurrences: RecurrenceOccurrence[];
  /** True when MAX_OCCURRENCES stopped the expansion before the range ended. */
  truncated: boolean;
  /** Rules that produced nothing in the range, and why — a silent zero is indistinguishable from a broken rule. */
  inactiveRuleIds: string[];
  /** Rules this module refused to expand at all, with the reason. */
  rejected: { ruleId: string; reason: RecurrenceRejection }[];
  horizonDays: number;
}

export type RecurrenceRejection =
  | "UNKNOWN_TIMEZONE"
  | "MALFORMED_LOCAL_TIME"
  | "MALFORMED_DATE_RANGE"
  | "UNKNOWN_FREQ"
  | "WEEKLY_WITHOUT_WEEKDAYS"
  | "INTERVAL_OUT_OF_RANGE";

export class RecurrenceHorizonError extends Error {
  constructor(public readonly days: number) {
    super(`a recurrence horizon of ${days} days exceeds the ${MAX_HORIZON_DAYS}-day maximum`);
    this.name = "RecurrenceHorizonError";
  }
}

// ── local wall clock ↔ instant ───────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?/;

/** Cache of formatters. Constructing an Intl.DateTimeFormat is not cheap and a 45-day expansion builds one per occurrence otherwise. */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** True when the platform's ICU knows this zone. A rule with a zone it does not know expands to nothing, which must be a REJECTION and not a silent empty. */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!timeZone || /[+]/.test(timeZone)) return false;
  try { zoneFormatter(timeZone); return true; } catch { return false; }
}

/** The wall-clock reading of `instant` in `timeZone`, as milliseconds of a fictional UTC date. The difference between this and `instant` IS the zone's offset at that instant. */
function wallClockMs(instant: Date, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(instant);
  const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
}

export interface ZonedInstant { instant: Date; dst: OccurrenceDst }

/**
 * `localDate` at `localTime` in `timeZone`, as an instant.
 *
 * The method: take the wanted wall clock as if it were UTC, ask the zone what
 * wall clock that instant really shows, and subtract the difference. Repeat
 * once — the first correction can cross a DST boundary into a different offset.
 * Then VERIFY: if the resulting instant does not read back as the wall clock we
 * asked for, that wall clock does not exist (spring forward) and what we have
 * is the first instant after the gap.
 *
 * Ambiguity (fall back) is detected by trying the pre-transition offset first:
 * if the instant one hour EARLIER also reads back as the wanted wall clock,
 * there are two and the earlier is returned.
 */
export function zonedLocalToInstant(localDate: string, localTime: string, timeZone: string): ZonedInstant {
  const t = TIME_RE.exec(localTime);
  if (!DATE_RE.test(localDate) || !t) throw new RangeError(`not a local date-time: ${localDate} ${localTime}`);
  const [y, mo, d] = localDate.split("-").map(Number) as [number, number, number];
  const wanted = Date.UTC(y, mo - 1, d, Number(t[1]), Number(t[2]), Number(t[3] ?? "0"));

  // Two candidates, because one correction is not enough: the first correction
  // can cross a transition and land under a DIFFERENT offset, and the second
  // candidate is the one computed under that offset. In an ordinary hour both
  // agree; in a transition hour they do not, and which of them READS BACK as
  // the wanted wall clock is what tells the three cases apart.
  const off1 = wallClockMs(new Date(wanted), timeZone) - wanted;
  const cand1 = wanted - off1;
  const off2 = wallClockMs(new Date(cand1), timeZone) - cand1;
  const cand2 = wanted - off2;
  const ok1 = wallClockMs(new Date(cand1), timeZone) === wanted;
  const ok2 = wallClockMs(new Date(cand2), timeZone) === wanted;

  // Neither reads back: the wanted wall clock DOES NOT EXIST on this date in
  // this zone. The later candidate is the wanted time shifted forward by the
  // gap, which is the convention named in the header.
  if (!ok1 && !ok2) return { instant: new Date(Math.max(cand1, cand2)), dst: "skipped_forward" };

  const chosen = ok1 ? cand1 : cand2;
  // AMBIGUITY: on a fall-back day the wanted wall clock happens twice and both
  // candidates collapse onto the LATER one, so the earlier is found by probing
  // an hour back. (One hour, because every zone in tzdata but Lord Howe moves
  // by an hour; a 30-minute repeat there reads as `normal`, which is the
  // honest limit of this probe rather than a wrong instant.)
  const earlier = chosen - 3_600_000;
  if (wallClockMs(new Date(earlier), timeZone) === wanted) return { instant: new Date(earlier), dst: "ambiguous" };
  return { instant: new Date(chosen), dst: "normal" };
}

/** The local calendar date of `instant` in `timeZone`, as `YYYY-MM-DD`. */
export function zonedLocalDate(instant: Date, timeZone: string): string {
  const ms = wallClockMs(instant, timeZone);
  return new Date(ms).toISOString().slice(0, 10);
}

// ── calendar arithmetic on `YYYY-MM-DD`, with no Date in the middle ──────────
// A local calendar date is not an instant and must not be turned into one to be
// incremented: `new Date("2026-10-25")` is midnight UTC, and adding 24h to it
// lands on the wrong DAY in any zone whose offset moved. These four helpers
// work on the UTC epoch-day of the date's own numbers, which has no zone at all.

const DAY_MS = 86_400_000;
function dayNumber(localDate: string): number {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
function dayToLocalDate(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
/** ISO weekday (1=Mon … 7=Sun) of an epoch day. Epoch day 0 was a Thursday. */
function isoWeekdayOfDay(n: number): IsoWeekday {
  return ((((n + 3) % 7) + 7) % 7 + 1) as IsoWeekday;
}
/** ISO weekday (1=Mon … 7=Sun) of a calendar date. */
export function isoWeekdayOf(localDate: string): IsoWeekday {
  return isoWeekdayOfDay(dayNumber(localDate));
}
/** The epoch day of the Monday of `n`'s ISO week. */
function mondayOf(n: number): number {
  return n - (isoWeekdayOfDay(n) - 1);
}

// ── expansion ────────────────────────────────────────────────────────────────

function validate(rule: RecurrenceRule): RecurrenceRejection | null {
  if (!DATE_RE.test(rule.effectiveFrom) || !DATE_RE.test(rule.effectiveUntil)
      || dayNumber(rule.effectiveUntil) < dayNumber(rule.effectiveFrom)) return "MALFORMED_DATE_RANGE";
  if (!TIME_RE.test(rule.localTime)) return "MALFORMED_LOCAL_TIME";
  if (rule.freq !== "daily" && rule.freq !== "weekly") return "UNKNOWN_FREQ";
  if (rule.freq === "weekly" && !(rule.byWeekday && rule.byWeekday.length > 0)) return "WEEKLY_WITHOUT_WEEKDAYS";
  if (!Number.isInteger(rule.intervalCount) || rule.intervalCount < 1 || rule.intervalCount > 52) return "INTERVAL_OUT_OF_RANGE";
  if (!isKnownTimeZone(rule.timezone)) return "UNKNOWN_TIMEZONE";
  return null;
}

/**
 * The epoch day of the FIRST date this rule could occur on — `effectiveFrom`
 * for a daily rule, and for a weekly one the first matching weekday on or after
 * it. This is the interval ANCHOR, and which date it is matters:
 *
 * "every other Tuesday", set up on a Thursday, must mean "the coming Tuesday,
 * then the one after next". Anchoring on `effectiveFrom`'s own ISO week instead
 * would make week 0 the week whose Tuesday has already gone, so the first
 * occurrence would land TWELVE days out — correct by the arithmetic and wrong
 * by every reading of the sentence. Anchoring on the first occurrence costs one
 * seven-day scan, once per rule, and cannot produce that surprise.
 */
function anchorDay(rule: RecurrenceRule): number {
  const from = dayNumber(rule.effectiveFrom);
  if (rule.freq === "daily" || !rule.byWeekday?.length) return from;
  for (let d = from; d < from + 7; d += 1) if (rule.byWeekday.includes(isoWeekdayOfDay(d))) return d;
  return from;
}

/**
 * Does `rule` occur on this local date? Weeks are counted in whole ISO weeks
 * from the Monday of the anchor's week, so an "every 2 weeks" rule keeps its
 * parity no matter which day of the week the caller asks about.
 */
function occursOn(rule: RecurrenceRule, localDate: string): boolean {
  const day = dayNumber(localDate);
  const from = dayNumber(rule.effectiveFrom);
  if (day < from || day > dayNumber(rule.effectiveUntil)) return false;
  if (rule.skipDates?.includes(localDate)) return false;
  if (rule.freq === "daily") return (day - from) % rule.intervalCount === 0;
  if (!rule.byWeekday?.includes(isoWeekdayOf(localDate))) return false;
  if (rule.intervalCount === 1) return true;
  return ((mondayOf(day) - mondayOf(anchorDay(rule))) / 7) % rule.intervalCount === 0;
}

function minutesOr(v: number | null | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

function materialiseOne(rule: RecurrenceRule, localDate: string): RecurrenceOccurrence {
  const { instant, dst } = zonedLocalToInstant(localDate, rule.localTime, rule.timezone);
  const lead = minutesOr(rule.arrivalLeadMinutes, 0);
  const duration = typeof rule.durationMinutes === "number" && rule.durationMinutes >= 0 ? rule.durationMinutes : null;
  return {
    id: `rec:${rule.id}:${localDate}`,
    recurrenceId: rule.id,
    localDate,
    type: rule.type,
    label: rule.label ?? null,
    stageId: rule.stageId ?? null,
    placeId: rule.placeId ?? null,
    flexibility: rule.flexibility ?? "flexible",
    confidence: typeof rule.confidence === "number" ? rule.confidence : null,
    startsAt: instant,
    requiredArrivalAt: new Date(instant.getTime() - lead * 60_000),
    endsAt: duration === null ? null : new Date(instant.getTime() + duration * 60_000),
    prepMinutes: minutesOr(rule.prepMinutes, 0),
    latenessToleranceMinutes: minutesOr(rule.latenessToleranceMinutes, 0),
    dst,
    timezone: rule.timezone,
  };
}

/**
 * Expand `rules` over `[rangeStart, rangeEnd]` — INSTANTS, because that is what
 * every caller has (a projection's window, a Today's day) and converting them to
 * each rule's own local dates is this function's job and not the caller's.
 *
 * Throws RecurrenceHorizonError when the range is longer than MAX_HORIZON_DAYS.
 * That is deliberate and is the point of the whole file: the one way a
 * rule-based model becomes a materialised one is a caller asking for everything,
 * and a refusal is the only answer that keeps the guarantee.
 */
export function expandRecurrences(
  rules: readonly RecurrenceRule[],
  rangeStart: Date,
  rangeEnd: Date,
): ExpansionResult {
  const spanMs = rangeEnd.getTime() - rangeStart.getTime();
  const horizonDays = Math.ceil(spanMs / DAY_MS);
  if (!Number.isFinite(spanMs) || spanMs < 0) throw new RangeError("expandRecurrences: the range is not ordered");
  if (horizonDays > MAX_HORIZON_DAYS) throw new RecurrenceHorizonError(horizonDays);

  const occurrences: RecurrenceOccurrence[] = [];
  const inactiveRuleIds: string[] = [];
  const rejected: { ruleId: string; reason: RecurrenceRejection }[] = [];
  let truncated = false;

  for (const rule of rules) {
    const bad = validate(rule);
    if (bad) { rejected.push({ ruleId: rule.id, reason: bad }); continue; }

    // The local-date window this instant range covers IN THIS RULE'S ZONE, one
    // day of slack at each end because an instant range rarely aligns with a
    // local midnight and the occurrence at either edge belongs to the caller.
    const firstDay = Math.max(dayNumber(zonedLocalDate(rangeStart, rule.timezone)) - 1, dayNumber(rule.effectiveFrom));
    const lastDay = Math.min(dayNumber(zonedLocalDate(rangeEnd, rule.timezone)) + 1, dayNumber(rule.effectiveUntil));

    let produced = 0;
    for (let day = firstDay; day <= lastDay; day += 1) {
      const localDate = dayToLocalDate(day);
      if (!occursOn(rule, localDate)) continue;
      const occ = materialiseOne(rule, localDate);
      // The slack days are a search window, not an output window: an occurrence
      // outside the caller's actual instant range is dropped here.
      if (occ.startsAt.getTime() < rangeStart.getTime() || occ.startsAt.getTime() > rangeEnd.getTime()) continue;
      if (occurrences.length >= MAX_OCCURRENCES) { truncated = true; break; }
      occurrences.push(occ);
      produced += 1;
    }
    if (produced === 0) inactiveRuleIds.push(rule.id);
    if (truncated) break;
  }

  occurrences.sort((a, b) => a.requiredArrivalAt.getTime() - b.requiredArrivalAt.getTime()
    || a.id.localeCompare(b.id));
  return { occurrences, truncated, inactiveRuleIds, rejected, horizonDays };
}

/**
 * The next occurrence of any rule strictly after `after`, WITHOUT expanding a
 * horizon. Today needs one answer, not a list, and making it pay for 45 days of
 * expansion to get it is the bloat this model exists to avoid. Walks forward a
 * day at a time and stops at the first hit or at `lookaheadDays`.
 */
export function nextOccurrenceAfter(
  rules: readonly RecurrenceRule[],
  after: Date,
  lookaheadDays = 14,
): RecurrenceOccurrence | null {
  let best: RecurrenceOccurrence | null = null;
  for (const rule of rules) {
    if (validate(rule)) continue;
    const start = dayNumber(zonedLocalDate(after, rule.timezone));
    const last = Math.min(start + lookaheadDays, dayNumber(rule.effectiveUntil));
    for (let day = Math.max(start, dayNumber(rule.effectiveFrom)); day <= last; day += 1) {
      const localDate = dayToLocalDate(day);
      if (!occursOn(rule, localDate)) continue;
      const occ = materialiseOne(rule, localDate);
      if (occ.requiredArrivalAt.getTime() <= after.getTime()) continue;
      if (!best || occ.requiredArrivalAt.getTime() < best.requiredArrivalAt.getTime()) best = occ;
      break;
    }
  }
  return best;
}

// ── routine-aware context ────────────────────────────────────────────────────

export interface RoutineEntry {
  recurrenceId: string;
  label: string | null;
  type: string;
  /** "every weekday at 09:00", "every day at 07:30", "every 2 weeks on Tue, Thu at 18:30". */
  cadence: string;
  timezone: string;
  localTime: string;
  weekdays: IsoWeekday[];
  /** Occurrences per week this rule contributes, at its own interval. */
  perWeek: number;
  effectiveFrom: string;
  effectiveUntil: string;
  skippedDates: string[];
  /** True while `asOf` falls inside [effectiveFrom, effectiveUntil] in the rule's zone. */
  active: boolean;
}

export interface RoutineSummary {
  entries: RoutineEntry[];
  /** Total occurrences per week across every active rule. The one number that says "this is a life, not a trip". */
  occurrencesPerWeek: number;
  /**
   * Local hours (0–23) claimed by the routine on each ISO weekday, as the
   * complement of which the surface can say "your Tuesdays are free after 11".
   * Keyed by weekday; each value is the sorted set of claimed hours.
   */
  claimedHoursByWeekday: Record<IsoWeekday, number[]>;
  /** True when at least one rule covers five or more days a week — the long-stay signature. */
  hasDailyRhythm: boolean;
  /** The zone the routine is lived in, when every rule agrees on one; null when they disagree. */
  timezone: string | null;
  reading: string;
}

export const ROUTINE_READING =
  "§23 long-stay: the recurrence RULES in force, not their occurrences. A routine is a pattern the traveller already knows; " +
  "the surface's job is to say what is DIFFERENT, not to re-announce it. Occurrences are computed per read over a bounded " +
  "horizon (TripRecurrence.expandRecurrences) and are never stored.";

function cadenceOf(rule: RecurrenceRule): string {
  const hhmm = rule.localTime.slice(0, 5);
  const every = rule.intervalCount === 1 ? "every" : `every ${rule.intervalCount}`;
  if (rule.freq === "daily") return `${every} ${rule.intervalCount === 1 ? "day" : "days"} at ${hhmm}`;
  const days = [...(rule.byWeekday ?? [])].sort((a, b) => a - b) as IsoWeekday[];
  const isWeekdays = days.length === 5 && days.every((d, i) => d === i + 1);
  const isWeekend = days.length === 2 && days[0] === 6 && days[1] === 7;
  const named = isWeekdays ? "weekday" : isWeekend ? "weekend day" : days.map((d) => ISO_WEEKDAY_NAMES[d]).join(", ");
  if (rule.intervalCount === 1 && (isWeekdays || isWeekend)) return `every ${named} at ${hhmm}`;
  if (rule.intervalCount === 1) return `every ${named} at ${hhmm}`;
  return `every ${rule.intervalCount} weeks on ${days.map((d) => ISO_WEEKDAY_NAMES[d]).join(", ")} at ${hhmm}`;
}

/**
 * The §23 "routine-aware context" clause: what the trip's standing rhythm IS,
 * derived from the rules and not from their expansion.
 *
 * Deriving it from the RULES is the whole point. A summary computed by
 * expanding 45 days and counting would be a summary that costs 45 days of work,
 * would change shape at the edges of the horizon, and would be unable to say
 * anything about the part of the stay outside it. A rule already contains the
 * pattern; reading it back out is arithmetic on six fields.
 */
export function summariseRoutine(rules: readonly RecurrenceRule[], asOf: Date): RoutineSummary {
  const entries: RoutineEntry[] = [];
  const claimed: Record<IsoWeekday, Set<number>> = { 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set(), 5: new Set(), 6: new Set(), 7: new Set() };
  const zones = new Set<string>();
  let perWeekTotal = 0;
  let dailyRhythm = false;

  for (const rule of rules) {
    if (validate(rule)) continue;
    const today = zonedLocalDate(asOf, rule.timezone);
    const active = dayNumber(today) >= dayNumber(rule.effectiveFrom) && dayNumber(today) <= dayNumber(rule.effectiveUntil);
    const weekdays = (rule.freq === "daily"
      ? [1, 2, 3, 4, 5, 6, 7]
      : [...(rule.byWeekday ?? [])].sort((a, b) => a - b)) as IsoWeekday[];
    const perWeek = (rule.freq === "daily" ? 7 : weekdays.length) / rule.intervalCount;
    const hour = Number(TIME_RE.exec(rule.localTime)?.[1] ?? "0");

    entries.push({
      recurrenceId: rule.id, label: rule.label ?? null, type: rule.type,
      cadence: cadenceOf(rule), timezone: rule.timezone, localTime: rule.localTime.slice(0, 5),
      weekdays, perWeek: Math.round(perWeek * 100) / 100,
      effectiveFrom: rule.effectiveFrom, effectiveUntil: rule.effectiveUntil,
      skippedDates: [...(rule.skipDates ?? [])].sort(),
      active,
    });

    if (!active) continue;
    zones.add(rule.timezone);
    perWeekTotal += perWeek;
    if (weekdays.length >= 5) dailyRhythm = true;
    // The hours the obligation OCCUPIES: from the moment the traveller must
    // start preparing to the end of the thing. A routine that claims 09:00–10:30
    // has not left the traveller free at 09:30.
    const startMin = hour * 60 + Number(TIME_RE.exec(rule.localTime)?.[2] ?? "0") - minutesOr(rule.prepMinutes, 0) - minutesOr(rule.arrivalLeadMinutes, 0);
    const endMin = hour * 60 + Number(TIME_RE.exec(rule.localTime)?.[2] ?? "0") + (rule.durationMinutes ?? 0);
    for (const d of weekdays) {
      for (let m = Math.max(startMin, 0); m <= Math.min(endMin, 24 * 60 - 1); m += 60) claimed[d].add(Math.floor(m / 60));
      claimed[d].add(Math.floor(Math.min(Math.max(endMin, 0), 24 * 60 - 1) / 60));
    }
  }

  return {
    entries,
    occurrencesPerWeek: Math.round(perWeekTotal * 100) / 100,
    claimedHoursByWeekday: {
      1: [...claimed[1]].sort((a, b) => a - b), 2: [...claimed[2]].sort((a, b) => a - b),
      3: [...claimed[3]].sort((a, b) => a - b), 4: [...claimed[4]].sort((a, b) => a - b),
      5: [...claimed[5]].sort((a, b) => a - b), 6: [...claimed[6]].sort((a, b) => a - b),
      7: [...claimed[7]].sort((a, b) => a - b),
    },
    hasDailyRhythm: dailyRhythm,
    timezone: zones.size === 1 ? [...zones][0]! : null,
    reading: ROUTINE_READING,
  };
}

/** The local hours of `weekday` that the routine does NOT claim — §7.3's question, asked of a pattern rather than of a day. */
export function habitualFreeHours(summary: RoutineSummary, weekday: IsoWeekday): number[] {
  const claimed = new Set(summary.claimedHoursByWeekday[weekday]);
  const free: number[] = [];
  for (let h = 0; h < 24; h += 1) if (!claimed.has(h)) free.push(h);
  return free;
}

/**
 * §11.4: what a routine occurrence is worth interrupting for.
 *
 * "Do not convert every social or live-intel change into a push notification"
 * is the spec's sentence, and a standing 09:00 obligation on day 34 of a 45-day
 * stay is the purest example of a change that is not one. An ON-PATTERN
 * occurrence is `low` significance and NOT actionable: there is nothing for the
 * traveller to decide, because they already decided, once, when they created
 * the rule. What IS worth surfacing is a DEVIATION — an occurrence the zone
 * moved (DST), or one whose rule is about to lapse.
 *
 * Returns the §11.4 AttentionEvent fields; the caller passes them to
 * policies/TripAttentionPolicy.decideAttention with its own context. This module
 * does not import that policy, and does not decide: it describes.
 */
export function routineAttentionEvent(
  occ: RecurrenceOccurrence,
  opts: { ruleEndsAfterThisOccurrence?: boolean } = {},
): { kind: string; significance: "none" | "low" | "medium" | "high" | "critical"; affectsViewer: boolean; actionable: boolean; deadlineAt: string } {
  const deviated = occ.dst !== "normal";
  const lapsing = opts.ruleEndsAfterThisOccurrence === true;
  return {
    kind: "trip.routine_occurrence",
    significance: deviated ? "medium" : lapsing ? "low" : "none",
    affectsViewer: true,
    // On-pattern: nothing to do. Deviated: the traveller may need to move.
    actionable: deviated || lapsing,
    deadlineAt: occ.requiredArrivalAt.toISOString(),
  };
}
