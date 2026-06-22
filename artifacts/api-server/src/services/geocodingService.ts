/**
 * geocodingService — server-side reverse geocoding via OpenStreetMap Nominatim.
 *
 * Nominatim policy: max 1 request/second, User-Agent required.
 * We enforce a 1.1-second gap between calls with a simple in-process mutex.
 * Falls back gracefully — never throws, never crashes the app.
 *
 * Provider priority:
 *   1. Mapbox if MAPBOX_TOKEN env var is set
 *   2. Nominatim (OSM) — free, no key, rate-limited
 *   3. Null fallback (coordinates saved, city name unavailable)
 */

export interface PlaceResult {
  city: string | null;
  district: string | null;
  country: string | null;
  countryCode: string | null;
  formatted: string | null;
}

const NULL_RESULT: PlaceResult = {
  city: null,
  district: null,
  country: null,
  countryCode: null,
  formatted: null,
};

// ── Rate-limit mutex (Nominatim: 1 req/sec) ─────────────────────────────────
let lastNominatimAt = 0;
const NOMINATIM_MIN_MS = 1100;

async function nominatimThrottle(): Promise<void> {
  const wait = NOMINATIM_MIN_MS - (Date.now() - lastNominatimAt);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  lastNominatimAt = Date.now();
}

// ── Mapbox ───────────────────────────────────────────────────────────────────
async function reverseGeocodeMapbox(lat: number, lng: number): Promise<PlaceResult> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("no_token");
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?types=neighborhood,locality,place,district,region&access_token=${token}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`mapbox_${res.status}`);
  const data: any = await res.json();
  const features: any[] = data.features ?? [];
  const get = (type: string) =>
    features.find((f) => (f.place_type as string[]).includes(type))?.text ?? null;
  const city = get("locality") ?? get("place") ?? null;
  const district = get("neighborhood") ?? null;
  const country = get("country") ?? null;
  const cc = features
    .find((f) => (f.place_type as string[]).includes("country"))
    ?.properties?.short_code?.toUpperCase() ?? null;
  const formatted = features[0]?.place_name?.split(",").slice(0, 3).join(",").trim() ?? null;
  return { city, district, country, countryCode: cc, formatted };
}

// ── Nominatim ────────────────────────────────────────────────────────────────
async function reverseGeocodeNominatim(lat: number, lng: number): Promise<PlaceResult> {
  await nominatimThrottle();
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14&addressdetails=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "TravelBuddyApp/1.0 (contact via app)" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return NULL_RESULT;
  const data: any = await res.json();
  const addr = data.address ?? {};
  const city =
    addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.county ?? null;
  const district = addr.suburb ?? addr.neighbourhood ?? addr.quarter ?? null;
  const country = addr.country ?? null;
  const countryCode = (addr.country_code as string | undefined)?.toUpperCase() ?? null;
  const formatted =
    (data.display_name as string | undefined)?.split(",").slice(0, 3).join(",").trim() ?? null;
  return { city, district, country, countryCode, formatted };
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function reverseGeocode(lat: number, lng: number): Promise<PlaceResult> {
  if (process.env.MAPBOX_TOKEN) {
    try {
      return await reverseGeocodeMapbox(lat, lng);
    } catch {
      // fall through to Nominatim
    }
  }
  try {
    return await reverseGeocodeNominatim(lat, lng);
  } catch {
    return NULL_RESULT;
  }
}
