/**
 * discoveryWarmup — pre-populate the Discovery L1 (in-memory) and L2 (Postgres)
 * caches on startup for the top 20 cities and repeat hourly.
 *
 * Strategy:
 *  • warmUpDiscoveryCache(port) — called once on startup; fires 20 × 4 = 80 HTTP
 *    requests at 1.2-second intervals so Overpass/Nominatim aren't overwhelmed.
 *  • startDiscoveryCacheWarmer(port) — sets a recurring 1-hour timer that calls
 *    warmUpDiscoveryCache again, refreshing the L2 Postgres cache before entries
 *    expire (2 h TTL) so a cold-started instance always finds warm DB entries.
 */

import { logger } from "./logger.js";

// ── Cities ───────────────────────────────────────────────────────────────────
//
// Ordered roughly by traveler-demand (most requested first based on usage logs).
// Limit to 20 so the full warmup cycle takes ~100 s — well within the 2 h TTL.
const WARMUP_CITIES = [
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
  // ── extended set (10 more) ─────────────────────────────
  "Sydney",
  "Istanbul",
  "Lisbon",
  "Singapore",
  "Mexico City",
  "Miami",
  "Kyoto",
  "Prague",
  "Seoul",
  "Cape Town",
];

const WARMUP_CATEGORIES = ["food", "nightlife", "activities", "for_you"] as const;

// Interval between individual requests (ms) — keeps Overpass under fair-use rate.
const REQUEST_INTERVAL_MS = 1_200;

// Per-request timeout (ms) — Overpass can be slow; allow up to 15 s.
const REQUEST_TIMEOUT_MS  = 15_000;

// How often to repeat the full warmup cycle (ms).
const WARMUP_CYCLE_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

// ── Core warm-up function ────────────────────────────────────────────────────

/**
 * Warm up the cache for all cities × categories, staggered by REQUEST_INTERVAL_MS.
 *
 * Calls the local `/api/discovery` endpoint which — after Step 2 changes — writes
 * results to both the in-memory Map (L1) and the Postgres table (L2).
 *
 * @param port  The port the API server is listening on (same process).
 */
export async function warmUpDiscoveryCache(port: number): Promise<void> {
  const pairs: Array<{ city: string; category: string }> = [];
  for (const city of WARMUP_CITIES) {
    for (const category of WARMUP_CATEGORIES) {
      pairs.push({ city, category });
    }
  }

  logger.info(
    { cities: WARMUP_CITIES.length, categories: WARMUP_CATEGORIES.length, total: pairs.length },
    "discovery warm-up: starting",
  );

  let warmed = 0;
  let failed = 0;

  for (const { city, category } of pairs) {
    // Wait between requests to stay within rate limits.
    await new Promise<void>((r) => setTimeout(r, REQUEST_INTERVAL_MS));

    try {
      const url = `http://localhost:${port}/api/discovery?destination=${encodeURIComponent(city)}&category=${category}`;
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { "x-warmup": "1" },
      });
      if (resp.ok) {
        warmed++;
      } else {
        failed++;
        logger.warn({ city, category, status: resp.status }, "discovery warm-up: non-OK response");
      }
    } catch (e) {
      failed++;
      logger.warn({ city, category, err: e }, "discovery warm-up: request error");
    }
  }

  logger.info({ warmed, failed, total: pairs.length }, "discovery warm-up: complete");
}

// ── Hourly scheduler ─────────────────────────────────────────────────────────

/**
 * Start the recurring Discovery cache warmer.
 *
 * Calls warmUpDiscoveryCache immediately on startup (one cycle runs in the
 * background), then repeats every WARMUP_CYCLE_INTERVAL_MS (1 hour).  The
 * interval is unref()d so it doesn't prevent the process from exiting cleanly
 * during tests.
 *
 * @param port  The port the API server is listening on.
 */
export function startDiscoveryCacheWarmer(port: number): void {
  // Run once immediately (non-blocking — don't await).
  warmUpDiscoveryCache(port).catch((e) =>
    logger.warn({ err: e }, "discovery warm-up: unhandled error"),
  );

  // Repeat hourly.
  const interval = setInterval(() => {
    warmUpDiscoveryCache(port).catch((e) =>
      logger.warn({ err: e }, "discovery warm-up: hourly repeat error"),
    );
  }, WARMUP_CYCLE_INTERVAL_MS);

  // Allow the process to exit cleanly even if the interval is still pending.
  if (interval.unref) interval.unref();

  logger.info(
    { intervalHours: WARMUP_CYCLE_INTERVAL_MS / 3_600_000 },
    "discovery warm-up: hourly scheduler started",
  );
}
