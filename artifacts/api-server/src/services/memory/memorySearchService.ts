/**
 * memorySearchService — §15 Memory Retrieval and Search, reachable at last.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       §15 "Memory Retrieval and Search"
 *       §18 derivatives are registered and revocable
 *       §28.6 "public search queries a public derivative, never canonical rows
 *             plus post-filtering"
 *
 * CENSUS: H110 (`searchMemories(...)` signature), H111 (graph and deterministic
 *         index before semantic), H112 (ranking dimensions), H113 (hard
 *         namespace isolation), H114 (privacy changes revoke searchable
 *         derivatives). All five are BUILT-BUT-WRONG with ONE blocker between
 *         them, recorded at §15 of the census: "No route imports the module."
 *         `services/memoryRetrieval/searchMemories.ts` is complete, correct and
 *         has never been called by anything a user can reach — its only callers
 *         are the certification harness's in-memory world.
 *
 * This module is the bridge, and it exists because two things had to be true
 * before a route could call `searchMemories` and get an answer rather than a
 * refusal.
 *
 * ── 1. THE DERIVATIVE HAS TO EXIST ─────────────────────────────────────────
 * §28.6 is the reason retrieval reads a REGISTERED derivative instead of
 * canonical rows: a public search that filtered canonical rows would be one
 * forgotten predicate away from serving a private Memory, and there would be no
 * record of where the answer went. `readRegisteredPayload` therefore refuses
 * when nothing is registered — which, until now, was every scope, because
 * census H34 records that "the READ paths still build per request and register
 * nothing."
 *
 * So this module registers before it reads: `projectionStaleness` decides, and
 * `rebuildProjection` writes. Building on demand is not a cache warm-up, it is
 * what makes the cleanup graph real — a derivative that was never registered
 * cannot be revoked when the Memory behind it is deleted, and §18's whole
 * argument is that it must be.
 *
 * ── 2. A REVOKED DERIVATIVE MUST NOT BE REBUILT ────────────────────────────
 * This is the rule that makes H114 mean anything, and it is the one an
 * "ensure it is fresh" helper gets wrong by default. `revokeDerivativesForMemory`
 * marks a registration REVOKED when a privacy decision or a deletion reaches
 * it. A rebuild-if-not-fresh loop would see REVOKED, decide the payload needs
 * refreshing, and resurrect the exact derivative the user's privacy decision
 * destroyed — silently, on the next search. So REVOKED is never rebuilt here;
 * the read is allowed to proceed and `searchMemories` refuses it with
 * `derivative_revoked`, which is a DIFFERENT answer from "nothing matched" and
 * reaches the caller as one.
 *
 * `rebuildProjection` also refuses to overwrite a REVOKED registration on its
 * own, so this is belt and braces rather than the only guard — deliberately,
 * because it is the guard whose absence is invisible until somebody's deleted
 * Memory turns up in a search result.
 *
 * ── 3. THE CALLER DOES NOT CHOOSE THE NAMESPACE ────────────────────────────
 * `searchMemories` enforces namespace isolation on the way in, and it does it
 * correctly — a PRIVATE_PERSONAL request whose viewer is not the owner is
 * refused before any read. But "correctly enforced" is not "safe to expose":
 * if a route passed a client-supplied `{ ownerId, namespace, projection }`
 * straight through, the only thing standing between a stranger and somebody's
 * private timeline would be that one equality check, and any future relaxation
 * of it would be a data breach rather than a bug.
 *
 * So the wire carries an INTENT — "my memories", "my history of this place",
 * "this person's public memories" — and this module derives the namespace, the
 * projection and the scope from it. A namespace the caller named is not a
 * namespace at all.
 */
import type { ClientLike } from "../memoryProjections/derivativeRegistry.js";
import {
  projectionStaleness,
  rebuildProjection,
} from "../memoryProjections/derivativeRegistry.js";
import type { ProjectionId, ProjectionScope } from "../memoryProjections/projectionRegistry.js";
import {
  searchMemories,
  RETRIEVAL_ENGINE_VERSION,
  RANKING_WEIGHTS,
  NAMESPACE_PROJECTIONS,
  type RetrievalNamespace,
  type SearchResult,
  type SearchMemoriesInput,
} from "../memoryRetrieval/searchMemories.js";

/* ============================================================================
 * The intent a caller may express. Not a namespace, not a projection id.
 * ==========================================================================*/

export type MemorySearchIntent =
  /** My own Memories, over my private timeline. */
  | { readonly kind: "mine" }
  /** My own history of one place. */
  | { readonly kind: "mine_place"; readonly placeId: string }
  /** One person's PUBLIC Memories, through the public derivative (§28.6). */
  | { readonly kind: "public"; readonly ownerId: string };

export const MEMORY_SEARCH_INTENTS = ["mine", "mine_place", "public"] as const;

/**
 * The namespaces this surface can reach today, and the one it cannot.
 *
 * SHARED_CREW is DELIBERATELY ABSENT and saying so is the point. Its two
 * projections — `TripMemoryProjection` and `PeopleMemoryProjection` — are built
 * per OWNER (`readProjectionSources` reads `memories` filtered by
 * `scope.owner_id`), so a crew-wide search would have to union one derivative
 * per crew member and decide what happens when one of them is revoked, one is
 * stale and one belongs to somebody who has since left the trip. That is a
 * product decision about what "the crew's memory of this trip" means, not a
 * wiring gap, and inventing an answer here would put a shape on the wire that a
 * later decision would have to break. Census H113 stays BUILT-BUT-WRONG on
 * exactly this, and this constant is the evidence for the grade rather than an
 * argument against it.
 */
export const REACHABLE_NAMESPACES: readonly RetrievalNamespace[] = Object.freeze([
  "PRIVATE_PERSONAL",
  "PUBLIC",
]);

export const UNREACHABLE_NAMESPACES: Readonly<Record<string, string>> = Object.freeze({
  SHARED_CREW:
    "TripMemoryProjection and PeopleMemoryProjection are derived per owner, so a crew-wide derivative would have to union one per member; what that union means when a member's derivative is revoked is a product decision, not a wiring gap",
});

export interface ResolvedTarget {
  readonly namespace: RetrievalNamespace;
  readonly projectionId: ProjectionId;
  readonly scope: ProjectionScope;
}

export type SearchServiceFailure =
  | "invalid_intent"
  | "not_permitted"
  | "registry_unavailable"
  | "derivative_revoked"
  | "derivative_unavailable"
  | "namespace_violation"
  | "filter_unsupported";

export type MemorySearchServiceResult =
  | { readonly ok: true; readonly value: Extract<SearchResult, { ok: true }>["value"] & { readonly target: ResolvedTarget } }
  | { readonly ok: false; readonly reason: SearchServiceFailure; readonly detail: string; readonly retryable: boolean };

function refuse(reason: SearchServiceFailure, detail: string, retryable = false): MemorySearchServiceResult {
  return { ok: false, reason, detail, retryable };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn an intent into a namespace, a projection and a scope — server-side.
 *
 * `viewerId` is the AUTHENTICATED user and is the only identity trusted here.
 * Note what `mine` does with it: the owner is the viewer, full stop. There is
 * no path by which a caller names an owner for a private namespace, so the
 * equality check inside `searchMemories` is a second line rather than the only
 * one.
 */
export function resolveTarget(
  viewerId: string,
  intent: MemorySearchIntent,
): { ok: true; value: ResolvedTarget } | { ok: false; detail: string } {
  const emptyScope = { owner_id: "", viewer_id: null, trip_id: null, place_id: null, person_id: null };
  switch (intent?.kind) {
    case "mine":
      return {
        ok: true,
        value: {
          namespace: "PRIVATE_PERSONAL",
          projectionId: "MemoryTimelineProjection",
          scope: { ...emptyScope, owner_id: viewerId, viewer_id: viewerId },
        },
      };
    case "mine_place": {
      if (typeof intent.placeId !== "string" || intent.placeId.length === 0) {
        return { ok: false, detail: "placeId is required" };
      }
      return {
        ok: true,
        value: {
          namespace: "PRIVATE_PERSONAL",
          projectionId: "PlaceMemoryProjection",
          scope: { ...emptyScope, owner_id: viewerId, viewer_id: viewerId, place_id: intent.placeId },
        },
      };
    }
    case "public": {
      if (typeof intent.ownerId !== "string" || !UUID_RE.test(intent.ownerId)) {
        return { ok: false, detail: "ownerId must be a UUID" };
      }
      return {
        ok: true,
        value: {
          namespace: "PUBLIC",
          projectionId: "PublicMemoryProjection",
          // viewer_id is NULL on purpose. §28.6: a public derivative is built
          // once for its audience, not once per reader. Keying it by viewer
          // would make it a per-viewer filtered read of canonical rows wearing
          // a derivative's name, which is the thing §28.6 forbids.
          scope: { ...emptyScope, owner_id: intent.ownerId, viewer_id: null },
        },
      };
    }
    default:
      return { ok: false, detail: `unknown search intent ${JSON.stringify((intent as any)?.kind)}` };
  }
}

export interface MemorySearchRequest {
  readonly intent: MemorySearchIntent;
  readonly query?: string | null;
  readonly people?: readonly string[];
  readonly place?: string | null;
  readonly trip?: string | null;
  readonly event?: string | null;
  readonly dateRange?: { from?: string | null; to?: string | null } | null;
  readonly memoryType?: string | null;
  readonly limit?: number;
  readonly now?: Date;
}

/**
 * Make sure the derivative this search will read is registered and current.
 *
 * Returns without rebuilding when the registration is REVOKED — see the
 * header. The caller does NOT treat that as an error: the read proceeds and
 * refuses with `derivative_revoked`, so "this index was destroyed by a privacy
 * decision" reaches the person as its own answer rather than as an empty page.
 */
export async function ensureDerivative(
  client: ClientLike,
  target: ResolvedTarget,
  now: Date,
): Promise<{ ok: true; rebuilt: boolean; state: string } | { ok: false; detail: string; retryable: boolean }> {
  const staleness = await projectionStaleness(client, target.projectionId, target.scope);
  if (!staleness.ok) {
    return { ok: false, detail: staleness.detail, retryable: staleness.retryable };
  }
  const state = staleness.value.state;
  if (state === "FRESH" || state === "REVOKED") return { ok: true, rebuilt: false, state };

  const built = await rebuildProjection(client, target.projectionId, target.scope, now);
  if (!built.ok) return { ok: false, detail: built.detail, retryable: built.retryable };
  // `rebuildProjection` reports `was_revoked` when it declined to overwrite a
  // revoked registration. Reaching that branch would mean the staleness read
  // and the rebuild disagreed about the same row; either way the derivative is
  // not resurrected and the read below refuses.
  return { ok: true, rebuilt: !built.value.was_revoked, state };
}

/**
 * §15 retrieval, authorized and reachable.
 *
 * The order is: resolve the target from the intent, register the derivative,
 * then search it. Nothing between the caller and `searchMemories` widens what
 * it may read.
 */
export async function runMemorySearch(
  client: ClientLike,
  viewerId: string,
  request: MemorySearchRequest,
): Promise<MemorySearchServiceResult> {
  const resolved = resolveTarget(viewerId, request.intent);
  if (!resolved.ok) return refuse("invalid_intent", resolved.detail);
  const target = resolved.value;

  const now = request.now ?? new Date();
  const prepared = await ensureDerivative(client, target, now);
  if (!prepared.ok) {
    return refuse("registry_unavailable", prepared.detail, prepared.retryable);
  }

  const input: SearchMemoriesInput = {
    ownerId: target.scope.owner_id,
    viewerId,
    namespace: target.namespace,
    authorizedProjection: target.projectionId,
    people: request.people,
    place: request.place ?? null,
    trip: request.trip ?? null,
    event: request.event ?? null,
    dateRange: request.dateRange ?? null,
    memoryType: request.memoryType ?? null,
    semanticQuery: request.query ?? null,
    limit: request.limit,
    scope: target.scope,
    now,
  };

  const result = await searchMemories(client, input);
  if (!result.ok) {
    switch (result.reason) {
      case "derivative_revoked":
        return refuse("derivative_revoked", result.detail);
      case "derivative_unavailable":
        return refuse("derivative_unavailable", result.detail, result.retryable);
      case "namespace_violation":
      case "projection_not_in_namespace":
        // Unreachable through `resolveTarget`, which only ever produces legal
        // pairings. Mapped rather than collapsed into a generic failure so that
        // if it ever DOES happen it is visible as what it is — an isolation
        // breach attempt — instead of as "search failed".
        return refuse("namespace_violation", result.detail);
      case "filter_not_supported_by_projection":
        return refuse("filter_unsupported", result.detail);
      default:
        return refuse("derivative_unavailable", result.detail);
    }
  }

  return { ok: true, value: { ...result.value, target } };
}

/** What a client needs to render the search surface honestly. */
export function searchCapabilities(): {
  intents: readonly string[];
  namespaces: readonly RetrievalNamespace[];
  unreachableNamespaces: Readonly<Record<string, string>>;
  rankingDimensions: readonly string[];
  /**
   * §15's weights, sent WITH the dimension names.
   *
   * Without them a client that wants to say "this ranked here because it
   * happened near where you asked" has to pick the largest raw value, and the
   * largest raw value is always `privacy_eligibility` — which is 1 on every
   * eligible row and carries a weight of ZERO because it is a GATE, not a
   * contributor. A client ranking by raw value would tell every person, about
   * every result, that it is there because it is shareable. The contribution is
   * value × weight, and the weight has to be on the wire for anyone to compute
   * it.
   */
  rankingWeights: Readonly<Record<string, number>>;
  engineVersion: string;
  /**
   * §15 asks for graph and deterministic index BEFORE semantic, and this
   * repository has no semantic index at all: `defaultSemanticScorer` is token
   * overlap and no model is called on this path. Stated on the wire so a search
   * box cannot imply an understanding the engine does not have. Census H111.
   */
  semanticIndex: "none";
  projectionsByNamespace: Readonly<Record<string, readonly string[]>>;
} {
  return {
    intents: MEMORY_SEARCH_INTENTS,
    namespaces: REACHABLE_NAMESPACES,
    unreachableNamespaces: UNREACHABLE_NAMESPACES,
    rankingDimensions: Object.keys(RANKING_WEIGHTS),
    rankingWeights: RANKING_WEIGHTS,
    engineVersion: RETRIEVAL_ENGINE_VERSION,
    semanticIndex: "none",
    projectionsByNamespace: NAMESPACE_PROJECTIONS as unknown as Readonly<Record<string, readonly string[]>>,
  };
}
