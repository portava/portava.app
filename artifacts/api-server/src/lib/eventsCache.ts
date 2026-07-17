/**
 * Events context helper — Ticketmaster Discovery API.
 *
 * Fetches events near a destination during trip dates. Active only when
 * TICKETMASTER_API_KEY is set; skips silently otherwise.
 *
 * Results are cached per destination+date-range with a 12-hour TTL.
 *
 * Privacy: only the destination city name and date range are sent to
 * Ticketmaster. No user identifiers or private data leave this server.
 *
 * Graceful degradation: any error, timeout, or missing key returns null.
 */

const TM_BASE = "https://app.ticketmaster.com/discovery/v2/events.json";
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1_000; // 12 hours

export interface NearbyEvent {
  id: string;
  name: string;
  category: string;   // e.g. "Music", "Sports", "Arts & Theatre", "Family"
  localDate: string;  // YYYY-MM-DD
  venueName: string | null;
  url: string | null;
}

export interface EventsContext {
  destination: string;
  events: NearbyEvent[];
}

interface CacheEntry {
  context: EventsContext;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(destination: string, startDate: string, endDate: string): string {
  return `${destination.toLowerCase()}:${startDate}:${endDate}`;
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function inferCategory(raw: any): string {
  const seg: string = raw?._embedded?.events?.[0]?.classifications?.[0]?.segment?.name ?? "";
  return seg || "Event";
}

function parseEvents(data: any, maxCount: number): NearbyEvent[] {
  const raw: any[] = data?._embedded?.events ?? [];
  return raw.slice(0, maxCount).map((e: any) => {
    const seg: string =
      e.classifications?.[0]?.segment?.name ?? "Event";
    return {
      id: typeof e.id === "string" ? e.id : String(Math.random()),
      name: typeof e.name === "string" ? e.name : "Event",
      category: seg,
      localDate: e.dates?.start?.localDate ?? "",
      venueName: e._embedded?.venues?.[0]?.name ?? null,
      url: typeof e.url === "string" ? e.url : null,
    };
  });
}

export async function getEventsNearDestination(
  destination: string,
  startDate?: string,
  endDate?: string,
  maxCount = 5,
): Promise<EventsContext | null> {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return null; // Integration inactive — skip silently

  // Single clock read for this call — `today` and the cache timestamp both
  // derive from nowMs so they can never disagree (split-clock risk).
  const nowMs = Date.now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const start = startDate ?? today;
  const end = endDate && endDate >= start ? endDate : start;

  const key = cacheKey(destination, start, end);
  const cached = cache.get(key);
  if (cached && isFresh(cached)) return cached.context;

  try {
    // Ticketmaster expects ISO 8601 with Z suffix for date range params
    const startDT = encodeURIComponent(`${start}T00:00:00Z`);
    const endDT   = encodeURIComponent(`${end}T23:59:59Z`);
    const city    = encodeURIComponent(destination);

    const url =
      `${TM_BASE}?apikey=${apiKey}` +
      `&city=${city}` +
      `&startDateTime=${startDT}` +
      `&endDateTime=${endDT}` +
      `&classificationName=music,arts,sports,family` +
      `&sort=date,asc` +
      `&size=${maxCount}`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;

    const data = await res.json() as any;
    const events = parseEvents(data, maxCount);

    const context: EventsContext = { destination, events };
    cache.set(key, { context, cachedAt: nowMs });
    return context;
  } catch {
    return null;
  }
}
