/**
 * discoveryCandidate — the server-built DiscoveryCandidate projection.
 *
 * WHAT THIS DISCHARGES, AND WHAT IT DOES NOT
 * ==========================================
 * Sensing §8 (`docs/specs/…Sensing…v1.txt:135`): "Introduce server-built
 * DiscoveryCandidate / projection with why-now, why-for-user, confidence,
 * freshness and truth class." Sensing §5.1 (`:106-108`): every server-built
 * state consumed by Map / Discovery / Wall / Compass carries truth class,
 * confidence, freshness and coverage, and "prediction must never be rendered
 * indistinguishably from observation." Map §20 (`:202-203`): Discovery owns
 * "Candidate relevance" and exposes it to the Map as a projection.
 *
 * census-discovery A03 and A25. Both were NOT-BUILT; this module makes them
 * BUILT — and, when it was written, BUILT-BUT-WRONG on one field:
 *
 *   whyNow WAS always null. There was no live-intelligence producer for a
 *   place (census-discovery A01 — the ranker's inputs are taste, graph,
 *   behaviour and trails; ExperienceState, forecast and friction did not reach
 *   it). A why-now manufactured from static popularity would be exactly the
 *   thing §5.1 forbids: a prediction dressed as an observation.
 *
 *   THE PRODUCER NOW EXISTS: lib/discoveryLiveRank grades a served row on the
 *   live claims lib/liveClaimRead serves and returns `whyNow` as grounded
 *   reasons in the claims' OWN vocabulary (crowd_busy, trajectory_building,
 *   walk_in_refused, …). This module copies that list and invents nothing. It
 *   is null whenever no grade was computed (the live-rank flag is off, the row
 *   is outside the ranked window, the live gates refused the read) and whenever
 *   a grade found no reading — so "absent" and "nothing observed" both read as
 *   null rather than as an empty endorsement. Absence of evidence must never
 *   silently become evidence of absence.
 *
 * EVERY VALUE HERE IS DERIVED, NONE IS MEASURED — read this before trusting one
 * ======================================================================
 * The projection is assembled from facts the served row already carries. The
 * mappings are DEFAULTS, chosen to be explainable and monotone, and they are
 * recorded here so an owner can ratify or replace them (census-discovery D9):
 *
 *   truthClass   what kind of claim "this place exists and is worth listing" is
 *     corroborated   two independent sources agree: a canonical public.places
 *                    row (Discovery's own promoted registry), or an OSM row
 *                    that carries a Wikidata entity id
 *     observed       one source observed it: a plain OSM directory row, or a
 *                    moderated-active community submission (a traveller's
 *                    observation, admitted by review)
 *     stale          served from a cache entry past its TTL (serve point 3,
 *                    L2_stale) — the observation is real but its age is
 *                    unknown to the client unless we say so
 *     unknown        an id shape this module does not recognise
 *     (inferred / predicted / conflicting are §5.1 classes with NO producer
 *     on this surface today and are never emitted — emitting them would be
 *     the forbidden rendering.)
 *
 *   confidence   a CLASS PRIOR in [0,1], not a measurement:
 *                corroborated 0.8 · observed 0.6 · stale 0.4 · unknown 0.2.
 *                Nothing else moves it. When a real calibration exists (Event
 *                Truth, ROADMAP), it replaces this table; until then a single
 *                prior per class is the honest amount of precision.
 *
 *   freshness    mechanical: which serve point produced the row and how old the
 *                cache entry was. `ageMs` is null when the serve point does not
 *                know (the Compass candidate cache does not expose its stamp).
 *
 *   whyForUser   the ranker's OWN per-feature contributions, positive ones,
 *                strongest first, at most three, named by the feature key
 *                portavaRank already logs to rank_events.features
 *                (categoryAffinity, followedAuthor, distance, …). No new
 *                vocabulary is invented; when no per-user ranker ran on this
 *                serve (the unranked cache-A points, an anonymous caller, or
 *                the Compass path whose scores are a different shape) the list
 *                is EMPTY and `rankedBy` says why. An empty list is "nothing
 *                was computed", never "nothing applies".
 *
 * INERT UNTIL SEEDED ON
 * =====================
 * `withDiscoveryCandidates` is the only thing the route calls. With
 * `discovery_candidate_projection_enabled` absent / false / unreadable it
 * returns the SAME ARRAY REFERENCE it was given — not a copy — so the served
 * JSON is byte-identical to today's. Migration 2361 seeds the flag FALSE and
 * refuses to commit it ON. Discovery is a live surface; nothing here changes
 * what a user sees until an owner flips that row.
 *
 * NEVER PERSISTED
 * ===============
 * The projection is per-serve (freshness and whyForUser are properties of THIS
 * response, not of the place), so it is attached to the OUTGOING slice only and
 * never written into Cache A / L2. A cached projection would carry a freshness
 * that was true once.
 *
 * THE MAP-FACING READER
 * =====================
 * `readDiscoveryCandidatesForViewer` is the privacy-complete reader Map §20
 * expects each owner to expose (routes/mapProjection.ts:14-27 lists the
 * others). Like lib/discoveryPde it DOES NOT RETRIEVE: the Map hands it the
 * place rows it already holds and gets projections back. It ranks with
 * `served: false`, which hands the ranker a client that cannot write
 * (lib/discoveryPde.ts) — a Map read must never produce a rank_events
 * impression for a page the user did not see on Discovery. Precondition,
 * stated rather than assumed: the caller's rows are already block-filtered
 * (DiscoveryPlace never carries submitted_by; the filter happens where the
 * rows are read). It has no consumer yet — the Map gateway is another agent's
 * file — and the census records it as "reader exists, consumer absent" rather
 * than as done.
 */
import type { RankCandidate, ScoredCandidate } from "./portavaRank.js";
import { isFlagEnabled } from "./featureFlags.js";
import { loadPdeViewer, rankForViewer, type PdePlace } from "./discoveryPde.js";
import type { DiscoveryLiveRank } from "./discoveryLiveRank.js";

/** Literal name so check-flag-polarity resolves the read. `*_enabled` ⇒ capability, fail-closed. */
export const DISCOVERY_CANDIDATE_PROJECTION_FLAG = "discovery_candidate_projection_enabled";

/** Sensing §5.1 vocabulary. Only the first four are ever produced here. */
export type DiscoveryTruthClass =
  | "corroborated" | "observed" | "stale" | "unknown"
  | "inferred" | "predicted" | "conflicting";

export type DiscoveryFreshnessState = "fresh" | "stale" | "unknown";

export type DiscoveryRankedBy = "pde" | "compass" | "none";

export interface DiscoveryCandidate {
  /** The served place id this projection describes (same id space as the row). */
  id: string;
  /**
   * Grounded reasons from lib/discoveryLiveRank, in the claims' own
   * vocabulary. Null when no grade was computed or the grade found no
   * reading — never an empty array, so "absent" cannot read as "none apply".
   */
  whyNow: string[] | null;
  /** Ranker feature keys with positive contribution, strongest first, ≤ 3. */
  whyForUser: string[];
  /** Which ranker produced whyForUser; "none" ⇒ the list is empty by construction. */
  rankedBy: DiscoveryRankedBy;
  /** Class prior in [0,1]. Not a measurement. */
  confidence: number;
  freshness: {
    state: DiscoveryFreshnessState;
    /** Age of the cache entry the row came from; null when unknown. */
    ageMs: number | null;
    /** The route's cacheLevel label, verbatim. */
    servedFrom: string;
  };
  truthClass: DiscoveryTruthClass;
}

/** The subset of a served place this module reads. Structural, so the Map can pass its own rows. */
export interface CandidateSourceRow {
  id: string;
  canonicalPlaceId?: string | null;
  wikidataId?: string | null;
}

export interface CandidateServeContext {
  /** The route's cacheLevel label (L1 · L2_fresh · L2_stale · miss · compass_candidate_hit · compass_fresh_rank). */
  cacheLevel: string;
  /** Epoch ms the cache entry was written; null when the serve point does not know. */
  cachedAt: number | null;
  /** PDE per-candidate scores when PDE ranked this serve; null otherwise. */
  scoredById: Map<string, ScoredCandidate<RankCandidate>> | null;
  /** Who ranked. Must be "pde" iff scoredById is non-null. */
  rankedBy: DiscoveryRankedBy;
  /**
   * Live grades from lib/discoveryLiveRankRead, keyed by served row id. Absent
   * / null (the default, and the state whenever `discovery_live_rank_enabled`
   * is off) ⇒ every `whyNow` is null, exactly as before this existed.
   */
  liveRankById?: Map<string, DiscoveryLiveRank> | null;
  /** Clock, injectable for tests. */
  nowMs?: number;
}

export const CONFIDENCE_PRIOR: Readonly<Record<"corroborated" | "observed" | "stale" | "unknown", number>> = {
  corroborated: 0.8,
  observed:     0.6,
  stale:        0.4,
  unknown:      0.2,
};

const OSM_ID = /^(node|way|relation)\/\d+$/;
const WHY_FOR_USER_MAX = 3;

/** Truth class from the facts a served row carries. Pure. */
export function classifyTruth(row: CandidateSourceRow, cacheLevel: string): DiscoveryTruthClass {
  if (cacheLevel === "L2_stale") return "stale";
  if (row.canonicalPlaceId) return "corroborated";
  if (row.id.startsWith("db/")) return "observed";
  if (OSM_ID.test(row.id)) return row.wikidataId ? "corroborated" : "observed";
  return "unknown";
}

/** Freshness from the serve point and the entry's age. Pure. */
export function classifyFreshness(
  cacheLevel: string, cachedAt: number | null, nowMs: number,
): DiscoveryCandidate["freshness"] {
  const ageMs = cachedAt == null ? null : Math.max(0, nowMs - cachedAt);
  const state: DiscoveryFreshnessState =
    cacheLevel === "L2_stale" ? "stale"
    : cacheLevel === "L1" || cacheLevel === "L2_fresh" || cacheLevel === "miss" || cacheLevel === "compass_fresh_rank" ? "fresh"
    : "unknown";
  return { state, ageMs, servedFrom: cacheLevel };
}

/**
 * The ranker's positive per-feature contributions, strongest first, capped.
 * Zero and negative contributions are not reasons FOR the user; they are
 * omitted rather than sign-flipped into a different claim.
 */
export function whyForUserFromFeatures(features: Record<string, number> | undefined): string[] {
  if (!features) return [];
  return Object.entries(features)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, WHY_FOR_USER_MAX)
    .map(([k]) => k);
}

/**
 * The grounded why-now for a row, copied verbatim from the live grade. Null in
 * every case where no reading backs it: no grade at all, an empty reason list,
 * or a grade whose evidence label says nothing was observed (`none`) or that
 * the gates refused the look (`unreadable`). This function composes no reason
 * of its own and reads no field but the grade's.
 */
export function whyNowOf(id: string, ctx: Pick<CandidateServeContext, "liveRankById">): string[] | null {
  const grade = ctx.liveRankById?.get(id);
  if (!grade) return null;
  if (grade.evidence === "none" || grade.evidence === "unreadable") return null;
  return grade.whyNow.length > 0 ? [...grade.whyNow] : null;
}

/** Project one served row. Pure; no I/O, no clock unless supplied. */
export function projectDiscoveryCandidate(row: CandidateSourceRow, ctx: CandidateServeContext): DiscoveryCandidate {
  const nowMs = ctx.nowMs ?? Date.now();
  const truthClass = classifyTruth(row, ctx.cacheLevel);
  const scored = ctx.scoredById?.get(row.id);
  const whyForUser = ctx.rankedBy === "pde" && scored ? whyForUserFromFeatures(scored.features) : [];
  return {
    id: row.id,
    whyNow: whyNowOf(row.id, ctx),
    whyForUser,
    rankedBy: ctx.rankedBy,
    confidence: CONFIDENCE_PRIOR[truthClass as keyof typeof CONFIDENCE_PRIOR] ?? CONFIDENCE_PRIOR.unknown,
    freshness: classifyFreshness(ctx.cacheLevel, ctx.cachedAt, nowMs),
    truthClass,
  };
}

// ── Flag (cached 30 s, mirrors discoveryServeLog) ─────────────────────────────

const FLAG_TTL_MS = 30_000;
let _flagCache: { value: boolean; at: number } | null = null;

/** Invalidate the flag cache. Exported for tests. */
export function invalidateCandidateProjectionFlagCache(): void {
  _flagCache = null;
}

export async function candidateProjectionEnabled(sc: any): Promise<boolean> {
  if (_flagCache && Date.now() - _flagCache.at < FLAG_TTL_MS) return _flagCache.value;
  const value = await isFlagEnabled(sc, DISCOVERY_CANDIDATE_PROJECTION_FLAG);
  _flagCache = { value, at: Date.now() };
  return value;
}

/**
 * The one call the route makes. Flag OFF ⇒ returns `places` ITSELF (same
 * reference, nothing copied, nothing added). Flag ON ⇒ a new array whose
 * elements carry `candidate`. Never throws into a feed response.
 */
export async function withDiscoveryCandidates<T extends CandidateSourceRow>(
  sc: any,
  places: T[],
  ctx: CandidateServeContext,
): Promise<Array<T & { candidate?: DiscoveryCandidate }>> {
  let on = false;
  try { on = await candidateProjectionEnabled(sc); } catch { on = false; }
  if (!on) return places;
  return places.map((p) => ({ ...p, candidate: projectDiscoveryCandidate(p, ctx) }));
}

// ── The Map-facing reader (Map §20; census-discovery A25) ─────────────────────

export interface CandidateReadOutcome<T> {
  candidates: Array<{ place: T; candidate: DiscoveryCandidate }>;
  rankedBy: DiscoveryRankedBy;
  /** Writes the ranker attempted and the no-write client intercepted. Must be 0 on the served path; here it is expected to be > 0 when PDE ran. */
  suppressedWrites: number;
}

/**
 * Project candidate relevance for a viewer over rows the CALLER already holds.
 * Does not retrieve. Does not write (served:false). Anonymous viewer ⇒ no
 * per-user ranking, `rankedBy: "none"`, every whyForUser empty.
 */
export async function readDiscoveryCandidatesForViewer<T extends CandidateSourceRow & PdePlace>(
  sc: any,
  places: T[],
  viewerId: string | null,
  city: string | null,
  opts: { cacheLevel?: string; cachedAt?: number | null; nowMs?: number } = {},
): Promise<CandidateReadOutcome<T>> {
  const cacheLevel = opts.cacheLevel ?? "map_read";
  const base = { cacheLevel, cachedAt: opts.cachedAt ?? null, nowMs: opts.nowMs };
  if (!viewerId || places.length === 0) {
    const ctx: CandidateServeContext = { ...base, scoredById: null, rankedBy: "none" };
    return {
      candidates: places.map((place) => ({ place, candidate: projectDiscoveryCandidate(place, ctx) })),
      rankedBy: "none",
      suppressedWrites: 0,
    };
  }
  const viewer = await loadPdeViewer(sc, viewerId, city);
  const outcome = await rankForViewer(places, viewer, { sc, served: false });
  const ctx: CandidateServeContext = { ...base, scoredById: outcome.scoredById, rankedBy: "pde" };
  return {
    candidates: outcome.ranked.map((place) => ({ place, candidate: projectDiscoveryCandidate(place, ctx) })),
    rankedBy: "pde",
    suppressedWrites: outcome.stages.suppressedWrites,
  };
}
