/**
 * HiddenGemDiscoveryService
 *
 * Ranking, proximity scoring, and vibe-tag matching for gem discovery.
 * Ranking formula: verificationWeight + saveScore + visitScore + vibeMatchBonus
 *
 * Proximity: haversine distance used to sort/filter by lat/lng radius.
 * Only public + approximate gems expose coordinates for proximity ranking.
 * Protected gems are never distance-ranked (no coords).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const VERIFICATION_WEIGHT: Record<string, number> = {
  admin:        5,
  guide:        4,
  gps_verified: 3,
  community:    2,
  unverified:   0,
};

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
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

/** Compute a single gem's discovery score (higher = better rank). */
function scoreGem(
  gem: any,
  vibeTags: string[],
  userLat?: number,
  userLng?: number,
): { score: number; distanceKm: number | null } {
  const vw = VERIFICATION_WEIGHT[gem.verification_level] ?? 0;
  const saveScore  = Math.min(gem.save_count  ?? 0, 200) / 200 * 3;
  const visitScore = Math.min(gem.visit_count ?? 0, 100) / 100 * 2;

  // Vibe-tag overlap bonus (+1 per matching tag, max 3)
  const gemTags   = (gem.vibe_tags ?? []) as string[];
  const tagBonus  = Math.min(
    gemTags.filter((t) => vibeTags.includes(t)).length,
    3,
  );

  // Proximity decay: perfect score at 0 km, 0 at 50 km+
  let proximityBonus = 0;
  let distanceKm: number | null = null;
  if (userLat != null && userLng != null) {
    const lat = gem.latitude ?? gem.approx_latitude;
    const lng = gem.longitude ?? gem.approx_longitude;
    if (lat != null && lng != null) {
      distanceKm = haversineKm(userLat, userLng, lat, lng);
      proximityBonus = Math.max(0, 2 * (1 - distanceKm / 50));
    }
  }

  return {
    score: vw + saveScore + visitScore + tagBonus + proximityBonus,
    distanceKm,
  };
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
