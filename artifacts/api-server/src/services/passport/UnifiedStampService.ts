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

/** Which live table a unified stamp was read from (storage origin, not provenance). */
export type UnifiedStampSource = "v1_gps" | "v2_achievement";

/**
 * TABLE 16 — canonical server-side stamp provenance. This is the PROVENANCE
 * (where a stamp legitimately came from), distinct from the storage origin
 * (`UnifiedStampSource`). It is derived on read from the live `source_type`
 * columns and never trusts a self-editable profile field (§12).
 */
export type StampSource =
  | "self_reported"
  | "system_observed"
  | "trip_derived"
  | "event_verified"
  | "contribution_earned"
  | "buddy_derived"
  | "partner_verified"
  | "admin_issued";

/**
 * TABLE 16 — the platform's trust assertion on a stamp. §12: a self-reported or
 * decorative stamp must NEVER visually impersonate a verified one, so this is
 * derived from canonical provenance (verification_level / award path), not from
 * an editable field.
 */
export type StampVerification = "decorative" | "reported" | "verified";

export interface UnifiedStamp {
  source: UnifiedStampSource;
  /** TABLE 16 provenance, derived server-side from the live source_type. */
  stampSource: StampSource;
  /** TABLE 16 verification assertion, derived from provenance (§12). */
  verification: StampVerification;
  /** v2 user_stamps.id when source is v2; null for v1 GPS rows. */
  userStampId: string | null;
  /** v2 user_stamps.stamp_definition_id; null for v1 GPS rows. */
  definitionId: string | null;
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

/**
 * Map a live `source_type` string onto the TABLE 16 StampSource enum. The raw
 * values are the award-provenance strings the write paths actually use
 * (StampAwardEngine: trips/posts/events/admin/moderation/system/recalculate/
 * safe_return/rent_buddy; PassportStampService GPS: system/passport/checkin/
 * gps/crew). Unknown/absent → system_observed (a platform-awarded stamp with no
 * more specific provenance), EXCEPT explicit self markers → self_reported.
 */
export function mapStampSource(raw: string | null | undefined): StampSource {
  switch (norm(raw)) {
    case "trips":       return "trip_derived";
    case "events":      return "event_verified";
    case "posts":       return "contribution_earned";
    case "rent_buddy":
    case "buddy":       return "buddy_derived";
    case "admin":
    case "moderation":  return "admin_issued";
    case "partner":
    case "partner_verified": return "partner_verified";
    case "self":
    case "self_reported":
    case "manual":
    case "manual_memory":
    case "user":        return "self_reported";
    default:            return "system_observed";
  }
}

/**
 * §12 verification assertion for a v1 passport_stamps row. The live table forces
 * a self-inserted stamp to verification_level='unverified' (migration 2149 RLS),
 * so an unverified/absent level is a reported claim — never "verified". The
 * platform-set levels (verified/gps/checkin/crew/safe_return/admin/community) are
 * canonical travel facts → verified.
 */
export function verificationFromLevel(level: string | null | undefined): StampVerification {
  switch (norm(level)) {
    case "verified":
    case "gps":
    case "checkin":
    case "crew":
    case "safe_return":
    case "admin":
    case "community":
      return "verified";
    case "decorative":
      return "decorative";
    default:
      // 'unverified' (self-inserted default) and any unknown level: a claim, not
      // a verified fact. Presented as "reported" so it can never impersonate a
      // verified stamp (§12).
      return "reported";
  }
}

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/**
 * Dedup key: catalog link first, else the place tuple, else (for location-less
 * v2 rows) the stamp definition.
 *
 * Location-less v2 stamps (badges / social / safety achievements: city and
 * country both null, catalog_id not yet backfilled) previously all collapsed
 * into one `loc:{type}||` key, so distinct achievements vanished from the
 * unified view. Keying them per definition keeps distinct definitions apart
 * while still collapsing repeat awards of the SAME definition — which matches
 * the catalog semantics: every award of a location-less definition resolves to
 * the single "definition:{slug}" catalog entry (StampAwardEngine →
 * resolveOrEnqueueForDefinition), so once catalog_id is backfilled the `cat:`
 * key would dedup them identically.
 */
function dedupKey(s: { catalogId: string | null; stampType: string | null; country: string | null; city: string | null; definitionId?: string | null }): string {
  if (s.catalogId) return `cat:${s.catalogId}`;
  const country = norm(s.country);
  const city = norm(s.city);
  if (!country && !city && s.definitionId) return `def:${s.definitionId}`;
  return `loc:${norm(s.stampType)}|${country}|${city}`;
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
        "id, stamp_definition_id, source_type, city, country, earned_at, is_revoked, catalog_id, " +
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
      // v2 achievements are awarded only by StampAwardEngine via the service
      // role (never self-inserted), so they are canonical facts → verified (§12).
      stampSource: mapStampSource(r.source_type),
      verification: "verified" as const,
      userStampId: r.id ?? null,
      definitionId: r.stamp_definition_id ?? null,
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
        // v1 carries a real, platform-controlled verification_level and
        // source_type (both un-forgeable by the owner, migration 2149) — read
        // them verbatim so a self-inserted 'unverified' stamp can never appear
        // as verified (§12).
        stampSource: mapStampSource(r.source_type),
        verification: verificationFromLevel(r.verification_level),
        userStampId: null,
        definitionId: null,
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
