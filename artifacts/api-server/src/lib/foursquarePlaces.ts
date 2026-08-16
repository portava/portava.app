/**
 * foursquarePlaces — venue/POI autocomplete provider for the universal
 * location service. Complements Nominatim (cities/regions/addresses) with
 * hotels, landmarks, venues, and airports.
 *
 * Gracefully disabled when FOURSQUARE_API_KEY is not configured or the
 * request fails/times out — search then runs on Nominatim alone.
 */
import { logger as rootLogger } from "./logger";
import { Sentry } from "./sentry.js";
import { getFoursquareApiKey } from "./foursquareApiKey";

const logger = rootLogger.child({ lib: "foursquarePlaces" });

const FSQ_SEARCH = "https://places-api.foursquare.com/places/search";
const FSQ_API_VERSION = "2025-06-17";
const TIMEOUT_MS = 1500;
let keyMissingLogged = false;
let authFailedLogged = false;
let quotaExhaustedLogged = false;

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
  const key = getFoursquareApiKey();
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
    const res = await fetch(`${FSQ_SEARCH}?${params}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "X-Places-Api-Version": FSQ_API_VERSION },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      if (!authFailedLogged) {
        authFailedLogged = true;
        logger.warn({ status: res.status }, "Foursquare auth failed — venue search disabled (check FOURSQUARE_API_KEY)");
        Sentry.captureMessage("Foursquare auth failure — venue search disabled", {
          level: "error",
          extra: { status: res.status, hint: "Check FOURSQUARE_API_KEY is set and valid" },
        });
      }
      return [];
    }
    // See places.ts fsq-photo route for the full rationale: a 429 here means
    // the account has no API credits remaining, not ordinary rate limiting.
    // Named explicitly (once per process) so a dead account reads as a dead
    // account instead of a transient blip that looks identical to "no venues
    // matched" in the UI.
    if (res.status === 429) {
      if (!quotaExhaustedLogged) {
        quotaExhaustedLogged = true;
        logger.warn(
          { status: 429 },
          "Foursquare venue search: account has no API credits remaining — venue search disabled until credits are restored",
        );
        Sentry.captureMessage("Foursquare quota exhausted — venue search disabled", {
          level: "warning",
          extra: { status: 429 },
        });
      }
      return [];
    }
    if (!res.ok) throw new Error(`Foursquare ${res.status}`);
    const body: any = await res.json();
    const results: any[] = Array.isArray(body?.results) ? body.results : [];

    return results
      .filter((r) => r?.fsq_place_id && r?.name)
      .map((r) => {
        const loc = r.location ?? {};
        const city = loc.locality ?? null;
        const country = null; // v3 returns ISO code in location.country; keep name null
        const countryCode = typeof loc.country === "string" ? loc.country.toUpperCase() : null;
        const displayParts = [r.name, city, loc.region].filter(Boolean);
        return {
          id: `foursquare-${r.fsq_place_id}`,
          type: inferType(r.categories),
          name: r.name,
          displayName: displayParts.join(", "),
          country,
          countryCode,
          region: loc.region ?? null,
          city,
          district: loc.neighborhood?.[0] ?? null,
          lat: typeof r.latitude === "number" ? r.latitude : null,
          lng: typeof r.longitude === "number" ? r.longitude : null,
          timezone: null,
          source: "foursquare" as const,
          // License requirement: any surface showing this result must display
          // this attribution (audit: the live-v3 path previously emitted none).
          attribution: "Powered by Foursquare",
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
