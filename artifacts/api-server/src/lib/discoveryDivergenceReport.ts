/**
 * Stage-3 reader — divergence + cost over `discovery_shadow_serves`.
 *
 * Shadow mode (Stage 2) records, for every cache-A serve to an in-cohort user,
 * BOTH the legacy page the user actually received and the page PDE WOULD have
 * served, plus the precomputed comparison (overlap / displacement / top-changed)
 * and both timings. This module aggregates those rows into the answer the packet
 * says must precede flipping `pde`: how differently would PDE order discovery,
 * and at what cost.
 *
 * Two segregations are load-bearing and are NEVER summed away:
 *
 *   - by SERVE-POINT CLASS. Divergence on the cache-A points (1/2/3), where
 *     legacy ran NO ranker, means "PDE reached traffic legacy never ranked at
 *     all". Divergence on serve point 6 (cold fetch), where legacy DID rank,
 *     means "the two rankers disagree". Those are different findings; the shadow
 *     table's own comment (2092) forbids summing them.
 *   - by SORT_BY. A reorder measured over sort=popular is not comparable to one
 *     over the default sort; pooling them understates divergence
 *     (discoveryShadow.ts warns of exactly this).
 *
 * A third split, by COHORT_REASON, keeps internal-account rows (which prove the
 * harness) distinct from percent-cohort rows (which measure real divergence).
 *
 * Pure functions only — no DB, no clock. The CLI (scripts/reportDiscoveryDivergence.ts)
 * supplies the rows and prints the result.
 */

/** One row of discovery_shadow_serves, projected to the columns this report reads. */
export interface ShadowServeRow {
  serve_point: number;
  sort_by: string | null;
  cohort_reason: string | null;
  page_size: number;
  legacy_total: number;
  pde_total: number;
  overlap_count: number;    // ids present in both served pages
  displaced_count: number;  // shared ids that changed position
  top_changed: boolean;     // did position 0 change
  legacy_ms: number | null;
  pde_ms: number | null;
  pde_suppressed_writes: number;
  /**
   * `12` Phase 9's remaining axes, computed at write time and stored inside the
   * existing `pde_stages` jsonb (lib/discoveryShadow.ts). ABSENT on rows written
   * before that existed, and on rows whose caller passed ids only — those are
   * reported as unknown, never as zero.
   */
  pde_stages?: { phase9?: ShadowPhase9Blob | null } | null;
}

/** The shape `lib/discoveryShadow.ts` writes under `pde_stages.phase9`. */
export interface ShadowPhase9Blob {
  legacy: ShadowPageDimensionsBlob;
  pde: ShadowPageDimensionsBlob;
  creatorConcentration: ShadowCreatorConcentrationBlob | null;
  estimatedTravelIntent: ShadowTravelIntentBlob | null;
  unmeasured: readonly string[];
}

export interface ShadowPageDimensionsBlob {
  n: number;
  categoryDistinct: number;
  categoryEntropy: number;
  placeDistinct: number;
  neighborhoodDistinct: number;
  geoCellDistinct: number;
  meanSavedCount: number | null;
  savedCountCoverage: number;
}

export type ServePointClass = "cache_a" | "cold_rank" | "other";

/**
 * Cache-A serve points (1/2/3) ran NO ranker on the legacy side; serve point 6
 * (cold fetch) DID. These must never be pooled — see the module header.
 */
export function classifyServePoint(sp: number): ServePointClass {
  if (sp === 1 || sp === 2 || sp === 3) return "cache_a";
  if (sp === 6) return "cold_rank";
  return "other";
}

export interface DivergenceGroup {
  servePointClass: ServePointClass;
  sortBy: string;        // "default" when null
  cohortReason: string;  // "unknown" when null
  n: number;
  /** Fraction of serves where PDE would have changed position 0. */
  topChangedRate: number;
  /** Mean shared-and-moved ids per page. */
  meanDisplaced: number;
  /** Mean ids PDE would add/drop from the page (page_size − overlap). */
  meanMembershipChange: number;
  /** Fraction of served items that stayed in place: overlap / page_size. */
  meanOverlapRate: number;
  legacyMsP50: number | null;
  legacyMsP95: number | null;
  pdeMsP50: number | null;
  pdeMsP95: number | null;
  meanSuppressedWrites: number;
  /**
   * `12` Phase 9 axes, aggregated over the rows in this group THAT CARRY THEM.
   * `null` when no row in the group does — a group of rows written before the
   * dimensions existed reports unknown, not a diversity of zero.
   */
  phase9: Phase9Aggregate | null;
}

export interface Phase9Aggregate {
  /** Rows in this group that actually carried Phase 9 dimensions. */
  n: number;
  /** Mean distinct content categories per page — Phase 9 "diversity". */
  meanCategoryDistinctLegacy: number;
  meanCategoryDistinctPde: number;
  /** Mean normalized category entropy per page — the shape a distinct COUNT cannot see. */
  meanCategoryEntropyLegacy: number;
  meanCategoryEntropyPde: number;
  /** Phase 9 "place diversity", on both of its axes. */
  meanNeighborhoodDistinctLegacy: number;
  meanNeighborhoodDistinctPde: number;
  meanGeoCellDistinctLegacy: number;
  meanGeoCellDistinctPde: number;
  /** Phase 9 "save rate potential" — mean of the per-page means, over pages that had one. */
  meanSavedCountLegacy: number | null;
  meanSavedCountPde: number | null;
  /** Mean fraction of items whose save count was known. Travels with the means, always. */
  meanSavedCoverageLegacy: number;
  meanSavedCoveragePde: number;
  /** The Phase 9 axes this surface cannot measure, by name. Never summarised away. */
  unmeasured: readonly string[];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Nearest-rank percentile (p in [0,1]); null for an empty set. */
export function percentile(xs: readonly number[], p: number): number | null {
  const vals = xs.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const rank = Math.ceil(p * vals.length);
  const idx = Math.min(vals.length - 1, Math.max(0, rank - 1));
  return vals[idx];
}

function groupKey(r: ShadowServeRow): string {
  return `${classifyServePoint(r.serve_point)}|${r.sort_by ?? "default"}|${r.cohort_reason ?? "unknown"}`;
}

/**
 * Aggregate the Phase 9 dimensions over the rows in one group THAT CARRY THEM.
 *
 * Rows without a `phase9` blob are EXCLUDED from the mean rather than counted
 * as zero, and the count of rows that did carry one is reported — a mean over
 * three of four hundred rows is a different fact from a mean over four hundred,
 * and reporting only the mean makes them look identical.
 */
export function aggregatePhase9(rows: readonly ShadowServeRow[]): Phase9Aggregate | null {
  const blobs = rows
    .map((r) => r.pde_stages?.phase9)
    .filter((b): b is ShadowPhase9Blob => !!b && !!b.legacy && !!b.pde);
  if (blobs.length === 0) return null;

  const meanOfKnown = (xs: Array<number | null>): number | null => {
    const known = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    return known.length === 0 ? null : mean(known);
  };

  return {
    n: blobs.length,
    meanCategoryDistinctLegacy: mean(blobs.map((b) => b.legacy.categoryDistinct)),
    meanCategoryDistinctPde:    mean(blobs.map((b) => b.pde.categoryDistinct)),
    meanCategoryEntropyLegacy:  mean(blobs.map((b) => b.legacy.categoryEntropy)),
    meanCategoryEntropyPde:     mean(blobs.map((b) => b.pde.categoryEntropy)),
    meanNeighborhoodDistinctLegacy: mean(blobs.map((b) => b.legacy.neighborhoodDistinct)),
    meanNeighborhoodDistinctPde:    mean(blobs.map((b) => b.pde.neighborhoodDistinct)),
    meanGeoCellDistinctLegacy:  mean(blobs.map((b) => b.legacy.geoCellDistinct)),
    meanGeoCellDistinctPde:     mean(blobs.map((b) => b.pde.geoCellDistinct)),
    meanSavedCountLegacy: meanOfKnown(blobs.map((b) => b.legacy.meanSavedCount)),
    meanSavedCountPde:    meanOfKnown(blobs.map((b) => b.pde.meanSavedCount)),
    meanSavedCoverageLegacy: mean(blobs.map((b) => b.legacy.savedCountCoverage)),
    meanSavedCoveragePde:    mean(blobs.map((b) => b.pde.savedCountCoverage)),
    // Taken from the rows themselves rather than re-declared here, so the
    // report can never claim to have measured an axis the writer did not.
    unmeasured: blobs[0].unmeasured ?? [], creatorConcentration: aggregateCreatorConcentration(blobs), travelIntent: aggregateTravelIntent(blobs),
  };
}

/**
 * Aggregate shadow rows into per-(serve-point-class, sort_by, cohort_reason)
 * divergence + cost groups. Groups are ordered cache_a → cold_rank → other, then
 * by sort_by, then cohort_reason, so a reader can never accidentally read a
 * cache-A number as a ranker-vs-ranker number.
 */
export function aggregateDivergence(rows: readonly ShadowServeRow[]): DivergenceGroup[] {
  const buckets = new Map<string, ShadowServeRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }

  const groups: DivergenceGroup[] = [];
  for (const [, rs] of buckets) {
    const first = rs[0];
    const legacyMs = rs.map((r) => r.legacy_ms).filter((x): x is number => x != null);
    const pdeMs = rs.map((r) => r.pde_ms).filter((x): x is number => x != null);
    const overlapRates = rs.map((r) => (r.page_size > 0 ? r.overlap_count / r.page_size : 0));
    const membershipChange = rs.map((r) => Math.max(0, r.page_size - r.overlap_count));
    groups.push({
      servePointClass: classifyServePoint(first.serve_point),
      sortBy: first.sort_by ?? "default",
      cohortReason: first.cohort_reason ?? "unknown",
      n: rs.length,
      topChangedRate: mean(rs.map((r) => (r.top_changed ? 1 : 0))),
      meanDisplaced: mean(rs.map((r) => r.displaced_count)),
      meanMembershipChange: mean(membershipChange),
      meanOverlapRate: mean(overlapRates),
      legacyMsP50: percentile(legacyMs, 0.5),
      legacyMsP95: percentile(legacyMs, 0.95),
      pdeMsP50: percentile(pdeMs, 0.5),
      pdeMsP95: percentile(pdeMs, 0.95),
      meanSuppressedWrites: mean(rs.map((r) => r.pde_suppressed_writes)),
      phase9: aggregatePhase9(rs),
    });
  }

  const classOrder: Record<ServePointClass, number> = { cache_a: 0, cold_rank: 1, other: 2 };
  groups.sort((a, b) =>
    classOrder[a.servePointClass] - classOrder[b.servePointClass] ||
    a.sortBy.localeCompare(b.sortBy) ||
    a.cohortReason.localeCompare(b.cohortReason),
  );
  return groups;
}

/** Render a group as aligned report lines (no I/O). */
export function formatGroup(g: DivergenceGroup): string[] {
  const pctOf = (x: number) => `${(x * 100).toFixed(1)}%`;
  const ms = (x: number | null) => (x == null ? "—" : `${x}ms`);
  return [
    `  [${g.servePointClass}] sort=${g.sortBy} cohort=${g.cohortReason}  (n=${g.n})`,
    `     top-1 changed ... ${pctOf(g.topChangedRate)}`,
    `     displaced/page .. ${g.meanDisplaced.toFixed(2)}   membership Δ/page .. ${g.meanMembershipChange.toFixed(2)}   overlap .. ${pctOf(g.meanOverlapRate)}`,
    `     cost pde p50/p95  ${ms(g.pdeMsP50)} / ${ms(g.pdeMsP95)}   legacy p50/p95 ${ms(g.legacyMsP50)} / ${ms(g.legacyMsP95)}   suppressed writes/serve ${g.meanSuppressedWrites.toFixed(1)}`,
    ...formatPhase9(g.phase9),
  ];
}

/** `12` Phase 9 lines. Absent dimensions print as "not recorded", never as zeros. */
export function formatPhase9(p: Phase9Aggregate | null): string[] {
  if (!p) {
    return ["     phase 9 dims ... not recorded on any row in this group"];
  }
  const n2 = (x: number) => x.toFixed(2);
  const nOrDash = (x: number | null) => (x == null ? "—" : x.toFixed(1));
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  return [
    `     phase 9 (n=${p.n} of the rows above)`,
    `       diversity      cats/page legacy ${n2(p.meanCategoryDistinctLegacy)} → pde ${n2(p.meanCategoryDistinctPde)}   entropy ${n2(p.meanCategoryEntropyLegacy)} → ${n2(p.meanCategoryEntropyPde)}`,
    `       place div.     hoods/page ${n2(p.meanNeighborhoodDistinctLegacy)} → ${n2(p.meanNeighborhoodDistinctPde)}   geo cells ${n2(p.meanGeoCellDistinctLegacy)} → ${n2(p.meanGeoCellDistinctPde)}`,
    `       save potential mean saves/item ${nOrDash(p.meanSavedCountLegacy)} → ${nOrDash(p.meanSavedCountPde)}   (coverage ${pct(p.meanSavedCoverageLegacy)} → ${pct(p.meanSavedCoveragePde)})`,
    ...formatCreatorConcentration(p.creatorConcentration),
    ...formatTravelIntent(p.travelIntent),
    `       NOT measured   ${p.unmeasured.join(", ") || "—"}`,
  ];
}

// ── Phase 9's fifth axis: creator concentration (census-discovery DV-79) ──────
//
// The writer stopped being able to say only "not measurable" here. It now joins
// `discovery_places.submitted_by` for itself (lib/discoveryShadow.ts), which
// leaves the SERVED response shape untouched and puts a real figure on the row.
//
// Everything this reader already does for `meanSavedCount` applies again, for
// the same reason and with one addition. Rows that did not measure the axis are
// EXCLUDED from the mean rather than counted as zero — and, because a failed
// author read is not the same fact as a page with no resolvable author, the
// number of rows that could not read is reported BESIDE the mean rather than
// folded into it. A mean over two of four hundred rows and a mean over four
// hundred look identical if only the mean is printed.
//
// These declarations sit at the foot of the file, and `Phase9Aggregate` gains
// its field by declaration merging, because every line above is the target of
// an anchored citation in docs/architecture and docs/discovery: inserting a
// line there silently repoints someone else's evidence.

/** The shape `lib/discoveryShadow.ts` writes under `pde_stages.phase9.creatorConcentration`. */
export interface ShadowCreatorConcentrationBlob {
  /** `measured` · `unreadable` · `no_client`. Only the first carries page figures. */
  reason: string;
  legacy: ShadowPageCreatorsBlob | null;
  pde: ShadowPageCreatorsBlob | null;
}

export interface ShadowPageCreatorsBlob {
  n: number;
  /** Items whose author was resolvable — COVERAGE, never concentration. */
  resolved: number;
  coverage: number;
  distinctCreators: number | null;
  hhi: number | null;
  topCreatorShare: number | null;
}

export interface Phase9CreatorAggregate {
  /** Rows whose author join actually RAN. The denominator of every mean here. */
  n: number;
  /**
   * Rows that carried the axis but could not read it (`unreadable`/`no_client`).
   * Never folded into the means: a read that did not happen is not a page with
   * no creators, and a report that hid this count would let one stand for the
   * other.
   */
  unreadable: number;
  /** Mean fraction of the page whose author was resolvable. Travels with every figure below. */
  meanCoverageLegacy: number;
  meanCoveragePde: number;
  /** Mean per-page Herfindahl over resolved authors; null when NO page resolved anybody. */
  meanHhiLegacy: number | null;
  meanHhiPde: number | null;
  meanDistinctCreatorsLegacy: number | null;
  meanDistinctCreatorsPde: number | null;
  meanTopCreatorShareLegacy: number | null;
  meanTopCreatorSharePde: number | null;
}

/** Declaration merging — see the note above. */
export interface Phase9Aggregate {
  /**
   * Phase 9 "creator concentration", over the rows in this group whose author
   * join RAN. Null when none did, which is unknown and not a concentration of
   * zero.
   */
  creatorConcentration: Phase9CreatorAggregate | null;
}

/**
 * Aggregate the creator axis over the blobs in one group.
 *
 * Three populations, kept apart on purpose:
 *   • blobs with no `creatorConcentration` at all — written before the join
 *     existed. Invisible here, exactly as a missing `phase9` is to the caller.
 *   • blobs whose read failed — counted in `unreadable`, in no mean.
 *   • blobs that measured — the means, each one still carrying its coverage.
 */
export function aggregateCreatorConcentration(
  blobs: readonly ShadowPhase9Blob[],
): Phase9CreatorAggregate | null {
  const carried = blobs
    .map((b) => b.creatorConcentration)
    .filter((c): c is ShadowCreatorConcentrationBlob => !!c && typeof c.reason === "string");
  const measured = carried.filter((c) => c.reason === "measured" && !!c.legacy && !!c.pde);
  if (measured.length === 0) return null;

  const meanOfKnown = (xs: Array<number | null | undefined>): number | null => {
    const known = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    return known.length === 0 ? null : mean(known);
  };
  const legacy = measured.map((c) => c.legacy!);
  const pde = measured.map((c) => c.pde!);

  return {
    n: measured.length,
    unreadable: carried.length - measured.length,
    meanCoverageLegacy: mean(legacy.map((p) => p.coverage)),
    meanCoveragePde:    mean(pde.map((p) => p.coverage)),
    // hhi / distinct / top-share are null on a page that resolved NOBODY, and
    // meanOfKnown drops them rather than reading them as the least concentrated
    // value a page can have.
    meanHhiLegacy: meanOfKnown(legacy.map((p) => p.hhi)),
    meanHhiPde:    meanOfKnown(pde.map((p) => p.hhi)),
    meanDistinctCreatorsLegacy: meanOfKnown(legacy.map((p) => p.distinctCreators)),
    meanDistinctCreatorsPde:    meanOfKnown(pde.map((p) => p.distinctCreators)),
    meanTopCreatorShareLegacy: meanOfKnown(legacy.map((p) => p.topCreatorShare)),
    meanTopCreatorSharePde:    meanOfKnown(pde.map((p) => p.topCreatorShare)),
  };
}

/** The creator lines. An unresolved axis prints prose, never a quotable number. */
export function formatCreatorConcentration(c: Phase9CreatorAggregate | null): string[] {
  if (!c) {
    return ["       creator conc. author join resolved on no row in this group"];
  }
  const n2 = (x: number | null) => (x == null ? "—" : x.toFixed(2));
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  return [
    `       creator conc. hhi/page ${n2(c.meanHhiLegacy)} → ${n2(c.meanHhiPde)}   creators/page ${n2(c.meanDistinctCreatorsLegacy)} → ${n2(c.meanDistinctCreatorsPde)}   top share ${n2(c.meanTopCreatorShareLegacy)} → ${n2(c.meanTopCreatorSharePde)}`,
    `                     (coverage ${pct(c.meanCoverageLegacy)} → ${pct(c.meanCoveragePde)}; joined on ${c.n} row(s), unreadable on ${c.unreadable})`,
  ];
}

// ── Phase 9's sixth axis: estimated travel intent (census-discovery DV-79) ────
//
// Migration 2894 admits `trip_add` to the `rank_events.outcome` vocabulary and
// `lib/discoveryShadow.ts` reads it per page, so the axis DV-40 said had to wait
// for a recommendation object now has a number.
//
// IT WILL BE ZERO, AND THAT IS NOT THE SAME AS BLANK
// ==================================================
// Nothing writes the token yet, so every page in production reads zero trip
// adds from a read that SUCCEEDED. Everything this reader already does for
// `creatorConcentration` therefore applies with one addition of its own:
//
//   • rows that could not read are counted in `unreadable` and enter no mean —
//     as before;
//   • rows that READ AND FOUND NOTHING are counted in `zeroCorpus` and DO enter
//     the means, at 0 — because that is what they measured;
//   • and `writerless` is carried up from the rows so the printed zero always
//     arrives with the reason it is zero. A report that printed `0.00` alone
//     would be read as "Discovery produces no travel intent", which is a
//     finding nobody has made.
//
// Declared at the foot, and `Phase9Aggregate` gains its field by declaration
// merging, for the reason the creator block above gives: every line higher up is
// the target of an anchored citation, and inserting one silently repoints
// somebody else's evidence.

/** The shape `lib/discoveryShadow.ts` writes under `pde_stages.phase9.estimatedTravelIntent`. */
export interface ShadowTravelIntentBlob {
  /** `measured` · `not_joinable` · `unreadable` · `no_client`. Only the first carries page figures. */
  reason: string;
  /** Why a zero is expected, or null once a writer exists. */
  writerless?: string | null;
  legacy: ShadowPageTravelIntentBlob | null;
  pde: ShadowPageTravelIntentBlob | null;
}

export interface ShadowPageTravelIntentBlob {
  n: number;
  itemsWithTripAdd: number;
  tripAdds: number;
  /** null on an EMPTY page — 0/0 is undefined, not zero. */
  tripAddRate: number | null;
}

export interface Phase9TravelIntentAggregate {
  /** Rows whose trip-add read actually RAN. The denominator of every mean here. */
  n: number;
  /**
   * Rows that carried the axis but could not read it (`unreadable` / `no_client`
   * / `not_joinable`). Never folded into the means: on this axis a failed read
   * and a measured zero print the same digit, so the count that separates them
   * has to be on the page.
   */
  unreadable: number;
  /**
   * Rows that READ and found no trip add on EITHER page. `n === zeroCorpus` is
   * the expected state until a writer exists, and saying it outright is what
   * stops the zero below being read as a finding.
   */
  zeroCorpus: number;
  /** Mean trip-add ROWS per page, over the rows that read. */
  meanTripAddsLegacy: number;
  meanTripAddsPde: number;
  /** Mean per-page fraction of ITEMS with intent; null when every page was empty. */
  meanTripAddRateLegacy: number | null;
  meanTripAddRatePde: number | null;
  /** Carried up from the rows, never re-declared here — see the note above. */
  writerless: string | null;
}

/** Declaration merging — see the note above. */
export interface Phase9Aggregate {
  /**
   * Phase 9 "estimated travel intent", over the rows in this group whose
   * trip-add read RAN. Null when none did, which is unknown and not an intent
   * of zero.
   */
  travelIntent: Phase9TravelIntentAggregate | null;
}

/**
 * Aggregate the travel-intent axis over the blobs in one group.
 *
 * Three populations, kept apart on purpose, and a fourth this axis adds:
 *   • blobs with no `estimatedTravelIntent` object at all — written before the
 *     read existed. Invisible here, exactly as a missing `phase9` is.
 *   • blobs whose read failed — counted in `unreadable`, in no mean.
 *   • blobs that measured — the means.
 *   • of those, the ones that measured ZERO — counted again in `zeroCorpus`, so
 *     "we read 400 pages and none had a trip add" cannot be mistaken for "we
 *     read 400 pages" nor for "we could not read".
 */
export function aggregateTravelIntent(
  blobs: readonly ShadowPhase9Blob[],
): Phase9TravelIntentAggregate | null {
  const carried = blobs
    .map((b) => b.estimatedTravelIntent)
    .filter((t): t is ShadowTravelIntentBlob => !!t && typeof t.reason === "string");
  const measured = carried.filter((t) => t.reason === "measured" && !!t.legacy && !!t.pde);
  if (measured.length === 0) return null;

  const meanOfKnown = (xs: Array<number | null | undefined>): number | null => {
    const known = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    return known.length === 0 ? null : mean(known);
  };
  const legacy = measured.map((t) => t.legacy!);
  const pde = measured.map((t) => t.pde!);

  return {
    n: measured.length,
    unreadable: carried.length - measured.length,
    zeroCorpus: measured.filter((t) => (t.legacy!.tripAdds ?? 0) === 0 && (t.pde!.tripAdds ?? 0) === 0).length,
    meanTripAddsLegacy: mean(legacy.map((t) => t.tripAdds)),
    meanTripAddsPde:    mean(pde.map((t) => t.tripAdds)),
    // A page with no items has no rate, and meanOfKnown drops it rather than
    // reading "there was nothing to divide" as "nobody wanted to go".
    meanTripAddRateLegacy: meanOfKnown(legacy.map((t) => t.tripAddRate)),
    meanTripAddRatePde:    meanOfKnown(pde.map((t) => t.tripAddRate)),
    writerless: measured.find((t) => typeof t.writerless === "string" && t.writerless.length > 0)?.writerless ?? null,
  };
}

/** The travel-intent lines. An unread axis prints prose, never a quotable number. */
export function formatTravelIntent(t: Phase9TravelIntentAggregate | null): string[] {
  if (!t) {
    return ["       travel intent no row in this group could read a trip-add signal"];
  }
  const n2 = (x: number) => x.toFixed(2);
  const nOrDash = (x: number | null) => (x == null ? "—" : x.toFixed(2));
  const lines = [
    `       travel intent  trip adds/page ${n2(t.meanTripAddsLegacy)} → ${n2(t.meanTripAddsPde)}   items w/ intent ${nOrDash(t.meanTripAddRateLegacy)} → ${nOrDash(t.meanTripAddRatePde)}`,
    `                     (read on ${t.n} row(s), unreadable on ${t.unreadable}; ${t.zeroCorpus} of the ${t.n} read found none)`,
  ];
  // The zero's reason travels with the zero. Without this line the two numbers
  // above are a finding about travellers rather than a fact about the writer.
  if (t.writerless) lines.push(`                      ${t.writerless}`);
  return lines;
}
