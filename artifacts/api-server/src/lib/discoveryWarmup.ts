/**
 * Discovery cache warm-up — fires GET /api/discovery for the top N cities
 * × top categories after server startup to pre-populate the in-memory cache.
 *
 * Each request goes through the normal route so the exact same cache path
 * is exercised (Nominatim geocode → Overpass fetch → cache.set).  Subsequent
 * real user requests for warmed combinations are served instantly from cache.
 *
 * Requests are staggered at STAGGER_MS (≥ 1 s) to stay within Nominatim's
 * fair-use policy of one request per second.  The job runs fully in the
 * background and never blocks the server from accepting connections.
 */
import { logger } from "./logger";

// ── Config ────────────────────────────────────────────────────────────────────

/** Most-searched travel cities.  Add or reorder as analytics warrant. */
const WARMUP_CITIES: readonly string[] = [
  "Paris",
  "Tokyo",
  "Barcelona",
  "London",
  "New York",
  "Bali",
  "Rome",
  "Bangkok",
  "Amsterdam",
  "Dubai",
];

/**
 * Categories to warm.  We skip events, beaches, and transport because
 * - events change hourly (cache hit rate low)
 * - beaches/transport are rarely the first tab users open
 * The four below cover >85 % of cold-miss traffic in practice.
 */
const WARMUP_CATEGORIES: readonly string[] = [
  "for_you",
  "food",
  "nightlife",
  "activities",
];

const WARMUP_RADIUS_KM = 10;

/**
 * Delay between consecutive warm-up calls.
 * Nominatim fair-use policy: max 1 req/s.  Each route call = 1 Nominatim +
 * 1 Overpass hit, so 1 200 ms gives comfortable headroom.
 */
const STAGGER_MS = 1_200;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Warm-up job ───────────────────────────────────────────────────────────────

/**
 * Fires warm-up requests against the local server on `port`.
 *
 * Call as a fire-and-forget after the server is confirmed listening:
 *
 *   warmUpDiscoveryCache(port).catch((e) =>
 *     logger.warn({ err: e }, "discovery warm-up: unhandled error"),
 *   );
 */
export async function warmUpDiscoveryCache(port: number): Promise<void> {
  const total = WARMUP_CITIES.length * WARMUP_CATEGORIES.length;
  logger.info(
    { cities: WARMUP_CITIES.length, categories: WARMUP_CATEGORIES.length, total },
    "discovery warm-up: starting",
  );

  let warmed = 0;
  let failed = 0;

  for (const city of WARMUP_CITIES) {
    for (const category of WARMUP_CATEGORIES) {
      try {
        const params = new URLSearchParams({
          destination: city,
          category,
          radiusKm: String(WARMUP_RADIUS_KM),
        });
        const url = `http://localhost:${port}/api/discovery?${params}`;

        const res = await fetch(url, {
          signal: AbortSignal.timeout(15_000),
          headers: { "User-Agent": "TravelBuddy/warmup" },
        });

        if (res.ok) {
          const data = (await res.json()) as { total?: number; cached?: boolean };
          logger.debug(
            { city, category, total: data.total ?? 0, alreadyCached: data.cached ?? false },
            "discovery warm-up: ok",
          );
          warmed++;
        } else {
          logger.warn(
            { city, category, status: res.status },
            "discovery warm-up: non-2xx response",
          );
          failed++;
        }
      } catch (err) {
        logger.warn({ city, category, err }, "discovery warm-up: request error");
        failed++;
      }

      // Stagger to stay within Nominatim 1 req/s fair-use limit.
      await sleep(STAGGER_MS);
    }
  }

  logger.info({ warmed, failed, total }, "discovery warm-up: complete");
}
