/**
 * discoverySearchHelpers.ts
 *
 * Pure intelligence helpers for the unified search endpoint.
 * Exported for unit testing — no Supabase or Express dependencies.
 *
 * Covers Phases 11–18, 26 of the Search Intelligence roadmap:
 *   Phase 11–12: Multi-tier ranking (exact > prefix > contains)
 *   Phase 13–14: Typo tolerance via static alias map
 *   Phase 15–16: Time-intent parsing ("tonight", "tomorrow", etc.)
 *   Phase 17–18: Location / nearby-intent context
 */

// ── Search query context ───────────────────────────────────────────────────────

export interface SearchQueryContext {
  lat?: number | null;
  lng?: number | null;
  tz?: string | null;
  startsAfter?: string | null;
  startsBefore?: string | null;
  timeLabel?: string | null;
  /** True when the query contained a proximity keyword ("nearby", "near me", etc.) */
  nearbyIntent?: boolean;
  /**
   * Human-readable city name for the user's current location.
   * Mobile passes this when nearbyIntent=true and location is granted.
   * Used to city-boost events, travelers, and places that don't have lat/lng.
   */
  userCity?: string | null;
}

// ── Alias / typo-tolerance map ─────────────────────────────────────────────────
// Maps common travel-domain misspellings and synonyms to canonical terms.
// Keys are lowercase; matching is case-insensitive, word-boundary only.

export const SEARCH_ALIASES: Record<string, string> = {
  // People
  "travler":      "traveler",
  "tarveler":     "traveler",
  "traveller":    "traveler",
  "backpaker":    "backpacker",
  // Food & drink
  "restaurnt":    "restaurant",
  "reataurant":   "restaurant",
  "resturant":    "restaurant",
  "restrant":     "restaurant",
  "restraunt":    "restaurant",
  "resterant":    "restaurant",
  "coctail":      "cocktail",
  "coctails":     "cocktails",
  // Philippine destinations (common misspellings)
  "siargou":      "siargao",
  "siargow":      "siargao",
  "borocay":      "boracay",
  "phlippines":   "philippines",
  "philippnes":   "philippines",
  "davou":        "davao",
  "ceboo":        "cebu",
  "manilla":      "manila",
  "maniila":      "manila",
  "gensan":       "general santos",
  // International cities
  "tokoyo":       "tokyo",
  "tokio":        "tokyo",
  "bankok":       "bangkok",
  "bangok":       "bangkok",
  "phuket":       "phuket",  // common misspelling covered by ilike anyway
  "pukhet":       "phuket",
  "barcalona":    "barcelona",
  "singapor":     "singapore",
  "istambul":     "istanbul",
  // Places
  "bech":         "beach",
  "beachh":       "beach",
  "musem":        "museum",
  "museam":       "museum",
  "hotell":       "hotel",
  "hostle":       "hostel",
  // Activities
  "hiing":        "hiking",
  "hikng":        "hiking",
  "treking":      "trekking",
  "swiming":      "swimming",
  "snorkling":    "snorkeling",
  "divng":        "diving",
  // Nightlife
  "nightlif":     "nightlife",
  "nighlife":     "nightlife",
  "clubing":      "clubbing",
  // Events
  "evnt":         "event",
  "evenet":       "event",
  "festval":      "festival",
  "festivel":     "festival",
  // Misc travel
  "acivity":      "activity",
  "activty":      "activity",
  "adveture":     "adventure",
  "adventur":     "adventure",
  "photograpy":   "photography",
  "photigraphy":  "photography",
  "wknd":         "weekend",
  "tonite":       "tonight",
  "tmrw":         "tomorrow",
  // Philippine destination abbreviations (gensan already listed above; gl added here)
  "gl":           "general luna",
};

/**
 * Replace the first word-boundary alias match in q with its canonical form.
 * Case-insensitive; preserves the rest of the query verbatim.
 * Returns the original string unchanged when no alias matches.
 */
export function applyAliases(q: string): string {
  for (const [typo, canonical] of Object.entries(SEARCH_ALIASES)) {
    const re = new RegExp(`\\b${typo}\\b`, "i");
    if (re.test(q)) {
      return q.replace(re, canonical);
    }
  }
  return q;
}

// ── Multi-tier ranking ─────────────────────────────────────────────────────────

/**
 * Score a result title (and optional subtitle) against the search query.
 *   3 = exact match
 *   2 = prefix match
 *   1 = substring match
 *   0 = no match
 *
 * For traveler results the subtitle carries the @handle.
 * Passing subtitle lets @username searches rank handle-exact matches at tier 3.
 */
export function matchTier(title: string, q: string, subtitle?: string | null): number {
  const lq = q.toLowerCase().trim();
  const t  = (title ?? "").toLowerCase().trim();

  if (t === lq)         return 3;
  if (t.startsWith(lq)) return 2;
  if (t.includes(lq))   return 1;

  // Also score against the subtitle (strip leading @)
  if (subtitle) {
    const s = subtitle.replace(/^@/, "").toLowerCase().trim();
    if (s === lq)         return 3;
    if (s.startsWith(lq)) return 2;
    if (s.includes(lq))   return 1;
  }
  return 0;
}

/**
 * Stable-sort items so higher match tiers appear first.
 * Accepts any object with a `title` field and an optional `subtitle` field.
 */
export function rankByMatchTier<T extends { title: string; subtitle?: string | null }>(
  items: T[],
  q: string,
): T[] {
  return [...items].sort(
    (a, b) =>
      matchTier(b.title, q, b.subtitle) - matchTier(a.title, q, a.subtitle),
  );
}

export interface RankCombinedOpts {
  /**
   * When true, upcoming items (startsAt >= now) sort before past items
   * within the same match tier.  Nearest upcoming sorts first; past items
   * sort most-recent-first.  Items without a startsAt date are treated as
   * past.  Use for trip and event types.
   */
  upcomingFirst?: boolean;
}

/**
 * Combined weighted sort in a single pass:
 *   1. Match tier (primary)  — exact > prefix > contains > none
 *   2. Upcoming-first        — (optional) future startsAt before past ones
 *   3. City proximity        — (optional) locationPreview matches userCity
 *
 * Use this instead of `rankByMatchTier` for types that carry location/time
 * so that city-boosting or upcoming-first ordering is not undone by a second
 * sort downstream.  Without optional fields the function degenerates to a
 * pure match-tier sort (stable).
 *
 * @param userCity  Human-readable city name from the user's location; ignored
 *                  when null/undefined.
 * @param opts      See {@link RankCombinedOpts}.
 */
export function rankCombined<T extends {
  title: string;
  subtitle?: string | null;
  locationPreview?: string | null;
  startsAt?: string | null;
}>(
  items: T[],
  q: string,
  userCity?: string | null,
  opts?: RankCombinedOpts,
): T[] {
  const nowMs = Date.now();
  return [...items].sort((a, b) => {
    // ── 1. Match tier ─────────────────────────────────────────────────────────
    const tierA = matchTier(a.title, q, a.subtitle);
    const tierB = matchTier(b.title, q, b.subtitle);
    if (tierA !== tierB) return tierB - tierA;

    // ── 2. Upcoming-first (trips, events) ────────────────────────────────────
    if (opts?.upcomingFirst) {
      const aMs = a.startsAt ? new Date(a.startsAt).getTime() : null;
      const bMs = b.startsAt ? new Date(b.startsAt).getTime() : null;
      const aUp = aMs != null && aMs >= nowMs ? 1 : 0;
      const bUp = bMs != null && bMs >= nowMs ? 1 : 0;
      if (aUp !== bUp) return bUp - aUp;            // upcoming before past
      if (aUp && bUp && aMs != null && bMs != null) return aMs - bMs; // nearest upcoming first
      if (!aUp && !bUp && aMs != null && bMs != null) return bMs - aMs; // most recent past first
    }

    // ── 3. City tiebreak (nearby intent) ─────────────────────────────────────
    if (userCity) {
      const uCity = userCity.toLowerCase();
      const inCityA = (a.locationPreview ?? "").toLowerCase().includes(uCity) ? 1 : 0;
      const inCityB = (b.locationPreview ?? "").toLowerCase().includes(uCity) ? 1 : 0;
      if (inCityA !== inCityB) return inCityB - inCityA;
    }

    return 0; // preserve original relative order (stable)
  });
}

// ── Distance helpers ───────────────────────────────────────────────────────────

/** Haversine distance in km between two lat/lng points. */
export function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Nearby-intent parsing ──────────────────────────────────────────────────────

const NEARBY_PATTERNS: RegExp[] = [
  /\bnearby\b/i,
  /\bnear\s+me\b/i,
  /\baround\s+me\b/i,
  /\bnear\s+here\b/i,
  /\bclose\s+by\b/i,
];

export interface NearbyIntentResult {
  nearbyIntent: boolean;
  strippedQuery: string;
}

/**
 * Detect a proximity keyword in the query and strip it.
 * Returns { nearbyIntent: false, strippedQuery: q } when no keyword found.
 */
export function parseNearbyIntent(q: string): NearbyIntentResult {
  for (const re of NEARBY_PATTERNS) {
    if (re.test(q)) {
      const stripped = q.replace(re, "").replace(/\s{2,}/g, " ").trim();
      return { nearbyIntent: true, strippedQuery: stripped || q };
    }
  }
  return { nearbyIntent: false, strippedQuery: q };
}

// ── Time-intent parsing ────────────────────────────────────────────────────────

export type TimeIntentType = "tonight" | "tomorrow" | "this_weekend" | "next_week";

export interface TimeIntent {
  type: TimeIntentType;
  label: string;
  /** ISO 8601 UTC lower bound for starts_at filtering. */
  startsAfter: string;
  /** ISO 8601 UTC upper bound (exclusive) for starts_at filtering. */
  startsBefore: string;
}

export interface TimeIntentResult {
  intent: TimeIntent | null;
  /** Query with the time expression removed (falls back to original if stripping leaves empty). */
  strippedQuery: string;
}

const INTENT_PATTERNS: { re: RegExp; type: TimeIntentType; label: string }[] = [
  { re: /\btonight\b/i,        type: "tonight",      label: "Tonight" },
  { re: /\btonite\b/i,         type: "tonight",      label: "Tonight" },
  { re: /\btomorrow\b/i,       type: "tomorrow",     label: "Tomorrow" },
  { re: /\btmrw\b/i,           type: "tomorrow",     label: "Tomorrow" },
  { re: /\bthis\s+weekend\b/i, type: "this_weekend", label: "This Weekend" },
  { re: /\bnext\s+week\b/i,    type: "next_week",    label: "Next Week" },
];

/**
 * Parse a time-intent keyword from the query and derive UTC date bounds.
 * Uses the IANA timezone string (tz) for local-date computation.
 * Falls back to UTC when tz is absent or invalid.
 */
export function parseTimeIntent(q: string, tz?: string | null): TimeIntentResult {
  for (const { re, type, label } of INTENT_PATTERNS) {
    if (!re.test(q)) continue;

    const stripped = q.replace(re, "").replace(/\s{2,}/g, " ").trim();
    const now = new Date();

    let tzOffsetMs = 0;
    if (tz) {
      try {
        const fmt = (tz_: string) =>
          now.toLocaleString("en-US", { timeZone: tz_, hour12: false });
        tzOffsetMs = new Date(fmt(tz)).getTime() - new Date(fmt("UTC")).getTime();
      } catch {
        tzOffsetMs = 0;
      }
    }

    const localNow    = new Date(now.getTime() + tzOffsetMs);
    const localMidnight = Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate(),
    );

    const toUtc = (localMs: number) => new Date(localMs - tzOffsetMs).toISOString();

    let startsAfter: string;
    let startsBefore: string;

    switch (type) {
      case "tonight": {
        startsAfter  = toUtc(localMidnight + 18 * 3600_000);
        startsBefore = toUtc(localMidnight + 24 * 3600_000);
        break;
      }
      case "tomorrow": {
        startsAfter  = toUtc(localMidnight + 24 * 3600_000);
        startsBefore = toUtc(localMidnight + 48 * 3600_000);
        break;
      }
      case "this_weekend": {
        const dow      = localNow.getUTCDay();
        const daysToSat = dow === 0 ? 6 : (6 - dow);
        const satMs    = localMidnight + daysToSat * 24 * 3600_000;
        const monMs    = satMs + 2 * 24 * 3600_000;
        const startMs  = dow === 0 || dow === 6 ? localMidnight : satMs;
        startsAfter    = toUtc(startMs);
        startsBefore   = toUtc(monMs);
        break;
      }
      case "next_week": {
        const dow       = localNow.getUTCDay();
        const daysToMon = dow === 0 ? 1 : (8 - dow);
        const monMs     = localMidnight + daysToMon       * 24 * 3600_000;
        const nextMonMs = localMidnight + (daysToMon + 7) * 24 * 3600_000;
        startsAfter     = toUtc(monMs);
        startsBefore    = toUtc(nextMonMs);
        break;
      }
    }

    return {
      intent: { type, label, startsAfter, startsBefore },
      strippedQuery: stripped || q,
    };
  }

  return { intent: null, strippedQuery: q };
}
