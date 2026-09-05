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
import { isPostPublished, decidePostReadable } from "../../lib/postVisibility.js";
import { loadViewerTripIds } from "../../lib/mediaEligibility.js";
import {
  resolveViewer,
  loadEligibleCandidates,
} from "../media/MediaProjectionService.js";
import { toMediaProjection, type MediaCandidateRow } from "../../lib/media/mediaProjection.js";
import { areSharedMomentsEnabled } from "../../lib/places/sharedMoments.js";
import { fetchBlockedSet } from "../../lib/blocks.js";
import { isWallRabEnabled } from "./wallRabGate.js";
import { checkBookingKycGate } from "../../lib/rentBuddyKycGate.js";
// The ONE booking-creation gate (audit RAB-1/RAB-2). The RAB opportunity
// producer below runs every surfaced buddy through it so the Wall never shows
// a "book" opportunity the canonical POST /rent-a-buddy/bookings would refuse.
import { enforceBookingCreationGates } from "../../routes/rentABuddy.js";
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
  /**
   * Following pagination horizon (spec §28). The Following cursor's `publishedAt`:
   * slide the fetch window down to (and including) this instant so postcards /
   * moments OLDER than the newest LOADER_FETCH remain reachable on later pages and
   * keep their distinct identity — otherwise a supplementary loader is frozen at
   * the newest rows, the older ones are never fetched, and an older postcard's
   * post appears via the Post spine as a plain post (identity lost). Mutually
   * exclusive with `snapshotAtIso`: For You sets the snapshot, Following sets this.
   */
  followingCursorPublishedAt?: string;
}

/** The effective created-at ceiling for a loader: the For You snapshot freeze, or
 *  the Following cursor slide, whichever the caller set (at most one is). */
function loaderHorizon(opts: LoaderOptions): string | undefined {
  return opts.snapshotAtIso ?? opts.followingCursorPublishedAt;
}

/** Is a canonical row within the loader's created-at horizon (For You freeze or
 *  Following slide)? A row with no created_at cannot be proven within it, so it is
 *  excluded once a horizon is set. */
function withinSnapshot(createdAt: unknown, horizon: string | undefined): boolean {
  if (!horizon) return true;
  const c = typeof createdAt === "string" ? createdAt : "";
  return c !== "" && c <= horizon;
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

/**
 * Batch-load the experience time (spec §16 `experienceAt`) for a set of entities
 * from the canonical media layer. `media_assets.captured_at` (migration 2250) is
 * WHEN the media was captured — the "Happened last night · 10:15 PM" clock,
 * distinct from `publishedAt`. The asset is linked to its entity through the
 * canonical §6.1 `media_attachments` layer (entity_type + entity_id), so this is
 * the same read model the Media v2 system owns — the Wall does not invent a
 * second one.
 *
 * Per entity we take the COVER asset's captured_at when one is marked, else the
 * lowest-position asset's; a null captured_at contributes nothing (the entity
 * simply has no experience time, which is honest — most rows will). Returns a
 * Map keyed by entity_id; fail-soft to an empty map so a media-layer hiccup only
 * costs the `experienceAt` annotation, never the object.
 */
async function loadCapturedAtByEntity(
  sc: any,
  entityType: "postcard" | "shared_moment" | "post",
  entityIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(entityIds)].filter(Boolean);
  if (!sc || unique.length === 0) return out;
  try {
    const { data } = await sc
      .from("media_attachments")
      .select("entity_id, is_cover, position, media_assets(captured_at)")
      .eq("entity_type", entityType)
      .in("entity_id", unique.slice(0, 500));
    // Best attachment per entity: cover wins, else lowest position. Only an
    // attachment whose asset actually carries a captured_at contributes.
    const best = new Map<string, { cover: boolean; position: number; capturedAt: string }>();
    for (const r of (data as any[]) ?? []) {
      const eid = r?.entity_id ? String(r.entity_id) : "";
      if (!eid) continue;
      const asset = Array.isArray(r.media_assets) ? r.media_assets[0] : r.media_assets;
      const capturedAt = typeof asset?.captured_at === "string" ? asset.captured_at : null;
      if (!capturedAt) continue;
      const cover = r.is_cover === true;
      const position = typeof r.position === "number" ? r.position : 0;
      const cur = best.get(eid);
      // Prefer a cover; among equals prefer the earlier position.
      if (!cur || (cover && !cur.cover) || (cover === cur.cover && position < cur.position)) {
        best.set(eid, { cover, position, capturedAt });
      }
    }
    for (const [eid, v] of best) out.set(eid, v.capturedAt);
  } catch (err) {
    logger.warn({ err, entityType }, "captured_at (experienceAt) read failed — no experience time");
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

  const horizon = loaderHorizon(opts);

  // 1. The discriminator: live passport_postcards rows for followed authors.
  const postcardPostIds = new Set<string>();
  // post_id → passport_postcard id, so the postcard's media (and its capture
  // time) can be looked up through the canonical §6.1 attachment layer, which is
  // keyed by the postcard entity id, not the post id (spec §16).
  const postcardIdByPostId = new Map<string, string>();
  try {
    let dq = sc
      .from("passport_postcards")
      .select("id, post_id, user_id, status, deleted_at, created_at")
      .in("user_id", followed.slice(0, 500))
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(LOADER_FETCH);
    // Slide the discriminator window down to the horizon too (spec §28): on a
    // Following page past the newest LOADER_FETCH, the newest postcards are all
    // newer than the cursor and contribute nothing, so we must walk back to the
    // older ones instead of re-reading the same newest set every page.
    if (horizon) dq = dq.lte("created_at", horizon);
    const { data } = await dq;
    // Re-checked in memory (status + tombstone) so a row fed past the query
    // filter cannot resurrect a hidden/reported/deleted postcard on the Wall.
    for (const r of (data as any[]) ?? []) {
      if (isLivePostcardRow(r) && r.post_id) {
        const pid = String(r.post_id);
        postcardPostIds.add(pid);
        if (r.id) postcardIdByPostId.set(pid, String(r.id));
      }
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
    // Apply the loader horizon: the For You freeze (a newly-published postcard
    // can't enter mid-pagination) OR the Following cursor slide (older postcards
    // past the newest window stay reachable). Mirrors the Post spine.
    if (horizon) q = q.lte("created_at", horizon);
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

  // Experience time (spec §16): the postcard cover media's capture instant, read
  // through the canonical attachment layer keyed by the postcard entity id.
  const capturedByPostcardId = await loadCapturedAtByEntity(
    sc,
    "postcard",
    [...postcardIdByPostId.values()],
  );

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
    const publishedAt = String(r.published_at ?? r.created_at);
    const postcardId = postcardIdByPostId.get(id);
    const capturedAt = postcardId ? capturedByPostcardId.get(postcardId) : undefined;

    out.candidates.push({
      objectType: "postcard",
      canonicalObjectId: id,
      authorId,
      visibility: r.visibility ?? null,
      tripId: r.trip_id ?? null,
      publishedAt,
      // Only when it DIFFERS from publishedAt — a postcard published at the same
      // instant it was captured carries one clock, not two (spec §16).
      experienceAt: capturedAt && capturedAt !== publishedAt ? capturedAt : undefined,
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
    // Apply the loader horizon (For You freeze or Following slide): drop media
    // published after the horizon so it can't drift ranks / duplicate across pages
    // (like the Post spine).
    const horizon = loaderHorizon(opts);
    const rows = horizon
      ? fetched.filter((r) => withinSnapshot((r as any).created_at, horizon))
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
    // Apply the loader horizon (For You freeze or Following slide): a Moment
    // outside the horizon must not enter mid-pagination or duplicate across pages
    // (mirrors the Post spine's created-at horizon).
    .filter((row: any) => withinSnapshot(row.created_at, loaderHorizon(opts)));
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
  const [profiles, places, capturedByMomentId] = await Promise.all([
    batchProfiles(sc, [...ownerIds, ...participantIds]),
    batchPlaces(sc, placeIds),
    // Experience time (spec §16): a Shared Moment is a "discovered social memory"
    // — its media's capture instant is exactly the "happened" clock, read through
    // the canonical attachment layer keyed by the moment entity id.
    loadCapturedAtByEntity(sc, "shared_moment", momentIds),
  ]);

  const out = emptyLoaded();
  for (const m of moments) {
    const id = String(m.id);
    const ownerId = String(m.owner_id);
    const placeRef = m.place_id ? places.get(String(m.place_id)) ?? null : null;
    const participants = (membersByMoment.get(id) ?? [])
      .map((uid) => actorFrom(profiles.get(uid), uid))
      .filter((a): a is PublicActorRef => !!a);
    const publishedAt = String(m.created_at ?? new Date().toISOString());
    const capturedAt = capturedByMomentId.get(id);

    out.candidates.push({
      objectType: "shared_moment",
      canonicalObjectId: id,
      authorId: ownerId,
      publishedAt,
      experienceAt: capturedAt && capturedAt !== publishedAt ? capturedAt : undefined,
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

// ── 4. Contextual opportunities: Rent-a-Buddy (spec §19) ─────────────────────

/**
 * The viewer facts the RAB opportunity producer needs — the LoaderViewer plus
 * the context signals the route already reads for discovery (§13): the
 * viewer's current city, upcoming trip cities and interests (all lowercased
 * where they are matched case-insensitively).
 */
export interface OpportunityViewer extends LoaderViewer {
  currentCity: string | null;
  /** Lowercased destination cities of upcoming/active trips. */
  upcomingTripCities: Set<string>;
  /** Lowercased interest tokens. */
  interests: Set<string>;
}

/** How many available buddies the producer reads before context matching. */
const OPPORTUNITY_FETCH = 60;
/** How many matched buddies are run through the booking gate per request. The
 *  gate is several reads per buddy, so this is deliberately small. */
const OPPORTUNITY_GATE_CHECKS = 6;
/** The most opportunities one page may carry (spec §19: "sparingly"). */
const MAX_OPPORTUNITIES = 3;
/** Approved meetup zones shown as the coarse area label (never a coordinate). */
const MAX_ZONE_LABELS = 2;
/** Buddy experience media carried as social content (spec §19). */
const MAX_BUDDY_MEDIA = 3;

/** Booking statuses that count as "the viewer has engaged with this buddy". */
const ENGAGED_BOOKING_STATUSES = ["confirmed", "in_progress", "completed"] as const;

/**
 * The rent_buddy_profiles columns this producer reads. DELIBERATELY EXCLUDES
 * meetup_base_lat / meetup_base_lng and every other private field (spec §19:
 * never expose precise Buddy coordinates — the approved area/service zone is
 * the only location the Wall carries). The gate-input columns (category
 * approvals, verification, nightlife sign-off) are here because
 * enforceBookingCreationGates reads them off the loaded row.
 */
const BUDDY_OPPORTUNITY_COLUMNS =
  "id, user_id, display_name, tagline, city, country, categories, available_now, " +
  "available_now_until, preferred_meetup_zones, cover_photo_url, gallery_urls, " +
  "intro_video_url, buddy_level, updated_at, status, admin_status, risk_hold, " +
  "category_approvals, nightlife_admin_approved, verification_status, id_verified, phone_verified";

/** Human role label for the buddy's matched service category (spec §19: the
 *  commercial identity is secondary to the person, so this is a small tag). */
export function buddyRoleLabel(category: string | null | undefined): string {
  const c = String(category ?? "").trim().toLowerCase();
  if (!c) return "Buddy";
  return `${c.charAt(0).toUpperCase()}${c.slice(1)} Buddy`;
}

function lower(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/** Pick the service category the viewer is most likely to care about: an
 *  interest match first, else the buddy's first category, else the MVP
 *  default "city". */
function matchCategory(categories: unknown, interests: Set<string>): { category: string; interestMatch: boolean } {
  const cats = Array.isArray(categories) ? categories.map(lower).filter(Boolean) : [];
  for (const c of cats) if (interests.has(c)) return { category: c, interestMatch: true };
  return { category: cats[0] ?? "city", interestMatch: false };
}

/** A stored media reference (bare `<bucket>/<path>` or public URL) → a coarse
 *  DisplayMedia. The client hydrates private-bucket refs through the existing
 *  signing path (CachedImage → /api/media/sign); the server never fabricates a URL. */
function buddyMediaToDisplay(row: any): DisplayMedia[] {
  const out: DisplayMedia[] = [];
  const push = (url: unknown, kind: "image" | "video", tag: string) => {
    if (typeof url !== "string" || url.trim().length === 0) return;
    if (out.length >= MAX_BUDDY_MEDIA) return;
    out.push({
      mediaId: `${row.id}:${tag}`,
      kind,
      url: url.trim(),
      thumbnailUrl: null,
      autoplayEligible: kind === "video" ? false : undefined,
      processing: false,
    });
  };
  push(row.cover_photo_url, "image", "cover");
  for (const [i, g] of (Array.isArray(row.gallery_urls) ? row.gallery_urls : []).entries()) {
    push(g, "image", `gallery-${i}`);
  }
  push(row.intro_video_url, "video", "intro");
  return out;
}

/**
 * A response capture for the shared booking-creation gate. enforceBookingCreationGates
 * follows the route convention (writes the refusal to `res` and returns false),
 * so a read-only caller hands it a recorder instead of a live response. Only
 * `status()` and `json()` are ever called on it.
 */
function gateCapture(): { status: (c: number) => any; json: (b: unknown) => any; code: number; body: unknown } {
  const cap: any = {
    code: 200,
    body: null,
    status(c: number) { cap.code = c; return cap; },
    json(b: unknown) { cap.body = b; return cap; },
  };
  return cap;
}

/**
 * Load Rent-a-Buddy contextual opportunities (spec §6 ContextualOpportunityProjection,
 * §19 Rent a Buddy Integration):
 *
 *   • buddy_dispatch — a Buddy the viewer FOLLOWS or has ENGAGED with (a confirmed /
 *                      in-progress / completed booking) who is available now.
 *   • buddy_around   — a Buddy who is "I'm Around" (available_now, within its
 *                      available_now_until horizon) in the viewer's current city
 *                      or an upcoming trip city, matched to the viewer's interests.
 *
 * Buddy experience media (cover / gallery / intro video) rides on the projection
 * as social content; the person identity stays primary and the service identity
 * is a small `buddyRole` tag on the actor (§7/§19).
 *
 * FAIL-CLOSED ON BOTH FLAGS: `wall_rab_integration_enabled` AND the RAB master
 * `rent_buddy_enabled` are read here through the shared `isWallRabEnabled`, so
 * an unreadable flag yields no opportunities. Both must be ON.
 *
 * HONOURS THE CONSOLIDATED BOOKING GATE: every matched buddy is run through the
 * SAME enforceBookingCreationGates that seats a booking (kill switches, rollout
 * / launch controls, account limits, launch-control identity + age, the
 * fail-closed rent_buddy_city_restrictions read, blocks, nightlife / group
 * approvals, high-risk verification) plus the KYC gate. A buddy the viewer
 * could not actually book right now is never surfaced — an opportunity the Wall
 * shows is one the viewer can act on. Cities the gate refuses (launch control
 * disabled / waitlist-only / restriction unreadable) therefore never appear.
 *
 * Never exposes a precise Buddy coordinate: the projection carries the city and
 * approved meetup zones only, and the select list never reads meetup_base_*.
 * Paid promotion cannot manufacture an opportunity — only the honest
 * `available_now` flag admits a buddy here (§19).
 *
 * Fully fail-soft (spec §34 / TABLE 5 "RAB unavailable → remove Buddy context
 * only"): any read failure degrades to an empty set.
 */
export async function loadContextualOpportunityCandidates(
  sc: any,
  viewer: OpportunityViewer,
  opts: LoaderOptions = {},
): Promise<LoadedWallCandidates> {
  // ── Flags (both fail-closed) ──────────────────────────────────────────────
  if (!(await isWallRabEnabled(sc))) return emptyLoaded();

  // ── Bookings must be possible at all (KYC gate, fail-closed) ─────────────
  try {
    const kyc = await checkBookingKycGate(sc);
    if (!kyc.allowed) return emptyLoaded();
  } catch {
    return emptyLoaded();
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // ── Buddies the viewer has engaged with (their own bookings only) ─────────
  const engagedBuddyIds = new Set<string>();
  try {
    const { data, error } = await sc
      .from("rent_buddy_bookings")
      .select("buddy_id, status")
      .eq("traveler_id", viewer.viewerId)
      .in("status", [...ENGAGED_BOOKING_STATUSES])
      .limit(50);
    if (error) logger.warn({ err: error }, "opportunity: engaged-buddy read rejected");
    for (const b of (data as any[]) ?? []) if (b?.buddy_id) engagedBuddyIds.add(String(b.buddy_id));
  } catch (err) {
    logger.warn({ err }, "opportunity: engaged-buddy read failed — dispatch limited to follows");
  }

  // ── Available buddies (honest available_now only) ─────────────────────────
  let rows: any[] = [];
  try {
    const { data, error } = await sc
      .from("rent_buddy_profiles")
      .select(BUDDY_OPPORTUNITY_COLUMNS)
      .eq("status", "active")
      .eq("admin_status", "active")
      .eq("available_now", true)
      .order("updated_at", { ascending: false })
      .limit(OPPORTUNITY_FETCH);
    if (error) {
      logger.warn({ err: error }, "opportunity: buddy read rejected — no opportunities");
      return emptyLoaded();
    }
    rows = (data as any[]) ?? [];
  } catch (err) {
    logger.warn({ err }, "opportunity: buddy read failed — no opportunities");
    return emptyLoaded();
  }
  if (rows.length === 0) return emptyLoaded();

  const contextCities = new Set<string>([...viewer.upcomingTripCities].map(lower).filter(Boolean));
  if (viewer.currentCity) contextCities.add(lower(viewer.currentCity));

  interface Matched {
    row: any;
    kind: "buddy_dispatch" | "buddy_around";
    category: string;
    interestMatch: boolean;
  }
  const matched: Matched[] = [];
  for (const row of rows) {
    if (!row || !row.id || !row.user_id) continue;
    // Re-check the honest availability flag client-side (never trust a fed row).
    if (row.available_now !== true) continue;
    if (row.status !== "active" || row.admin_status !== "active") continue;
    if (row.risk_hold === true) continue;
    if (String(row.user_id) === viewer.viewerId) continue; // never surface self
    // "I'm Around" has a horizon; an expired horizon is not live (spec §4/§19).
    if (typeof row.available_now_until === "string" && row.available_now_until <= nowIso) continue;
    // For You freeze horizon (§28), mirroring the other loaders.
    if (!withinSnapshot(row.updated_at, opts.snapshotAtIso)) continue;

    const userId = String(row.user_id);
    const isDispatch = viewer.followedCreatorIds.has(userId) || engagedBuddyIds.has(String(row.id));
    const inContext = contextCities.size > 0 && contextCities.has(lower(row.city));
    if (!isDispatch && !inContext) continue;
    const { category, interestMatch } = matchCategory(row.categories, viewer.interests);
    matched.push({ row, kind: isDispatch ? "buddy_dispatch" : "buddy_around", category, interestMatch });
  }
  if (matched.length === 0) return emptyLoaded();

  // Dispatch (social tie) first, then interest-matched "around", then the rest.
  matched.sort((a, b) => {
    const ka = a.kind === "buddy_dispatch" ? 0 : a.interestMatch ? 1 : 2;
    const kb = b.kind === "buddy_dispatch" ? 0 : b.interestMatch ? 1 : 2;
    return ka - kb;
  });
  const toGate = matched.slice(0, OPPORTUNITY_GATE_CHECKS);

  // ── The consolidated booking gate, per buddy (fail-closed on throw) ───────
  const gated = await Promise.all(
    toGate.map(async (m) => {
      try {
        const capture = gateCapture();
        const ok = await enforceBookingCreationGates({
          sc,
          res: capture,
          userId: viewer.viewerId,
          buddyProfile: m.row,
          city: String(m.row.city ?? ""),
          countryCode: m.row.country ?? null,
          category: m.category,
          applyKillSwitch: true,
          applyRollout: true,
          applyLimits: true,
        });
        return ok === true;
      } catch (err) {
        logger.warn({ err, buddyProfileId: m.row.id }, "opportunity: booking gate threw — dropping buddy");
        return false;
      }
    }),
  );
  const admitted = toGate.filter((_, i) => gated[i]).slice(0, MAX_OPPORTUNITIES);
  if (admitted.length === 0) return emptyLoaded();

  // Person identity from profiles (primary); the buddy row's display_name is
  // only a fallback so the Wall never shows a blank byline.
  const profiles = await batchProfiles(sc, admitted.map((m) => String(m.row.user_id)));

  const out = emptyLoaded();
  for (const m of admitted) {
    const row = m.row;
    const id = String(row.id);
    const userId = String(row.user_id);
    const prof = profiles.get(userId);
    const city = typeof row.city === "string" ? row.city : null;
    const zones = (Array.isArray(row.preferred_meetup_zones) ? row.preferred_meetup_zones : [])
      .filter((z: unknown): z is string => typeof z === "string" && z.trim().length > 0)
      .slice(0, MAX_ZONE_LABELS);
    const areaLine = city ? `Around ${city}${zones.length > 0 ? ` · ${zones.join(", ")}` : ""}` : null;
    const tagline = typeof row.tagline === "string" && row.tagline.trim() ? row.tagline.trim() : null;
    const text = [tagline, areaLine].filter((s): s is string => !!s).join("\n") || null;
    const media = buddyMediaToDisplay(row);

    const actor: PublicActorRef = {
      userId,
      displayName: prof?.displayName ?? (typeof row.display_name === "string" && row.display_name ? row.display_name : "Buddy"),
      handle: prof?.handle ?? null,
      avatarUrl: prof?.avatarUrl ?? null,
      isBuddy: true,
      buddyRole: buddyRoleLabel(m.category),
    };

    out.candidates.push({
      objectType: "contextual_opportunity",
      canonicalObjectId: id,
      authorId: userId,
      // The moment availability was last set — the publication clock (§16).
      publishedAt: String(row.updated_at ?? nowIso),
      text,
      actor,
      media: media.length > 0 ? media : undefined,
      authorAccountStatus: prof?.accountStatus ?? "active",
      isDeleted: false,
      opportunityKind: m.kind,
      opportunityArea: city,
      // Service eligibility resolved above by the consolidated booking gate.
      callerVisibilityResolved: true,
    });
    out.signals.set(id, {
      category: m.category,
      city,
      country: typeof row.country === "string" ? row.country : null,
      saveCount: 0,
      isFirstImpression: true,
    });
  }
  return out;
}

// ── 5. Stories / Quick Media (spec §18) ──────────────────────────────────────

/** How long a quick-media item lives on the top row (spec §18: short-lived). */
export const QUICK_MEDIA_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Hard cap on items returned to the row — it is a small, quiet strip (§18). */
export const MAX_QUICK_MEDIA_ITEMS = 60;

/**
 * One short-lived media item from a followed person. `media.url` is the stored
 * storage reference (bare `<bucket>/<path>` or the row's public_url) — the
 * private-bucket bytes are signed by the EXISTING hydration path on the client
 * (CachedImage → useHydratedMedia → the batch-sign endpoint, which re-runs
 * lib/mediaAccess per object). This service never mints a signed URL itself.
 */
export interface QuickMediaItem {
  /** media_assets.id */
  id: string;
  ownerUserId: string;
  actor: PublicActorRef;
  media: DisplayMedia;
  /** The canonical post the asset is published through — where "open" lands. */
  postId: string;
  createdAt: string;
  /** createdAt + QUICK_MEDIA_WINDOW_MS — the client may drop it when passed. */
  expiresAt: string;
}

/** moderation states that must never reach a social surface (media_assets). */
const QUICK_MEDIA_BLOCKED_MODERATION: ReadonlySet<string> = new Set([
  "rejected",
  "flagged",
  "removed",
  "owner_deleted",
]);

function quickMediaAssetServable(row: any, nowMs: number): boolean {
  if (!row || typeof row.id !== "string" || typeof row.owner_user_id !== "string") return false;
  if (row.processing_status !== "ready") return false;
  if (typeof row.moderation_status === "string" && QUICK_MEDIA_BLOCKED_MODERATION.has(row.moderation_status)) {
    return false;
  }
  // 'private' is an explicit owner-only asset; anything else resolves through
  // the publishing post below (deny by default when nothing publishes it).
  if (row.visibility === "private") return false;
  const createdMs = Date.parse(String(row.created_at ?? ""));
  if (!Number.isFinite(createdMs)) return false;
  if (nowMs - createdMs > QUICK_MEDIA_WINDOW_MS) return false; // expired (§18)
  if (createdMs > nowMs + 5 * 60_000) return false; // clock-skewed future row
  const bucket = typeof row.storage_bucket === "string" ? row.storage_bucket.trim() : "";
  const path = typeof row.storage_path === "string" ? row.storage_path.trim() : "";
  return bucket.length > 0 && path.length > 0;
}

/**
 * Load the followed people's short-lived media for the Stories / Quick Media
 * row (spec §18). Data source: media_assets created within the last 24 h by
 * accounts the viewer follows.
 *
 * Every item passes the canonical policy before it is returned (§23):
 *   - blocks, both directions, FAIL-CLOSED (an unreadable block list ⇒ nothing);
 *   - owner account must be active;
 *   - the asset must be ready, moderation-clean and not `private`;
 *   - the asset must be PUBLISHED THROUGH A POST the viewer may read: the
 *     attachment (media_attachments post/postcard) or, for rows recorded before
 *     the canonical attachment layer, the post_media row at the same storage
 *     path. That post must be active, published (delayed-post gate) and readable
 *     under lib/postVisibility.decidePostReadable (trip_only ⇒ accepted trip
 *     membership). An asset nothing publishes is DENIED, exactly as
 *     lib/mediaAccess denies the bytes — media_assets.visibility='inherit' has
 *     nothing to inherit from, and 'public' without a canonical object has
 *     nowhere to open.
 *   - the publishing post must belong to the asset owner (a post cannot publish
 *     someone else's object).
 *
 * Never a coordinate; never a signed URL (see QuickMediaItem).
 */
export async function loadQuickMediaItems(
  sc: any,
  viewerId: string,
  opts: { nowMs?: number; limit?: number } = {},
): Promise<QuickMediaItem[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_QUICK_MEDIA_ITEMS, MAX_QUICK_MEDIA_ITEMS));

  // 1. Follow graph — the row is "from followed people" only (§18).
  let followed: string[] = [];
  try {
    const { data, error } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", viewerId)
      .limit(500);
    if (error) throw error;
    followed = [...new Set(((data as any[]) ?? []).map((r) => String(r.following_id)).filter(Boolean))];
  } catch (err) {
    logger.warn({ err }, "quick media: follow read failed — degrading to empty row");
    return [];
  }
  if (followed.length === 0) return [];

  // 2. Blocks, both directions, fail-closed.
  const blocked = await fetchBlockedSet(sc, viewerId);
  if (blocked === null) {
    logger.warn("quick media: block list unreadable — failing closed to an empty row");
    return [];
  }
  const owners = followed.filter((id) => !blocked.has(id) && id !== viewerId);
  if (owners.length === 0) return [];

  // 3. Recent media_assets from those owners.
  const sinceIso = new Date(nowMs - QUICK_MEDIA_WINDOW_MS).toISOString();
  let assets: any[] = [];
  try {
    const { data, error } = await sc
      .from("media_assets")
      .select(
        "id, owner_user_id, storage_bucket, storage_path, public_url, media_type, thumbnail_path, thumbnail_url, " +
          "width, height, duration_ms, moderation_status, processing_status, visibility, created_at",
      )
      .in("owner_user_id", owners.slice(0, 500))
      .gte("created_at", sinceIso)
      .eq("processing_status", "ready")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    // Re-checked in memory so a row fed past the query filters (a stale
    // replica, a test double) cannot resurrect a private/expired asset.
    assets = ((data as any[]) ?? []).filter((r) => quickMediaAssetServable(r, nowMs) && owners.includes(String(r.owner_user_id)));
  } catch (err) {
    logger.warn({ err }, "quick media: media_assets read failed — degrading to empty row");
    return [];
  }
  if (assets.length === 0) return [];

  // 4. Resolve the publishing post for each asset: canonical attachment first,
  //    then the legacy post_media row at the same storage path.
  const assetIds = assets.map((a) => String(a.id));
  const postIdByAsset = new Map<string, string>();
  try {
    const { data } = await sc
      .from("media_attachments")
      .select("media_asset_id, entity_type, entity_id")
      .in("media_asset_id", assetIds.slice(0, 500))
      .in("entity_type", ["post", "postcard"]);
    for (const att of (data as any[]) ?? []) {
      const aid = String(att.media_asset_id);
      if (!postIdByAsset.has(aid) && att.entity_id) postIdByAsset.set(aid, String(att.entity_id));
    }
  } catch (err) {
    logger.warn({ err }, "quick media: attachment read failed — falling back to post_media paths");
  }
  const unresolved = assets.filter((a) => !postIdByAsset.has(String(a.id)));
  if (unresolved.length > 0) {
    try {
      const paths = [...new Set(unresolved.map((a) => String(a.storage_path)))];
      const { data } = await sc
        .from("post_media")
        .select("post_id, storage_path, moderation_status, processing_status")
        .in("storage_path", paths.slice(0, 500));
      const postByPath = new Map<string, string>();
      for (const pm of (data as any[]) ?? []) {
        if (!pm?.post_id || !pm?.storage_path) continue;
        if (pm.moderation_status === "rejected" || pm.moderation_status === "flagged") continue;
        if (pm.processing_status && pm.processing_status !== "ready") continue;
        if (!postByPath.has(String(pm.storage_path))) postByPath.set(String(pm.storage_path), String(pm.post_id));
      }
      for (const a of unresolved) {
        const pid = postByPath.get(String(a.storage_path));
        if (pid) postIdByAsset.set(String(a.id), pid);
      }
    } catch (err) {
      logger.warn({ err }, "quick media: post_media path read failed — unpublished assets stay hidden");
    }
  }
  const publishedAssets = assets.filter((a) => postIdByAsset.has(String(a.id)));
  if (publishedAssets.length === 0) return [];

  // 5. The publishing posts, gated by the canonical post policy (§23).
  const postIds = [...new Set([...postIdByAsset.values()])];
  const posts = new Map<string, any>();
  try {
    const { data, error } = await sc
      .from("posts")
      .select("id, author_id, visibility, status, post_status, trip_id")
      .in("id", postIds.slice(0, 500));
    if (error) throw error;
    for (const p of (data as any[]) ?? []) posts.set(String(p.id), p);
  } catch (err) {
    logger.warn({ err }, "quick media: post read failed — failing closed to an empty row");
    return [];
  }
  const needsTrips = [...posts.values()].some((p) => p?.visibility === "trip_only");
  const viewerTripIds = needsTrips ? await loadViewerTripIds(sc, viewerId) : new Set<string>();

  const readableByPost = new Map<string, boolean>();
  for (const [pid, p] of posts) {
    const active = !p.status || p.status === "active";
    const published = isPostPublished(p);
    const tripMember = !!p.trip_id && viewerTripIds.has(String(p.trip_id));
    readableByPost.set(pid, active && published && decidePostReadable(p, viewerId, tripMember).readable);
  }

  // 6. Owner profiles (display + account status).
  const profiles = await batchProfiles(sc, publishedAssets.map((a) => String(a.owner_user_id)));

  const out: QuickMediaItem[] = [];
  for (const a of publishedAssets) {
    const id = String(a.id);
    const ownerId = String(a.owner_user_id);
    const postId = postIdByAsset.get(id);
    if (!postId) continue;
    const post = posts.get(postId);
    if (!post || !readableByPost.get(postId)) continue;
    // A post cannot publish somebody else's object (lib/mediaAccess 3a rule).
    if (String(post.author_id) !== ownerId) continue;
    const prof = profiles.get(ownerId);
    if (!prof || prof.accountStatus !== "active") continue;
    const actor = actorFrom(prof, ownerId);
    if (!actor) continue;

    const bucket = String(a.storage_bucket).trim();
    const path = String(a.storage_path).trim();
    const url = typeof a.public_url === "string" && a.public_url.trim() ? a.public_url.trim() : `${bucket}/${path}`;
    const thumbnailUrl =
      typeof a.thumbnail_url === "string" && a.thumbnail_url.trim()
        ? a.thumbnail_url.trim()
        : typeof a.thumbnail_path === "string" && a.thumbnail_path.trim()
          ? `${bucket}/${a.thumbnail_path.trim()}`
          : null;
    const kind: DisplayMedia["kind"] = a.media_type === "video" ? "video" : "image";
    const createdAt = new Date(Date.parse(String(a.created_at))).toISOString();
    out.push({
      id,
      ownerUserId: ownerId,
      actor,
      media: {
        mediaId: id,
        kind,
        url,
        thumbnailUrl,
        width: typeof a.width === "number" ? a.width : null,
        height: typeof a.height === "number" ? a.height : null,
        durationMs: typeof a.duration_ms === "number" ? a.duration_ms : null,
        autoplayEligible: kind === "video" ? false : undefined,
        processing: false,
      },
      postId,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + QUICK_MEDIA_WINDOW_MS).toISOString(),
    });
    if (out.length >= limit) break;
  }
  return out;
}
