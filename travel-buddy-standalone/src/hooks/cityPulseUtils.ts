/**
 * cityPulseUtils.ts
 *
 * Pure, side-effect-free utilities extracted from useCityPulse so they can be
 * unit-tested without pulling in React, Expo, or Supabase.
 *
 * Exported by useCityPulse.ts for convenience — import directly from here in
 * tests.
 */
import type { CityEvent, Interest } from '../types/models.ts';

/** Local copy — avoids a relative import that fails in the tsx CJS resolution path. */
function blockOf(iso: string): CityEvent['block'] {
  const h = new Date(iso).getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 22) return 'evening';
  return 'late';
}

/**
 * Map a raw /api/events response item to the canonical CityEvent shape.
 * Handles field-name translation (e.g. `start_time` → `startAt`, `attendee_count`
 * → `attendeeCount`) and fills in defaults for optional fields.
 */
export function mapApiEvent(
  e: Record<string, unknown>,
  city: string,
  currentCitySlug: string,
): CityEvent {
  // formatEvent() returns camelCase field names (startsAt, goingCount,
  // maxAttendees). Accept either the camelCase form the API currently sends or
  // the legacy snake_case names so the mapper stays forward- and back-compatible.
  const startAt =
    (e.startsAt as string) ??
    (e.start_time as string) ??
    (e.starts_at as string) ??
    '';
  return {
    id:            e.id as string,
    kind:          (e.kind as CityEvent['kind']) ?? 'event',
    title:         e.title as string,
    city:          (e.city as string) ?? city,
    citySlug:      (e.city_slug as string) ?? (e.citySlug as string) ?? currentCitySlug,
    startAt,
    block:         blockOf(startAt),
    category:      (e.category as Interest) ?? 'social',
    attendeeCount: (e.goingCount as number) ?? (e.attendee_count as number) ?? 0,
    capacity:      (e.maxAttendees as number) ?? (e.max_capacity as number) ?? undefined,
    score:         null,
  };
}

/**
 * Decide which events to display after a successful API fetch.
 *
 * Returns `fetched` when the API returned at least one event (live data).
 * Returns an empty array when the API returned nothing — this is a valid
 * "no events right now" state, NOT a signal to show mock data.
 *
 * This is the hook's primary dispatch branch so it can be tested without React.
 */
export function resolveEventsOnSuccess(fetched: CityEvent[]): CityEvent[] {
  return fetched.length > 0 ? fetched : [];
}

/**
 * Decide which events to display when the API fetch threw or returned a
 * non-ok status.
 *
 * In dev (`isDev = true`) we show `fallback` (mock data) so the screen isn't
 * blank while developing. In production we show an empty list — the empty
 * state UI is shown instead of mock data, which would be misleading to users.
 */
export function resolveEventsOnError(isDev: boolean, fallback: CityEvent[]): CityEvent[] {
  return isDev ? fallback : [];
}

/**
 * Convert a CityEvent startAt value to a numeric millisecond timestamp for
 * sorting, handling all edge cases that break the native comparator:
 *
 *   • empty string ('')      → new Date('').getTime() = NaN  ← the root-cause bug
 *   • null / undefined       → NaN
 *   • any other invalid ISO  → NaN
 *
 * NaN returned from a comparator is coerced to 0 by V8's sort, meaning the
 * affected item appears "equal" to every other item and can land anywhere in
 * the output — producing the observed out-of-order list (11 AM before 10:24 AM,
 * 6 PM stranded after 11:34 PM, etc.).
 *
 * We replace NaN with Infinity so events without a known start time sort
 * consistently to the END of the list rather than silently breaking the order
 * of events around them.
 */
function safeStartMs(startAt: string | null | undefined): number {
  if (!startAt) return Infinity;
  const ms = new Date(startAt).getTime();
  return isNaN(ms) ? Infinity : ms;
}
/**
 * Result shape returned by fetchCityEvents.
 * `sessionId` is the UUID the server stamped on the impression batch — pass it
 * through to any recordOutcome() call so the learning loop can join impressions
 * to outcomes.
 */
export interface FetchCityEventsResult {
  events: CityEvent[];
  sessionId: string | undefined;
}

/**
 * Fetch live events from /api/events and return the mapped events together
 * with the session ID that the server attached to this impression batch.
 * Throws on any non-ok HTTP status so callers can fall back gracefully.
 *
 * @param base - API base URL (e.g. https://xyz.replit.dev)
 * @param token - JWT bearer token for the Authorization header
 * @param city - human-readable city name for the `city` query param
 * @param currentCitySlug - slug used as the citySlug fallback in mapped events
 */
/**
 * Local-day [start, end) bounds for "today", as ISO strings, so the server's
 * dateFrom/dateTo filter matches what the device considers "today" rather
 * than the server's own timezone.
 */
export function todayBoundsIso(now = new Date()): { dateFrom: string; dateTo: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
}

export async function fetchCityEvents(
  base: string,
  token: string,
  city: string,
  currentCitySlug: string,
): Promise<FetchCityEventsResult> {
  // Scope to today's events only. Without this, the API returns the next N
  // upcoming events across ANY future date; since the UI (e.g. the "Full Day"
  // chronological list) only displays a time-of-day like "10:24 AM" with no
  // date, a tomorrow-morning event sorts correctly by absolute time but
  // LOOKS out of order next to today's later events.
  const { dateFrom, dateTo } = todayBoundsIso();
  const params = new URLSearchParams({ city, state: 'open', limit: '20', dateFrom, dateTo });
  const r = await fetch(`${base}/api/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { events?: unknown[]; sessionId?: string };
  const events = (data?.events ?? []).map((e) =>
    mapApiEvent(e as Record<string, unknown>, city, currentCitySlug),
  );
  return { events, sessionId: data?.sessionId };
}

/**
 * Sort a CityEvent array by ascending start time.
 *
 * Safe against missing, empty, or invalid `startAt` values — events without a
 * parseable start time are placed at the END of the list instead of corrupting
 * the position of adjacent valid events.
 *
 * Use this instead of an inline `.sort()` comparator wherever CityEvents need
 * chronological ordering (Full Day list, Happening Now, Today Around You band).
 */
export function sortEventsByStartTime(events: CityEvent[]): CityEvent[] {
  return [...events].sort((a, b) => safeStartMs(a.startAt) - safeStartMs(b.startAt));
}
