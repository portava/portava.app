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
  const opts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    // en-CA formats as YYYY-MM-DD, directly comparable to date-column strings.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone ?? "UTC", ...opts }).format(now);
  } catch {
    // Invalid/unknown timezone string — fall back to UTC.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...opts }).format(now);
  }
}

/**
 * Compute canonical status from trip fields. Terminal states (cancelled/archived)
 * are never overwritten; missing title/city ⇒ draft; date boundaries are compared
 * in the trip's timezone against YYYY-MM-DD strings.
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
  now?: Date,
): string {
  if (currentStatus === "cancelled" || currentStatus === "archived") return currentStatus;
  if (!title || !destinationCity) return "draft";
  const today = todayInTimezone(timezone, now ?? new Date());
  if (startDate) {
    const start = startDate.slice(0, 10);
    const end   = endDate ? endDate.slice(0, 10) : null;
    if (today < start)        return "upcoming";
    if (!end || today <= end) return "active";
    return "completed";
  }
  return "planning";
}
