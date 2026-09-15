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
