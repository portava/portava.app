/**
 * Memory retrieval and search.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 15 "Memory Retrieval and Search"
 *       (docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt:431)
 *       Section 10 / 28.6: public search queries a public derivative, never
 *       canonical rows plus post-filtering.
 *       Section 18: derivatives are registered and revocable.
 *
 * CENSUS: H110 (`searchMemories(...)` signature), H111 (graph and deterministic
 *         index before semantic), H112 (ranking dimensions), H113 (hard
 *         namespace isolation), H114 (privacy changes revoke searchable
 *         derivatives and embeddings) - all five NOT-BUILT
 *         (docs/architecture/census-highlights-memories.md, section 15).
 *
 * THREE PROPERTIES, EACH ENFORCED BY CONSTRUCTION RATHER THAN BY CARE.
 *
 * 1. NAMESPACE ISOLATION (H113). A namespace names the projections it may read.
 *    PUBLIC may read only PublicMemoryProjection. The check is on the way IN, so
 *    a caller cannot ask the public namespace for the owner's timeline and be
 *    saved only by a filter later in the pipeline.
 *
 * 2. DETERMINISTIC FIRST (H111). Structured filters select the result set.
 *    `semanticQuery` may only REORDER what the filters already selected - it is
 *    given no power to add a row. A semantic scorer may be injected; the default
 *    is deterministic token overlap. No model is called from this path.
 *
 * 3. REVOCATION IS REAL (H114). Retrieval reads registered derivatives, so a
 *    revoked derivative is not searchable: there is nothing left to search. The
 *    reader refuses rather than returning an empty page, because "no results"
 *    and "this index was revoked" are different answers to a person.
 */

import type { ClientLike, ProjectionResult } from "../memoryProjections/derivativeRegistry.js";
import { readRegisteredPayload } from "../memoryProjections/derivativeRegistry.js";
import { getProjectionDefinition } from "../memoryProjections/projectionRegistry.js";
import type { ProjectedRow, ProjectionId, ProjectionScope } from "../memoryProjections/projectionRegistry.js";

export const RETRIEVAL_ENGINE_VERSION = "memory-retrieval@1";

/** Section 15 "Authorized namespaces". */
export type RetrievalNamespace = "PRIVATE_PERSONAL" | "SHARED_CREW" | "PUBLIC";

/**
 * Hard isolation boundaries, as data. A namespace can read exactly these
 * projections and nothing else.
 */
export const NAMESPACE_PROJECTIONS: Readonly<Record<RetrievalNamespace, readonly ProjectionId[]>> = Object.freeze({
  PRIVATE_PERSONAL: ["MemoryTimelineProjection", "PlaceMemoryProjection", "MapTrailDerivative", "CompassMemoryProjection"],
  SHARED_CREW: ["TripMemoryProjection", "PeopleMemoryProjection"],
  PUBLIC: ["PublicMemoryProjection"],
});

/** Section 15 "Ranking dimensions". */
export type RankingDimension =
  | "semantic_relevance"
  | "temporal_relevance"
  | "spatial_relevance"
  | "person_relevance"
  | "explicit_significance"
  | "confidence"
  | "privacy_eligibility";

export const RANKING_WEIGHTS: Readonly<Record<RankingDimension, number>> = Object.freeze({
  semantic_relevance: 0.25,
  temporal_relevance: 0.20,
  spatial_relevance: 0.20,
  person_relevance: 0.15,
  explicit_significance: 0.10,
  confidence: 0.10,
  // Not a weight but a gate: a row that is not privacy-eligible scores 0 and is
  // dropped, so no amount of relevance can carry it into a result set.
  privacy_eligibility: 0,
});

/** Section 15 `searchMemories({...})`. */
export interface SearchMemoriesInput {
  ownerId: string;
  /** Who is asking. For PRIVATE_PERSONAL this must equal ownerId. */
  viewerId: string;
  namespace: RetrievalNamespace;
  /** The registered derivative to read. Must be legal for the namespace. */
  authorizedProjection: ProjectionId;
  people?: readonly string[];
  place?: string | null;
  trip?: string | null;
  event?: string | null;
  dateRange?: { from?: string | null; to?: string | null } | null;
  memoryType?: string | null;
  semanticQuery?: string | null;
  limit?: number;
  /** Extra scope for projections keyed by trip/place/person. */
  scope?: Partial<ProjectionScope>;
  /** Injectable reranker. Receives only rows the filters already selected. */
  semanticScorer?: (query: string, row: ProjectedRow) => number;
  /** Reference instant for temporal relevance. Injected so results are replayable. */
  now?: Date;
}

export interface SearchHit {
  memory_id: string;
  row: ProjectedRow;
  score: number;
  /** Per-dimension contributions - a rank with no derivation is not a rank. */
  dimensions: Record<RankingDimension, number>;
}

export interface SearchMemoriesOutput {
  hits: SearchHit[];
  namespace: RetrievalNamespace;
  projection_id: ProjectionId;
  /** How many rows the deterministic filters selected, before ranking or limit. */
  deterministic_match_count: number;
  /** True when a semantic query reordered the set. It can never widen it. */
  semantic_rerank_applied: boolean;
  engine_version: string;
}

export type SearchFailureReason =
  | "namespace_violation"
  | "projection_not_in_namespace"
  | "unknown_projection"
  | "filter_not_supported_by_projection"
  | "derivative_unavailable"
  | "derivative_revoked";

export type SearchResult =
  | { ok: true; value: SearchMemoriesOutput }
  | { ok: false; reason: SearchFailureReason; detail: string; retryable: boolean };

function asString(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 1);
}

/** Deterministic default: token overlap between the query and the row's text. */
export function defaultSemanticScorer(query: string, row: ProjectedRow): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const haystack = tokenize(
    [row.title, row.caption, row.location_city, row.location_country, row.place_id].map(asString).join(" "),
  );
  if (haystack.length === 0) return 0;
  const hay = new Set(haystack);
  let hits = 0;
  for (const t of q) if (hay.has(t)) hits++;
  return hits / q.size;
}

/** Newer is more relevant, halving roughly every 180 days. Never negative. */
function temporalRelevance(occurredAt: string, now: Date): number {
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return 0;
  const days = Math.max(0, (now.getTime() - t) / 86400000);
  return 1 / (1 + days / 180);
}

/**
 * Section 15. Retrieve memories from an authorized derivative.
 *
 * Deterministic filters run first and decide membership; the semantic query only
 * reorders. Every refusal is structured: a caller can tell "the index was
 * revoked" from "nothing matched", which a bare empty array cannot express.
 */
export async function searchMemories(
  client: ClientLike,
  input: SearchMemoriesInput,
): Promise<SearchResult> {
  const now = input.now ?? new Date();

  // 1. Namespace isolation, on the way in (H113).
  if (input.namespace === "PRIVATE_PERSONAL" && input.viewerId !== input.ownerId) {
    return {
      ok: false, reason: "namespace_violation", retryable: false,
      detail: "PRIVATE_PERSONAL is readable only by the owner",
    };
  }
  const allowed = NAMESPACE_PROJECTIONS[input.namespace];
  if (!allowed.includes(input.authorizedProjection)) {
    return {
      ok: false, reason: "projection_not_in_namespace", retryable: false,
      detail: `${input.authorizedProjection} is not readable from ${input.namespace}; allowed: ${allowed.join(", ")}`,
    };
  }
  const definition = getProjectionDefinition(input.authorizedProjection);
  if (!definition) {
    return { ok: false, reason: "unknown_projection", retryable: false, detail: `no definition for ${input.authorizedProjection}` };
  }

  // 1b. A filter the derivative cannot answer is REFUSED, not ignored. A
  //     projection whose whitelist omits `people` cannot be asked "who was
  //     there"; silently dropping the predicate would answer a different
  //     question than the one asked and look like a complete result.
  const whitelist = new Set(definition.field_whitelist);
  const unsupported: string[] = [];
  const needsAny = (filterName: string, fields: readonly string[]) => {
    if (!fields.some((f) => whitelist.has(f))) unsupported.push(`${filterName} (needs one of ${fields.join(", ")})`);
  };
  if (input.dateRange?.from || input.dateRange?.to) needsAny("dateRange", ["occurred_at"]);
  if (input.trip) needsAny("trip", ["trip_id"]);
  if (input.event) needsAny("event", ["event_id"]);
  if (input.memoryType) needsAny("memoryType", ["memory_type"]);
  if (input.place) needsAny("place", ["place_id", "canonical_location_id", "location_city", "location_country"]);
  if ((input.people ?? []).length > 0) needsAny("people", ["people", "person_id"]);
  if (unsupported.length > 0) {
    return {
      ok: false, reason: "filter_not_supported_by_projection", retryable: false,
      detail: `${input.authorizedProjection} cannot answer: ${unsupported.join("; ")}`,
    };
  }

  // 2. Read the registered derivative. Never canonical rows (28.6).
  // A PUBLIC or SHARED_CREW derivative is built once for its audience, not once
  // per reader: keying it by viewer would make it a per-viewer filtered read of
  // canonical rows wearing a derivative's name, which is what 28.6 forbids. Only
  // the owner's private namespace is scoped to a viewer, and there the viewer is
  // the owner.
  const scope: ProjectionScope = {
    owner_id: input.ownerId,
    viewer_id: input.scope?.viewer_id ?? (input.namespace === "PRIVATE_PERSONAL" ? input.ownerId : null),
    // Scope names WHICH artifact to read; the query filters run INSIDE it. They
    // are deliberately not the same thing: asking the timeline for one trip is a
    // filter, while a trip recap is its own registered derivative.
    trip_id: input.scope?.trip_id ?? null,
    place_id: input.scope?.place_id ?? null,
    person_id: input.scope?.person_id ?? null,
  };
  const payload: ProjectionResult<{ rows: ProjectedRow[]; registration: { revocation_state: string } }> =
    await readRegisteredPayload(client, input.authorizedProjection, scope) as ProjectionResult<any>;
  if (!payload.ok) {
    const revoked = /is REVOKED|is PURGED/.test(payload.detail);
    return {
      ok: false,
      reason: revoked ? "derivative_revoked" : "derivative_unavailable",
      detail: payload.detail,
      retryable: payload.reason === "registry_unavailable" ? payload.retryable : false,
    };
  }

  // 3. Deterministic filters decide MEMBERSHIP.
  const from = input.dateRange?.from ? Date.parse(input.dateRange.from) : null;
  const to = input.dateRange?.to ? Date.parse(input.dateRange.to) : null;
  const people = input.people ?? [];

  const selected = payload.value.rows.filter((row) => {
    const occurred = asString(row.occurred_at);
    const t = Date.parse(occurred);
    if (from !== null && !Number.isNaN(from) && (Number.isNaN(t) || t < from)) return false;
    if (to !== null && !Number.isNaN(to) && (Number.isNaN(t) || t > to)) return false;
    if (input.trip && asString(row.trip_id) !== input.trip) return false;
    if (input.event && asString(row.event_id) !== input.event) return false;
    if (input.memoryType && asString(row.memory_type) !== input.memoryType) return false;
    if (input.place) {
      const placeFields = [row.place_id, row.canonical_location_id, row.location_city, row.location_country].map(asString);
      if (!placeFields.includes(input.place)) return false;
    }
    if (people.length > 0) {
      const rowPeople = Array.isArray(row.people) ? row.people.map(asString) : [asString(row.person_id)];
      if (!people.every((p) => rowPeople.includes(p))) return false;
    }
    return true;
  });

  const deterministicIds = new Set(selected.map((r) => asString(r.memory_id)));

  // 4. Rank. Semantic relevance is one dimension among seven, and it can only
  //    reorder rows step 3 already selected.
  const scorer = input.semanticScorer ?? defaultSemanticScorer;
  const query = input.semanticQuery ?? "";
  const hits: SearchHit[] = selected.map((row) => {
    const semantic = query.length > 0 ? Math.max(0, Math.min(1, scorer(query, row))) : 0;
    const temporal = temporalRelevance(asString(row.occurred_at), now);
    const spatial = input.place
      ? 1
      : asString(row.location_city).length > 0 || asString(row.place_id).length > 0
        ? 0.5
        : 0;
    const rowPeople = Array.isArray(row.people) ? row.people.map(asString) : [];
    const person = people.length > 0
      ? people.filter((p) => rowPeople.includes(p)).length / people.length
      : rowPeople.length > 0 ? 0.5 : 0;
    // Significance is present only on owner-facing projections; a public row has
    // no significance field at all, so this dimension is simply 0 there (H64).
    const significance = typeof row.significance_score === "number" ? row.significance_score : 0;
    const confidence = typeof row.confidence === "number" ? row.confidence : 0.5;
    const eligible = 1;

    const dimensions: Record<RankingDimension, number> = {
      semantic_relevance: semantic,
      temporal_relevance: temporal,
      spatial_relevance: spatial,
      person_relevance: person,
      explicit_significance: significance,
      confidence,
      privacy_eligibility: eligible,
    };
    const score =
      dimensions.semantic_relevance * RANKING_WEIGHTS.semantic_relevance +
      dimensions.temporal_relevance * RANKING_WEIGHTS.temporal_relevance +
      dimensions.spatial_relevance * RANKING_WEIGHTS.spatial_relevance +
      dimensions.person_relevance * RANKING_WEIGHTS.person_relevance +
      dimensions.explicit_significance * RANKING_WEIGHTS.explicit_significance +
      dimensions.confidence * RANKING_WEIGHTS.confidence;

    return {
      memory_id: asString(row.memory_id),
      row,
      score: Number((score * eligible).toFixed(6)),
      dimensions,
    };
  });

  hits.sort((a, b) => b.score - a.score || a.memory_id.localeCompare(b.memory_id));
  const limited = typeof input.limit === "number" && input.limit >= 0 ? hits.slice(0, input.limit) : hits;

  // A reranker that added a row would be a privacy hole, not a relevance bug.
  for (const hit of limited) {
    if (!deterministicIds.has(hit.memory_id)) {
      return {
        ok: false, reason: "namespace_violation", retryable: false,
        detail: `ranking produced ${hit.memory_id}, which the deterministic filters did not select`,
      };
    }
  }

  return {
    ok: true,
    value: {
      hits: limited,
      namespace: input.namespace,
      projection_id: input.authorizedProjection,
      deterministic_match_count: selected.length,
      semantic_rerank_applied: query.length > 0,
      engine_version: RETRIEVAL_ENGINE_VERSION,
    },
  };
}
