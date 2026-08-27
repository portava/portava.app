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

/** "Today" as a YYYY-MM-DD string in the given IANA timezone (UTC fallback). */
export function todayInTimezone(timezone: string | null | undefined): string {
  const opts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    // en-CA formats as YYYY-MM-DD, directly comparable to date-column strings.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone ?? "UTC", ...opts }).format(new Date());
  } catch {
    // Invalid/unknown timezone string — fall back to UTC.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...opts }).format(new Date());
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
): string {
  if (currentStatus === "cancelled" || currentStatus === "archived") return currentStatus;
  if (!title || !destinationCity) return "draft";
  const today = todayInTimezone(timezone);
  if (startDate) {
    const start = startDate.slice(0, 10);
    const end   = endDate ? endDate.slice(0, 10) : null;
    if (today < start)        return "upcoming";
    if (!end || today <= end) return "active";
    return "completed";
  }
  return "planning";
}
