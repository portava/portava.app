/**
 * canonicalLocations — the server half of the universal location service.
 *
 * Responsibilities:
 *  - Normalize location names so provider variants compare equal
 *    ("Cebu City" / "Cebu" / "city of cebu" -> "cebu").
 *  - Resolve any Place-shaped object to a canonical_locations row
 *    (find-or-create), merging provider ids and aliases as variants appear.
 *  - Degrade gracefully: if the table is missing or the DB is down, callers
 *    get `canonicalId: null` and everything else keeps working.
 *
 * The matching core (`matchCanonical`) is a pure function so it can be
 * unit-tested without a database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "./logger";

const logger = rootLogger.child({ lib: "canonicalLocations" });

// ── Types ─────────────────────────────────────────────────────────────────────

/** Mirror of the client Place shape (only the fields the resolver reads). */
export interface PlaceInput {
  id: string;
  type: string;
  name: string;
  displayName?: string | null;
  city?: string | null;
  district?: string | null;
  region?: string | null;
  country?: string | null;
  countryCode?: string | null;
  postalCode?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface CanonicalRow {
  id: string;
  kind: string;
  name: string;
  normalized_name: string;
  display_name: string;
  city: string | null;
  region: string | null;
  country: string | null;
  country_code: string | null;
  postal_code: string | null;
  lat: number | null;
  lng: number | null;
  provider_ids: Record<string, string>;
  aliases: string[];
}

export interface ResolveResult {
  canonicalId: string | null;
  /** Canonical fields to merge over the input place (may be empty on failure). */
  canonical: Partial<{
    name: string;
    displayName: string;
    city: string | null;
    region: string | null;
    country: string | null;
    countryCode: string | null;
    postalCode: string | null;
    lat: number | null;
    lng: number | null;
  }>;
}

// ── Name normalization ────────────────────────────────────────────────────────

const GENERIC_PREFIX = /^(?:city|municipality|province|district|town) of\s+/;
const GENERIC_SUFFIX = /\s+(?:city|municipality|metro)$/;

/**
 * Normalize a location name for comparison:
 * lowercase, strip diacritics, drop punctuation, collapse whitespace, and
 * remove generic prefixes/suffixes ("Cebu City" -> "cebu", "City of Manila"
 * -> "manila"). Output only contains [a-z0-9 ] so it is safe in queries.
 */
export function normalizeLocationName(name: string): string {
  let n = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")    // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
  const stripped = n.replace(GENERIC_PREFIX, "").replace(GENERIC_SUFFIX, "").trim();
  // Never strip down to nothing ("Mexico City" -> "mexico", fine; "City" -> keep "city")
  return stripped.length > 0 ? stripped : n;
}

/** Coarse kind classes: matching rules differ per class. */
export type KindClass = "admin" | "city" | "venue";

export function kindClass(type: string): KindClass {
  switch (type) {
    case "country":
    case "region":
      return "admin";
    case "city":
    case "town":
    case "district":
    case "neighborhood":
      return "city";
    default:
      return "venue"; // place | landmark | airport | anything else
  }
}

export function haversineKm(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Extract {provider, providerId} from a Place id like "nominatim-12345". */
export function providerKeyOf(placeId: string): { provider: string; providerId: string } | null {
  const m = /^(nominatim|foursquare|maptiler|google)-(.+)$/.exec(placeId);
  if (!m) return null;
  return { provider: m[1], providerId: m[2] };
}

// Max distance (km) for two same-named locations to be considered the same.
const CITY_MATCH_KM = 50;
const VENUE_MATCH_KM = 1.5;

/**
 * Pure matching core: given candidate rows (pre-filtered by name/provider),
 * pick the row that IS this place, or null if none qualifies.
 *
 * Rules:
 *  1. Shared provider id -> same location, always.
 *  2. Same kind class + compatible country + same normalized name (or alias)
 *     + geographic proximity when both sides have coordinates
 *     (50 km for city-class, 1.5 km for venue-class, unlimited for admin).
 *     Missing coordinates on either side -> name+country is enough.
 */
export function matchCanonical(rows: CanonicalRow[], place: PlaceInput): CanonicalRow | null {
  const pk = providerKeyOf(place.id);
  if (pk) {
    const byProvider = rows.find((r) => r.provider_ids?.[pk.provider] === pk.providerId);
    if (byProvider) return byProvider;
  }

  const norm = normalizeLocationName(place.name);
  const cls = kindClass(place.type);
  const cc = place.countryCode?.toUpperCase() ?? null;
  const countryNorm = place.country ? normalizeLocationName(place.country) : null;

  for (const row of rows) {
    if (kindClass(row.kind) !== cls) continue;

    // Country compatibility: equal codes, or fall back to country-name compare,
    // or one side unknown (null) — unknown never disqualifies.
    const rowCc = row.country_code?.toUpperCase() ?? null;
    if (cc && rowCc && cc !== rowCc) continue;
    if (!cc || !rowCc) {
      const rowCountryNorm = row.country ? normalizeLocationName(row.country) : null;
      if (countryNorm && rowCountryNorm && countryNorm !== rowCountryNorm) continue;
    }

    const nameHit =
      row.normalized_name === norm || (row.aliases ?? []).includes(norm);
    if (!nameHit) continue;

    if (
      place.lat != null && place.lng != null &&
      row.lat != null && row.lng != null &&
      cls !== "admin"
    ) {
      const maxKm = cls === "city" ? CITY_MATCH_KM : VENUE_MATCH_KM;
      if (haversineKm(place.lat, place.lng, row.lat, row.lng) > maxKm) continue;
    }
    return row;
  }
  return null;
}

// ── Resolution (find-or-create) ───────────────────────────────────────────────

const TABLE = "canonical_locations";

// place.id -> ResolveResult, 1 h TTL. Provider ids are stable so this is safe.
const resolveCache = new Map<string, { result: ResolveResult; ts: number }>();
const RESOLVE_CACHE_TTL_MS = 60 * 60 * 1000;
const inFlight = new Map<string, Promise<ResolveResult>>();

let tableMissingLogged = false;
const NULL_RESULT: ResolveResult = { canonicalId: null, canonical: {} };

function isMissingTable(err: any): boolean {
  const code = err?.code ?? "";
  const msg = String(err?.message ?? "");
  return code === "42P01" || code === "PGRST205" || /canonical_locations/.test(msg) && /not exist|not found/i.test(msg);
}

function rowToCanonicalFields(row: CanonicalRow): ResolveResult["canonical"] {
  return {
    name: row.name,
    displayName: row.display_name,
    city: row.city,
    region: row.region,
    country: row.country,
    countryCode: row.country_code,
    postalCode: row.postal_code,
    lat: row.lat,
    lng: row.lng,
  };
}

/** Prefer non-null incoming values to backfill canonical rows over time. */
function buildRowPatch(row: CanonicalRow, place: PlaceInput, norm: string): Partial<CanonicalRow> | null {
  const patch: any = {};
  const pk = providerKeyOf(place.id);
  if (pk && row.provider_ids?.[pk.provider] !== pk.providerId) {
    patch.provider_ids = { ...(row.provider_ids ?? {}), [pk.provider]: pk.providerId };
  }
  if (norm !== row.normalized_name && !(row.aliases ?? []).includes(norm)) {
    patch.aliases = [...(row.aliases ?? []), norm];
  }
  if (row.lat == null && place.lat != null) { patch.lat = place.lat; patch.lng = place.lng; }
  if (row.postal_code == null && place.postalCode) patch.postal_code = place.postalCode;
  if (row.country == null && place.country) patch.country = place.country;
  if (row.country_code == null && place.countryCode) patch.country_code = place.countryCode.toUpperCase();
  if (row.region == null && place.region) patch.region = place.region;
  if (Object.keys(patch).length === 0) return null;
  patch.updated_at = new Date().toISOString();
  return patch;
}

/**
 * Resolve a place to its canonical location row, creating one if needed.
 * Never throws — failures return `{ canonicalId: null, canonical: {} }`.
 */
export async function resolveCanonicalLocation(
  db: SupabaseClient,
  place: PlaceInput,
): Promise<ResolveResult> {
  if (!place?.name || typeof place.name !== "string") return NULL_RESULT;

  const cacheKey = `${place.id}|${normalizeLocationName(place.name)}`;
  const hit = resolveCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < RESOLVE_CACHE_TTL_MS) return hit.result;

  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const promise = doResolve(db, place)
    .then((result) => {
      if (result.canonicalId) resolveCache.set(cacheKey, { result, ts: Date.now() });
      return result;
    })
    .catch((err) => {
      logger.warn({ err, placeId: place.id }, "canonical resolve failed");
      return NULL_RESULT;
    })
    .finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, promise);
  return promise;
}

async function doResolve(db: SupabaseClient, place: PlaceInput, retried = false): Promise<ResolveResult> {
  const norm = normalizeLocationName(place.name);
  if (!norm) return NULL_RESULT;

  // Candidate set: provider-id match first (exact), then name/alias matches.
  let candidates: CanonicalRow[] = [];
  const pk = providerKeyOf(place.id);

  try {
    if (pk) {
      const { data, error } = await db
        .from(TABLE)
        .select("*")
        .contains("provider_ids", { [pk.provider]: pk.providerId })
        .limit(3);
      if (error) throw error;
      candidates = (data ?? []) as CanonicalRow[];
    }

    if (candidates.length === 0) {
      const [byName, byAlias] = await Promise.all([
        db.from(TABLE).select("*").eq("normalized_name", norm)
          .order("created_at", { ascending: true }).limit(20),
        db.from(TABLE).select("*").contains("aliases", [norm])
          .order("created_at", { ascending: true }).limit(20),
      ]);
      if (byName.error) throw byName.error;
      if (byAlias.error) throw byAlias.error;
      const seen = new Set<string>();
      for (const r of [...(byName.data ?? []), ...(byAlias.data ?? [])] as CanonicalRow[]) {
        if (!seen.has(r.id)) { seen.add(r.id); candidates.push(r); }
      }
    }
  } catch (err) {
    if (isMissingTable(err)) {
      if (!tableMissingLogged) {
        tableMissingLogged = true;
        logger.error("canonical_locations table missing — apply migration 0125. Resolving is disabled until then.");
      }
      return NULL_RESULT;
    }
    throw err;
  }

  const match = matchCanonical(candidates, place);

  if (match) {
    const patch = buildRowPatch(match, place, norm);
    if (patch) {
      // Best-effort enrichment; a race here only loses an alias/backfill.
      const { error } = await db.from(TABLE).update(patch).eq("id", match.id);
      if (error) logger.warn({ error, id: match.id }, "canonical row patch failed");
      Object.assign(match, patch);
    }
    return { canonicalId: match.id, canonical: rowToCanonicalFields(match) };
  }

  // No match — create the canonical row from this place.
  const insertRow = {
    kind: place.type || "place",
    name: place.name,
    normalized_name: norm,
    display_name: place.displayName || place.name,
    city: place.city ?? (kindClass(place.type) === "city" ? place.name : null),
    region: place.region ?? null,
    country: place.country ?? null,
    country_code: place.countryCode?.toUpperCase() ?? null,
    postal_code: place.postalCode ?? null,
    lat: place.lat ?? null,
    lng: place.lng ?? null,
    provider_ids: pk ? { [pk.provider]: pk.providerId } : {},
    aliases: [] as string[],
  };

  const { data, error } = await db.from(TABLE).insert(insertRow).select("*").single();
  if (error) {
    if (isMissingTable(error)) return NULL_RESULT;
    // 23505: lost a create race — another resolve inserted the same canonical
    // identity (unique index from migration 0126). Re-run the match once; the
    // winner's row is now in the candidate set.
    if ((error as { code?: string }).code === "23505" && !retried) {
      return doResolve(db, place, true);
    }
    throw error;
  }
  const row = data as CanonicalRow;
  return { canonicalId: row.id, canonical: rowToCanonicalFields(row) };
}
