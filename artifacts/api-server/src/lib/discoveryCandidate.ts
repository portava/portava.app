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
 *   whyForUser   the ranker's OWN reasons, strongest first, at most three, in
 *                whichever ranker's vocabulary ran. PDE: the positive
 *                per-feature contributions portavaRank already logs to
 *                rank_events.features (categoryAffinity, followedAuthor,
 *                distance, …). Compass: the grounded `RankingFactor.key` list
 *                its pipeline produced, carried here by
 *                lib/discoveryRankProvenance. No new vocabulary is invented in
 *                either case; when no per-user ranker ran on this serve (the
 *                unranked cache-A points, an anonymous caller) the list is
 *                EMPTY and `rankedBy` says why. An empty list is "nothing was
 *                computed", never "nothing applies".
 *
 *   provenance   `06` §5's five cache-metadata fields plus the feature vector
 *                `01` §7 says a cached final order must not be stored without.
 *                Built by lib/discoveryRankProvenance at the moment the ranker
 *                returns and REPLAYED verbatim on a cache-B hit — so
 *                `rankedAt` reports when the rank happened, never when the
 *                cache was read. Null when no rank is on file for this serve.
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
 * rows are read).
 *
 * CONSUMER, as of 2026-09-15: `routes/mapProjection.ts` calls this reader over
 * its already-paginated page, behind THIS lane's own
 * `discovery_candidate_projection_enabled` rather than a Map-side flag — so the
 * Map cannot serve the projection while its owner's gate is shut. The sentence
 * that stood here ("It has no consumer yet — the Map gateway is another agent's
 * file") was true when it was written and is false now; census-discovery §31
 * records the same correction against A25 and D10.
 *
 * It is still NOT done, and the reason has changed rather than gone away:
 * measured read-only against production on 2026-09-15, the flag row
 * `discovery_candidate_projection_enabled` DOES NOT EXIST there at all, and
 * `isFlagEnabled` fails closed on an absent flag. Migration 2361 is applied to
 * no production database, so this projection is dark for every real user, and
 * §6 D9's mapping defaults are still unratified.
 */
import type { RankCandidate, ScoredCandidate } from "./portavaRank.js";
import type { DiscoveryRankProvenance } from "./discoveryRankProvenance.js";
import { explainReasons, type DiscoveryReason } from "./discoveryReasonCodes.js";
import { isFlagEnabled } from "./featureFlags.js";
import { loadPdeViewer, rankForViewer, type PdePlace } from "./discoveryPde.js";
import type { DiscoveryLiveRank } from "./discoveryLiveRank.js";
import { point } from "./mapObjects.js";
import { classifyAgainstProtected, type ProtectedZone } from "./protectedLocations.js";
import type { CoverageBucket } from "./truthClass.js";

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
  /**
   * §5.1's FOURTH field, and the last one this projection was missing.
   *
   * The cohort bucket behind `whyNow` — how many independent contributors the
   * live grade rested on — in `lib/truthClass`'s four-value vocabulary, copied
   * from `DiscoveryLiveRank.truth.coverage` and composed nowhere else. Never a
   * count: the count is the figure §24 withholds, the bucket is what may be
   * served in its place, and every published bucket already sits above the k
   * floor the privacy gate applied before the claim existed.
   *
   * ── `unknown` IS THE WITHHOLDING VALUE, AND IT IS AMBIGUOUS ON PURPOSE ──────
   * `unknown` means ONE of: no live grade ran, the grade found no reading, the
   * gates refused the look, or `coverageForCandidate` REFUSED to publish the
   * bucket because the §24 pass did not clear this row. Those cases are
   * deliberately indistinguishable from outside, for the same reason `reasons`
   * is: a candidate that said "withheld because this place is protected" would
   * publish the protected status this field exists to hide. The server-side
   * `coverageForCandidate` returns the reason for an operator; the wire does
   * not carry it.
   */
  coverage: CoverageBucket;
  /**
   * `06` §5 cache metadata — model_version, feature_version, candidate source,
   * recommendation reasons, the feature vector and the ranking timestamp — for
   * the rank that produced this row's position.
   *
   * NULL, never a blank record, whenever no ranker ran for this serve or the
   * serve point carries no provenance (the unranked cache-A points, an
   * anonymous caller). A record of empty strings would assert that a rank
   * happened and had no version; null says no rank is on file.
   */
  provenance: DiscoveryRankProvenance | null;
  /**
   * `01` §11 — the internal reason codes for this row, each with its
   * plain-language explanation. Translated by lib/discoveryReasonCodes from the
   * SAME signal list `whyForUser` reports, so the two can never disagree: one
   * is the ranker's vocabulary, the other the product's.
   *
   * Empty whenever no ranker ran, and also whenever every signal that fired is
   * one the `01` §10 guardrails forbid rendering. Both are "nothing to say",
   * and they are deliberately indistinguishable from outside — saying which
   * would leak what the guardrail withholds.
   */
  reasons: DiscoveryReason[];
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
  /**
   * `06` §5 provenance for the rank that produced this page, keyed by served
   * row id. Present on both Compass serve points — the fresh rank builds it,
   * and the cache-B hit REPLAYS the stored one rather than re-stamping a new
   * `rankedAt`, because the ranking timestamp is when the ranker ran and a
   * cache read is not a rank.
   */
  provenanceById?: ReadonlyMap<string, DiscoveryRankProvenance> | null;
  /**
   * §24 — the protected zones this serve must be checked against before any
   * cohort signal may be published, and the position of each served row.
   *
   * BOTH ARE REQUIRED FOR A BUCKET TO BE SERVED, and absence is not "no zones
   * nearby" — it is "the pass did not run", which fails closed to `unknown`.
   * That is the whole difference between this and copying the Map's bucket
   * across: the Map runs `applyProtection` over objects that carry their own
   * geometry, and a `DiscoveryCandidate` carries none by design, so the serve
   * point must hand the geometry in or get nothing.
   *
   * `positionById` is read ONLY to decide the zone question and never reaches
   * the projection — no coordinate appears on a `DiscoveryCandidate`.
   */
  protectedZones?: readonly ProtectedZone[] | null;
  positionById?: ReadonlyMap<string, { lat: number; lng: number }> | null;
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
export function whyForUserFromFeatures(
  features: Record<string, number> | undefined,
  limit: number = WHY_FOR_USER_MAX,
): string[] {
  if (!features) return [];
  const ordered = Object.entries(features)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);
  return Number.isFinite(limit) ? ordered.slice(0, limit) : ordered;
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

/**
 * Why `coverage` reads as it does. SERVER-SIDE ONLY — see the field's comment
 * for why the wire cannot carry this.
 */
export type CoverageWithholdReason =
  /** A bucket was read and the §24 pass cleared it. */
  | "served"
  /** No live grade, no reading, or the live gates refused the look. */
  | "no_reading"
  /** The serve point ran no protected-zone pass, so nothing may be published. */
  | "pass_did_not_run"
  /** The pass ran and this row is inside (or may be inside) a protected zone. */
  | "protected_zone";

export interface CandidateCoverageDecision {
  coverage: CoverageBucket;
  reason: CoverageWithholdReason;
}

/**
 * §24, answered CONSERVATIVELY — the arm that needs no ruling.
 *
 * The census left S49 on an owner question: either route `DiscoveryCandidate`
 * through the same coarsening the Map runs, or rule that a four-value bucket
 * over an already k-gated state is not protected-zone sensitive. This is the
 * FIRST arm. It publishes a bucket only where a real protected-zone pass ran
 * and cleared the row, so it cannot open the hole the second arm would have to
 * be ruled safe: a `coverage` on Discovery for a place whose `coverage` the Map
 * deliberately withholds is impossible by construction here.
 *
 * ── WHY IT PROBES AS `social_zone` ──────────────────────────────────────────
 * `classifyAgainstProtected` decides on an object's KIND as well as its
 * position, so the probe has to declare what kind of disclosure a cohort bucket
 * is. It is an AMBIENT PRESENCE disclosure: `protectedLocations` defines that
 * class as one where "the disclosure is the association with the place, which
 * no amount of coordinate blurring removes", which is exactly a bucket saying
 * independent people were observed at this place. So a coarsen-class zone
 * ESCALATES to suppress for it, and this function withholds — the same answer
 * the Map reaches when it deletes `coverage` inside a zone.
 *
 * Every non-`allow` answer withholds. There is no coarser honest bucket to fall
 * back to: `few` over a protected place still says people were there.
 *
 * PURE. The probe is built, read and discarded here; no coordinate escapes.
 */
export function coverageForCandidate(
  id: string,
  ctx: Pick<CandidateServeContext, "liveRankById" | "protectedZones" | "positionById">,
): CandidateCoverageDecision {
  const bucket = ctx.liveRankById?.get(id)?.truth?.coverage ?? null;
  // Nothing to withhold and nothing to serve. Checked FIRST so a row with no
  // reading is not reported as protected — that would be a disclosure made out
  // of an absence.
  if (bucket === null || bucket === "unknown") return { coverage: "unknown", reason: "no_reading" };

  const zones = ctx.protectedZones;
  const position = ctx.positionById?.get(id) ?? null;
  // Fail closed on BOTH halves. A serve point that passed no zones has not
  // proved this row is outside one, and a row with no position cannot be
  // placed against the zones that were passed.
  if (!Array.isArray(zones) || position === null) return { coverage: "unknown", reason: "pass_did_not_run" };

  const decision = classifyAgainstProtected(
    {
      id,
      kind: "social_zone",
      geometry: point(position.lat, position.lng),
      title: "",
      privacyClass: "place_level",
      renderingPriority: 0,
    },
    zones,
  );
  if (decision.action !== "allow") return { coverage: "unknown", reason: "protected_zone" };
  return { coverage: bucket, reason: "served" };
}

/** Project one served row. Pure; no I/O, no clock unless supplied. */
export function projectDiscoveryCandidate(row: CandidateSourceRow, ctx: CandidateServeContext): DiscoveryCandidate {
  const nowMs = ctx.nowMs ?? Date.now();
  const truthClass = classifyTruth(row, ctx.cacheLevel);
  const scored = ctx.scoredById?.get(row.id);
  const provenance = ctx.provenanceById?.get(row.id) ?? null;
  // Both rankers explain themselves, in their own vocabulary and from their own
  // output: PDE from the per-feature contributions it logs to rank_events, and
  // Compass from the grounded RankingFactor keys its pipeline produced. Neither
  // list is composed here. When no ranker ran, the list stays empty and
  // `rankedBy` says which case that is.
  // The UNCAPPED signal list, in the ranker's own strength order. `whyForUser`
  // caps it for display; `reasons` translates the whole list, because a code is
  // grounded by ANY signal that fired and truncating first would drop a real
  // reason for a display limit that has nothing to do with it.
  const signals =
    ctx.rankedBy === "pde" && scored ? whyForUserFromFeatures(scored.features, Number.POSITIVE_INFINITY)
    : ctx.rankedBy === "compass" && provenance ? provenance.reasons
    : [];
  const whyForUser = signals.slice(0, WHY_FOR_USER_MAX);
  return {
    id: row.id,
    whyNow: whyNowOf(row.id, ctx),
    whyForUser,
    rankedBy: ctx.rankedBy,
    confidence: CONFIDENCE_PRIOR[truthClass as keyof typeof CONFIDENCE_PRIOR] ?? CONFIDENCE_PRIOR.unknown,
    freshness: classifyFreshness(ctx.cacheLevel, ctx.cachedAt, nowMs),
    truthClass,
    coverage: coverageForCandidate(row.id, ctx).coverage,
    provenance,
    reasons: explainReasons(signals),
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
