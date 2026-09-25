/**
 * protectedZoneStore — the ONE reader of `protected_zones`.
 *
 * ── WHY IT IS A MODULE AND NOT A SECOND COPY ────────────────────────────────
 * `routes/mapProjection.ts` has read this table since §24 was built, behind a
 * private `loadProtectedZones` with a 30-second cache, and that TTL is carried
 * over UNCHANGED: moving a reader is not the moment to retune its caching. Discovery now needs the
 * same zones for the same reason — `lib/discoveryCandidate.coverageForCandidate`
 * cannot publish a cohort bucket without them — and the obvious move, copying
 * the loader, is the failure `lib/sensingCoverageAggregate`'s header names
 * about thresholds: two readers of one privacy policy drift apart, and the one
 * that drifts LOOSE is the one nobody notices.
 *
 * So the loader moved here and `mapProjection` calls it. There is one cache,
 * one parse, and one answer to "what does this database's policy say".
 *
 * ── THE TWO FAIL-CLOSED RULES, PRESERVED EXACTLY ────────────────────────────
 * Both are load-bearing and neither is obvious, so they are restated rather
 * than left to be re-derived from the code:
 *
 *   1. AN UNREADABLE POLICY IS NOT AN ABSENT POLICY. A failed read returns
 *      `null`, never `[]`. An empty array means "the policy was read and there
 *      are no zones", which permits publishing; null means "we could not ask",
 *      which must not. Collapsing them publishes a protected place during a
 *      database blip.
 *   2. A MALFORMED RING STAYS IN THE LIST. `applyProtection` treats geometry it
 *      cannot parse as SUPPRESS. Dropping the row here would quietly turn a
 *      broken policy row into no policy at all, which is the wrong direction.
 */
import type { ProtectedZone } from "./protectedLocations.js";

/** How long a successful read is reused. Unsuccessful reads are never cached. */
export const PROTECTED_ZONE_CACHE_TTL_MS = 30_000;

let cache: { zones: ProtectedZone[]; at: number } | null = null;

/** Drop the cache. Exported for tests and for an operator changing the policy. */
export function clearProtectedZoneCache(): void {
  cache = null;
}

/**
 * Every active protected zone, or NULL when the policy could not be read.
 *
 * Null is not an empty list. See rule 1 above.
 */
export async function loadActiveProtectedZones(sc: any): Promise<ProtectedZone[] | null> {
  if (cache && Date.now() - cache.at < PROTECTED_ZONE_CACHE_TTL_MS) return cache.zones;
  if (!sc || typeof sc.from !== "function") return null;

  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await sc
      .from("protected_zones")
      .select(
        "id, category, action, privacy_floor, shape, center_lat, center_lng, radius_meters, ring, jurisdiction, policy_ref",
      )
      .eq("active", true));
  } catch {
    // A throw is a failed read, not an empty policy.
    return null;
  }
  if (error || !Array.isArray(data)) return null;

  const zones: ProtectedZone[] = [];
  for (const row of data as any[]) {
    const base = {
      id: String(row.id),
      category: String(row.category),
      action: row.action ?? undefined,
      privacyFloor: row.privacy_floor ?? undefined,
      jurisdiction: row.jurisdiction ?? undefined,
      policyRef: row.policy_ref ?? undefined,
    };
    if (row.shape === "circle") {
      zones.push({
        ...base,
        shape: "circle",
        center: { lat: Number(row.center_lat), lng: Number(row.center_lng) },
        radiusMeters: Number(row.radius_meters),
      } as ProtectedZone);
    } else {
      // See rule 2: unparseable geometry is SUPPRESS, so it must stay in.
      zones.push({ ...base, shape: "polygon", ring: row.ring } as ProtectedZone);
    }
  }
  cache = { zones, at: Date.now() };
  return zones;
}
