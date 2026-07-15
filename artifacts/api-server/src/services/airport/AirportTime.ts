/**
 * AirportTime
 *
 * Timezone helpers for the layover system. All conversions run server-side
 * (Node has full ICU); clients send airport-local wall times and receive both
 * UTC instants and pre-formatted local strings.
 */

/** Offset (minutes) of `tz` from UTC at the given instant. Falls back to 0 (UTC). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    let hour = get("hour");
    if (hour === 24) hour = 0; // some ICU versions emit 24:00
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Convert an airport-local wall time ("YYYY-MM-DDTHH:mm" or with seconds) to a
 * UTC instant. Two-pass offset correction handles DST boundaries. Returns null
 * on malformed input.
 */
export function wallTimeToUtc(tz: string, wall: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(wall).trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  let offset = tzOffsetMinutes(tz, new Date(utcGuess));
  let ts = utcGuess - offset * 60000;
  offset = tzOffsetMinutes(tz, new Date(ts));
  ts = utcGuess - offset * 60000;
  const out = new Date(ts);
  return Number.isFinite(out.getTime()) ? out : null;
}

/** Local hour-of-day (0–23) at the airport for a UTC instant. */
export function localHour(tz: string, at: Date): number {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(at);
    const h = Number(s);
    return h === 24 ? 0 : h;
  } catch {
    return at.getUTCHours();
  }
}

/** Local calendar day ("YYYY-MM-DD") at the airport for a UTC instant. */
export function localDayString(tz: string, at: Date): string {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return dtf.format(at); // en-CA yields YYYY-MM-DD
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Pre-formatted local time ("14:30") at the airport for a UTC instant. */
export function formatLocalTime(tz: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

/** Validate that a timezone identifier is usable. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
