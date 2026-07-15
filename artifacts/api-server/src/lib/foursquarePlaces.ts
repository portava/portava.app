/**
 * foursquarePlaces — venue/POI autocomplete provider for the universal
 * location service. Complements Nominatim (cities/regions/addresses) with
 * hotels, landmarks, venues, and airports.
 *
 * Gracefully disabled when FOURSQUARE_API_KEY is not configured or the
 * request fails/times out — search then runs on Nominatim alone.
 */
import { logger as rootLogger } from "./logger";

const logger = rootLogger.child({ lib: "foursquarePlaces" });

const TIMEOUT_MS = 1500;
let keyMissingLogged = false;
let authFailedLogged = false;

function inferType(categories: Array<{ name?: string }> | undefined): string {
  const names = (categories ?? []).map((c) => c.name ?? "").join(" ").toLowerCase();
  if (/airport/.test(names)) return "airport";
  if (/hotel|hostel|resort|lodging|bed and breakfast/.test(names)) return "place";
  return "landmark";
}

export interface FoursquareOptions {
  lat?: number;
  lng?: number;
  limit?: number;
}

/** Search Foursquare Places; returns [] on any failure. Result shape = Place. */
export async function searchFoursquare(q: string, opts: FoursquareOptions = {}): Promise<any[]> {
  const key = process.env.FOURSQUARE_API_KEY;
  if (!key) {
    if (!keyMissingLogged) {
      keyMissingLogged = true;
      logger.info("FOURSQUARE_API_KEY not set — venue search disabled");
    }
    return [];
  }

  const params = new URLSearchParams({
    query: q,
    limit: String(opts.limit ?? 6),
  });
  if (opts.lat != null && opts.lng != null) {
    params.set("ll", `${opts.lat},${opts.lng}`);
  }

  try {
    const res = await fetch(`https://api.foursquare.com/v3/places/search?${params}`, {
      headers: { Authorization: key, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      if (!authFailedLogged) {
        authFailedLogged = true;
        logger.warn({ status: res.status }, "Foursquare auth failed — venue search disabled (check FOURSQUARE_API_KEY)");
      }
      return [];
    }
    if (!res.ok) throw new Error(`Foursquare ${res.status}`);
    const body: any = await res.json();
    const results: any[] = Array.isArray(body?.results) ? body.results : [];

    return results
      .filter((r) => r?.fsq_id && r?.name)
      .map((r) => {
        const loc = r.location ?? {};
        const geo = r.geocodes?.main ?? {};
        const city = loc.locality ?? null;
        const country = null; // v3 returns ISO code in location.country; keep name null
        const countryCode = typeof loc.country === "string" ? loc.country.toUpperCase() : null;
        const displayParts = [r.name, city, loc.region].filter(Boolean);
        return {
          id: `foursquare-${r.fsq_id}`,
          type: inferType(r.categories),
          name: r.name,
          displayName: displayParts.join(", "),
          country,
          countryCode,
          region: loc.region ?? null,
          city,
          district: loc.neighborhood?.[0] ?? null,
          lat: typeof geo.latitude === "number" ? geo.latitude : null,
          lng: typeof geo.longitude === "number" ? geo.longitude : null,
          timezone: null,
          source: "foursquare" as const,
          address: loc.address ?? null,
          postalCode: loc.postcode ?? null,
          formattedAddress: loc.formatted_address ?? null,
        };
      });
  } catch (err) {
    logger.warn({ err, q }, "Foursquare search failed — continuing without venues");
    return [];
  }
}
