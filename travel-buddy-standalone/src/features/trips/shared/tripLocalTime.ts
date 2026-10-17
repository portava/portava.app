/**
 * A date + time a person TYPES in a field, read in a NAMED time zone that the
 * field states — the trip surfaces' typed-time reader (census-trips TR13, TR15,
 * TR123).
 *
 * ONE CONVERSION, NOT TWO
 * =======================
 * Turning a wall time in a zone into an instant — and saying when there is no
 * single answer — is itineraryTimes.ts's (`usableZone`, `wallTimeToInstant`,
 * `offsetWords`, `dateMs`; the itinerary paste review uses it too). This module
 * does not convert anything itself: it reads what was typed ("2026-10-23",
 * "19:00", strict, 24-hour) and hands it to that conversion. The one thing it
 * adds is the other direction — how a stage's zone shows an instant the server
 * served — which the paste review has no need for.
 *
 * WHAT IS NEVER GUESSED (itineraryTimes.ts's rules, restated as field states)
 *   A zone this runtime cannot compute in   `no_zone`; never the phone's zone.
 *   A wall time the clocks skip             `skipped`; not moved.
 *   A wall time that happens twice          `twice` until the person picks.
 *   A date or a time that is not real       `bad_date` / `bad_time`.
 *
 * Pure: imports only the pure itineraryTimes.ts. node:test-safe, and loadable
 * by the api-server's suites.
 */
import { dateMs, usableZone, wallTimeToInstant, offsetWords, type ClockTime } from '../../../platform/input-assistance/paste/itineraryTimes.ts';

export { usableZone, offsetWords };

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
/** 24-hour HH:MM only. "7" or "7pm" is not accepted here: a bare 7 is morning OR evening. */
const CLOCK_TEXT = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' as typed, if it names a real calendar date; else null. */
export function readDateText(text: string | null | undefined): string | null {
  const t = typeof text === 'string' ? text.trim() : '';
  return DATE_TEXT.test(t) && dateMs(t) !== null ? t : null;
}

/** 'HH:MM' (24-hour) as typed; else null. */
export function readClockText(text: string | null | undefined): ClockTime | null {
  const m = CLOCK_TEXT.exec(typeof text === 'string' ? text.trim() : '');
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/**
 * How `zone`'s wall clock reads at an instant the server served
 * (`2026-10-23T12:00:00+00:00` in Asia/Ho_Chi_Minh → `{ date: '2026-10-23',
 * time: '19:00' }`). Null when either cannot be read — the caller then says so
 * rather than drawing the instant in some other zone.
 */
export function instantInZone(iso: string | null | undefined, zone: string | null | undefined): { date: string; time: string } | null {
  const z = usableZone(zone);
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!z || !Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: z, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 'NaN');
  const [y, mo, d, h, mi] = [get('year'), get('month'), get('day'), get('hour') % 24, get('minute')];
  if (![y, mo, d, h, mi].every(Number.isFinite)) return null;
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time: `${pad(h)}:${pad(mi)}` };
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-23' → 'Fri 23 Oct 2026' (a stage can span a year end, so the year is said). A date that is not real comes back as given. */
export function dateWords(date: string): string {
  const ms = dateMs(readDateText(date));
  if (ms === null) return date;
  const at = new Date(ms);
  return `${WEEKDAY[at.getUTCDay()]} ${at.getUTCDate()} ${MONTH[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

// ── A time a person is typing ────────────────────────────────────────────────

/** What a date + time field holds while it is being typed, and which of two instants was picked. */
export interface TypedTime { date: string; time: string; pick: 'earlier' | 'later' | null }
export const EMPTY_TYPED_TIME: TypedTime = { date: '', time: '', pick: null };

export type TypedTimeReading =
  /** Nothing typed: the field is not set. */
  | { kind: 'empty' }
  | { kind: 'ok'; iso: string }
  /** One of date / time is typed and the other is not. */
  | { kind: 'incomplete' }
  | { kind: 'bad_date' }
  | { kind: 'bad_time' }
  /** No zone this runtime can compute in: no time can be placed yet. */
  | { kind: 'no_zone' }
  | { kind: 'skipped' }
  /** Happens twice and nothing has been picked yet. */
  | { kind: 'twice'; earlier: string; later: string };

/** A typed field, read in `zone`. Only `empty` and `ok` may be sent; every other kind is said to the person. */
export function readTypedTime(value: TypedTime, zone: string | null | undefined): TypedTimeReading {
  const dateText = value.date.trim(); const timeText = value.time.trim();
  if (!dateText && !timeText) return { kind: 'empty' };
  if (!dateText || !timeText) return { kind: 'incomplete' };
  const date = readDateText(dateText);
  if (!date) return { kind: 'bad_date' };
  const clock = readClockText(timeText);
  if (!clock) return { kind: 'bad_time' };
  const r = wallTimeToInstant(date, clock, zone);
  switch (r.kind) {
    case 'exact': return { kind: 'ok', iso: r.iso };
    case 'twice': return value.pick ? { kind: 'ok', iso: value.pick === 'earlier' ? r.earlier : r.later } : r;
    case 'skipped': return r;
    case 'bad_zone': return { kind: 'no_zone' };
    default: return { kind: 'bad_date' };
  }
}

/** A served instant as a field's starting value in `zone`; empty when there is none or it cannot be shown in that zone. */
export function typedTimeOf(iso: string | null | undefined, zone: string | null | undefined): TypedTime {
  const local = instantInZone(iso ?? null, zone);
  const clock = local ? readClockText(local.time) : null;
  if (!local || !clock) return EMPTY_TYPED_TIME;
  // A served instant inside a repeated hour reads back as that wall time twice;
  // the pick is the one the server holds, so an untouched field stays itself.
  const again = wallTimeToInstant(local.date, clock, zone);
  const pick = again.kind === 'twice' ? (Date.parse(again.earlier) === Date.parse(iso!) ? 'earlier' : 'later') : null;
  return { date: local.date, time: local.time, pick };
}

/** The words for a field that cannot be sent as typed, or null when it can (empty or a single instant). */
export function typedTimeProblem(r: TypedTimeReading, zone: string | null): string | null {
  switch (r.kind) {
    case 'empty': case 'ok': return null;
    case 'incomplete': return 'Add both a date and a time.';
    case 'bad_date': return 'Enter the date as year-month-day, for example 2026-10-23.';
    case 'bad_time': return 'Enter the time as 24-hour hours:minutes, for example 19:00.';
    case 'no_zone': return "No time zone is known yet, so a time can't be set.";
    case 'skipped': return `That time doesn't happen that day in ${zone ?? 'this time zone'} — the clocks go forward. Choose another time.`;
    case 'twice': return `That time happens twice that day in ${zone ?? 'this time zone'} — the clocks go back. Choose which one.`;
  }
}
