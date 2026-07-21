/**
 * Local-time resolution shared by all time-aware Compass surfaces.
 *
 * The time-of-day bucket must follow the traveler's clock, not the server's.
 * Priority:
 *   1. Explicit client-supplied UTC offset (?tzOffsetMinutes=480 for UTC+8)
 *   2. The traveler's IANA timezone (notification_preferences.timezone)
 *   3. UTC — only when neither is known.
 *
 * Originally lived in routes/compassHome.ts; extracted so the feed routes and
 * the context engine resolve the same local hour as Compass Home.
 */

export const MAX_TZ_OFFSET_MINUTES = 14 * 60;

/* ── Test hook ───────────────────────────────────────────────────────────────
 * Time-aware payloads differ by hour. Tests inject a fixed UTC instant so both
 * shapes are exercised deterministically.
 */
let _testNowUtc: Date | null = null;
export function _setTestNowUtc(now: Date | null): void {
  _testNowUtc = now;
}

/** Current UTC instant (test-injectable). */
export function nowUtcInstant(): Date {
  return _testNowUtc !== null ? new Date(_testNowUtc.getTime()) : new Date();
}

export function localHourFor(
  nowUtc: Date,
  tzOffsetMinutes: number | null,
  timezone: string | null,
): number {
  if (
    tzOffsetMinutes !== null &&
    Number.isFinite(tzOffsetMinutes) &&
    Math.abs(tzOffsetMinutes) <= MAX_TZ_OFFSET_MINUTES
  ) {
    const utcMinutes = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
    const localMinutes = (((utcMinutes + Math.trunc(tzOffsetMinutes)) % 1440) + 1440) % 1440;
    return Math.floor(localMinutes / 60);
  }
  if (timezone) {
    try {
      const part = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(nowUtc)
        .find((p) => p.type === "hour");
      const h = Number(part?.value);
      if (Number.isFinite(h)) return h;
    } catch {
      // Invalid timezone name — fall through to UTC.
    }
  }
  return nowUtc.getUTCHours();
}

/** Parse a raw ?tzOffsetMinutes query/body value. Accepts strings or numbers. */
export function parseTzOffsetParam(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || Math.abs(raw) > MAX_TZ_OFFSET_MINUTES) return null;
    return Math.trunc(raw);
  }
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_TZ_OFFSET_MINUTES) return null;
  return Math.trunc(n);
}

/** The traveler's stored IANA timezone (notification_preferences.timezone). */
export async function fetchUserTimezone(sc: any, userId: string): Promise<string | null> {
  try {
    const { data } = await sc
      .from("notification_preferences")
      .select("timezone")
      .eq("user_id", userId)
      .maybeSingle();
    return ((data as any)?.timezone as string | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the traveler's local hour for a request: client offset first, then
 * stored timezone, then UTC. One-stop helper for time-aware routes.
 */
export async function resolveLocalHour(
  sc: any,
  userId: string,
  tzOffsetMinutes: number | null,
  nowUtc: Date = nowUtcInstant(),
): Promise<number> {
  const timezone =
    tzOffsetMinutes !== null ? null : await fetchUserTimezone(sc, userId);
  return localHourFor(nowUtc, tzOffsetMinutes, timezone);
}
