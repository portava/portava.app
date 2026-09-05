/**
 * WallProjectionService — projects canonical objects into Wall shapes.
 *
 * OWNS (spec TABLE 2): the projection of canonical objects (Posts, Postcards,
 * video, Shared Moments, stories/quick media) into WallProjection shapes.
 * DOES NOT OWN: canonical social/media/place truth — every value it emits is
 * copied out of a canonical row, never invented.
 *
 * THE GATE ORDER IS THE POINT (spec §23/§24). Every candidate passes the
 * canonical eligibility / block / visibility gates BEFORE it is projected:
 *
 *   1. Eligibility  — author account 'active' (allowlist), object not deleted/removed.
 *   2. Block        — no block in EITHER direction between viewer and author
 *                     (fail-closed: an unreadable blocks table drops the author).
 *   3. Visibility   — lib/postVisibility.decidePostReadable for post-like objects,
 *                     using the viewer's accepted trip memberships for trip_only.
 *
 * A candidate that fails any gate is DROPPED before projection — it never reaches
 * a shape, so nothing downstream (ranking, following sort, live dedup) can
 * re-admit it. This is why the gate lives here, upstream of both feed modes,
 * rather than in the ranker or the route.
 *
 * The service is pure over its inputs plus ONE batched block read; it does not
 * fetch candidates (the route/candidate loaders do) and it does not rank or order
 * them (the ranking / following services do).
 *
 * It DOES own one more purely-projection decision: when several loaders each
 * produce a candidate for the SAME canonical object (a postcard is a `posts` row
 * that the media loader would otherwise emit as a plain video/photo), which
 * PROJECTION of that object wins. `dedupeCandidates` encodes that precedence
 * (a distinct Postcard/Shared-Moment presentation outranks a plain post; a
 * media-populated candidate outranks a media-less one) so the feed shows one
 * richest projection per object. See services/wall/WallCandidateLoaders.ts.
 */
import type {
  DisplayMedia,
  PublicActorRef,
  PublicPlaceRef,
  VisibilityState,
  WallAction,
  WallObjectType,
  WallProjection,
} from "../../lib/wallProjection.js";
import { decidePostReadable } from "../../lib/postVisibility.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { logger } from "../../lib/logger.js";
import {
  gatherContextThread,
  DEFAULT_CONTEXT_THREAD_POLICY,
  type ContextThreadPolicy,
  type ContextThreadViewerContext,
} from "./ContextThreadService.js";

/**
 * A canonical candidate the route has fetched and normalized. Post-like objects
 * (social_post/video/postcard/social_update/discovery) carry the `posts`-table
 * visibility semantics; shared_moment / contextual_opportunity carry their own
 * consent/eligibility, already resolved by the caller (`callerVisibilityResolved`).
 */
export interface WallCandidate {
  objectType: WallObjectType;
  canonicalObjectId: string;
  authorId: string;
  /** Raw visibility string from the canonical row (posts.visibility). */
  visibility?: string | null;
  tripId?: string | null;
  /** Publication time — the chronological spine (spec §16). */
  publishedAt: string;
  /** Experience time when it differs from publishedAt (spec §16). */
  experienceAt?: string | null;
  text?: string | null;
  media?: DisplayMedia[];
  place?: PublicPlaceRef | null;
  actor?: PublicActorRef | null;

  // ── Eligibility signals (spec §23) ──────────────────────────────────────────
  /** profiles.account_status ('active' | 'deactivated' | 'pending_deletion' |
   *  'deleted') — ALLOWLIST: anything but 'active' drops the object. */
  authorAccountStatus?: string | null;
  /** Canonical moderation state; 'removed'/'takedown' drops the object (§37). */
  moderationStatus?: string | null;
  isDeleted?: boolean;

  // ── Type-specific ───────────────────────────────────────────────────────────
  /** Required for discovery objects — the visible "why" (spec §13). */
  discoveryReason?: string | null;
  /** Shared Moment participant labels the caller has already authorized (§12). */
  participants?: PublicActorRef[];
  /** contextual_opportunity kind (spec §19). */
  opportunityKind?: "buddy_dispatch" | "buddy_around" | "event" | "trip_signal";
  /** contextual_opportunity: the COARSE approved area (a city / service zone
   *  label) the opportunity is about — never a coordinate (spec §19). */
  opportunityArea?: string | null;
  /**
   * For non-post objects (shared_moment / contextual_opportunity) whose
   * visibility the CALLER has already resolved (membership / service eligibility).
   * Ignored for post-like types, which always go through decidePostReadable.
   */
  callerVisibilityResolved?: boolean;
}

export interface ProjectViewerContext {
  viewerId: string;
  /** Accepted trip memberships — drives trip_only visibility (spec §23). */
  viewerTripIds: Set<string>;
  /** Creators the viewer already follows — suppresses a redundant follow action. */
  followedCreatorIds?: Set<string>;
  /** The viewer's current city — the spatial frame for the map Context Thread
   *  (spec §8/§22). Absent ⇒ no map bridge is offered. */
  currentCity?: string | null;
  /** Wall Phase 5 (spec §21): when on, a place-linked object may offer an
   *  Ask Compass handoff. Off (default) attaches no Compass action — Compass
   *  never occupies a permanent panel and is opt-in per object. */
  compassHandoffEnabled?: boolean;
}

const POST_LIKE_TYPES: ReadonlySet<WallObjectType> = new Set<WallObjectType>([
  "social_post",
  "video",
  "postcard",
  "social_update",
  "discovery",
]);

/** Map a raw posts.visibility string to the client-facing VisibilityState. */
function mapVisibility(raw: string | null | undefined): VisibilityState {
  switch (raw) {
    case "private":
      return "private";
    case "trip_only":
      return "trip";
    case "friends_only":
    case "friends":
      return "friends";
    case "close_friends":
    case "circle_only":
      return "circle";
    case "followers_only":
    case "followers":
      return "followers";
    default:
      return "public";
  }
}

/**
 * Batch-load the set of author ids that are blocked in EITHER direction relative
 * to the viewer. Fail-closed: on any error the whole queried author set is
 * treated as blocked (returned), so a transient blocks-table failure over-denies
 * rather than leaking to a blocked user (same contract as lib/blockGuard.ts).
 */
async function loadBlockedAuthorIds(
  sc: any,
  viewerId: string,
  authorIds: string[],
): Promise<Set<string>> {
  const unique = [...new Set(authorIds)].filter((id) => id && id !== viewerId);
  if (!sc || unique.length === 0) return new Set();
  try {
    const list = unique.join(",");
    const { data, error } = await sc
      .from("blocks")
      .select("blocker_id, blocked_id")
      .or(
        `and(blocker_id.eq.${viewerId},blocked_id.in.(${list})),` +
          `and(blocked_id.eq.${viewerId},blocker_id.in.(${list}))`,
      );
    if (error) {
      logger.warn({ err: error }, "wallProjection: blocks read failed — failing closed");
      return new Set(unique); // fail closed: drop every author that could be blocked
    }
    const blocked = new Set<string>();
    for (const row of (data as any[]) ?? []) {
      if (row.blocker_id === viewerId) blocked.add(String(row.blocked_id));
      else blocked.add(String(row.blocker_id));
    }
    return blocked;
  } catch (err) {
    logger.warn({ err }, "wallProjection: blocks read threw — failing closed");
    return new Set(unique);
  }
}

/** Object-not-eligible check (author status + moderation + deletion). */
function passesEligibility(c: WallCandidate): boolean {
  if (c.isDeleted) return false;
  // ALLOWLIST: only `account_status === 'active'` passes — the canonical
  // predicate (lib/circleLocationsRead gate 7, lib/mapTravelers, the
  // `.in("account_status", ["active"])` DB filters in discoverySearch / follows
  // / compass). This used to be a DENYLIST of 'banned' / 'suspended', two
  // values the profiles CHECK constraint does not even allow
  // (profiles_account_status_check: active / deactivated / pending_deletion /
  // deleted) — so it could never drop anything, and a deactivated or
  // pending-deletion author's posts kept flowing onto every follower's Wall
  // (§23: fail closed). A null/absent value reads as 'active' exactly as
  // lib/http requireUser and gate 7 do: the column is NOT NULL, so absence
  // only means a loader that could not read the profile, which is the
  // loaders' own fail-soft default.
  const status = c.authorAccountStatus ?? "active";
  if (status !== "active") return false;
  const mod = c.moderationStatus ?? "active";
  if (mod === "removed" || mod === "takedown" || mod === "moderated") return false;
  return true;
}

/** Visibility gate for one candidate. Post-like → decidePostReadable; other
 *  types → caller-resolved flag (defaults to false = fail closed). */
function passesVisibility(c: WallCandidate, viewer: ProjectViewerContext): boolean {
  if (POST_LIKE_TYPES.has(c.objectType)) {
    const viewerIsTripMember = !!c.tripId && viewer.viewerTripIds.has(c.tripId);
    // followers_only is readable by the author's followers: the viewer follows
    // the author iff the author is in the viewer's followedCreatorIds set (already
    // loaded for the feed). Absent set ⇒ not a follower ⇒ the tier fails closed.
    const viewerIsFollower = viewer.followedCreatorIds?.has(c.authorId) ?? false;
    return decidePostReadable(
      { author_id: c.authorId, visibility: c.visibility ?? null, trip_id: c.tripId ?? null },
      viewer.viewerId,
      viewerIsTripMember,
      viewerIsFollower,
    ).readable;
  }
  // Non-post objects: the caller resolves consent/eligibility. Absent flag ⇒
  // not authorized (fail closed) so a caller that forgets to resolve leaks nothing.
  return c.callerVisibilityResolved === true;
}

/** Build the (deliberately minimal) action set for a projection (spec §7). */
function buildActions(c: WallCandidate, viewer: ProjectViewerContext): WallAction[] {
  const actions: WallAction[] = [
    { type: "open_object", label: "Open", targetType: c.objectType, targetId: c.canonicalObjectId },
  ];
  // A place-linked object may lead to the canonical place — one action, not the
  // full Map/Trip/Compass/Buddy stack (spec §7: intelligence is optional).
  if (c.place) {
    actions.push({
      type: "see_place",
      label: "See place",
      targetType: "place",
      targetId: c.place.placeId,
    });
    // Wall Phase 5 (spec §21): an Ask Compass handoff on a place-linked object,
    // ONLY when the phase flag is on. Compass appears as an optional action here,
    // never as a permanent panel, and never asserts inference as fact.
    if (viewer.compassHandoffEnabled) {
      actions.push({
        type: "ask_compass",
        label: "Ask Compass",
        targetType: "place",
        targetId: c.place.placeId,
      });
    }
  }
  // A Buddy opportunity (spec §19) leads into the canonical RAB surface — one
  // "See Buddy" action carrying only the coarse approved area, never a
  // coordinate. The candidate loader already ran the consolidated booking gate,
  // so an action here is one the viewer can actually take.
  if (
    c.objectType === "contextual_opportunity" &&
    (c.opportunityKind === "buddy_dispatch" || c.opportunityKind === "buddy_around")
  ) {
    actions.push({
      type: "book_buddy",
      label: "See Buddy",
      targetType: "buddy",
      targetId: c.canonicalObjectId,
      ...(c.opportunityArea ? { params: { area: c.opportunityArea } } : {}),
    });
  }
  // Discovery objects reaching outside the follow graph may offer a follow, only
  // when the viewer does not already follow the actor (spec §13).
  if (
    c.objectType === "discovery" &&
    c.actor &&
    !(viewer.followedCreatorIds?.has(c.actor.userId) ?? false)
  ) {
    actions.push({
      type: "follow",
      label: "Follow",
      targetType: "user",
      targetId: c.actor.userId,
    });
  }
  return actions;
}

/** Project one gated candidate into its typed WallProjection shape. */
function projectOne(c: WallCandidate, viewer: ProjectViewerContext): WallProjection {
  const base = {
    projectionId: `wall_${c.objectType}_${c.canonicalObjectId}`,
    canonicalObjectId: c.canonicalObjectId,
    actor: c.actor ?? undefined,
    publishedAt: c.publishedAt,
    experienceAt: c.experienceAt ?? undefined,
    visibility: mapVisibility(c.visibility),
    media: c.media && c.media.length > 0 ? c.media : undefined,
    text: c.text ?? undefined,
    place: c.place ?? undefined,
    actions: buildActions(c, viewer),
  };

  switch (c.objectType) {
    case "video":
      return { ...base, objectType: "video", inlinePlayback: true };
    case "postcard":
      return { ...base, objectType: "postcard", storyPresentation: true };
    case "shared_moment":
      return {
        ...base,
        objectType: "shared_moment",
        participants: c.participants && c.participants.length > 0 ? c.participants : undefined,
      };
    case "social_update":
      return { ...base, objectType: "social_update" };
    case "discovery":
      return {
        ...base,
        objectType: "discovery",
        discoveryReason: c.discoveryReason ?? "recommended",
      };
    case "contextual_opportunity":
      return {
        ...base,
        objectType: "contextual_opportunity",
        opportunityKind: c.opportunityKind ?? "event",
      };
    case "social_post":
    default:
      return { ...base, objectType: "social_post" };
  }
}

/**
 * Project a batch of canonical candidates into Wall shapes, running the
 * eligibility → block → visibility gates first (spec §23/§24). Input order is
 * PRESERVED for the survivors, so a caller that wants strict chronology
 * (Following) or a caller that will rank (For You) both get a clean,
 * already-gated list to work from.
 *
 * Never throws: a gate-read failure fails closed (drops candidates), it does not
 * surface an error — an intelligence/gate hiccup must never collapse the feed
 * (spec §34), and dropping is the safe direction for a privacy gate.
 */
export async function projectObjects(
  sc: any,
  candidates: WallCandidate[],
  viewer: ProjectViewerContext,
): Promise<WallProjection[]> {
  if (candidates.length === 0) return [];

  // Eligibility first (pure) — narrows the set the block read has to cover.
  const eligible = candidates.filter(passesEligibility);
  if (eligible.length === 0) return [];

  const blockedAuthorIds = await loadBlockedAuthorIds(
    sc,
    viewer.viewerId,
    eligible.map((c) => c.authorId),
  );

  const out: WallProjection[] = [];
  for (const c of eligible) {
    if (blockedAuthorIds.has(c.authorId)) continue; // block gate (either direction)
    if (!passesVisibility(c, viewer)) continue; // visibility gate
    out.push(projectOne(c, viewer));
  }
  return out;
}

// ── Candidate precedence (which projection of one canonical object wins) ─────

/**
 * Presentation precedence per object type (spec §6/§10/§12). Higher wins when
 * two loaders describe the SAME canonical object. A Postcard / Shared Moment has
 * a DISTINCT presentation the spec forbids collapsing into a plain post (§10:
 * "never a Post with a badge"), so it outranks the generic social/video shape the
 * Post/Media loaders would otherwise emit for the same row. Discovery keeps its
 * own outside-graph rank; it never collides with the in-graph loaders.
 */
const CANDIDATE_TYPE_RANK: Record<WallObjectType, number> = {
  shared_moment: 6,
  contextual_opportunity: 6,
  postcard: 5,
  video: 4,
  discovery: 4,
  social_post: 3,
  social_update: 2,
};

/** Richness of a candidate: its type precedence, then a media tiebreak so a
 *  media-populated projection beats an otherwise-equal media-less one. */
function candidateRichness(c: WallCandidate): number {
  const base = CANDIDATE_TYPE_RANK[c.objectType] ?? 3;
  const hasMedia = (c.media?.length ?? 0) > 0 ? 1 : 0;
  return base * 2 + hasMedia;
}

/**
 * Collapse candidates that share a `canonicalObjectId` down to the single
 * richest projection (see CANDIDATE_TYPE_RANK), preserving first-seen order so a
 * superseding projection keeps the original object's position in the feed. Pure;
 * never throws. This is the projection-layer half of merging multiple candidate
 * loaders — the loaders module unions the ranking/place side-maps around it.
 */
export function dedupeCandidates(candidates: WallCandidate[]): WallCandidate[] {
  const best = new Map<string, WallCandidate>();
  const order: string[] = [];
  for (const c of candidates) {
    const id = c.canonicalObjectId;
    const existing = best.get(id);
    if (!existing) {
      best.set(id, c);
      order.push(id);
      continue;
    }
    if (candidateRichness(c) > candidateRichness(existing)) best.set(id, c);
  }
  return order.map((id) => best.get(id)!);
}

// ── Context Thread attachment (spec §8/§9) ───────────────────────────────────

export interface AttachContextThreadsOptions {
  /** The §9 policy (confidence / freshness / utility floors). */
  policy?: ContextThreadPolicy;
  /** Per-window context-thread cap (spec §15 maxContextThreadsInWindow). */
  maxContextThreadsInWindow?: number;
  /** The sliding window the cap is measured over. */
  windowSize?: number;
  /** Live For You strip subjects — a thread that repeats one is suppressed (§4). */
  liveStripSubjectIds?: Set<string>;
  /**
   * wall_rab_integration_enabled — NECESSARY but not sufficient for the buddy
   * candidate reader, which also re-reads the RAB master `rent_buddy_enabled`
   * itself (fail-closed).
   */
  rabEnabled?: boolean;
  now?: Date;
}

/**
 * Attach an OPTIONAL Context Thread beneath each projection where the §9 gate
 * says one earns its place (spec §8/§9). This is the wiring point of the gate:
 * WallProjectionService owns projection, so it owns whether a projection carries
 * a `contextThread`.
 *
 * Behind wall_context_threads_enabled (read ONCE here, fail-closed). Walks the
 * items in order, enforcing the per-window annotation cap
 * (maxContextThreadsInWindow / spec §15 visualOverload) as it goes: once a
 * window is saturated, further objects in that window get no thread. Live-strip
 * duplication is suppressed inside ContextThreadService's §9 gate. Never throws —
 * a Context Thread failure returns the items unannotated, never an error.
 */
export async function attachContextThreads(
  sc: any,
  items: WallProjection[],
  viewer: ProjectViewerContext,
  opts: AttachContextThreadsOptions = {},
): Promise<WallProjection[]> {
  if (!sc || items.length === 0) return items;
  try {
    if (!(await isFlagEnabled(sc, "wall_context_threads_enabled"))) return items;
  } catch {
    return items; // fail-closed
  }

  const policy = opts.policy ?? DEFAULT_CONTEXT_THREAD_POLICY;
  const maxThreads = Math.max(0, opts.maxContextThreadsInWindow ?? 2);
  const windowSize = Math.max(2, opts.windowSize ?? 6);
  const liveStripSubjectIds = opts.liveStripSubjectIds ?? new Set<string>();

  const out: WallProjection[] = [];
  for (const item of items) {
    // Count threads already placed in the trailing window.
    const window = out.slice(Math.max(0, out.length - (windowSize - 1)));
    const threadsInWindow = window.filter((w) => !!w.contextThread).length;
    const windowSaturated = threadsInWindow >= maxThreads;

    const ctViewer: ContextThreadViewerContext = {
      viewerId: viewer.viewerId,
      followedCreatorIds: viewer.followedCreatorIds,
      viewerTripIds: viewer.viewerTripIds,
      currentCity: viewer.currentCity ?? null,
      liveStripSubjectIds,
      windowSaturated,
      rabEnabled: opts.rabEnabled === true,
      // §21: the compass bridge is opt-in per object, gated by the same flag that
      // adds the Ask Compass action (ProjectViewerContext.compassHandoffEnabled).
      compassHandoffEnabled: viewer.compassHandoffEnabled === true,
      now: opts.now,
    };

    let thread;
    try {
      thread = await gatherContextThread(sc, item, ctViewer, policy);
    } catch (err) {
      logger.warn({ err }, "wallProjection: context thread build failed — no thread");
      thread = undefined;
    }
    out.push(thread ? ({ ...item, contextThread: thread } as WallProjection) : item);
  }
  return out;
}

// Test seam — pure helpers exercised directly by the projection privacy tests.
export const _internal = { mapVisibility, passesEligibility, passesVisibility, buildActions, candidateRichness };
