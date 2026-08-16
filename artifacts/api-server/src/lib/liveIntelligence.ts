/**
 * liveIntelligence — Phase 8 Live Intelligence.
 *
 * Central confidence system + tool-time live lookups for volatile data.
 *
 * Source classes (carried end-to-end API → UI):
 *   - verified_live       — checked against a live external source just now
 *                           (weather via Open-Meteo, open-now via Foursquare)
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
  label:       string;
  /** ISO timestamp of when the datum was checked/read. */
  checkedAt:   string;
  /** Optional honest note, e.g. why live verification was unavailable. */
  dataNote?:   string;
}

export function makeConfidence(sourceClass: SourceClass, note?: string): Confidence {
  return {
    sourceClass,
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

const FSQ_URL = "https://places-api.foursquare.com/places/search";
const FSQ_API_VERSION = "2025-06-17";
const LIVE_TIMEOUT_MS = 2_500;
const LIVE_CACHE_TTL_MS = 10 * 60 * 1_000; // 10 minutes — volatile data, short TTL

export interface LiveVenueStatus {
  openNow:   boolean | null;   // null = source responded but didn't include hours
  venueName: string;
  source:    "foursquare";
  checkedAt: string;
}

interface LiveCacheEntry {
  status:   LiveVenueStatus | null; // null = confirmed miss (venue not found)
  cachedAt: number;
}

const liveCache = new Map<string, LiveCacheEntry>();

/** TEST ONLY — clear the live-status cache. */
export function _clearLiveCache(): void {
  liveCache.clear();
}

function liveKey(name: string, city: string | null): string {
  return `${name.trim().toLowerCase()}|${(city ?? "").trim().toLowerCase()}`;
}

/**
 * Look up a venue's live open-now status by name (+ optional city).
 *
 * Returns:
 *   - LiveVenueStatus  → source reached; openNow may still be null when the
 *                        source has no hours data (honest unknown)
 *   - null             → source unavailable (no key, outage, timeout, error,
 *                        or venue not found) — caller MUST degrade honestly.
 */
export async function getLiveVenueStatus(
  name: string,
  city: string | null,
): Promise<LiveVenueStatus | null> {
  if (!name.trim()) return null;
  if (isSourceDown("places_live")) return null; // simulated outage

  const nowMs = Date.now(); // single clock read (split-clock guard)
  const key = liveKey(name, city);
  const cached = liveCache.get(key);
  if (cached && nowMs - cached.cachedAt < LIVE_CACHE_TTL_MS) return cached.status;

  const apiKey = getFoursquareApiKey();
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({
      query: name,
      limit: "1",
      fields: "fsq_place_id,name,hours",
    });
    if (city) params.set("near", city);

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
    const r = Array.isArray(body?.results) ? body.results[0] : null;
    if (!r?.fsq_place_id) {
      // Confirmed "not found" — cache the miss so we don't hammer the source.
      liveCache.set(key, { status: null, cachedAt: nowMs });
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
    liveCache.set(key, { status, cachedAt: nowMs });
    return status;
  } catch (err) {
    logger.warn({ err, name }, "live venue lookup error — degrading honestly");
    return null;
  }
}
