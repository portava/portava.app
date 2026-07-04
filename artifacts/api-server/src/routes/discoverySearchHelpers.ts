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
 *   Phase 17–18: Location context type definitions
 */

// ── Search query context ───────────────────────────────────────────────────────

export interface SearchQueryContext {
  lat?: number | null;
  lng?: number | null;
  tz?: string | null;
  startsAfter?: string | null;
  startsBefore?: string | null;
  timeLabel?: string | null;
}

// ── Alias / typo-tolerance map ─────────────────────────────────────────────────
// Maps common travel-domain misspellings and synonyms to canonical search terms.
// Keys are lowercase; matching is case-insensitive word-boundary.

export const SEARCH_ALIASES: Record<string, string> = {
  // People
  "travler":     "traveler",
  "tarveler":    "traveler",
  "traveller":   "traveler",
  "backpaker":   "backpacker",
  // Food
  "restaurnt":   "restaurant",
  "reataurant":  "restaurant",
  "resturant":   "restaurant",
  "restrant":    "restaurant",
  "restraunt":   "restaurant",
  "resterant":   "restaurant",
  // Places
  "bech":        "beach",
  "beachh":      "beach",
  "musem":       "museum",
  "museam":      "museum",
  "hotell":      "hotel",
  "hostle":      "hostel",
  // Activities
  "hiing":       "hiking",
  "hikng":       "hiking",
  "treking":     "trekking",
  "swiming":     "swimming",
  "snorkling":   "snorkeling",
  "divng":       "diving",
  // Nightlife
  "nightlif":    "nightlife",
  "nighlife":    "nightlife",
  "coctail":     "cocktail",
  "coctails":    "cocktails",
  "clubing":     "clubbing",
  // Events
  "evnt":        "event",
  "evenet":      "event",
  "festval":     "festival",
  "festivel":    "festival",
  // Misc travel
  "acivity":     "activity",
  "activty":     "activity",
  "adveture":    "adventure",
  "adventur":    "adventure",
  "photograpy":  "photography",
  "photigraphy": "photography",
  "wknd":        "weekend",
  "tonite":      "tonight",
  "tmrw":        "tomorrow",
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
 * Score a result title against the search query.
 *   3 = exact match (title === query)
 *   2 = prefix match (title starts with query)
 *   1 = substring match (title contains query)
 *   0 = no title match (subtitle/location may still match via DB query)
 */
export function matchTier(title: string, q: string): number {
  const t = (title ?? "").toLowerCase().trim();
  const lq = q.toLowerCase().trim();
  if (t === lq) return 3;
  if (t.startsWith(lq)) return 2;
  if (t.includes(lq)) return 1;
  return 0;
}

/**
 * Stable-sort items so higher match tiers appear first.
 * Items with equal tier preserve their original (DB-order) relative position.
 */
export function rankByMatchTier<T extends { title: string }>(items: T[], q: string): T[] {
  return [...items].sort((a, b) => matchTier(b.title, q) - matchTier(a.title, q));
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
  { re: /\bthis\s+weekend\b/i, type: "this_weekend", label: "This weekend" },
  { re: /\bnext\s+week\b/i,    type: "next_week",    label: "Next week" },
];

/**
 * Parse a time-intent keyword from the query and derive UTC date bounds.
 * Uses the IANA timezone string (tz) for local-date computation.
 * Falls back to UTC when tz is absent or invalid.
 *
 * Returns { intent: null, strippedQuery: q } when no time keyword is found.
 */
export function parseTimeIntent(q: string, tz?: string | null): TimeIntentResult {
  for (const { re, type, label } of INTENT_PATTERNS) {
    if (!re.test(q)) continue;

    const stripped = q.replace(re, "").replace(/\s{2,}/g, " ").trim();
    const now = new Date();

    // Compute the local timezone offset in ms so we can work with "local midnight".
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

    // Build a "local now" by shifting UTC by the offset.
    const localNow = new Date(now.getTime() + tzOffsetMs);

    // Local midnight (as UTC ms) — the basis for all date arithmetic.
    const localMidnight = Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate(),
    );

    // Convenience: convert a local ms timestamp back to real UTC.
    const toUtc = (localMs: number) => new Date(localMs - tzOffsetMs).toISOString();

    let startsAfter: string;
    let startsBefore: string;

    switch (type) {
      case "tonight": {
        // 18:00–24:00 local
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
        // Saturday–Sunday of the current week (or today if already Sat/Sun)
        const dow = localNow.getUTCDay(); // 0=Sun … 6=Sat
        const daysToSat = dow === 0 ? 6 : (6 - dow); // days until next Saturday
        const satMs = localMidnight + daysToSat * 24 * 3600_000;
        const monMs = satMs + 2 * 24 * 3600_000;
        const startMs = dow === 0 || dow === 6 ? localMidnight : satMs;
        startsAfter  = toUtc(startMs);
        startsBefore = toUtc(monMs);
        break;
      }
      case "next_week": {
        // Monday–Sunday of next ISO week
        const dow = localNow.getUTCDay();
        const daysToMon = dow === 0 ? 1 : (8 - dow);
        const monMs    = localMidnight + daysToMon       * 24 * 3600_000;
        const nextMonMs = localMidnight + (daysToMon + 7) * 24 * 3600_000;
        startsAfter  = toUtc(monMs);
        startsBefore = toUtc(nextMonMs);
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
