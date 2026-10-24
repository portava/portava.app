/**
 * discoveryTrendCanonicalContext — census-discovery §133 (DV-28, DV-29, DV-33,
 * DC-06, DC-21): the v2 trend context for the places Discovery actually serves.
 *
 * Every served Discovery place is a `public.places` row (`db/<places.id>`,
 * lib/discoveryCandidates/materialize.ts). The v2 context read
 * `discovery_places` only — in production 0 of 180 served places joined it
 * (2026-10-23) — so every served place had no cell, city, content class, Trail
 * or creator, and every lifecycle read `unknown`.
 *
 * Behind `discovery_trend_canonical_place_context_enabled` (3920, seeded FALSE):
 *   - loadTrendContext (lib/discoveryLocalMomentum) adds the active, unmerged
 *     `places` rows for the candidate ids no `discovery_places` row shadows —
 *     the materialiser's precedence — mapped by `canonicalContextPlaceRow`;
 *   - the rebuild scheduler calls `rebuild_place_momentum_canonical` (3920),
 *     whose context `discovery_trend_place_context_canonical()` is this
 *     mapping's SQL twin (src/test/db/discoveryTrendCanonicalContext.db.test.ts C1).
 * OFF, absent or unreadable: neither reads anything new, and both run exactly
 * as before. A canonical place has no submitter column, so its creator is null
 * (no creator peer baseline) — stated, never inferred.
 */
import { isFlagEnabled } from "./featureFlags.js";
import type { ContextPlaceRow } from "./discoveryTrendNormalised.js";

/** 3920's row. */
export const TREND_CANONICAL_CONTEXT_FLAG = "discovery_trend_canonical_place_context_enabled";

/** The `places` columns the context reads. */
export const CANONICAL_CONTEXT_PLACES_SELECT = "id, city, neighborhood, latitude, longitude, created_at, primary_category";

/** The RPC each producer calls. */
export const TREND_REBUILD_RPC = "rebuild_place_momentum";
export const TREND_REBUILD_RPC_CANONICAL = "rebuild_place_momentum_canonical";

/** A `places` row → the context row 3920's SQL builds from it. */
export function canonicalContextPlaceRow(row: Record<string, unknown>): ContextPlaceRow {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: String(row["id"]),
    submitted_by: null,
    city: typeof row["city"] === "string" ? (row["city"] as string) : null,
    neighborhood: typeof row["neighborhood"] === "string" ? (row["neighborhood"] as string) : null,
    lat: num(row["latitude"]),
    lng: num(row["longitude"]),
    created_at: typeof row["created_at"] === "string" ? (row["created_at"] as string) : null,
    category: typeof row["primary_category"] === "string" ? (row["primary_category"] as string) : null,
    place_type: null,
  };
}

/**
 * The canonical rows to add to a candidate set's context: `[]` while the flag
 * is OFF, absent or unreadable (no read is issued), the mapped rows when ON, and
 * null when that read FAILED — the caller then treats the context as unread,
 * exactly as for a failed `discovery_places` read.
 */
export async function loadCanonicalContextRows(
  sc: any, ids: readonly string[], shadowed: readonly ContextPlaceRow[],
): Promise<ContextPlaceRow[] | null> {
  if (!(await isFlagEnabled(sc, "discovery_trend_canonical_place_context_enabled"))) return [];
  const taken = new Set(shadowed.map((r) => String(r?.id ?? "").toLowerCase()));
  const rest = ids.filter((id) => !taken.has(id.toLowerCase()));
  if (rest.length === 0) return [];
  try {
    const res = await sc.from("places")
      .select("id, city, neighborhood, latitude, longitude, created_at, primary_category")
      .in("id", rest)
      .eq("status", "active")
      .is("merged_into_place_id", null);
    if (res?.error || !Array.isArray(res?.data)) return null;
    return (res.data as Array<Record<string, unknown>>).map(canonicalContextPlaceRow);
  } catch {
    // resolves-not-throws-ok: a throw is a failed read, reported as null.
    return null;
  }
}

/** Which rebuild the scheduler calls: the canonical one only while the flag reads TRUE. */
export async function trendRebuildRpc(sc: any): Promise<typeof TREND_REBUILD_RPC | typeof TREND_REBUILD_RPC_CANONICAL> {
  return (await isFlagEnabled(sc, "discovery_trend_canonical_place_context_enabled")) ? TREND_REBUILD_RPC_CANONICAL : TREND_REBUILD_RPC;
}
