/**
 * discoverySearchProtection — the search adapter over lib/protectedLocations
 * (census-discovery B04; census-input-intelligence G190's Discovery leg; Map
 * spec §24, "Suppress sensitive locations before data reaches the client").
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * `GET /discovery/search` and `GET /discovery/suggest` put a position on the
 * wire for places, activities, saved places, events whose venue this viewer may
 * see, hidden gems (the approximate pair) and city/country centroids — §27's
 * placement contract, `metadata.lat` / `metadata.lng`. The one protected-place
 * gate the repository has, `lib/protectedLocations.ts`, was consulted by none
 * of it, so a place standing inside a registered shelter or residence zone was
 * served at full precision by search while the Map withheld it.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * It does not re-decide any of §24. `lib/protectedLocations.ts` is shared and
 * its semantics are untouched: every row with a position becomes a one-object
 * probe and is handed to the SAME `applyProtection` the Map calls, and the
 * answer is read back. The zones come from the ONE reader of
 * `protected_zones`, `lib/protectedZoneStore` — its 30-second cache and both of
 * its fail-closed rules are inherited, not restated.
 *
 * ── THE THREE CASES, WITH THE FLAG ON ───────────────────────────────────────
 *   ZONES READ, NONE REGISTERED ([])   — an identity pass by construction: the
 *       same array reference comes back, so the body is byte-identical to the
 *       flag being off. With no zones every position is trivially outside
 *       every zone, so the contract's "cannot prove it is outside" arm cannot
 *       arise. This is production's state (2217 applied, 0 rows).
 *   ZONES READ, SOME REGISTERED        — per row with a position:
 *       allow    → the row, untouched (same object);
 *       coarsen  → the position is snapped to the zone's anchor by
 *                  `coarsenForZone` and marked `coordsPrecision: "approximate"`;
 *       suppress → the row is not served.
 *       That includes the contract's own fail-closed arms: a zone whose
 *       geometry cannot be parsed covers "unknown", which suppresses every
 *       positioned row, because the zone store keeps a malformed ring in the
 *       list on purpose (its rule 2).
 *   ZONES UNREADABLE (null — table absent, read error, throw) — the store's
 *       rule 1: an unreadable policy is not an absent one. Every row that
 *       carries a position has it WITHHELD (null, `coordsPrecision: "hidden"`,
 *       §27's own "no position this viewer may have"). Rows are kept. The
 *       protected field is the position, and a search that answers nothing
 *       because a policy table blinked would be an outage wearing a privacy
 *       badge. An unreadable read is never cached (the store's rule), so the
 *       next request re-reads.
 *
 * Rows that carry no position — travelers, hashtags, posts, a city the
 * registry could not place, an event whose venue this viewer may not see —
 * disclose no position and are passed through untouched.
 *
 * ── WHY COUNTS DO NOT GO ON THE WIRE ────────────────────────────────────────
 * The Map ships `ProtectionReport` beside a viewport the client chose. A search
 * is bounded by a QUERY the client typed, and "1 suppressed" under the query
 * "shelter" confirms that a place by that name exists — a disclosure the Map's
 * viewport argument does not cover. The report is logged server-side only.
 *
 * ── THE FLAG ────────────────────────────────────────────────────────────────
 * `discovery_search_protected_zones_enabled` (migration 3366, seeded FALSE).
 * Read through `isFlagEnabled` — CAPABILITY polarity, as the buddy launch gate
 * two hundred lines into routes/discoverySearch.ts is — and cached 30 s. OFF,
 * absent or unreadable: the input array itself is returned and nothing is
 * read, so every served body is byte-identical to the tree before this file.
 * The flip is the owner's.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { logger as rootLogger } from "./logger.js";
import type { MapObject, MapObjectKind, PrivacyClass } from "./mapObjects.js";
import { applyProtection, type ProtectedZone, type ProtectionReport } from "./protectedLocations.js";
import { loadActiveProtectedZones } from "./protectedZoneStore.js";

const logger = rootLogger.child({ lib: "discoverySearchProtection" });

/** Literal name so check-flag-polarity resolves the read. */
export const DISCOVERY_SEARCH_PROTECTION_FLAG = "discovery_search_protected_zones_enabled";

/** The fields of a search row this adapter reads or rewrites. Structural, so the route's type is not imported. */
export interface ProtectableSearchRow {
  id: string;
  type: string;
  title: string;
  metadata: Record<string, unknown> | null;
}

/** What the pass did. Server-side only — see "WHY COUNTS DO NOT GO ON THE WIRE". */
export interface SearchProtectionReport extends ProtectionReport {
  /** Rows whose position was withheld because the policy could not be read. */
  withheld: number;
  /** Rows passed through because they carry no position. */
  unpositioned: number;
  /** "read" when zones were read (even zero of them), "unreadable" otherwise. */
  policy: "read" | "unreadable";
}

export interface SearchProtectionOutcome<T> {
  results: T[];
  report: SearchProtectionReport;
}

/**
 * The map kind a search row's position is, for the §24 question ONLY.
 *
 * None of these is in `AMBIENT_PRESENCE_KINDS`, `COARSEN_UNSAFE_KINDS` or
 * `PROTECTION_EXEMPT_KINDS`, so each takes its zone's category action as
 * written. A city or country centroid is a registry point with no person
 * attached, which is `place` in the Map's vocabulary; the saved heading is the
 * viewer's own save, which the Map draws as `saved_place` and gates the same way.
 */
export function mapKindForSearchType(type: string): MapObjectKind {
  switch (type) {
    case "events": return "event";
    case "hidden_gems": return "hidden_gem";
    case "saved": return "saved_place";
    default: return "place";
  }
}

/**
 * The precision the row's wire position already has. A gem's pair is the
 * approximate centroid (`gemSearchPosition`); everything else is a venue- or
 * registry-level point.
 */
function privacyClassOf(row: ProtectableSearchRow): PrivacyClass {
  return row.type === "hidden_gems" || row.metadata?.coordsPrecision === "approximate" ? "approximate" : "place_level";
}

/** The wire position, when BOTH halves are present. Null means the row discloses no position. */
function wirePosition(row: ProtectableSearchRow): { lat: unknown; lng: unknown } | null {
  const m = row.metadata;
  if (!m || typeof m !== "object") return null;
  if (!("lat" in m) || !("lng" in m)) return null;
  if (m.lat === null || m.lat === undefined || m.lng === null || m.lng === undefined) return null;
  return { lat: m.lat, lng: m.lng };
}

function withPosition<T extends ProtectableSearchRow>(
  row: T,
  lat: number | null,
  lng: number | null,
  precision: "approximate" | "hidden",
): T {
  return { ...row, metadata: { ...(row.metadata ?? {}), lat, lng, coordsPrecision: precision } };
}

function emptyReport(policy: "read" | "unreadable"): SearchProtectionReport {
  return { evaluated: 0, allowed: 0, coarsened: 0, suppressed: 0, safetyExempt: 0, withheld: 0, unpositioned: 0, policy };
}

/**
 * The pass itself. PURE: no I/O, no clock, and the input is never mutated.
 *
 * `zones`:
 *   []      the policy was read and registers nothing — returns `rows` itself;
 *   null    the policy could not be read — positions withheld, rows kept;
 *   [z, …]  each positioned row is decided by `applyProtection`.
 */
export function applySearchProtection<T extends ProtectableSearchRow>(
  rows: T[],
  zones: readonly ProtectedZone[] | null,
): SearchProtectionOutcome<T> {
  if (Array.isArray(zones) && zones.length === 0) {
    return { results: rows, report: { ...emptyReport("read"), unpositioned: rows.length } };
  }
  const report = emptyReport(zones === null ? "unreadable" : "read");
  const out: T[] = [];
  for (const row of rows) {
    const pos = wirePosition(row);
    if (pos === null) {
      report.unpositioned += 1;
      out.push(row);
      continue;
    }
    if (zones === null) {
      report.withheld += 1;
      out.push(withPosition(row, null, null, "hidden"));
      continue;
    }

    // The probe: the row's wire position as a Point, in the Map's own shape.
    // A non-numeric pair is handed over as it is — `geometryPositions` refuses
    // it, and the contract suppresses what it cannot place.
    const probe: MapObject = {
      id: row.id,
      kind: mapKindForSearchType(row.type),
      geometry: { type: "Point", coordinates: [pos.lng as number, pos.lat as number] },
      title: row.title && row.title.trim() !== "" ? row.title : row.id,
      privacyClass: privacyClassOf(row),
      renderingPriority: 0,
    };
    const outcome = applyProtection([probe], zones);
    report.evaluated += outcome.report.evaluated;
    report.allowed += outcome.report.allowed;
    report.coarsened += outcome.report.coarsened;
    report.suppressed += outcome.report.suppressed;
    report.safetyExempt += outcome.report.safetyExempt;

    const decided = outcome.objects[0];
    if (!decided) continue;            // suppressed: the row is not served
    if (decided === probe) {           // allowed: the row, untouched
      out.push(row);
      continue;
    }
    // Coarsened: the only thing read back is the snapped point.
    const coords = decided.geometry?.type === "Point" ? decided.geometry.coordinates : null;
    const lng = Array.isArray(coords) && Number.isFinite(coords[0]) ? coords[0] : null;
    const lat = Array.isArray(coords) && Number.isFinite(coords[1]) ? coords[1] : null;
    if (lat === null || lng === null) {
      // Coarsened to nothing placeable: the defence-in-depth answer is the
      // stricter one, never the original point.
      report.coarsened -= 1;
      report.suppressed += 1;
      continue;
    }
    out.push(withPosition(row, lat, lng, "approximate"));
  }
  return { results: out, report };
}

// ── The flag (cached 30 s, mirrors the buddy launch gate) ────────────────────

const FLAG_TTL_MS = 30_000;
let _flagCache: { value: boolean; at: number } | null = null;

/** Invalidate the flag cache. Exported for tests. */
export function invalidateSearchProtectionFlagCache(): void {
  _flagCache = null;
}

/** True when the owner has turned the search pass on. False on absent or unreadable. */
export async function searchProtectionEnabled(sc: any): Promise<boolean> {
  if (_flagCache && Date.now() - _flagCache.at < FLAG_TTL_MS) return _flagCache.value;
  const value = await isFlagEnabled(sc, DISCOVERY_SEARCH_PROTECTION_FLAG);
  _flagCache = { value, at: Date.now() };
  return value;
}

/**
 * The flag and the policy, read ONCE per serve. `null` when the pass is off —
 * the flag false, absent or unreadable — and nothing else is read. `zones` is
 * null when the policy could not be read: a throw anywhere in the load is the
 * unreadable case, never a 500.
 */
async function resolvePolicy(sc: any): Promise<{ zones: ProtectedZone[] | null } | null> {
  if (!(await searchProtectionEnabled(sc))) return null;
  try {
    return { zones: await loadActiveProtectedZones(sc) };
  } catch {
    return { zones: null };
  }
}

function logIfChanged(report: SearchProtectionReport, route: string): void {
  if (report.policy === "unreadable" || report.suppressed > 0 || report.coarsened > 0) {
    logger.warn({ route, report }, "discovery search: §24 protection pass changed what was served");
  }
}

/**
 * The one call a serve point makes, as the LAST gate before serialization —
 * after ranking, after pagination (protectedLocations' own placement rule).
 * Flag OFF ⇒ `rows` itself, nothing read.
 */
export async function protectSearchResults<T extends ProtectableSearchRow>(sc: any, rows: T[], route = "GET /discovery/search"): Promise<T[]> { // §80: the gateway names itself in the log
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const policy = await resolvePolicy(sc);
  if (policy === null) return rows;
  const { results, report } = applySearchProtection(rows, policy.zones);
  logIfChanged(report, route);
  return results;
}

/** `protectSearchResults` over a page object's `results`, keeping every other field. */
export async function protectSearchPage<P extends { results: ProtectableSearchRow[] }>(sc: any, page: P, route = "GET /discovery/search"): Promise<P> {
  const results = await protectSearchResults(sc, page.results, route);
  return results === page.results ? page : { ...page, results };
}

/**
 * The same pass over suggest groups, with the policy read once for all of
 * them. A group the pass empties is not served — an empty group is never a
 * group — and the survivors keep their order. Flag OFF ⇒ `groups` itself.
 */
export async function protectSuggestGroups<G extends { items: ProtectableSearchRow[] }>(sc: any, groups: G[]): Promise<G[]> {
  if (!Array.isArray(groups) || groups.length === 0) return groups;
  const policy = await resolvePolicy(sc);
  if (policy === null) return groups;
  const total: SearchProtectionReport = emptyReport(policy.zones === null ? "unreadable" : "read");
  const out: G[] = [];
  let changed = false;
  for (const g of groups) {
    const { results, report } = applySearchProtection(g.items, policy.zones);
    for (const k of ["evaluated", "allowed", "coarsened", "suppressed", "safetyExempt", "withheld", "unpositioned"] as const) {
      total[k] += report[k];
    }
    if (results === g.items) { out.push(g); continue; }
    changed = true;
    if (results.length > 0) out.push({ ...g, items: results });
  }
  logIfChanged(total, "GET /discovery/suggest");
  return changed ? out : groups;
}
