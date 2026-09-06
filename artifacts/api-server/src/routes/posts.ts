import { Router } from "express";
import { z } from "zod";
import { logger as rootLogger } from "../lib/logger";
import { enrichSpans } from "../lib/enrichSpans";
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine";

const postsLogger = rootLogger.child({ route: "posts" });
import { nameVisibilitySet, sanitizeIdentity, presentedName } from "../lib/publicIdentity";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import { decidePostReadable, isPostPublished, needsTripMembershipCheck, needsFollowerCheck } from "../lib/postVisibility.js";
import {
  requireUser,
  sendError,
  isAcceptedTripMember,
  tripExists,
} from "../lib/http";
import {
  createPostSchema,
  updatePostSchema,
  listPostsQuerySchema,
  locationPrivacyPatchSchema,
  sensitivityLevel,
  defaultPrivacyMode,
  geofenceRadius,
  safeLocationLabel,
  mapPublicPost,
  type LocationPrivacyMode,
} from "../lib/postSchemas";
import { verifyLocation, shouldCreatePostcard } from "../lib/locationVerify";
import {
  loadRestrictiveGems,
  gemCeilingForItem,
  coarsenMediaLocation,
  UNDETERMINED_GEM_CEILING,
  type RestrictiveGem,
} from "../lib/mediaLocationVisibility";
import { upsertCityStamp } from "../lib/stampHelper";
import type { SupabaseClient } from "@supabase/supabase-js";
import { awardStamp } from "../services/passport/StampAwardEngine.js";
import { evaluateAndAwardCriteria } from "../lib/stamps/criteria/index.js";
import { getServiceClient } from "../lib/supabase";
import { stampEntity, unstampEntity } from "../services/stamps/ContentStampService.js";
import { stampOverlayCol, feedVariantCol } from "../lib/postMediaOverlay";
import { checkRateLimit } from "../lib/rateLimit";
import { writePulseGeoTag } from "../services/location/PulseGeoTagService";
import { processTagging } from "../services/tagging/TaggingService.js";
import { recordActivityEvent } from "../compass/CompassActiveUserRewardEngine.js";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter } from "../services/notifications/NotificationRouter.js";
import { isKillSwitchEngaged } from "../lib/featureFlags.js";
import { processImage, makeThumbnail, makeFeedVariant, computePHash } from "../lib/mediaProcessing.js";
import { stripVideoLocationMetadata } from "../lib/videoMetadata.js";
import {
  guardUploadRequest,
  verifyUploadedBytes,
  ALLOWED_MEDIA_MIME,
} from "../lib/mediaPipeline.js";
import { recordMediaAsset, capturedAtFromImageBytes } from "../lib/mediaAssets.js";
import { resolvePostPlace } from "../lib/places/placeResolve.js";
import { classifyBuckets, incrementBucketCounts } from "../lib/places/bucketClassifier.js";
import { ensurePlaceDay, isEligiblePlaceDayPost } from "../lib/places/placeDays.js";
import { detectAndStoreLanguage, invalidateContentTranslations } from "../services/contentTranslation.js";

const router = Router();

const STORAGE_BUCKET = "post-media";
// Inbound size caps and the MIME allowlist moved to lib/mediaPipeline.ts
// (MEDIA_SIZE_LIMITS, ALLOWED_MEDIA_MIME), shared with the postcard signed-URL
// transport. They are a different thing from MAX_IMAGE_DIM in
// mediaProcessing.ts, which caps what the server KEEPS after re-encoding rather
// than what it accepts; the reasoning for the 15 MB figure moved with it.

/* ===========================================================================
 * POST /media/upload  — authenticated media upload proxied through API server
 * ===========================================================================
 * Client sends raw binary body with Content-Type = MIME type.
 * Server uses service-role key to upload to Supabase Storage, bypassing RLS.
 * Files stored at post-media/{userId}/{timestamp}.{ext}.
 * Returns { url, path }.
 */
router.post(
  "/media/upload",
  (req, res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { (req as any).rawBody = Buffer.concat(chunks); next(); });
    req.on("error", next);
  },
  async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Storage not configured"); return; }

    // Kill switch + per-user upload budget, from lib/mediaPipeline so this
    // transport and the postcard signed-URL transport share one policy and one
    // rate-limit bucket — switching endpoint does not buy a fresh allowance.
    const guard = await guardUploadRequest(sc, user.id);
    if (!guard.ok) {
      if (guard.failure.code === "rate_limited") {
        res.setHeader("Retry-After", Math.ceil(guard.failure.retryAfterMs / 1000).toString());
      }
      sendError(res, guard.failure.code, guard.failure.message);
      return;
    }

    const declaredMime = (req.headers["content-type"] ?? "").split(";")[0].trim();
    const declaredInfo = ALLOWED_MEDIA_MIME[declaredMime];
    if (!declaredInfo) {
      sendError(res, "invalid_payload", `Unsupported media type: ${declaredMime}`);
      return;
    }

    // The bytes decide the real type — the header is untrusted. verifyUploadedBytes
    // folds together the three checks this path used to run inline (non-empty,
    // recognisable, within the ceiling for its REAL kind) and adds one it did
    // not: rejecting a declared/actual KIND mismatch, so a request announcing
    // image/jpeg cannot store a video that every downstream consumer will then
    // treat as a photo.
    const rawBody: Buffer = (req as any).rawBody;
    const verified = verifyUploadedBytes(rawBody, declaredInfo.mediaType);
    if (!verified.ok) {
      sendError(res, verified.failure.code, verified.failure.message);
      return;
    }
    const sniffed = verified.value;

    let uploadBuf = rawBody;
    let uploadMime = sniffed.mime;
    let uploadExt = sniffed.ext;
    let width: number | null = null;
    let height: number | null = null;
    let thumb: { buffer: Buffer; mime: string } | null = null;
    let feed: { buffer: Buffer; mime: string } | null = null;
    let processed = false;
    let phash: string | null = null;
    // §6 capture time / Wall §16 "two clocks". Read from the RAW bytes, before
    // processImage strips the metadata — after the strip there is nothing left
    // to read. Null for video and for any image without a plausible EXIF date.
    const capturedAt =
      sniffed.kind === "image" ? capturedAtFromImageBytes(rawBody) : null;

    if (sniffed.kind === "image") {
      try {
        // Strip EXIF/GPS + auto-orient + cap dimensions, and build a real
        // server-side thumbnail. Closes the audit's top EXIF/GPS leak.
        const img = await processImage(rawBody, sniffed);
        uploadBuf = img.buffer;
        uploadMime = img.mime;
        uploadExt = img.ext;
        width = img.width;
        height = img.height;
        const t = await makeThumbnail(img.buffer);
        thumb = { buffer: t.buffer, mime: t.mime };
        // Feed-sized derivative. Built from the PROCESSED buffer, so it
        // inherits the EXIF/GPS strip and auto-orient rather than re-deriving
        // them from the raw upload. Fail-soft in the same way the thumbnail is:
        // a missing variant means the client falls back to the original, which
        // is exactly today's behaviour.
        const f = await makeFeedVariant(img.buffer);
        feed = { buffer: f.buffer, mime: f.mime };
        processed = true;
        // Perceptual hash for near-duplicate detection. Computed on the
        // processed (EXIF-stripped, re-encoded) buffer so the hash is stable
        // regardless of orientation or metadata. Fail-soft: a null hash never
        // blocks the upload — the dedup worker skips rows where phash IS NULL.
        phash = await computePHash(img.buffer);
      } catch (err) {
        // FAIL-CLOSED FOR EVERY IMAGE, HEIC INCLUDED.
        //
        // This used to special-case HEIC and store the raw bytes when sharp
        // could not decode them — "documented gap", fail-open by design. It was
        // not merely a gap, it was live: the bundled libvips (8.18.3) links
        // libheif with only the AOM/AV1 codec, no HEVC decoder plugin, so a
        // real iPhone HEIC fails with "Support for this compression format has
        // not been built in" and took this branch EVERY time. `image/heic` is
        // in ALLOWED_MEDIA_MIME and sniffMedia recognises the `heic`/`mif1`
        // brands, so those uploads were stored byte-for-byte — EXIF and GPS
        // intact — by the very code path whose purpose is to remove them.
        //
        // The sibling transport (postcards /complete) already rejects any image
        // it cannot process, with no HEIC exception. Rejecting here makes the
        // two agree: an image whose metadata we cannot strip is not stored.
        req.log.warn({ err, mime: sniffed.mime }, "image processing failed — upload rejected");
        sendError(res, "invalid_payload", "Corrupt or undecodable image file");
        return;
      }
    } else {
      // VIDEO — no transcode tier, but the container still has to give up its
      // capture coordinates. Length-preserving in-place scrub; see
      // lib/videoMetadata.ts for why the bytes are overwritten rather than
      // removed. Fail-closed: a video whose location metadata cannot be proven
      // gone is refused, never stored.
      const scrub = stripVideoLocationMetadata(rawBody, sniffed);
      if (!scrub.ok) {
        req.log.warn({ mime: sniffed.mime }, "video location metadata could not be stripped — upload rejected");
        sendError(res, scrub.failure.code, scrub.failure.message);
        return;
      }
      if (scrub.stripped.length > 0) {
        req.log.info({ stripped: scrub.stripped }, "video location metadata stripped");
      }
      uploadBuf = scrub.buffer;
    }

    const basePath = `${user.id}/${Date.now()}`;
    const path = `${basePath}.${uploadExt}`;

    const { error } = await sc.storage
      .from(STORAGE_BUCKET)
      .upload(path, uploadBuf, { contentType: uploadMime, upsert: false });
    if (error) {
      req.log.error({ err: error, path }, "Storage upload failed");
      sendError(res, "db_error", `Upload failed: ${error.message}`);
      return;
    }

    let thumbnailUrl: string | null = null;
    let thumbnailPath: string | null = null;
    if (thumb) {
      thumbnailPath = `${basePath}.thumb.jpg`;
      const { error: tErr } = await sc.storage
        .from(STORAGE_BUCKET)
        .upload(thumbnailPath, thumb.buffer, { contentType: thumb.mime, upsert: false });
      if (tErr) {
        req.log.warn({ err: tErr }, "Thumbnail upload failed — continuing without");
        thumbnailPath = null;
      } else {
        thumbnailUrl = `${STORAGE_BUCKET}/${thumbnailPath}`;
      }
    }

    // Feed variant — same fail-soft contract as the thumbnail. If generation or
    // upload fails, feedUrl stays null and the client uses the original.
    let feedUrl: string | null = null;
    let feedPath: string | null = null;
    if (feed) {
      feedPath = `${basePath}.feed.jpg`;
      const { error: fErr } = await sc.storage
        .from(STORAGE_BUCKET)
        .upload(feedPath, feed.buffer, { contentType: feed.mime, upsert: false });
      if (fErr) {
        req.log.warn({ err: fErr }, "Feed-variant upload failed — continuing without");
        feedPath = null;
      } else {
        feedUrl = `${STORAGE_BUCKET}/${feedPath}`;
      }
    }

    const mediaRelayUrl = `${STORAGE_BUCKET}/${path}`;

    // Canonical dual-write (flag-gated OFF; fail-soft — legacy flow unaffected).
    void recordMediaAsset(sc, {
      ownerUserId: user.id,
      storageBucket: STORAGE_BUCKET,
      storagePath: path,
      publicUrl: mediaRelayUrl,
      mediaType: sniffed.kind,
      mimeType: uploadMime,
      sizeBytes: uploadBuf.length,
      width,
      height,
      thumbnailPath,
      thumbnailUrl,
      // The §6 clock. Absent before this: both recordMediaAsset call sites
      // omitted the field, so media_assets.captured_at had no writer at all and
      // the Wall's §16 experienceAt could never differ from publishedAt.
      capturedAt,
    });

    // Response stays backward-compatible ({url, path}); new fields are additive.
    // `phash` is included so the client can persist it on the post_media row.
    //
    // `feedUrl` is NULL whenever no variant exists — video, or any upload
    // predating this feature. (An image that fails processing no longer lands
    // here at all: it is rejected above rather than stored unprocessed.) The
    // client must treat null as "use `url`". It must never construct a variant
    // path itself: for every pre-existing post that URL would 404.
    res.status(201).json({
      url: mediaRelayUrl, path, thumbnailUrl, feedUrl, width, height, processed, phash,
    });
  },
);

// Columns returned to clients. NEVER include original_lat/original_lng or
// user_gps_lat/user_gps_lng — those are stored privately and must not leak.
const POST_COLUMNS =
  "id, author_id, trip_id, content, media_urls, visibility, status, created_at, updated_at, " +
  "location_name, location_city, location_country, " +
  "location_privacy_mode, post_status, " +
  "public_lat, public_lng, public_location_label, geofence_radius_meters, " +
  "publish_after_exit, publish_after_time, publish_eligible_at, published_at, location_sensitivity_level, " +
  "category, save_count, media_count, has_video, primary_media_type, original_language";

const POST_MEDIA_FEED_COLUMNS =
  "post_id, id, media_type, public_url, thumbnail_url, duration_seconds, width, height, sort_order, processing_status, moderation_status";

/** Filter and shape post_media rows for public feed consumption.
 *  Excludes non-ready and rejected/flagged items; sorts by sort_order.
 *  Returns snake_case keys to match the post_media column names.
 *
 *  `feed_url` is the 0208 feed-sized derivative and is NULL for every row that
 *  predates 0208, for videos, and for any upload whose derive failed. NULL is
 *  the contract, not a gap: the client renders `feed_url ?? url`. The server
 *  reports existence; the client must never append `.feed.jpg` to `url` itself,
 *  because for every pre-existing row that object does not exist and the
 *  request would 404. `?? null` is load-bearing — when feedVariantCol() finds no
 *  column the key is absent from the row, and this normalises it to explicit
 *  null rather than leaving it `undefined` and dropped from the JSON. */
export function filterPostMedia(items: any[]): Array<Record<string, unknown>> {
  if (!Array.isArray(items)) return [];
  return items
    .filter((m: any) => m.processing_status === "ready" && m.moderation_status !== "rejected" && m.moderation_status !== "flagged")
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((m: any) => ({
      id:                m.id,
      media_type:        m.media_type,
      url:               m.public_url,
      feed_url:          m.feed_url ?? null,
      thumbnail_url:     m.thumbnail_url ?? null,
      duration_seconds:  m.duration_seconds ?? null,
      width:             m.width ?? null,
      height:            m.height ?? null,
      sort_order:        m.sort_order ?? 0,
      processing_status: m.processing_status,
      stamp_overlay:     m.stamp_overlay ?? null,
    }));
}

/**
 * Attach the resolved `media` array to post rows that are returned raw.
 *
 * WHY THIS EXISTS — the shape-B regression (#3585)
 * ------------------------------------------------
 * 2083 made post_media canonical for storage-backed media and STRIPPED those
 * entries out of posts.media_urls. The feed endpoints were converted to read
 * post_media, but the mutation and pending endpoints still returned the raw
 * posts row: `media_urls` now empty, and no `media` key at all.
 *
 * The client's mapPost() reads exactly those two fields, so a storage-backed
 * post came back as `mediaUrls: []` and `media: undefined` — a post model with
 * no media whatsoever. Editing or publishing a post with uploaded photos blanked
 * its tile until the next refetch. Before 2083 the same code worked, because
 * media_urls still carried the storage URL; the strip is what exposed it.
 *
 * So this is not defensive padding — these responses are a render source, and
 * the field they rendered from was deliberately emptied.
 *
 * Fails OPEN, matching the feed endpoints: a post_media read failure omits the
 * media rather than failing the mutation the caller actually asked for. The
 * mutation has already been committed by the time this runs.
 */
async function withPostMedia(sc: any, rows: any[]): Promise<any[]> {
  if (!Array.isArray(rows)) return [];
  const ids = rows.map((r) => r?.id).filter((id): id is string => Boolean(id));
  const byPost: Record<string, any[]> = {};
  if (ids.length > 0) {
    try {
      const { data } = await sc
        .from("post_media")
        .select(POST_MEDIA_FEED_COLUMNS + (await stampOverlayCol(sc)) + (await feedVariantCol(sc)))
        .in("post_id", ids);
      for (const m of (data ?? []) as any[]) {
        (byPost[m.post_id] ??= []).push(m);
      }
    } catch {
      /* fail-open — see the note above */
    }
  }
  // filterPostMedia applies the ready/rejected/flagged rules and the sort, so
  // the projection here is identical to what the feed endpoints emit.
  return rows.map((r) => ({ ...r, media: filterPostMedia(byPost[r?.id ?? ""] ?? []) }));
}

/** Single-row convenience wrapper for withPostMedia. */
async function withPostMediaOne(sc: any, row: any): Promise<any> {
  const [out] = await withPostMedia(sc, [row]);
  return out;
}

/**
 * Author-only column set for GET /posts/pending.  Extends POST_COLUMNS with
 * private fields safe to serve exclusively to the post owner:
 *   - location_lat / location_lng — used by the mobile geofence watcher
 *   - venue_name                  — internal venue used for geotag credit
 */
const PENDING_POST_COLUMNS =
  POST_COLUMNS + ", location_lat, location_lng, venue_name";

// ── Hidden-Gem location protection for public post reads (Media v2 P1b) ────────
//
// A post's public_lat/public_lng become the EXACT published coordinate once a
// delayed geotag clears (lib/delayedPostPublisher). If that coordinate sits at /
// near a protected Hidden Gem — or the post is tagged to the gem's canonical
// place — serving it de-anonymizes a location the gem's own guard hides. This
// gate coarsens the public location (coords + labels) ONLY when a gem constrains
// it, so a normal post that intentionally published its exact location is left
// untouched. Fail-closed: if the gem lookup fails, coarsen.

interface PostGemContext {
  gems: RestrictiveGem[];
  /** post id → canonical_place_id (fetched separately so the id is never served). */
  placeById: Map<string, string | null>;
  determined: boolean;
}

async function loadPostGemContext(
  db: SupabaseClient,
  rows: any[],
): Promise<PostGemContext> {
  const ids = rows.map((r) => r?.id).filter((v): v is string => typeof v === "string");
  const placeById = new Map<string, string | null>();
  try {
    if (ids.length > 0) {
      const { data, error } = await db
        .from("posts")
        .select("id, canonical_place_id")
        .in("id", ids);
      if (error) throw error;
      for (const r of (data as any[]) ?? []) placeById.set(r.id, r.canonical_place_id ?? null);
    }
    const gems = await loadRestrictiveGems(db, {
      placeIds: Array.from(placeById.values()),
      cities: rows.map((r) => r?.location_city ?? null),
    });
    return { gems, placeById, determined: true };
  } catch {
    // Fail-closed: undetermined ⇒ every non-owner read coarsens.
    return { gems: [], placeById, determined: false };
  }
}

/**
 * Coarsen a public post row's location when a protected/approximate Hidden Gem
 * constrains it. Owner sees their own post unchanged. When no gem constrains and
 * the batch was determined, the row passes through untouched (preserving the
 * user's intentional delayed-publish exact coordinate).
 */
function gemProtectPost(row: any, ctx: PostGemContext, viewerId: string): any {
  if (row?.author_id === viewerId) return row; // owner sees their own exact
  const lat = row?.public_lat ?? null;
  const lng = row?.public_lng ?? null;
  const placeId = ctx.placeById.get(row?.id) ?? null;
  const ceiling = ctx.determined
    ? gemCeilingForItem(ctx.gems, { placeId, lat, lng })
    : UNDETERMINED_GEM_CEILING; // fail-closed
  if (ceiling == null) return row; // no gem constraint → unchanged
  const d = coarsenMediaLocation(
    {
      name: row?.location_name ?? null,
      city: row?.location_city ?? null,
      country: row?.location_country ?? null,
      lat,
      lng,
    },
    { locationVisibility: ceiling, isOwner: false, coarsenSeed: String(row?.id ?? ""), emitCoarseCoords: true },
  );
  return {
    ...row,
    location_name: d.name,
    location_city: d.city,
    location_country: d.country,
    public_location_label: d.name ?? d.city ?? d.country ?? null,
    public_lat: d.lat, // coarse grid-snapped — never the exact published coord
    public_lng: d.lng,
  };
}

/**
 * Redact sensitive location fields from responses served to non-author
 * audiences.  The raw location_name (exact venue) must be suppressed
 * whenever a privacy mode is active — callers should use
 * public_location_label instead.
 *
 * Exceptions:
 *   - mode is null or 'none' → no privacy is set; expose as-is.
 *   - mode is delayed_until_exit/time AND post_status='published' → the
 *     geofence was cleared; location intentionally revealed.
 */

/* ===========================================================================
 * POST /posts  — create a standalone or trip-attached post
 * ===========================================================================
 * - requires a valid bearer token (author = verified user; client author_id ignored)
 * - if trip_id present: trip must exist AND user must be owner/accepted member
 * - visibility=trip_only requires trip_id (schema + DB both enforce)
 * - service-role insert; audit fields set server-side
 */

/**
 * Awards social post-count stamps (first_post, storyteller, photographer) for a
 * newly-published post.  Exported so the trigger path can be tested in isolation
 * without spinning up the full HTTP server.
 *
 * Returns the list of slug names actually awarded (empty if none qualified or the
 * stamp system is disabled).  The caller is responsible for dispatching the
 * "passport.stamp_earned" push notification.
 */
export async function awardSocialPostStamps(
  sc: SupabaseClient,
  userId: string,
  postId: string,
  hasPhoto: boolean,
): Promise<string[]> {
  const [totalRes, photoRes] = await Promise.all([
    sc.from("posts").select("id", { count: "exact", head: true })
      .eq("author_id", userId).eq("status", "active"),
    sc.from("posts").select("id", { count: "exact", head: true })
      .eq("author_id", userId).eq("status", "active")
      .not("media_urls", "eq", "{}"),
  ]);

  const totalPosts = totalRes.count ?? 0;
  const photoPosts = photoRes.count ?? 0;

  const socialAwards: Array<{ slug: string }> = [];
  if (totalPosts >= 1)  socialAwards.push({ slug: "first_post" });
  if (totalPosts >= 10) socialAwards.push({ slug: "storyteller" });
  if (hasPhoto && photoPosts >= 25) socialAwards.push({ slug: "photographer" });

  const settled = await Promise.allSettled(
    socialAwards.map(({ slug }) =>
      awardStamp(sc, {
        userId,
        definitionSlug: slug,
        sourceType:     "posts",
        sourceId:       postId,
      }).then((r) => ({ slug, ...r })),
    ),
  );

  return settled
    .filter((r) => r.status === "fulfilled" && (r as any).value.awarded)
    .map((r) => (r as any).value.slug as string);
}

router.post("/posts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  // Emergency kill switch: disable_posting — fail-CLOSED on DB error
  const flagSc = getServiceClient();
  if (flagSc && await isKillSwitchEngaged(flagSc, 'disable_posting')) {
    sendError(res, 'feature_disabled', 'Posting is temporarily disabled');
    return;
  }

  const parsed = createPostSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { content, mediaUrls, tripId, visibility } = parsed.data;
  const {
    mediaType, addToPassport, locationName, locationPlaceId, locationCity,
    locationCountry, locationLat, locationLng, userGpsLat, userGpsLng,
    locationSource: locationSrc,
    locationVisibility,
    filterId, filterIntensity, mediaThumbnailUrl, mediaDurationSeconds,
    locationPrivacyMode: reqPrivacyMode, publishAfterTime, geofenceRadiusMeters,
    venueName, venueId, category,
  } = parsed.data;
  const locationSource = locationSrc ?? 'none';

  // ── Delayed geotag: compute sensitivity / privacy mode / geofence radius ──
  const sens = sensitivityLevel(venueName ?? null);
  const privacyMode: LocationPrivacyMode = reqPrivacyMode ?? defaultPrivacyMode(locationSource, sens);
  const radius = geofenceRadius(sens, geofenceRadiusMeters ?? undefined);
  const publicLabel = safeLocationLabel(locationName ?? null, locationCity ?? null, locationCountry ?? null, privacyMode, sens);

  // Determine delayed-publish status from chosen privacy mode
  let delayedStatus: string = 'published';
  let publishAfterExitFlag = false;
  let publishEligibleAt: string | null = null;
  if (privacyMode === 'delayed_until_exit') {
    delayedStatus = 'pending_location_exit';
    publishAfterExitFlag = true;
  } else if (privacyMode === 'delayed_until_time' && publishAfterTime) {
    delayedStatus = 'pending_delay';
    publishEligibleAt = publishAfterTime;
  }

  // Trip-attached: verify existence + accepted membership BEFORE writing.
  if (tripId) {
    if (!(await tripExists(client, tripId))) {
      sendError(res, "not_found", "Trip not found");
      return;
    }
    if (!(await isAcceptedTripMember(client, tripId, user.id))) {
      // invited-but-not-accepted, declined, removed, or non-member all land here
      sendError(res, "not_member", "You must be an accepted member of this trip to post to it");
      return;
    }
  }

  // SERVER-OWNED location verification. Client verification flags are never
  // trusted (they aren't accepted by the schema). We compute the result here.
  const verdict = verifyLocation({
    locationLat: locationLat ?? null,
    locationLng: locationLng ?? null,
    userGpsLat: userGpsLat ?? null,
    userGpsLng: userGpsLng ?? null,
    locationSource: locationSource ?? 'none',
  });

  const { data, error } = await client
    .from("posts")
    .insert({
      author_id: user.id, // verified user only — never from client
      trip_id: tripId ?? null,
      content: content ?? "",
      media_urls: mediaUrls ?? [],
      media_type: mediaType ?? null,
      visibility,
      status: "active",
      // tagged location
      location_name: locationName ?? null,
      location_place_id: locationPlaceId ?? null,
      location_city: locationCity ?? null,
      location_country: locationCountry ?? null,
      location_lat: locationLat ?? null,
      location_lng: locationLng ?? null,
      // private GPS (internal only; never in public projections)
      user_gps_lat: userGpsLat ?? null,
      user_gps_lng: userGpsLng ?? null,
      location_source: locationSource,
      // server-decided verification
      location_verified: verdict.locationVerified,
      location_verified_at: verdict.locationVerified ? new Date().toISOString() : null,
      location_distance_meters: verdict.distanceMeters,
      add_to_passport: addToPassport ?? true,
      created_by: user.id,
      updated_by: user.id,
      source: "api_server",
      // editorial category
      category: category ?? null,
      // media filters
      filter_id: filterId ?? 'original',
      filter_intensity: filterIntensity ?? 100,
      media_thumbnail_url: mediaThumbnailUrl ?? null,
      media_duration_seconds: mediaDurationSeconds ?? null,
      // ── delayed geotag fields ──────────────────────────────────────────────
      location_privacy_mode: privacyMode,
      geotag_verified: verdict.locationVerified,
      geotag_credit_awarded: false, // set to true below after anti-abuse check
      original_lat: locationLat ?? null,   // private — never in public SELECTs
      original_lng: locationLng ?? null,   // private — never in public SELECTs
      venue_id: venueId ?? null,
      venue_name: venueName ?? null,
      public_location_label: publicLabel,
      geofence_radius_meters: radius,
      publish_after_exit: publishAfterExitFlag,
      publish_after_time: publishAfterTime ?? null,
      publish_eligible_at: publishEligibleAt,
      location_sensitivity_level: sens,
      post_status: delayedStatus,
    })
    .select(POST_COLUMNS)
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to insert post");
    sendError(res, "db_error", error.message);
    return;
  }

  // Compass activity ingestion — fire-and-forget
  recordActivityEvent(
    getServiceClient(),
    user.id,
    "post_published",
    { city: locationCity ?? undefined },
  );

  // Language detection — fire-and-forget; sets posts.original_language for translation.
  if ((content ?? '').trim()) {
    const _sc = getServiceClient();
    if (_sc) {
      detectAndStoreLanguage(_sc, 'post', (data as any).id, content ?? '', req.log).catch(() => {});
    }
  }

  // Auto-create a passport postcard when eligible (media + add_to_passport +
  // active). Best-effort: a postcard failure must NOT corrupt the post. The
  // unique(post_id) constraint prevents duplicates.
  let postcard: any = null;
  if (shouldCreatePostcard({ mediaUrls: mediaUrls ?? [], addToPassport: addToPassport ?? true, status: 'active' })) {
    const pc = await client
      .from("passport_postcards")
      .insert({
        post_id: (data as any).id,
        user_id: user.id,
        media_url: (mediaUrls as string[])[0],
        caption: content ?? null,
        location_name: locationName ?? null,
        location_city: locationCity ?? null,
        location_country: locationCountry ?? null,
        location_verified: verdict.locationVerified,
        stamp_eligible: verdict.stampEligible,
        stamp_reason: verdict.stampReason,
        verification_method: verdict.verificationMethod,
        verified_distance_meters: verdict.distanceMeters,
        verified_at: verdict.locationVerified ? new Date().toISOString() : null,
        visibility,
        status: 'active',
      })
      .select("id, post_id, location_verified, stamp_eligible, stamp_reason, verification_method")
      .single();
    if (pc.error) {
      // Log but don't fail the post (rollback plan: posting must survive).
      req.log.error({ err: pc.error }, "Postcard auto-create failed (post still created)");
    } else {
      postcard = pc.data;

      // GPS-verified city stamp: earned only when stamp_eligible=true AND a
      // city name is present. Best-effort — stamp failure must not affect post.
      if (verdict.stampEligible && locationCity) {
        const sc = getServiceClient();
        if (sc) {
          await upsertCityStamp(sc, {
            userId: user.id,
            locationCity,
            locationCountry: locationCountry ?? null,
            postcardId: postcard.id,
          }, req.log);

          // Fire-and-forget: location milestone stamps based on GPS-verified cities/countries.
          // city_explorer → first verified city; globe_trotter → 5 countries; world_citizen → 20 countries.
          // globe_trotter_5 / globe_trotter_10 → criteria-engine path (countries_visited >= 5/10).
          void (async () => {
            try {
              const stampSc = getServiceClient();
              if (!stampSc) return;

              const { data: postcardRows } = await stampSc
                .from("passport_postcards")
                .select("location_city, location_country")
                .eq("user_id", user.id)
                .eq("stamp_eligible", true);

              const rows = (postcardRows ?? []) as any[];
              const distinctCities = new Set(rows.map((r: any) => (r.location_city ?? "").toLowerCase().trim()).filter(Boolean)).size;
              const distinctCountries = new Set(rows.map((r: any) => (r.location_country ?? "").toLowerCase().trim()).filter(Boolean)).size;

              const locationAwards: Array<{ slug: string }> = [];
              if (distinctCities >= 1)  locationAwards.push({ slug: "city_explorer" });
              // globe_trotter (unversioned) removed — globe_trotter_5/10 via criteria-engine below
              if (distinctCountries >= 20) locationAwards.push({ slug: "world_citizen" });

              const [settled, criteriaOutcomes] = await Promise.all([
                Promise.allSettled(
                  locationAwards.map(({ slug }) =>
                    awardStamp(stampSc, {
                      userId:         user.id,
                      definitionSlug: slug,
                      sourceType:     "posts",
                      sourceId:       (data as any).id,
                      city:           locationCity ?? undefined,
                      country:        locationCountry ?? undefined,
                    }).then((r) => ({ slug, ...r })),
                  ),
                ),
                // Criteria-engine path: evaluate globe_trotter_5 and globe_trotter_10
                // (distinct countries from user_stamps via the countries_visited metric).
                // globe_trotter (unversioned) is retired — is_active=false in stamp_definitions.
                evaluateAndAwardCriteria(stampSc, user.id, {
                  sourceType: "posts",
                  sourceId:   (data as any).id,
                  onlySlugs:  ["globe_trotter_5", "globe_trotter_10"],
                }),
              ]);

              const awardedSlugs = [
                ...settled
                  .filter((r) => r.status === "fulfilled" && (r as any).value.awarded)
                  .map((r) => (r as any).value.slug as string),
                ...criteriaOutcomes
                  .filter((o) => o.awarded)
                  .map((o) => o.slug),
              ];

              if (awardedSlugs.length > 0) {
                const { NotificationService: NS } = await import("../services/notifications/NotificationService.js");
                const { NotificationRouter: NR }  = await import("../services/notifications/NotificationRouter.js");
                const notifSvc    = new NS(stampSc);
                const notifRouter = new NR(stampSc);
                const row = await notifSvc.create({
                  userId:     user.id,
                  eventType:  "passport.stamp_earned",
                  sourceType: "posts",
                  sourceId:   (data as any).id,
                  params: {
                    location: locationCity ?? locationCountry ?? "your travels",
                    stamps:   awardedSlugs.join(","),
                    count:    String(awardedSlugs.length),
                  },
                });
                if (row) await notifRouter.route(row);
              }
            } catch {}
          })();
        }
      }

      // Fire-and-forget: award first_postcard stamp on a user's first passport postcard.
      void (async () => {
        try {
          const sc = getServiceClient();
          if (!sc) return;
          const result = await awardStamp(sc, {
            userId:        user.id,
            definitionSlug: "first_postcard",
            // "postcards" skips validateSource() table lookup — postcard IDs live
            // in passport_postcards, not in the posts table.
            sourceType:    "postcards",
            sourceId:      (data as any).id,
            city:          locationCity ?? undefined,
            country:       locationCountry ?? undefined,
          });
          if (result.awarded) {
            const notifSvc    = new NotificationService(sc);
            const notifRouter = new NotificationRouter(sc);
            const row = await notifSvc.create({
              userId:     user.id,
              eventType:  "passport.stamp_earned",
              sourceType: "postcards",
              sourceId:   (data as any).id,
              params:     { location: locationCity ?? locationCountry ?? "your travels" },
            });
            if (row) await notifRouter.route(row);
          }
        } catch {}
      })();
    }
  }

  // Pulse GPS tag — write fire-and-forget after the post is committed.
  // Enforces privacy rules: off mode → no_location; hotel blur → neighborhood cap.
  // Never blocks the response; a failure must not corrupt the post.
  {
    const sc = getServiceClient();
    if (sc) {
      writePulseGeoTag(sc, {
        postId:                    (data as any).id,
        userId:                    user.id,
        userGpsLat:                userGpsLat   ?? null,
        userGpsLng:                userGpsLng   ?? null,
        locationCity:              locationCity ?? null,
        locationCountry:           locationCountry ?? null,
        venueName:                 locationName ?? null,
        locationVisibilityOverride: (locationVisibility ?? null) as any,
      }).catch((err) => {
        req.log.warn({ err }, "pulse_geo_tag write failed (non-fatal)");
      });
    }
  }

  // Write-time tagging: extract @mentions, enforce all permission/rate-limit rules,
  // write tag + hashtag_usage rows, then dispatch user_tagged notifications via
  // NotificationService (privacy guard + dedup) + NotificationRouter (push channels).
  // Non-fatal: a tagging failure must never block the post write path.
  {
    const sc = getServiceClient();
    if (sc && (content ?? '').trim().length > 0) {
      try {
        const taggedIds = await processTagging({
          db: sc,
          authorId: user.id,
          sourceType: 'post',
          sourceId: (data as any).id,
          content: content ?? '',
          city: locationCity ?? null,
          country: locationCountry ?? null,
          logger: req.log,
        });
        if (taggedIds.length > 0) {
          const { data: taggerProfile } = await sc.from('profiles').select('handle').eq('id', user.id).single();
          const taggerHandle = (taggerProfile as any)?.handle ?? 'someone';
          const notifSvc   = new NotificationService(sc);
          const notifRouter = new NotificationRouter(sc);
          await Promise.allSettled(
            taggedIds.map(async (taggedId) => {
              const row = await notifSvc.create({
                userId: taggedId,
                eventType: 'pulse.user_tagged',
                actorId: user.id,
                sourceType: 'post',
                sourceId: (data as any).id,
                params: { taggerHandle, context: `@${taggerHandle} mentioned you in a post.` },
              });
              if (row) await notifRouter.route(row);
            }),
          );
        }
      } catch (err) {
        req.log.warn({ err }, 'post tagging side-effect failed (non-fatal)');
      }
    }
  }

  // ── Geotag credit + anti-abuse (fire-and-forget, non-fatal) ────────────────
  // Credit is awarded at creation time (not publish time) when location is GPS-verified.
  // Anti-abuse: max 3 credits per user per venue per 24 h window.
  if (verdict.locationVerified && venueName) {
    const sc = getServiceClient();
    if (sc) {
      const rateLimited = await isGeotagCreditRateLimited(sc, user.id, venueName).catch(() => false);
      const postId = (data as any).id as string;
      if (rateLimited) {
        // Flag for safety review instead of awarding credit
        await sc.from("posts").update({ post_status: "pending_safety_review" }).eq("id", postId);
        await logDelayedEvent(sc, postId, user.id, "credit_rate_limited", {
          metadata: { venue_name: venueName, reason: "rate_limit_exceeded" },
        });
      } else {
        await sc.from("posts").update({ geotag_credit_awarded: true }).eq("id", postId);
        await logDelayedEvent(sc, postId, user.id, "geotag_credit_awarded", {
          metadata: { venue_name: venueName, sensitivity: sens },
        });
      }
    }
  }

  // Log created_pending event for all delayed posts
  if (delayedStatus !== 'published') {
    const sc = getServiceClient();
    if (sc) {
      await logDelayedEvent(sc, (data as any).id, user.id, "created_pending", {
        lat: locationLat ?? undefined,
        lng: locationLng ?? undefined,
        metadata: { privacy_mode: privacyMode, post_status: delayedStatus },
      });
    }
  }

  res.status(201).json({ ...(data as any), postcard });

  // Fire-and-forget: resolve the post's tagged location to a canonical venue-level
  // place record. Fail-soft — a resolution failure must never affect the post.
  if (locationName && locationLat != null && locationLng != null) {
    const placeSc = getServiceClient();
    if (placeSc) {
      void resolvePostPlace(placeSc, {
        postId: (data as any).id,
        locationName,
        latitude: locationLat,
        longitude: locationLng,
        city: locationCity ?? null,
        countryCode: locationCountry ?? null,
      }).then(async (result) => {
        const callbackNow = new Date();
        if (result?.placeId) {
          await placeSc
            .from("posts")
            .update({ canonical_place_id: result.placeId })
            .eq("id", (data as any).id)
            .is("canonical_place_id", null); // guard against race
          // A day only materializes from activity that is already eligible for
          // the public place surface. Private, delayed, hidden, or moderated
          // source content must not reveal an activity anchor.
          if (isEligiblePlaceDayPost(data)) {
            void ensurePlaceDay(placeSc, result.placeId, new Date((data as any).created_at ?? callbackNow));
          }

          // Bucket classification — fail-soft, never blocks post creation.
          try {
            const postId = (data as any).id as string;
            const buckets = classifyBuckets({
              tags: Array.isArray((data as any).tags) ? (data as any).tags : [],
              caption: content ?? null,
              category: category ?? null,
            });
            const postedAt = (data as any).created_at ?? callbackNow.toISOString();

            // Attempt to increment bucket counts in place_coverage_buckets.
            const upsertOk = buckets.length === 0
              ? true // nothing to upsert
              : await incrementBucketCounts(placeSc, postId, result.placeId, buckets, postedAt);

            if (!upsertOk) {
              postsLogger.warn({ postId, placeId: result.placeId }, "bucket upsert failed (non-fatal)");
            }

            // Store classified buckets on the post row and mark as done.
            // bucket_classified is set true only when there are no matches (genuinely empty)
            // OR when the count upsert succeeded — so a transient DB failure leaves the
            // post available for retry by the Phase-2 backfill worker.
            await placeSc
              .from("posts")
              .update({
                post_buckets:       buckets,
                bucket_classified:  buckets.length === 0 || upsertOk,
              })
              .eq("id", postId);
          } catch (bucketErr) {
            postsLogger.warn({ err: bucketErr, postId: (data as any).id }, "bucket classification failed (non-fatal)");
          }
        }
      }).catch((err) => {
        postsLogger.warn({ err, postId: (data as any).id }, "canonical place resolve failed (non-fatal)");
      });
    }
  }

  // Feed Pulse post creation into Trust Engine (fire-and-forget; flag-gated internally)
  void recordTrustEvent(client, {
    userId: user.id,
    eventType: "pulse_post_created",
    category: "content_quality",
    delta: 1,
    severity: "minor",
    sourceType: "pulse_post",
    sourceId: (data as any).id,
    dedupWindowHours: 2,
  });

  // Fire-and-forget: social post-count stamps.
  // first_post → 1st published post; storyteller → 10 posts; photographer → 25 posts with photos.
  // Trigger logic lives in awardSocialPostStamps() so it can be unit-tested independently.
  void (async () => {
    try {
      const stampSc = getServiceClient();
      if (!stampSc) return;
      const postId   = (data as any).id as string;
      const hasPhoto = ((data as any).media_urls as string[] ?? []).length > 0;

      const awardedSlugs = await awardSocialPostStamps(stampSc, user.id, postId, hasPhoto);

      if (awardedSlugs.length > 0) {
        const notifSvc    = new NotificationService(stampSc);
        const notifRouter = new NotificationRouter(stampSc);
        const row = await notifSvc.create({
          userId:     user.id,
          eventType:  "passport.stamp_earned",
          sourceType: "posts",
          sourceId:   postId,
          params: { stamps: awardedSlugs.join(","), count: String(awardedSlugs.length) },
        });
        if (row) await notifRouter.route(row);
      }
    } catch {}
  })();
});

// Safe public location labels (no GPS coordinates). Same privacy contract as POST_COLUMNS.
const FOLLOWING_POST_COLUMNS = POST_COLUMNS;

// ── Delayed geotag helpers ────────────────────────────────────────────────────

/** Append an event to the delayed_post_location_events table. Non-fatal. */
async function logDelayedEvent(
  db: any,
  postId: string,
  userId: string,
  eventType: string,
  extra?: { lat?: number; lng?: number; metadata?: Record<string, unknown> },
): Promise<void> {
  const { error } = await db.from("delayed_post_location_events").insert({
    post_id: postId,
    user_id: userId,
    event_type: eventType,
    lat: extra?.lat ?? null,
    lng: extra?.lng ?? null,
    metadata: extra?.metadata ?? null,
  });
  if (error) {
    postsLogger.warn({ err: error, postId, eventType }, "delayed post event write failed (non-fatal)");
  }
}

/**
 * Anti-abuse: check if the user has already received 3 geotag credits at the
 * same venue in the last 24 hours. Returns true when the cap is hit.
 */
async function isGeotagCreditRateLimited(
  db: any,
  userId: string,
  venueName: string | null,
): Promise<boolean> {
  if (!venueName) return false;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  try {
    const { count } = await db
      .from("delayed_post_location_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("event_type", "geotag_credit_awarded")
      .gte("created_at", since)
      .filter("metadata->>venue_name", "eq", venueName);
    return (count ?? 0) >= 3;
  } catch {
    return false;
  }
}

/* ===========================================================================
 * GET /posts  — global feed OR following feed
 * ===========================================================================
 * feed=global (default): active PUBLIC STANDALONE posts for all users.
 * feed=following: public standalone posts from users the caller follows only.
 *
 * Hard privacy rules enforced at the query level for BOTH modes:
 *   - visibility = "public" only (never trip_only or private)
 *   - trip_id IS NULL (standalone only — no trip content leaks)
 *   - status = "active" (no deleted/hidden/reported posts)
 *   - never returns user_gps_lat/lng (not in any SELECT column list)
 * Auth required for both modes.
 */
router.get("/posts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = listPostsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { limit, before, feed } = parsed.data;

  // ── Following feed ────────────────────────────────────────────────────────
  if (feed === "following") {
    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    // Step 1: who does this user follow?
    const { data: followRows, error: followErr } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", user.id);
    if (followErr) {
      req.log.error({ err: followErr }, "Failed to load following list for feed");
      sendError(res, "db_error", followErr.message);
      return;
    }
    const rawFollowingIds: string[] = (followRows ?? []).map((r: any) => r.following_id);
    if (rawFollowingIds.length === 0) {
      res.status(200).json({ posts: [], feed: "following" });
      return;
    }

    // Defensive layer: strip private accounts whose follow was never accepted.
    // user_follows rows for private accounts are only written on acceptance, but
    // if an account turned private AFTER being followed the row can be stale.
    // Cross-check: private followees must also have a user_friendships row.
    let followingIds = rawFollowingIds;
    try {
      const { data: privateFollowees, error: privateErr } = await sc
        .from("profiles")
        .select("id")
        .in("id", rawFollowingIds)
        .or("is_private.eq.true,passport_visibility.eq.private");
      // "None of these followees are private" and "the privacy query was
      // rejected" both arrive as an empty/null list, and only the first one
      // means the defensive layer had nothing to do. A schema/query error here
      // degrades the feed to unfiltered — which is the exact case this layer
      // exists to cover — so it must not pass silently.
      if (privateErr) {
        req.log.warn(
          { code: (privateErr as any)?.code, err: privateErr, userId: user.id },
          "following feed: private-followee lookup failed — stale-follow privacy cross-check skipped",
        );
      }
      if (privateFollowees && privateFollowees.length > 0) {
        const privateIdSet = new Set<string>(privateFollowees.map((p: any) => p.id));
        const { data: friendships, error: friendshipErr } = await sc
          .from("user_friendships")
          .select("user_a, user_b")
          .or(`user_a.eq.${user.id},user_b.eq.${user.id}`);
        // Fails the other way: an unreadable friendships table looks like "no
        // accepted friendships", so every private followee is dropped. Safe,
        // but a silently emptied following feed is not something to guess at.
        if (friendshipErr) {
          req.log.warn(
            { code: (friendshipErr as any)?.code, err: friendshipErr, userId: user.id },
            "following feed: user_friendships read failed — private followees will all be excluded",
          );
        }
        const acceptedPrivate = new Set<string>();
        for (const f of friendships ?? []) {
          const other = (f as any).user_a === user.id ? (f as any).user_b : (f as any).user_a;
          if (privateIdSet.has(other)) acceptedPrivate.add(other);
        }
        followingIds = rawFollowingIds.filter(id => !privateIdSet.has(id) || acceptedPrivate.has(id));
        if (followingIds.length === 0) {
          res.status(200).json({ posts: [], feed: "following" });
          return;
        }
      }
    } catch (err) {
      req.log.warn(
        { err, userId: user.id },
        "following feed: stale-follow privacy cross-check rejected — degrading to unfiltered",
      );
    }

    // Step 1b: fetch caller's hidden post IDs before the main LIMIT query so
    // the DB returns exactly `limit` visible posts (no premature end-of-feed).
    const followingHiddenIds: string[] = [];
    try {
      const { data: hiddenRows } = await sc
        .from("post_hides")
        .select("post_id")
        .eq("user_id", user.id);
      for (const r of hiddenRows ?? []) followingHiddenIds.push((r as any).post_id);
    } catch { /* best-effort */ }

    // Step 2: public standalone active published posts from followed users only.
    let q = sc
      .from("posts")
      .select(FOLLOWING_POST_COLUMNS)
      .in("author_id", followingIds)
      .is("trip_id", null)
      .eq("visibility", "public")
      .eq("status", "active")
      .eq("post_status", "published")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (before) q = q.lt("created_at", before);
    if (followingHiddenIds.length > 0) q = q.not("id", "in", `(${followingHiddenIds.join(",")})`);

    const { data: postRows, error: postErr } = await q;
    if (postErr) {
      req.log.error({ err: postErr }, "Failed to load following feed posts");
      sendError(res, "db_error", postErr.message);
      return;
    }
    const posts: any[] = postRows ?? [];

    // Step 3: batch-fetch author profiles (one query for all unique authors).
    const authorIds = [...new Set(posts.map((p) => p.author_id))];
    let profileMap: Record<string, any> = {};
    if (authorIds.length > 0) {
      const { data: profiles } = await sc
        .from("profiles")
        .select("id, handle, name, username, full_name, avatar_url, is_official")
        .in("id", authorIds);
      const allowedNames = await nameVisibilitySet(sc, authorIds);
      for (const p of profiles ?? []) profileMap[p.id] = sanitizeIdentity(p as any, allowedNames, user.id);
    }

    // Step 4: batch-fetch engagement counts + likedByMe + savedByMe + stampCount + isStampedByViewer.
    const postIds = posts.map((p) => p.id);
    const engMap: Record<string, { likeCount: number; commentCount: number; likedByMe: boolean; saveCount: number; savedByMe: boolean; stampCount: number; isStampedByViewer: boolean }> = {};
    if (postIds.length > 0) {
      const [{ data: engData }, { data: savedData }, { data: allStampData }, { data: myStampData }] = await Promise.all([
        sc.from("posts").select("id, like_count, comment_count, save_count").in("id", postIds),
        sc.from("post_saves").select("post_id").eq("user_id", user.id).in("post_id", postIds),
        sc.from("content_stamps").select("entity_id").eq("entity_type", "post").in("entity_id", postIds),
        sc.from("content_stamps").select("entity_id").eq("user_id", user.id).eq("entity_type", "post").in("entity_id", postIds),
      ]);
      const savedSet = new Set<string>((savedData ?? []).map((r: any) => r.post_id));
      const stampCountMap: Record<string, number> = {};
      for (const r of (allStampData ?? []) as any[]) stampCountMap[r.entity_id] = (stampCountMap[r.entity_id] ?? 0) + 1;
      // likedByMe derives from content_stamps (unified write path since Task 3047).
      const myStampSet = new Set<string>((myStampData ?? []).map((r: any) => r.entity_id as string));
      for (const r of engData ?? []) {
        engMap[r.id] = {
          // likeCount derives from content_stamps so it stays consistent with
          // compat like writes — posts.like_count is no longer updated.
          likeCount: stampCountMap[r.id] ?? 0,
          commentCount: r.comment_count ?? 0,
          likedByMe: myStampSet.has(r.id),
          saveCount: r.save_count ?? 0,
          savedByMe: savedSet.has(r.id),
          stampCount: stampCountMap[r.id] ?? 0,
          isStampedByViewer: myStampSet.has(r.id),
        };
      }
    }

    // Step 5: enrich with positioned @mention + #hashtag spans.
    const followingSpansMap = posts.length > 0
      ? await enrichSpans(sc, 'post', posts.map((p) => ({ id: p.id as string, content: (p.content ?? '') as string })), user.id)
      : {};

    // Step 5.5: batch-fetch structured media for posts that carry video/images.
    const followingMediaByPost: Record<string, any[]> = {};
    if (postIds.length > 0) {
      try {
        const { data: mediaRows } = await sc
          .from("post_media")
          .select(POST_MEDIA_FEED_COLUMNS + (await stampOverlayCol(sc)) + (await feedVariantCol(sc)))
          .in("post_id", postIds)
          .eq("processing_status", "ready")
          .neq("moderation_status", "rejected");
        for (const m of (mediaRows ?? []) as any[]) {
          if (!followingMediaByPost[m.post_id]) followingMediaByPost[m.post_id] = [];
          followingMediaByPost[m.post_id].push(m);
        }
      } catch { /* fail-open: missing media must not break the feed */ }
    }

    // Step 6: merge author + engagement + spans + media into each post.
    // Hidden-Gem location protection (fail-closed) — coarsens public coords/labels
    // for posts that sit at / are tagged to a protected gem.
    const followingGemCtx = await loadPostGemContext(sc, posts);
    const merged = posts.map((p) => {
      const safe = gemProtectPost(mapPublicPost(p), followingGemCtx, user.id);
      const pr = profileMap[p.author_id];
      const eng = engMap[p.id] ?? { likeCount: 0, commentCount: 0, likedByMe: false, saveCount: 0, savedByMe: false, stampCount: 0, isStampedByViewer: false };
      const spans = (followingSpansMap as any)[p.id] ?? { tags: [], hashtagUsages: [] };
      return {
        ...safe,
        author: pr
          ? {
              id:         pr.id,
              handle:     pr.handle ?? pr.username ?? null,
              username:   pr.handle ?? pr.username ?? null,
              name:       pr.name ?? pr.full_name ?? null,
              avatarUrl:  pr.avatar_url ?? null,
              isOfficial: (pr.is_official as boolean) ?? false,
            }
          : null,
        likeCount: eng.likeCount,
        commentCount: eng.commentCount,
        likedByMe: eng.likedByMe,
        saveCount: eng.saveCount,
        savedByMe: eng.savedByMe,
        stampCount: eng.stampCount,
        isStampedByViewer: eng.isStampedByViewer,
        canLike: true,
        canComment: true,
        canShare: true,
        tags: spans.tags,
        hashtagUsages: spans.hashtagUsages,
        media: filterPostMedia(followingMediaByPost[p.id] ?? []),
      };
    });

    res.status(200).json({ posts: merged, feed: "following" });
    return;
  }

  // ── Global feed (default) ─────────────────────────────────────────────────
  const svc = getServiceClient();
  if (!svc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Pre-fetch IDs to exclude before the LIMIT query so the DB returns exactly
  // `limit` visible posts without premature end-of-feed.
  const globalHiddenIds: string[] = [];
  try {
    const { data: hiddenRows } = await svc
      .from("post_hides")
      .select("post_id")
      .eq("user_id", user.id);
    for (const r of hiddenRows ?? []) globalHiddenIds.push((r as any).post_id);
  } catch { /* best-effort */ }

  // Exclude posts from private-profile authors. The global feed is shown to all
  // authenticated users; private accounts' content must not surface to non-followers.
  // We check three sources so a user who set privacy via any route is covered:
  //   1. profiles.is_private = true  (synced from privacy PATCH)
  //   2. profiles.passport_visibility = 'private'  (separate passport toggle)
  //   3. profile_privacy_settings.profile_visibility = 'private'  (canonical settings row)
  const privateAuthorIdSet = new Set<string>();
  {
    let lookupFailure: unknown = null;
    try {
      const [profRes, settingsRes] = await Promise.all([
        svc.from("profiles").select("id").or("is_private.eq.true,passport_visibility.eq.private"),
        svc.from("profile_privacy_settings").select("user_id").eq("profile_visibility", "private"),
      ]);
      // An empty set means "no private accounts exist"; a failed query means
      // "we could not find out". Both used to produce the same empty exclusion
      // list, and the second one published every private account's posts to the
      // global feed for that page. PostgREST reports such failures in `error`
      // rather than throwing, so the catch below never fires for them — inspect
      // both results explicitly and FAIL CLOSED.
      if (profRes.error || settingsRes.error) {
        lookupFailure = profRes.error ?? settingsRes.error;
        req.log.error(
          {
            profilesCode: (profRes.error as any)?.code,
            settingsCode: (settingsRes.error as any)?.code,
            err: lookupFailure,
          },
          "global feed: private-author lookup failed — refusing to serve an unfiltered page",
        );
      } else {
        for (const p of profRes.data ?? []) privateAuthorIdSet.add((p as any).id);
        for (const p of settingsRes.data ?? []) privateAuthorIdSet.add((p as any).user_id);
      }
    } catch (err) {
      lookupFailure = err ?? new Error("private-author lookup rejected");
      req.log.error(
        { err },
        "global feed: private-author lookup rejected — refusing to serve an unfiltered page",
      );
    }
    if (lookupFailure) {
      // Fail-closed: without the exclusion list every private account's posts
      // would surface to this page. A retryable 503 is the honest answer.
      sendError(res, "degraded_unavailable", "Feed privacy filter unavailable");
      return;
    }
  }
  const privateAuthorIds = [...privateAuthorIdSet];

  let q = svc
    .from("posts")
    .select(POST_COLUMNS)
    .is("trip_id", null)
    .eq("visibility", "public")
    .eq("status", "active")
    .eq("post_status", "published")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) q = q.lt("created_at", before);
  if (globalHiddenIds.length > 0) q = q.not("id", "in", `(${globalHiddenIds.join(",")})`);
  if (privateAuthorIds.length > 0) q = q.not("author_id", "in", `(${privateAuthorIds.join(",")})`);

  const { data, error } = await q;
  if (error) {
    req.log.error({ err: error }, "Failed to list posts");
    sendError(res, "db_error", error.message);
    return;
  }

  const globalPosts: any[] = data ?? [];
  const globalPostIds = globalPosts.map((p) => p.id);
  const globalAuthorIds = [...new Set(globalPosts.map((p) => p.author_id))];

  // Batch-fetch authors
  let globalProfileMap: Record<string, any> = {};
  if (globalAuthorIds.length > 0) {
    const { data: profiles } = await svc
      .from("profiles")
      .select("id, handle, name, avatar_url, is_official")
      .in("id", globalAuthorIds);
    const allowedNames = await nameVisibilitySet(svc, globalAuthorIds);
    for (const p of profiles ?? []) globalProfileMap[p.id] = sanitizeIdentity(p as any, allowedNames, user.id);
  }

  // Batch-fetch engagement + likedByMe + savedByMe + stampCount + isStampedByViewer
  const globalEngMap: Record<string, { likeCount: number; commentCount: number; likedByMe: boolean; saveCount: number; savedByMe: boolean; stampCount: number; isStampedByViewer: boolean }> = {};
  if (globalPostIds.length > 0) {
    const [{ data: engData }, { data: savedData }, { data: allStampData }, { data: myStampData }] = await Promise.all([
      svc.from("posts").select("id, like_count, comment_count, save_count").in("id", globalPostIds),
      svc.from("post_saves").select("post_id").eq("user_id", user.id).in("post_id", globalPostIds),
      svc.from("content_stamps").select("entity_id").eq("entity_type", "post").in("entity_id", globalPostIds),
      svc.from("content_stamps").select("entity_id").eq("user_id", user.id).eq("entity_type", "post").in("entity_id", globalPostIds),
    ]);
    const savedSet = new Set<string>((savedData ?? []).map((r: any) => r.post_id));
    const stampCountMap: Record<string, number> = {};
    for (const r of (allStampData ?? []) as any[]) stampCountMap[r.entity_id] = (stampCountMap[r.entity_id] ?? 0) + 1;
    // likedByMe derives from content_stamps (unified write path since Task 3047).
    const myStampSet = new Set<string>((myStampData ?? []).map((r: any) => r.entity_id as string));
    for (const r of engData ?? []) {
      globalEngMap[r.id] = {
        // likeCount derives from content_stamps so it stays consistent with
        // compat like writes — posts.like_count is no longer updated.
        likeCount: stampCountMap[r.id] ?? 0,
        commentCount: r.comment_count ?? 0,
        likedByMe: myStampSet.has(r.id),
        saveCount: r.save_count ?? 0,
        savedByMe: savedSet.has(r.id),
        stampCount: stampCountMap[r.id] ?? 0,
        isStampedByViewer: myStampSet.has(r.id),
      };
    }
  }

  // Enrich with positioned @mention + #hashtag spans
  const globalSpansMap = globalPosts.length > 0
    ? await enrichSpans(svc, 'post', globalPosts.map((p) => ({ id: p.id as string, content: (p.content ?? '') as string })), user.id)
    : {};

  // Batch-fetch structured media for global feed posts (fail-open)
  const globalMediaByPost: Record<string, any[]> = {};
  if (globalPostIds.length > 0) {
    try {
      const { data: mediaRows } = await svc
        .from("post_media")
        .select(POST_MEDIA_FEED_COLUMNS + (await stampOverlayCol(svc)) + (await feedVariantCol(svc)))
        .in("post_id", globalPostIds)
        .eq("processing_status", "ready")
        .neq("moderation_status", "rejected");
      for (const m of (mediaRows ?? []) as any[]) {
        if (!globalMediaByPost[m.post_id]) globalMediaByPost[m.post_id] = [];
        globalMediaByPost[m.post_id].push(m);
      }
    } catch { /* fail-open */ }
  }

  // Hidden-Gem location protection (fail-closed).
  const globalGemCtx = await loadPostGemContext(svc, globalPosts);
  const mergedGlobal = globalPosts.map((p) => {
    const safe = gemProtectPost(mapPublicPost(p), globalGemCtx, user.id);
    const pr = globalProfileMap[p.author_id];
    const eng = globalEngMap[p.id] ?? { likeCount: 0, commentCount: 0, likedByMe: false, saveCount: 0, savedByMe: false, stampCount: 0, isStampedByViewer: false };
    const spans = (globalSpansMap as any)[p.id] ?? { tags: [], hashtagUsages: [] };
    return {
      ...safe,
      author: pr ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null, isOfficial: (pr.is_official as boolean) ?? false } : null,
      likeCount: eng.likeCount,
      commentCount: eng.commentCount,
      likedByMe: eng.likedByMe,
      saveCount: eng.saveCount,
      savedByMe: eng.savedByMe,
      stampCount: eng.stampCount,
      isStampedByViewer: eng.isStampedByViewer,
      canLike: true,
      canComment: true,
      canShare: true,
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
      media: filterPostMedia(globalMediaByPost[p.id] ?? []),
    };
  });

  // ── Hashtag boost for followed hashtags ──────────────────────────────────────
  // Posts that share at least one hashtag with the viewer's followed set are
  // surfaced slightly higher.  This is a soft-boost (re-sort within the page),
  // not a hard filter — the feed always contains non-followed posts too.
  const boostedPostIds = new Set<string>();
  try {
    if (globalPostIds.length > 0) {
      const { data: followedRows } = await svc
        .from("user_hashtag_follows")
        .select("hashtag_id")
        .eq("user_id", user.id);
      const followedHashtagIds = (followedRows ?? []).map((r: any) => r.hashtag_id as string);
      if (followedHashtagIds.length > 0) {
        const { data: matchRows } = await svc
          .from("hashtag_usage")
          .select("source_id")
          .eq("source_type", "post")
          .in("source_id", globalPostIds)
          .in("hashtag_id", followedHashtagIds);
        for (const r of matchRows ?? []) boostedPostIds.add((r as any).source_id as string);
      }
    }
  } catch { /* non-fatal — serve feed without boost on error */ }

  const finalPosts = boostedPostIds.size === 0
    ? mergedGlobal
    : [
        ...mergedGlobal.filter((p) => boostedPostIds.has(p.id)).map((p) => ({ ...p, hashtagBoosted: true })),
        ...mergedGlobal.filter((p) => !boostedPostIds.has(p.id)),
      ];

  res.status(200).json({ posts: finalPosts, feed: "global" });
});

/* ===========================================================================
 * GET /trips/:tripId/posts  — a trip's feed
 * ===========================================================================
 * - requires accepted membership to view trip_only content
 * - returns active posts attached to that trip that the user may see:
 *     public (anyone who can load the trip) + trip_only (accepted members)
 *   excludes other users' private posts.
 */
router.get("/trips/:tripId/posts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const tripId = req.params.tripId;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
    sendError(res, "invalid_payload", "Invalid trip id");
    return;
  }
  if (!(await tripExists(client, tripId))) {
    sendError(res, "not_found", "Trip not found");
    return;
  }

  const accepted = await isAcceptedTripMember(client, tripId, user.id);

  // Non-members may only ever see public trip-attached posts; accepted members
  // additionally see trip_only. Nobody sees another user's private post.
  //
  // DELAYED-PUBLISH GATE. `status = 'active'` is what POST /posts writes for a
  // delayed-geotag post; the publication state lives in `post_status`, and this
  // feed read neither of them together. POST_COLUMNS has always SELECTED
  // post_status (the same "selected but never read" shape as the visibility
  // leak below it), so a pending post — content, city, venue label — reached
  // every trip member while its author was still standing at the place (§23/§37).
  //
  // Author-or-published, matching GET /posts/:postId, not the strict
  // `post_status = 'published'` of the Wall / global / following feeds: this
  // route deliberately shows a viewer their OWN posts (see the private branch
  // below), so a strict gate would hide the author's own pending post from
  // their own trip. PostgREST ANDs repeated `or=` params, so this composes with
  // the visibility `or` rather than replacing it.
  let q = client
    .from("posts")
    .select(POST_COLUMNS)
    .eq("trip_id", tripId)
    .eq("status", "active")
    .or(`post_status.eq.published,author_id.eq.${user.id}`)
    .order("created_at", { ascending: false })
    .limit(100);

  if (accepted) {
    // public + trip_only, plus own private
    q = q.or(
      `visibility.eq.public,visibility.eq.trip_only,and(visibility.eq.private,author_id.eq.${user.id})`,
    );
  } else {
    // public only, plus own private
    q = q.or(`visibility.eq.public,and(visibility.eq.private,author_id.eq.${user.id})`);
  }

  const { data, error } = await q;
  if (error) {
    req.log.error({ err: error }, "Failed to list trip posts");
    sendError(res, "db_error", error.message);
    return;
  }
  // In-memory re-check of the same predicate: a row fed past the query filter
  // (a widened `or`, a client that drops the param) must still never be served.
  const tripPosts: any[] = (data ?? []).filter(
    (p: any) => isPostPublished(p) || p.author_id === user.id,
  );
  const tripPostIds = tripPosts.map((p) => p.id);
  const tripAuthorIds = [...new Set(tripPosts.map((p) => p.author_id))];

  const tripSvc = getServiceClient();
  let tripProfileMap: Record<string, any> = {};
  if (tripSvc && tripAuthorIds.length > 0) {
    const { data: profiles } = await tripSvc
      .from("profiles").select("id, handle, name, avatar_url, is_official").in("id", tripAuthorIds);
    const allowedNames = await nameVisibilitySet(tripSvc, tripAuthorIds);
    for (const p of profiles ?? []) tripProfileMap[p.id] = sanitizeIdentity(p as any, allowedNames, user.id);
  }

  const tripEngMap: Record<string, { likeCount: number; commentCount: number; likedByMe: boolean; saveCount: number; savedByMe: boolean; stampCount: number; isStampedByViewer: boolean }> = {};
  if (tripSvc && tripPostIds.length > 0) {
    const [{ data: engData }, { data: savedData }, { data: allStampData }, { data: myStampData }] = await Promise.all([
      tripSvc.from("posts").select("id, like_count, comment_count, save_count").in("id", tripPostIds),
      tripSvc.from("post_saves").select("post_id").eq("user_id", user.id).in("post_id", tripPostIds),
      tripSvc.from("content_stamps").select("entity_id").eq("entity_type", "post").in("entity_id", tripPostIds),
      tripSvc.from("content_stamps").select("entity_id").eq("user_id", user.id).eq("entity_type", "post").in("entity_id", tripPostIds),
    ]);
    const savedSet = new Set<string>((savedData ?? []).map((r: any) => r.post_id));
    const stampCountMap: Record<string, number> = {};
    for (const r of (allStampData ?? []) as any[]) stampCountMap[r.entity_id] = (stampCountMap[r.entity_id] ?? 0) + 1;
    // likedByMe derives from content_stamps (unified write path since Task 3047).
    const myStampSet = new Set<string>((myStampData ?? []).map((r: any) => r.entity_id as string));
    for (const r of engData ?? []) {
      // likeCount derives from content_stamps — posts.like_count no longer updated by compat writes.
      tripEngMap[r.id] = { likeCount: stampCountMap[r.id] ?? 0, commentCount: r.comment_count ?? 0, likedByMe: myStampSet.has(r.id), saveCount: r.save_count ?? 0, savedByMe: savedSet.has(r.id), stampCount: stampCountMap[r.id] ?? 0, isStampedByViewer: myStampSet.has(r.id) };
    }
  }

  // Enrich with positioned @mention + #hashtag spans
  const tripSpansMap = (tripSvc && tripPosts.length > 0)
    ? await enrichSpans(tripSvc, 'post', tripPosts.map((p) => ({ id: p.id as string, content: (p.content ?? '') as string })), user.id)
    : {};

  // Batch-fetch structured media for trip posts (fail-open)
  const tripMediaByPost: Record<string, any[]> = {};
  if (tripSvc && tripPostIds.length > 0) {
    try {
      const { data: mediaRows } = await tripSvc
        .from("post_media")
        .select(POST_MEDIA_FEED_COLUMNS + (await stampOverlayCol(tripSvc)) + (await feedVariantCol(tripSvc)))
        .in("post_id", tripPostIds)
        .eq("processing_status", "ready")
        .neq("moderation_status", "rejected");
      for (const m of (mediaRows ?? []) as any[]) {
        if (!tripMediaByPost[m.post_id]) tripMediaByPost[m.post_id] = [];
        tripMediaByPost[m.post_id].push(m);
      }
    } catch { /* fail-open */ }
  }

  const mergedTrip = tripPosts.map((p) => {
    const pr = tripProfileMap[p.author_id];
    const eng = tripEngMap[p.id] ?? { likeCount: 0, commentCount: 0, likedByMe: false, saveCount: 0, savedByMe: false, stampCount: 0, isStampedByViewer: false };
    const spans = (tripSpansMap as any)[p.id] ?? { tags: [], hashtagUsages: [] };
    // public: any authenticated user; trip_only: accepted members only; private: no public engagement
    const canEngage = p.visibility === "public" || (p.visibility === "trip_only" && accepted);
    return {
      ...p,
      author: pr ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null, isOfficial: (pr.is_official as boolean) ?? false } : null,
      likeCount: eng.likeCount,
      commentCount: eng.commentCount,
      likedByMe: eng.likedByMe,
      saveCount: eng.saveCount,
      savedByMe: eng.savedByMe,
      stampCount: eng.stampCount,
      isStampedByViewer: eng.isStampedByViewer,
      canLike: canEngage,
      canComment: canEngage,
      canShare: canEngage,
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
      media: filterPostMedia(tripMediaByPost[p.id] ?? []),
    };
  });

  res.status(200).json({ posts: mergedTrip, isMember: accepted });
});

/* ===========================================================================
 * GET /posts/pending  — author's own pending posts
 * ===========================================================================
 * Must be registered BEFORE any /posts/:postId route so Express does not
 * treat the literal "pending" as a :postId parameter.
 * Returns the caller's posts with status in (pending_location_exit,
 * pending_delay, pending_safety_review).
 */
router.get("/posts/pending", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data, error } = await client
    .from("posts")
    .select(PENDING_POST_COLUMNS)
    .eq("author_id", user.id)
    .eq("status", "active")
    .in("post_status", ["pending_location_exit", "pending_delay", "pending_safety_review"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    req.log.error({ err: error }, "Failed to load pending posts");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(200).json({ posts: await withPostMedia(getServiceClient() ?? client, data ?? []) });
});

/* ===========================================================================
 * GET /posts/liked-by-me  — compact list of the current user's stamped post IDs
 *
 * Used by the client-side liked-posts cache to pre-warm on auth so 'liked by
 * me' heart indicators are correct from the first feed paint.
 *
 * Reads from content_stamps (unified write path since Task 3047) so the result
 * is always consistent with POST /posts/:postId/like and POST /stamps.
 *
 * Query params:
 *   limit  — max rows to return (default 500, capped at 500)
 *
 * Response: { postIds: string[] }
 * ===========================================================================
 */
router.get("/posts/liked-by-me", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const rawLimit = parseInt((req.query.limit as string) ?? "500", 10);
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 500 : Math.min(rawLimit, 500);

  const { data, error } = await sc
    .from("content_stamps")
    .select("entity_id")
    .eq("user_id", user.id)
    .eq("entity_type", "post")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    req.log.error({ err: error }, "Failed to fetch liked-by-me post IDs");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ postIds: (data ?? []).map((r: { entity_id: string }) => r.entity_id) });
});

/* ===========================================================================
 * GET /posts/saved-by-me  — compact list of the current user's saved post IDs
 *
 * Used by the client-side saved-posts cache to pre-warm on auth so bookmark
 * indicators are correct from the first feed paint without a round-trip.
 *
 * Queries post_saves filtered by user_id, ordered by created_at DESC so the
 * most-recently saved posts are included first when the result is capped.
 *
 * Query params:
 *   limit  — max rows to return (default 500, capped at 500)
 *
 * Response: { postIds: string[] }
 * ===========================================================================
 */
router.get("/posts/saved-by-me", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const rawLimit = parseInt((req.query.limit as string) ?? "500", 10);
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 500 : Math.min(rawLimit, 500);

  const { data, error } = await sc
    .from("post_saves")
    .select("post_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    req.log.error({ err: error }, "Failed to fetch saved-by-me post IDs");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ postIds: (data ?? []).map((r: { post_id: string }) => r.post_id) });
});

/* ===========================================================================
 * GET /posts/:postId  — single post fetch (author sees own pending; others
 * only see published posts)
 * ===========================================================================
 */
router.get("/posts/:postId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("posts")
    .select(POST_COLUMNS)
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Post not found"); return; }

  const post = data as any;
  const isAuthor = post.author_id === user.id;
  const isPublished = !post.post_status || post.post_status === "published";

  if (!isPublished && !isAuthor) {
    sendError(res, "not_found", "Post not found");
    return;
  }

  // VISIBILITY. The read above uses the SERVICE client, so RLS is bypassed and
  // this is the only thing standing between a post id and its contents.
  // POST_COLUMNS has always selected `visibility` and `trip_id`; nothing read
  // them, so any authenticated user holding an id received private and
  // trip_only posts in full.
  //
  // The membership query runs ONLY for a trip_only post viewed by a non-author
  // (see needsTripMembershipCheck) — author and public reads cost no extra
  // round trip. It uses the USER client, matching checkEngagePermission, so
  // membership is evaluated under the viewer's own RLS rather than bypassed.
  //
  // A refusal answers not_found rather than forbidden: forbidden would confirm
  // that a private post with this id exists, which is itself a disclosure to
  // someone who may only be guessing ids.
  const viewerIsTripMember = needsTripMembershipCheck(post, user.id)
    ? await isAcceptedTripMember(client, post.trip_id, user.id)
    : false;

  // followers_only posts are readable by the author's followers. Resolve the
  // follow relationship only when the tier actually needs it (needsFollowerCheck)
  // — author/public/private/trip_only reads cost no extra round trip. The USER
  // client is used (matching the membership check) so the follow row is read
  // under the viewer's own RLS rather than bypassed.
  const viewerIsFollower = needsFollowerCheck(post, user.id)
    ? await (async () => {
        const { data: followRow } = await client
          .from("user_follows")
          .select("follower_id")
          .eq("follower_id", user.id)
          .eq("following_id", post.author_id)
          .maybeSingle();
        return !!followRow;
      })()
    : false;

  const decision = decidePostReadable(post, user.id, viewerIsTripMember, viewerIsFollower);
  if (!decision.readable) {
    req.log.info(
      { postId, viewerId: user.id, reason: decision.reason },
      "post read refused by visibility gate",
    );
    sendError(res, "not_found", "Post not found");
    return;
  }

  const [{ data: savedRow }, { data: rawMedia }, { count: postStampCount }, { count: liveCommentCount }, { data: myStampRow }, { data: featuredRow }, { data: authorProfile }, allowedNames] = await Promise.all([
    sc.from("post_saves").select("post_id").eq("post_id", postId).eq("user_id", user.id).maybeSingle(),
    sc.from("post_media")
      .select("id, media_type, public_url, thumbnail_url, duration_seconds, width, height, sort_order, processing_status, moderation_status" + (await stampOverlayCol(sc)) + (await feedVariantCol(sc)))
      .eq("post_id", postId)
      .eq("processing_status", "ready")
      .order("sort_order", { ascending: true }),
    sc.from("content_stamps").select("id", { count: "exact", head: true }).eq("entity_type", "post").eq("entity_id", postId),
    sc.from("posts_comments").select("id", { count: "exact", head: true }).eq("post_id", postId).is("deleted_at", null),
    sc.from("content_stamps").select("id").eq("user_id", user.id).eq("entity_type", "post").eq("entity_id", postId).maybeSingle(),
    sc.from("portava_featured")
      .select("category, featured_at")
      .eq("post_id", postId)
      .eq("status", "live")
      .order("featured_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sc.from("profiles").select("id, handle, name, avatar_url, is_official").eq("id", post.author_id).maybeSingle(),
    nameVisibilitySet(sc, [post.author_id]),
  ]);

  // Filter out moderated items; preserve backward-compat mediaUrls field on the base object
  // `feed_url` mirrors filterPostMedia() — see the contract note there. Detail
  // views load the ORIGINAL, so this is projected for shape-consistency with the
  // feed endpoints rather than because this surface should render it.
  const media = ((rawMedia ?? []) as any[])
    .filter((m: any) => m.moderation_status !== "rejected" && m.moderation_status !== "flagged")
    .map((m: any) => ({
      id:                m.id,
      media_type:        m.media_type,
      url:               m.public_url,
      feed_url:          m.feed_url ?? null,
      thumbnail_url:     m.thumbnail_url ?? null,
      duration_seconds:  m.duration_seconds ?? null,
      width:             m.width ?? null,
      height:            m.height ?? null,
      sort_order:        m.sort_order ?? 0,
      processing_status: m.processing_status,
      stamp_overlay:     m.stamp_overlay ?? null,
    }));

  // Hidden-Gem location protection (fail-closed) for non-author reads.
  const singlePostGemCtx = isAuthor ? null : await loadPostGemContext(sc, [post]);
  const base = isAuthor
    ? post
    : gemProtectPost(mapPublicPost(post), singlePostGemCtx!, user.id);
  const featuredByPortava = featuredRow
    ? { category: (featuredRow as any).category, featuredAt: (featuredRow as any).featured_at }
    : null;

  // Build author object matching the shape used by feed endpoints.
  // Universal display-name rule: show real name only when the author opted in or is the viewer.
  const ap = authorProfile as any | null;
  const nameOk = ap && (ap.id === user.id || allowedNames.has(ap.id as string));
  const author = ap
    ? { id: ap.id, handle: ap.handle, name: nameOk ? (ap.name ?? null) : null, avatarUrl: ap.avatar_url ?? null, isOfficial: (ap.is_official as boolean) ?? false }
    : null;

  res.status(200).json({
    ...base,
    author,
    // likeCount derives from content_stamps so it stays consistent with compat
    // like writes — posts.like_count is no longer updated in this write path.
    likeCount: postStampCount ?? 0,
    // Read the live comments table rather than relying on the cached posts
    // counter; older comments can exist while that denormalized value is stale.
    commentCount: liveCommentCount ?? 0,
    saveCount: post.save_count ?? 0,
    likedByMe: !!myStampRow,
    savedByMe: !!savedRow,
    stampCount: postStampCount ?? 0,
    isStampedByViewer: !!myStampRow,
    media,
    canLike: true,
    canComment: true,
    canShare: true,
    featuredByPortava,
  });
});

/* ===========================================================================
 * PATCH /posts/:postId/location-privacy  — change privacy mode
 * ===========================================================================
 * Author-only. Validates ownership, changes mode, recomputes post_status and
 * publish_eligible_at, logs a privacy_changed event.
 */
router.patch("/posts/:postId/location-privacy", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const nowMs = Date.now();
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const parsed = locationPrivacyPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { locationPrivacyMode: newMode, publishAfterTime } = parsed.data;

  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id, canonical_place_id, created_at, visibility, status, post_status, location_sensitivity_level")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can change location privacy");
    return;
  }

  // Cannot change privacy on posts that are already published or canceled
  const currentStatus = (existing as any).post_status as string;
  if (currentStatus === "published" || currentStatus === "canceled" || currentStatus === "expired") {
    sendError(res, "invalid_payload", `Cannot change privacy on a ${currentStatus} post`);
    return;
  }

  const patch: Record<string, unknown> = { location_privacy_mode: newMode };
  if (newMode === "delayed_until_exit") {
    patch.post_status = "pending_location_exit";
    patch.publish_after_exit = true;
    patch.publish_eligible_at = null;
  } else if (newMode === "delayed_until_time" && publishAfterTime) {
    patch.post_status = "pending_delay";
    patch.publish_eligible_at = publishAfterTime;
    patch.publish_after_time = publishAfterTime;
  } else if (newMode === "none" || newMode === "hidden" || newMode === "city_only" || newMode === "trusted_circle_only") {
    patch.post_status = "published";
    patch.published_at = new Date(nowMs).toISOString();
    patch.publish_eligible_at = null;
  }

  const { data: updated, error: updateErr } = await client
    .from("posts")
    .update(patch)
    .eq("id", postId)
    .eq("author_id", user.id)
    .select(POST_COLUMNS)
    .single();
  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  const sc = getServiceClient();
  if (sc) {
    await logDelayedEvent(sc, postId, user.id, "privacy_changed", {
      metadata: { new_mode: newMode, new_status: patch.post_status },
    });
    await invalidateCompassCache(sc, user.id, "post_privacy_change");
    if (
      patch.post_status === "published" &&
      (updated as any)?.canonical_place_id &&
      isEligiblePlaceDayPost(updated)
    ) {
      await ensurePlaceDay(
        sc,
        (updated as any).canonical_place_id,
        new Date((updated as any).created_at ?? nowMs),
      );
    }
  }

  res.status(200).json(await withPostMediaOne(getServiceClient() ?? client, updated));
});

/* ===========================================================================
 * POST /posts/:postId/publish-now-without-location  — strip location, publish
 * ===========================================================================
 */
router.post("/posts/:postId/publish-now-without-location", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const nowMs = Date.now();
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id, canonical_place_id, created_at, visibility, status, post_status")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can publish this post");
    return;
  }

  const now = new Date(nowMs).toISOString();
  const { data: updated, error: updateErr } = await client
    .from("posts")
    .update({
      post_status: "published",
      published_at: now,
      location_privacy_mode: "hidden",
      // Strip public coordinates — this post publishes without location
      public_lat: null,
      public_lng: null,
      public_location_label: null,
      venue_name: null,
    })
    .eq("id", postId)
    .eq("author_id", user.id)
    .select(POST_COLUMNS)
    .single();
  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  const sc = getServiceClient();
  if (sc) {
    await logDelayedEvent(sc, postId, user.id, "publish_without_location", {
      metadata: { published_at: now },
    });
    if (
      (updated as any)?.canonical_place_id &&
      isEligiblePlaceDayPost(updated)
    ) {
      await ensurePlaceDay(
        sc,
        (updated as any).canonical_place_id,
        new Date((updated as any).created_at ?? nowMs),
      );
    }
  }

  res.status(200).json(await withPostMediaOne(getServiceClient() ?? client, updated));
});

/* ===========================================================================
 * POST /posts/:postId/cancel-delayed-publish  — cancel a pending post
 * ===========================================================================
 */
router.post("/posts/:postId/cancel-delayed-publish", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id, post_status")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can cancel this post");
    return;
  }

  const { data: updated, error: updateErr } = await client
    .from("posts")
    .update({ post_status: "canceled" })
    .eq("id", postId)
    .eq("author_id", user.id)
    .select(POST_COLUMNS)
    .single();
  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  const sc = getServiceClient();
  if (sc) {
    await logDelayedEvent(sc, postId, user.id, "canceled");
    await invalidateCompassCache(sc, user.id, "delayed_post_cancel");
  }

  res.status(200).json(await withPostMediaOne(getServiceClient() ?? client, updated));
});

/* ===========================================================================
 * POST /posts/:postId/location-event  — generic mobile telemetry append
 * ===========================================================================
 */
router.post("/posts/:postId/location-event", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const { eventType, lat, lng, metadata } = req.body ?? {};
  const allowedEventTypes = ["created_pending","exit_detected","published","canceled","privacy_changed","publish_without_location","geotag_credit_awarded","credit_rate_limited","worker_skipped"] as const;
  if (!eventType || !allowedEventTypes.includes(eventType)) {
    sendError(res, "invalid_payload", "Invalid or missing eventType");
    return;
  }

  // Verify ownership — only the author can append location events
  const { data: existing } = await client
    .from("posts")
    .select("id, author_id")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can log events for this post");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  await logDelayedEvent(sc, postId, user.id, eventType, {
    lat: typeof lat === "number" ? lat : undefined,
    lng: typeof lng === "number" ? lng : undefined,
    metadata: metadata && typeof metadata === "object" ? metadata : undefined,
  });

  res.status(201).json({ ok: true });
});

/* ===========================================================================
 * PATCH /posts/:postId  — author-only edit
 * ===========================================================================
 */
router.patch("/posts/:postId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const postId = req.params.postId;
  const parsed = updatePostSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  // Load the existing row (service role) to check ownership + cross-field rules.
  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id, trip_id, visibility, content")
    .eq("id", postId)
    .maybeSingle();
  if (loadErr) {
    req.log.error({ err: loadErr }, "Failed to load post for update");
    sendError(res, "db_error", loadErr.message);
    return;
  }
  if (!existing) {
    sendError(res, "not_found", "Post not found");
    return;
  }
  if (existing.author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can edit this post");
    return;
  }

  // If changing visibility to trip_only, the post must have a trip.
  const nextVisibility = parsed.data.visibility ?? existing.visibility;
  if (nextVisibility === "trip_only" && !existing.trip_id) {
    sendError(res, "invalid_payload", "Cannot set trip_only on a standalone post");
    return;
  }

  const patch: Record<string, unknown> = { updated_by: user.id };
  if (parsed.data.content !== undefined) patch.content = parsed.data.content;
  if (parsed.data.mediaUrls !== undefined) patch.media_urls = parsed.data.mediaUrls;
  if (parsed.data.visibility !== undefined) patch.visibility = parsed.data.visibility;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  if (parsed.data.category !== undefined) patch.category = parsed.data.category ?? null;

  const { data, error } = await client
    .from("posts")
    .update(patch)
    .eq("id", postId)
    .eq("author_id", user.id) // belt-and-suspenders ownership guard
    .select(POST_COLUMNS)
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to update post");
    sendError(res, "db_error", error.message);
    return;
  }

  // Record edit history when caption/body content changes (non-fatal fire-and-forget)
  if (parsed.data.content !== undefined && (existing as any).content !== parsed.data.content) {
    const sc = getServiceClient();
    if (sc) {
      void sc.from("post_edits").insert({
        post_id: postId,
        user_id: user.id,
        old_content: (existing as any).content ?? null,
        new_content: parsed.data.content,
      });
    }
  }

  // Content translation: when caption changes, invalidate stale cache and
  // re-detect source language — fire-and-forget.
  if (parsed.data.content !== undefined && parsed.data.content !== (existing as any).content) {
    const scTx = getServiceClient();
    if (scTx) {
      invalidateContentTranslations(scTx, 'post', postId).catch(() => {});
      if (parsed.data.content.trim()) {
        detectAndStoreLanguage(scTx, 'post', postId, parsed.data.content, req.log).catch(() => {});
      }
    }
  }

  res.status(200).json(await withPostMediaOne(getServiceClient() ?? client, data));
});

/* ===========================================================================
 * DELETE /posts/:postId  — author-only soft delete
 * ===========================================================================
 * Soft delete (status=deleted, deleted_at=now) so feeds hide it but the row is
 * retained for moderation/audit. Author only.
 */
router.delete("/posts/:postId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const postId = req.params.postId;

  const { data: existing, error: loadErr } = await client
    .from("posts")
    .select("id, author_id")
    .eq("id", postId)
    .maybeSingle();
  if (loadErr) {
    sendError(res, "db_error", loadErr.message);
    return;
  }
  if (!existing) {
    sendError(res, "not_found", "Post not found");
    return;
  }
  if (existing.author_id !== user.id) {
    sendError(res, "forbidden", "Only the author can delete this post");
    return;
  }

  const { error } = await client
    .from("posts")
    .update({ status: "deleted", deleted_at: new Date().toISOString(), updated_by: user.id })
    .eq("id", postId)
    .eq("author_id", user.id);

  if (error) {
    req.log.error({ err: error }, "Failed to delete post");
    sendError(res, "db_error", error.message);
    return;
  }

  // Invalidate compass feed cache — await so stale content is never served after 204
  await invalidateCompassCache(getServiceClient(), user.id, "post_delete");

  res.status(204).send();
});

/* ============================================================================
 * POST /posts/:postId/like  — like a post (idempotent)
 * DELETE /posts/:postId/like — unlike a post (idempotent)
 * ============================================================================
 */
function isValidUuid(s: string) {
  return /^[0-9a-f-]{36}$/i.test(s);
}

/** Returns true if the caller may engage with a post; sends 403 and returns false otherwise. */
async function checkEngagePermission(
  res: any,
  post: { visibility: string; trip_id: string | null },
  userId: string,
  userClient: any,
): Promise<boolean> {
  if (post.visibility === "private") {
    sendError(res, "forbidden", "Cannot engage with a private post");
    return false;
  }
  if (post.visibility === "trip_only") {
    if (!post.trip_id || !(await isAcceptedTripMember(userClient, post.trip_id, userId))) {
      sendError(res, "forbidden", "Only accepted trip members can engage with this post");
      return false;
    }
  }
  return true;
}

// Compat wrapper — proxies to content_stamps until mobile clients are migrated.
// New code should use POST /stamps { entityType: 'post', entityId }.
router.post("/posts/:postId/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const { data: post, error: postErr } = await sc
    .from("posts")
    .select("id, author_id, visibility, trip_id")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (postErr || !post) { sendError(res, "not_found", "Post not found"); return; }

  // Bidirectional block check — matches /stamps access control.
  const authorId: string = (post as any).author_id;
  if (authorId !== user.id) {
    const { count: blockCount, error: blockErr } = await sc
      .from("blocks")
      .select("blocker_id", { count: "exact", head: true })
      .or(`and(blocker_id.eq.${user.id},blocked_id.eq.${authorId}),and(blocker_id.eq.${authorId},blocked_id.eq.${user.id})`);
    if (blockErr || (blockCount ?? 0) > 0) { sendError(res, "not_found", "Post not found"); return; }
  }

  const allowed = await checkEngagePermission(res, post as any, user.id, client);
  if (!allowed) return;

  const { stampCount } = await stampEntity(sc, user.id, "post", postId);
  void linkOutcomeSignal(sc, user.id, postId, "liked", "route:post_like");
  res.json({ likedByMe: true, likeCount: stampCount });
});

// Compat wrapper — proxies to content_stamps until mobile clients are migrated.
// New code should use DELETE /stamps/post/:entityId.
router.delete("/posts/:postId/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const { stampCount } = await unstampEntity(sc, user.id, "post", postId);
  res.json({ likedByMe: false, likeCount: stampCount });
});

/* ============================================================================
 * POST /posts/:postId/save   — save a post (idempotent, writes to post_saves)
 * DELETE /posts/:postId/save — unsave a post (idempotent)
 * ============================================================================
 */
router.post("/posts/:postId/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post, error: postErr } = await sc
    .from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (postErr) { sendError(res, "db_error", postErr.message); return; }
  if (!post) { sendError(res, "not_found", "Post not found"); return; }

  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { error: upsertErr } = await sc
    .from("post_saves")
    .upsert({ post_id: postId, user_id: user.id }, { onConflict: "post_id,user_id", ignoreDuplicates: true });
  if (upsertErr) { sendError(res, "db_error", upsertErr.message); return; }

  const { count } = await sc.from("post_saves").select("post_id", { count: "exact", head: true }).eq("post_id", postId);
  await sc.from("posts").update({ save_count: count ?? 0 }).eq("id", postId);

  res.status(200).json({ savedByMe: true, saveCount: count ?? 0 });
});

router.delete("/posts/:postId/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Allow unsave even if post is no longer accessible (idempotent removal)
  const { data: post } = await sc
    .from("posts").select("id, visibility, trip_id").eq("id", postId).maybeSingle();
  if (post && !(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { error: delErr } = await sc
    .from("post_saves").delete().eq("post_id", postId).eq("user_id", user.id);
  if (delErr) { sendError(res, "db_error", delErr.message); return; }

  const { count } = await sc.from("post_saves").select("post_id", { count: "exact", head: true }).eq("post_id", postId);
  await sc.from("posts").update({ save_count: count ?? 0 }).eq("id", postId);

  res.status(200).json({ savedByMe: false, saveCount: count ?? 0 });
});

/* ============================================================================
 * GET /posts/:postId/savers — owner-only list of users who saved this post.
 * Privacy-filtered: users with allow_profile_discovery = false are omitted.
 * ============================================================================
 */
router.get("/posts/:postId/savers", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify caller is the post author.
  const { data: post } = await sc
    .from("posts")
    .select("author_id")
    .eq("id", postId)
    .maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if ((post as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the post author can view savers");
    return;
  }

  const limit = Math.min(Number((req.query as any).limit ?? 50), 100);

  // Fetch savers, most-recent first, excluding the author themselves.
  const { data: saveRows, error: saveErr } = await sc
    .from("post_saves")
    .select("user_id, created_at")
    .eq("post_id", postId)
    .neq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit * 2); // over-fetch to absorb privacy filter
  if (saveErr) { sendError(res, "db_error", saveErr.message); return; }
  if (!saveRows || saveRows.length === 0) { res.json({ savers: [] }); return; }

  const saverIds = (saveRows as any[]).map((r) => r.user_id as string);

  // Parallel: profiles + privacy settings.
  const [profilesRes, privacyRes] = await Promise.all([
    sc.from("profiles").select("id, username, display_name, name, full_name, avatar_url, is_official").in("id", saverIds),
    sc.from("profile_privacy_settings").select("user_id, allow_profile_discovery, show_real_name").in("user_id", saverIds),
  ]);

  // Fail-closed: an UNREAD privacy table is not "everybody allows discovery".
  // `privacyRes.error` resolves (PostgREST does not throw), so an unchecked read
  // yielded an empty map and `!== false` then listed every opted-out saver.
  if (privacyRes.error) {
    req.log.error({ err: privacyRes.error }, "posts/:postId/savers: discovery-privacy lookup failed");
    sendError(res, "degraded_unavailable", "Privacy settings could not be read");
    return;
  }
  const profileMap = new Map(((profilesRes.data ?? []) as any[]).map((p) => [p.id as string, p]));
  // No row in profile_privacy_settings means allow_profile_discovery defaults to true.
  const privacyMap = new Map(((privacyRes.data ?? []) as any[]).map((p) => [p.user_id as string, p.allow_profile_discovery as boolean]));
  // Universal display-name rule: real names are OPT-IN (show_real_name defaults
  // to false), so a saver with no privacy row — or a failed lookup — shows
  // @handle only.
  const showNameSet = new Set(
    ((privacyRes.data ?? []) as any[])
      .filter((p) => p.show_real_name === true)
      .map((p) => p.user_id as string),
  );

  const savers = (saveRows as any[])
    .filter((r) => privacyMap.get(r.user_id as string) !== false)
    .slice(0, limit)
    .map((r) => {
      const p = profileMap.get(r.user_id as string);
      return {
        userId: r.user_id,
        handle: (p as any)?.username ?? null,
        name: presentedName(p as any, showNameSet.has(r.user_id as string)),
        avatarUrl: (p as any)?.avatar_url ?? null,
        isOfficial: (p as any)?.is_official ?? false,
        savedAt: r.created_at,
      };
    })
    .filter((s) => s.handle !== null);

  res.json({ savers });
});

/* ============================================================================
 * POST /posts/:postId/hide  — hide a post from the caller's feeds (idempotent)
 * ============================================================================
 */
router.post("/posts/:postId/hide", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Upsert to be idempotent — hiding the same post twice is fine
  const { error } = await sc
    .from("post_hides")
    .upsert({ user_id: user.id, post_id: postId }, { onConflict: "user_id,post_id", ignoreDuplicates: true });
  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(200).json({ hidden: true });
});

/* ============================================================================
 * GET /posts/:postId/comments  — list visible comments
 * POST /posts/:postId/comments — add a comment
 * DELETE /posts/:postId/comments/:commentId — soft-delete own comment
 * ============================================================================
 */
router.get("/posts/:postId/comments", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Verify post exists and caller has read access
  const { data: post } = await sc.from("posts").select("id, author_id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;
  const isPostAuthor = (post as any).author_id === user.id;

  const { data: rows, error: listErr } = await sc
    .from("posts_comments")
    .select("id, post_id, user_id, body, created_at, updated_at, original_language")
    .eq("post_id", postId)
    .is("parent_comment_id", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (listErr) { sendError(res, "db_error", listErr.message); return; }

  const commentRows: any[] = rows ?? [];
  const authorIds = [...new Set(commentRows.map((c) => c.user_id))];
  let profileMap: Record<string, any> = {};
  if (authorIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select("id, handle, name, avatar_url, verified").in("id", authorIds);
    for (const p of profiles ?? []) profileMap[p.id] = p;
  }

  const commentIds = commentRows.map((c) => c.id as string);

  const [commentSpansMap, commentLikeRows] = await Promise.all([
    enrichSpans(
      sc, 'comment',
      commentRows.map((c) => ({ id: c.id as string, content: (c.body ?? '') as string })),
      user.id,
    ),
    commentIds.length > 0
      ? sc.from("comment_likes").select("comment_id, user_id").in("comment_id", commentIds).then((r: any) => r.data ?? [])
      : Promise.resolve([]),
  ]);

  const likeCountMap: Record<string, number> = {};
  const likedByMeSet = new Set<string>();
  for (const row of commentLikeRows as any[]) {
    likeCountMap[row.comment_id] = (likeCountMap[row.comment_id] ?? 0) + 1;
    if (row.user_id === user.id) likedByMeSet.add(row.comment_id);
  }

  const comments = commentRows.map((c) => {
    const pr    = profileMap[c.user_id];
    const spans = commentSpansMap[c.id] ?? { tags: [], hashtagUsages: [] };
    return {
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      updatedAt: c.updated_at ?? null,
      canDelete: c.user_id === user.id || isPostAuthor,
      likeCount: likeCountMap[c.id] ?? 0,
      likedByMe: likedByMeSet.has(c.id),
      originalLanguage: (c.original_language as string | null) ?? null,
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
      author: pr
        ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null, verified: (pr.verified as boolean) ?? false }
        : { id: c.user_id, handle: "traveler", name: "Traveler", avatarUrl: null, verified: false },
    };
  });

  res.status(200).json({ ok: true, comments });
});

router.post("/posts/:postId/comments", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const rl = checkRateLimit("comment", user.id, 30, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many comments — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const body = String(req.body?.body ?? "").trim();
  if (!body) { sendError(res, "invalid_payload", "Comment body is required"); return; }
  if (body.length > 1000) { sendError(res, "invalid_payload", "Comment must be 1000 characters or fewer"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, author_id, visibility, trip_id, comments_setting, sharing_disabled").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  // Enforce comments_setting (fail-open if column not yet migrated)
  const commentsSetting = (post as any).comments_setting ?? "everyone";
  const callerId = user.id;
  const authorId = (post as any).author_id as string;

  // Block check: fail-closed count query (avoids maybeSingle multi-row error)
  if (callerId !== authorId) {
    const { count: blockCount, error: blockErr } = await sc.from("blocks")
      .select("id", { count: "exact", head: true })
      .or(`and(blocker_id.eq.${callerId},blocked_id.eq.${authorId}),and(blocker_id.eq.${authorId},blocked_id.eq.${callerId})`);
    if (blockErr || (blockCount ?? 0) > 0) { sendError(res, "blocked_user", "Cannot comment on this post"); return; }
  }

  // Post owner can always comment on their own post
  if (callerId !== authorId && commentsSetting !== "everyone") {
    if (commentsSetting === "disabled") {
      sendError(res, "comments_disabled", "Comments are disabled on this post");
      return;
    }
    if (commentsSetting === "friends") {
      const { data: fr } = await sc
        .from("friend_requests").select("id").eq("status", "accepted")
        .or(`and(requester_id.eq.${callerId},recipient_id.eq.${authorId}),and(requester_id.eq.${authorId},recipient_id.eq.${callerId})`)
        .maybeSingle();
      if (!fr) { sendError(res, "comments_limited", "Only friends can comment on this post"); return; }
    }
    if (commentsSetting === "circle") {
      const { data: mem } = await sc
        .from("circle_memberships").select("other_id").eq("user_id", authorId).eq("other_id", callerId).maybeSingle();
      if (!mem) { sendError(res, "comments_limited", "Only circle members can comment on this post"); return; }
    }
    if (commentsSetting === "trip_crew") {
      const tripId = (post as any).trip_id as string | null;
      if (!tripId || !(await isAcceptedTripMember(client, tripId, callerId))) {
        sendError(res, "comments_limited", "Only trip crew can comment on this post");
        return;
      }
    }
    if (commentsSetting === "verified") {
      const { data: profile } = await sc.from("profiles").select("verified").eq("id", callerId).maybeSingle();
      if (!(profile as any)?.verified) { sendError(res, "comments_limited", "Only verified accounts can comment on this post"); return; }
    }
  }

  const { data: comment, error: insertErr } = await sc
    .from("posts_comments")
    .insert({ post_id: postId, user_id: user.id, body })
    .select("id, post_id, user_id, body, created_at, updated_at")
    .single();
  if (insertErr) { sendError(res, "db_error", insertErr.message); return; }

  // Accurate count + sync
  const { count } = await sc.from("posts_comments").select("id", { count: "exact", head: true })
    .eq("post_id", postId).is("deleted_at", null);
  await sc.from("posts").update({ comment_count: count ?? 0 }).eq("id", postId);

  // Fetch author profile for response
  const { data: profile } = await sc.from("profiles").select("id, handle, name, avatar_url").eq("id", user.id).single();

  // Write-time tagging for comments: enforce permissions, write rows, dispatch notifications.
  {
    const sc = getServiceClient();
    if (sc && body.trim().length > 0) {
      try {
        const taggedIds = await processTagging({
          db: sc,
          authorId: user.id,
          sourceType: 'comment',
          sourceId: (comment as any).id,
          content: body,
          logger: req.log,
        });
        if (taggedIds.length > 0) {
          const { data: taggerProfile } = await sc.from('profiles').select('handle').eq('id', user.id).single();
          const taggerHandle = (taggerProfile as any)?.handle ?? 'someone';
          const notifSvc    = new NotificationService(sc);
          const notifRouter  = new NotificationRouter(sc);
          await Promise.allSettled(
            taggedIds.map(async (taggedId) => {
              const row = await notifSvc.create({
                userId: taggedId,
                eventType: 'pulse.user_tagged',
                actorId: user.id,
                sourceType: 'comment',
                sourceId: (comment as any).id,
                params: { taggerHandle, context: `@${taggerHandle} mentioned you in a comment.` },
              });
              if (row) await notifRouter.route(row);
            }),
          );
        }
      } catch (err) {
        req.log.warn({ err }, 'comment tagging side-effect failed (non-fatal)');
      }
    }
  }

  res.status(201).json({
    ok: true,
    comment: {
      id: (comment as any).id,
      body: (comment as any).body,
      createdAt: (comment as any).created_at,
      updatedAt: null,
      canDelete: true,
      author: profile
        ? { id: profile.id, handle: profile.handle, name: profile.name, avatarUrl: profile.avatar_url ?? null }
        : { id: user.id, handle: "traveler", name: "Traveler", avatarUrl: null },
    },
    commentCount: count ?? 0,
  });

  // Language detection for comment — fire-and-forget.
  if (body.trim()) {
    const _sc = getServiceClient();
    if (_sc) {
      detectAndStoreLanguage(_sc, 'comment', (comment as any).id, body, req.log).catch(() => {});
    }
  }
});

router.patch("/posts/:postId/comments/:commentId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId) || !isValidUuid(commentId)) {
    sendError(res, "invalid_payload", "Invalid id"); return;
  }

  const body = String(req.body?.body ?? "").trim();
  if (!body) { sendError(res, "invalid_payload", "Comment body is required"); return; }
  if (body.length > 1000) { sendError(res, "invalid_payload", "Comment must be 1000 characters or fewer"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Author-only: fetch the comment and verify ownership.
  const { data: existing } = await sc
    .from("posts_comments").select("id, user_id, body")
    .eq("id", commentId).eq("post_id", postId).is("deleted_at", null).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Comment not found"); return; }
  if ((existing as any).user_id !== user.id) {
    sendError(res, "forbidden", "Cannot edit someone else's comment"); return;
  }

  const { data: updated, error: updateErr } = await sc
    .from("posts_comments")
    .update({ body, updated_at: new Date().toISOString() })
    .eq("id", commentId)
    .select("id, post_id, user_id, body, created_at, updated_at")
    .single();
  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  res.status(200).json({ ok: true, comment: updated });

  // Invalidate stale translation cache and re-detect language — fire-and-forget.
  void invalidateContentTranslations(sc, 'comment', commentId);
  if (body.trim()) {
    detectAndStoreLanguage(sc, 'comment', commentId, body, req.log).catch(() => {});
  }
});

router.delete("/posts/:postId/comments/:commentId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId) || !isValidUuid(commentId)) {
    sendError(res, "invalid_payload", "Invalid id"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("posts_comments").select("id, user_id")
    .eq("id", commentId).eq("post_id", postId).is("deleted_at", null).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Comment not found"); return; }

  // Allow: comment author OR post owner
  if ((existing as any).user_id !== user.id) {
    const { data: postRow } = await sc.from("posts").select("author_id").eq("id", postId).maybeSingle();
    if (!postRow || (postRow as any).author_id !== user.id) {
      sendError(res, "forbidden", "Cannot delete someone else's comment"); return;
    }
  }

  await sc.from("posts_comments").update({ deleted_at: new Date().toISOString() }).eq("id", commentId);

  const { count } = await sc.from("posts_comments").select("id", { count: "exact", head: true })
    .eq("post_id", postId).is("deleted_at", null);
  await sc.from("posts").update({ comment_count: count ?? 0 }).eq("id", postId);

  res.status(200).json({ ok: true, commentCount: count ?? 0 });
});

/* ============================================================================
 * GET  /posts/:postId/reactions  — list emoji reactions + caller's reaction
 * POST /posts/:postId/reactions  — upsert emoji reaction (idempotent)
 * DELETE /posts/:postId/reactions — remove caller's reaction
 * ============================================================================
 */
const VALID_REACTION_EMOJIS = new Set(["❤️", "😂", "😮", "😢", "😡", "👍", "🔥", "✈️"]);

router.get("/posts/:postId/reactions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: rows, error } = await sc
    .from("post_reactions").select("emoji, user_id").eq("post_id", postId);

  if (error) {
    req.log.error({ err: error }, "reactions fetch failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const counts: Record<string, number> = {};
  let myReaction: string | null = null;
  for (const r of (rows ?? []) as any[]) {
    counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
    if (r.user_id === user.id) myReaction = r.emoji;
  }

  res.status(200).json({
    reactions: Object.entries(counts).map(([emoji, count]) => ({ emoji, count })),
    myReaction,
    total: (rows ?? []).length,
  });
});

router.post("/posts/:postId/reactions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const rl = checkRateLimit("reaction", user.id, 60, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many reactions — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const emoji = String(req.body?.emoji ?? "").trim();
  if (!emoji || !VALID_REACTION_EMOJIS.has(emoji)) {
    sendError(res, "invalid_payload", "Invalid or unsupported emoji");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc
    .from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { error } = await sc
    .from("post_reactions")
    .upsert({ post_id: postId, user_id: user.id, emoji }, { onConflict: "post_id,user_id" });

  if (error) {
    req.log.error({ err: error }, "reaction upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const { data: rows } = await sc.from("post_reactions").select("emoji, user_id").eq("post_id", postId);
  const counts: Record<string, number> = {};
  for (const r of (rows ?? []) as any[]) counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;

  res.status(200).json({
    ok: true,
    myReaction: emoji,
    reactions: Object.entries(counts).map(([e, c]) => ({ emoji: e, count: c })),
  });
});

router.delete("/posts/:postId/reactions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  await sc.from("post_reactions").delete().eq("post_id", postId).eq("user_id", user.id);

  const { data: rows } = await sc.from("post_reactions").select("emoji, user_id").eq("post_id", postId);
  const counts: Record<string, number> = {};
  for (const r of (rows ?? []) as any[]) counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;

  res.status(200).json({
    ok: true,
    myReaction: null,
    reactions: Object.entries(counts).map(([e, c]) => ({ emoji: e, count: c })),
  });
});

/* ============================================================================
 * PATCH /posts/:postId/settings  — owner controls
 * ============================================================================
 */
const postSettingsSchema = z.object({
  commentsSetting: z.enum(["everyone", "friends", "circle", "trip_crew", "verified", "disabled"]).optional(),
  likesHidden: z.boolean().optional(),
  sharingDisabled: z.boolean().optional(),
  repostingDisabled: z.boolean().optional(),
});

router.patch("/posts/:postId/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const parsed = postSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }
  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "At least one setting must be provided");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("posts").select("id, author_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the post owner can change settings"); return;
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.commentsSetting !== undefined) patch.comments_setting = parsed.data.commentsSetting;
  if (parsed.data.likesHidden !== undefined) patch.likes_hidden = parsed.data.likesHidden;
  if (parsed.data.sharingDisabled !== undefined) patch.sharing_disabled = parsed.data.sharingDisabled;
  if (parsed.data.repostingDisabled !== undefined) patch.reposting_disabled = parsed.data.repostingDisabled;

  const { error } = await sc.from("posts").update(patch).eq("id", postId);
  if (error) {
    req.log.error({ err: error }, "post settings update failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ ok: true, ...parsed.data });
});

/* ============================================================================
 * POST /posts/:postId/archive  — soft-archive (owner only)
 * ============================================================================
 */
router.post("/posts/:postId/archive", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("posts").select("id, author_id").eq("id", postId).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Post not found"); return; }
  if ((existing as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the post owner can archive this post"); return;
  }

  const { error } = await sc.from("posts")
    .update({ status: "hidden", updated_by: user.id }).eq("id", postId);
  if (error) {
    req.log.error({ err: error }, "post archive failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ ok: true, archived: true });
});

/* ============================================================================
 * POST /posts/:postId/share  — record a share action; enforces sharing_disabled
 * ============================================================================
 */
const VALID_SHARE_TARGETS = new Set(["dm", "group_chat", "trip_crew", "circle", "external", "copy_link"]);

router.post("/posts/:postId/share", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const target = String(req.body?.target ?? "").trim();
  if (!VALID_SHARE_TARGETS.has(target)) {
    sendError(res, "invalid_payload", "Invalid share target"); return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc
    .from("posts").select("id, author_id, visibility, trip_id, sharing_disabled").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }

  if ((post as any).sharing_disabled === true && user.id !== (post as any).author_id) {
    sendError(res, "sharing_disabled", "Sharing is disabled for this post"); return;
  }

  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const rl = checkRateLimit("share", user.id, 10, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many share actions — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const { error: shareErr } = await sc
    .from("post_shares")
    .upsert({ post_id: postId, user_id: user.id, target }, { onConflict: "post_id,user_id,target", ignoreDuplicates: true });
  if (shareErr) {
    req.log.error({ err: shareErr }, "post share record failed");
    sendError(res, "db_error", shareErr.message);
    return;
  }

  res.status(200).json({ ok: true, target });
});

/* ============================================================================
 * POST /posts/:postId/comments/:commentId/like  — like a comment (idempotent)
 * DELETE /posts/:postId/comments/:commentId/like — unlike a comment
 * ============================================================================
 */
router.post("/posts/:postId/comments/:commentId/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  if (!isValidUuid(commentId)) { sendError(res, "invalid_payload", "Invalid comment id"); return; }

  const rl = checkRateLimit("comment_like", user.id, 60, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many likes — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: comment } = await sc
    .from("posts_comments").select("id, post_id").eq("id", commentId).is("deleted_at", null).maybeSingle();
  if (!comment) { sendError(res, "not_found", "Comment not found"); return; }
  if ((comment as any).post_id !== postId) { sendError(res, "not_found", "Comment not found"); return; }

  const { error } = await sc
    .from("comment_likes")
    .upsert({ comment_id: commentId, user_id: user.id }, { onConflict: "comment_id,user_id", ignoreDuplicates: true });

  if (error) {
    req.log.error({ err: error }, "comment like failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const { count } = await sc
    .from("comment_likes").select("id", { count: "exact", head: true }).eq("comment_id", commentId);

  res.status(200).json({ ok: true, likedByMe: true, likeCount: count ?? 0 });
});

router.delete("/posts/:postId/comments/:commentId/like", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  if (!isValidUuid(commentId)) { sendError(res, "invalid_payload", "Invalid comment id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: comment } = await sc
    .from("posts_comments").select("id, post_id").eq("id", commentId).is("deleted_at", null).maybeSingle();
  if (!comment) { sendError(res, "not_found", "Comment not found"); return; }
  if ((comment as any).post_id !== postId) { sendError(res, "not_found", "Comment not found"); return; }

  await sc.from("comment_likes").delete().eq("comment_id", commentId).eq("user_id", user.id);

  const { count } = await sc
    .from("comment_likes").select("id", { count: "exact", head: true }).eq("comment_id", commentId);

  res.status(200).json({ ok: true, likedByMe: false, likeCount: count ?? 0 });
});

/* ============================================================================
 * GET /posts/:postId/edit-history — owner-only list of past content edits
 * ============================================================================
 */
router.get("/posts/:postId/edit-history", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { postId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, author_id").eq("id", postId).maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if ((post as any).author_id !== user.id) {
    sendError(res, "forbidden", "Only the post author can view edit history");
    return;
  }

  const { data: edits, error } = await sc
    .from("post_edits")
    .select("id, old_content, new_content, edited_at")
    .eq("post_id", postId)
    .order("edited_at", { ascending: false });

  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(200).json({
    ok: true,
    edits: (edits ?? []).map((e: any) => ({
      id: e.id,
      oldContent: e.old_content ?? null,
      newContent: e.new_content ?? null,
      editedAt: e.edited_at,
    })),
  });
});

/* ============================================================================
 * GET  /posts/:postId/comments/:commentId/replies — list one-level replies
 * POST /posts/:postId/comments/:commentId/replies — add a reply
 * ============================================================================
 */
router.get("/posts/:postId/comments/:commentId/replies", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  if (!isValidUuid(commentId)) { sendError(res, "invalid_payload", "Invalid comment id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, author_id, visibility, trip_id").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  const { data: parent } = await sc.from("posts_comments").select("id, post_id").eq("id", commentId).is("deleted_at", null).maybeSingle();
  if (!parent || (parent as any).post_id !== postId) { sendError(res, "not_found", "Comment not found"); return; }

  const isPostAuthor = (post as any).author_id === user.id;

  const { data: rows, error } = await sc
    .from("posts_comments")
    .select("id, post_id, user_id, body, created_at, updated_at, parent_comment_id")
    .eq("parent_comment_id", commentId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) { sendError(res, "db_error", error.message); return; }

  const replyRows: any[] = rows ?? [];
  const authorIds = [...new Set(replyRows.map((r) => r.user_id))];
  let profileMap: Record<string, any> = {};
  if (authorIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select("id, handle, name, avatar_url, verified").in("id", authorIds);
    for (const p of profiles ?? []) profileMap[p.id] = p;
  }

  const replyIds = replyRows.map((r) => r.id as string);
  const [replySpansMap, likeRows] = await Promise.all([
    enrichSpans(
      sc, 'comment',
      replyRows.map((r) => ({ id: r.id as string, content: (r.body ?? '') as string })),
      user.id,
    ),
    replyIds.length > 0
      ? sc.from("comment_likes").select("comment_id, user_id").in("comment_id", replyIds).then((r: any) => r.data ?? [])
      : Promise.resolve([]),
  ]);

  const likeCountMap: Record<string, number> = {};
  const likedByMeSet = new Set<string>();
  for (const row of likeRows as any[]) {
    likeCountMap[row.comment_id] = (likeCountMap[row.comment_id] ?? 0) + 1;
    if (row.user_id === user.id) likedByMeSet.add(row.comment_id);
  }

  const replies = replyRows.map((r) => {
    const pr    = profileMap[r.user_id];
    const spans = replySpansMap[r.id] ?? { tags: [], hashtagUsages: [] };
    return {
      id: r.id,
      body: r.body,
      parentCommentId: r.parent_comment_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at ?? null,
      canDelete: r.user_id === user.id || isPostAuthor,
      likeCount: likeCountMap[r.id] ?? 0,
      likedByMe: likedByMeSet.has(r.id),
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
      author: pr
        ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null, verified: (pr.verified as boolean) ?? false }
        : { id: r.user_id, handle: "traveler", name: "Traveler", avatarUrl: null, verified: false },
    };
  });

  res.status(200).json({ ok: true, replies });
});

router.post("/posts/:postId/comments/:commentId/replies", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const { postId, commentId } = req.params;
  if (!isValidUuid(postId)) { sendError(res, "invalid_payload", "Invalid post id"); return; }
  if (!isValidUuid(commentId)) { sendError(res, "invalid_payload", "Invalid comment id"); return; }

  const rl = checkRateLimit("comment", user.id, 30, 60_000);
  if (!rl.allowed) {
    sendError(res, "rate_limited", `Too many comments — retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`);
    return;
  }

  const body = String(req.body?.body ?? "").trim();
  if (!body) { sendError(res, "invalid_payload", "Reply body is required"); return; }
  if (body.length > 1000) { sendError(res, "invalid_payload", "Reply must be 1000 characters or fewer"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post } = await sc.from("posts").select("id, author_id, visibility, trip_id, comments_setting").eq("id", postId).eq("status", "active").maybeSingle();
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if (!(await checkEngagePermission(res, post as any, user.id, client))) return;

  // Verify parent comment belongs to the post and is a root comment (one-level depth guard)
  const { data: parent } = await sc.from("posts_comments").select("id, post_id, parent_comment_id").eq("id", commentId).is("deleted_at", null).maybeSingle();
  if (!parent || (parent as any).post_id !== postId) { sendError(res, "not_found", "Comment not found"); return; }
  if ((parent as any).parent_comment_id !== null) { sendError(res, "invalid_payload", "Cannot reply to a reply — only one level of nesting is supported"); return; }

  // Enforce comments_setting (same rules as top-level comments)
  const commentsSetting = (post as any).comments_setting ?? "everyone";
  const callerId = user.id;
  const authorId = (post as any).author_id as string;

  // Block check: fail-closed count query (avoids maybeSingle multi-row error)
  if (callerId !== authorId) {
    const { count: blockCount, error: blockErr } = await sc.from("blocks")
      .select("id", { count: "exact", head: true })
      .or(`and(blocker_id.eq.${callerId},blocked_id.eq.${authorId}),and(blocker_id.eq.${authorId},blocked_id.eq.${callerId})`);
    if (blockErr || (blockCount ?? 0) > 0) { sendError(res, "blocked_user", "Cannot comment on this post"); return; }
  }

  if (callerId !== authorId && commentsSetting !== "everyone") {
    if (commentsSetting === "disabled") { sendError(res, "comments_disabled", "Comments are disabled on this post"); return; }
    if (commentsSetting === "friends") {
      const { data: fr } = await sc.from("friend_requests").select("id").eq("status", "accepted")
        .or(`and(requester_id.eq.${callerId},recipient_id.eq.${authorId}),and(requester_id.eq.${authorId},recipient_id.eq.${callerId})`)
        .maybeSingle();
      if (!fr) { sendError(res, "comments_limited", "Only friends can comment on this post"); return; }
    }
    if (commentsSetting === "circle") {
      const { data: mem } = await sc.from("circle_memberships").select("other_id").eq("user_id", authorId).eq("other_id", callerId).maybeSingle();
      if (!mem) { sendError(res, "comments_limited", "Only circle members can comment on this post"); return; }
    }
    if (commentsSetting === "trip_crew") {
      const tripId = (post as any).trip_id as string | null;
      if (!tripId || !(await isAcceptedTripMember(client, tripId, callerId))) { sendError(res, "comments_limited", "Only trip crew can comment on this post"); return; }
    }
    if (commentsSetting === "verified") {
      const { data: profile } = await sc.from("profiles").select("verified").eq("id", callerId).maybeSingle();
      if (!(profile as any)?.verified) { sendError(res, "comments_limited", "Only verified accounts can comment on this post"); return; }
    }
  }

  const { data: reply, error: insertErr } = await sc
    .from("posts_comments")
    .insert({ post_id: postId, user_id: user.id, body, parent_comment_id: commentId })
    .select("id, post_id, user_id, body, created_at, updated_at, parent_comment_id")
    .single();
  if (insertErr) { sendError(res, "db_error", insertErr.message); return; }

  const { data: profile } = await sc.from("profiles").select("id, handle, name, avatar_url").eq("id", user.id).single();

  // Write-time tagging for replies — same as top-level comments
  {
    const scTagging = getServiceClient();
    const replyBody = (reply as any).body as string;
    if (scTagging && replyBody.trim().length > 0) {
      try {
        const taggedIds = await processTagging({
          db: scTagging,
          authorId: user.id,
          sourceType: 'comment',
          sourceId: (reply as any).id,
          content: replyBody,
          logger: req.log,
        });
        if (taggedIds.length > 0) {
          const { data: taggerProfile } = await scTagging.from('profiles').select('handle').eq('id', user.id).single();
          const taggerHandle = (taggerProfile as any)?.handle ?? 'someone';
          const notifSvc   = new NotificationService(scTagging);
          const notifRouter = new NotificationRouter(scTagging);
          await Promise.allSettled(
            taggedIds.map(async (taggedId) => {
              const row = await notifSvc.create({
                userId: taggedId,
                eventType: 'pulse.user_tagged',
                actorId: user.id,
                sourceType: 'comment',
                sourceId: (reply as any).id,
                params: { taggerHandle, context: `@${taggerHandle} mentioned you in a reply.` },
              });
              if (row) await notifRouter.route(row);
            }),
          );
        }
      } catch (err) {
        req.log.warn({ err }, 'reply tagging side-effect failed (non-fatal)');
      }
    }
  }

  // Build enriched spans for response (so the client sees real tags/hashtagUsages immediately)
  const replySpans = await enrichSpans(
    sc, 'comment',
    [{ id: (reply as any).id, content: (reply as any).body }],
    user.id,
  ).catch(() => ({} as Record<string, any>));
  const spans = replySpans[(reply as any).id] ?? { tags: [], hashtagUsages: [] };

  // Language detection for reply body — fire-and-forget.
  const replyBodyTrimmed = (reply as any).body as string;
  if (replyBodyTrimmed.trim()) {
    detectAndStoreLanguage(sc, 'comment', (reply as any).id, replyBodyTrimmed, req.log).catch(() => {});
  }

  res.status(201).json({
    ok: true,
    reply: {
      id: (reply as any).id,
      body: (reply as any).body,
      parentCommentId: (reply as any).parent_comment_id,
      createdAt: (reply as any).created_at,
      updatedAt: null,
      canDelete: true,
      likeCount: 0,
      likedByMe: false,
      tags: spans.tags,
      hashtagUsages: spans.hashtagUsages,
      author: profile
        ? { id: profile.id, handle: profile.handle, name: profile.name, avatarUrl: profile.avatar_url ?? null }
        : { id: user.id, handle: "traveler", name: "Traveler", avatarUrl: null },
    },
  });
});

/* ===========================================================================
 * POST /posts/:id/wrong-place  — report a bad canonical place attachment
 * ===========================================================================
 * Any authenticated user (except the post author) can report that the
 * canonical place attached to a post is incorrect.  One pending report per
 * (post, reporter) is enforced by the unique index in the migration.
 */
router.post("/posts/:id/wrong-place", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const postId = req.params["id"];
  if (!postId) {
    sendError(res, "invalid_payload", "Post ID is required");
    return;
  }

  const reasonSchema = z.object({
    reason: z.string().max(500).optional(),
  });
  const parsed = reasonSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { reason } = parsed.data;

  // Verify post exists and has a canonical place set
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: post, error: postErr } = await sc
    .from("posts")
    .select("id, author_id, canonical_place_id")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();

  if (postErr || !post) {
    sendError(res, "not_found", "Post not found");
    return;
  }

  // Authors cannot report their own posts
  if ((post as any).author_id === user.id) {
    res.status(403).json({ error: "forbidden", message: "You cannot report your own post" });
    return;
  }

  const { error: insertErr } = await sc
    .from("place_mismatch_reports")
    .insert({
      post_id:           postId,
      reporter_id:       user.id,
      reported_place_id: (post as any).canonical_place_id ?? null,
      reason:            reason ?? null,
      status:            "pending",
    });

  if (insertErr) {
    // Unique constraint violation → already reported
    if (insertErr.code === "23505") {
      res.status(409).json({ error: "already_reported", message: "You have already reported this place" });
      return;
    }
    postsLogger.error({ err: insertErr, postId }, "place_mismatch_reports insert failed");
    sendError(res, "db_error", insertErr.message);
    return;
  }

  res.status(201).json({ ok: true });
});

export default router;
