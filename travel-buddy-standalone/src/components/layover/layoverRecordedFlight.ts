/**
 * layoverRecordedFlight — the words for the traveller's onward flight as Trips
 * last RECORDED it (census-layover L153 offline, L43 after re-entry). Pure, so
 * the copy is tested without rendering, and shared by the offline plan card and
 * the re-entry card so the two cannot word the same record differently.
 *
 * Every value printed is the server's. A value nobody recorded is said as "not
 * recorded", never left blank (blank reads as "none") and never filled from the
 * schedule. Who recorded it and when is always said, and an observation past
 * the server's `staleAfter` (the bundle TTL from the OBSERVATION instant) is
 * said to be old: gates and times change, and the departure board wins.
 */
import { fmtClock } from './layoverFormat.ts';

export interface RecordedFlightValues {
  designator: string | null;
  gate: string | null;
  terminal: string | null;
  status: string;
  estimatedDepartureAt: string | null;
  scheduledDepartureAt: string | null;
  source: string;
  observedAt: string;
}

const STATUS_WORDS: Record<string, string> = {
  unknown: 'status not reported',
  scheduled: 'reported on schedule',
  delayed: 'delayed',
  boarding: 'boarding',
  departed: 'departed',
  landed: 'landed',
  cancelled: 'cancelled',
  diverted: 'diverted',
};

const SOURCE_WORDS: Record<string, string> = { traveller: 'you', feed: 'the flight-status feed' };

function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export interface RecordedFlightCopy {
  lines: string[];
  /** True once `nowMs` is at or past `staleAfter`, or when either instant is unreadable (unknown age is not fresh). */
  stale: boolean;
  staleLine: string | null;
}

export function describeRecordedFlight(
  f: RecordedFlightValues,
  opts: { timezone: string | null; nowMs: number; staleAfter: string | null },
): RecordedFlightCopy {
  const name = f.designator ?? 'Your flight';
  const status = own(STATUS_WORDS, f.status) ?? f.status;
  const departs = f.estimatedDepartureAt
    ? ` — departs ${fmtClock(f.estimatedDepartureAt, opts.timezone)}`
    : f.scheduledDepartureAt
      ? ` — scheduled ${fmtClock(f.scheduledDepartureAt, opts.timezone)}`
      : '';
  const by = own(SOURCE_WORDS, f.source) ?? f.source;
  const lines = [
    `${name}: gate ${f.gate ?? 'not recorded'}, terminal ${f.terminal ?? 'not recorded'}.`,
    `Status: ${status}${departs}.`,
    `Recorded by ${by} at ${fmtClock(f.observedAt, opts.timezone)}.`,
  ];
  const observedMs = Date.parse(f.observedAt);
  const staleMs = opts.staleAfter === null ? NaN : Date.parse(opts.staleAfter);
  const stale = !Number.isFinite(observedMs) || !Number.isFinite(staleMs) || opts.nowMs >= staleMs;
  const age = Number.isFinite(observedMs) ? Math.max(0, Math.round((opts.nowMs - observedMs) / 60_000)) : null;
  const staleLine = stale
    ? `${age === null ? 'Recorded at an unknown time' : `Recorded ${age} min ago`} — gates and times change; check the departure board.`
    : null;
  return { lines, stale, staleLine };
}

/** The server's reasons there is no recorded flight, in a traveller's words. Unknown reasons are said as themselves. */
const NO_FLIGHT_WORDS: Record<string, string | null> = {
  no_flight_feed: null, // the feature is off: say nothing, as before
  not_linked_to_a_trip_flight: 'This layover is not linked to a flight on your trip, so no gate is saved.',
  no_flight_observation: 'No update has been recorded for your flight, so no gate or status is saved. Check the departure board.',
  flight_unreadable: 'Your flight could not be read when this was saved. Check the departure board.',
};

/** `null` = nothing to say (the feature is off). */
export function noRecordedFlightSentence(reason: string | null): string | null {
  if (reason === null) return null;
  const w = own(NO_FLIGHT_WORDS, reason);
  return w === undefined ? `No flight details saved (${reason}).` : w;
}
