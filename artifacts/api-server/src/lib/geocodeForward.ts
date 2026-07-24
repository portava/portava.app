/**
 * geocodeForward — server-side forward geocoding (query string → coordinates)
 * for the Compass→map command channel. Doing this on the server (instead of the
 * old client Nominatim "geocode-and-fly") means the map receives authoritative
 * coordinates and we control caching + attribution + rate discipline.
 *
 * Keyless Nominatim by default (same provider the app already uses), wrapped
 * fail-soft: any error → null (the command layer then declines to move the map
 * rather than guessing). Injectable for tests via _setForwardGeocoder.
 */
import type { GeocodeHit } from "./mapCommands.js";

export type ForwardGeocoder = (query: string) => Promise<GeocodeHit | null>;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — place coordinates barely move
const cache = new Map<string, { at: number; hit: GeocodeHit | null }>();

/** Nominatim usage policy asks for an identifying UA + ≤1 req/s; we cache hard. */
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "Portava/1.0 (map compass geocode)";

async function nominatimForwardGeocode(query: string): Promise<GeocodeHit | null> {
  try {
    const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as any[];
    const top = Array.isArray(body) ? body[0] : null;
    if (!top) return null;
    const lat = Number(top.lat), lng = Number(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, label: String(top.display_name ?? query).split(",")[0].trim() || query };
  } catch {
    return null;
  }
}

let _impl: ForwardGeocoder = nominatimForwardGeocode;

/** Test hook — swap the underlying geocoder. */
export function _setForwardGeocoder(fn: ForwardGeocoder | null): void {
  _impl = fn ?? nominatimForwardGeocode;
}

/** Cached, fail-soft forward geocode. Never throws. */
export async function forwardGeocode(query: string): Promise<GeocodeHit | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.hit;
  const result = await _impl(key).catch(() => null);
  cache.set(key, { at: Date.now(), hit: result });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return result;
}

/** Test hook — clear the geocode cache. */
export function _clearGeocodeCache(): void {
  cache.clear();
}
