/**
 * Canonical location key utility.
 *
 * Produces a deterministic, lowercase-slug key for a location that is stable
 * across spelling variants, capitalisation differences, and input sources.
 *
 * Key format:
 *   city stamps:         "city:{country_code}:{normalized-city}"
 *   country stamps:      "country:{country_code}"
 *   region stamps:       "region:{country_code}:{normalized-region}"
 *   neighborhood stamps: "neighborhood:{country_code}:{normalized-city}:{normalized-neighborhood}"
 *   landmark stamps:     "landmark:{country_code}:{normalized-city}:{normalized-name}"
 *   hidden_gem stamps:   "hidden_gem:{country_code}:{normalized-city}:{normalized-name}"
 *   special_event stamps:"special_event:{normalized-name}"
 *
 * Normalisation: lowercase → strip accents → replace spaces/underscores with hyphens
 * → strip punctuation except hyphens → collapse multiple hyphens → trim.
 */

export interface LocationKeyInput {
  stampType: string;
  countryCode?: string | null;
  country?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  region?: string | null;
  displayName?: string | null;
}

/**
 * Normalise a location segment: lowercase, strip accents, replace non-alphanumeric
 * with hyphens, collapse runs, trim.
 */
export function normalizeSegment(raw: string): string {
  return raw
    .toLowerCase()
    // Decompose accented characters (é → e + combining accent)
    .normalize("NFD")
    // Remove combining diacritics (the accent part)
    .replace(/[\u0300-\u036f]/g, "")
    // Replace spaces, underscores, slashes with hyphens
    .replace(/[\s_/]+/g, "-")
    // Remove anything that isn't alphanumeric or hyphen
    .replace(/[^a-z0-9-]/g, "")
    // Collapse consecutive hyphens
    .replace(/-{2,}/g, "-")
    // Trim leading/trailing hyphens
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve the best 2-char country code from input.
 * Accepts ISO 3166-1 alpha-2 codes directly. Falls back to first 2 chars of
 * country name (uppercased) when no explicit code is provided.
 */
function resolveCountryCode(input: LocationKeyInput): string {
  if (input.countryCode && input.countryCode.length === 2) {
    return input.countryCode.toUpperCase();
  }
  if (input.country) {
    // Common country name → code mappings for the most-visited destinations
    const NAME_MAP: Record<string, string> = {
      "philippines":    "PH",
      "united states":  "US",
      "usa":            "US",
      "united kingdom": "GB",
      "uk":             "GB",
      "japan":          "JP",
      "australia":      "AU",
      "france":         "FR",
      "germany":        "DE",
      "thailand":       "TH",
      "indonesia":      "ID",
      "singapore":      "SG",
      "malaysia":       "MY",
      "vietnam":        "VN",
      "south korea":    "KR",
      "korea":          "KR",
      "spain":          "ES",
      "italy":          "IT",
      "canada":         "CA",
      "mexico":         "MX",
      "brazil":         "BR",
      "india":          "IN",
      "china":          "CN",
      "new zealand":    "NZ",
    };
    const normalized = input.country.toLowerCase().trim();
    if (NAME_MAP[normalized]) return NAME_MAP[normalized];
    // Fallback: first 2 letters uppercase
    return input.country.trim().slice(0, 2).toUpperCase();
  }
  return "XX";
}

/**
 * Build the canonical location key for a given location input.
 *
 * @throws never — all errors produce a best-effort fallback key
 */
export function canonicalLocationKey(input: LocationKeyInput): string {
  const cc = resolveCountryCode(input).toLowerCase();
  const type = (input.stampType ?? "city").toLowerCase();

  switch (type) {
    case "country": {
      return `country:${cc}`;
    }

    case "region": {
      const reg = input.region
        ? normalizeSegment(input.region)
        : cc;
      return `region:${cc}:${reg}`;
    }

    case "city":
    case "check_in": {
      const city = input.city
        ? normalizeSegment(input.city)
        : "unknown";
      return `city:${cc}:${city}`;
    }

    case "neighborhood": {
      const city = input.city ? normalizeSegment(input.city) : "unknown";
      const nbhd = input.neighborhood
        ? normalizeSegment(input.neighborhood)
        : "unknown";
      return `neighborhood:${cc}:${city}:${nbhd}`;
    }

    case "landmark":
    case "hidden_gem": {
      const city = input.city ? normalizeSegment(input.city) : "unknown";
      const name = input.displayName
        ? normalizeSegment(input.displayName)
        : "unknown";
      return `${type}:${cc}:${city}:${name}`;
    }

    case "special_event": {
      const name = input.displayName
        ? normalizeSegment(input.displayName)
        : "event";
      return `special_event:${name}`;
    }

    case "plan":
    case "trip":
    case "host":
    case "safe_return":
    case "rent_buddy":
    case "social": {
      // These stamp types are user-specific, not location-canonical.
      // Still build a best-effort key using city if available.
      const city = input.city ? normalizeSegment(input.city) : "unknown";
      return `${type}:${cc}:${city}`;
    }

    default: {
      const city = input.city ? normalizeSegment(input.city) : "unknown";
      return `${type}:${cc}:${city}`;
    }
  }
}

/**
 * Convenience: build key from flat string fields (legacy v1 path compatibility).
 */
export function canonicalLocationKeyFromStrings(opts: {
  stampType: string;
  city?: string | null;
  country?: string | null;
  neighborhood?: string | null;
  region?: string | null;
  displayName?: string | null;
}): string {
  return canonicalLocationKey({
    stampType:    opts.stampType,
    country:      opts.country,
    city:         opts.city,
    neighborhood: opts.neighborhood,
    region:       opts.region,
    displayName:  opts.displayName,
  });
}
