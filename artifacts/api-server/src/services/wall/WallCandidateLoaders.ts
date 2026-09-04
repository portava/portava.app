/**
 * WallCandidateLoaders — the non-Post candidate fetchers for the Wall feed.
 *
 * The Post loader (routes/wall.ts) supplies the social/photo/video spine. The
 * Wall feed object model (spec §6) has more members whose SHAPES and client
 * renderers already exist but whose server candidates were never fetched:
 *
 *   • Postcards      (§10) — the canonical Passport-postcard posts, projected
 *                            with their DISTINCT story presentation, not as a
 *                            plain post with a badge.
 *   • Video / media  (§11) — media-BEARING posts, reusing the Media v2 reader
 *                            (MediaProjectionService) so the coarse, whitelisted
 *                            DisplayMedia the client needs is actually populated.
 *   • Shared Moments (§12) — real-world overlaps the viewer is an accepted member
 *                            of, surfaced as a social memory, gated by the
 *                            underlying Shared-Moment consent/membership.
 *
 * EVERY loader here is a THIN reader. It owns no truth: it copies canonical rows
 * into `WallCandidate`s and hands them to the SAME eligibility → block →
 * visibility gate the Post loader uses (WallProjectionService.projectObjects,
 * spec §23/§24). The loaders never decide readability themselves for post-like
 * objects (that stays with decidePostReadable inside the gate); Shared Moments
 * resolve their consent here (accepted membership) and set
 * `callerVisibilityResolved` so the gate still applies eligibility + block.
 *
 * GRACEFUL DEGRADATION IS LOAD-BEARING (spec §34). Every loader is fully
 * fail-soft: any read failure degrades to an EMPTY candidate set, so a failing
 * loader costs the feed one object TYPE, never the feed itself. The Post spine
 * is untouched by any loader here.
 */
import type {
  DisplayMedia,
  PublicActorRef,
  PublicPlaceRef,
  WallObjectType,
} from "../../lib/wallProjection.js";
import type { WallRankSignals } from "./WallRankingService.js";
import { dedupeCandidates, type WallCandidate } from "./WallProjectionService.js";
import { isPostPublished } from "../../lib/postVisibility.js";
import {
  resolveViewer,
  loadEligibleCandidates,
} from "../media/MediaProjectionService.js";
import { toMediaProjection, type MediaCandidateRow } from "../../lib/media/mediaProjection.js";
import { areSharedMomentsEnabled } from "../../lib/places/sharedMoments.js";
import { fetchBlockedSet } from "../../lib/blocks.js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ svc: "wallCandidateLoaders" });

/** How many candidates each supplementary loader fetches before gating. Bounded
 *  to keep the first server page fast (spec TABLE 4: < 500 ms backend). */
const LOADER_FETCH = 60;
/** Coarse participant labels a Shared Moment may carry (spec §12 — a memory, not
 *  a cohort dump). */
const MAX_MOMENT_PARTICIPANTS = 5;

/**
 * The candidate bundle a loader returns — the same triple the route's Post
 * loader produces, so they merge cleanly. `signals` feeds For You ranking and
 * `placeByObject` feeds the Live For You strip's subject derivation.
 */
export interface LoadedWallCandidates {
  candidates: WallCandidate[];
  signals: Map<string, WallRankSignals>;
  placeByObject: Map<string, PublicPlaceRef>;
}

/** The viewer facts the supplementary loaders need. A subset of the route's
 *  WallViewerContext, passed explicitly so these stay independently testable. */
export interface LoaderViewer {
  viewerId: string;
  followedCreatorIds: Set<string>;
}

/**
 * Optional per-request loader options. `snapshotAtIso` is the For You session's
 * created-at freeze horizon (from the For You cursor): supplementary candidates
 * must be frozen to the SAME horizon as the Post spine (routes/wall.ts
 * loadCandidates), otherwise a postcard/video published mid-pagination enters the
 * candidate set, shifts ranks, and duplicates/skips items across pages (§28).
 * Absent (Following mode, or the first For You page) ⇒ no horizon, freshest rows.
 */
export interface LoaderOptions {
  snapshotAtIso?: string;
}

/** Is a canonical row within the For You freeze horizon? A row with no created_at
 *  cannot be proven pre-snapshot, so it is excluded once a horizon is set. */
function withinSnapshot(createdAt: unknown, snapshotAtIso: string | undefined): boolean {
  if (!snapshotAtIso) return true;
  const c = typeof createdAt === "string" ? createdAt : "";
  return c !== "" && c <= snapshotAtIso;
}

function emptyLoaded(): LoadedWallCandidates {
  return { candidates: [], signals: new Map(), placeByObject: new Map() };
}

// ── Shared batched enrichment ────────────────────────────────────────────────

interface AuthorProfile {
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  accountStatus: string | null;
}

/** Batch-load author identity + account status (eligibility). Fail-soft: a
 *  failed read leaves an empty map, so authors project without an actor byline
 *  rather than breaking the loader. */
async function batchProfiles(sc: any, ids: string[]): Promise<Map<string, AuthorProfile>> {
  const out = new Map<string, AuthorProfile>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return out;
  try {
    const { data } = await sc
      .from("profiles")
      .select("id, display_name, username, avatar_url, account_status")
      .in("id", unique.slice(0, 500));
    for (const p of (data as any[]) ?? []) {
      out.set(String(p.id), {
        displayName: String(p.display_name ?? p.username ?? "Traveler"),
        handle: p.username ?? null,
        avatarUrl: p.avatar_url ?? null,
        accountStatus: p.account_status ?? "active",
      });
    }
  } catch (err) {
    logger.warn({ err }, "profile batch read failed");
  }
  return out;
}

/** Batch-load coarse place refs (id + labels only — NEVER coordinates, spec
 *  §23). Fail-soft. */
async function batchPlaces(sc: any, ids: string[]): Promise<Map<string, PublicPlaceRef>> {
  const out = new Map<string, PublicPlaceRef>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return out;
  try {
    const { data } = await sc
      .from("places")
      .select("id, name, city, country_code")
      .in("id", unique.slice(0, 500));
    for (const pl of (data as any[]) ?? []) {
      out.set(String(pl.id), {
        placeId: String(pl.id),
        name: String(pl.name ?? "Place"),
        city: pl.city ?? null,
        country: pl.country_code ?? null,
      });
    }
  } catch (err) {
    logger.warn({ err }, "place batch read failed");
  }
  return out;
}

function actorFrom(prof: AuthorProfile | undefined, authorId: string): PublicActorRef | undefined {
  if (!prof) return undefined;
  return {
    userId: authorId,
    displayName: prof.displayName,
    handle: prof.handle,
    avatarUrl: prof.avatarUrl,
  };
}

/** Map ready post_media child rows to coarse DisplayMedia. Same "ready +
 *  moderation-clean + has a url" contract as lib/media/mediaProjection; carries
 *  no coordinate columns (none exist on post_media). */
function readyMediaToDisplay(rows: any[]): DisplayMedia[] {
  return (rows ?? [])
    .filter(
      (m: any) =>
        m &&
        m.processing_status === "ready" &&
        m.moderation_status !== "rejected" &&
        m.moderation_status !== "flagged" &&
        typeof m.public_url === "string" &&
        m.public_url.trim().length > 0,
    )
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((m: any) => ({
      mediaId: String(m.id),
      kind: m.media_type === "video" ? ("video" as const) : ("image" as const),
      url: String(m.public_url).trim(),
      thumbnailUrl: typeof m.thumbnail_url === "string" ? m.thumbnail_url : null,
      width: typeof m.width === "number" ? m.width : null,
      height: typeof m.height === "number" ? m.height : null,
      durationMs: typeof m.duration_seconds === "number" ? Math.round(m.duration_seconds * 1000) : null,
      // Autoplay is deferred to client product/device/reduced-motion policy
      // (§11/§36); the server never forces it on.
      autoplayEligible: m.media_type === "video" ? false : undefined,
      processing: false,
    }));
}

// ── 1. Postcards (spec §10) ──────────────────────────────────────────────────

const POSTCARD_COLUMNS =
  "id, author_id, trip_id, content, visibility, status, post_status, created_at, published_at, " +
  "canonical_place_id, has_video, media_count, category, " +
  "location_city, location_country, save_count";

/**
 * Is this `passport_postcards` row a LIVE postcard? The same predicate the
 * canonical Passport readers apply (MediaProjectionService.countOwned,
 * compass/PassportRemembersService; routes/passport.ts filters status='active'
 * at the DB): moderation-active and not tombstoned.
 */
function isLivePostcardRow(r: any): boolean {
  return !!r && String(r.status ?? "") === "active" && r.deleted_at == null;
}

/**
 * Load Postcard candidates — the canonical Passport-postcard posts, scoped to
 * followed authors in BOTH modes (a viewer's own postcards live on their
 * Passport, not the Wall's Following-of-others). Projected as `postcard` so the
 * client's distinct story presentation renders instead of a plain post.
 *
 * ── WHAT MAKES A POST A POSTCARD (the discriminator) ─────────────────────────
 * A live `passport_postcards` row pointing at the post (post_id) — NOT
 * `posts.add_to_passport`. That column is the author's INTENT flag and it
 * defaults TRUE everywhere: `boolean DEFAULT true NOT NULL` in the schema,
 * `addToPassport ?? true` in POST /posts, `.default(true)` in POST /postcards.
 * So a Hidden-Gem post, a plain text update, or any composer that omits the
 * field carries add_to_passport=true, and a loader keyed on it rendered all of
 * them as Postcards (§10: a Postcard is a distinct object, never a Post with a
 * badge).
 *
 * The postcards system itself never treats the flag as the fact. It creates
 * the `passport_postcards` row only when a post actually BECOMES a postcard:
 * POST /posts on create when it has media + add_to_passport + active
 * (lib/locationVerify.shouldCreatePostcard), and POST /postcards/:id/media/
 * :mediaId/complete lazily on the FIRST ready media (routes/postcards.ts). A
 * post with the flag and no media never gets a row and is not a postcard.
 * Every canonical Postcard reader — GET /passport/:handle/postcards,
 * GET /me/passport/postcards, Compass "What Portava Remembers", the Media v2
 * ownership count — reads `passport_postcards`, so this loader reads the same
 * table and the same liveness predicate (status='active', not tombstoned).
 *
 * Two reads: the live postcard rows for the followed authors (the
 * discriminator), then the `posts` rows those point at (the canonical object:
 * text, visibility, place, delayed-publish state). A post is emitted only when
 * it is in BOTH sets, and only when it is `status='active'` AND
 * `post_status='published'` — the delayed-publish gate the Post spine applies
 * (lib/postVisibility.isPostPublished); a postcard whose author asked for it
 * to stay hidden until they left the place is not served (§23).
 *
 * Post-like → the projection gate re-checks visibility with decidePostReadable,
 * exactly as the Post loader; this loader only SELECTS and shapes.
 */
export async function loadPostcardCandidates(
  sc: any,
  mode: "for_you" | "following",
  viewer: LoaderViewer,
  opts: LoaderOptions = {},
): Promise<LoadedWallCandidates> {
  const followed = [...viewer.followedCreatorIds];
  if (followed.length === 0) return emptyLoaded(); // no in-graph postcards to show

  // 1. The discriminator: live passport_postcards rows for followed authors.
  const postcardPostIds = new Set<string>();
  try {
    const { data } = await sc
      .from("passport_postcards")
      .select("post_id, user_id, status, deleted_at, created_at")
      .in("user_id", followed.slice(0, 500))
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(LOADER_FETCH);
    // Re-checked in memory (status + tombstone) so a row fed past the query
    // filter cannot resurrect a hidden/reported/deleted postcard on the Wall.
    for (const r of (data as any[]) ?? []) {
      if (isLivePostcardRow(r) && r.post_id) postcardPostIds.add(String(r.post_id));
    }
  } catch (err) {
    logger.warn({ err }, "postcard discriminator read failed — degrading to no postcards");
    return emptyLoaded();
  }
  if (postcardPostIds.size === 0) return emptyLoaded();

  // 2. The canonical objects those postcards point at.
  let rows: any[] = [];
  try {
    let q = sc
      .from("posts")
      .select(POSTCARD_COLUMNS)
      .in("id", [...postcardPostIds].slice(0, 500))
      .eq("status", "active")
      // Delayed-publish gate — same DB predicate as the Post spine and the
      // Following / global feeds (routes/posts.ts). Re-checked in memory below.
      .eq("post_status", "published")
      .in("author_id", followed.slice(0, 500))
      .order("created_at", { ascending: false })
      .limit(LOADER_FETCH);
    // Freeze to the For You horizon so a newly-published postcard can't enter
    // mid-pagination (mirrors the Post spine's `.lte(created_at, snapshotAt)`).
    if (opts.snapshotAtIso) q = q.lte("created_at", opts.snapshotAtIso);
    const { data } = await q;
    // In-memory guards, independent of the query filters: the row must be one
    // a live postcard points at (the discriminator) and must be published.
    rows = ((data as any[]) ?? []).filter(
      (r) => r && postcardPostIds.has(String(r.id)) && isPostPublished(r),
    );
  } catch (err) {
    logger.warn({ err }, "postcard candidate read failed — degrading to no postcards");
    return emptyLoaded();
  }
  if (rows.length === 0) return emptyLoaded();

  const authorIds = rows.map((r) => String(r.author_id));
  const placeIds = rows.map((r) => r.canonical_place_id).filter((x: any): x is string => !!x);
  const postIds = rows.map((r) => String(r.id));

  // Media for the postcards, batched (one read for all of them).
  const mediaByPost = new Map<string, DisplayMedia[]>();
  try {
    if (postIds.length > 0) {
      const { data } = await sc
        .from("post_media")
        .select(
          "id, post_id, media_type, public_url, thumbnail_url, width, height, duration_seconds, sort_order, processing_status, moderation_status",
        )
        .in("post_id", postIds.slice(0, 500));
      const grouped = new Map<string, any[]>();
      for (const m of (data as any[]) ?? []) {
        const pid = String(m.post_id);
        (grouped.get(pid) ?? grouped.set(pid, []).get(pid)!).push(m);
      }
      for (const [pid, ms] of grouped) mediaByPost.set(pid, readyMediaToDisplay(ms));
    }
  } catch (err) {
    logger.warn({ err }, "postcard media batch read failed — postcards project without media");
  }

  const [profiles, places] = await Promise.all([
    batchProfiles(sc, authorIds),
    batchPlaces(sc, placeIds),
  ]);

  const out = emptyLoaded();
  for (const r of rows) {
    const id = String(r.id);
    const authorId = String(r.author_id);
    const prof = profiles.get(authorId);
    const placeRef = r.canonical_place_id ? places.get(String(r.canonical_place_id)) ?? null : null;
    const media = mediaByPost.get(id) ?? [];

    out.candidates.push({
      objectType: "postcard",
      canonicalObjectId: id,
      authorId,
      visibility: r.visibility ?? null,
      tripId: r.trip_id ?? null,
      publishedAt: String(r.published_at ?? r.created_at),
      text: r.content ?? null,
      place: placeRef,
      actor: actorFrom(prof, authorId),
      media: media.length > 0 ? media : undefined,
      authorAccountStatus: prof?.accountStatus ?? "active",
      isDeleted: false,
    });
    out.signals.set(id, {
      category: r.category ?? null,
      city: r.location_city ?? null,
      country: r.location_country ?? null,
      saveCount: Number(r.save_count ?? 0),
      isFirstImpression: true,
    });
    if (placeRef) out.placeByObject.set(id, placeRef);
  }
  return out;
}

// ── 2. Video / media (spec §11) ──────────────────────────────────────────────

/**
 * Load media-bearing candidates by reusing the Media v2 reader
 * (MediaProjectionService.loadEligibleCandidates), which already runs the SHARED,
 * fail-closed media eligibility + block gate (lib/mediaEligibility). Each row is
 * projected to the coarse, whitelisted media shape (toMediaProjection — never a
 * coordinate) and emitted as `video` (a video-first post) or a media-populated
 * `social_post`.
 *
 * Scoped to the follow graph (feedType 'following') in both modes so it enriches
 * followed content with real DisplayMedia without pulling outside-graph objects
 * into the feed (discovery stays the Post loader's job). The result still passes
 * through the Wall gate (projectObjects) like every other candidate — the media
 * gate is an additional, stricter layer, not a replacement.
 */
export async function loadVideoMediaCandidates(
  sc: any,
  viewerId: string,
  opts: LoaderOptions = {},
): Promise<LoadedWallCandidates> {
  try {
    const resolved = await resolveViewer(sc, viewerId, { needFollows: true });
    if (resolved.followedCreatorIds.size === 0) return emptyLoaded();

    const fetched: MediaCandidateRow[] = await loadEligibleCandidates(sc, resolved, {
      feedType: "following",
      limit: LOADER_FETCH,
    });
    // Freeze to the For You horizon: drop media published after the session
    // snapshot so it can't drift ranks mid-pagination (like the Post spine).
    const rows = opts.snapshotAtIso
      ? fetched.filter((r) => withinSnapshot((r as any).created_at, opts.snapshotAtIso))
      : fetched;
    if (rows.length === 0) return emptyLoaded();

    const nowMs = Date.now();
    const out = emptyLoaded();
    for (const row of rows) {
      const proj = toMediaProjection(row, nowMs);
      if (!proj) continue; // only media-bearing posts belong to this loader

      const id = String(row.id);
      const authorId = row.author_id ? String(row.author_id) : "";
      if (!authorId) continue;

      const display: DisplayMedia = {
        mediaId: proj.id,
        kind: proj.mediaType,
        url: proj.url,
        thumbnailUrl: proj.thumbnailUrl,
        width: proj.width,
        height: proj.height,
        durationMs: proj.durationSeconds != null ? Math.round(proj.durationSeconds * 1000) : null,
        autoplayEligible: proj.mediaType === "video" ? false : undefined,
        processing: false,
      };

      // Coarse place ref straight from the whitelisted projection labels — no
      // coordinate, no extra `places` read.
      const placeRef: PublicPlaceRef | null = proj.placeId
        ? {
            placeId: proj.placeId,
            name: proj.placeLabel ?? proj.city ?? "Place",
            city: proj.city,
            country: proj.country,
          }
        : null;

      const contributor = proj.contributor;
      const actor: PublicActorRef | undefined = contributor
        ? {
            userId: contributor.id,
            displayName: contributor.name ?? contributor.username ?? "Traveler",
            handle: contributor.username ?? null,
            avatarUrl: contributor.avatarUrl ?? null,
          }
        : undefined;

      // Real account status straight off the embedded profile so the Wall gate
      // re-checks author eligibility itself (the media gate already dropped
      // suspended/banned authors; this keeps the two gates independent).
      const rawProfile = Array.isArray((row as any).profiles) ? (row as any).profiles[0] : (row as any).profiles;
      const accountStatus = rawProfile?.account_status ?? "active";

      const objectType: WallObjectType = proj.mediaType === "video" ? "video" : "social_post";

      out.candidates.push({
        objectType,
        canonicalObjectId: id,
        authorId,
        visibility: (row as any).visibility ?? null,
        tripId: (row as any).trip_id ?? null,
        publishedAt: String((row as any).created_at ?? proj.capturedAt),
        text: (row as any).content ?? null,
        place: placeRef,
        actor,
        media: [display],
        authorAccountStatus: accountStatus,
        isDeleted: false,
      });
      out.signals.set(id, {
        category: proj.category ?? null,
        city: proj.city ?? null,
        country: proj.country ?? null,
        saveCount: 0,
        isFirstImpression: true,
      });
      if (placeRef) out.placeByObject.set(id, placeRef);
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "video/media candidate load failed — degrading to no media objects");
    return emptyLoaded();
  }
}

// ── 3. Shared Moments (spec §12) ─────────────────────────────────────────────

/**
 * Load Shared Moment candidates the viewer is an ACCEPTED member of — the same
 * consent boundary GET /shared-moments enforces (an accepted membership joined to
 * an active moment). Because membership resolves the moment's visibility, each
 * candidate sets `callerVisibilityResolved = true`; the Wall gate then still
 * applies eligibility + a bidirectional block against the moment owner.
 *
 * Gated behind the Shared Moments capability flag (fail-closed): if it is off (the
 * prod default) this loader emits nothing. Participant labels are coarse and
 * block-filtered; a moment with no readable participants still surfaces as a
 * memory of the place.
 */
export async function loadSharedMomentCandidates(
  sc: any,
  viewerId: string,
  opts: LoaderOptions = {},
): Promise<LoadedWallCandidates> {
  try {
    if (!(await areSharedMomentsEnabled(sc))) return emptyLoaded();
  } catch {
    return emptyLoaded(); // fail-closed
  }

  let memberships: any[] = [];
  try {
    const { data } = await sc
      .from("shared_moment_memberships")
      .select("role, status, shared_moments(*)")
      .eq("user_id", viewerId)
      .eq("status", "accepted")
      .order("updated_at", { ascending: false })
      .limit(LOADER_FETCH);
    memberships = (data as any[]) ?? [];
  } catch (err) {
    logger.warn({ err }, "shared moment membership read failed — degrading to no moments");
    return emptyLoaded();
  }

  const moments = memberships
    .map((m) => m?.shared_moments)
    .filter((row: any) => row && row.status === "active" && row.owner_id)
    // Freeze to the For You horizon: a Moment created after the session snapshot
    // must not enter mid-pagination (mirrors the Post spine's created-at freeze).
    .filter((row: any) => withinSnapshot(row.created_at, opts.snapshotAtIso));
  if (moments.length === 0) return emptyLoaded();

  const momentIds = moments.map((m: any) => String(m.id));
  const ownerIds = moments.map((m: any) => String(m.owner_id));
  const placeIds = moments.map((m: any) => m.place_id).filter((x: any): x is string => !!x);

  // Coarse participant labels, block-filtered. A null blocked-set (read failed)
  // is treated as "cannot prove nobody is blocked" ⇒ show no participant labels
  // rather than risk surfacing a blocked person (fail-closed, spec §23).
  const blocked = await fetchBlockedSet(sc, viewerId);
  const membersByMoment = new Map<string, string[]>();
  try {
    if (momentIds.length > 0) {
      const { data } = await sc
        .from("shared_moment_memberships")
        .select("moment_id, user_id, status")
        .in("moment_id", momentIds.slice(0, 500))
        .eq("status", "accepted");
      for (const m of (data as any[]) ?? []) {
        const mid = String(m.moment_id);
        const uid = String(m.user_id);
        if (uid === viewerId) continue;
        if (blocked === null || blocked.has(uid)) continue;
        const list = membersByMoment.get(mid) ?? [];
        if (list.length < MAX_MOMENT_PARTICIPANTS) list.push(uid);
        membersByMoment.set(mid, list);
      }
    }
  } catch (err) {
    logger.warn({ err }, "shared moment participant read failed — moments show without participants");
  }

  const participantIds = [...membersByMoment.values()].flat();
  const [profiles, places] = await Promise.all([
    batchProfiles(sc, [...ownerIds, ...participantIds]),
    batchPlaces(sc, placeIds),
  ]);

  const out = emptyLoaded();
  for (const m of moments) {
    const id = String(m.id);
    const ownerId = String(m.owner_id);
    const placeRef = m.place_id ? places.get(String(m.place_id)) ?? null : null;
    const participants = (membersByMoment.get(id) ?? [])
      .map((uid) => actorFrom(profiles.get(uid), uid))
      .filter((a): a is PublicActorRef => !!a);

    out.candidates.push({
      objectType: "shared_moment",
      canonicalObjectId: id,
      authorId: ownerId,
      publishedAt: String(m.created_at ?? new Date().toISOString()),
      text: m.title ?? null,
      place: placeRef,
      actor: actorFrom(profiles.get(ownerId), ownerId),
      participants: participants.length > 0 ? participants : undefined,
      // Real owner status (already loaded for the byline above) so the Wall gate's
      // passesEligibility can drop a banned/suspended owner's moment — matching the
      // Post spine and media loader. Hardcoding "active" here defeated that gate.
      authorAccountStatus: profiles.get(ownerId)?.accountStatus ?? "active",
      isDeleted: false,
      // Consent already resolved by accepted membership above.
      callerVisibilityResolved: true,
    });
    out.signals.set(id, {
      category: null,
      city: placeRef?.city ?? null,
      country: placeRef?.country ?? null,
      saveCount: 0,
      isFirstImpression: true,
    });
    if (placeRef) out.placeByObject.set(id, placeRef);
  }
  return out;
}

// ── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge the Post spine with the supplementary loaders' candidates. The candidate
 * lists are concatenated (Post spine first, so it anchors order) and collapsed by
 * WallProjectionService.dedupeCandidates so each canonical object keeps its ONE
 * richest projection. The ranking/place side-maps are unioned first-writer-wins,
 * so the Post spine's existing ranking signal for an object is preserved when a
 * richer projection supersedes it. Pure; never throws.
 */
export function mergeLoadedCandidates(
  base: LoadedWallCandidates,
  ...extras: LoadedWallCandidates[]
): LoadedWallCandidates {
  const allCandidates = [...base.candidates];
  const signals = new Map(base.signals);
  const placeByObject = new Map(base.placeByObject);

  for (const e of extras) {
    allCandidates.push(...e.candidates);
    for (const [k, v] of e.signals) if (!signals.has(k)) signals.set(k, v);
    for (const [k, v] of e.placeByObject) if (!placeByObject.has(k)) placeByObject.set(k, v);
  }

  return { candidates: dedupeCandidates(allCandidates), signals, placeByObject };
}
