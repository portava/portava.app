/**
 * discoveryShadow — P1 Stage 2. Observation only: it logs, it never serves.
 *
 * WHAT SHADOW MODE DOES
 * =====================
 * With `DISCOVERY_ENGINE_MODE = shadow`, the user receives the LEGACY result,
 * byte for byte. After the response is flushed, PDE ranks the same candidates
 * for the same viewer, and both orders are written to `discovery_shadow_serves`
 * (operator ruling D7=A).
 *
 * The user's response is computed, sent and finished before any of this runs.
 * Nothing here can change what was served, because what was served has already
 * left.
 *
 * WHERE IT IS WIRED, AND WHY NOT EVERYWHERE YET
 * =============================================
 * Stage 2a wires serve points 1, 2 and 3 — the Cache A layers. That is the
 * traffic the entire packet is about: legacy runs NO ranker there, so a
 * divergence row from those serve points says something no other measurement in
 * this system can say.
 *
 * Serve point 6, the cold-fetch legacy rank, is deliberately NOT wired. Since
 * the engine was extracted rather than copied, the cold path already IS PDE —
 * `routes/discovery.ts` calls `rankForViewer` for it. A shadow row there would
 * compare a result with itself and report zero divergence, which reads like
 * evidence and is a tautology. Rows that cannot fail to agree do not belong in
 * a table whose purpose is to find disagreement.
 *
 * Serve points 4 and 5 — the Compass candidate-cache hit and the fresh Compass
 * rank — are a genuinely different ranker and a genuinely different comparison.
 * They are Stage 2b, not an oversight.
 *
 * NOTHING HERE MAY WRITE OUTSIDE THIS TABLE
 * =========================================
 * The PDE run behind these rows is invoked with `served: false`, which hands it
 * a client that cannot write (lib/discoveryPde.ts). That is not a formality:
 * DiscoveryRankingService emits its own `rank_events` rows for every candidate
 * it scores, and a shadow run left unguarded would have written production
 * impression rows for a page NOBODY SAW — into the very table D7=A exists to
 * keep this data out of. `pde_suppressed_writes` records how many such writes
 * were intercepted, so the guard's effectiveness is visible in the data rather
 * than assumed.
 *
 * WHO IT APPLIES TO — D6, and the gate is now in place
 * =====================================================
 * D6=A stages shadow to INTERNAL ACCOUNTS FIRST, then to a fixed
 * user-id-hashed percentage (D6=B); everyone (C) is the owner's alone.
 *
 * `DISCOVERY_ENGINE_MODE` is one global flag with one global value, so the mode
 * alone says WHAT and never WHO — and without a WHO, `shadow` means everybody.
 * Operator ruling 2026-08-15: shadow must not be enabled for any traffic until
 * that gate exists. It does now: `lib/discoveryCohort.ts`, read from
 * `metadata.cohort` on the same flag row, and applied at the call site in
 * routes/discovery.ts.
 *
 * It fails closed in the OPPOSITE direction from the mode resolver, which is
 * the part worth remembering. The mode falls back to `legacy` because "keep
 * doing what you were doing" is the safe answer for a mode. A cohort that
 * cannot be read includes NOBODY, because "shadow, but I could not read who
 * for" must never mean "shadow everyone" — that failure would arrive silently,
 * as load, not as an error.
 *
 * Every row records which cohort admitted the user (`cohort_reason`, and
 * `cohort_bucket` for D6=B). D6=A rows come from a handful of internal accounts
 * and prove only that the harness runs; D6=B rows are the sample the divergence
 * measurement is actually made from. Pooling them would be a category error,
 * and a row that does not say where it came from will eventually be read as
 * coming from wherever the reader assumes.
 *
 * READ THIS BEFORE INTERPRETING A ZERO-DIVERGENCE ROW
 * ===================================================
 * `applyFilters` does not only filter. When `sortBy` is `rating`, `popular` or
 * `nearest` it RE-SORTS the list, and it runs after ranking on both sides. So
 * on those requests the explicit user sort overrides the ranker in legacy and
 * in PDE alike, and the two pages agree by construction.
 *
 * Those rows are real observations of real serves, and they are not evidence
 * that PDE changes nothing. `sort_by` is recorded on every row precisely so the
 * two populations can be separated. Any analysis that pools them will find PDE
 * less consequential than it is, in exact proportion to how many users sort.
 *
 * FAILURES ARE LOGGED, NOT SWALLOWED
 * ==================================
 * Same rule as lib/discoveryServeLog.ts, for the same reason: an insert that is
 * rejected silently is how a surface can be "instrumented" for weeks and hold
 * zero rows with nothing anywhere saying so. A rejected row is logged. It still
 * never throws — an observation must not be able to damage a request that has
 * already been answered.
 */
import { logger } from "./logger.js";

/** The comparison, computed once at write time so every reader agrees. */
export interface ShadowComparison {
  /** Ids present on both served pages. */
  overlapCount: number;
  /** Shared ids whose position on the page differs. */
  displacedCount: number;
  /** Did the top slot change. */
  topChanged: boolean;
}

/**
 * Compare two served pages by id order.
 *
 * Deliberately compares the SERVED PAGES rather than the full ranked lists.
 * What a user receives is a page; a reordering below the fold changed nothing
 * anybody saw, and counting it as divergence would inflate every figure this
 * table produces.
 */
export function compareServedOrders(legacyIds: string[], pdeIds: string[]): ShadowComparison {
  const pdePos = new Map<string, number>();
  pdeIds.forEach((id, i) => { if (!pdePos.has(id)) pdePos.set(id, i); });

  let overlapCount = 0;
  let displacedCount = 0;
  legacyIds.forEach((id, i) => {
    const j = pdePos.get(id);
    if (j === undefined) return;
    overlapCount += 1;
    if (j !== i) displacedCount += 1;
  });

  // Two empty pages agree. An empty page against a populated one does not, and
  // must not be reported as "top unchanged" — that would read as agreement.
  const topChanged = (legacyIds[0] ?? null) !== (pdeIds[0] ?? null);

  return { overlapCount, displacedCount, topChanged };
}

// ── Phase 9 comparison dimensions ─────────────────────────────────────────────
//
// `12` Phase 9 (`docs/specs/discovery-v1/12_Claude_Code_Implementation.md:125`):
// "Compare: overlap, save rate potential, diversity, creator concentration,
// place diversity, estimated travel intent."
//
// `compareServedOrders` above answers the first. These answer three more, and
// say plainly that two are not answerable from a served Discovery page:
//
//   creator concentration    A served row is a `DiscoveryPlace`, and a
//                            DiscoveryPlace carries NO author — no
//                            `submitted_by`, `authorId` or `creatorId` field
//                            exists on it (the block filter runs where the rows
//                            are READ, precisely because the served shape has
//                            nobody on it). Concentration over creators cannot
//                            be computed from a page that does not name any.
//   estimated travel intent  No trip-add or itinerary-add signal is attached to
//                            a served item (census-discovery DV-40: no
//                            recommendation object, no per-item intent
//                            outcome). Substituting distance would be a proxy
//                            wearing a measurement's name.
//
// Both are reported as `null` and NAMED in `unmeasured`. A zero would read as
// "measured, and it was none", which is the failure this whole census exists to
// stop being possible.

/** The per-item facts the Phase 9 dimensions read. Structural, so the route can pass its own rows. */
export interface ShadowPageItem {
  id: string;
  /** Content type / category slug — the "diversity" axis. */
  category?: string | null;
  /** Neighbourhood label, when the row carries one — one of the "place diversity" axes. */
  neighborhood?: string | null;
  lat?: number | null;
  lng?: number | null;
  /**
   * Demonstrated saves for this place. The Phase 9 axis is "save rate
   * POTENTIAL", and this is a PROXY for it, not a predicted rate: it is what
   * travellers have already done, not what this page will cause. Reported with
   * its own coverage so a mean over three of twenty items cannot be read as a
   * mean over twenty.
   */
  savedCount?: number | null;
}

export interface ShadowPageDimensions {
  /** Items measured. */
  n: number;
  /** Phase 9 "diversity" — how many distinct content categories the page holds. */
  categoryDistinct: number;
  /**
   * Normalized Shannon entropy over categories, 0–1. A distinct COUNT cannot
   * tell four-evenly-spread from three-of-one-plus-one; this can. 1 for an even
   * spread, 0 when everything is one category (and for a page of one item).
   */
  categoryEntropy: number;
  /** Phase 9 "place diversity" — distinct served places. */
  placeDistinct: number;
  /** Distinct neighbourhood labels among the rows that carry one. */
  neighborhoodDistinct: number;
  /** Distinct ~1 km geo cells — geography, which neighbourhood LABELLING is not. */
  geoCellDistinct: number;
  /** Mean of the KNOWN save counts; null when none is known. */
  meanSavedCount: number | null;
  /** Fraction of items whose save count was known. Travels with the mean, always. */
  savedCountCoverage: number;
}

/**
 * ~1 km at the equator, and never coarser than that anywhere — good enough to
 * separate "same block" from "across town".
 *
 * A fixed grid, so two points 150 m apart that straddle a boundary count as two
 * cells. That is a known property of bucketing, not a defect: the measure is
 * "how spread out is this page", and the error it makes is to report a page as
 * slightly MORE spread than it is, never less. Recorded here because a reader
 * comparing two pages needs to know which way the bias runs.
 */
const GEO_CELL_DEG = 0.01;

function normalizedEntropy(counts: readonly number[], total: number): number {
  if (total <= 0 || counts.length <= 1) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h / Math.log2(counts.length);
}

/** Pure: one page → its Phase 9 dimensions. No clock, no client, no throw. */
export function pageDimensions(items: readonly ShadowPageItem[]): ShadowPageDimensions {
  const n = items.length;
  const catCounts = new Map<string, number>();
  const places = new Set<string>();
  const hoods = new Set<string>();
  const cells = new Set<string>();
  let savedSum = 0;
  let savedKnown = 0;

  for (const it of items) {
    if (!it) continue;
    places.add(it.id);
    const cat = typeof it.category === "string" && it.category.length > 0 ? it.category : "(unknown)";
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    if (typeof it.neighborhood === "string" && it.neighborhood.length > 0) hoods.add(it.neighborhood);
    if (typeof it.lat === "number" && Number.isFinite(it.lat) && typeof it.lng === "number" && Number.isFinite(it.lng)) {
      cells.add(`${Math.floor(it.lat / GEO_CELL_DEG)}:${Math.floor(it.lng / GEO_CELL_DEG)}`);
    }
    if (typeof it.savedCount === "number" && Number.isFinite(it.savedCount)) {
      savedSum += it.savedCount;
      savedKnown += 1;
    }
  }

  return {
    n,
    categoryDistinct: n === 0 ? 0 : catCounts.size,
    categoryEntropy: normalizedEntropy([...catCounts.values()], n),
    placeDistinct: places.size,
    neighborhoodDistinct: hoods.size,
    geoCellDistinct: cells.size,
    meanSavedCount: savedKnown === 0 ? null : savedSum / savedKnown,
    savedCountCoverage: n === 0 ? 0 : savedKnown / n,
  };
}

/** The axes this surface cannot measure today, named on every row. */
export const UNMEASURED_PHASE9_AXES = ["creator_concentration", "estimated_travel_intent"] as const;

export interface ShadowPhase9Comparison {
  legacy: ShadowPageDimensions;
  pde: ShadowPageDimensions;
  /** Phase 9 "creator concentration" — NOT measurable: a served page names no author. */
  creatorConcentration: null;
  /** Phase 9 "estimated travel intent" — NOT measurable: no per-item trip/itinerary signal. */
  estimatedTravelIntent: null;
  /** The unmeasured axes, by name, so silence cannot be read as zero. */
  unmeasured: readonly string[];
}

export interface ShadowPageComparison extends ShadowComparison {
  dimensions: ShadowPhase9Comparison;
}

/**
 * The full Phase 9 comparison of two served pages: the existing order
 * comparison plus the dimensions above, computed per PAGE and never blended
 * into one number. "Legacy is more diverse" and "PDE is more diverse" are
 * different findings and a single delta would hide which.
 */
export function compareShadowPages(
  legacy: readonly ShadowPageItem[],
  pde: readonly ShadowPageItem[],
): ShadowPageComparison {
  return {
    ...compareServedOrders(legacy.map((i) => i.id), pde.map((i) => i.id)),
    dimensions: {
      legacy: pageDimensions(legacy),
      pde: pageDimensions(pde),
      creatorConcentration: null,
      estimatedTravelIntent: null,
      unmeasured: UNMEASURED_PHASE9_AXES,
    },
  };
}

export interface ShadowServeParams {
  userId: string;
  sessionId?: string | null;

  destination: string;
  category: string;
  radiusKm: number;
  page: number;
  pageSize: number;
  sortBy?: string | null;

  /** Serve point of the LEGACY path that answered this request. */
  servePoint: number;
  cacheLevel?: string | null;

  /** Ids of the page legacy actually served, in served order. */
  legacyIds: string[];
  /**
   * The legacy page's ROWS, for the Phase 9 dimensions. Optional: a caller that
   * has only ids still writes a valid row, and the dimensions are then absent
   * rather than zero. Absence and zero are different facts.
   */
  legacyItems?: readonly ShadowPageItem[];
  legacyTotal: number;
  legacyMs?: number | null;

  /** Ids of the page PDE would have served, in its order. */
  pdeIds: string[];
  /** The PDE page's ROWS, for the Phase 9 dimensions. Optional, as above. */
  pdeItems?: readonly ShadowPageItem[];
  pdeTotal: number;
  pdeMs?: number | null;
  pdeStages?: Record<string, unknown> | null;
  pdeSuppressedWrites?: number | null;

  engineMode: string;
  modeReason: string;

  /**
   * Which D6 cohort admitted this user — 'user_listed' (A), 'percent_in' (B)
   * or 'kind_all' (C) — and, for B, the 0-99 hash bucket.
   *
   * Required rather than optional. A shadow row whose population is unknown is
   * a row that will eventually be pooled with a population it does not belong
   * to, and internal-account rows pooled with real-user rows would corrupt the
   * one measurement this table exists to produce.
   */
  cohortReason: string;
  cohortBucket?: number | null;
}

/**
 * Write one shadow observation. Fire-and-forget; never throws.
 *
 * The caller is responsible for having flushed the response first — this
 * function does not enforce ordering it cannot see. It is called with `void`
 * from the serve paths for exactly that reason.
 */
export async function logDiscoveryShadowServe(sc: any, p: ShadowServeParams): Promise<void> {
  try {
    if (!sc) return;

    const cmp = compareServedOrders(p.legacyIds, p.pdeIds);
    // `12` Phase 9's remaining axes, computed HERE — at write time, from the
    // pages themselves — rather than in the reader, because the reader only
    // ever sees the columns and `legacy_ids`/`pde_ids` alone cannot answer
    // them. Stored inside the existing `pde_stages` jsonb under its own key, so
    // no column and no migration is added; a row written before this existed
    // simply has no `phase9` key and the reader reports it as unknown.
    const phase9 = p.legacyItems && p.pdeItems
      ? compareShadowPages(p.legacyItems, p.pdeItems).dimensions
      : null;

    const { error } = await sc.from("discovery_shadow_serves").insert({
      user_id:     p.userId,
      session_id:  p.sessionId ?? null,

      destination: p.destination,
      category:    p.category,
      radius_km:   p.radiusKm,
      page:        p.page,
      page_size:   p.pageSize,
      sort_by:     p.sortBy ?? null,

      serve_point:  p.servePoint,
      cache_level:  p.cacheLevel ?? null,
      legacy_ids:   p.legacyIds,
      legacy_total: p.legacyTotal,
      legacy_ms:    p.legacyMs ?? null,

      pde_ids:   p.pdeIds,
      pde_total: p.pdeTotal,
      pde_ms:    p.pdeMs ?? null,
      pde_stages: phase9 ? { ...(p.pdeStages ?? {}), phase9 } : (p.pdeStages ?? {}),
      pde_suppressed_writes: p.pdeSuppressedWrites ?? 0,

      overlap_count:   cmp.overlapCount,
      displaced_count: cmp.displacedCount,
      top_changed:     cmp.topChanged,

      engine_mode: p.engineMode,
      mode_reason: p.modeReason,
      cohort_reason: p.cohortReason,
      cohort_bucket: p.cohortBucket ?? null,
    });

    if (error) {
      logger.warn(
        { err: error, servePoint: p.servePoint, destination: p.destination },
        "discoveryShadow: shadow observation rejected — the comparison for this serve is lost",
      );
    }
  } catch (err) {
    logger.warn({ err }, "discoveryShadow: shadow observation threw — the comparison for this serve is lost");
  }
}
