/**
 * liveIntelligence — Phase 8 Live Intelligence.
 *
 * Central confidence system + tool-time live lookups for volatile data.
 *
 * Source classes (carried end-to-end API → UI):
 *   - verified_live       — checked against a live external source just now
 *                           (weather via Open-Meteo, open-now via Foursquare —
 *                           the latter only for a provider record confirmed
 *                           as the place, lead ruling D-67)
 *   - community_reported  — entered/maintained by app users (events, catalog
 *                           entries, community hours notes); current DB read
 *   - historical          — cached/catalog data that may be stale (ratings,
 *                           stored opening hours, approximated route timing)
 *   - ai_inference        — produced by a model, not verified against a source
 *
 * Live lookups follow the weatherCache pattern: short in-memory TTL cache,
 * strict timeout, and graceful degradation — any failure returns null so
 * callers must fall back to clearly-labeled historical data or an explicit
 * "can't verify right now". NEVER fabricate a live value.
 *
 * Test-only outage simulation: _setSimulatedOutage("places_live", true)
 * makes every live venue lookup behave exactly like a source outage.
 */
import { logger as rootLogger } from "./logger";
import { truthClassOfSourceClass } from "./sourceTruth.js";
import type { TruthClass } from "./truthClass.js";
import { getFoursquareApiKey } from "./foursquareApiKey";

const logger = rootLogger.child({ lib: "liveIntelligence" });
let liveQuotaExhaustedLogged = false;

// ── Confidence system ─────────────────────────────────────────────────────────

export type SourceClass =
  | "verified_live"
  | "community_reported"
  | "historical"
  | "ai_inference";

export const CONFIDENCE_LABELS: Record<SourceClass, string> = {
  verified_live:      "Verified live",
  community_reported: "Community-reported",
  historical:         "Historical",
  ai_inference:       "AI inference",
};

export interface Confidence {
  sourceClass: SourceClass;
  /**
   * §5.1 truth class the source class implies (lib/sourceTruth). CPV2-02: a
   * predicted / inferred / stale / unknown datum keeps that qualification on
   * the tool result, so the UI blocks and the grounding envelope can carry it.
   */
  truthClass:  TruthClass;
  label:       string;
  /** ISO timestamp of when the datum was checked/read. */
  checkedAt:   string;
  /** Optional honest note, e.g. why live verification was unavailable. */
  dataNote?:   string;
}

export function makeConfidence(sourceClass: SourceClass, note?: string): Confidence {
  return {
    sourceClass,
    truthClass: truthClassOfSourceClass(sourceClass),
    label: CONFIDENCE_LABELS[sourceClass],
    checkedAt: new Date().toISOString(),
    ...(note ? { dataNote: note } : {}),
  };
}

/** Honest degradation message used when a live source is down/unreachable. */
export const CANT_VERIFY_NOTE =
  "Live status can't be verified right now — showing the last known information instead.";

// ── Test-only outage simulation ───────────────────────────────────────────────

export type LiveSource = "places_live";

const simulatedOutages = new Set<LiveSource>();

/** TEST ONLY — simulate a live-source outage (no fetch is attempted). */
export function _setSimulatedOutage(source: LiveSource, down: boolean): void {
  if (down) simulatedOutages.add(source);
  else simulatedOutages.delete(source);
}

export function isSourceDown(source: LiveSource): boolean {
  return simulatedOutages.has(source);
}

// ── Live venue open-now lookup (Foursquare) ───────────────────────────────────
//
// IDENTITY FIRST (lead ruling D-67, 2026-10-06). A provider record may carry a
// "verified live" label for a Portava place only when it is confirmed to BE
// that place: either a stored provider id matches, or the names match after
// normalisation AND the provider's coordinates lie within
// LIVE_IDENTITY_MAX_DISTANCE_M of the place's own. Neither `discovery_places`
// nor `places` stores a Foursquare id that this lookup is handed today, so the
// name-plus-coordinates rule is the one that applies.
//
// THE DEFECT THIS REPLACES. The lookup used to ask Foursquare for `limit=1` by
// name near a city and label whatever came back "verified_live". A different
// venue with the same or a similar name — a chain's other branch, a namesake
// across town — had its hours shown as this place's, verified live.

const FSQ_URL = "https://places-api.foursquare.com/places/search";
const FSQ_API_VERSION = "2025-06-17";
const LIVE_TIMEOUT_MS = 2_500;
const LIVE_CACHE_TTL_MS = 10 * 60 * 1_000; // 10 minutes — volatile data, short TTL
/** Enough candidates that the right venue is found when a namesake ranks first. */
const LIVE_SEARCH_LIMIT = 5;
/**
 * Search radius around the anchor, in metres. It only biases which candidates
 * the provider returns; identity is decided by LIVE_IDENTITY_MAX_DISTANCE_M.
 */
const LIVE_SEARCH_RADIUS_M = 1_000;

/**
 * The farthest a provider record may sit from the place's stored coordinates
 * and still be the same place (lead ruling D-67: an engineering default that
 * allows for geocoding drift on one street frontage). Change it HERE only.
 */
export const LIVE_IDENTITY_MAX_DISTANCE_M = 150;

/**
 * Where the Portava place is. REQUIRED by `getLiveVenueStatus`; `null` means
 * the place has no usable coordinates, and then nothing can be verified.
 */
export interface LiveVenueAnchor {
  lat: number;
  lng: number;
}

export interface LiveVenueStatus {
  openNow:   boolean | null;   // null = source responded but didn't include hours
  venueName: string;
  source:    "foursquare";
  checkedAt: string;
}

interface LiveCacheEntry {
  status:   LiveVenueStatus | null; // null = confirmed miss (no record confirmed as this place)
  cachedAt: number;
}

const liveCache = new Map<string, LiveCacheEntry>();

/**
 * The most entries the live cache holds (lead follow-up F5). Every distinct
 * name-and-anchor is a key, so without a bound a caller varying a coordinate's
 * last decimal grows the map without end. At the cap the OLDEST entry goes:
 * a Map iterates in insertion order and a write re-inserts its key.
 */
export const LIVE_CACHE_MAX_ENTRIES = 5_000;

function liveCacheSet(key: string, entry: LiveCacheEntry): void {
  liveCache.delete(key);
  liveCache.set(key, entry);
  while (liveCache.size > LIVE_CACHE_MAX_ENTRIES) {
    const oldest = liveCache.keys().next().value;
    if (oldest === undefined) break;
    liveCache.delete(oldest);
  }
}

/** TEST ONLY — clear the live-status cache. */
export function _clearLiveCache(): void {
  liveCache.clear();
}

/** TEST ONLY — how many entries the live cache holds. */
export function _liveCacheSize(): number {
  return liveCache.size;
}

/**
 * The anchor as a usable coordinate pair, or null. A non-finite or
 * out-of-range coordinate is not a place's location, so it anchors nothing.
 */
export function liveVenueAnchorOf(lat: unknown, lng: unknown): LiveVenueAnchor | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * A venue name reduced for an identity comparison: Unicode NFKD, combining
 * marks (diacritics) stripped, case-folded, punctuation removed, whitespace
 * collapsed. Two names match only when these are EXACTLY equal and non-empty.
 * `toUpperCase().toLowerCase()` is the full case fold JavaScript offers
 * (ß → ss, final ς → σ), which a bare `toLowerCase()` is not.
 */
export function normaliseVenueName(name: string): string {
  return String(name)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .toLowerCase()
    .replace(/\p{P}+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Great-circle distance in metres (mean Earth radius). Exported so the 150 m boundary test can pin a record at exactly 150 m. */
export function metresBetween(a: LiveVenueAnchor, b: LiveVenueAnchor): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (((b.lng - a.lng + 540) % 360) - 180) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * D-67's identity rule for one provider record: the normalised names are
 * equal AND the record's own coordinates are within
 * LIVE_IDENTITY_MAX_DISTANCE_M of the anchor. A record without both
 * coordinates cannot be placed, so it is never confirmed.
 */
export function isSameVenue(
  placeName: string,
  anchor: LiveVenueAnchor,
  record: { name?: unknown; latitude?: unknown; longitude?: unknown },
): boolean {
  const want = normaliseVenueName(placeName);
  if (!want) return false;
  if (normaliseVenueName(String(record.name ?? "")) !== want) return false;
  const at = liveVenueAnchorOf(record.latitude, record.longitude);
  if (!at) return false;
  return metresBetween(anchor, at) <= LIVE_IDENTITY_MAX_DISTANCE_M;
}

/** Same name at two different places is two entries, never one. */
function liveKey(name: string, anchor: LiveVenueAnchor): string {
  return `${normaliseVenueName(name)}|${anchor.lat},${anchor.lng}`;
}

/**
 * Look up a venue's live open-now status, for ONE identified place.
 *
 * `anchor` is the place's own stored coordinates and is required: with a null
 * anchor nothing can be confirmed as this place, so the provider is not asked
 * and the answer is null — an honest "can't verify", never a guess.
 *
 * Returns:
 *   - LiveVenueStatus  → a provider record confirmed as this place (D-67);
 *                        openNow may still be null when the source has no
 *                        hours data (honest unknown)
 *   - null             → nothing verifiable: no anchor, no key, outage,
 *                        quota, timeout, error, or no record confirmed as
 *                        this place — caller MUST degrade honestly.
 */
export async function getLiveVenueStatus(
  name: string,
  anchor: LiveVenueAnchor | null,
): Promise<LiveVenueStatus | null> {
  if (!name.trim()) return null;
  const at = anchor ? liveVenueAnchorOf(anchor.lat, anchor.lng) : null;
  if (!at) return null; // no place to confirm a record against — never a name-only guess
  if (isSourceDown("places_live")) return null; // simulated outage

  const nowMs = Date.now(); // single clock read (split-clock guard)
  const key = liveKey(name, at);
  const cached = liveCache.get(key);
  if (cached && nowMs - cached.cachedAt < LIVE_CACHE_TTL_MS) return cached.status;
  if (cached) liveCache.delete(key); // expired: it no longer holds a slot

  const apiKey = getFoursquareApiKey();
  if (!apiKey) return null;

  try {
    // `ll` and `near` are alternatives in the Places API; the place's own
    // coordinates are the better centre for finding THIS venue.
    const params = new URLSearchParams({
      query: name,
      ll: `${at.lat},${at.lng}`,
      radius: String(LIVE_SEARCH_RADIUS_M),
      limit: String(LIVE_SEARCH_LIMIT),
      fields: "fsq_place_id,name,latitude,longitude,hours",
    });

    const res = await fetch(`${FSQ_URL}?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "X-Places-Api-Version": FSQ_API_VERSION },
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    // Same distinction as the discovery photo routes: 429 here means the
    // account has no API credits remaining, not ordinary rate limiting.
    if (res.status === 429) {
      if (!liveQuotaExhaustedLogged) {
        liveQuotaExhaustedLogged = true;
        logger.warn(
          { status: 429 },
          "live venue lookup: account has no API credits remaining — live open-now checks disabled until credits are restored",
        );
      }
      return null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status, name }, "live venue lookup failed — degrading honestly");
      return null;
    }
    const body: any = await res.json();
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    // The FIRST record confirmed as this place; a namesake ranked above it is skipped.
    const r = results.find((x) => x?.fsq_place_id && isSameVenue(name, at, x));
    if (!r) {
      // Confirmed "no record is this place" — cache the miss so we don't
      // hammer the source. A namesake elsewhere is not a partial answer.
      if (results.length > 0) {
        logger.info({ name, candidates: results.length }, "live venue lookup: no record confirmed as this place — no verified-live label");
      }
      liveCacheSet(key, { status: null, cachedAt: nowMs });
      return null;
    }

    const openNow: boolean | null =
      typeof r.hours?.open_now === "boolean" ? r.hours.open_now : null;

    const status: LiveVenueStatus = {
      openNow,
      venueName: String(r.name ?? name),
      source: "foursquare",
      checkedAt: new Date(nowMs).toISOString(),
    };
    liveCacheSet(key, { status, cachedAt: nowMs });
    return status;
  } catch (err) {
    logger.warn({ err, name }, "live venue lookup error — degrading honestly");
    return null;
  }
}
