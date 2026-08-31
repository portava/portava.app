/**
 * HiddenGemDiscoveryService
 *
 * Ranking, proximity scoring, and vibe-tag matching for gem discovery.
 *
 * Ranking is EVIDENCE / FRESHNESS / RELEVANCE based and is deliberately NOT
 * popularity-first (§16.2). The scoring lives in the pure `scoreGemForRanking`
 * (lib/hiddenGemState) so it can be unit-tested and so a diff shows any change:
 *   evidence(verification) + freshness(updated_at) + vibe + proximity
 *   − overcrowding demotion
 * save_count / visit_count are NOT ranking inputs — the previous
 * saveScore/visitScore terms were the §16.2 popularity-first violation, and a
 * fragile overcrowded gem is now demoted rather than boosted by its saves.
 *
 * Proximity: haversine distance used to sort/filter by lat/lng radius.
 * Only public + approximate gems expose coordinates for proximity ranking.
 * Protected gems are never distance-ranked (no coords).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { scoreGemForRanking } from "../../lib/hiddenGemState.js";

/**
 * Lat/lng bounding box for a radius around a point (mirrors lib/mapTravelers).
 * A generous superset of the true circle — the haversine pass below still makes
 * the exact circular cut, so a slightly-too-wide box never changes results,
 * it only bounds how many rows the DB returns.
 */
function radiusBoundingBox(lat: number, lng: number, radiusKm: number): {
  minLat: number; maxLat: number; minLng: number; maxLng: number;
} {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    minLat: Number((lat - dLat).toFixed(5)),
    maxLat: Number((lat + dLat).toFixed(5)),
    minLng: Number((lng - dLng).toFixed(5)),
    maxLng: Number((lng + dLng).toFixed(5)),
  };
}

/**
 * Compute a single gem's discovery score (higher = better rank).
 * Delegates to the pure, popularity-free `scoreGemForRanking`.
 */
function scoreGem(
  gem: any,
  vibeTags: string[],
  userLat?: number,
  userLng?: number,
): { score: number; distanceKm: number | null } {
  return scoreGemForRanking(gem, { vibeTags, userLat, userLng });
}

export interface DiscoverGemsOptions {
  city?: string;
  neighborhood?: string;
  category?: string;
  vibeTags?: string[];
  userLat?: number;
  userLng?: number;
  /** km — used for /nearby endpoint */
  radiusKm?: number;
  layoverSafe?: boolean;
  availableMinutes?: number;
  limit?: number;
  offset?: number;
}

export interface RankedGem {
  gem: any;
  score: number;
  distanceKm: number | null;
}

/**
 * Discover and rank active gems.
 * Proximity filtering applied when userLat/userLng + radiusKm provided.
 * Always excludes hidden/merged/pending gems.
 */
export async function discoverGems(
  db: SupabaseClient,
  opts: DiscoverGemsOptions = {},
): Promise<RankedGem[]> {
  // Proximity path: bound the fetch to a lat/lng box so we don't pull the whole
  // active table and radius-filter in JS. Without this, a global /nearby query
  // fetched up to 300 status-only rows in unspecified order — which could BOTH
  // miss nearby gems (past the unordered cap) and over-fetch far ones. The box
  // is matched against the gem's effective position — exact coords, or approx
  // coords when exact is absent — so it never drops a gem the haversine pass
  // would have kept. Gems with no coordinates at all (protected) fall outside
  // both boxes and are excluded from proximity results, matching
  // findNearbyGems' documented contract.
  const proximityBounded =
    opts.userLat != null && opts.userLng != null && opts.radiusKm != null;

  let q = db
    .from("hidden_gems")
    .select(`
      id, name, category, city, country, neighborhood,
      description, latitude, longitude, approx_latitude, approx_longitude,
      vibe_tags, price_range, safety_notes, best_time_to_go, local_etiquette,
      layover_safe, minimum_layover_minutes,
      sensitivity_level, verification_level, status,
      submitted_by, guide_verified_by,
      save_count, visit_count, report_count,
      image_url, canonical_place_id, source_type, moderation_status,
      created_at, updated_at
    `)
    .eq("status", "active");

  if (proximityBounded) {
    const b = radiusBoundingBox(opts.userLat!, opts.userLng!, opts.radiusKm!);
    q = q.or(
      `and(latitude.gte.${b.minLat},latitude.lte.${b.maxLat},longitude.gte.${b.minLng},longitude.lte.${b.maxLng}),` +
      `and(approx_latitude.gte.${b.minLat},approx_latitude.lte.${b.maxLat},approx_longitude.gte.${b.minLng},approx_longitude.lte.${b.maxLng})`,
    );
  }

  q = q.limit(Math.min((opts.limit ?? 60) * 3, 300)); // over-fetch for client-side ranking

  if (opts.city)     q = q.ilike("city", opts.city);
  if (opts.neighborhood) q = q.ilike("neighborhood", opts.neighborhood);
  if (opts.category) q = q.eq("category", opts.category);
  if (opts.layoverSafe) {
    q = q.eq("layover_safe", true);
    if (opts.availableMinutes) q = q.lte("minimum_layover_minutes", opts.availableMinutes);
  }

  const { data, error } = await q;
  if (error) throw error;

  const gems = data ?? [];
  const vibeTags = opts.vibeTags ?? [];

  // Score + optional proximity filter
  let ranked: RankedGem[] = gems.map((gem) => {
    const { score, distanceKm } = scoreGem(gem, vibeTags, opts.userLat, opts.userLng);
    return { gem, score, distanceKm };
  });

  if (opts.userLat != null && opts.userLng != null && opts.radiusKm != null) {
    ranked = ranked.filter((r) => r.distanceKm == null || r.distanceKm <= opts.radiusKm!);
  }

  // Sort descending by score
  ranked.sort((a, b) => b.score - a.score);

  const start = opts.offset ?? 0;
  return ranked.slice(start, start + (opts.limit ?? 40));
}

/**
 * Find gems near a lat/lng point within radiusKm.
 * Only gems with coords (exact or approx) are returned.
 * Protected gems (no coords ever) are excluded from proximity results.
 */
export async function findNearbyGems(
  db: SupabaseClient,
  lat: number,
  lng: number,
  radiusKm: number,
  opts: Pick<DiscoverGemsOptions, "city" | "category" | "limit"> = {},
): Promise<RankedGem[]> {
  return discoverGems(db, {
    ...opts,
    userLat: lat,
    userLng: lng,
    radiusKm,
    limit: opts.limit ?? 30,
  });
}

/**
 * Get recommended gems for a user based on their visit/save history.
 * Simple collaborative filter: find vibe tags the user likes, rank accordingly.
 */
export async function getPersonalisedRecommendations(
  db: SupabaseClient,
  userId: string,
  city?: string,
  limit = 20,
): Promise<RankedGem[]> {
  // Collect user's vibe-tag preferences from saved/visited gems
  const { data: savedRows } = await db
    .from("hidden_gem_saves")
    .select("gem_id, hidden_gems(vibe_tags)")
    .eq("user_id", userId)
    .limit(30);

  const preferredTags = new Set<string>();
  for (const r of savedRows ?? []) {
    const tags = (r as any).hidden_gems?.vibe_tags ?? [];
    for (const t of tags) preferredTags.add(t);
  }

  return discoverGems(db, {
    city,
    vibeTags: Array.from(preferredTags),
    limit,
  });
}
