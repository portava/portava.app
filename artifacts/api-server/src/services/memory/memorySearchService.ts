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
} from "../memoryProjections/derivativeRegistry.js"; import { reviveDeletionRevokedDerivative } from "../memoryProjections/narrowingReprojection.js"; // one line: cited by line
import type { ProjectionId, ProjectionScope } from "../memoryProjections/projectionRegistry.js";
import { acceptedCrewOfTrip, canReadMemory } from "./memoryReadPolicy.js";
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
  | { readonly kind: "public"; readonly ownerId: string }
  /**
   * The crew's Memories of ONE trip — SHARED_CREW, served as a union of the
   * trip's current accepted crew members' per-owner `TripMemoryProjection`
   * derivatives. See `runCrewMemorySearch`.
   */
  | { readonly kind: "crew_trip"; readonly tripId: string };

export const MEMORY_SEARCH_INTENTS = ["mine", "mine_place", "public", "crew_trip"] as const;

/**
 * The namespaces this surface can reach. All three of them, as of this change.
 *
 * SHARED_CREW USED TO BE DELIBERATELY ABSENT, and the absence carried an
 * argument: `TripMemoryProjection` and `PeopleMemoryProjection` are built per
 * OWNER (`readProjectionSources` reads `memories` filtered by
 * `scope.owner_id`), so a crew-wide search has to union one derivative per crew
 * member, and the old comment said deciding what that union means "when one of
 * them is revoked, one is stale and one belongs to somebody who has since left
 * the trip" was a product decision rather than a wiring gap.
 *
 * Two thirds of that question turned out to be already answered in the schema,
 * and the remaining third is answered here by construction:
 *
 *  - "somebody who has since left the trip" is not a state this system has.
 *    `trip_members.status` permits 'removed'/'left' (migration 0078) and
 *    NOTHING writes them: REMOVE_PARTICIPANT and DECLINE_INVITE both
 *    `DELETE FROM public.trip_members`, and the only UPDATEs anywhere are role
 *    changes. A departed member is simply not crew, and the durable record of
 *    the departure is the `trip.participant_removed` event row, not a tombstone
 *    on the membership. So the union is over `acceptedCrewOfTrip` and inherits
 *    that rule rather than restating it — the same rule the §23 visibility
 *    ladder (`memoryReadPolicy.ts`) and `GET /trips/:tripId/memories/recap`
 *    already apply.
 *
 *  - "one is stale" is `ensureDerivative`: a STALE registration is rebuilt, and
 *    that is per member exactly as it is for a single target.
 *
 *  - "one is revoked" is the one real decision, and it is recorded at
 *    `CREW_UNION_PARTIAL_POLICY` below.
 */
export const REACHABLE_NAMESPACES: readonly RetrievalNamespace[] = Object.freeze([
  "PRIVATE_PERSONAL",
  "SHARED_CREW",
  "PUBLIC",
]);

/**
 * Empty, and the emptiness is the news.
 *
 * This constant existed to carry SHARED_CREW's reason for being unreachable, and
 * a constant that keeps asserting a reason for something that is no longer true
 * is worse than no constant: `searchCapabilities()` puts it ON THE WIRE, so a
 * stale entry here is a client being told it cannot do something it can. The
 * key is kept (frozen, empty) rather than deleted because the SHAPE is part of
 * the response contract — a client renders "this surface cannot reach X, here is
 * why" from it — and the next namespace that is built-but-unreachable belongs
 * here.
 */
export const UNREACHABLE_NAMESPACES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * THE DECISION, and it is the owner's open question rather than a settled one.
 *
 * A single-target search REFUSES when its derivative is revoked or unreadable:
 * `derivative_revoked` / `derivative_unavailable`, surfaced as 410 / 503, because
 * "this index was destroyed by a privacy decision" is a different answer from
 * "nothing matched". That is right for one target, where the refusal is about
 * the one thing the person asked for.
 *
 * For a UNION it is wrong, and this is the default being built:
 *
 *  - DENIAL OF SERVICE. One crew member revoking their derivative — which a
 *    privacy decision or a single deletion does — would blank the whole crew's
 *    shared memory of the trip for everybody. One person's ordinary, legitimate
 *    privacy action must not be able to take the surface down for five others.
 *
 *  - PRIVACY LEAK BY INFERENCE. The refusal ITSELF is the disclosure. A crew
 *    search that answered yesterday and 410s today tells every other member
 *    that somebody revoked something, which is precisely the fact a revocation
 *    is meant to make unobservable.
 *
 * So: serve the readable members, and NAME the withheld ones. The honesty
 * requirement that makes this safe rather than merely convenient is in
 * `CrewMemberDisclosure` — a partial union must never present as complete, and a
 * member whose derivative could not be READ is reported as WITHHELD, never
 * dropped and never rendered as "this member has no memories". Both of those
 * would be the §28.11 defect this repository keeps finding: a failed read served
 * as a plausible empty result.
 *
 * WHAT IS STILL OPEN, for the owner rather than for this comment: whether a
 * withheld member should be named by USER ID at all. Naming them is what makes
 * the union honest to the five members who are served, and it is also the
 * inference channel above, narrowed from "somebody" to "this person". It is
 * narrowed, not closed. The alternative — a bare count — is strictly less
 * useful and only slightly less revealing on a crew of three.
 */
export const CREW_UNION_PARTIAL_POLICY = "serve_readable_and_name_withheld" as const;

/**
 * N members means N derivative reads, so the fan-out is bounded.
 *
 * THE BOUND, and it is the smallest safe one rather than a considered capacity
 * decision: the 25 lowest member ids, sorted, and every member past that is
 * reported as withheld with `over_member_bound`. Sorted so the cut is
 * deterministic and the same member is never served to one reader and withheld
 * from another; named on the wire so a crew of 30 is never served 25 members'
 * memories as if that were all of them.
 *
 * Per member, the engine is asked for at most `limit` hits (the route caps
 * `limit` at 100), and the union then takes the global top `limit`. Each
 * member's top-`limit` is a superset of its contribution to the global
 * top-`limit`, so this is exact rather than approximate, and it bounds the rows
 * held in memory at 25 × 100. The neighbouring bounds on this surface are
 * TRIP_RECAP_LIMIT = 500 (routes/memories.ts) and GRAPH_MEMORY_LIMIT = 2000.
 *
 * There is no cursor. A crew search is one page, as the single-target search is.
 */
export const CREW_UNION_MEMBER_LIMIT = 25;

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
  | "filter_unsupported"
  /**
   * The §23 audience ladder over a crew union could not read a gate it needed.
   * Its own reason rather than `derivative_unavailable`, because the derivative
   * was fine and the thing that failed was the permission check — and a
   * permission check that cannot establish its result must fail, not pass.
   */
  | "audience_unavailable";

export type MemorySearchServiceResult =
  | { readonly ok: true; readonly value: Extract<SearchResult, { ok: true }>["value"] & { readonly target: ResolvedTarget } }
  | { readonly ok: false; readonly reason: SearchServiceFailure; readonly detail: string; readonly retryable: boolean };

function refuse(reason: SearchServiceFailure, detail: string, retryable = false): MemorySearchServiceResult {
  return { ok: false, reason, detail, retryable };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One member's slice of a crew union.
 *
 * `viewer_id` is NULL, and that is the §28.6 rule rather than an oversight: a
 * SHARED_CREW derivative is built once for its AUDIENCE, not once per reader.
 * Keying it by viewer would make it a per-viewer filtered read of canonical rows
 * wearing a derivative's name, and it would also make the cleanup graph find N
 * rows to revoke where there should be one. `searchMemories` says the same thing
 * in its own words at the scope it assembles.
 *
 * The consequence is the reason the §23 ladder runs over the union in
 * `runCrewMemorySearch`: a derivative that is not keyed by reader cannot have
 * been narrowed for this reader.
 */
export function crewMemberTarget(memberId: string, tripId: string): ResolvedTarget {
  return {
    namespace: "SHARED_CREW",
    projectionId: "TripMemoryProjection",
    scope: { owner_id: memberId, viewer_id: null, trip_id: tripId, place_id: null, person_id: null },
  };
}

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
    case "crew_trip": {
      if (typeof intent.tripId !== "string" || !UUID_RE.test(intent.tripId)) {
        return { ok: false, detail: "tripId must be a UUID" };
      }
      // A crew search has no single owner, so what this returns is the VIEWER's
      // own slice of the union — the one member of it whose identity is already
      // established. `runCrewMemorySearch` re-resolves one target per member
      // through `crewMemberTarget`, which is this same shape with the member's
      // id in it, so there is exactly one place that decides what a crew target
      // looks like. Returning the viewer's slice here (rather than refusing) is
      // what keeps `resolveTarget` total over the intent union and keeps the
      // `target` field on the response meaning the same thing it always did.
      return { ok: true, value: crewMemberTarget(viewerId, intent.tripId) };
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
  now: Date, /** Lead ruling H-5: the OWNER's request may rebuild a derivative a deletion revoked. */ viewerId?: string,
): Promise<{ ok: true; rebuilt: boolean; state: string } | { ok: false; detail: string; retryable: boolean }> {
  const staleness = await projectionStaleness(client, target.projectionId, target.scope);
  if (!staleness.ok) {
    return { ok: false, detail: staleness.detail, retryable: staleness.retryable };
  }
  const state = staleness.value.state;
  if (state === "REVOKED" && viewerId !== undefined && viewerId === target.scope.owner_id && (await reviveDeletionRevokedDerivative(client, target.projectionId, target.scope, now)).state === "revived") return { ok: true, rebuilt: true, state: "REVIVED" }; if (state === "FRESH" || state === "REVOKED") return { ok: true, rebuilt: false, state }; // H-5: only a deletion's revocation, only for its owner; anything else stays REVOKED and is refused below

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
  // A crew search is not a single-target search, and `resolveTarget` would hand
  // this function the VIEWER's own slice of the union — a plausible, wrong,
  // silently-partial answer in which the other five members simply do not
  // appear. Refused here rather than trusted to every future caller.
  if (request.intent?.kind === "crew_trip") {
    return refuse("invalid_intent", "a crew_trip search is a union; call runCrewMemorySearch");
  }
  const resolved = resolveTarget(viewerId, request.intent);
  if (!resolved.ok) return refuse("invalid_intent", resolved.detail);
  const target = resolved.value;

  const now = request.now ?? new Date();
  const prepared = await ensureDerivative(client, target, now, viewerId);
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

/* ============================================================================
 * SHARED_CREW — a crew-wide search over one trip.
 * ==========================================================================*/

/** Why a member of the crew is not in the union. Never "no reason". */
export type CrewWithholdReason =
  /** §18 / H114: this member's derivative was destroyed by a privacy decision. */
  | "derivative_revoked"
  /** The derivative could not be read or registered. A failed read, not an empty one. */
  | "derivative_unavailable"
  /** Past `CREW_UNION_MEMBER_LIMIT`. The fan-out bound, stated rather than hidden. */
  | "over_member_bound";

/**
 * One crew member's line in the union, and the reason this whole change exists.
 *
 * THE SHAPE IS DELIBERATE IN THREE WAYS.
 *
 * 1. EVERY member of the crew gets a line, served or not. A member who is
 *    withheld is therefore impossible to confuse with a member who was never in
 *    the crew, and a reader counting lines gets the crew size.
 *
 * 2. `matchCount` is NULL for a withheld member, never 0. This is the §28.11
 *    rule applied to a field instead of to a status code: 0 would say "this
 *    member has no memories of the trip", which is a claim about the world, and
 *    we do not know it. NULL says we did not look, or looked and failed.
 *
 * 3. `reason` is non-null exactly when `state` is "withheld". A withheld member
 *    with no reason would be the silent omission this requirement exists to
 *    forbid.
 *
 * The idiom is `unenforceableOnFeed` on GET /highlights/resurfacing-controls
 * (routes/highlights.ts): name the thing the surface could not do, on the wire,
 * beside the things it did, so a client renders the gap rather than promising an
 * effect it did not deliver.
 */
export interface CrewMemberDisclosure {
  readonly memberId: string;
  readonly state: "served" | "withheld";
  readonly reason: CrewWithholdReason | null;
  readonly detail: string | null;
  /** Rows this member's derivative contributed. NULL when withheld — never 0. */
  readonly matchCount: number | null;
}

export interface CrewSearchValue {
  readonly hits: Extract<SearchResult, { ok: true }>["value"]["hits"];
  readonly namespace: RetrievalNamespace;
  readonly projection_id: ProjectionId;
  readonly deterministic_match_count: number;
  readonly semantic_rerank_applied: boolean;
  readonly engine_version: string;
  readonly trip_id: string;
  /** Every current accepted crew member, served or withheld. */
  readonly members: readonly CrewMemberDisclosure[];
  /** Just the withheld ones, so a client cannot miss them by not filtering. */
  readonly withheld_members: readonly CrewMemberDisclosure[];
  /**
   * FALSE whenever any member was withheld or any row was withheld by the §23
   * ladder. A partial union must never present as complete, and a boolean a
   * client has to read is harder to ignore than an array it has to filter.
   * Stated on the wire next to `semanticIndex`, which is the same kind of marker
   * for a different ceiling: what this answer does NOT cover.
   */
  readonly union_complete: boolean;
  readonly crew_size: number;
  /**
   * Rows the §23 audience ladder removed from the union. Not per member and not
   * per row: `canReadMemory` returns a bare boolean and logs when a gate read
   * fails, so at row granularity "denied" and "undecidable" are already
   * indistinguishable — that is its own recorded ceiling (see
   * memoryReadPolicy.ts). What this count buys is that the narrowing is VISIBLE
   * at all, so a short page is not read as a complete one.
   */
  readonly audience_withheld_count: number;
  readonly partial_policy: typeof CREW_UNION_PARTIAL_POLICY;
  readonly member_bound: number;
}

export type CrewSearchResult =
  | { readonly ok: true; readonly value: CrewSearchValue }
  | { readonly ok: false; readonly reason: SearchServiceFailure; readonly detail: string; readonly retryable: boolean };

/** Columns the §23 ladder reads. Nothing here is ever served to the caller. */
const LADDER_COLUMNS = "id, owner_id, visibility, state, trip_id, allowed_user_ids, hidden_user_ids";
const LADDER_CHUNK = 100;

function serve(memberId: string, matchCount: number): CrewMemberDisclosure {
  return { memberId, state: "served", reason: null, detail: null, matchCount };
}

function withhold(memberId: string, reason: CrewWithholdReason, detail: string): CrewMemberDisclosure {
  return { memberId, state: "withheld", reason, detail, matchCount: null };
}

/**
 * §15 retrieval over SHARED_CREW: the crew's Memories of one trip.
 *
 * ── AUTHORIZATION IS ONE RULE, NOT TWO ─────────────────────────────────────
 * `acceptedCrewOfTrip` decides both halves: whether the VIEWER may run the
 * search, and which members' derivatives may be in it. There is no second
 * membership predicate here, which matters because the first thing the §23
 * ladder's own comments record is that the trip_crew rule had been written three
 * times and the loosest copy admitted role='invited' and status='removed'.
 * Reusing that function also means a DEPARTED member needs no handling at all:
 * `REMOVE_PARTICIPANT` and `DECLINE_INVITE` DELETE the `trip_members` row, so a
 * departed member is absent from `crew.ids` and absent from the union, and there
 * is no "formerly crew" state to invent.
 *
 * It fails CLOSED: an unreadable `trip_members` or `trips` is a refusal, not an
 * empty crew — an empty crew would be served as "nobody on this trip has any
 * memories", which is the §28.11 defect.
 *
 * ── THE PROJECTION IS NOT THE PERMISSION ───────────────────────────────────
 * This is the part a union gets wrong by default, and it is why the ladder runs
 * below. `TripMemoryProjection.build` filters to the scope owner's undeleted
 * Memories on the trip and runs NO audience ladder — `GET
 * /trips/:tripId/memories/recap` says so in its own header and handles it by
 * running `canReadMemory(..., "trip")` per row BEFORE it calls the builder. The
 * search path cannot do that: it reads a REGISTERED derivative (§28.6), the
 * registration is keyed by audience rather than by reader, and so the payload it
 * reads back contains every one of that member's trip Memories including the
 * `only_me` ones. `TRIP_FIELDS` does not even carry `visibility`, so the rows
 * themselves cannot be filtered on their own contents.
 *
 * So the ladder runs as an INTERSECTION after the read: the derivative decides
 * which rows and which FIELDS exist (the whitelist stays structural, and no
 * canonical column is ever served), and `canReadMemory` decides whether this
 * viewer may have each of them. It can only ever narrow. A hit whose canonical
 * row cannot be found is withheld rather than served, because a row we cannot
 * check is a row we cannot clear.
 */
export async function runCrewMemorySearch(
  client: ClientLike,
  viewerId: string,
  request: MemorySearchRequest,
): Promise<CrewSearchResult> {
  const intent = request.intent;
  if (intent?.kind !== "crew_trip") {
    return { ok: false, reason: "invalid_intent", detail: "runCrewMemorySearch serves the crew_trip intent only", retryable: false };
  }
  if (typeof intent.tripId !== "string" || !UUID_RE.test(intent.tripId)) {
    return { ok: false, reason: "invalid_intent", detail: "tripId must be a UUID", retryable: false };
  }
  const tripId = intent.tripId;

  // The trip is SCOPE here, not a filter — `TRIP_FIELDS` has no `trip_id` at
  // all, so the engine would (correctly) refuse `trip` as an unanswerable
  // predicate. A caller who sends it is not having a predicate dropped: the
  // scope enforces exactly that equality on every row in the union. A caller who
  // sends a DIFFERENT trip is asking two incompatible questions, and is refused.
  if (request.trip != null && request.trip !== tripId) {
    return {
      ok: false, reason: "invalid_intent", retryable: false,
      detail: `trip filter ${request.trip} contradicts the crew scope ${tripId}`,
    };
  }

  const sc = client as any;
  const crew = await acceptedCrewOfTrip(sc, tripId);
  if (!crew.ok) {
    return {
      ok: false, reason: "registry_unavailable", retryable: true,
      detail: `crew membership unreadable for trip ${tripId}; refusing rather than searching an empty crew`,
    };
  }
  if (!crew.ids.has(viewerId)) {
    return { ok: false, reason: "not_permitted", detail: "only the trip's accepted crew can search its memories", retryable: false };
  }

  // Sorted so the fan-out bound cuts the same crew the same way for every
  // reader: a member must not be served to one and withheld from another.
  const allMembers = [...crew.ids].sort();
  const inBound = allMembers.slice(0, CREW_UNION_MEMBER_LIMIT);
  const overBound = allMembers.slice(CREW_UNION_MEMBER_LIMIT);

  const now = request.now ?? new Date();
  const perMemberLimit = typeof request.limit === "number" && request.limit > 0 ? request.limit : undefined;
  const disclosures: CrewMemberDisclosure[] = [];
  const merged: Extract<SearchResult, { ok: true }>["value"]["hits"] = [];
  const ownerOfHit = new Map<string, string>();
  let deterministic = 0;
  let rerankApplied = false;

  for (const memberId of inBound) {
    const target = crewMemberTarget(memberId, tripId);
    const prepared = await ensureDerivative(client, target, now, viewerId);
    if (!prepared.ok) {
      disclosures.push(withhold(memberId, "derivative_unavailable", prepared.detail));
      continue;
    }

    const result = await searchMemories(client, {
      ownerId: memberId,
      viewerId,
      namespace: target.namespace,
      authorizedProjection: target.projectionId,
      people: request.people,
      place: request.place ?? null,
      // Not `request.trip`: see the contradiction check above. The scope carries it.
      trip: null,
      event: request.event ?? null,
      dateRange: request.dateRange ?? null,
      memoryType: request.memoryType ?? null,
      semanticQuery: request.query ?? null,
      // Each member is asked for at most one page. Its top-`limit` is a superset
      // of its contribution to the union's top-`limit`, so the merge below is
      // exact, and the rows held in memory are bounded at members × limit.
      limit: perMemberLimit,
      scope: target.scope,
      now,
    });

    if (!result.ok) {
      // ONE member's revocation must not blank the crew's shared memory — see
      // CREW_UNION_PARTIAL_POLICY. Withheld and named, not propagated.
      const reason: CrewWithholdReason = result.reason === "derivative_revoked" ? "derivative_revoked" : "derivative_unavailable";
      disclosures.push(withhold(memberId, reason, result.detail));
      continue;
    }

    deterministic += result.value.deterministic_match_count;
    rerankApplied = rerankApplied || result.value.semantic_rerank_applied;
    for (const hit of result.value.hits) {
      merged.push(hit);
      ownerOfHit.set(hit.memory_id, memberId);
    }
    disclosures.push(serve(memberId, result.value.deterministic_match_count));
  }

  for (const memberId of overBound) {
    disclosures.push(withhold(
      memberId,
      "over_member_bound",
      `this crew has ${allMembers.length} accepted members and this surface unions at most ${CREW_UNION_MEMBER_LIMIT}`,
    ));
  }

  // ── §23, over the union. See the header: the derivative was not narrowed for
  //    this reader, so it is narrowed here, and it is narrowed rather than
  //    re-derived — nothing below serves a canonical column.
  let audienceWithheld = 0;
  let cleared = merged;
  if (merged.length > 0) {
    const ids = [...new Set(merged.map((h) => h.memory_id))];
    const canonical = new Map<string, any>();
    for (let i = 0; i < ids.length; i += LADDER_CHUNK) {
      const batch = ids.slice(i, i + LADDER_CHUNK);
      // supabase-js RESOLVES a PostgREST rejection with `{ error }` rather than
      // throwing (CONTRIBUTING.md records this exact defect against rankLog), so
      // the error is bound and inspected. A try/catch here would read an
      // unreadable `memories` as "nobody may see anything" — a silent, total,
      // plausible denial.
      const { data, error } = await sc.from("memories").select(LADDER_COLUMNS).in("id", batch);
      if (error) {
        return {
          ok: false, reason: "audience_unavailable", retryable: true,
          detail: `the audience ladder could not read memories for trip ${tripId}: ${(error as any)?.message ?? "unknown error"}`,
        };
      }
      if (!Array.isArray(data)) {
        return {
          ok: false, reason: "audience_unavailable", retryable: true,
          detail: "the audience ladder's memories read returned no row array",
        };
      }
      for (const row of data as any[]) canonical.set(row.id as string, row);
    }

    const verdicts = await Promise.all(merged.map(async (hit) => {
      const row = canonical.get(hit.memory_id);
      // A row we cannot find is a row we cannot clear. The derivative said it
      // exists, so this is a disagreement between the derivative and canonical
      // storage, and the safe reading of a disagreement is to withhold.
      if (!row) return false;
      const owner = ownerOfHit.get(hit.memory_id);
      if (owner !== undefined && owner === viewerId) return true;
      return canReadMemory(sc, row, viewerId, "trip");
    }));
    cleared = merged.filter((_h, i) => verdicts[i]);
    audienceWithheld = merged.length - cleared.length;
  }

  const sorted = [...cleared].sort((a, b) => b.score - a.score || a.memory_id.localeCompare(b.memory_id));
  // The page can be SHORTER than `limit` when the ladder withheld rows a member's
  // own page already spent. `audience_withheld_count` and `union_complete` are
  // what keep that from reading as "there was nothing more".
  const hits = perMemberLimit === undefined ? sorted : sorted.slice(0, perMemberLimit);

  const withheldMembers = disclosures.filter((d) => d.state === "withheld");
  return {
    ok: true,
    value: {
      hits,
      namespace: "SHARED_CREW",
      projection_id: "TripMemoryProjection",
      deterministic_match_count: deterministic,
      semantic_rerank_applied: rerankApplied,
      engine_version: RETRIEVAL_ENGINE_VERSION,
      trip_id: tripId,
      members: disclosures,
      withheld_members: withheldMembers,
      union_complete: withheldMembers.length === 0 && audienceWithheld === 0,
      crew_size: allMembers.length,
      audience_withheld_count: audienceWithheld,
      partial_policy: CREW_UNION_PARTIAL_POLICY,
      member_bound: CREW_UNION_MEMBER_LIMIT,
    },
  };
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
  /**
   * SHARED_CREW's two ceilings, on the wire for the same reason
   * `semanticIndex: "none"` is: a client must be able to render what this answer
   * does NOT cover. `partialPolicy` tells it a crew search can come back partial
   * at all; `memberBound` tells it the crew size past which it certainly will.
   */
  crewUnion: { partialPolicy: typeof CREW_UNION_PARTIAL_POLICY; memberBound: number };
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
    crewUnion: { partialPolicy: CREW_UNION_PARTIAL_POLICY, memberBound: CREW_UNION_MEMBER_LIMIT },
  };
}
