/**
 * discoveryOnePipeline — the two capability gates of census-discovery §79
 * (lane W10-R4): one ranking pipeline for GET /discovery.
 *
 * `discovery_for_you_pde_enabled` (migration 3455, seeded FALSE)
 *   ON: a signed-in `for_you` page is ordered by the PDE pipeline
 *   (lib/discoveryPde `rankForViewer`) and by nothing else. Compass keeps the
 *   job it can do without ordering anything: its pipeline's gates (safety
 *   filter, eligibility, safe-return attention, Live exclusions) decide which
 *   candidates ENTER the PDE pipeline (compass/CompassFeedBuilder
 *   `compassEligibleForDiscovery`). Compass's score is not used, Cache B is
 *   neither read nor written, and `rankItemsForDiscovery` is not called.
 *   OFF / absent / unreadable (the seed): serve points 4 and 5 are exactly
 *   what they were — the Compass order, replayed from or written to Cache B.
 *
 * `discovery_cache_a_ranked_enabled` (migration 3456, seeded FALSE)
 *   ON: a signed-in Cache A hit (serve points 1/2/3) is ranked for the viewer
 *   on the request, in every engine mode, exactly as the signed-in cold fetch
 *   (serve point 6) already is. Cache A stays what `01` §7 says it may be — a
 *   user-independent CANDIDATE cache — and is never a signed-in viewer's final
 *   order. OFF: the cached order is ranked only in `pde` mode for an in-cohort
 *   viewer, as before.
 *
 * Both are CAPABILITY flags (`*_enabled`), read fail-closed through
 * lib/featureFlags.isFlagEnabled and cached for 30 s like every other
 * Discovery serve flag. Turning either on changes the order a real user is
 * served, so that is the owner's decision (Phase F gate 2; register entry
 * D-W10R4-2). Nothing here turns anything on.
 */
import { isFlagEnabled } from "./featureFlags.js";

/** Literal names so check-flag-polarity resolves the reads. */
export const DISCOVERY_FOR_YOU_PDE_FLAG = "discovery_for_you_pde_enabled";
export const DISCOVERY_CACHE_A_RANKED_FLAG = "discovery_cache_a_ranked_enabled";

const FLAG_TTL_MS = 30_000;
const _flagCache = new Map<string, { value: boolean; at: number }>();

/** Invalidate both flag caches. Exported for tests. */
export function invalidateOnePipelineFlagCache(): void {
  _flagCache.clear();
}

async function cachedFlag(key: string, read: () => Promise<boolean>): Promise<boolean> {
  const hit = _flagCache.get(key);
  if (hit && Date.now() - hit.at < FLAG_TTL_MS) return hit.value;
  let value = false;
  try { value = await read(); } catch { value = false; }
  _flagCache.set(key, { value, at: Date.now() });
  return value;
}

/** 3455. Only a signed-in `for_you` request can be governed by it; everything else answers false without a read. */
export async function forYouPdeEnabled(sc: any, category: string, viewerId: string | null): Promise<boolean> {
  if (category !== "for_you" || !viewerId || !sc) return false;
  return cachedFlag(DISCOVERY_FOR_YOU_PDE_FLAG, () => isFlagEnabled(sc, DISCOVERY_FOR_YOU_PDE_FLAG));
}

/** 3456. An anonymous request has no viewer to rank for, so it answers false without a read. */
export async function cacheARankedEnabled(sc: any, viewerId: string | null): Promise<boolean> {
  if (!viewerId || !sc) return false;
  return cachedFlag(DISCOVERY_CACHE_A_RANKED_FLAG, () => isFlagEnabled(sc, DISCOVERY_CACHE_A_RANKED_FLAG));
}
