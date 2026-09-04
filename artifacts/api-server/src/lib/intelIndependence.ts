/**
 * Independence clustering (IG unit I2 — spec §11 anti-manipulation, Table 30
 * "Venue brigading", AT-04 "three copied reports ⇒ one independence cluster; no
 * consensus inflation"). PURE: no DB, no clock other than the timestamps it is
 * handed.
 *
 * WHAT IT IS FOR. Confidence, the privacy group threshold and the §10 conflict
 * predicate all reward INDEPENDENT corroboration — distinct parties who saw the
 * same thing without coordinating. Counting raw actors instead lets a handful of
 * coordinated accounts manufacture "consensus": three copies of one report look
 * like three witnesses. §11 says the opposite — "One cluster contributes at most
 * one full source weight." This module collapses coordinated reports into ONE
 * cluster so they can only ever count once.
 *
 * UNITS, NOT ACTORS. The clustering runs over INDEPENDENCE UNITS: a non-null
 * group_key (a Trip Crew / party token, lib/intelGroupKey) is one unit; a solo
 * actor with no group_key is their own singleton unit. This preserves the prior
 * aggregator's group accounting exactly — distinctGroups counts group_key units,
 * a null group_key earns zero group credit, and maxGroupShare is actor-based over
 * the distinct-actor union so overlapping crews that share members cannot dilute
 * the dominant share. The detectors below can only ever MERGE units on top of
 * that, never split them.
 *
 * THE DETECTOR SIGNALS (spec §11: actor relationship, shared media, common
 * source, unusually synchronized behaviour). Each MERGES the units behind two
 * observations:
 *   1. SHARED EVIDENCE MEDIA — the same asset key or content hash attached to
 *      observations from different units. Two "different" witnesses posting the
 *      same photo are one source. Merges even across distinct group_keys.
 *   2. COMMON SOURCE — the same official feed / partner-API reference behind
 *      different units' observations (Table 30 "common-source clustering").
 *   3. UNUSUALLY SYNCHRONIZED BEHAVIOUR — different actors asserting the IDENTICAL
 *      value within a very short window (SYNC_WINDOW_SECONDS). Two strangers
 *      reporting the exact same state within seconds is coordination, not
 *      coincidence. This is the only soft heuristic, so the window is deliberately
 *      tight — honest reports minutes apart are never collapsed.
 *
 * WHAT IT DELIBERATELY DOES NOT USE. No device fingerprint and no payment
 * linkage — named in the spec's threat list but privacy-invasive identity joins
 * this module refuses to perform (owner privacy invariant). It clusters only on
 * artifacts already attached to the observation.
 *
 * DIRECTION OF ERROR. Merging only ever REDUCES the independent-group count and
 * RAISES the largest group's share — both STRICTER for publication and for the
 * consensus/Live label. It can suppress a real signal but can never inflate one.
 */

// ── Calibration (v1; §8 "thresholds launch in shadow mode") ──────────────────
/**
 * How close in time two IDENTICAL-value reports from different actors must be to
 * read as "unusually synchronized" (coordination, not coincidence). Deliberately
 * tight: independent people reporting the same state minutes apart are normal and
 * must stay distinct clusters, so this catches only near-simultaneous copies.
 */
export const SYNC_WINDOW_SECONDS = 30;

/** One observation, reduced to the fields clustering reads. */
export interface IndependenceObservation {
  actorId: string;
  /** Shared crew/party token; null/'' ⇒ this observation is its own solo unit. */
  groupKey: string | null;
  /** Stable key of the claim value (aggregator's stableValueKey) — for sync detection. */
  valueKey: string;
  /** Observation instant, ms since epoch. Non-finite ⇒ excluded from sync detection. */
  observedAtMs: number;
  /** Asset keys / content hashes of media evidence attached to this observation. */
  mediaRefs: readonly string[];
  /** Official-feed / partner-API references behind this observation (common source). */
  sourceRefs: readonly string[];
}

export interface IndependenceClustering {
  /** Verified-group clusters — the privacy gate's distinctGroups. */
  distinctGroups: number;
  /**
   * Largest verified-group cluster's distinct-actor count over the distinct-actor
   * union of ALL group_key observations, 0..1 (0 when there are no verified
   * groups). Matches the prior aggregator's actor-based share, over MERGED units.
   */
  maxGroupShare: number;
  /** Total distinct clusters (verified or solo). */
  clusterCount: number;
  /** Canonical cluster id for the unit an actor observed under (its group_key, or solo). */
  clusterForUnit(groupKey: string | null, actorId: string): string;
  /** True when that unit's cluster carries a verifiable group identity (a group_key). */
  attestedForUnit(groupKey: string | null, actorId: string): boolean;
}

/** The independence unit an observation belongs to: its group_key, or a solo token. */
function unitKeyOf(groupKey: string | null, actorId: string): string {
  return groupKey != null && groupKey !== "" ? `g:${groupKey}` : `s:${actorId}`;
}

/** Minimal union-find over string ids, with path compression. */
class UnionFind {
  private parent = new Map<string, string>();
  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Cluster observations by independence. Deterministic and order-independent:
 * canonical cluster ids are the lexicographically smallest member unit, so the
 * same observations always yield the same assignment regardless of input order.
 */
export function clusterByIndependence(
  observations: readonly IndependenceObservation[],
): IndependenceClustering {
  const uf = new UnionFind();
  const unitActors = new Map<string, Set<string>>(); // unitKey → actors seen under it
  const unitAttested = new Map<string, boolean>();

  for (const o of observations) {
    if (!o.actorId) continue;
    const unit = unitKeyOf(o.groupKey, o.actorId);
    uf.add(unit);
    let set = unitActors.get(unit);
    if (!set) { set = new Set(); unitActors.set(unit, set); }
    set.add(o.actorId);
    if (o.groupKey != null && o.groupKey !== "") unitAttested.set(unit, true);
    else if (!unitAttested.has(unit)) unitAttested.set(unit, false);
  }

  // (1) Shared media, (2) common source: units sharing a media/source ref merge.
  const refUnit = new Map<string, string>();
  const mergeByRef = (ns: string, ref: string, unit: string): void => {
    if (!ref) return;
    const key = `${ns}:${ref}`;
    const anchor = refUnit.get(key);
    if (anchor === undefined) refUnit.set(key, unit);
    else uf.union(anchor, unit);
  };
  for (const o of observations) {
    if (!o.actorId) continue;
    const unit = unitKeyOf(o.groupKey, o.actorId);
    for (const r of o.mediaRefs ?? []) mergeByRef("media", String(r), unit);
    for (const r of o.sourceRefs ?? []) mergeByRef("source", String(r), unit);
  }

  // (3) Unusually synchronized behaviour: within one value, DIFFERENT actors
  // reporting within SYNC_WINDOW of each other are coordinated. Sort each value's
  // observations by time and chain-union neighbouring units when the actors
  // differ, so a burst of near-simultaneous copies collapses together.
  const byValue = new Map<string, IndependenceObservation[]>();
  for (const o of observations) {
    if (!o.actorId || !Number.isFinite(o.observedAtMs)) continue;
    let list = byValue.get(o.valueKey);
    if (!list) { list = []; byValue.set(o.valueKey, list); }
    list.push(o);
  }
  const windowMs = SYNC_WINDOW_SECONDS * 1000;
  for (const list of byValue.values()) {
    list.sort((a, b) => a.observedAtMs - b.observedAtMs);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (cur.actorId !== prev.actorId && cur.observedAtMs - prev.observedAtMs <= windowMs) {
        uf.union(unitKeyOf(prev.groupKey, prev.actorId), unitKeyOf(cur.groupKey, cur.actorId));
      }
    }
  }

  // Canonicalise each cluster to its smallest member unit (stable ids).
  const clusterMembers = new Map<string, string[]>(); // root → member unitKeys
  for (const unit of unitActors.keys()) {
    const root = uf.find(unit);
    let list = clusterMembers.get(root);
    if (!list) { list = []; clusterMembers.set(root, list); }
    list.push(unit);
  }
  const canonicalOfRoot = new Map<string, string>();
  const clusterAttested = new Map<string, boolean>();
  const clusterGroupedActors = new Map<string, Set<string>>(); // canonical → distinct grouped actors
  for (const [root, units] of clusterMembers) {
    const canonical = units.reduce((m, u) => (u < m ? u : m), units[0]);
    canonicalOfRoot.set(root, canonical);
    let attested = false;
    const groupedActors = new Set<string>();
    for (const u of units) {
      if (unitAttested.get(u)) {
        attested = true;
        for (const a of unitActors.get(u) ?? []) groupedActors.add(a);
      }
    }
    clusterAttested.set(canonical, attested);
    clusterGroupedActors.set(canonical, groupedActors);
  }

  const canonicalOfUnit = (unit: string): string => canonicalOfRoot.get(uf.find(unit)) ?? unit;

  // distinctGroups + maxGroupShare over VERIFIED-GROUP clusters only, with the
  // denominator being the distinct-actor UNION across all group_key observations.
  const allGroupedActors = new Set<string>();
  let maxGroupActors = 0;
  let distinctGroups = 0;
  for (const [canonical, attested] of clusterAttested) {
    if (!attested) continue;
    distinctGroups++;
    const actors = clusterGroupedActors.get(canonical) ?? new Set();
    if (actors.size > maxGroupActors) maxGroupActors = actors.size;
    for (const a of actors) allGroupedActors.add(a);
  }
  const maxGroupShare = allGroupedActors.size > 0 ? maxGroupActors / allGroupedActors.size : 0;

  return {
    distinctGroups,
    maxGroupShare,
    clusterCount: clusterMembers.size,
    clusterForUnit: (groupKey, actorId) => canonicalOfUnit(unitKeyOf(groupKey, actorId)),
    attestedForUnit: (groupKey, actorId) =>
      clusterAttested.get(canonicalOfUnit(unitKeyOf(groupKey, actorId))) ?? false,
  };
}
