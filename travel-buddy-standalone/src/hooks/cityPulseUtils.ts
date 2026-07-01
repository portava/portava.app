/**
 * cityPulseUtils.ts
 *
 * Pure, side-effect-free utilities extracted from useCityPulse so they can be
 * unit-tested without pulling in React, Expo, or Supabase.
 *
 * Exported by useCityPulse.ts for convenience — import directly from here in
 * tests.
 */
import type { CityEvent, Interest } from '../types/models';

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
  const startAt = (e.start_time as string) ?? '';
  return {
    id:            e.id as string,
    kind:          (e.kind as CityEvent['kind']) ?? 'event',
    title:         e.title as string,
    city:          (e.city as string) ?? city,
    citySlug:      (e.city_slug as string) ?? currentCitySlug,
    startAt,
    block:         blockOf(startAt),
    category:      (e.category as Interest) ?? 'social',
    attendeeCount: (e.attendee_count as number) ?? 0,
    capacity:      (e.max_capacity as number) ?? undefined,
    score:         null,
  };
}

/**
 * Fetch live events from /api/events and return them as CityEvent[].
 * Throws on any non-ok HTTP status so callers can fall back gracefully.
 *
 * @param base - API base URL (e.g. https://xyz.replit.dev)
 * @param token - JWT bearer token for the Authorization header
 * @param city - human-readable city name for the `city` query param
 * @param currentCitySlug - slug used as the citySlug fallback in mapped events
 */
export async function fetchCityEvents(
  base: string,
  token: string,
  city: string,
  currentCitySlug: string,
): Promise<CityEvent[]> {
  const params = new URLSearchParams({ city, state: 'open', limit: '20' });
  const r = await fetch(`${base}/api/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { events?: unknown[] };
  return (data?.events ?? []).map((e) =>
    mapApiEvent(e as Record<string, unknown>, city, currentCitySlug),
  );
}
