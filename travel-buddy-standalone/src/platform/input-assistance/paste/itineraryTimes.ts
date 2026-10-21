/**
 * Global Input Intelligence — §24 itinerary blocks (census G160): reading the
 * TIME a pasted itinerary line carries and placing it on one calendar day in
 * one named time zone, WITHOUT GUESSING.
 *
 * The extract route (`POST /api/input-assistance/extract`) already cuts an
 * itinerary into items and carries each item's `timeHint` ("7", "7:30pm",
 * "21h") and `dayLabel` ("Friday", "Day 2") to the client, kept out of the place
 * query. This module is what turns those two strings into an instant a Trip can
 * store — or says, precisely, what is missing so the person can supply it.
 *
 * WHAT COUNTS AS UNAMBIGUOUS, and nothing else does:
 *   CLOCK  "7pm", "7:30 a.m.", "19:00", "0:30", "07:30" (a leading zero is the
 *          24-hour convention), "21h" (the h-suffix is 24-hour). A bare 1–12
 *          ("7", "10:30", "12") is EITHER morning or evening; both readings are
 *          returned and the person picks — "Dinner at 7" is not read as 19:00.
 *   DAY    an ISO date; "Day N" against the trip's first day (inside the trip);
 *          a weekday that falls EXACTLY ONCE inside the trip's dates; "today",
 *          "tonight", "tomorrow" against today's date IN THE STOP'S ZONE. Two
 *          Fridays in the trip, no trip dates, "weekend", or a heading that is
 *          not a day ("Hoi An:") → the person picks from the trip's days.
 *   ZONE   a wall-clock time in a zone where the clocks skip it (spring
 *          forward) does not exist and is NOT moved to the next valid minute;
 *          one that happens twice (fall back) is returned with both instants
 *          for the person to pick. A zone this runtime cannot compute in is
 *          said, never replaced by the phone's zone.
 *
 * Pure module — no React, no network, no RN. node:test-safe.
 */

export interface ClockTime { hour: number; minute: number }

export type ClockReading =
  | { kind: 'exact'; time: ClockTime }
  /** A bare 1–12: both readings, for the person to choose between. */
  | { kind: 'meridiem'; am: ClockTime; pm: ClockTime }
  | { kind: 'unreadable' };

const CLOCK = /^(\d{1,2})(?::(\d{2}))?(am|pm|a\.m\.|p\.m\.|h)?$/;
const UNREADABLE: ClockReading = { kind: 'unreadable' };
const exact = (hour: number, minute: number): ClockReading => ({ kind: 'exact', time: { hour, minute } });

/** Read an itinerary `timeHint`. Whitespace and case are ignored; anything else must match. */
export function readClock(hint: string | null | undefined): ClockReading {
  if (typeof hint !== 'string') return UNREADABLE;
  const m = CLOCK.exec(hint.replace(/\s+/g, '').toLowerCase());
  if (!m) return UNREADABLE;
  const hourText = m[1]!;
  const hour = Number(hourText);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3] ?? null;
  if (minute > 59) return UNREADABLE;
  if (suffix === 'am' || suffix === 'a.m.') return hour >= 1 && hour <= 12 ? exact(hour % 12, minute) : UNREADABLE;
  if (suffix === 'pm' || suffix === 'p.m.') return hour >= 1 && hour <= 12 ? exact((hour % 12) + 12, minute) : UNREADABLE;
  if (hour > 23) return UNREADABLE;
  if (suffix === 'h') return exact(hour, minute);
  if (hour === 0 || hour >= 13 || (hourText.length === 2 && hourText.startsWith('0'))) return exact(hour, minute);
  return { kind: 'meridiem', am: { hour: hour % 12, minute }, pm: { hour: (hour % 12) + 12, minute } };
}

// ── Days ─────────────────────────────────────────────────────────────────────

export interface TripWindow { start: string | null; end: string | null }

export type DayChoiceReason =
  | 'no_label'        // the line sits under no heading
  | 'unrecognised'    // a heading that is not a day ("Hoi An")
  | 'weekday_none'    // no such weekday inside the trip's dates
  | 'weekday_many'    // that weekday falls more than once inside the trip
  | 'day_outside'     // "Day 9" of a five-day trip
  | 'weekend'         // two days, not one
  | 'no_trip_dates';  // a weekday or "Day N" with no trip dates to place it

export type DayReading =
  | { kind: 'date'; date: string }
  | { kind: 'choose'; why: DayChoiceReason; options: string[] };

/** At most this many days are offered to choose from. */
export const MAX_DAY_OPTIONS = 31;
/** A trip window longer than this is not walked. */
const MAX_WINDOW_DAYS = 400;
const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' → UTC midnight ms, or null for anything that is not a real calendar date. */
export function dateMs(date: string | null | undefined): number | null {
  if (typeof date !== 'string') return null;
  const m = ISO_DATE.exec(date.trim().slice(0, 10));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Every date of the trip, first to last, or [] when either end is unknown or unreadable. */
export function tripDays(trip: TripWindow | null): string[] {
  const a = dateMs(trip?.start ?? null);
  const b = dateMs(trip?.end ?? null);
  if (a === null || b === null || b < a) return [];
  const out: string[] = [];
  for (let t = a; t <= b && out.length < MAX_WINDOW_DAYS; t += DAY_MS) out.push(isoDate(t));
  return out;
}

const WEEKDAY = /^(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/;
const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Place an itinerary heading on one date. `today` is today's date in the
 * STOP'S zone (see {@link todayIn}), or null when it cannot be computed.
 */
export function readDay(label: string | null | undefined, trip: TripWindow | null, today: string | null): DayReading {
  const days = tripDays(trip);
  const choose = (why: DayChoiceReason, options: string[] = days): DayReading => ({ kind: 'choose', why, options: options.slice(0, MAX_DAY_OPTIONS) });
  const text = typeof label === 'string' ? label.trim().toLowerCase() : '';
  if (!text) return choose('no_label');

  const iso = /^(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso && dateMs(iso[1]!) !== null) return { kind: 'date', date: iso[1]! };

  const dayN = /^day\s*(\d{1,2})\b/.exec(text);
  if (dayN) {
    const start = dateMs(trip?.start ?? null);
    if (start === null) return choose('no_trip_dates', []);
    const n = Number(dayN[1]);
    const end = dateMs(trip?.end ?? null);
    const at = start + (n - 1) * DAY_MS;
    if (n < 1 || (end !== null && at > end)) return choose('day_outside');
    return { kind: 'date', date: isoDate(at) };
  }

  if (/^(today|tonight)\b/.test(text)) {
    return today && dateMs(today) !== null ? { kind: 'date', date: today } : choose('unrecognised');
  }
  if (/^tomorrow\b/.test(text)) {
    const t = dateMs(today);
    return t !== null ? { kind: 'date', date: isoDate(t + DAY_MS) } : choose('unrecognised');
  }
  if (/^weekend\b/.test(text)) {
    const weekend = days.filter((d) => [0, 6].includes(new Date(dateMs(d)!).getUTCDay()));
    return choose('weekend', weekend.length > 0 ? weekend : days);
  }

  const wd = WEEKDAY.exec(text);
  if (wd) {
    if (days.length === 0) return choose('no_trip_dates', []);
    const want = WEEKDAY_INDEX[wd[1]!.slice(0, 3)]!;
    const hits = days.filter((d) => new Date(dateMs(d)!).getUTCDay() === want);
    if (hits.length === 1) return { kind: 'date', date: hits[0]! };
    return hits.length === 0 ? choose('weekday_none') : choose('weekday_many', hits);
  }
  return choose('unrecognised');
}

// ── Zones ────────────────────────────────────────────────────────────────────

/** The shape of an IANA zone name — the same test the gateway bridge applies (geoSuggestions.ts). */
const IANA_ZONE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (formatters.has(zone)) return formatters.get(zone) ?? null;
  let dtf: Intl.DateTimeFormat | null = null;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtf.format(new Date(0)); // some runtimes accept the option and fail on use
  } catch {
    dtf = null;
  }
  formatters.set(zone, dtf);
  return dtf;
}

/** A zone name this runtime can compute wall-clock times in. Never a fallback. */
export function usableZone(zone: string | null | undefined): string | null {
  const z = typeof zone === 'string' ? zone.trim() : '';
  return z && IANA_ZONE.test(z) && formatterFor(z) ? z : null;
}

/** The wall clock `zone` shows at `utcMs`, as if it were UTC (ms). */
function wallAt(dtf: Intl.DateTimeFormat, utcMs: number): number {
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
}

/** Today's date as the wall clock in `zone` shows it, or null. */
export function todayIn(zone: string | null | undefined, now: Date): string | null {
  const z = usableZone(zone);
  if (!z) return null;
  return isoDate(wallAt(formatterFor(z)!, now.getTime()));
}

export type InstantReading =
  | { kind: 'exact'; iso: string }
  /** The clocks go back: this wall time happens twice. Earlier first. */
  | { kind: 'twice'; earlier: string; later: string }
  /** The clocks go forward: this wall time does not happen on that day. */
  | { kind: 'skipped' }
  | { kind: 'bad_zone' }
  | { kind: 'bad_date' };

function offsetText(offsetMs: number): string {
  const minutes = Math.round(offsetMs / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** The ISO instant for a wall time at a known offset: `2026-10-23T19:00:00+07:00`. */
function isoAt(date: string, time: ClockTime, offsetMs: number): string {
  return `${date}T${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}:00${offsetText(offsetMs)}`;
}

/**
 * The instant at which `zone`'s wall clock reads `date` `time`. Every offset
 * the zone uses within a day either side is tried, and an instant counts only
 * if the zone's clock really reads that wall time at it — which is what
 * separates a skipped hour (no instant) and a repeated one (two) from the
 * ordinary case (one).
 */
export function wallTimeToInstant(date: string, time: ClockTime, zone: string | null | undefined): InstantReading {
  const z = usableZone(zone);
  if (!z) return { kind: 'bad_zone' };
  const day = dateMs(date);
  if (day === null || !Number.isInteger(time.hour) || !Number.isInteger(time.minute)
    || time.hour < 0 || time.hour > 23 || time.minute < 0 || time.minute > 59) return { kind: 'bad_date' };
  const dtf = formatterFor(z)!;
  const wall = day + time.hour * 3_600_000 + time.minute * 60_000;
  const offsets = new Set([wallAt(dtf, wall - DAY_MS) - (wall - DAY_MS), wallAt(dtf, wall) - wall, wallAt(dtf, wall + DAY_MS) - (wall + DAY_MS)]);
  const hits = [...new Set([...offsets].map((o) => wall - o))].filter((t) => wallAt(dtf, t) === wall).sort((a, b) => a - b);
  if (hits.length === 0) return { kind: 'skipped' };
  const at = (t: number) => isoAt(isoDate(day), time, wall - t);
  if (hits.length === 1) return { kind: 'exact', iso: at(hits[0]!) };
  return { kind: 'twice', earlier: at(hits[0]!), later: at(hits[hits.length - 1]!) };
}

// ── Words for the review screen (fixed English, so a test can read them) ─────

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-23' → 'Fri 23 Oct'. */
export function dayWords(date: string): string {
  const ms = dateMs(date);
  if (ms === null) return date;
  const d = new Date(ms);
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
}

/** { hour: 19, minute: 5 } → '19:05'. */
export function clockWords(time: ClockTime): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}

/** { hour: 19, minute: 0 } → '7:00 pm'; for the morning-or-evening choice. */
export function meridiemWords(time: ClockTime): string {
  const h = time.hour % 12 === 0 ? 12 : time.hour % 12;
  return `${h}:${String(time.minute).padStart(2, '0')} ${time.hour < 12 ? 'am' : 'pm'}`;
}

/** The UTC offset an ISO instant carries, as 'GMT+7' / 'GMT-3:30' / 'GMT'. */
export function offsetWords(iso: string): string {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return 'GMT';
  const h = Number(m[2]); const min = Number(m[3]);
  if (h === 0 && min === 0) return 'GMT';
  return `GMT${m[1]}${h}${min ? `:${m[3]}` : ''}`;
}
