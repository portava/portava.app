/**
 * Canonical, server-authoritative trip status.
 *
 * The single source of truth for deriving a trip's lifecycle status from its
 * fields. Extracted so routes/trips.ts and routes/trips-expansion.ts compute it
 * IDENTICALLY — they previously had two copies that diverged: trips.ts evaluated
 * day boundaries in the trip's IANA timezone (correct), while the trips-expansion
 * copy used UTC midnight, so the same trip could read 'upcoming' on one endpoint
 * and 'active' on the other around the day boundary. Never let clients override
 * this.
 */

const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * "Today" as a YYYY-MM-DD string in the given IANA timezone (UTC fallback).
 *
 * `now` is a parameter and not a hidden `new Date()` because a function whose
 * answer depends on the wall clock cannot be tested at the boundary that
 * matters — the few hours a day when the trip's zone and UTC disagree about
 * which day it is. Callers that do not pass it get the clock, exactly as
 * before, so every existing call site is byte-identical in behaviour.
 */
export function todayInTimezone(timezone: string | null | undefined, now: Date = new Date()): string {
  if (!timezone || timezone === "UTC") return now.toISOString().slice(0, 10);
  try {
    let formatter = calendarFormatters.get(timezone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
      if (calendarFormatters.size >= 64) calendarFormatters.clear();
      calendarFormatters.set(timezone, formatter);
    }
    const parts = formatter.formatToParts(now);
    const part = (key: string) => parts.find(p => p.type === key)?.value;
    return [part("year"), part("month"), part("day")].join("-");
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Evaluate the stored civil dates on reads as well as writes. Terminal states
 * are explicit; a missing end leaves the trip open through its unknown end. */
export function tripStatusAtRead(row: { status?: string | null; start_date?: string | null; end_date?: string | null; timezone?: string | null }, now = new Date()): string {
  const status = row.status ?? "planning";
  if (["cancelled", "archived", "completed", "draft"].includes(status)) return status;
  const today = todayInTimezone(row.timezone, now);
  if (row.end_date && today > row.end_date) return "completed";
  if (row.start_date) return today < row.start_date ? "upcoming" : "active";
  return status;
}

export function tripHasEnded(row: Parameters<typeof tripStatusAtRead>[0], now = new Date()): boolean {
  return ["completed", "cancelled", "archived"].includes(row.status ?? "")
    || Boolean(row.end_date && todayInTimezone(row.timezone, now) > row.end_date);
}

/** Exact expiry instant for consumers that hold a dated result across midnight.
 * Searching local dates handles short/long DST days without assuming 24 hours. */
export function tripExpiryInstant(endDate?: string | null, timezone?: string | null): string | null {
  if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;
  const midnight = Date.parse(endDate + "T00:00:00Z");
  if (!Number.isFinite(midnight)) return null;
  if (!timezone || timezone === "UTC") return new Date(midnight + 86_400_000).toISOString();
  let lo = midnight - 86_400_000;
  let hi = midnight + 2 * 86_400_000;
  while (hi - lo > 1) {
    const mid = Math.floor((hi + lo) / 2);
    if (todayInTimezone(timezone, new Date(mid)) > endDate) hi = mid; else lo = mid;
  }
  return new Date(hi).toISOString();
}

/**
 * Compute canonical status from trip fields. Terminal states (cancelled/archived)
 * are never overwritten; missing title/city ⇒ draft; date boundaries are compared
 * in the trip's timezone against YYYY-MM-DD strings.
 *
 * `now` defaults to the real clock, which is what the write paths in routes/
 * want: they are deciding the status of a trip AT THE MOMENT OF THE WRITE.
 *
 * It is a PARAMETER because a reader that has been handed a clock must not
 * quietly consult a different one. `todayInTimezone` already took a `now` and
 * this function did not thread it through, so TripHealthProjection — which
 * receives `now` as an option and uses it for every other derivation — got its
 * `tripStatus` from `new Date()` instead. The projection then reported a phase
 * computed at the injected instant beside a status computed at the real one,
 * and the two could disagree. It surfaced as a test that passed all day and
 * failed at 22:09 UTC, when the trip's Europe/Paris date rolled past its
 * end_date while the injected `now` sat two days earlier.
 */
export function computeTripStatus(
  title: string | null,
  destinationCity: string | null,
  startDate: string | null,
  endDate: string | null,
  currentStatus: string,
  timezone?: string | null,
  /**
   * The clock to answer about. Additive, and defaulted to the wall clock, so
   * every call site that does not pass one is byte-identical in behaviour.
   *
   * IT EXISTS BECAUSE ONE PROJECTION WAS ANSWERING FROM TWO CLOCKS.
   * `buildTripHealthProjection` takes a `now` and threads it into
   * `liveEnvelope`, `buildTripFreedomProjection`, `operationalState` and the
   * phase inputs — into every clock read but this one, because this function
   * had nowhere to put it. So the field that says whether a trip is OVER was
   * the single field in that projection derived from the real date, and
   * `tripHealthProjection.test.ts` went red in 17 places at once at midnight
   * Europe/Paris on 2026-09-15 when the wall clock passed its fixture's
   * `end_date`. The `now` it had pinned was never consulted.
   *
   * `todayInTimezone` above already carries the argument for this parameter,
   * in its own words: a function whose answer depends on the wall clock cannot
   * be tested at the boundary that matters. It got the parameter; the function
   * that calls it did not, which is why the gap survived.
   */
  now: Date = new Date(),
): string {
  if (currentStatus === "cancelled" || currentStatus === "archived") return currentStatus;
  if (!title || !destinationCity) return "draft";
  const today = todayInTimezone(timezone, now);
  if (startDate) {
    const start = startDate.slice(0, 10);
    const end   = endDate ? endDate.slice(0, 10) : null;
    if (today < start)        return "upcoming";
    if (!end || today <= end) return "active";
    return "completed";
  }
  return "planning";
}
