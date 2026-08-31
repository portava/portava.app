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
  /**
   * Diacritic/stroke-folded search key (§10). Populated by the
   * `search_key` STORED generated column added in migration 2220 (mirrors
   * `searchKey()` below). Optional here so pre-migration rows and unit
   * fixtures without the column still type-check; the folded resolver falls
   * back to `normalized_name` when it is absent.
   */
  search_key?: string | null;
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

// ── Stroke-letter fold (§10) ──────────────────────────────────────────────────
//
// Unicode NFD (used by normalizeLocationName) decomposes a *precomposed base +
// combining mark* — but a Latin letter whose diacritic is a STROKE or BAR
// THROUGH the glyph (đ, Đ, ø, ł, …) has NO canonical decomposition: the stroke
// is part of the base codepoint, so NFD leaves it intact and the subsequent
// `[^a-z0-9\s]` strip then deletes it entirely. For Đà Nẵng (a launch city) that
// silently turns "Đà Nẵng" into "a nang", which never matches a typed "da nang".
// The client Phase-1 SDK hit and fixed this exact bug; this mirrors it
// server-side so the stored search key and the typed query fold identically.
//
// This is an EXPLICIT, additive fold applied BEFORE normalization so the base
// letter survives the punctuation strip. It never touches stored *display*
// spelling (`name`/`display_name`) — only the derived comparison key.
const STROKE_FOLD: Record<string, string> = {
  "đ": "d", "Đ": "d", // Latin small/capital d with stroke (Vietnamese, Croatian)
  "ø": "o", "Ø": "o", // o with stroke (Danish, Norwegian)
  "ł": "l", "Ł": "l", // l with stroke (Polish)
  "ħ": "h", "Ħ": "h", // h with stroke (Maltese)
  "ŧ": "t", "Ŧ": "t", // t with stroke (Sámi)
  "ð": "d", "Ð": "d", // eth (Icelandic) — folds to d for search
  "ı": "i", "İ": "i", // dotless i / dotted capital I (Turkish)
};
const STROKE_FOLD_RE = new RegExp(`[${Object.keys(STROKE_FOLD).join("")}]`, "g");

/**
 * Fold stroke/bar Latin letters (đ→d, Đ→d, ø→o, ł→l, …) to their base ASCII
 * letter. Pure, deterministic, and idempotent. Applied before NFD so the base
 * letter is preserved through diacritic stripping. Non-stroke input is returned
 * unchanged.
 */
export function strokeFold(s: string): string {
  if (!s) return s;
  return s.replace(STROKE_FOLD_RE, (ch) => STROKE_FOLD[ch] ?? ch);
}

/**
 * The canonical geographic SEARCH KEY for a name: stroke-fold then the existing
 * diacritic/case/punctuation normalization. Diacritic-insensitive and
 * case-insensitive while never mutating the stored display spelling.
 *
 *   searchKey("Đà Nẵng") === searchKey("da nang") === "da nang"
 *   searchKey("Ho Chi Minh City")                  === "ho chi minh"
 *
 * The `search_key` generated column (migration 2220) computes the identical
 * value in SQL, so the query side and the stored side always fold the same way.
 */
export function searchKey(name: string): string {
  return normalizeLocationName(strokeFold(name));
}

// ── Canonical city keys (shared with the intelligence graph) ─────────────────
//
// Known misspellings/variants observed in live rows that normalization alone
// cannot collapse. Keys and values are already-normalized names
// (post-normalizeLocationName). "cebu city"→"cebu" and "new york city"→
// "new york" are handled by the generic suffix strip; this map is only for
// true misspellings and abbreviations.
export const CITY_NAME_ALIASES: Record<string, string> = {
  "siargoa": "siargao",   // common misspelling of Siargao
  "nyc": "new york",
};

// ── City abbreviations / transliterations / misspellings (§10, §11) ───────────
//
// Maps an already-`searchKey`ed query form to the `searchKey` of the CANONICAL
// city it means, so free text resolves to a city ID (not merely a country).
// The audit flagged that "hcmc"/"saigon"/"danang" resolved to a COUNTRY at best;
// these entries resolve them to the canonical CITY row instead.
//
// Keys and values are POST-searchKey (lowercase, diacritic/stroke-folded, and —
// crucially — the generic "city" suffix is already stripped, so "Ho Chi Minh
// City" canonicalizes to "ho chi minh"). Never destructive: this only steers the
// LOOKUP KEY; stored display spelling is untouched (§10).
export const CITY_GEO_ALIASES: Record<string, string> = {
  // Ho Chi Minh City — abbreviation + historical/local name + spacing variants.
  "hcmc": "ho chi minh",
  "saigon": "ho chi minh",
  "sai gon": "ho chi minh",
  "hochiminh": "ho chi minh",
  // Đà Nẵng — closed-up spelling and its airport-adjacent shorthand.
  "danang": "da nang",
  // Phú Quốc — the canonical example misspelling ("phu qouc") + closed-up form.
  "phu qouc": "phu quoc",
  "phuquoc": "phu quoc",
  // Other launch-city shorthands.
  "ft lauderdale": "fort lauderdale",
  "krung thep": "bangkok",
};

/**
 * Resolve a raw query to its canonical geographic lookup key: `searchKey` it,
 * then apply the abbreviation/misspelling alias dictionary. Returns the folded
 * key the canonical registry is indexed by. Non-aliased input just returns its
 * own `searchKey`.
 */
export function resolveGeoAlias(rawOrKey: string): string {
  const key = searchKey(rawOrKey);
  return CITY_GEO_ALIASES[key] ?? CITY_NAME_ALIASES[key] ?? key;
}

// Junk/fragment strings seen in live city columns that must never become
// city nodes ("san" is a truncated "San ..." fragment, not a city).
const JUNK_CITY_NAMES = new Set([
  "san", "n a", "na", "none", "null", "unknown", "undefined", "test",
]);

/**
 * Canonical city key for grouping/aggregation: normalized name with known
 * misspellings collapsed and junk fragments rejected. Returns null when the
 * input is empty, junk, or too short to be a real city name.
 *
 * "Cebu City" / "cebu" -> "cebu"; "New York City" -> "new york";
 * "Siargoa" -> "siargao"; "san" -> null.
 */
export function canonicalCityKey(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const norm = normalizeLocationName(s);
  const key = CITY_NAME_ALIASES[norm] ?? norm;
  if (key.length < 2 || JUNK_CITY_NAMES.has(key)) return null;
  return key;
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

// ── Typeahead: canonical city/admin suggestions ───────────────────────────────
//
// Powers the global search bar's Cities group so location suggestions come
// from the normalized canonical registry (not raw profile text). Venue-class
// rows are excluded — venue typeahead belongs to /api/places/search.
// Prefix matches are listed ahead of contains matches; rows are deduped by
// normalized_name. Fail-soft: any error returns [].
export async function suggestCanonicalLocations(
  db: SupabaseClient,
  q: string,
  limit = 5,
): Promise<CanonicalRow[]> {
  const norm = normalizeLocationName(q);
  if (!norm || norm.length < 2) return [];
  try {
    const esc = norm.replace(/[%_]/g, "\\$&");
    const [prefix, contains] = await Promise.all([
      db.from(TABLE).select("*").ilike("normalized_name", `${esc}%`).limit(limit * 3),
      db.from(TABLE).select("*").ilike("normalized_name", `%${esc}%`).limit(limit * 3),
    ]);
    if (prefix.error && contains.error) return [];
    const rows = [
      ...((prefix.data ?? []) as CanonicalRow[]),
      ...((contains.data ?? []) as CanonicalRow[]),
    ];
    const seen = new Set<string>();
    const out: CanonicalRow[] = [];
    for (const r of rows) {
      // City-class rows only: admin rows (regions/countries) would be
      // mislabeled by callers that group these under "Cities" (countries
      // already surface via their own search type), and venues are handled
      // by the places search path.
      if (kindClass(r.kind) !== "city") continue;
      if (seen.has(r.normalized_name)) continue;
      seen.add(r.normalized_name);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

// ── Diacritic/stroke/alias-aware canonical city resolution (§10/§11/§12) ──────
//
// The strengthened city path behind the Global Input Intelligence gateway.
// Unlike suggestCanonicalLocations (which matches raw `normalized_name`), this:
//   - folds the query with `searchKey` (so "da nang" matches stored "Đà Nẵng"),
//   - applies the abbreviation/misspelling dictionary ("hcmc" → the HCMC city),
//   - queries the `search_key` generated column (migration 2220) AND, as a
//     graceful fallback for the pre-migration deploy window (or fixtures without
//     the column), the legacy `normalized_name` — whichever returns rows.
// Prefix matches lead contains matches; rows are deduped and city-class only.
// Fail-soft: any hard error returns [].
export async function suggestCanonicalLocationsFolded(
  db: SupabaseClient,
  q: string,
  limit = 5,
): Promise<CanonicalRow[]> {
  const key = resolveGeoAlias(q);
  if (!key || key.length < 2) return [];
  const escKey = key.replace(/[%_]/g, "\\$&");
  // Fallback pattern for the legacy column: the plain normalized form of the
  // *aliased* key (ASCII already, so identical to its own searchKey).
  const escNorm = key.replace(/[%_]/g, "\\$&");
  const fetch = limit * 3;
  try {
    const [skPrefix, skContains, nnPrefix, nnContains] = await Promise.all([
      db.from(TABLE).select("*").ilike("search_key", `${escKey}%`).limit(fetch),
      db.from(TABLE).select("*").ilike("search_key", `%${escKey}%`).limit(fetch),
      db.from(TABLE).select("*").ilike("normalized_name", `${escNorm}%`).limit(fetch),
      db.from(TABLE).select("*").ilike("normalized_name", `%${escNorm}%`).limit(fetch),
    ]);
    // Prefix rows first (both columns), then contains rows. A per-result error
    // (e.g. search_key missing pre-migration) is simply skipped — the other
    // column still yields matches.
    const prefixRows = [
      ...((skPrefix.data ?? []) as CanonicalRow[]),
      ...((nnPrefix.data ?? []) as CanonicalRow[]),
    ];
    const containsRows = [
      ...((skContains.data ?? []) as CanonicalRow[]),
      ...((nnContains.data ?? []) as CanonicalRow[]),
    ];
    const seenId = new Set<string>();
    const seenName = new Set<string>();
    const out: CanonicalRow[] = [];
    for (const r of [...prefixRows, ...containsRows]) {
      if (kindClass(r.kind) !== "city") continue;
      if (seenId.has(r.id)) continue;
      const nameKey = (r.search_key ?? r.normalized_name ?? "").toLowerCase();
      // Dedupe by normalized identity too, but keep same-name rows in DIFFERENT
      // countries (genuine ambiguity, e.g. Paris FR vs Paris TX) so the caller
      // can disambiguate them.
      const dedupeKey = `${nameKey}|${(r.country_code ?? r.country ?? "").toLowerCase()}`;
      if (seenName.has(dedupeKey)) continue;
      seenId.add(r.id);
      seenName.add(dedupeKey);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The folded search key actually stored for a canonical row: the generated
 * `search_key` column when present, else derived from the display name. Used to
 * decide exact-tier equality for disambiguation.
 */
export function rowSearchKey(row: CanonicalRow): string {
  return (row.search_key ?? searchKey(row.name)) || "";
}
