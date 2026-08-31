/**
 * MediaProjectionService (§41/§42) — the World-first projection reader.
 *
 * A THIN reader/aggregator: it fetches already-privacy-owned rows from existing
 * tables, runs them through the SHARED eligibility gate
 * (lib/mediaEligibility.filterEligibleMediaCandidates — the fail-closed
 * distribution gate) and the SHARED coarse projector
 * (lib/media/mediaProjection.toMediaProjection), then assembles the §43 shapes.
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
  projectMediaCandidates,
  toMediaProjection,
  type MediaCandidateRow,
  type MediaProjection,
} from "../../lib/media/mediaProjection.js";
import { readLiveClaimEnvelopes, type LiveClaimEnvelope } from "../../lib/liveClaimRead.js";
import { aggregateFreshness, type FreshnessState } from "../../lib/media/mediaFreshness.js";
import {
  assembleTimeBands,
  readIntelTimeSubstrate,
  type MediaTimeBands,
} from "../../lib/media/mediaTimeBands.js";
import { logger } from "../../lib/logger.js";
import {
  buildCategoryBuckets,
  buildPerspectiveSummary,
  type CategoryBucket,
  type PerspectiveSummary,
} from "./MediaPerspectiveService.js";

const DEFAULT_CANDIDATE_LIMIT = 200;

const SELECT = `${MEDIA_PROJECTION_POST_COLUMNS}, post_media(${MEDIA_PROJECTION_POST_MEDIA_COLUMNS}), profiles!author_id(${MEDIA_PROJECTION_PROFILE_COLUMNS})`;

export interface ViewerResolved {
  viewerId: string;
  viewerCountry: string | null;
  viewerAge: number | null;
  followedCreatorIds: Set<string>;
  viewerTripIds: Set<string>;
}

/** Calculate whole-year age from an ISO date-of-birth, or null. */
function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const t = new Date(dob).getTime();
  if (!Number.isFinite(t)) return null;
  const years = (Date.now() - t) / (1000 * 60 * 60 * 24 * 365.25);
  return years >= 0 && years < 200 ? Math.floor(years) : null;
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
          .select("location_country, date_of_birth")
          .eq("id", viewerId)
          .maybeSingle();
        viewerCountry = (data as any)?.location_country ?? null;
        viewerAge = ageFromDob((data as any)?.date_of_birth ?? null);
      } catch {
        /* non-fatal */
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
  tripId?: string | null;
  postIds?: string[] | null;
  limit?: number;
}

/**
 * Fetch and eligibility-filter media candidates. Returns the eligible raw rows
 * (post_media + profiles attached), or [] on any failure / empty result. Never
 * throws to the route.
 */
export async function loadEligibleCandidates(
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

  if (filter.placeId) query = query.eq("canonical_place_id", filter.placeId);
  if (filter.tripId) query = query.eq("trip_id", filter.tripId);
  if (filter.city) query = query.ilike("location_city", `%${filter.city}%`);
  if (filter.postIds && filter.postIds.length > 0) query = query.in("id", filter.postIds.slice(0, limit));

  let rows: any[] = [];
  try {
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return [];
    rows = data;
  } catch {
    return [];
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
  // Fail-closed: a block-fetch failure means we cannot prove nothing is from a
  // blocked user, so we surface nothing rather than risk it.
  if (blockFetchFailed) return [];
  return eligible as unknown as MediaCandidateRow[];
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
  const candidates = await loadEligibleCandidates(sc, viewer, {
    feedType: "for_you",
    city: city ?? undefined,
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  const media = projectMediaCandidates(candidates, nowMs);

  const forYouNow = buildCategoryBuckets(media, nowMs);

  const zoneMap = groupZones(media);
  const zoneList = [...zoneMap.values()]
    .sort((a, b) => b.items.length - a.items.length)
    .slice(0, MAX_WORLD_ZONES);

  // Read the gated live state for each zone that has a canonical place id. The
  // read is fail-closed; when live is off (the prod default) every zone gets an
  // empty live state and NO state badge — exactly the anti-fabrication rule.
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
  freshness: FreshnessState;
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
      console.warn(
        "[MediaProjectionService] place identity read failed; projection will carry nulls",
        { placeId, code: (error as any)?.code, message: (error as any)?.message },
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

  const candidates = await loadEligibleCandidates(sc, viewer, {
    feedType: "for_you",
    placeId,
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  const media = projectMediaCandidates(candidates, nowMs);
  if (!placeCity) placeCity = media.find((m) => m.city)?.city ?? null;
  if (!placeName) placeName = media.find((m) => m.placeLabel)?.placeLabel ?? null;

  const currentState = await readCurrentState(sc, placeId, nowMs);
  const perspectives = buildPerspectiveSummary(media, nowMs);

  return {
    placeId,
    generatedAt,
    place: { id: placeId, name: placeName, city: placeCity, country: placeCountry, neighborhood: placeNeighborhood },
    currentState,
    perspectives,
    freshness: aggregateFreshness(media.map((m) => m.capturedAt), nowMs),
  };
}

// ── §27 People lens ──────────────────────────────────────────────────────────

export interface PeopleGroup {
  contributor: MediaProjection["contributor"];
  perspectiveCount: number;
  freshness: FreshnessState;
  media: MediaProjection[];
}

export interface PeopleProjection {
  generatedAt: string;
  people: PeopleGroup[];
  totalPerspectives: number;
}

export async function buildPeopleProjection(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  nowMs: number,
): Promise<PeopleProjection> {
  const generatedAt = new Date(nowMs).toISOString();
  const candidates = await loadEligibleCandidates(sc, viewer, {
    feedType: "following",
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  const media = projectMediaCandidates(candidates, nowMs);

  const byContributor = new Map<string, MediaProjection[]>();
  for (const m of media) {
    const cid = m.contributor?.id;
    if (!cid) continue;
    const list = byContributor.get(cid) ?? [];
    list.push(m);
    byContributor.set(cid, list);
  }

  const people: PeopleGroup[] = [];
  for (const items of byContributor.values()) {
    const sorted = items.sort(
      (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
    );
    people.push({
      contributor: sorted[0].contributor,
      perspectiveCount: sorted.length,
      freshness: aggregateFreshness(sorted.map((m) => m.capturedAt), nowMs),
      media: sorted.slice(0, 12),
    });
  }
  people.sort((a, b) => b.perspectiveCount - a.perspectiveCount);

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
}

/**
 * The owner's own media library. All content is self-authored, so this reads the
 * owner's posts directly (owner sees their own drafts/processing — the whole
 * point of the owner-only buckets) and still projects COARSE (no coordinates,
 * no live labels). Other domains' expressions (Postcards / Memories / Gems) are
 * declared buckets, populated best-effort.
 */
export async function buildMyWorldProjection(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  nowMs: number,
): Promise<MyWorldProjection> {
  const generatedAt = new Date(nowMs).toISOString();

  let rows: MediaCandidateRow[] = [];
  try {
    const { data } = await (sc as any)
      .from("posts")
      .select(SELECT)
      .eq("author_id", viewer.viewerId)
      .order("created_at", { ascending: false })
      .limit(DEFAULT_CANDIDATE_LIMIT);
    rows = Array.isArray(data) ? (data as MediaCandidateRow[]) : [];
  } catch {
    rows = [];
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

  const buckets: MyWorldBucket[] = [
    { key: "all", label: "All", ownerOnly: false, count: published.length, media: published.slice(0, 60) },
    { key: "posts", label: "Posts", ownerOnly: false, count: published.length, media: published.slice(0, 60) },
    { key: "trips", label: "Trips", ownerOnly: false, count: trips.length, media: trips.slice(0, 60) },
    // Owner-only operational buckets (§30).
    { key: "drafts", label: "Drafts", ownerOnly: true, count: drafts.length, media: drafts.slice(0, 60) },
    { key: "archived", label: "Archived", ownerOnly: true, count: archived.length, media: archived.slice(0, 60) },
    { key: "processing", label: "Processing", ownerOnly: true, count: processing.length, media: processing.slice(0, 60) },
    // Declared cross-domain buckets — populated by their own domains in a later
    // slice; well-formed empty here rather than absent.
    { key: "postcards", label: "Postcards", ownerOnly: false, count: 0, media: [] },
    { key: "memories", label: "Memories", ownerOnly: false, count: 0, media: [] },
    { key: "tagged", label: "Tagged", ownerOnly: false, count: 0, media: [] },
    { key: "gems", label: "Hidden Gems", ownerOnly: false, count: 0, media: [] },
  ];

  return { generatedAt, buckets };
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

  const candidates = await loadEligibleCandidates(sc, viewer, {
    feedType: opts.placeId ? "for_you" : "following",
    placeId: opts.placeId ?? undefined,
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  const media = projectMediaCandidates(candidates, nowMs).sort(
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
  const candidates = await loadEligibleCandidates(sc, viewer, {
    feedType: "for_you",
    city: city ?? undefined,
    limit: DEFAULT_CANDIDATE_LIMIT,
  });
  const media = projectMediaCandidates(candidates, nowMs);

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
