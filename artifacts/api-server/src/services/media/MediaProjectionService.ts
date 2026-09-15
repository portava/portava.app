/**
 * MediaProjectionService (§41/§42) — the World-first projection reader.
 *
 * A THIN reader/aggregator: it fetches already-privacy-owned rows from existing
 * tables, runs them through the SHARED eligibility gate
 * (lib/mediaEligibility.filterEligibleMediaCandidates — the fail-closed
 * distribution gate) and the SHARED coarse projector
 * (lib/media/mediaProjection.toMediaProjection), then assembles the §43 shapes.
 *
 * Every non-owner-facing projection is shaped by `projectCandidatesProtected`,
 * NOT by the raw projector: `toMediaProjection` copies the stored venue name and
 * canonical place id verbatim (it is the field whitelist, not the policy), so it
 * is passed through the lib/mediaLocationVisibility choke point, which folds in
 * the owner's `location_privacy_mode` and any hosting Hidden Gem's ceiling.
 *
 * It owns NO truth. Current/live state comes ONLY from the gated live-claim read
 * (lib/liveClaimRead.readLiveClaimEnvelopes), which is fail-closed: if live is
 * off/stale/unpromoted it returns [], and this service emits NO live badge. It
 * never manufactures a "busy now". It never emits a precise coordinate.
 *
 * Every builder degrades to a well-formed EMPTY projection when there is no data
 * (pre-launch = empty is normal).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  filterEligibleMediaCandidates,
  loadViewerTripIds,
  type FeedType,
  type MediaCandidate,
  type ViewerCtx,
} from "../../lib/mediaEligibility.js";
import {
  MEDIA_PROJECTION_POST_COLUMNS,
  MEDIA_PROJECTION_POST_MEDIA_COLUMNS,
  MEDIA_PROJECTION_PROFILE_COLUMNS,
  applyLocationDisclosure,
  toMediaProjection,
  type MediaCandidateRow,
  type MediaProjection,
} from "../../lib/media/mediaProjection.js";
import {
  loadRestrictiveGems,
  gemCeilingForItem,
  resolveMediaPlaceDisclosure,
  type MediaPlaceDisclosure,
  type RestrictiveGem,
} from "../../lib/mediaLocationVisibility.js";
import { readLiveClaimEnvelopes, type LiveClaimEnvelope } from "../../lib/liveClaimRead.js";
import { aggregateFreshness, type FreshnessState } from "../../lib/media/mediaFreshness.js";
import {
  assembleTimeBands,
  readIntelTimeSubstrate,
  type MediaTimeBands,
} from "../../lib/media/mediaTimeBands.js";
import { resolveGateAge, ageForFailClosedFilter } from "../../lib/gateAge.js";
import { logger } from "../../lib/logger.js";
import { excludePrivateAuthorPosts } from "../../lib/privacyFilter.js";
import {
  buildCategoryBuckets,
  buildPerspectiveSummary,
  type CategoryBucket,
  type PerspectiveSummary,
} from "./MediaPerspectiveService.js";
import { buildMyWorldMemory, type MyWorldMemory } from "./MyWorldMemoryService.js";
import { buildVisualConsensus, type VisualConsensus } from "./MediaConsensusService.js";

const DEFAULT_CANDIDATE_LIMIT = 200;

const SELECT = `${MEDIA_PROJECTION_POST_COLUMNS}, post_media(${MEDIA_PROJECTION_POST_MEDIA_COLUMNS}), profiles!author_id(${MEDIA_PROJECTION_PROFILE_COLUMNS})`;

export interface ViewerResolved {
  viewerId: string;
  viewerCountry: string | null;
  viewerAge: number | null;
  followedCreatorIds: Set<string>;
  viewerTripIds: Set<string>;
}

/**
 * Resolve the viewer's eligibility context: country + age (for geo/age gates),
 * followed set and trip membership (for the following feed). All best-effort —
 * a failed read leaves the safe default (empty set / null), which the
 * downstream gates treat fail-closed.
 */
export async function resolveViewer(
  sc: SupabaseClient,
  viewerId: string,
  opts: { needFollows?: boolean } = {},
): Promise<ViewerResolved> {
  const followedCreatorIds = new Set<string>();
  let viewerCountry: string | null = null;
  let viewerAge: number | null = null;
  let viewerTripIds = new Set<string>();

  await Promise.all([
    (async () => {
      try {
        const { data } = await sc
          .from("profiles")
          .select("location_country")
          .eq("id", viewerId)
          .maybeSingle();
        viewerCountry = (data as any)?.location_country ?? null;
      } catch {
        /* non-fatal */
      }
    })(),
    // THROUGH THE SEAM (lib/gateAge.ts). Same shape and same cost argument as
    // routes/mediaFeed.ts: the viewer is resolved once per request, so this is
    // one extra read per request and none per projected item. The file's own
    // private `ageFromDob` is DELETED rather than left unused: a date-of-birth-
    // to-age helper sitting next to the seam is an invitation for the next gate
    // added to this file to call it and skip the contradiction rule, which is
    // the exact shape of the defect being fixed.
    (async () => {
      try {
        viewerAge = ageForFailClosedFilter(await resolveGateAge(sc, viewerId));
      } catch {
        /* non-fatal — null already means withhold */
      }
    })(),
    (async () => {
      if (!opts.needFollows) return;
      try {
        const { data } = await sc
          .from("user_follows")
          .select("following_id")
          .eq("follower_id", viewerId);
        for (const r of (data as any[]) ?? []) followedCreatorIds.add(r.following_id as string);
      } catch {
        /* non-fatal */
      }
    })(),
    (async () => {
      if (!opts.needFollows) return;
      try {
        viewerTripIds = await loadViewerTripIds(sc, viewerId);
      } catch {
        /* non-fatal */
      }
    })(),
  ]);

  return { viewerId, viewerCountry, viewerAge, followedCreatorIds, viewerTripIds };
}

export interface CandidateFilter {
  feedType: FeedType;
  city?: string | null;
  placeId?: string | null;
  authorId?: string | null;
  /**
   * NARROWING ONLY. Composes WITH the `feedType` branch below rather than
   * replacing it, so a caller can say "these authors, under the for_you rules"
   * without widening what `for_you` admits. `authorId` (singular) is the
   * pre-existing single-author escape hatch and keeps its own semantics.
   */
  authorIds?: string[] | null;
  tripId?: string | null;
  postIds?: string[] | null;
  /**
   * NARROWING ONLY, like `authorIds`. `posts.category` is the same coarse enum
   * the perspective buckets and the §4.1 "for you now" list already group on
   * (MediaPerspectiveService.bucketKey), so this filter adds no new vocabulary
   * and no new disclosure — it selects a subset of what the feedType branch
   * already admits.
   */
  category?: string | null;
  limit?: number;
}

/**
 * Which candidate-loader input could not be read. Carried on the refusal so a
 * log line names the failing read rather than "media unavailable".
 */
export type MediaCandidateInput = "posts" | "eligibility";

/**
 * Raised when the candidate read could not be performed — NOT when it found
 * nothing.
 *
 * supabase-js RESOLVES on a database error: a failed read arrives as
 * `{ data: null, error: {...} }`, which the old `if (error) return []` made
 * byte-identical to `{ data: [], error: null }`. Every §43 surface then served
 * an unreadable `posts` table to the client as a 200 carrying a confident,
 * well-formed, EMPTY world. "There is no media anywhere near you" is a claim
 * about the world, and it may not be assembled out of a query that did not
 * answer.
 *
 * This is the mechanism `TripAccessUnavailableError` (lib/http.ts) established
 * and for the same structural reason: the return type has nowhere to put a
 * third state. `MediaCandidateRow[]` can express "rows" and "no rows"; it
 * cannot express "I could not look". Widening it to a result union would
 * rewrite every builder AND `services/wall/WallCandidateLoaders.ts`, which this
 * lane does not own — so the refusal is an exception and the old swallowing
 * signature stays available, deprecated, for that one caller.
 *
 * `status` and `code` are read by the global error handler
 * (lib/errorEnvelope.ts), so an uncaught one becomes exactly the response the
 * route would have sent by hand: 503 `degraded_unavailable`, `retryable: true`.
 * Express 5 forwards a rejected async handler there automatically, so no media
 * route needs a try/catch for this to arrive correctly.
 *
 * WHAT THIS IS NOT. It is not a fail-closed empty result wearing a new name.
 * Genuine emptiness still resolves to `[]` and every media route still answers
 * 200 with a well-formed empty projection — the router's "pre-launch = empty is
 * normal" invariant is preserved, and `mediaWorldProjection.test.ts` pins both
 * halves with paired controls so neither can quietly swallow the other.
 */
export class MediaCandidatesUnavailableError extends Error {
  /** Which read failed. */
  readonly input: MediaCandidateInput;
  /** Read by the global error handler (lib/errorEnvelope.ts). */
  readonly status: number = 503;
  /** Read by the global error handler (lib/errorEnvelope.ts). */
  readonly code = "degraded_unavailable" as const;
  constructor(input: MediaCandidateInput, detail: string) {
    super(`media candidate input ${input} unavailable — refusing to answer: ${detail}`);
    this.name = "MediaCandidatesUnavailableError";
    this.input = input;
  }
}

/** Narrow an unknown caught value to this lane's refusal. */
export function isMediaCandidatesUnavailable(e: unknown): e is MediaCandidatesUnavailableError {
  return e instanceof MediaCandidatesUnavailableError;
}

/**
 * Fetch and eligibility-filter media candidates.
 *
 * Returns the eligible raw rows (post_media + profiles attached), or `[]` when
 * the query genuinely matched nothing. THROWS `MediaCandidatesUnavailableError`
 * when a read could not be performed — see that class for why the third state
 * cannot live in the return type.
 */
export async function loadEligibleCandidatesOrRefuse(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  filter: CandidateFilter,
): Promise<MediaCandidateRow[]> {
  const limit = Math.min(filter.limit ?? DEFAULT_CANDIDATE_LIMIT, DEFAULT_CANDIDATE_LIMIT);

  // Following feed with an empty follow graph can never yield anyone else's
  // content; short-circuit to empty (matches mediaFeed.ts).
  if (
    filter.feedType === "following" &&
    !filter.authorId &&
    viewer.followedCreatorIds.size === 0
  ) {
    return [];
  }

  let query = (sc as any)
    .from("posts")
    .select(SELECT)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (filter.authorId) {
    query = query.eq("author_id", filter.authorId);
  } else if (filter.feedType === "for_you") {
    query = query.eq("visibility", "public");
  } else if (filter.feedType === "following") {
    query = query.in("author_id", [...viewer.followedCreatorIds]);
  }

  // Applied AFTER the feedType branch, never instead of it: an empty array here
  // would mean "no author matches", so the caller is responsible for not asking
  // at all — `buildPeopleProjection` skips the lane entirely when the set is
  // empty rather than issuing `.in("author_id", [])`.
  if (filter.authorIds && filter.authorIds.length > 0) {
    query = query.in("author_id", filter.authorIds.slice(0, DEFAULT_CANDIDATE_LIMIT));
  }

  if (filter.category) query = query.eq("category", filter.category);
  if (filter.placeId) query = query.eq("canonical_place_id", filter.placeId);
  if (filter.tripId) query = query.eq("trip_id", filter.tripId);
  if (filter.city) query = query.ilike("location_city", `%${filter.city}%`);
  if (filter.postIds && filter.postIds.length > 0) query = query.in("id", filter.postIds.slice(0, limit));

  let rows: any[] = [];
  {
    // DESTRUCTURED, and the shape matters as much as the behaviour.
    //
    // The first version of this block assigned the awaited result to a local and
    // read `settled.error` off it. That is just as bound — and
    // `check:unchecked-supabase-reads` reported it as
    // `[discarded / gate-function]`, because the pattern it recognises is the
    // destructuring one. A read whose care the guard cannot SEE is a read the
    // guard cannot protect, and the next person to touch this line gets no
    // warning if they drop the check. So it is written in the shape the guard
    // reads, and the transport/resolved distinction is kept by re-throwing our
    // own error type rather than by splitting the try.
    //
    // `error` is a RESOLVED PostgREST failure; the `catch` is the
    // transport/driver rejection. Both used to `return []`.
    try {
      const { data, error } = (await query) as { data: unknown; error: unknown };
      if (error) {
        throw new MediaCandidatesUnavailableError(
          "posts",
          String((error as any)?.message ?? (error as any)?.code ?? "db_error"),
        );
      }
      if (!Array.isArray(data)) {
        // A non-array payload with no error is not an empty page — it is a shape
        // this code cannot read, which is the same unknown as a failed read.
        throw new MediaCandidatesUnavailableError("posts", "candidate read returned a non-array payload");
      }
      rows = data;
    } catch (err) {
      if (err instanceof MediaCandidatesUnavailableError) throw err;
      throw new MediaCandidatesUnavailableError("posts", String((err as any)?.message ?? err));
    }
  }
  if (rows.length === 0) return [];

  const viewerCtx: ViewerCtx = {
    viewerUserId: viewer.viewerId,
    feedType: filter.feedType,
    followedCreatorIds: viewer.followedCreatorIds,
    viewerCountry: viewer.viewerCountry,
    viewerAge: viewer.viewerAge,
    viewerTripIds: viewer.viewerTripIds,
  };

  const { eligible, blockFetchFailed } = await filterEligibleMediaCandidates(
    rows as MediaCandidate[],
    viewerCtx,
    sc,
    null,
  );
  // A block-fetch failure means we cannot prove nothing is from a blocked user.
  // Surfacing nothing was the safe half of the answer and the dishonest half of
  // the report: the viewer was told the world is empty when in fact the block
  // list could not be read. Refuse — which withholds exactly as much content as
  // the empty list did, and says so.
  if (blockFetchFailed) {
    throw new MediaCandidatesUnavailableError("eligibility", "viewer block/mute list could not be read");
  }

  // ── Private-account guard ───────────────────────────────────────────────────
  // filterEligibleMediaCandidates gates blocks, mutes, suspension, status,
  // post_status, publish_at, visibility and moderation — and nothing else. It
  // has never known about `profiles.is_private`; that rule lives in
  // lib/privacyFilter and the two LEGACY media feeds both call it
  // (routes/mediaFeed.ts mode=grid and GET /media/feed).
  //
  // This loader is the shared candidate source for everything net-new: all six
  // World-shell builders (world / places / people / my-world / timeline / map),
  // the experience resolver, the action rail, and the Wall's Quick Media
  // loader. None of them applied the guard, so a private account's
  // visibility='public' post — its media, its place label and its contributor
  // credit (username, display name, avatar) — was projected to every viewer,
  // while the same row was correctly hidden two files away. Exactly the "the
  // gate landed on one path and not its twin" shape.
  //
  // Applied HERE, at the one choke point, rather than on each of the eight
  // callers — a per-caller fix is how this class recurs. The viewer's own rows
  // always pass (My World is unaffected), and an approved follower still sees
  // the item. `is_private` rides along on the profiles join
  // (MEDIA_PROJECTION_PROFILE_COLUMNS), so this costs no extra round trip.
  const visible = await excludePrivateAuthorPosts(
    eligible as unknown as Array<Record<string, any>>,
    viewer.viewerId,
    sc,
    { profilesKey: "profiles" },
  );
  return visible as unknown as MediaCandidateRow[];
}

/**
 * DEPRECATED — the swallowing signature. `[]` here means EITHER "no rows" OR
 * "the read failed", which is the defect `loadEligibleCandidatesOrRefuse`
 * exists to remove. Prefer that function in anything new.
 *
 * It is kept for exactly one caller: `services/wall/WallCandidateLoaders.ts`,
 * which this lane does not own. Changing that file's failure behaviour is a
 * Wall decision — a Wall page that currently degrades to "no quick media" would
 * start refusing the whole page — so the choice is left to the Wall lane rather
 * than taken on its behalf. Every media-owned caller (all six World-shell
 * builders, the experience resolver, the action rail and §38 search) has moved
 * to the refusing form; this wrapper has ONE remaining call site and should
 * reach zero.
 *
 * It does not re-implement the swallow: it calls the refusing loader and
 * converts, so the two can never drift apart.
 */
export async function loadEligibleCandidates(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  filter: CandidateFilter,
): Promise<MediaCandidateRow[]> {
  try {
    return await loadEligibleCandidatesOrRefuse(sc, viewer, filter);
  } catch (err) {
    if (isMediaCandidatesUnavailable(err)) return [];
    throw err;
  }
}

// ── Location disclosure: the choke point, applied to every projection ────────

/**
 * Batch Hidden-Gem context for a page of rows. `determined=false` means the
 * restrictive-gem lookup FAILED and every item must be coarsened defensively
 * (fail-closed) — never treated as "no gem here". Mirrors mediaFeed.ts's
 * FeedGemContext so the two paths share one shape as well as one policy.
 */
export interface ProjectionGemContext {
  gems: RestrictiveGem[];
  determined: boolean;
}

/** A context that constrains nothing — for callers holding only owner content. */
export const OWNER_ONLY_GEM_CONTEXT: ProjectionGemContext = { gems: [], determined: true };

/**
 * Load, in ONE query pair, the restrictive Hidden Gems that could constrain any
 * row on this page, keyed by the rows' canonical_place_id and city. Fail-closed:
 * a lookup error yields determined=false so every item is coarsened.
 */
export async function loadProjectionGemContext(
  sc: SupabaseClient,
  rows: MediaCandidateRow[],
): Promise<ProjectionGemContext> {
  if (rows.length === 0) return { gems: [], determined: true };
  try {
    const gems = await loadRestrictiveGems(sc, {
      placeIds: rows.map((r) => (r as any).canonical_place_id ?? null),
      cities: rows.map((r) => (r as any).location_city ?? null),
    });
    return { gems, determined: true };
  } catch (err) {
    logger.warn(
      { err },
      "mediaProjection: Hidden-Gem location protection lookup failed; coarsening every item",
    );
    return { gems: [], determined: false };
  }
}

/**
 * Batch the canonical Place's NEIGHBORHOOD label for a page of rows (spec §7
 * "MediaAsset → Neighborhood", §46 coarse labels).
 *
 * WHY THIS EXISTS. `MediaProjection` has carried a `neighborhood` field since
 * the shell was written and it was `null` on every projection ever served:
 * `toMediaProjection` hard-codes `neighborhood: null` (correct — the raw
 * projector reads one `posts` row and `posts` has no neighborhood column), and
 * `applyLocationDisclosure` then copies `d.neighborhood` off a disclosure whose
 * input never carried one. The tier machinery was already complete and correct —
 * `coarsenMediaLocation` discloses `neighborhood` at the 'neighborhood' and
 * 'place' tiers and withholds it at 'city' / 'country' / 'hidden' — so the ONLY
 * thing missing was a producer. The §7 edge was drawn in the type and severed in
 * the data.
 *
 * WHERE THE LABEL COMES FROM. `places.neighborhood`, keyed by the post's
 * `canonical_place_id` — the same column and the same read `buildPlaceProjection`
 * already performs for a place header. Media does not own a second neighborhood
 * source (§48: Places owns canonical Place identity), so this reads theirs.
 *
 * FAIL-SOFT, AND THAT IS THE CORRECT POSTURE HERE — unlike the gem context
 * beside it, which is fail-CLOSED. Losing this lookup costs a LABEL; it can
 * never disclose anything, because the label is handed to the choke point as an
 * INPUT and the choke point decides whether the viewer's tier may see it. A
 * failed read yields an empty map, every row's `neighborhood` stays `null`, and
 * the projection is exactly what it was before this function existed. The gem
 * lookup is fail-closed because losing IT would widen disclosure; losing this
 * one only narrows it.
 */
export async function loadPlaceNeighborhoods(
  sc: SupabaseClient,
  rows: MediaCandidateRow[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [
    ...new Set(
      rows
        .map((r) => (r as any).canonical_place_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
  if (ids.length === 0) return out;
  try {
    const { data, error } = await (sc as any)
      .from("places")
      .select("id, neighborhood")
      .in("id", ids);
    if (error) {
      logger.warn({ err: error }, "mediaProjection: places.neighborhood read failed; labels stay null");
      return out;
    }
    for (const r of ((data as any[]) ?? [])) {
      const id = (r as any)?.id;
      const raw = (r as any)?.neighborhood;
      const label = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
      if (typeof id === "string" && label != null) out.set(id, label);
    }
  } catch (err) {
    logger.warn({ err }, "mediaProjection: places.neighborhood read threw; labels stay null");
  }
  return out;
}

/** The neighborhood label for a row, or null when the place has none / is unknown. */
export function neighborhoodForRow(
  row: MediaCandidateRow,
  neighborhoods: ReadonlyMap<string, string>,
): string | null {
  const placeId = (row as any).canonical_place_id;
  if (typeof placeId !== "string" || placeId.length === 0) return null;
  return neighborhoods.get(placeId) ?? null;
}

/**
 * Resolve one row's full location disclosure for this viewer.
 *
 * NOTE ON COORDINATES: the projection layer deliberately does not select
 * `location_lat` / `location_lng` (see MEDIA_PROJECTION_POST_COLUMNS), so the
 * gem cross-check here runs on the canonical-place arm only — a post is
 * constrained when it is AT the gem's canonical place. mediaFeed.ts, which does
 * hold coordinates for ranking, additionally runs the proximity arm. Not reading
 * coordinates in order to protect coordinates is the correct trade: the
 * projection can never disclose a point it never loaded.
 */
export function disclosureForRow(
  row: MediaCandidateRow,
  viewerId: string,
  ctx: ProjectionGemContext,
  neighborhood: string | null = null,
): MediaPlaceDisclosure {
  const placeId = typeof row.canonical_place_id === "string" ? row.canonical_place_id : null;
  const ceiling = ctx.determined
    ? gemCeilingForItem(ctx.gems, { placeId, lat: null, lng: null })
    : null;
  return resolveMediaPlaceDisclosure(
    {
      name: typeof row.location_name === "string" ? row.location_name : null,
      // §7 MediaAsset → Neighborhood. Handed in as an INPUT so the tier logic
      // decides disclosure: coarsenMediaLocation keeps it at 'neighborhood' and
      // 'place' and nulls it at 'city' / 'country' / 'hidden'. Defaulting to
      // null keeps every other caller's behaviour byte-identical.
      neighborhood,
      city: typeof row.location_city === "string" ? row.location_city : null,
      country: typeof row.location_country === "string" ? row.location_country : null,
      lat: null,
      lng: null,
    },
    {
      isOwner: (row as any).author_id === viewerId,
      // `posts` carries no independent §33 tier column (that is media_assets);
      // legacy posts default to 'place', exactly as mediaFeed.ts does.
      locationVisibility: (row as any).location_visibility ?? "place",
      locationPrivacyMode: row.location_privacy_mode ?? null,
      postStatus: row.post_status ?? null,
      coarsenSeed: row.id ?? null,
      // The World shell has never emitted coordinates and must not start.
      emitCoarseCoords: false,
      gem: { ceiling, determined: ctx.determined },
    },
  );
}

/**
 * Project a page of candidate rows THROUGH the location/gem choke point.
 *
 * This is the only projection entry point the World-shell builders may use.
 * `projectMediaCandidates` (the raw projector) copies stored labels verbatim and
 * is therefore not servable to a non-owner on its own.
 */
export async function projectCandidatesProtected(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  rows: MediaCandidateRow[],
  nowMs: number,
): Promise<MediaProjection[]> {
  if (rows.length === 0) return [];
  // Two independent batch reads, one round trip's worth of latency. The gem
  // context is fail-CLOSED (losing it widens disclosure); the neighborhood map
  // is fail-SOFT (losing it only removes a label) — see loadPlaceNeighborhoods.
  const [ctx, neighborhoods] = await Promise.all([
    loadProjectionGemContext(sc, rows),
    loadPlaceNeighborhoods(sc, rows),
  ]);
  const out: MediaProjection[] = [];
  for (const row of rows) {
    const p = toMediaProjection(row, nowMs);
    if (!p) continue;
    out.push(
      applyLocationDisclosure(
        p,
        disclosureForRow(row, viewer.viewerId, ctx, neighborhoodForRow(row, neighborhoods)),
      ),
    );
  }
  return out;
}

// ── Live current-state (gated, fail-closed) ──────────────────────────────────

export interface CurrentState {
  /** True only when the gated live path returned at least one live claim. */
  live: boolean;
  /** The client-facing live claim envelopes — [] when live is unavailable. */
  claims: LiveClaimEnvelope[];
  /** A coarse crowd label, ONLY from a gated live crowd claim. Null otherwise. */
  crowdLabel: string | null;
}

const EMPTY_CURRENT_STATE: CurrentState = { live: false, claims: [], crowdLabel: null };

/**
 * The current live state for a place subject. Delegates entirely to the gated,
 * fail-closed live-claim read. If live is off / stale / unpromoted, returns the
 * empty state — NO live badge is ever manufactured here.
 */
export async function readCurrentState(
  sc: SupabaseClient,
  placeId: string | null | undefined,
  nowMs: number,
): Promise<CurrentState> {
  if (!placeId) return EMPTY_CURRENT_STATE;
  let claims: LiveClaimEnvelope[] = [];
  try {
    claims = await readLiveClaimEnvelopes(sc, placeId, { now: new Date(nowMs) });
  } catch {
    return EMPTY_CURRENT_STATE;
  }
  if (!claims || claims.length === 0) return EMPTY_CURRENT_STATE;

  let crowdLabel: string | null = null;
  const crowd = claims.find((c) => c.claimType === "crowd.level" || c.claimType === "crowd");
  if (crowd) {
    const v = crowd.value as any;
    const level = typeof v === "string" ? v : v?.level;
    crowdLabel = typeof level === "string" && level.length > 0 ? level : null;
  }
  return { live: true, claims, crowdLabel };
}

// ── §4.1 World / NOW ─────────────────────────────────────────────────────────

export interface WorldZone {
  placeId: string | null;
  label: string;
  perspectiveCount: number;
  freshness: FreshnessState;
  /** Live crowd/trend claims for this zone — [] unless the gated path served them. */
  liveClaims: LiveClaimEnvelope[];
  /** Coarse crowd label ONLY from a gated live claim; null otherwise. */
  liveCrowdLabel: string | null;
  /**
   * §18 Visual Consensus for this zone — witness corroboration over the zone's
   * FRESH perspectives plus the canonical lib/intelConflict contradiction state
   * carried on `liveClaims`. `uncertaintyLabel` is the §18 "Mixed reports"
   * banner and is non-null ONLY on a material conflict.
   */
  consensus: VisualConsensus;
}

export interface WorldProjection {
  city: string | null;
  generatedAt: string;
  cityVisualState: WorldZone[];
  forYouNow: CategoryBucket[];
  changingNow: WorldZone[];
  totalPerspectives: number;
}

const MAX_WORLD_ZONES = 20;

/** Group projected media into coarse zones keyed by canonical place (or label). */
function groupZones(media: MediaProjection[]): Map<string, { placeId: string | null; label: string; items: MediaProjection[] }> {
  const zones = new Map<string, { placeId: string | null; label: string; items: MediaProjection[] }>();
  for (const m of media) {
    const key = m.placeId ?? (m.placeLabel ? `label:${m.placeLabel}` : "unlabeled");
    const label = m.placeLabel ?? m.neighborhood ?? m.city ?? "Nearby";
    const z = zones.get(key) ?? { placeId: m.placeId ?? null, label, items: [] };
    z.items.push(m);
    zones.set(key, z);
  }
  return zones;
}

export async function buildWorldProjection(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  city: string | null,
  nowMs: number,
): Promise<WorldProjection> {
  const generatedAt = new Date(nowMs).toISOString();
  const candidates = await loadEligibleCandidatesOrRefuse(sc, viewer, {
    feedType: "for_you",
    city: city ?? undefined,
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  const media = await projectCandidatesProtected(sc, viewer, candidates, nowMs);

  const forYouNow = buildCategoryBuckets(media, nowMs);

  const zoneMap = groupZones(media);
  const zoneList = [...zoneMap.values()]
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, MAX_WORLD_ZONES);

  // Read the gated live state for each zone that has a canonical place id. The
  // read is fail-closed; when live is off (the prod default) every zone gets an
  // empty live state and NO state badge — exactly the anti-fabrication rule.
  // §18 actor-relationship side channel, built ONCE for the whole page and
  // sliced per zone below. Never written onto a projection (see partyTokensByPostId).
  const partyTokens = partyTokensByPostId(candidates);

  const cityVisualState: WorldZone[] = await Promise.all(
    zoneList.map(async (z) => {
      const current = await readCurrentState(sc, z.placeId, nowMs);
      return {
        placeId: z.placeId,
        label: z.label,
        perspectiveCount: z.items.length,
        freshness: aggregateFreshness(z.items.map((m) => m.capturedAt), nowMs),
        liveClaims: current.claims,
        liveCrowdLabel: current.crowdLabel,
        // §18: the zone's own witness corroboration and the canonical conflict
        // state already riding on `current.claims`. Media used to drop the
        // latter on the floor — a zone whose reports materially disagreed
        // rendered exactly like one they agreed about.
        consensus: buildVisualConsensus(z.items, current.claims, nowMs, {
          groupKeyById: partyTokens,
        }),
      };
    }),
  );

  // "Changing now" is ONLY zones with a gated live claim. No live claims → empty.
  const changingNow = cityVisualState.filter((z) => z.liveClaims.length > 0);

  return {
    city: city ?? null,
    generatedAt,
    cityVisualState,
    forYouNow,
    changingNow,
    totalPerspectives: media.length,
  };
}

// ── §13 Place Current View ───────────────────────────────────────────────────

export interface PlaceProjection {
  placeId: string;
  generatedAt: string;
  /** Coarse place labels — no coordinates. */
  place: { id: string; name: string | null; city: string | null; country: string | null; neighborhood: string | null };
  currentState: CurrentState;
  perspectives: PerspectiveSummary;
  /** §18 Corroboration → Contradiction → Visual Consensus for this place. */
  consensus: VisualConsensus;
  freshness: FreshnessState;
}

/**
 * Map each candidate post id to the trip it was contributed under, for the §18
 * independence clustering ONLY. Posts with no trip contribute `null` and stay
 * their own solo unit.
 */
function partyTokensByPostId(rows: MediaCandidateRow[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const r of rows) {
    const id = (r as any)?.id;
    if (id == null) continue;
    const tripId = (r as any)?.trip_id;
    out.set(String(id), typeof tripId === "string" && tripId.length > 0 ? tripId : null);
  }
  return out;
}

export async function buildPlaceProjection(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  placeId: string,
  nowMs: number,
): Promise<PlaceProjection> {
  const generatedAt = new Date(nowMs).toISOString();

  // Coarse place identity (labels only). Best-effort; a failed read leaves nulls.
  let placeName: string | null = null;
  let placeCity: string | null = null;
  let placeCountry: string | null = null;
  let placeNeighborhood: string | null = null;
  try {
    // `country_code`, NOT `country`: the places table has never had a `country`
    // column. PostgREST fails the WHOLE read on an unknown select-list column
    // (PGRST100), and the catch below turns that into "leave the nulls" — so
    // this did not degrade one field, it silently emptied place identity
    // entirely, on every projection, for as long as the line has existed.
    const { data, error } = await (sc as any)
      .from("places")
      .select("id, name, city, country_code, neighborhood")
      .eq("id", placeId)
      .maybeSingle();
    // Best-effort stays best-effort, but a schema error is not a missing row.
    // Logging it is what turns the next occurrence of this into a five-minute
    // fix instead of another silent emptiness.
    if (error) {
      logger.warn(
        {
          placeId,
          code: (error as any)?.code ?? null,
          message: (error as any)?.message ?? null,
        },
        "mediaPlaceProjection: place identity read failed — projection will carry null place labels",
      );
    }
    if (data) {
      placeName = (data as any).name ?? null;
      placeCity = (data as any).city ?? null;
      placeCountry = (data as any).country_code ?? null;
      placeNeighborhood = (data as any).neighborhood ?? null;
    }
  } catch {
    /* non-fatal — labels stay null */
  }

  const candidates = await loadEligibleCandidatesOrRefuse(sc, viewer, {
    feedType: "for_you",
    placeId,
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  const media = await projectCandidatesProtected(sc, viewer, candidates, nowMs);
  if (!placeCity) placeCity = media.find((m) => m.city)?.city ?? null;
  if (!placeName) placeName = media.find((m) => m.placeLabel)?.placeLabel ?? null;

  const currentState = await readCurrentState(sc, placeId, nowMs);
  // §18 actor-relationship side channel: the party token each perspective was
  // contributed under. Read off the CANDIDATE rows and handed to the summary as
  // an input — it is never written onto a projection, because `MediaProjection`
  // is a privacy whitelist and trip membership is not on it.
  const perspectives = buildPerspectiveSummary(media, nowMs, {
    groupKeyById: partyTokensByPostId(candidates),
  });

  return {
    placeId,
    generatedAt,
    place: { id: placeId, name: placeName, city: placeCity, country: placeCountry, neighborhood: placeNeighborhood },
    currentState,
    perspectives,
    // §18 Visual Consensus. The SAME party-token side channel the independence
    // clustering uses, so a trip crew cannot self-corroborate a place either.
    consensus: buildVisualConsensus(media, currentState.claims, nowMs, {
      groupKeyById: partyTokensByPostId(candidates),
    }),
    freshness: aggregateFreshness(media.map((m) => m.capturedAt), nowMs),
  };
}

// ── §27 People lens ──────────────────────────────────────────────────────────

/**
 * Which of §27's populations a contributor reaches this lens through.
 *
 * §27 names four — *followed users, Trip Crew, Shared Moment participants and
 * relevant creators* — and three values cover them, because the fourth has no
 * separate source: a "relevant creator" reaches the People lens through the
 * follow graph, which is exactly what census-media MD216 already credits when
 * it says *"followed users and creators are handled"*. Inventing a fourth enum
 * value with no producer would be a vocabulary entry standing in for a build.
 */
export type PeopleRelation = "followed" | "trip_crew" | "shared_moment";

/**
 * §27's declared order IS the priority order. A contributor who qualifies under
 * more than one population is counted ONCE, at the earliest-declared one.
 */
const PEOPLE_RELATION_ORDER: readonly PeopleRelation[] = ["followed", "trip_crew", "shared_moment"];

export interface PeopleAffinities {
  /** Other accepted members of trips the VIEWER has accepted. Never the viewer. */
  tripCrewIds: Set<string>;
  /** Other accepted members of Shared Moments the VIEWER has accepted. Never the viewer. */
  sharedMomentIds: Set<string>;
}

/** Membership rows in any other state are not a relationship. */
const ACCEPTED_MEMBERSHIP_STATUS = "accepted";

/**
 * Resolve the two §27 populations the follow graph cannot express.
 *
 * TWO HOPS EACH, and the first hop is the viewer's own accepted membership —
 * so an invitation the viewer has not accepted yields nobody, and an invitation
 * somebody else has not accepted does not make them crew. Read viewer-scoped at
 * line level in both directions.
 *
 * FAIL-SOFT, and the asymmetry with the gem read in `projectCandidatesProtected`
 * is deliberate for the same reason `loadPlaceNeighborhoods` is: losing the gem
 * context would WIDEN disclosure, losing this one only removes people from a
 * lens. An empty set here means "no affinity lane", never "admit everyone".
 */
export async function loadPeopleAffinities(
  sc: SupabaseClient,
  viewerId: string,
): Promise<PeopleAffinities> {
  const tripCrewIds = new Set<string>();
  const sharedMomentIds = new Set<string>();

  // THE READS ARE PASSED IN, NOT BUILT FROM A TABLE NAME. Both hops used to be
  // one `.from(table).select(`${groupCol}, user_id, status`)` parameterised by
  // the caller. That is the same query written once, but it is invisible to
  // check:write-path-columns, which can only compare a select list against the
  // live schema when the table and the list are both literals. A dynamic pair
  // is a blind spot where a column that does not exist reaches PostgREST, which
  // rejects the WHOLE statement with 42703 — and supabase-js resolves that
  // rather than throwing, so the population silently empties. The two callers
  // below therefore spell both reads out; `groupCol` survives only to read the
  // key back off the returned row, where it cannot hide a phantom column.
  const peers = async (
    label: string,
    groupCol: string,
    readMine: () => PromiseLike<{ data: unknown; error: unknown }>,
    readGroup: (groups: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
    into: Set<string>,
  ): Promise<void> => {
    let mine: string[] = [];
    try {
      const { data, error } = await readMine();
      if (error) {
        logger.warn(
          { table: label, code: (error as any)?.code ?? null, message: (error as any)?.message ?? null },
          "loadPeopleAffinities: viewer membership read failed — this §27 population is empty for this request",
        );
        return;
      }
      for (const r of (data as any[]) ?? []) {
        if (String(r?.status ?? ACCEPTED_MEMBERSHIP_STATUS) !== ACCEPTED_MEMBERSHIP_STATUS) continue;
        if (r?.[groupCol] != null) mine.push(String(r[groupCol]));
      }
    } catch {
      return;
    }
    mine = [...new Set(mine)];
    if (mine.length === 0) return;

    try {
      const { data, error } = await readGroup(mine.slice(0, DEFAULT_CANDIDATE_LIMIT));
      if (error) return;
      for (const r of (data as any[]) ?? []) {
        if (String(r?.status ?? ACCEPTED_MEMBERSHIP_STATUS) !== ACCEPTED_MEMBERSHIP_STATUS) continue;
        const uid = r?.user_id == null ? null : String(r.user_id);
        if (!uid || uid === viewerId) continue;
        into.add(uid);
      }
    } catch {
      /* non-fatal — the population stays empty */
    }
  };

  await Promise.all([
    peers(
      "trip_members",
      "trip_id",
      () => (sc as any).from("trip_members").select("trip_id, user_id, status").eq("user_id", viewerId),
      (groups) => (sc as any).from("trip_members").select("trip_id, user_id, status").in("trip_id", groups),
      tripCrewIds,
    ),
    peers(
      "shared_moment_memberships",
      "moment_id",
      () =>
        (sc as any)
          .from("shared_moment_memberships")
          .select("moment_id, user_id, status")
          .eq("user_id", viewerId),
      (groups) =>
        (sc as any)
          .from("shared_moment_memberships")
          .select("moment_id, user_id, status")
          .in("moment_id", groups),
      sharedMomentIds,
    ),
  ]);

  return { tripCrewIds, sharedMomentIds };
}

export interface PeopleGroup {
  contributor: MediaProjection["contributor"];
  /** Which §27 population put this contributor on the lens. */
  relation: PeopleRelation;
  perspectiveCount: number;
  freshness: FreshnessState;
  media: MediaProjection[];
}

export interface PeopleProjection {
  generatedAt: string;
  people: PeopleGroup[];
  totalPerspectives: number;
}

/**
 * §27 People lens — all four declared populations.
 *
 * TWO LANES, and the split is the privacy argument:
 *
 *  1. **The follow lane** (`feedType: "following"`) is unchanged. Its visibility
 *     gate admits a followed author's `trip_only` item on a trip the viewer is a
 *     member of, because the follow lane carries `viewerTripIds` as that proof.
 *  2. **The affinity lane** (`feedType: "for_you"`, narrowed to the crew and
 *     Shared Moment ids) is PUBLIC-ONLY, and the bound is stated rather than
 *     hidden: a crew member's `trip_only` or `private` post is WITHHELD rather
 *     than guessed at. The shared eligibility gate refuses non-public items on
 *     `for_you` in the query AND again per item, so nothing here widens it —
 *     this lane narrows an existing feed type, it does not invent a new one.
 *
 * Before this, the lens ran lane 1 ALONE, whose per-item gate refuses any author
 * the viewer does not follow. Trip Crew and Shared Moment participants were
 * therefore structurally unreachable no matter what they posted, while the
 * client's own copy named both populations.
 */
export async function buildPeopleProjection(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  nowMs: number,
): Promise<PeopleProjection> {
  const generatedAt = new Date(nowMs).toISOString();

  const affinities = await loadPeopleAffinities(sc, viewer.viewerId);
  const affinityIds = [...new Set([...affinities.tripCrewIds, ...affinities.sharedMomentIds])].filter(
    (id) => !viewer.followedCreatorIds.has(id),
  );

  const [followed, affinity] = await Promise.all([
    loadEligibleCandidatesOrRefuse(sc, viewer, {
      feedType: "following",
      limit: DEFAULT_CANDIDATE_LIMIT,
    }),
    affinityIds.length === 0
      ? Promise.resolve([] as MediaCandidateRow[])
      : loadEligibleCandidatesOrRefuse(sc, viewer, {
          feedType: "for_you",
          authorIds: affinityIds,
          limit: DEFAULT_CANDIDATE_LIMIT,
        }),
  ]);

  // Dedupe by post id: a followed crew member is one person with one library,
  // and two lanes reaching the same row must not count it twice.
  const byId = new Map<string, MediaCandidateRow>();
  for (const row of [...followed, ...affinity]) {
    const id = (row as any)?.id;
    if (id == null) continue;
    if (!byId.has(String(id))) byId.set(String(id), row);
  }

  const media = await projectCandidatesProtected(sc, viewer, [...byId.values()], nowMs);

  const relationOf = (cid: string): PeopleRelation | null => {
    if (viewer.followedCreatorIds.has(cid)) return "followed";
    if (affinities.tripCrewIds.has(cid)) return "trip_crew";
    if (affinities.sharedMomentIds.has(cid)) return "shared_moment";
    // The viewer's own items ride the follow lane's self-exemption; they are
    // not one of §27's populations, so they group under `followed` rather than
    // being dropped from a lens the viewer is looking at.
    return cid === viewer.viewerId ? "followed" : null;
  };

  const byContributor = new Map<string, MediaProjection[]>();
  for (const m of media) {
    const cid = m.contributor?.id;
    if (!cid) continue;
    const list = byContributor.get(cid) ?? [];
    list.push(m);
    byContributor.set(cid, list);
  }

  const people: PeopleGroup[] = [];
  for (const [cid, items] of byContributor) {
    const relation = relationOf(cid);
    if (!relation) continue;
    const sorted = items.sort(
      (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
    );
    people.push({
      contributor: sorted[0].contributor,
      relation,
      perspectiveCount: sorted.length,
      freshness: aggregateFreshness(sorted.map((m) => m.capturedAt), nowMs),
      media: sorted.slice(0, 12),
    });
  }
  // §27's declared order first, the count only inside a population.
  people.sort((a, b) => {
    const byRelation =
      PEOPLE_RELATION_ORDER.indexOf(a.relation) - PEOPLE_RELATION_ORDER.indexOf(b.relation);
    if (byRelation !== 0) return byRelation;
    return b.perspectiveCount - a.perspectiveCount;
  });

  return { generatedAt, people, totalPerspectives: media.length };
}

// ── §30 My World (owner library) ─────────────────────────────────────────────

export interface MyWorldBucket {
  key: string;
  label: string;
  ownerOnly: boolean;
  count: number;
  media: MediaProjection[];
}

export interface MyWorldProjection {
  generatedAt: string;
  buckets: MyWorldBucket[];
  /**
   * §31 / §31.1 Memory Integration — the owner's derived My-World memory
   * groupings and Hidden Gem Memory lines. OWNER-ONLY, SESSION-SCOPED,
   * READ-ONLY over the existing Memory system (never a second memory store).
   */
  memory: MyWorldMemory;
}

/**
 * The owner's own media library. All content is self-authored, so this reads the
 * owner's posts directly (owner sees their own drafts/processing — the whole
 * point of the owner-only buckets) and still projects COARSE (no coordinates,
 * no live labels). Other domains' expressions (Postcards / Memories / Gems) are
 * declared buckets, populated best-effort.
 *
 * This is the ONE builder that uses the raw projector rather than
 * `projectCandidatesProtected`, and deliberately: every row here is the viewer's
 * own (`author_id = viewer.viewerId`), which is exactly the case the choke point
 * passes through untouched — an owner's `location_privacy_mode` governs what
 * OTHERS see, not what they see of their own library. The query is owner-scoped
 * at line level, so there is no path by which a non-owner row reaches here.
 */
export async function buildMyWorldProjection(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  nowMs: number,
): Promise<MyWorldProjection> {
  const generatedAt = new Date(nowMs).toISOString();

  // THE OWNER'S OWN LIBRARY. This read did not even DESTRUCTURE `error`, so an
  // unreadable `posts` table rendered My World as an empty library — a person
  // being shown "you have no media" when in fact the database did not answer.
  // Of every surface this loader feeds, this is the one where the empty reading
  // is least survivable: the viewer knows it is false and has no way to tell
  // whether their uploads are gone. Refuse.
  //
  // My World does NOT go through the shared loader (it is owner-scoped, so the
  // blocks/mutes/private-account gates that loader exists to apply are all
  // no-ops against your own rows). It therefore needs the same refusal spelled
  // out here rather than inherited.
  let rows: MediaCandidateRow[] = [];
  {
    let settled: { data: unknown; error: unknown };
    try {
      settled = (await (sc as any)
        .from("posts")
        .select(SELECT)
        .eq("author_id", viewer.viewerId)
        .order("created_at", { ascending: false })
        .limit(DEFAULT_CANDIDATE_LIMIT)) as { data: unknown; error: unknown };
    } catch (err) {
      throw new MediaCandidatesUnavailableError("posts", String((err as any)?.message ?? err));
    }
    if (settled.error) {
      throw new MediaCandidatesUnavailableError(
        "posts",
        String((settled.error as any)?.message ?? (settled.error as any)?.code ?? "db_error"),
      );
    }
    if (!Array.isArray(settled.data)) {
      throw new MediaCandidatesUnavailableError("posts", "owner library read returned a non-array payload");
    }
    rows = settled.data as MediaCandidateRow[];
  }

  const published: MediaProjection[] = [];
  const drafts: MediaProjection[] = [];
  const archived: MediaProjection[] = [];
  const processing: MediaProjection[] = [];
  const trips: MediaProjection[] = [];

  for (const row of rows) {
    const status = (row as any).status ?? "active";
    const postStatus = (row as any).post_status;
    const rawMedia = Array.isArray(row.post_media) ? row.post_media : [];
    const isProcessing =
      rawMedia.length > 0 && rawMedia.every((m: any) => m && m.processing_status && m.processing_status !== "ready");

    if (status === "archived") {
      const p = toMediaProjection(row, nowMs);
      if (p) archived.push(p);
      continue;
    }
    if (postStatus === "draft") {
      const p = toMediaProjection(row, nowMs);
      if (p) drafts.push(p);
      continue;
    }
    if (isProcessing) {
      // Processing items may have no ready media; still list them so the owner
      // sees the upload in flight. Project may return null (no ready media) — in
      // that case fall back to a minimal placeholder projection.
      const p = toMediaProjection(row, nowMs);
      processing.push(
        p ?? {
          id: row.id,
          mediaType: "image",
          url: "",
          thumbnailUrl: null,
          width: null,
          height: null,
          durationSeconds: null,
          capturedAt: typeof row.created_at === "string" ? row.created_at : generatedAt,
          placeId: typeof row.canonical_place_id === "string" ? row.canonical_place_id : null,
          placeLabel: typeof row.location_name === "string" ? row.location_name : null,
          neighborhood: null,
          city: typeof row.location_city === "string" ? row.location_city : null,
          country: typeof row.location_country === "string" ? row.location_country : null,
          category: typeof row.category === "string" ? row.category : null,
          freshness: "historical",
          contributor: null,
        },
      );
      continue;
    }

    const p = toMediaProjection(row, nowMs);
    if (!p) continue;
    published.push(p);
    if ((row as any).trip_id) trips.push(p);
  }

  // Cross-domain bucket counts (§30) — read from each domain's OWN owner-scoped
  // table (reusing the existing per-object shape), best-effort. These carry a
  // COUNT only: the media items belong to their own domains' projections, and are
  // not re-projected here. Every read degrades to 0. The §31 memory build runs
  // in parallel with these.
  const [postcardsCount, memoriesCount, gemsCount, uploadsCount, tagged, memory] = await Promise.all([
    countOwned(sc, "passport_postcards", "user_id", viewer.viewerId, (r) => (r as any).status === "active" && (r as any).deleted_at == null),
    countOwned(sc, "memories", "owner_id", viewer.viewerId, (r) => !["deleted", "removed", "hidden"].includes(String((r as any).state ?? ""))),
    countOwned(sc, "hidden_gems", "submitted_by", viewer.viewerId, (r) => ["active", "pending"].includes(String((r as any).status ?? "active"))),
    countOwned(sc, "media_assets", "owner_user_id", viewer.viewerId),
    // §30 Tagged — OTHER people's posts this viewer is tagged in, re-gated. This
    // is the one non-owner bucket in My World, which is why it is the only one
    // that goes through the eligibility gate and the location choke point rather
    // than through countOwned.
    loadTaggedMedia(sc, viewer, nowMs).catch(() => [] as MediaProjection[]),
    // §31 memory is scoped to the SESSION viewer id — never a query param.
    buildMyWorldMemory(sc, viewer.viewerId).catch(() => undefined),
  ]);

  const buckets: MyWorldBucket[] = [
    { key: "all", label: "All", ownerOnly: false, count: published.length, media: published.slice(0, 60) },
    { key: "posts", label: "Posts", ownerOnly: false, count: published.length, media: published.slice(0, 60) },
    { key: "trips", label: "Trips", ownerOnly: false, count: trips.length, media: trips.slice(0, 60) },
    // Owner-only operational buckets (§30).
    { key: "drafts", label: "Drafts", ownerOnly: true, count: drafts.length, media: drafts.slice(0, 60) },
    { key: "archived", label: "Archived", ownerOnly: true, count: archived.length, media: archived.slice(0, 60) },
    { key: "uploads", label: "Uploads", ownerOnly: true, count: uploadsCount, media: [] },
    { key: "processing", label: "Processing", ownerOnly: true, count: processing.length, media: processing.slice(0, 60) },
    // Cross-domain buckets — counted from each domain's owner-scoped table.
    { key: "postcards", label: "Postcards", ownerOnly: false, count: postcardsCount, media: [] },
    { key: "memories", label: "Memories", ownerOnly: false, count: memoriesCount, media: [] },
    // Tagged — public posts this viewer is tagged in (`public.tags`, source_type
    // 'post', status 'approved'), re-gated and coarsened. See loadTaggedMedia.
    { key: "tagged", label: "Tagged", ownerOnly: false, count: tagged.length, media: tagged.slice(0, 60) },
    { key: "gems", label: "Hidden Gems", ownerOnly: false, count: gemsCount, media: [] },
  ];

  return {
    generatedAt,
    buckets,
    memory: memory ?? {
      ownerId: viewer.viewerId,
      visibility: "owner_only",
      groups: [],
      hiddenGemMemory: [],
      totals: { surfaced: 0, suppressed: 0 },
      notes: [],
    },
  };
}

/**
 * The post ids this viewer has been TAGGED in (§30 "Tagged" filter).
 *
 * WHAT WAS HERE BEFORE, AND WHY IT WAS WRONG. The Tagged bucket was a literal —
 * `{ key: "tagged", count: 0, media: [] }` — under the comment *"Tagged has no
 * backing people-tag table yet (pre-launch)"*. That comment is false, and it is
 * false in the direction that hides work the repository had already done:
 * `public.tags` is created by migration `0044_tags_hashtags.sql`, is present in
 * the production baseline, and is WRITTEN on the post-create path —
 * `routes/posts.ts` calls `processTagging({ sourceType: 'post', sourceId: post.id })`,
 * which upserts `(source_type, source_id, tagger_id, tagged_user_id, status)`
 * through `services/tagging/TaggingService.ts` after the tag-permission, block
 * and rate checks. The bucket was reporting zero over a populated table.
 *
 * STATUS. Only `status='approved'` rows count. A `pending` tag is one the tagged
 * user has not accepted (the `approval_required` tag permission writes it), and
 * surfacing it in their own library would be the acceptance the flow is asking
 * for. `routes/tags.ts` filters the same way.
 *
 * BEST-EFFORT, degrading to an empty list: a Tagged bucket that fails to load is
 * an empty bucket, exactly as it has always been. It can never widen anything —
 * the ids it produces are handed to `loadEligibleCandidates`, which re-gates
 * every one of them.
 */
export async function loadTaggedPostIds(
  sc: SupabaseClient,
  viewerId: string,
  limit: number = DEFAULT_CANDIDATE_LIMIT,
): Promise<string[]> {
  try {
    const { data, error } = await (sc as any)
      .from("tags")
      // `created_at`, NOT `tagged_at`. The canonical 0043 migration declares
      // `tagged_at` and it was never applied — migrations/README.md:12 and
      // docs/migrations.md:26 both record that live `tags` has no such column.
      // Naming it here failed the WHOLE read with 42703, which supabase-js
      // resolves rather than throws, so the bucket degraded to empty for every
      // viewer and looked exactly like "you have no tags".
      .select("source_id, created_at")
      .eq("tagged_user_id", viewerId)
      .eq("source_type", "post")
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      logger.warn({ err: error }, "myWorld: tags read failed — Tagged bucket degrades to empty");
      return [];
    }
    const ids: string[] = [];
    for (const r of ((data as any[]) ?? [])) {
      const id = (r as any)?.source_id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
    return [...new Set(ids)];
  } catch (err) {
    logger.warn({ err }, "myWorld: tags read threw — Tagged bucket degrades to empty");
    return [];
  }
}

/**
 * Project the media of the posts this viewer is tagged in (§30).
 *
 * THE GATES ARE NOT SKIPPED BECAUSE THE VIEWER IS TAGGED. Being tagged in a post
 * is not consent to see it: the tagger may have been blocked since, the author
 * may have gone private, the post may have been archived or moderated away. The
 * ids therefore go through `loadEligibleCandidates` — the same blocks / mutes /
 * suspension / status / publish_at / visibility / moderation gate plus the
 * private-account guard every other bucket crosses — and then through
 * `projectCandidatesProtected`, the location/gem choke point.
 *
 * `feedType: "for_you"` means PUBLIC posts only, in the query and again in the
 * gate. A tagged `trip_only` or `private` post is therefore withheld rather than
 * guessed at: admitting it would need a membership proof this bucket does not
 * hold, and under-showing a label is the safe direction. That is a stated bound,
 * not an oversight.
 */
export async function loadTaggedMedia(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  nowMs: number,
): Promise<MediaProjection[]> {
  const ids = await loadTaggedPostIds(sc, viewer.viewerId);
  if (ids.length === 0) return [];
  const rows = await loadEligibleCandidatesOrRefuse(sc, viewer, {
    feedType: "for_you",
    postIds: ids,
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  if (rows.length === 0) return [];
  return projectCandidatesProtected(sc, viewer, rows, nowMs);
}

/**
 * Count an owner's rows in a table, owner-scoped and best-effort. An optional
 * predicate applies a client-side status/tombstone filter (the source domains'
 * own deny rules). Any read failure or missing table degrades to 0.
 */
async function countOwned(
  sc: SupabaseClient,
  table: string,
  ownerCol: string,
  ownerId: string,
  keep?: (row: Record<string, unknown>) => boolean,
): Promise<number> {
  try {
    const { data } = await (sc as any).from(table).select("*").eq(ownerCol, ownerId).limit(1000);
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    return keep ? rows.filter(keep).length : rows.length;
  } catch {
    return 0;
  }
}

// ── Timeline (§17) ───────────────────────────────────────────────────────────

export interface TimeRail {
  key: "now" | "earlier" | "historical";
  label: string;
  count: number;
  media: MediaProjection[];
}

export interface TimelineProjection {
  generatedAt: string;
  rails: TimeRail[];
  /**
   * Media alone never fabricates a forecast — this stays false. The §17
   * Likely-Next forecast, when it exists, comes from the intel substrate and is
   * surfaced in `bands.likelyNext`, carrying its confidence band. It is NEVER a
   * media-derived signal.
   */
  forecastAvailable: false;
  totalPerspectives: number;
  /**
   * The §17 Time Architecture — Earlier / Now / Typical / Likely-Next. Each band
   * carries its source class so the client renders distinct visual treatments
   * (§46). Now is the ONLY band that may be live (gated); Typical and Likely-Next
   * are read from the intel substrate and are NEVER live; a Likely-Next forecast
   * always carries a confidence band. Place-scoped: Now/Typical/Likely-Next
   * populate only when a placeId subject is provided (else well-formed empty).
   */
  bands: MediaTimeBands;
}

export async function buildTimelineProjection(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  opts: { placeId?: string | null; nowMs: number },
): Promise<TimelineProjection> {
  const nowMs = opts.nowMs;
  const generatedAt = new Date(nowMs).toISOString();

  const candidates = await loadEligibleCandidatesOrRefuse(sc, viewer, {
    feedType: opts.placeId ? "for_you" : "following",
    placeId: opts.placeId ?? undefined,
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  const media = (await projectCandidatesProtected(sc, viewer, candidates, nowMs)).sort(
    (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
  );

  const now: MediaProjection[] = [];
  const earlier: MediaProjection[] = [];
  const historical: MediaProjection[] = [];
  for (const m of media) {
    const ageMs = nowMs - new Date(m.capturedAt).getTime();
    if (ageMs < 60 * 60 * 1000) now.push(m);
    else if (ageMs < 24 * 60 * 60 * 1000) earlier.push(m);
    else historical.push(m);
  }

  const rails: TimeRail[] = [
    { key: "now", label: "Now", count: now.length, media: now.slice(0, 40) },
    { key: "earlier", label: "Earlier", count: earlier.length, media: earlier.slice(0, 40) },
    { key: "historical", label: "Historical", count: historical.length, media: historical.slice(0, 40) },
  ];

  // ── §17 four-band Time Architecture (additive) ──────────────────────────────
  // Now = the gated live current-state (fail-closed; empty ⇒ no now label, never
  // fabricated). Typical + Likely-Next = the intel time substrate, read READ-ONLY
  // and OFF the live path — they are never live, and a forecast carries its
  // confidence band. Earlier = the observed media record. Place-scoped: without a
  // placeId, the gated read and the substrate read both return empty, so those
  // three bands are well-formed empty while Earlier still carries the media.
  const [currentState, substrate] = await Promise.all([
    readCurrentState(sc, opts.placeId ?? null, nowMs),
    readIntelTimeSubstrate(sc, opts.placeId ?? null, nowMs),
  ]);
  const { bands, neverLiveRemoved } = assembleTimeBands({
    media,
    now: { available: currentState.live, liveClaims: currentState.claims, crowdLabel: currentState.crowdLabel },
    substrate,
  });
  if (neverLiveRemoved > 0) {
    // A prediction/pattern reached a live flag — a truth-boundary regression.
    // Dropped fail-closed above; logged here so it is visible, not silent.
    logger.error(
      { placeId: opts.placeId ?? null, neverLiveRemoved },
      "mediaTimeline: never-live invariant removed items — a projector tagged a non-observation as live",
    );
  }

  return { generatedAt, rails, forecastAvailable: false, totalPerspectives: media.length, bands };
}

// ── §21 Media Map (perspective counts per place — NO location engine) ────────

export interface MapCluster {
  /** Opaque canonical place id — the client positions this via the Map gateway. */
  placeId: string | null;
  label: string;
  perspectiveCount: number;
  freshness: FreshnessState;
}

export interface MediaMapProjection {
  generatedAt: string;
  /**
   * Perspective counts keyed by canonical place. This projection deliberately
   * carries NO geometry: geographic placement is delegated to the canonical Map
   * projection (spec §21 — Media Map does not own a second location engine). The
   * client joins these counts onto positions it already has from the Map gateway.
   */
  clusters: MapCluster[];
  totalPerspectives: number;
}

export async function buildMediaMapProjection(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  city: string | null,
  nowMs: number,
): Promise<MediaMapProjection> {
  const generatedAt = new Date(nowMs).toISOString();
  const candidates = await loadEligibleCandidatesOrRefuse(sc, viewer, {
    feedType: "for_you",
    city: city ?? undefined,
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  const media = await projectCandidatesProtected(sc, viewer, candidates, nowMs);

  const zoneMap = groupZones(media);
  const clusters: MapCluster[] = [...zoneMap.values()]
    // Only clusters bound to a canonical place id can be positioned by the Map
    // gateway; a label-only cluster has no safe position, so it is omitted rather
    // than given an invented one.
    .filter((z) => z.placeId)
    .map((z) => ({
      placeId: z.placeId,
      label: z.label,
      perspectiveCount: z.items.length,
      freshness: aggregateFreshness(z.items.map((m) => m.capturedAt), nowMs),
    }))
    .sort((a, b) => b.perspectiveCount - a.perspectiveCount);

  return { generatedAt, clusters, totalPerspectives: media.length };
}
