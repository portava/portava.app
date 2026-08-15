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

const logger = rootLogger.child({ lib: "foursquarePlaces" });

const FSQ_SEARCH = "https://places-api.foursquare.com/places/search";
const FSQ_API_VERSION = "2025-06-17";
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

// ── Photo lookup ──────────────────────────────────────────────────────────────
//
// WHY THIS LIVES SERVER-SIDE
// ==========================
// It used to live in the CLIENT: travel-buddy-standalone/src/services/
// fsqPhotoLookup.ts called this same host directly from the browser, with a key
// shipped in the bundle as EXPO_PUBLIC_FOURSQUARE_API_KEY. Two separate
// problems, and the second is the serious one:
//
//   1. places-api.foursquare.com does not serve browser CORS headers, so on web
//      the request could not succeed at all. A live probe of the discovery
//      surface surfaced exactly these blocked calls.
//   2. EXPO_PUBLIC_* is compiled into the client bundle. The key was being
//      handed to every browser that loaded the app. The old module's header
//      called it "already public" — a description of the leak, not a
//      justification for it.
//
// Moving it here fixes both with one change: the request becomes same-origin
// from the client's perspective, and the credential never leaves the server.
//
// It is a SEPARATE function from searchFoursquare rather than an option on it,
// because the two want different `fields` and different failure semantics — a
// photo that cannot be found is normal and returns null, while a venue search
// that fails degrades a search box.

/** Result of a photo lookup. `reason` is populated only when photoUrl is null. */
export interface FoursquarePhotoResult {
  photoUrl: string | null;
  reason?: "no_foursquare_key" | "no_match" | "no_photo" | "auth_failed" | "request_failed";
}

/**
 * Look up the primary Foursquare photo for a venue by name + coordinates.
 *
 * Never throws. Every failure resolves to `{ photoUrl: null, reason }` — the
 * caller's contract is that a missing photo is normal and falls back to
 * category artwork, so an exception here would turn a cosmetic absence into a
 * broken card.
 *
 * ATTRIBUTION: any surface displaying the returned URL must show "Powered by
 * Foursquare". That obligation attaches to DISPLAY, not to fetching, so it does
 * not discharge by having moved the fetch to the server.
 */
export async function lookupFoursquarePhoto(
  name: string,
  lat: number | null,
  lng: number | null,
): Promise<FoursquarePhotoResult> {
  const key = process.env.FOURSQUARE_API_KEY;
  if (!key) {
    if (!keyMissingLogged) {
      keyMissingLogged = true;
      logger.info("FOURSQUARE_API_KEY not set — photo lookup disabled");
    }
    return { photoUrl: null, reason: "no_foursquare_key" };
  }

  const q = name.trim();
  if (!q) return { photoUrl: null, reason: "no_match" };

  const params = new URLSearchParams({ query: q, limit: "1", fields: "photos" });
  if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    params.set("ll", `${lat},${lng}`);
  }

  try {
    const res = await fetch(`${FSQ_SEARCH}?${params}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "X-Places-Api-Version": FSQ_API_VERSION },
      // Longer than the 1500 ms search timeout: a photo lookup is not on a
      // keystroke path, and a timeout here costs a picture rather than a
      // search box that feels broken.
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 401 || res.status === 403) {
      if (!authFailedLogged) {
        authFailedLogged = true;
        logger.warn({ status: res.status }, "Foursquare auth failed — photo lookup disabled (check FOURSQUARE_API_KEY)");
        Sentry.captureMessage("Foursquare auth failure — photo lookup disabled", {
          level: "error",
          extra: { status: res.status, hint: "Check FOURSQUARE_API_KEY is set and valid" },
        });
      }
      return { photoUrl: null, reason: "auth_failed" };
    }
    if (!res.ok) throw new Error(`Foursquare ${res.status}`);

    const body: any = await res.json();
    const first = Array.isArray(body?.results) ? body.results[0] : null;
    if (!first) return { photoUrl: null, reason: "no_match" };

    const photos: any[] = Array.isArray(first.photos) ? first.photos : [];
    const p = photos[0];
    if (typeof p?.prefix === "string" && typeof p?.suffix === "string") {
      return { photoUrl: `${p.prefix}original${p.suffix}` };
    }
    return { photoUrl: null, reason: "no_photo" };
  } catch (err) {
    logger.warn({ err, q }, "Foursquare photo lookup failed — falling back to category artwork");
    return { photoUrl: null, reason: "request_failed" };
  }
}
