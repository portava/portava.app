/**
 * sourceRegistry — resolve a provider/source string to its `sources` row id,
 * and hold the deterministic string->origin mapping the migration seeds from.
 *
 * WHY THIS EXISTS
 * ===============
 * A place's origin lives on scattered provider/source columns
 * (external_place_references.provider, discovery_places.source,
 * fsq_places.source). Migration 2101 makes origin explicit in `public.sources`
 * and adds a source_id FK to each carrier. This module is the read side: given
 * a provider/source string, return the source row's uuid so a write path can
 * populate source_id.
 *
 * FAIL-CLOSED
 * ===========
 * An UNMAPPED string returns null. It is never guessed into an origin — the
 * caller decides what to do with a null (leave source_id NULL, log, etc.).
 * A DB error also yields null for every lookup rather than a wrong id.
 *
 * Follows the featureFlags.ts conventions: the service client is injected as
 * the first argument (`sc: any`), and typing is intentionally loose at the
 * boundary.
 */
import { logger } from "./logger.js";

/** The six canonical place origins. The `sources.origin` CHECK enforces these. */
export const ORIGINS = [
  "official",
  "provider",
  "buddy",
  "traveler",
  "inferred",
  "promotional",
] as const;

export type Origin = (typeof ORIGINS)[number];

export interface SeedSource {
  key: string;
  display_name: string;
  origin: Origin;
}

/**
 * The single source of truth for the seed. Migration 2101's INSERT mirrors this
 * list exactly. One row per distinct existing provider/source string that
 * denotes a PLACE origin.
 *
 * buddy/inferred/promotional have no seed row: no existing string denotes them.
 * They remain valid origins the schema accepts, seeded when a real string needs
 * one — never guessed.
 *
 * Deliberately excluded (not place-origins):
 *   - discovery_place_photos.source ('foursquare'/'google') — photo provenance.
 *   - the image-provenance taxonomy (image_source_type, source_provider).
 *   - demo/QA fixtures ('seed_script','demo','qa_fixture') — quarantined, not
 *     production origins.
 */
export const SEED_SOURCES: readonly SeedSource[] = [
  { key: "portava",       display_name: "Portava (first-party verified)", origin: "official" },
  { key: "curated",       display_name: "Curated editorial",              origin: "official" },
  { key: "fsq",           display_name: "Foursquare",                     origin: "provider" },
  { key: "fsq_os_places", display_name: "Foursquare OS Places",           origin: "provider" },
  { key: "osm",           display_name: "OpenStreetMap",                  origin: "provider" },
  { key: "google",        display_name: "Google Places",                  origin: "provider" },
  { key: "user",          display_name: "Traveler-contributed",           origin: "traveler" },
  { key: "traveler",      display_name: "Traveler community",             origin: "traveler" },
];

/** Look up the seeded origin for a provider/source string, or null if unmapped. */
export function originForKey(key: string | null | undefined): Origin | null {
  if (!key) return null;
  return SEED_SOURCES.find((s) => s.key === key)?.origin ?? null;
}

// ── key -> source id, with a short TTL cache ──────────────────────────────────
// resolveSourceId is on write paths; the registry is tiny and effectively
// static, so a full-table load cached for 30s keeps this to at most two reads a
// minute. 30s mirrors the flag-cache window in lib/discoveryServeLog.ts.
const REGISTRY_TTL_MS = 30_000;
let _cache: { map: Map<string, string>; at: number } | null = null;

/** Invalidate the registry cache. Exported for tests. */
export function invalidateSourceRegistryCache(): void {
  _cache = null;
}

async function loadRegistry(sc: any): Promise<Map<string, string>> {
  if (_cache && Date.now() - _cache.at < REGISTRY_TTL_MS) return _cache.map;
  try {
    const { data, error } = await sc.from("sources").select("id, key");
    if (error || !data) {
      // Fail-closed: do not cache a failure. Every lookup returns null until the
      // next successful load, rather than serving a stale-or-empty guess.
      logger.warn({ err: error }, "sourceRegistry: sources load failed");
      return new Map();
    }
    const map = new Map<string, string>();
    for (const row of data as Array<{ id: string; key: string }>) {
      map.set(row.key, row.id);
    }
    _cache = { map, at: Date.now() };
    return map;
  } catch (err) {
    logger.warn({ err }, "sourceRegistry: sources load threw");
    return new Map();
  }
}

/**
 * Resolve a provider/source string to its `sources.id`.
 * Returns null for an unknown string or on any DB error (fail-closed). The
 * caller handles null — this never guesses an origin.
 */
export async function resolveSourceId(sc: any, providerString: string | null | undefined): Promise<string | null> {
  if (!providerString) return null;
  const map = await loadRegistry(sc);
  return map.get(providerString) ?? null;
}
