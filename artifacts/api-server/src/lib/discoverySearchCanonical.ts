/**
 * discoverySearchCanonical — Discovery's reader of the canonical registry's
 * STORED diacritic fold (census-discovery B01; census-input-intelligence G57's
 * stored side).
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * Migration 2220 gave `canonical_locations` a STORED generated column,
 * `search_key`, computed in SQL by `input_normalize_city_key(name)`: the stroke
 * letters NFD cannot decompose (đ, ø, ł, ħ, ŧ, ð, ı) are folded BEFORE the
 * diacritic strip, so "Łódź" is stored as `lodz` and "Thành phố Đà Nẵng" as
 * `thanh pho da nang`. The input gateway reads it
 * (`suggestCanonicalLocationsFolded`). Discovery's own two readers of the
 * registry did not:
 *
 *   • GET /discovery/suggest's Cities group matched `normalized_name`
 *     through `suggestCanonicalLocations`. That column is written by
 *     `normalizeLocationName`, which DELETES a stroke letter, so "Łódź" is
 *     stored as `odz` and a typed "lodz" can never reach it.
 *   • The centroid lookup that places a city or country result on the map
 *     keyed on `normalized_name` equality, so a profile that typed "Lodz"
 *     never met the registry's "Łódź".
 *
 * ── WHAT THIS MODULE DOES ───────────────────────────────────────────────────
 * Both readers now ask the stored fold first, and the query side folds with
 * `searchKey()` — the TypeScript mirror of the same SQL, which
 * src/test/canonicalSearchKeyProductionShape.test.ts pins to production's rows.
 * The display spelling is never touched: the fold is a KEY.
 *
 * ── THE DEGRADE, AND WHY IT IS NOT SILENT ───────────────────────────────────
 * Production has had 2220 since 2026-09-21 (integrator-read 2026-09-27: 31 of
 * 31 rows populated), so the degrade below is DEFENCE IN DEPTH for any
 * database without it — a restored backup, a fresh CI project, a harness
 * built short of 2220 — not production's state.
 *
 *   `search_key` ABSENT (42703 / PGRST204)
 *       The suggest reader falls back to the legacy `normalized_name` reader,
 *       which still matches every decomposable accent ("Zürich", "São Paulo")
 *       and misses only stroke letters. It never 500s, and it never lets the
 *       fallback pass for a whole answer: the rows carry a fold marker
 *       (`canonicalFoldOf`) and the route answers `coverage: "partial"` naming
 *       `canonical_locations.search_key`, so "the fold index could not be
 *       read" can never look like "no city matched".
 *   `canonical_locations` ABSENT (42P01 / PGRST205)
 *       [] — the permanent structural absence the legacy reader already treats
 *       as "no registry" (canonicalLocations.isMissingTable). Unchanged.
 *   ANY OTHER READ ERROR
 *       `CanonicalReadUnavailableError`, exactly as the legacy reader throws
 *       (owner ruling D11): the route's catch arm refuses rather than serving a
 *       silently halved pool.
 *
 * The centroid lookup is ENRICHMENT and never a gate (§27's position contract):
 * it runs the legacy equality first, exactly as before, and asks the stored
 * fold only for the names that equality could not place. An absent or
 * unreadable fold leaves those rows unplaced — a null position — which is the
 * answer they already had.
 */
import {
  CanonicalReadUnavailableError,
  kindClass,
  normalizeLocationName,
  searchKey,
  suggestCanonicalLocations,
  type CanonicalRow,
} from "./canonicalLocations.js";
import { isMissingColumnError, isMissingTableError } from "./capability/schemaCapability.js";
import { discoveryRefusal, sendDiscoveryRefusal } from "./discoveryRefusal.js";

/** The source a degraded answer names in `refusal.failedSources`. */
export const CANONICAL_FOLD_SOURCE = "canonical_locations.search_key";

/** Which key a canonical answer was matched through. */
export type CanonicalFold = "stored" | "legacy";

/**
 * The fold each returned array was matched through. A WeakMap keyed by the
 * array rather than a field on it: the route passes `CanonicalRow[]` straight
 * into `canonicalToCityResult`, and a marker property would ride along into
 * nothing but a marker field has no business on the wire.
 */
const FOLD_OF = new WeakMap<object, CanonicalFold>();

function marked(rows: CanonicalRow[], fold: CanonicalFold): CanonicalRow[] {
  FOLD_OF.set(rows, fold);
  return rows;
}

/** The fold `rows` were matched through, or null for an array this module did not produce. */
export function canonicalFoldOf(rows: unknown): CanonicalFold | null {
  return rows !== null && typeof rows === "object" ? FOLD_OF.get(rows as object) ?? null : null;
}

/** `[CANONICAL_FOLD_SOURCE]` when `rows` were matched through the legacy key, else `[]`. */
export function canonicalFoldFailures(rows: unknown): string[] {
  return canonicalFoldOf(rows) === "legacy" ? [CANONICAL_FOLD_SOURCE] : [];
}

/**
 * Send `body` as a PARTIAL refusal when its Cities group was matched through
 * the legacy key, and report whether it did. Used on the one exit of GET
 * /discovery/suggest that would otherwise answer a plain 200.
 *
 * `feature_disabled`, not `transient_db`: nothing is degraded and nothing will
 * recover by retrying — this database does not carry the stored fold. That is
 * the class this repository already gives an absent schema
 * (server/telegraph/commandRoute.ts, services/highlights/highlightControlWrites.ts).
 * `partial`, not `nothing`: every group in the body was really read and really
 * served; the absence the refusal names is "a city reachable only through a
 * stroke-letter fold", and `failedSources` says exactly which source that is.
 */
export function sendCanonicalFoldDegraded(res: any, body: object, rows: unknown): boolean {
  if (canonicalFoldOf(rows) !== "legacy") return false;
  sendDiscoveryRefusal(
    res,
    body,
    discoveryRefusal("feature_disabled", "canonical_fold_unavailable", "GET /discovery/suggest", "partial", [CANONICAL_FOLD_SOURCE]),
  );
  return true;
}

/**
 * GET /discovery/suggest's Cities reader: city-class canonical rows whose
 * STORED fold matches the query's fold, prefix matches first, deduped by fold.
 *
 * Same shape and limits as `suggestCanonicalLocations` (limit * 3 per read,
 * city-class only, prefix before contains), so the only thing that changes for
 * a caller is which key is compared.
 */
export async function readCanonicalCitySuggestions(
  sc: any,
  q: string,
  limit = 5,
): Promise<CanonicalRow[]> {
  const key = searchKey(q);
  if (!key || key.length < 2) return marked([], "stored");
  const esc = key.replace(/[%_]/g, "\\$&");

  let prefix: { data: unknown; error: unknown };
  let contains: { data: unknown; error: unknown };
  try {
    [prefix, contains] = await Promise.all([
      sc.from("canonical_locations").select("*").ilike("search_key", `${esc}%`).limit(limit * 3),
      sc.from("canonical_locations").select("*").ilike("search_key", `%${esc}%`).limit(limit * 3),
    ]);
  } catch (e) {
    // A rejected read is a failed read — never a no-match.
    throw new CanonicalReadUnavailableError("search_key", e);
  }

  const errs = [prefix.error, contains.error].filter((e) => e != null);
  if (errs.length > 0) {
    if (errs.every((e) => isMissingTableError(e))) return marked([], "stored");
    if (errs.every((e) => isMissingColumnError(e))) {
      // 2220 absent. The legacy reader keeps its own D11 contract: a read
      // error there throws, a missing table is [].
      const legacy = await suggestCanonicalLocations(sc, q, limit);
      return marked([...legacy], "legacy");
    }
    throw new CanonicalReadUnavailableError(prefix.error ? "search_key prefix" : "search_key contains", errs[0]);
  }

  const rows = [
    ...(Array.isArray(prefix.data) ? (prefix.data as CanonicalRow[]) : []),
    ...(Array.isArray(contains.data) ? (contains.data as CanonicalRow[]) : []),
  ];
  const seen = new Set<string>();
  const out: CanonicalRow[] = [];
  for (const r of rows) {
    if (!r || kindClass(r.kind) !== "city") continue;
    const fold = typeof r.search_key === "string" && r.search_key !== "" ? r.search_key : searchKey(r.name ?? "");
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(r);
    if (out.length >= limit) break;
  }
  return marked(out, "stored");
}

/** A registry centroid, as the search route attaches it. */
export interface CanonicalCentroid {
  id: string;
  lat: number;
  lng: number;
}

function finiteCoord(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Widen a legacy centroid lookup (keyed by `normalizeLocationName`) with the
 * stored fold, and re-key the result by the caller's own spelling.
 *
 * `legacyByNormalized` is what the route's existing `normalized_name` lookup
 * returned, and it WINS for every name it placed: nothing that was placed
 * before this module existed moves. Only names it could not place are asked of
 * `search_key`, in one batched read. Any failure of that read — the column
 * absent, a timeout, a throw — leaves those names unplaced, which is what they
 * already were: enrichment is never a gate.
 */
export async function withStoredFoldCentroids(
  sc: any,
  names: readonly string[],
  kinds: readonly string[],
  legacyByNormalized: ReadonlyMap<string, CanonicalCentroid>,
): Promise<Map<string, CanonicalCentroid>> {
  const out = new Map<string, CanonicalCentroid>();
  const unplaced = new Map<string, string[]>(); // fold -> the names that fold to it
  for (const name of names) {
    if (out.has(name)) continue;
    const legacy = legacyByNormalized.get(normalizeLocationName(name));
    if (legacy) {
      out.set(name, legacy);
      continue;
    }
    const fold = searchKey(name);
    if (fold.length === 0) continue;
    const list = unplaced.get(fold) ?? [];
    list.push(name);
    unplaced.set(fold, list);
  }
  if (unplaced.size === 0) return out;

  const folds = [...unplaced.keys()];
  try {
    const { data, error } = await sc
      .from("canonical_locations")
      .select("id, kind, search_key, lat, lng")
      .in("search_key", folds)
      .in("kind", kinds as string[])
      .limit(folds.length * 4);
    if (error || !Array.isArray(data)) return out;
    const byFold = new Map<string, CanonicalCentroid>();
    for (const r of data as any[]) {
      const fold = typeof r?.search_key === "string" ? r.search_key : null;
      if (fold === null || byFold.has(fold)) continue;
      const lat = finiteCoord(r.lat);
      const lng = finiteCoord(r.lng);
      // Never half a pin: a registry row without both coordinates places nothing.
      if (lat === null || lng === null) continue;
      byFold.set(fold, { id: String(r.id), lat, lng });
    }
    for (const [fold, list] of unplaced) {
      const hit = byFold.get(fold);
      if (!hit) continue;
      for (const name of list) out.set(name, hit);
    }
  } catch {
    // Enrichment is never a gate — an unreachable fold means unplaced rows.
  }
  return out;
}
