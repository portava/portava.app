/**
 * Intelligence Gathering — coverage input ASSEMBLY (IG-08 producer half).
 *
 * The reader that routes/intelCoverage.ts flagged as missing: it turns queried
 * intel rows into the per-(zone, claim-family) `CoverageInputs` that
 * lib/coverageScore.ts scores. PURE — no clock, no IO; the scheduler supplies
 * the rows and `nowMs`, this invents no data.
 *
 * Two design points that make the score meaningful:
 *  • DEMAND is measured from `saved_places` (a save is user intent about a place)
 *    — a signal INDEPENDENT of intel supply, so a zone people care about but that
 *    has no coverage yet still registers demand. saved_places.place_id keys the
 *    DISCOVERY id space (discovery_places.id), while intel subjects key the
 *    CANONICAL space (places.id); the two are bridged by
 *    discovery_places.canonical_location_id → places.id, so saves are translated
 *    to canonical subject ids (bridgeSaves) before attribution.
 *  • An entirely UNSOURCED cell gets topContributorShare = 1 (maximal
 *    concentration gap), never 0 — otherwise the score (a product of five
 *    factors) would zero out exactly the high-demand, zero-coverage gaps IG-08
 *    exists to surface.
 */
import { LIVE_ELIGIBLE_CLAIM_STATUSES } from "./intelContracts.js";
import { CLAIM_IMPORTANCE, type CoverageInputs } from "./coverageScore.js";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Default required-confidence band for a family (matches coverageScore's default). */
export const REQUIRED_CONFIDENCE = 0.65;

/** The tracked, importance-weighted families every present zone is scored against. */
export const PILOT_CLAIM_FAMILIES: readonly string[] = Object.keys(CLAIM_IMPORTANCE);

export interface ClaimRow {
  subject_id?: string | null;
  zone_id: string | null;
  claim_type: string;
  status: string;
  confidence: number | null;
  observed_at: string;
  expires_at: string | null;
}
export interface ObsRow {
  subject_id: string;
  zone_id: string | null;
  claim_type: string;
  actor_id: string | null;
  group_key: string | null;
  observed_at: string;
}
export interface SaveRow { place_id: string; saved_at: string; }

export interface AssembledCell extends CoverageInputs {
  zoneId: string | null;
  city: string;
}

/** '' and null collapse to the same zone key (the zoneless scope). */
export const zoneKey = (z: string | null | undefined): string => z ?? "";
const cellKey = (zone: string | null | undefined, family: string): string => `${zoneKey(zone)}|${family}`;

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k);
  if (arr) arr.push(v); else m.set(k, [v]);
}

/**
 * The freshest LIVE claim in a cell → its age-as-a-fraction-of-TTL and
 * confidence. Live = status is live-eligible AND not past expiry. Returns null
 * when the cell has no live claim (⇒ claimMissing).
 */
export function freshestLiveClaim(
  claims: readonly ClaimRow[],
  nowMs: number,
): { ageRatio: number; confidence: number } | null {
  let best: { ageRatio: number; confidence: number; observedMs: number } | null = null;
  for (const c of claims) {
    if (!LIVE_ELIGIBLE_CLAIM_STATUSES.includes(c.status as any)) continue;
    const obs = Date.parse(c.observed_at);
    if (!Number.isFinite(obs)) continue;
    const exp = c.expires_at ? Date.parse(c.expires_at) : NaN;
    if (Number.isFinite(exp) && exp <= nowMs) continue; // expired ⇒ not live
    const span = Number.isFinite(exp) ? Math.max(1, exp - obs) : NaN;
    const ageRatio = Number.isFinite(span) ? clamp01((nowMs - obs) / span) : 0;
    const confidence = typeof c.confidence === "number" ? c.confidence : 0;
    if (best === null || obs > best.observedMs) best = { ageRatio, confidence, observedMs: obs };
  }
  return best ? { ageRatio: best.ageRatio, confidence: best.confidence } : null;
}

/**
 * Largest single contributor's share of the cell's observations, grouping by
 * independent group where known (else actor). NO observations ⇒ 1: an unsourced
 * cell is maximally undiversified and must keep a real gap's score non-zero.
 */
export function topContributorShare(obs: readonly ObsRow[]): number {
  if (obs.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const o of obs) {
    const k = o.group_key ?? o.actor_id ?? "anon";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let max = 0;
  for (const n of counts.values()) if (n > max) max = n;
  return clamp01(max / obs.length);
}

/** subject (place) → the set of zones it has been observed / claimed in. */
export function subjectZoneMembership(
  observations: readonly Pick<ObsRow, "subject_id" | "zone_id">[],
  claims: readonly Pick<ClaimRow, "subject_id" | "zone_id">[],
): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (sid: string | null | undefined, z: string | null) => {
    if (!sid) return;
    const s = m.get(sid) ?? new Set<string>();
    s.add(zoneKey(z));
    m.set(sid, s);
  };
  for (const o of observations) add(o.subject_id, o.zone_id);
  for (const c of claims) add(c.subject_id ?? null, c.zone_id);
  return m;
}

/**
 * Translate raw saves (keyed by discovery_places.id) to canonical subject ids
 * (places.id) via the discovery→canonical bridge, dropping any save whose
 * discovery place has no canonical link. Returns SaveRow[] re-keyed so demandByZone
 * can attribute them against the intel subject membership.
 */
export function bridgeSaves(
  rawSaves: readonly SaveRow[],
  discoveryToCanonical: Map<string, string>,
): SaveRow[] {
  const out: SaveRow[] = [];
  for (const s of rawSaves) {
    const canonical = discoveryToCanonical.get(s.place_id);
    if (canonical) out.push({ place_id: canonical, saved_at: s.saved_at });
  }
  return out;
}

/** Demand per zone = saves (canonical-keyed) on places that are subjects in that zone. */
export function demandByZone(
  saves: readonly SaveRow[],
  membership: Map<string, Set<string>>,
): Map<string, number> {
  const d = new Map<string, number>();
  for (const s of saves) {
    const zones = membership.get(s.place_id);
    if (!zones) continue;
    for (const z of zones) d.set(z, (d.get(z) ?? 0) + 1);
  }
  return d;
}

/** Representative city per zone = the most common city among its subjects' places. */
export function cityByZone(
  membership: Map<string, Set<string>>,
  placeCity: Map<string, string | null>,
): Map<string, string> {
  const tally = new Map<string, Map<string, number>>();
  for (const [sid, zones] of membership) {
    const city = placeCity.get(sid);
    if (!city) continue;
    for (const z of zones) {
      const t = tally.get(z) ?? new Map<string, number>();
      t.set(city, (t.get(city) ?? 0) + 1);
      tally.set(z, t);
    }
  }
  const out = new Map<string, string>();
  for (const [z, t] of tally) {
    let best = "", bestN = -1;
    for (const [c, n] of t) if (n > bestN) { bestN = n; best = c; }
    out.set(z, best);
  }
  return out;
}

/**
 * Assemble one CoverageInputs cell per (present zone × tracked family). Zones are
 * the distinct zones seen in claims/observations; families default to the
 * importance-weighted pilot set so a family entirely MISSING from a zone still
 * produces a cell (the highest-value gap).
 */
export function buildCoverageCells(params: {
  zones: readonly (string | null)[];
  families?: readonly string[];
  claims: readonly ClaimRow[];
  observations: readonly ObsRow[];
  demand: Map<string, number>;
  city: Map<string, string>;
  nowMs: number;
}): AssembledCell[] {
  const families = params.families ?? PILOT_CLAIM_FAMILIES;

  const claimsByCell = new Map<string, ClaimRow[]>();
  for (const c of params.claims) push(claimsByCell, cellKey(c.zone_id, c.claim_type), c);
  const obsByCell = new Map<string, ObsRow[]>();
  for (const o of params.observations) push(obsByCell, cellKey(o.zone_id, o.claim_type), o);

  // Distinct zones, preserving the first-seen original value ('' vs a real id).
  const seen = new Map<string, string | null>();
  for (const z of params.zones) if (!seen.has(zoneKey(z))) seen.set(zoneKey(z), z ?? null);

  const cells: AssembledCell[] = [];
  for (const [zk, zoneId] of seen) {
    const demandEvents = params.demand.get(zk) ?? 0;
    const city = params.city.get(zk) ?? "";
    for (const family of families) {
      const ck = `${zk}|${family}`;
      const live = freshestLiveClaim(claimsByCell.get(ck) ?? [], params.nowMs);
      cells.push({
        claimFamily: family,
        zoneId,
        city,
        demandEvents,
        claimMissing: live === null,
        freshestAgeRatio: live ? live.ageRatio : undefined,
        currentConfidence: live ? live.confidence : 0,
        requiredConfidence: REQUIRED_CONFIDENCE,
        topContributorShare: topContributorShare(obsByCell.get(ck) ?? []),
      });
    }
  }
  return cells;
}
