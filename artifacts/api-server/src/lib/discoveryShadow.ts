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
// `compareServedOrders` above answers the first. These answer four more, and
// say plainly that one is not answerable from a served Discovery page:
//
//   creator concentration    A served row is a `DiscoveryPlace`, and a
//                            DiscoveryPlace carries NO author — no
//                            `submitted_by`, `authorId` or `creatorId` field
//                            exists on it. That is a fact about the SERVED
//                            SHAPE and it is still true. The shadow writer is
//                            not confined to the served shape: it does its OWN
//                            join to `discovery_places.submitted_by` (a column
//                            since 0029_discovery_places.sql) — see
//                            resolvePageAuthors at the foot of this file.
//   estimated travel intent  Migration 2894 admits `trip_add`, so the per-item
//                            signal DV-40 wanted from a recommendation object
//                            comes from the behaviour store — the writer reads
//                            it itself (resolvePageTripAdds, at the foot). NO
//                            WRITER SENDS THE TOKEN YET, so a measured page
//                            reads zero: a read that RAN, kept apart from one
//                            that failed, with the missing writer NAMED.

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
  /** Phase 9 "creator concentration" — the writer's OWN author join. Null only on a row written before it existed. */
  creatorConcentration: ShadowCreatorConcentration | null;
  /** Phase 9 "estimated travel intent" — recorded trip adds per page (2894). Null as above. */
  estimatedTravelIntent: ShadowTravelIntent | null;
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
      ? await compareShadowPagesWithCreators(sc, p.legacyItems, p.pdeItems)
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

// ── Phase 9's FIFTH dimension: creator concentration (census-discovery DV-79) ──
//
// EVERYTHING BELOW THIS LINE IS THE JOIN THE SERVED SHAPE CANNOT DO
// =================================================================
// The census row offered two ways to reach this axis: put an author on the
// SERVED `DiscoveryPlace`, or do "a join the shadow writer does not do". This
// is the second. The response the user received is not touched, no field is
// added to any served shape, and no route changes — the shadow writer, running
// after the response has already left, reads `discovery_places.submitted_by`
// for itself.
//
// `submitted_by` has existed since 0029_discovery_places.sql. The census
// sentence "a served DiscoveryPlace carries no author" remains true, because it
// is a statement about the SERVED SHAPE and not about the database.
//
// WHAT CAN AND CANNOT BE JOINED, AND WHY THAT IS COVERAGE
// ======================================================
// A served discovery id is either `db/<uuid>` (a row in a table) or an OSM
// element such as `node/12345`. Only the first can be joined at all, and even
// then only some of them: `routes/discovery.ts` mints `db/<uuid>` from BOTH
// `discovery_places` AND the canonical `places` table, and only the former has
// an author column. An OSM place has no author because nobody wrote it; a
// canonical row has none here because its author lives elsewhere.
//
// Every one of those is COVERAGE — "this page had places whose author I could
// not resolve" — and none of them is concentration. A page of twenty OSM
// places is not a page with no creators concentrated; it is a page about which
// the question was not answerable. That is why `coverage` travels with every
// figure below and why an unresolved page reports `null`, exactly as
// `meanSavedCount` already does for its own coverage.
//
// THE THREE STATES THAT MAY NEVER COLLAPSE
// ========================================
//   measured    the join ran. `resolved`/`coverage` say how much of the page it
//               could speak for, and the concentration figures are real.
//   not_joinable no id on either page is a `db/<uuid>`, so there was nothing to
//               look up. This is deliberately NOT `measured`-with-coverage-0:
//               `db/<uuid>` is minted from BOTH `discovery_places` AND the
//               canonical `places` table, so "no author found" cannot be told
//               apart from "author lives in a table this join does not read".
//               Unknown, and the axis stays NAMED in `unmeasured`.
//   unreadable  the join was rejected or threw. NOTHING is known: both page
//               figures are `null`, and `creator_concentration` stays in
//               `unmeasured`. A failed read reported as 0 would read as "this
//               page had no concentration", and as 1 as "one author owned the
//               page" — two different fabrications of the same failure.
//   no_client   there was no client to read with, which is the same amount of
//               knowledge and a different cause. It shares `ModifiersReason`'s
//               spelling because the shadow row already carries that vocabulary
//               in `pde_stages.modifiers`.

/** How the author read went. `no_client` is spelled as `ModifiersReason` spells it. */
export type CreatorReadReason = "measured" | "not_joinable" | "no_client" | "unreadable";

/** One page's creator distribution, ALWAYS carrying the coverage it was computed over. */
export interface ShadowPageCreators {
  /** Items on the page. */
  n: number;
  /** Items whose author was resolvable. COVERAGE, never concentration. */
  resolved: number;
  /** `resolved / n`. Travels with every figure below it, always. */
  coverage: number;
  /** Distinct authors among the RESOLVED items; null when none resolved. */
  distinctCreators: number | null;
  /**
   * Herfindahl–Hirschman index over the resolved items' authors, 0–1.
   * 1 when one author holds every resolved slot, 1/k when k authors hold an
   * equal share. Null when nothing resolved — there is no distribution, and 0
   * would be the least concentrated value rather than the absent one.
   */
  hhi: number | null;
  /** Largest single author's share of the RESOLVED items, 0–1; null when none resolved. */
  topCreatorShare: number | null;
}

/** The axis, per page, with the reason the read answered as it did. */
export interface ShadowCreatorConcentration {
  reason: CreatorReadReason;
  /** Null unless `reason` is `measured` — a read that did not happen produces no figure. */
  legacy: ShadowPageCreators | null;
  pde: ShadowPageCreators | null;
}

/** The result of the author join: which state it is in, and what it resolved. */
export interface PageAuthorResolution {
  reason: CreatorReadReason;
  /** served id → author id. A row whose `submitted_by` is NULL is ABSENT, not mapped to null. */
  authors: Map<string, string>;
}

/**
 * `db/<uuid>` → the uuid, for anything else null.
 *
 * The `db/` prefix is the id form `routes/discovery.ts` mints and
 * `lib/discoveryPlacePhotoStore.ts` already matches on, read out of that code
 * rather than guessed. A bare uuid is not what the serve path produces, and an
 * OSM element id is not a uuid at all — sending one to PostgREST would fail the
 * whole read for the rest of the page.
 */
function discoveryPlaceUuid(id: string): string | null {
  const m = /^db\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(id.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Resolve authors for a set of served ids. One join, never a read per place.
 *
 * FAILS CLOSED, and the failure is LOUD in the data rather than only in a log:
 * a rejected or throwing read returns `unreadable` with an EMPTY map, and every
 * caller below turns that into "no figure", never into "no authors". Those are
 * the two answers this function exists to keep apart.
 *
 * An id set with nothing joinable is `not_joinable`: no read was issued, and
 * reporting that as a measured page whose coverage happened to be 0 would let
 * "there was nothing to ask" stand in for "I asked and found nobody".
 */
export async function resolvePageAuthors(
  sc: any,
  ids: readonly string[],
): Promise<PageAuthorResolution> {
  const authors = new Map<string, string>();
  if (!sc) return { reason: "no_client", authors };

  const byUuid = new Map<string, string[]>();
  for (const id of ids) {
    const uuid = typeof id === "string" ? discoveryPlaceUuid(id) : null;
    if (!uuid) continue;
    const served = byUuid.get(uuid) ?? [];
    served.push(id);
    byUuid.set(uuid, served);
  }
  if (byUuid.size === 0) return { reason: "not_joinable", authors };

  try {
    const { data, error } = await sc
      .from("discovery_places")
      .select("id, submitted_by")
      .in("id", [...byUuid.keys()]);
    if (error) {
      logger.warn({ err: error }, "discoveryShadow: author join rejected — creator concentration is UNKNOWN for this serve, not zero");
      return { reason: "unreadable", authors };
    }
    for (const row of (data as any[]) ?? []) {
      const uuid = typeof row?.id === "string" ? row.id.toLowerCase() : null;
      const author = typeof row?.submitted_by === "string" && row.submitted_by.length > 0 ? row.submitted_by : null;
      // A NULL submitted_by is an UNRESOLVED author, not an author called null:
      // the column is `ON DELETE SET NULL`, so a deleted profile leaves a place
      // with no author, and counting every such place as one shared creator
      // would manufacture the most concentrated page this measure can report.
      if (!uuid || !author) continue;
      for (const served of byUuid.get(uuid) ?? []) authors.set(served, author);
    }
    return { reason: "measured", authors };
  } catch (err) {
    logger.warn({ err }, "discoveryShadow: author join threw — creator concentration is UNKNOWN for this serve, not zero");
    return { reason: "unreadable", authors };
  }
}

/** Pure: one page plus a resolved-author map → its creator distribution. No clock, no client, no throw. */
export function pageCreators(
  items: readonly ShadowPageItem[],
  authors: ReadonlyMap<string, string>,
): ShadowPageCreators {
  const n = items.length;
  const counts = new Map<string, number>();
  let resolved = 0;
  for (const it of items) {
    if (!it) continue;
    const author = authors.get(it.id);
    if (!author) continue;          // unresolved is COVERAGE, and contributes to nothing else
    resolved += 1;
    counts.set(author, (counts.get(author) ?? 0) + 1);
  }

  if (resolved === 0) {
    return { n, resolved: 0, coverage: 0, distinctCreators: null, hhi: null, topCreatorShare: null };
  }

  let hhi = 0;
  let top = 0;
  for (const c of counts.values()) {
    const share = c / resolved;
    hhi += share * share;
    if (share > top) top = share;
  }
  return { n, resolved, coverage: n === 0 ? 0 : resolved / n, distinctCreators: counts.size, hhi, topCreatorShare: top };
}

/**
 * The axes this surface cannot measure, GIVEN what the author join managed.
 *
 * Derived rather than declared, so the list on a row can never disagree with
 * the figures beside it: `creator_concentration` leaves the list exactly when a
 * concentration was actually computed, and returns to it the moment a read
 * fails. `UNMEASURED_PHASE9_AXES` stays as the answer for a caller with no
 * client at all, which is what `compareShadowPages` still is.
 */
export function unmeasuredPhase9Axes(
  creators: ShadowCreatorConcentration | null,
  intent: ShadowTravelIntent | null = null,
): readonly string[] {
  const unmeasured: string[] = [];
  // Order matches UNMEASURED_PHASE9_AXES, so a row that measured neither says
  // exactly what the seed constant says rather than saying it differently.
  if (creators?.reason !== "measured") unmeasured.push("creator_concentration");
  if (intent?.reason   !== "measured") unmeasured.push("estimated_travel_intent");
  return unmeasured;
}

/**
 * `compareShadowPages` plus the author join — the version the WRITER uses.
 *
 * The pure `compareShadowPages` above is unchanged and still reports
 * `creatorConcentration: null`, which is correct for what it is handed: a
 * function given nothing but served rows genuinely cannot name an author. This
 * one is given a client as well, and can.
 */
export async function compareShadowPagesWithCreators(
  sc: any,
  legacy: readonly ShadowPageItem[],
  pde: readonly ShadowPageItem[],
): Promise<ShadowPhase9Comparison> {
  const base = compareShadowPages(legacy, pde).dimensions;
  const resolution = await resolvePageAuthors(sc, [...legacy.map((i) => i.id), ...pde.map((i) => i.id)]);

  const creatorConcentration: ShadowCreatorConcentration = resolution.reason === "measured"
    ? {
        reason: "measured",
        legacy: pageCreators(legacy, resolution.authors),
        pde: pageCreators(pde, resolution.authors),
      }
    // NOT `pageCreators(page, new Map())`. That would report coverage 0 on a
    // read that never happened, which is the measured-but-nobody answer wearing
    // the failed-read's clothes. The two must stay distinguishable in the row.
    : { reason: resolution.reason, legacy: null, pde: null };

  // The travel-intent read is issued in the SAME await as the author join would
  // be if they were independent, but they are not: both fail closed on their own
  // terms, and one failing must not silence the other. Promise.all would reject
  // the pair on the first rejection; neither helper rejects, so the sequential
  // reads below are equivalent and one fewer thing to reason about.
  const intentRead = await resolvePageTripAdds(sc, [...legacy.map((i) => i.id), ...pde.map((i) => i.id)]);
  const estimatedTravelIntent: ShadowTravelIntent = intentRead.reason === "measured"
    ? {
        reason: "measured",
        writerless: tripAddWriterNote(),
        legacy: pageTravelIntent(legacy, intentRead.tripAdds),
        pde: pageTravelIntent(pde, intentRead.tripAdds),
      }
    // NOT `pageTravelIntent(page, new Map())`. That is the measured-and-found-
    // nothing answer, which is EXACTLY what production looks like today — so on
    // this axis, more than any other, a failed read wearing it would be
    // invisible. Both figures stay null; `reason` says which state this is.
    : { reason: intentRead.reason, writerless: tripAddWriterNote(), legacy: null, pde: null };

  return {
    ...base,
    creatorConcentration,
    estimatedTravelIntent,
    unmeasured: unmeasuredPhase9Axes(creatorConcentration, estimatedTravelIntent),
  };
}

// ── Phase 9's SIXTH dimension: estimated travel intent (census-discovery DV-79) ─
//
// WHAT THE CENSUS ROW SAID, AND WHAT CHANGED
// ==========================================
// DV-79 graded this axis FAIL with the evidence "needs a per-item trip-add /
// itinerary-add signal, which needs DV-40's recommendation object". DV-40
// records that `recommendations` / `recommendation_items` have no `CREATE TABLE`
// anywhere in the tree, so that route was closed and this axis stayed shut
// behind it.
//
// Migration 2894 opened the other one. `rank_events.outcome` now admits
// `trip_add`, which IS a per-item trip-add signal, on the behaviour store `04`
// §2 says this surface must use — no recommendation object required, and no
// parallel store created. The shadow writer reads it for itself, exactly as it
// reads `discovery_places.submitted_by` for the creator axis: the served
// response shape is untouched and no route changes.
//
// THERE IS NO WRITER, AND THE ROW SAYS SO
// =======================================
// The production trip-add site for a Discovery place is
// `POST /api/places/:placeId/add-to-trip-plan` (routes/plan.ts). It writes a
// `trip_plan_items` row and reports NO rank-events outcome. So every page in
// production reads ZERO trip adds — from a read that succeeded.
//
// This is the axis where the zero is the EVERYDAY answer rather than an edge
// case, which is precisely why the two must not collapse:
//
//   measured, tripAdds 0   the read ran; nobody has recorded a trip add for
//                          these items. Today that is true of every page, and
//                          `writerless` names the reason so the number is never
//                          quoted as "travellers do not add from Discovery".
//   unreadable             the read was rejected or threw. NOTHING is known.
//                          Both page figures are `null` and the axis stays
//                          NAMED in `unmeasured`. A 0 here would be the same
//                          sentence as the line above, written from a
//                          measurement nobody made.
//   not_joinable           both pages were empty, so there was nothing to ask.
//                          Not `measured`-with-n-0: no read was issued.
//   no_client              no client to read with. Same knowledge, other cause.
//
// WHAT IS NOT SCOPED, AND WHY
// ===========================
// The read filters on `outcome` and `item_id` and nothing else. It is NOT
// scoped to a surface: `item_id` is the canonical place id, a trip add is a
// trip add wherever the traveller came from, and scoping to `discovery` would
// count the same place's intent differently depending on which rail showed it.
// It is NOT scoped to the viewer either: the axis compares what two PAGES
// attract, not what one person did, exactly as `savedCount` already does.

/** How the trip-add read went. Spelled as `CreatorReadReason` spells its states. */
export type TravelIntentReadReason = "measured" | "not_joinable" | "no_client" | "unreadable";

/** One page's recorded travel intent, ALWAYS carrying the denominator it was computed over. */
export interface ShadowPageTravelIntent {
  /** Items on the page. */
  n: number;
  /** Items with AT LEAST ONE recorded trip add. */
  itemsWithTripAdd: number;
  /** Trip-add rows found across the page's items. One item added twice counts twice HERE and once above. */
  tripAdds: number;
  /** `itemsWithTripAdd / n`; null for an empty page — 0/0 is undefined, not zero. */
  tripAddRate: number | null;
}

/** The axis, per page, with the reason the read answered as it did. */
export interface ShadowTravelIntent {
  reason: TravelIntentReadReason;
  /**
   * Why a zero is expected, or null once it is not. Non-null exactly while
   * `TRIP_ADD_WRITERS` is empty — DERIVED, so the note cannot outlive the gap it
   * describes: whoever wires the writer adds its path to that list and the note
   * disappears from every row written afterwards, without editing this comment.
   */
  writerless: string | null;
  /** Null unless `reason` is `measured` — a read that did not happen produces no figure. */
  legacy: ShadowPageTravelIntent | null;
  pde: ShadowPageTravelIntent | null;
}

/** The `rank_events.outcome` token migration 2894 admits. */
export const TRIP_ADD_OUTCOME = "trip_add";

/**
 * Every call site in this repository that reports `outcome='trip_add'`.
 *
 * EMPTY. `POST /api/places/:placeId/add-to-trip-plan` (routes/plan.ts) is the
 * production trip-add site for a Discovery place and it reports no outcome;
 * adding that report is a one-call change in a file this lane does not own.
 * When it lands, its path goes here and `tripAddWriterNote()` stops annotating
 * every row.
 */
export const TRIP_ADD_WRITERS: readonly string[] = [];

/** The note itself, so the wording lives in one place and the tests can match it. */
export const TRIP_ADD_HAS_NO_WRITER =
  "nothing writes outcome='trip_add': the vocabulary admits it (migration 2894) and the only trip-add " +
  "site, POST /api/places/:placeId/add-to-trip-plan (routes/plan.ts), reports no outcome. A measured " +
  "page therefore reads 0 — which means 'never recorded', not 'never wanted'";

/** Null once a writer exists. See TRIP_ADD_WRITERS. */
export function tripAddWriterNote(): string | null {
  return TRIP_ADD_WRITERS.length === 0 ? TRIP_ADD_HAS_NO_WRITER : null;
}

/** Cap on the trip-add read. A page is bounded; the rows against it are not. */
export const TRIP_ADD_MAX_ROWS = 2_000;

/** The result of the trip-add read: which state it is in, and what it counted. */
export interface PageTripAddResolution {
  reason: TravelIntentReadReason;
  /** served id → trip-add rows recorded against it. An item with none is ABSENT, not mapped to 0. */
  tripAdds: Map<string, number>;
}

/**
 * Count recorded trip adds for a set of served ids. One read, never one per item.
 *
 * FAILS CLOSED and LOUDLY IN THE DATA: a rejected or throwing read returns
 * `unreadable` with an EMPTY map, and the caller turns that into "no figure",
 * never into "no trip adds". On this axis those two are one keystroke apart and
 * the wrong one is what production looks like, so the distinction is carried in
 * `reason` rather than inferred from an empty map.
 *
 * An EMPTY id set is `not_joinable`: no read was issued, and reporting it as a
 * measured page that happened to find nothing would let "there was nothing to
 * ask" stand in for "I asked and found none".
 */
export async function resolvePageTripAdds(
  sc: any,
  ids: readonly string[],
): Promise<PageTripAddResolution> {
  const tripAdds = new Map<string, number>();
  if (!sc) return { reason: "no_client", tripAdds };

  // De-duplicated: a page may serve the same id twice, and asking for it twice
  // would not change the answer but would widen the `IN` list for nothing.
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return { reason: "not_joinable", tripAdds };

  try {
    const { data, error } = await sc
      .from("rank_events")
      .select("item_id")
      .eq("outcome", TRIP_ADD_OUTCOME)
      .limit(TRIP_ADD_MAX_ROWS)
      .in("item_id", unique);
    if (error) {
      logger.warn({ err: error }, "discoveryShadow: trip-add read rejected — estimated travel intent is UNKNOWN for this serve, not zero");
      return { reason: "unreadable", tripAdds };
    }
    for (const r of (data as any[]) ?? []) {
      const id = typeof r?.item_id === "string" ? r.item_id : null;
      if (!id) continue;
      tripAdds.set(id, (tripAdds.get(id) ?? 0) + 1);
    }
    return { reason: "measured", tripAdds };
  } catch (err) {
    logger.warn({ err }, "discoveryShadow: trip-add read threw — estimated travel intent is UNKNOWN for this serve, not zero");
    return { reason: "unreadable", tripAdds };
  }
}

/** Pure: one page plus a trip-add count map → its travel intent. No clock, no client, no throw. */
export function pageTravelIntent(
  items: readonly ShadowPageItem[],
  tripAdds: ReadonlyMap<string, number>,
): ShadowPageTravelIntent {
  const n = items.length;
  let itemsWith = 0;
  let total = 0;
  for (const it of items) {
    if (!it) continue;
    const c = tripAdds.get(it.id) ?? 0;
    if (c > 0) itemsWith += 1;
    total += c;
  }
  // `tripAddRate` is per ITEM, not per row: one place added to four different
  // travellers' trips is one item with intent, and dividing rows by items would
  // let a single popular place report a rate above 1.
  return { n, itemsWithTripAdd: itemsWith, tripAdds: total, tripAddRate: n === 0 ? null : itemsWith / n };
}
