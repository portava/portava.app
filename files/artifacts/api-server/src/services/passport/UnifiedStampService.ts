/**
 * UnifiedStampService — Stamp Wave (legacy unification, read-layer).
 *
 * Portava has two live stamp systems that count separately by design:
 *   v1  passport_stamps  — GPS / location stamps (the passport screen's count)
 *   v2  user_stamps      — achievements, rarity, catalog art (the Stamps tab)
 *
 * This service presents both as ONE deduplicated collection for reads, so a
 * user's passport can show a single coherent stamp count/list. It is strictly
 * READ-ONLY and additive:
 *   - No writes. No data migration. Both write paths stay exactly as they are.
 *   - Dedup key: catalog_id when present (reconcile backfills it on BOTH
 *     tables), else normalized (stamp_type | country | city). When a place
 *     exists in both systems, the richer v2 row wins (it carries rarity + art).
 *   - Defensive: either table missing / column drift → that source contributes
 *     nothing rather than throwing. Never crashes a passport read.
 *
 * Consumers gate on `stamp_unified_view_enabled`; when off, legacy per-system
 * counts remain authoritative.
 */

export const UNIFIED_FLAG = "stamp_unified_view_enabled";

export type UnifiedStampSource = "v1_gps" | "v2_achievement";

export interface UnifiedStamp {
  source: UnifiedStampSource;
  /** v2 user_stamps.id when source is v2; null for v1 GPS rows. */
  userStampId: string | null;
  catalogId: string | null;
  stampType: string | null;
  city: string | null;
  country: string | null;
  earnedAt: string | null;
  /** v2 only: definition-derived. */
  name: string | null;
  rarity: string | null;
  artworkUrl: string | null;
}

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/** Dedup key: catalog link first, else the place tuple. */
function dedupKey(s: { catalogId: string | null; stampType: string | null; country: string | null; city: string | null }): string {
  if (s.catalogId) return `cat:${s.catalogId}`;
  return `loc:${norm(s.stampType)}|${norm(s.country)}|${norm(s.city)}`;
}

function pickDate(row: any): string | null {
  return row.earned_at ?? row.awarded_at ?? row.unlocked_at ?? row.created_at ?? null;
}

/** Read v2 achievement stamps (non-revoked), with definition + composited art. */
async function readV2(sc: any, userId: string): Promise<UnifiedStamp[]> {
  try {
    const { data, error } = await sc
      .from("user_stamps")
      .select(
        "id, city, country, earned_at, is_revoked, catalog_id, " +
        "stamp_definitions(name, rarity, stamp_type)",
      )
      .eq("user_id", userId)
      .eq("is_revoked", false);
    if (error || !Array.isArray(data)) return [];

    const rows = data as any[];
    // Resolve composited artwork for the catalog ids in one batch.
    const catalogIds = [...new Set(rows.map((r) => r.catalog_id).filter((x): x is string => typeof x === "string"))];
    const artMap = await readArtwork(sc, catalogIds);

    return rows.map((r) => ({
      source: "v2_achievement" as const,
      userStampId: r.id ?? null,
      catalogId: r.catalog_id ?? null,
      stampType: r.stamp_definitions?.stamp_type ?? null,
      city: r.city ?? null,
      country: r.country ?? null,
      earnedAt: pickDate(r),
      name: r.stamp_definitions?.name ?? null,
      rarity: r.stamp_definitions?.rarity ?? null,
      artworkUrl: r.catalog_id ? (artMap.get(r.catalog_id) ?? null) : null,
    }));
  } catch {
    return [];
  }
}

/** Read v1 GPS stamps. Tolerates schema drift (locked column, date column). */
async function readV1(sc: any, userId: string): Promise<UnifiedStamp[]> {
  try {
    const { data, error } = await sc
      .from("passport_stamps")
      .select("*")
      .eq("user_id", userId);
    if (error || !Array.isArray(data)) return [];
    return (data as any[])
      .filter((r) => r.locked !== true) // live table has a `locked` flag; skip locked
      .map((r) => ({
        source: "v1_gps" as const,
        userStampId: null,
        catalogId: r.catalog_id ?? null,
        stampType: r.stamp_type ?? null,
        city: r.city ?? null,
        country: r.country ?? null,
        earnedAt: pickDate(r),
        name: null,
        rarity: null,
        artworkUrl: null,
      }));
  } catch {
    return [];
  }
}

/** Batch-resolve composited artwork (active version public_url) by catalog id. */
async function readArtwork(sc: any, catalogIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (catalogIds.length === 0) return map;
  try {
    const { data, error } = await sc
      .from("universal_stamp_catalog")
      .select("id, stamp_artwork_versions!active_version_id(public_url)")
      .in("id", catalogIds)
      .eq("status", "approved");
    if (error || !Array.isArray(data)) return map;
    for (const row of data as any[]) {
      map.set(row.id, row.stamp_artwork_versions?.public_url ?? null);
    }
  } catch {
    // ignore — art is optional
  }
  return map;
}

export interface UnifiedStampResult {
  stamps: UnifiedStamp[];
  count: number;
  /** Breakdown for observability / debugging. */
  breakdown: { v2: number; v1: number; deduped: number };
}

/**
 * Merge v1 + v2 into one deduplicated collection. v2 (richer) wins ties.
 * Sorted newest-first by earnedAt.
 */
export async function buildUnifiedStamps(sc: any, userId: string): Promise<UnifiedStampResult> {
  const [v2, v1] = await Promise.all([readV2(sc, userId), readV1(sc, userId)]);

  const byKey = new Map<string, UnifiedStamp>();
  for (const s of v2) byKey.set(dedupKey(s), s);   // v2 first — wins ties
  let dedupedFromV1 = 0;
  for (const s of v1) {
    const k = dedupKey(s);
    if (byKey.has(k)) { dedupedFromV1++; continue; } // already covered by a v2 stamp
    byKey.set(k, s);
  }

  const stamps = [...byKey.values()].sort((a, b) => {
    const ta = a.earnedAt ? Date.parse(a.earnedAt) : 0;
    const tb = b.earnedAt ? Date.parse(b.earnedAt) : 0;
    return tb - ta;
  });

  return {
    stamps,
    count: stamps.length,
    breakdown: { v2: v2.length, v1: v1.length, deduped: dedupedFromV1 },
  };
}

/** Convenience: just the unified count (for passport stat). */
export async function getUnifiedStampCount(sc: any, userId: string): Promise<number> {
  const { count } = await buildUnifiedStamps(sc, userId);
  return count;
}

/** Read the unification flag. Fail-closed to false (legacy counts stay authoritative). */
export async function unifiedViewEnabled(sc: any): Promise<boolean> {
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", UNIFIED_FLAG)
      .maybeSingle();
    if (error) return false;
    return (data as any)?.enabled === true;
  } catch {
    return false;
  }
}
