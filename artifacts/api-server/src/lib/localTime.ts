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

/* ── Per-user timezone memoization ───────────────────────────────────────────
 * Feed/section routes resolve the local hour before the cache lookup (for the
 * cache key), and other surfaces (/compass/me/context, Compass Home) resolve
 * independently — so a single hot path could hit notification_preferences
 * several times per request for "auto" travelers. A stored timezone changes
 * rarely, so a short per-user TTL cache cuts those redundant reads without
 * affecting resolution priority (offset → stored timezone → UTC).
 */
const TZ_CACHE_TTL_MS = 60_000;
const tzCache = new Map<string, { value: string | null; expiresAt: number }>();

/** Drop all memoized timezones (tests; call after mutating notification_preferences). */
export function clearUserTimezoneCache(userId?: string): void {
  if (userId !== undefined) tzCache.delete(userId);
  else tzCache.clear();
}

/**
 * The traveler's stored IANA timezone (notification_preferences.timezone).
 * Memoized per user for a short TTL — errors are NOT cached, so a transient
 * DB failure doesn't pin the traveler to UTC for the TTL window.
 */
export async function fetchUserTimezone(sc: any, userId: string): Promise<string | null> {
  const hit = tzCache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const { data, error } = await sc
      .from("notification_preferences")
      .select("timezone")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return null; // do not cache failures
    const value = ((data as any)?.timezone as string | null) ?? null;
    tzCache.set(userId, { value, expiresAt: Date.now() + TZ_CACHE_TTL_MS });
    return value;
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
