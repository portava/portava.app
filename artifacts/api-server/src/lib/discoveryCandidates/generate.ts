/**
 * Candidate generation — `06` §1 stage 2 for the PDE path, census-discovery
 * §85 (lane W10-R3), DC-12 / DV-49.
 *
 * The caller's pool (the route's OSM directory and curated/canonical reads) is
 * kept exactly as handed in, in its own order. The §85 retrievals run in
 * parallel; ids they name that are already in the pool CLAIM that row (its
 * attribution gains the source); ids that are not are materialised under the
 * route's own eligibility rules (materialize.ts) and APPENDED after the pool.
 * The ranker then orders the union — generation decides what may be ranked,
 * never where it lands.
 *
 * Bounded: at most PER_SOURCE_LIMIT ids per source reach materialisation, and
 * at most MAX_GENERATED rows are added, taken round-robin across sources in
 * GENERATION_ORDER so no one source can fill the page by volume.
 */
import type { PdePlace, PdeViewer } from "../discoveryPde.js";
import type { GeneratedCandidateSource, PdeCandidateSource } from "./candidateSources.js";
import {
  cityPrefixOf,
  retrieveCircleContext, retrieveCurrentTrail, retrieveEmergingDiscoveries, retrieveExplorationPool,
  retrieveFollowedCreators, retrieveGraphRelated, retrieveRelatedTrails, retrieveSavedSimilar,
  retrieveTrendingLocal, retrieveTripDestination,
  type RetrievalContext, type RetrievalOutcome, type RetrievalStatus,
} from "./retrievals.js";
import { materialiseCandidates, type MaterialiseOutcome } from "./materialize.js";

/** Most rows generation adds to one request's candidate set. */
export const MAX_GENERATED = 60;

/** Round-robin order for the cap: the viewer's own stated context first, the city's signals last. */
export const GENERATION_ORDER: readonly GeneratedCandidateSource[] = [
  "current_trail", "followed_creators", "trip_destination", "saved_similar", "related_trails",
  "graph_related", "social_circle", "trending_local", "emerging_discoveries", "exploration_pool",
];

export interface SourceReport {
  status: RetrievalStatus | "flag_off";
  /** Ids the retrieval returned. */
  retrieved: number;
  /** Of those, rows already in the caller's pool (claimed, not added). */
  claimedFromPool: number;
  /** Rows this source added to the candidate set. */
  added: number;
  failedRead?: string;
}

export interface GenerationReport {
  /** Why nothing ran, when nothing did. */
  skipped?: "no_city" | "no_client" | "not_served" | "threw";
  sources: Partial<Record<GeneratedCandidateSource, SourceReport>>;
  generated: number;
  admittedCategories: string[] | "all";
  materialiseFailedReads: string[];
  refused: MaterialiseOutcome["refused"];
}

export interface GenerationOutcome<T extends PdePlace> {
  /** The pool, unchanged and in order, then the generated rows. */
  places: T[];
  /** Every candidate's attribution: `caller_pool` and/or the sources that named it. */
  sourcesById: Map<string, PdeCandidateSource[]>;
  /** Submitter of each GENERATED authored row — PDE-internal (DV-53's new-creator bucket), never serialised. */
  submitterById: Map<string, string>;
  report: GenerationReport;
}

export interface GenerateOptions {
  nowMs: number;
  /** The tab. `for_you`/absent-with-a-mixed-pool admits every category; see `admittedCategoriesFor`. */
  category?: string | null;
  /** `discovery_circle_candidates_enabled` — the consent-gated source (D-W10-R3-4). */
  circle: boolean;
}

/**
 * Which categories a generated row may carry. An explicit tab admits only that
 * tab (primary or secondary, as `queryDbPlaces` does). With no tab named, the
 * categories the caller's pool already carries — generation may add rows of
 * the kinds the caller's own retrieval returned, never widen the page to a kind
 * the tab excluded (D-W10-R3-1). `for_you` admits all.
 */
export function admittedCategoriesFor(pool: readonly PdePlace[], category: string | null | undefined): ReadonlySet<string> | null {
  if (category === "for_you") return null;
  if (typeof category === "string" && category.length > 0) return new Set([category]);
  return new Set(pool.map((p) => p.category).filter((c): c is string => typeof c === "string" && c.length > 0));
}

function dedupKey(p: { name?: unknown; lat?: number | null; lng?: number | null }): string | null {
  const name = typeof p.name === "string" ? p.name.toLowerCase().trim() : "";
  if (!name) return null;
  if (p.lat == null || p.lng == null) return name;
  return `${name}@${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
}

export async function generateCandidates<T extends PdePlace>(
  sc: any, pool: T[], viewer: PdeViewer, opts: GenerateOptions,
): Promise<GenerationOutcome<T>> {
  const sourcesById = new Map<string, PdeCandidateSource[]>();
  for (const p of pool) sourcesById.set(p.id, ["caller_pool"]);
  const admitted = admittedCategoriesFor(pool, opts.category);
  const report: GenerationReport = {
    sources: {}, generated: 0, admittedCategories: admitted ? [...admitted].sort() : "all",
    materialiseFailedReads: [], refused: { blocked: 0, standing: 0, demo: 0, category: 0 },
  };
  const cityPrefix = cityPrefixOf(viewer.city);
  if (!sc) return { places: pool, sourcesById, submitterById: new Map(), report: { ...report, skipped: "no_client" } };
  if (!cityPrefix) return { places: pool, sourcesById, submitterById: new Map(), report: { ...report, skipped: "no_city" } };

  const ctx: RetrievalContext = {
    sc, userId: viewer.userId, cityPrefix, followedIds: viewer.followedIds,
    viewedPlaceIds: Object.keys(viewer.placeAffinities ?? {}).sort(), nowMs: opts.nowMs, memo: new Map(),
  };
  const runs: Array<Promise<RetrievalOutcome>> = [
    retrieveCurrentTrail(ctx), retrieveFollowedCreators(ctx), retrieveTripDestination(ctx), retrieveSavedSimilar(ctx),
    retrieveRelatedTrails(ctx), retrieveGraphRelated(ctx),
    ...(opts.circle ? [retrieveCircleContext(ctx)] : []),
    retrieveTrendingLocal(ctx), retrieveEmergingDiscoveries(ctx), retrieveExplorationPool(ctx),
  ];
  const outcomes = await Promise.all(runs);
  if (!opts.circle) report.sources.social_circle = { status: "flag_off", retrieved: 0, claimedFromPool: 0, added: 0 };
  const bySource = new Map(outcomes.map((o) => [o.source, o]));

  // Claim pool rows; collect the rest for one materialisation.
  const poolIds = new Set(pool.map((p) => p.id));
  const wanted = new Set<string>();
  for (const o of outcomes) {
    let claimed = 0;
    for (const id of o.ids) {
      if (poolIds.has(id)) { claimed++; const s = sourcesById.get(id)!; if (!s.includes(o.source)) s.push(o.source); }
      else wanted.add(id);
    }
    report.sources[o.source] = {
      status: o.status, retrieved: o.ids.length, claimedFromPool: claimed, added: 0,
      ...(o.failedRead ? { failedRead: o.failedRead } : {}),
    };
  }

  const mat = await materialiseCandidates(sc, [...wanted].sort(), { viewerId: viewer.userId, cityPrefix, admitted });
  report.materialiseFailedReads = mat.failedReads;
  report.refused = mat.refused;

  // Round-robin across sources, skipping a row the pool already carries under
  // another id (the route's own name@coords dedup key).
  const seenKeys = new Set(pool.map((p) => dedupKey(p as { name?: unknown; lat?: number | null; lng?: number | null })).filter((k): k is string => !!k));
  const queues = GENERATION_ORDER.map((s) => ({ s, ids: (bySource.get(s)?.ids ?? []).filter((id) => !poolIds.has(id)), i: 0 }));
  const added: T[] = [];
  const addedIds = new Set<string>();
  let progressed = true;
  while (added.length < MAX_GENERATED && progressed) {
    progressed = false;
    for (const q of queues) {
      if (added.length >= MAX_GENERATED) break;
      while (q.i < q.ids.length) {
        const id = q.ids[q.i++]!;
        const row = mat.rows.get(id);
        if (!row) continue;
        if (addedIds.has(id)) { const s = sourcesById.get(id)!; if (!s.includes(q.s)) s.push(q.s); continue; }
        const key = dedupKey(row);
        if (key && seenKeys.has(key)) continue;
        if (key) seenKeys.add(key);
        // The row is `routes/discovery.ts` DiscoveryPlace, field for field
        // (materialize.ts); T is the caller's place type, which on every
        // serve path is DiscoveryPlace. The cast is the one place that
        // structural claim is made, and the M-series tests pin its fields.
        added.push(row as unknown as T);
        addedIds.add(id);
        sourcesById.set(id, [q.s]);
        report.sources[q.s]!.added++;
        progressed = true;
        break;
      }
    }
  }
  // A later source that named an already-added row is recorded too.
  for (const o of outcomes) for (const id of o.ids) {
    if (addedIds.has(id)) { const s = sourcesById.get(id)!; if (!s.includes(o.source)) s.push(o.source); }
  }
  report.generated = added.length;
  const submitterById = new Map([...mat.submitterById].filter(([id]) => addedIds.has(id)));
  return { places: added.length > 0 ? [...pool, ...added] : pool, sourcesById, submitterById, report };
}
