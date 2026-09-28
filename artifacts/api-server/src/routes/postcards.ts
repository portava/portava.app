/**
 * Postcards routes — structured media upload flow for Postcards.
 *
 * POST   /api/postcards                              — create a postcard draft post
 * POST   /api/postcards/:id/media/upload-url         — get a signed upload URL for one media item
 * POST   /api/postcards/:id/media/:mediaId/complete  — mark upload done, store metadata, update counts
 * DELETE /api/postcards/:id/media/:mediaId           — owner-only removal
 *
 * Design notes:
 *  - Photos and videos share the same post_media table; no parallel "video" system.
 *  - passport_postcard is created lazily on first ready media (add_to_passport=true).
 *  - Server-side MIME + size validation is the authoritative gate; storage bucket policy
 *    is defence-in-depth only.
 *  - TODO: wire a video transcoding / compression pipeline after upload completion.
 *  - TODO: server-side thumbnail generation (currently the client uploads a thumbnail frame).
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireUser, sendError, safeSecretEquals, tripExists, isAcceptedTripMember } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { processTagging } from '../services/tagging/TaggingService.js';
import { isKillSwitchEngaged } from '../lib/featureFlags.js';
import { processImage, computePHash, makeFeedVariant } from '../lib/mediaProcessing.js';
import { stripVideoLocationMetadata } from '../lib/videoMetadata.js';
import {
  guardUploadRequest,
  validateDeclaredUpload,
  verifyUploadedBytes,
  MEDIA_SIZE_LIMITS,
} from '../lib/mediaPipeline.js';
import { recordEntityMedia, MEDIA_SOURCE_UNDECLARED } from '../lib/mediaAssets.js'; import { recordPostcardCreatedSignal } from '../lib/mediaAnalytics.js';

const router = Router();

const STORAGE_BUCKET = 'post-media';
const MAX_MEDIA_PER_POSTCARD = 10;
// Size ceilings and the MIME allowlist now live in lib/mediaPipeline.ts, shared
// with POST /api/media/upload. They diverged while they were local: this path
// allowed 20 MB images against the other path's 15 MB, for the same photo from
// the same picker.


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/* ============================================================================
 * Stamp overlay (migration 0129) — optional, non-destructive stamp on a photo
 * ============================================================================
 * The client sends placement + a stamp_definitions id; the server validates
 * eligibility and PINS the artwork reference at publish time so later catalog
 * artwork updates never change historical posts. The original media file is
 * never modified — the overlay is pure metadata rendered client-side.
 *
 * Eligibility (never awards a stamp, never bypasses earning):
 *   - the caller has earned the stamp (user_stamps row, not revoked), OR
 *   - the stamp definition matches the post's location (city/country).
 * Only definitions with approved + active universal artwork qualify
 * (is_active = true AND universal_artwork_url IS NOT NULL).
 */
const STAMP_OVERLAY_STYLES = ['original', 'white', 'dark', 'watermark'] as const;

const stampOverlaySchema = z.object({
  stampDefinitionId: z.string().uuid(),
  style:    z.enum(STAMP_OVERLAY_STYLES).optional().default('white'),
  /** Normalized center within the displayed media frame (cover rect), 0..1. */
  x:        z.number().min(0).max(1),
  y:        z.number().min(0).max(1),
  /** Stamp diameter as a fraction of the media display width. */
  scale:    z.number().min(0.12).max(0.5),
  rotation: z.number().min(-45).max(45).optional().default(0),
  opacity:  z.number().min(0.05).max(1).optional(),
});

type StampOverlayInput = z.infer<typeof stampOverlaySchema>;

function normLoc(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** Case-insensitive location match between a stamp definition and a post.
 *  City-level defs require a city match (plus country agreement when both
 *  sides carry one — guards "Paris, Texas" vs "Paris, France"); country-level
 *  defs (no city) match on country alone. */
function stampDefMatchesLocation(
  def: { city?: string | null; country?: string | null },
  city?: string | null,
  country?: string | null,
): boolean {
  const defCity = normLoc(def.city);
  const defCountry = normLoc(def.country);
  const postCity = normLoc(city);
  const postCountry = normLoc(country);
  if (defCity) {
    if (!postCity || defCity !== postCity) return false;
    if (defCountry && postCountry && defCountry !== postCountry) return false;
    return true;
  }
  if (defCountry) return postCountry === defCountry;
  return false;
}

const roundTo = (n: number, p = 4) => Math.round(n * 10 ** p) / 10 ** p;

/**
 * Resolve + validate a requested stamp overlay. Returns the server-built
 * overlay JSON (with pinned artwork) or an error code. Failures NEVER block
 * the upload — the caller completes without the overlay and surfaces a flag.
 */
async function resolveStampOverlay(
  sc: any,
  userId: string,
  postId: string,
  input: StampOverlayInput,
): Promise<{ overlay: Record<string, unknown> | null; errorCode: string | null }> {
  let def: any = null;
  try {
    const { data, error } = await sc
      .from('stamp_definitions')
      .select('id, name, city, country, rarity, is_active, universal_artwork_url')
      .eq('id', input.stampDefinitionId)
      .maybeSingle();
    if (error) return { overlay: null, errorCode: 'stamp_unavailable' };
    def = data;
  } catch {
    return { overlay: null, errorCode: 'stamp_unavailable' };
  }

  // Only approved + active universal artwork may be overlaid.
  if (!def || def.is_active !== true || !def.universal_artwork_url) {
    return { overlay: null, errorCode: 'stamp_unavailable' };
  }

  // Eligibility: earned (not revoked) OR location-matching definition.
  let eligible = false;
  try {
    const { data: earnedRows } = await sc
      .from('user_stamps')
      .select('id')
      .eq('user_id', userId)
      .eq('stamp_definition_id', def.id)
      .eq('is_revoked', false)
      .limit(1);
    eligible = ((earnedRows ?? []) as any[]).length > 0;
  } catch { /* fall through to the location check */ }

  if (!eligible) {
    const { data: postRow } = await sc
      .from('posts')
      .select('location_city, location_country')
      .eq('id', postId)
      .maybeSingle();
    eligible =
      !!postRow &&
      stampDefMatchesLocation(def, (postRow as any).location_city, (postRow as any).location_country);
  }
  if (!eligible) return { overlay: null, errorCode: 'stamp_not_eligible' };

  return {
    overlay: {
      stampDefinitionId: def.id,
      label:           def.name ?? 'Stamp',
      city:            def.city ?? null,
      country:         def.country ?? null,
      artworkUrl:      def.universal_artwork_url,
      artworkPinnedAt: new Date().toISOString(),
      style:           input.style,
      x:               roundTo(input.x),
      y:               roundTo(input.y),
      scale:           roundTo(input.scale),
      rotation:        roundTo(input.rotation, 2),
      opacity:         roundTo(input.opacity ?? (input.style === 'watermark' ? 0.45 : 1)),
    },
    errorCode: null,
  };
}

/**
 * Re-derives and writes media_count, has_video, primary_media_type on the
 * parent post and any linked passport_postcard from the current set of ready
 * post_media rows.
 */
async function refreshMediaCounts(sc: any, postId: string): Promise<{
  mediaCount: number;
  hasVideo: boolean;
  primaryMediaType: string;
  firstReadyUrl: string | null; /** census-media §37.9: the public_url of every READY file that does NOT count (held, flagged, rejected…), and whether the read could not run (nothing is written then). */ uncountedUrls: string[]; unread?: true;
}> {
  const { data: mediaRows, error: mediaReadErr } = await sc
    .from('post_media')
    .select('media_type, processing_status, public_url, sort_order, moderation_status') // census-media §37.8: moderation read so a held file neither counts nor becomes the cover
    .eq('post_id', postId);
  if (mediaReadErr) return { mediaCount: 0, hasVideo: false, primaryMediaType: 'none', firstReadyUrl: null, uncountedUrls: [], unread: true }; // §37.9: a read that could not run is not "no files" — write no zeros
  const ready = ((mediaRows ?? []) as any[])
    .filter((r: any) => r.processing_status === 'ready')
    .filter((r: any) => countsTowardPostcard(r)).sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0)); // §37.8: ready AND distributable (was: .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));)

  const mediaCount = ready.length;
  const hasVideo = ready.some((r: any) => r.media_type === 'video');
  const primaryMediaType = mediaCount === 0 ? 'none' : (hasVideo ? 'video' : 'image');
  const firstReadyUrl = (ready[0]?.public_url as string | undefined) ?? null;

  await sc
    .from('posts')
    .update({ media_count: mediaCount, has_video: hasVideo, primary_media_type: primaryMediaType })
    .eq('id', postId)
    .then(undefined, () => {});

  await sc
    .from('passport_postcards')
    .update({ media_count: mediaCount, has_video: hasVideo, primary_media_type: primaryMediaType })
    .eq('post_id', postId)
    .then(undefined, () => {});

  return { mediaCount, hasVideo, primaryMediaType, firstReadyUrl, uncountedUrls: ((mediaRows ?? []) as any[]).filter((r: any) => r.processing_status === 'ready' && !countsTowardPostcard(r)).map((r: any) => String(r.public_url ?? '')).filter(Boolean) };
}

/* ============================================================================
 * POST /api/postcards — create a postcard draft
 * ============================================================================
 * Creates a post with no media yet (media_count=0). Hashtags are extracted
 * from the caption. The client then obtains upload URLs and completes each
 * item individually. The passport_postcard is created lazily on the first
 * completed media item when add_to_passport=true.
 */
const createPostcardSchema = z.object({
  caption:         z.string().max(2000).optional(),
  visibility:      z.enum(['public', 'private', 'trip_only']).optional().default('public'),
  locationName:    z.string().max(200).optional(),
  locationCity:    z.string().max(100).optional(),
  locationCountry: z.string().max(100).optional(),
  locationLat:     z.number().min(-90).max(90).optional(),
  locationLng:     z.number().min(-180).max(180).optional(),
  tripId:          z.string().uuid().optional(),
  placeId:         z.string().max(200).optional(),
  /** Universal canonical location registry id (canonical_locations.id — migrations 0125/0128). */
  canonicalLocationId: z.string().uuid().optional(),
  addToPassport:   z.boolean().optional().default(true),
  /**
   * Optional Portava Event id to link this post to via post_event_links.
   * NOTE: posts has no event_id column (removed; the separate event_posts table handles
   * participant-only event wall posts). This field writes a row to post_event_links instead,
   * enabling the Discovery event-post pipeline without touching the posts schema.
   */
  eventId: z.string().uuid().optional(),
});

router.post('/postcards', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Emergency posting stop. POST /posts has always honoured this; the postcard
  // shell is a post row by another name and did not, so engaging the switch
  // stopped one composer and left the other writing posts. Fail-CLOSED via
  // isKillSwitchEngaged: an unreadable stop engages.
  if (await isKillSwitchEngaged(sc, 'disable_posting')) {
    sendError(res, 'feature_disabled', 'Posting is temporarily disabled');
    return;
  }

  const parsed = createPostcardSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid payload');
    return;
  }
  const p = parsed.data;

  // Trip-attached: verify existence + accepted membership BEFORE writing.
  // Identical gate to POST /api/posts — the postcard shell is a posts row by
  // another name, and posts.trip_id is what every trip-scoped reader trusts
  // (GET /trips/:tripId/posts, the trip_only visibility checks in mediaFeed and
  // checkEngagePermission, contentStamps). The posts_trip_id_fkey constraint
  // only rejects a nonexistent trip; it knows nothing about membership, so
  // without this a client could attach a postcard to any trip id it can guess.
  if (p.tripId) {
    if (!(await tripExists(sc, p.tripId))) {
      sendError(res, 'not_found', 'Trip not found');
      return;
    }
    if (!(await isAcceptedTripMember(sc, p.tripId, user.id))) {
      sendError(res, 'not_member', 'You must be an accepted member of this trip to post to it');
      return;
    }
  }

  // Column mapping: provider place refs go to location_place_id (same column
  // the /api/posts flow writes — a bare `place_id` column does not exist).
  const baseRow = {
    author_id:          user.id,
    content:            p.caption ?? '',
    media_urls:         [],
    media_count:        0,
    has_video:          false,
    primary_media_type: 'none',
    visibility:         p.visibility,
    status:             'active',
    location_name:      p.locationName ?? null,
    location_city:      p.locationCity ?? null,
    location_country:   p.locationCountry ?? null,
    location_lat:       p.locationLat ?? null,
    location_lng:       p.locationLng ?? null,
    trip_id:            p.tripId ?? null,
    location_place_id:  p.placeId ?? null,
    add_to_passport:    p.addToPassport,
    created_by:         user.id,
    updated_by:         user.id,
    source:             'api_server',
  };

  // Cast note: canonical_location_id exists in the live DB (migration 0128,
  // applied) but src/lib/database.types.ts predates the canonical registry —
  // the same staleness that let the old nonexistent event_id/place_id writes
  // compile. Regenerating the types removes this cast; until then keep baseRow
  // itself strictly checked and widen only here.
  let ins = await sc
    .from('posts')
    .insert((p.canonicalLocationId
      ? { ...baseRow, canonical_location_id: p.canonicalLocationId }
      : baseRow) as typeof baseRow)
    .select('id')
    .single();

  // Graceful fallback: the canonical reference is optional. If the column is
  // missing in this environment (migration 0128 not applied), retry without it
  // — an optional location link must never block posting.
  if (
    ins.error && p.canonicalLocationId &&
    (ins.error as any).code === 'PGRST204' &&
    typeof ins.error.message === 'string' &&
    ins.error.message.includes('canonical_location_id')
  ) {
    req.log.warn({ err: ins.error }, 'postcards: canonical_location_id column missing — posting without it (apply migration 0128)');
    ins = await sc.from('posts').insert(baseRow).select('id').single();
  }

  const { data: post, error: postErr } = ins;

  if (postErr) {
    // Full technical detail stays server-side; the client gets a readable
    // sentence, never a raw database error string.
    req.log.error({ err: postErr }, 'postcards: failed to create post');
    sendError(res, "db_error", "We couldn't create your postcard. Please try again.", { exposeDetail: true });
    return;
  }

  const postId = (post as any).id as string;

  // Fire-and-forget: link post to a Portava Event if eventId was provided.
  // Errors here (e.g. unknown event_id, migration not yet applied) must never
  // block the post creation response — the event link is supplementary.
  if (p.eventId) {
    void Promise.resolve(
      sc.from('post_event_links' as any)
        .insert({ post_id: postId, event_id: p.eventId })
    ).then(({ error: linkErr }: { error: any }) => {
      if (linkErr) {
        req.log.warn({ err: linkErr, postId, eventId: p.eventId }, 'postcards: failed to insert post_event_links row (non-fatal)');
      }
    }).catch(() => {});
  }

  // Fire-and-forget: extract @mentions and #hashtags from caption
  if (p.caption) {
    processTagging({
      db:         sc,
      authorId:   user.id,
      sourceType: 'post',
      sourceId:   postId,
      content:    p.caption,
      city:       p.locationCity ?? null,
      country:    p.locationCountry ?? null,
      logger:     (req as any).log,
    }).catch(() => {});
  }

  res.status(201).json({ id: postId });
});

/* ============================================================================
 * POST /api/postcards/:id/media/upload-url — signed upload URL for one item
 * ============================================================================
 * Validates MIME type and declared file size server-side before creating the
 * post_media row (status=pending) and returning a signed Supabase Storage URL.
 * Storage path: post-media/{userId}/{postId}/{mediaId}.{ext}
 */
const uploadUrlSchema = z.object({
  mimeType:      z.string(),
  fileSizeBytes: z.number().int().positive(),
});

router.post('/postcards/:id/media/upload-url', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { id: postId } = req.params;

  if (!isValidUuid(postId)) { sendError(res, 'invalid_payload', 'Invalid postcard id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Emergency media kill switch AND the per-user upload rate limit, both from
  // lib/mediaPipeline so this transport draws on the same budget as
  // POST /api/media/upload. Rate limiting was previously absent here entirely:
  // minting signed upload URLs was unbounded, so a client could push 100 MB
  // objects at the storage bill without ever touching a limiter.
  const guard = await guardUploadRequest(sc, user.id);
  if (!guard.ok) {
    if (guard.failure.code === 'rate_limited') {
      res.setHeader('Retry-After', Math.ceil(guard.failure.retryAfterMs / 1000).toString());
    }
    sendError(res, guard.failure.code, guard.failure.message);
    return;
  }

  const parsed = uploadUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid payload');
    return;
  }
  const { mimeType, fileSizeBytes } = parsed.data;

  // Declared MIME + size, from the shared policy table. This path used to allow
  // 20 MB images while /api/media/upload allowed 15 MB, for the same photo from
  // the same picker; the shared limit is 15 MB, which is the number that had
  // documented reasoning behind it.
  const declared = validateDeclaredUpload({ mimeType, fileSizeBytes });
  if (!declared.ok) {
    sendError(res, declared.failure.code, declared.failure.message);
    return;
  }
  const mimeInfo = declared.value;

  // Verify post ownership
  const { data: postRow, error: postErr } = await sc
    .from('posts')
    .select('id, author_id')
    .eq('id', postId)
    .eq('status', 'active')
    .maybeSingle();

  if (postErr) {
    req.log.error({ err: postErr }, 'postcards: failed to load post for upload-url');
    sendError(res, "db_error", "We couldn't prepare your upload. Please try again.", { exposeDetail: true });
    return;
  }
  if (!postRow) { sendError(res, 'not_found', 'Postcard not found'); return; }
  if ((postRow as any).author_id !== user.id) { sendError(res, 'forbidden', 'Not your postcard'); return; }

  // Enforce max media per postcard
  const countRes = await sc
    .from('post_media')
    .select('id', { count: 'exact', head: true })
    .eq('post_id', postId)
    .neq('processing_status', 'failed');
  const existingCount = (countRes as any).count ?? 0;

  if (existingCount >= MAX_MEDIA_PER_POSTCARD) {
    sendError(res, 'invalid_payload', `Maximum ${MAX_MEDIA_PER_POSTCARD} media items per postcard`);
    return;
  }

  // Create post_media row in pending state (storage_path filled after we have the mediaId)
  const { data: mediaRow, error: mediaErr } = await sc
    .from('post_media')
    .insert({
      post_id:           postId,
      user_id:           user.id,
      media_type:        mimeInfo.mediaType,
      storage_bucket:    STORAGE_BUCKET,
      storage_path:      '',
      public_url:        '',
      mime_type:         mimeType,
      file_size_bytes:   fileSizeBytes,
      processing_status: 'pending',
      moderation_status: 'pending',
      sort_order:        existingCount,
    })
    .select('id')
    .single();

  if (mediaErr) {
    req.log.error({ err: mediaErr }, 'postcards: failed to create post_media row');
    sendError(res, "db_error", "We couldn't prepare your upload. Please try again.", { exposeDetail: true });
    return;
  }

  const mediaId = (mediaRow as any).id as string;
  const storagePath = `${user.id}/${postId}/${mediaId}.${mimeInfo.ext}`;

  // Backfill storage_path now that we have the mediaId
  const { error: pathErr } = await sc
    .from('post_media')
    .update({ storage_path: storagePath })
    .eq('id', mediaId);  // census-discovery §56 (DV-77): BOUND. A slot whose path did not record is one no sweep can find, so no URL is minted for it.
  if (pathErr) { req.log.error({ err: pathErr, mediaId }, 'postcards: storage_path backfill failed — refusing rather than minting an untracked upload URL'); await sc.from('post_media').update({ processing_status: 'failed' }).eq('id', mediaId).then(undefined, () => {}); sendError(res, "db_error", "We couldn't prepare your upload. Please try again.", { exposeDetail: true }); return; }

  // Generate signed upload URL
  const { data: urlData, error: urlErr } = await sc.storage
    .from(STORAGE_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (urlErr) {
    req.log.error({ err: urlErr }, 'postcards: failed to create signed upload URL');
    await sc
      .from('post_media')
      .update({ processing_status: 'failed' })
      .eq('id', mediaId)
      .then(undefined, () => {});
    sendError(res, "db_error", "We couldn't prepare your upload. Please try again.", { exposeDetail: true });
    return;
  }

  res.status(200).json({
    mediaId,
    uploadUrl: (urlData as any).signedUrl,
    path: storagePath,
  });
});

/* ============================================================================
 * POST /api/postcards/:id/media/:mediaId/complete — mark upload done
 * ============================================================================
 * Accepts final metadata from the client, sets processing_status=ready,
 * re-derives parent media summary columns, and lazily creates the
 * passport_postcard on the first ready media when add_to_passport=true.
 */
const completeSchema = z.object({
  mimeType:        z.string(),
  fileSizeBytes:   z.number().int().positive(),
  durationSeconds: z.number().positive().optional(),
  // .nullish() — accepts number | null | undefined so a client that received
  // null from /media/upload (HEIC fail-soft, unprocessed video) and passes
  // those nulls through reaches the explicit dimension guard below rather than
  // the generic Zod "Expected number, received null" message.
  width:           z.number().int().positive().nullish(),
  height:          z.number().int().positive().nullish(),
  thumbnailPath:   z.string().max(500).optional(),
  /** Optional stamp overlay — validated & pinned server-side (never trust client URLs). */
  stampOverlay:    stampOverlaySchema.optional(),
});

/**
 * The dimension-guard rejection, shared by the two places that can raise it:
 * the cheap pre-check in the video branch and the final guard before the write.
 * One literal because clients branch on this text — the hardening suite asserts
 * it names both dimensions, and two copies would drift silently.
 */
const DIMENSIONS_REQUIRED_MESSAGE = 'width and height are required to complete this upload.';

/* ============================================================================
 * Why a failed media check is CLASSIFIED before it is reported
 * ============================================================================
 * The completion handler below runs three genuinely different kinds of check
 * over the stored object, and until now a single `try` wrapped all of them and
 * a single `catch` reported every one of them as
 *
 *     400 invalid_payload  "Video could not be verified. Please re-upload."
 *
 * Those three kinds are:
 *
 *   CONTENT        the bytes are not what they were declared to be
 *                  (verifyUploadedBytes rejected the magic bytes; Sharp could
 *                  not decode the image). The uploader CAN fix this, and
 *                  re-uploading is the right advice. 400.
 *
 *   POLICY         the bytes are a legal media file that we refuse
 *                  (the stored object exceeds MEDIA_SIZE_LIMITS). The uploader
 *                  can fix this too, but not by re-uploading the same file —
 *                  the message has to say WHAT the limit is. 400.
 *
 *   INFRASTRUCTURE we could not perform the check at all: Storage would not
 *                  issue a signed URL, the range read returned 5xx, the
 *                  download errored, the re-upload errored. Nothing is known
 *                  about the file. Telling this person "your video could not be
 *                  verified, please re-upload" is a FALSE STATEMENT about their
 *                  content — it blames the user for our outage, and the advice
 *                  it gives (re-upload) is the one action that cannot help,
 *                  because the second attempt fails in the same place. 503
 *                  `degraded_unavailable`, which lib/http.ts marks retryable, so
 *                  the client offers "try again" instead of "your file is bad".
 *
 * Every throw inside the checked blocks is now raised as a MediaCheckFailure
 * carrying its kind. An UNCLASSIFIED throw — a bug in this handler, or a new
 * library error nobody has triaged — is reported as INFRASTRUCTURE, because
 * "we do not know what went wrong" must never be served as "your file is
 * broken". The log line carries `classification` so an unclassified failure is
 * visible to operators rather than hiding inside the retryable bucket.
 *
 * This is the same distinction §28.11 draws for reads ("never swallow failures
 * into plausible-looking empty history without structured error state"), on the
 * write path.
 * ============================================================================ */
type MediaFailureKind = 'content' | 'policy' | 'infrastructure';

class MediaCheckFailure extends Error {
  readonly kind: MediaFailureKind;
  constructor(kind: MediaFailureKind, message: string) {
    super(message);
    this.name = 'MediaCheckFailure';
    this.kind = kind;
  }
}

/** The stored bytes are not what they were declared to be — the uploader can fix it. */
const contentFailure = (m: string) => new MediaCheckFailure('content', m);
/** A legal file we refuse; the message must state the rule. */
const policyFailure = (m: string) => new MediaCheckFailure('policy', m);
/** The check could not be performed. Nothing is known about the file. */
const infraFailure = (m: string) => new MediaCheckFailure('infrastructure', m);

/**
 * Report a caught media-check failure with the code its KIND earns.
 *
 * `contentMessage` is the user-facing sentence for the content case only — the
 * one case where "please re-upload" is true advice. Policy failures carry their
 * own specific message (a size limit is useless if it does not say the limit).
 * Infrastructure failures never repeat the internal reason to the client, but
 * always log it.
 */
function sendMediaCheckFailure(
  req: any,
  res: any,
  err: unknown,
  stage: string,
  contentMessage: string,
): void {
  const classified = err instanceof MediaCheckFailure ? err : null;
  const kind: MediaFailureKind = classified?.kind ?? 'infrastructure';
  req.log.error(
    { err, stage, classification: classified ? kind : 'unclassified' },
    `postcards: ${stage} failed (${classified ? kind : 'unclassified — reported as infrastructure'})`,
  );
  if (kind === 'content') {
    sendError(res, 'invalid_payload', contentMessage);
    return;
  }
  if (kind === 'policy') {
    sendError(res, 'invalid_payload', classified!.message);
    return;
  }
  // INFRASTRUCTURE. 503 + retryable: our outage, not their file.
  sendError(
    res,
    'degraded_unavailable',
    'We could not check your upload right now. Your file is fine — please try again in a moment.',
  );
}

router.post('/postcards/:id/media/:mediaId/complete', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { id: postId, mediaId } = req.params;

  if (!isValidUuid(postId) || !isValidUuid(mediaId)) {
    sendError(res, 'invalid_payload', 'Invalid id');
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid payload');
    return;
  }
  const p = parsed.data;

  // Load + verify ownership
  const { data: mediaRow, error: mediaErr } = await sc
    .from('post_media')
    .select('id, user_id, post_id, storage_path, storage_bucket, media_type, processing_status')
    .eq('id', mediaId)
    .eq('post_id', postId)
    .maybeSingle();

  if (mediaErr) {
    req.log.error({ err: mediaErr }, 'postcards: failed to load media for complete');
    sendError(res, "db_error", "We couldn't finish your upload. Please try again.", { exposeDetail: true });
    return;
  }
  if (!mediaRow) { sendError(res, 'not_found', 'Media not found'); return; }
  if ((mediaRow as any).user_id !== user.id) { sendError(res, 'forbidden', 'Not your media'); return; }

  // Idempotent: already ready
  if ((mediaRow as any).processing_status === 'ready') {
    res.status(200).json({ ok: true });
    return;
  }

  // Compute bare bucket/path reference (bucket will be private; client hydration signs on demand)
  const storagePath = (mediaRow as any).storage_path as string;
  const publicUrl = `${STORAGE_BUCKET}/${storagePath}`;

  // Audit privacy fix: postcard media goes DIRECT to storage via signed URL, so
  // the server never saw the bytes — EXIF/GPS survived and width/height were
  // client-declared. For images: download, strip EXIF/auto-orient, re-upload in
  // place, and measure real dimensions server-side. Fail-closed for images.
  // Videos are not transcoded (no ffmpeg tier), but their container location
  // atoms ARE stripped, and their duration + display size are READ from the
  // container (§37, lib/videoProbe.ts) — server-measured wins, as for images.
  let probedVideo: VideoProbe | null = null;
  let measuredWidth: number | null = null;
  let measuredHeight: number | null = null;
  let computedPhash: string | null = null;
  let feedStoragePath: string | null = null;
  let feedUrl: string | null = null;
  if ((mediaRow as any).media_type === 'image') {
    try {
      // STORAGE — infrastructure. A download that fails says nothing about the
      // bytes; it says we could not read them.
      const dl = await sc.storage.from(STORAGE_BUCKET).download(storagePath);
      if ((dl as any).error || !(dl as any).data) {
        throw infraFailure((dl as any).error?.message ?? 'download failed');
      }
      const rawBuf = Buffer.from(await (dl as any).data.arrayBuffer());
      // BYTES — content. This is the one verdict that is genuinely about the
      // uploaded file, and the only one that earns "please re-upload".
      const verified = verifyUploadedBytes(rawBuf, 'image');
      if (!verified.ok) throw contentFailure(verified.failure.message);
      const sniffed = verified.value;
      // DECODE — content. Sharp throws on an image it cannot decode; that is a
      // fact about the file, so it is classified here rather than left to the
      // unclassified default.
      let img;
      try {
        img = await processImage(rawBuf, sniffed);
      } catch (decodeErr) {
        throw contentFailure(decodeErr instanceof Error ? decodeErr.message : 'image could not be decoded');
      }
      // STORAGE — infrastructure again.
      const { error: reErr } = await sc.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, img.buffer, { contentType: img.mime, upsert: true });
      if (reErr) throw infraFailure(reErr.message);
      measuredWidth = img.width;
      measuredHeight = img.height;
      // Perceptual hash for near-duplicate detection. Fail-soft: null hash
      // never blocks completion — the dedup worker skips rows where phash IS NULL.
      //
      // It says "fail-soft" and it was NOT: this call sat bare inside the outer
      // try, so a Sharp failure computing a dedup hash rejected an upload whose
      // bytes were already verified, stripped and re-stored. The comment
      // described the intent; the control flow did the opposite. Its own catch
      // now makes the sentence true.
      try {
        computedPhash = await computePHash(img.buffer);
      } catch (phashErr) {
        req.log.warn({ err: phashErr, mediaId }, 'postcards: phash not computed — dedup will skip this row');
        computedPhash = null;
      }

      // Feed-sized derivative (migration 0208). THIS is the write that matters:
      // post_media is what the Postcard Wall reads, and this handler — not
      // POST /posts/media — is the production upload path for postcard media.
      //
      // Derived from `img.buffer`, the ALREADY-PROCESSED image, so it inherits
      // the auto-orient and the full EXIF/GPS strip. Deriving it from `rawBuf`
      // would silently reintroduce capture coordinates into a second stored
      // object, which is the exact privacy defect this pipeline exists to fix.
      //
      // FAIL-SOFT, unlike the original processing above. A failure here leaves
      // feed_url NULL, and NULL means "no variant — serve the original", which
      // is precisely today's behaviour. Rejecting a completed upload because an
      // optimisation could not be built would trade a working post for a faster
      // one. upsert:true so a retried completion overwrites cleanly.
      try {
        const variant = await makeFeedVariant(img.buffer);
        const candidatePath = `${storagePath}.feed.jpg`;
        const { error: fErr } = await sc.storage
          .from(STORAGE_BUCKET)
          .upload(candidatePath, variant.buffer, { contentType: variant.mime, upsert: true });
        if (fErr) throw new Error(fErr.message);
        feedStoragePath = candidatePath;
        feedUrl = `${STORAGE_BUCKET}/${candidatePath}`;
      } catch (variantErr) {
        req.log.warn({ err: variantErr, mediaId }, 'postcards: feed variant not built — serving original');
      }
    } catch (err) {
      sendMediaCheckFailure(req, res, err, 'image processing', 'Image could not be processed. Please re-upload.');
      return;
    }
  } else {
    // VIDEO — the bytes first, then the dimensions (census-media §37.8).
    //
    // For video, measuredWidth/measuredHeight are never set: the processing
    // block above is gated on media_type === 'image'. The dimension guard
    // further down resolves to the size the CONTAINER states (probed below,
    // from the verified bytes) and only then to p.width/p.height.
    //
    // This used to refuse a payload without p.width/p.height HERE, before any
    // storage read, so the specific message stayed reachable with the store
    // down. That was right while the client's figure was the only source. It
    // stopped being right once census-media §22 began probing the stored
    // container: a client that sent no dimensions for a video whose container
    // states them was refused for a size the server reads itself. So the
    // payload is no longer refused on its face. The guard below refuses only
    // when NEITHER source states a size; with the store down the answer is the
    // storage failure (retryable), because the size is then genuinely unknown.
    //
    // Images are unaffected: their dimensions ARE the storage read (processImage
    // measures them), and their guard is satisfied by construction or rejected.
    //
    // Fail-closed on storage is unchanged — nothing below is relaxed.
    //
    if (p.width == null || p.height == null) {
      req.log.info({ mediaId, mediaType: 'video' }, 'postcards: complete without client dimensions — the container probe decides');
    }
    // (was: a pre-verification refusal — sendError(res, 'invalid_payload', DIMENSIONS_REQUIRED_MESSAGE); return;)
    //

    // Verify the stored bytes are really a video, and really within the
    // ceiling.
    //
    // Until now video got NO byte-level check on this transport: the whole
    // processing block above is gated on media_type === 'image', so the only
    // thing ever validated for a video was the size the CLIENT declared before
    // uploading. On a signed-URL transport the client has already written the
    // object by then, so a declaration is not validation — a client could
    // declare 1 MB of video/mp4 and store 500 MB of anything.
    //
    // Verified with a 64-byte RANGE read rather than a full download: magic
    // bytes live in the first few, and pulling 100 MB through an autoscale
    // process to read 12 of them is what made "just check it" look expensive
    // enough to skip. Content-Range carries the true stored length, so the real
    // size ceiling is enforced from the same request.
    //
    // Fail-CLOSED, matching images: completion is refused and is retryable,
    // rather than marking ready a row whose bytes nothing has ever inspected.
    //
    // THE THREE FAILURES BELOW ARE NOT THE SAME FAILURE. Signing and the range
    // read are OUR storage; the magic-byte check is the user's file; the size
    // ceiling is our rule. They used to share one `catch` and one sentence
    // ("Video could not be verified. Please re-upload."), which meant a Storage
    // outage was reported to the uploader as a broken video and the only advice
    // offered — re-upload — was the one action guaranteed to fail again. See
    // the classification note above DIMENSIONS_REQUIRED_MESSAGE.
    try {
      // STORAGE — infrastructure.
      const signed = await sc.storage.from(STORAGE_BUCKET).createSignedUrl(storagePath, 60);
      const signedUrl = (signed as any)?.data?.signedUrl;
      if (!signedUrl) {
        throw infraFailure((signed as any)?.error?.message ?? 'could not sign stored object for verification');
      }

      // NETWORK / STORAGE — infrastructure. A non-2xx here is the store
      // answering badly, not the file being bad; a fetch that throws (DNS,
      // socket, abort) is likewise ours and reaches the unclassified default,
      // which is also infrastructure.
      let probe: Response;
      try {
        probe = await fetch(signedUrl, { headers: { Range: 'bytes=0-63' } });
      } catch (netErr) {
        throw infraFailure(netErr instanceof Error ? netErr.message : 'verification read could not be made');
      }
      if (!probe.ok && probe.status !== 206) {
        throw infraFailure(`verification read failed (HTTP ${probe.status})`);
      }
      const headBuf = Buffer.from(await probe.arrayBuffer());

      // BYTES — content. The only verdict here that is about the user's file.
      const verified = verifyUploadedBytes(headBuf, 'video');
      if (!verified.ok) throw contentFailure(verified.failure.message);

      // "bytes 0-63/12345678" — the trailing total is the stored object size.
      // Absent (or a 200 without Content-Range) means the store did not honour
      // the range; skip the size assertion rather than guess from 64 bytes.
      //
      // SIZE — policy. A legal video we refuse. Its message names the limit and
      // is sent to the client verbatim, because "could not be verified" tells
      // someone with a 300 MB video nothing they can act on.
      const contentRange = probe.headers.get('content-range');
      const totalBytes = contentRange ? Number(contentRange.split('/')[1]) : NaN;
      if (Number.isFinite(totalBytes) && totalBytes > MEDIA_SIZE_LIMITS.video) {
        throw policyFailure(
          `This video is ${Math.round(totalBytes / 1024 / 1024)}MB. ` +
          `Videos can be up to ${Math.round(MEDIA_SIZE_LIMITS.video / 1024 / 1024)}MB.`,
        );
      }
    } catch (err) {
      sendMediaCheckFailure(req, res, err, 'video verification', 'Video could not be verified. Please re-upload.');
      return;
    }

    // LOCATION METADATA SCRUB.
    //
    // Everything above proves the object IS a video of a legal size. It does
    // not touch what the container SAYS. A phone video carries its capture
    // coordinates in `moov/udta/©xyz` (and, on Apple captures, an Apple
    // location `meta` key) exactly as a phone photo carries EXIF GPS — and on
    // this transport the bytes were written straight to Storage, so nothing had
    // ever looked. The image branch above exists precisely because "the server
    // never saw the bytes" is not a privacy model; video needs the same answer.
    //
    // COST, STATED PLAINLY: this downloads the stored object (ceiling 100 MB,
    // enforced above) once per completion, which the 64-byte Range probe was
    // written to avoid. There is no cheaper correct version: `moov` may sit at
    // either end of the file and can be megabytes, so no fixed window can prove
    // absence, and Storage has no partial write, so a file that DOES carry
    // coordinates has to be rewritten whole anyway. The re-upload is skipped
    // when nothing was found, so a video with no location metadata costs one
    // read and no write. The image branch already downloads and re-uploads in
    // exactly this shape.
    //
    // Fail-CLOSED, matching images: any failure refuses completion (retryable)
    // rather than marking ready a video whose coordinates are still in it.
    try {
      // STORAGE — infrastructure.
      const dl = await sc.storage.from(STORAGE_BUCKET).download(storagePath);
      if ((dl as any).error || !(dl as any).data) {
        throw infraFailure((dl as any).error?.message ?? 'download failed');
      }
      const videoBuf = Buffer.from(await (dl as any).data.arrayBuffer());
      // BYTES — content.
      const verifiedFull = verifyUploadedBytes(videoBuf, 'video');
      if (!verifiedFull.ok) throw contentFailure(verifiedFull.failure.message);
      probedVideo = probeVideoContainer(videoBuf); // duration + display size, from the verified bytes
      const scrub = stripVideoLocationMetadata(videoBuf, verifiedFull.value);
      if (!scrub.ok) {
        // A specific, actionable refusal — not the generic verification error.
        req.log.warn({ mediaId }, 'postcards: video location metadata could not be stripped — completion rejected');
        sendError(res, scrub.failure.code, scrub.failure.message);
        return;
      }
      if (scrub.stripped.length > 0) {
        const { error: reErr } = await sc.storage
          .from(STORAGE_BUCKET)
          // Content type from the SNIFFED bytes, not p.mimeType: the declared
          // value is a client assertion, and this write must not be the thing
          // that relabels a stored object.
          .upload(storagePath, scrub.buffer, { contentType: verifiedFull.value.mime, upsert: true });
        if (reErr) throw infraFailure(reErr.message);
        req.log.info({ mediaId, stripped: scrub.stripped }, 'postcards: video location metadata stripped');
      }
    } catch (err) {
      sendMediaCheckFailure(req, res, err, 'video location scrub', 'Video could not be processed. Please re-upload.');
      return;
    }
  }

  // Thumbnail: only THIS slot's own server-written poster (routes/postcardMediaTransport.ts).
  const poster = admissiblePosterPath(storagePath, p.thumbnailPath);
  if (!poster.ok) { sendError(res, 'invalid_payload', poster.message); return; }
  const thumbnailUrl: string | null = poster.path ? `${STORAGE_BUCKET}/${poster.path}` : null;
  const storedDuration = resolveStoredDuration(probedVideo, p.durationSeconds);

  // Optional stamp overlay — resolved & pinned server-side. An ineligible or
  // unavailable stamp NEVER blocks the upload: we complete without the overlay
  // and return a flag the client can surface.
  let overlay: Record<string, unknown> | null = null;
  let overlayError: string | null = null;
  if (p.stampOverlay) {
    if ((mediaRow as any).media_type !== 'image') {
      overlayError = 'stamp_overlay_images_only';
    } else {
      const resolved = await resolveStampOverlay(sc, user.id, postId, p.stampOverlay);
      overlay = resolved.overlay;
      overlayError = resolved.errorCode;
    }
    if (overlayError) {
      req.log.warn(
        { overlayError, stampDefinitionId: p.stampOverlay.stampDefinitionId, mediaId },
        'postcards: stamp overlay skipped (upload still completes)',
      );
    }
  }

  // Mark ready + store metadata
  const baseUpdate: Record<string, unknown> = {
    processing_status:      'ready',
    moderation_status:      await preDistributionPostMediaStatus(sc, { mediaType: (mediaRow as any).media_type === 'video' ? 'video' : 'image', bucket: STORAGE_BUCKET, path: storagePath, framePath: poster.path }), // census-media §37 (MD269/MD283): 'approved' while media_moderation_classifier_enabled is off (3356, seeded FALSE) (was: moderation_status:      'approved',)
    public_url:             publicUrl,
    mime_type:              p.mimeType,
    file_size_bytes:        p.fileSizeBytes,
    duration_seconds:       storedDuration.seconds,
    // Server-measured dimensions win over client-declared (audit trust fix).
    width:                  measuredWidth ?? probedVideo?.width ?? p.width ?? null,
    height:                 measuredHeight ?? probedVideo?.height ?? p.height ?? null,
    thumbnail_url:          thumbnailUrl,
    thumbnail_storage_path: poster.path,
    updated_at:             new Date().toISOString(),
    // Perceptual hash for near-duplicate grouping (null for videos or when
    // computation failed — worker skips rows with phash IS NULL).
    phash:                  computedPhash,
  };
  if ((mediaRow as any).media_type === 'video' && storedDuration.source !== 'measured') {
    // §37: the container did not state a duration (a live-recorded WebM, a
    // fragmented file with no timing). The stored value is the client's word,
    // and the log says so rather than the row pretending it was measured.
    req.log.warn({ mediaId, source: storedDuration.source }, 'postcards: video duration not stated by its container');
  }

  // Dimension guard: width and height must be present before we can flip the
  // row to 'ready'. For images this is guaranteed — server-side processing
  // always measures dimensions (and rejects on failure). For videos the values
  // come from the client; if they are missing we must refuse rather than write
  // a NULL-dimension row that the thumbnail pipeline (migration 0208) would
  // silently skip on every future pass.
  if (baseUpdate.width === null || baseUpdate.height === null) {
    req.log.warn({ mediaId, mediaType: (mediaRow as any).media_type }, 'postcards: complete rejected — width/height required');
    sendError(res, 'invalid_payload', DIMENSIONS_REQUIRED_MESSAGE);
    return;
  }

  // Feed-variant columns (0208) are added only when a variant was actually
  // built. Writing them unconditionally would set feed_url = NULL on videos and
  // on failed derives, which is the same result but says it less clearly; more
  // importantly, omitting them means an environment without 0208 only hits the
  // degrade path when there is something real to lose.
  if (feedUrl) {
    baseUpdate.feed_storage_path = feedStoragePath;
    baseUpdate.feed_url = feedUrl;
  }

  let { error: updateErr } = await sc
    .from('post_media')
    .update(overlay ? { ...baseUpdate, stamp_overlay: overlay } : baseUpdate)
    .eq('id', mediaId);

  // Graceful degrade: feed_url/feed_storage_path missing (migration 0208 not
  // applied in this environment) — drop them and retry. The variant object is
  // left in the bucket rather than deleted: it is addressable only through the
  // column we just failed to write, so nothing can serve it, and applying 0208
  // plus a backfill later can adopt it. Checked BEFORE the stamp_overlay branch
  // because PostgREST reports only the first unknown column, so a row missing
  // both would otherwise loop on the overlay message forever.
  if (
    updateErr && feedUrl &&
    (updateErr as any).code === 'PGRST204' &&
    typeof updateErr.message === 'string' &&
    (updateErr.message.includes('feed_url') || updateErr.message.includes('feed_storage_path'))
  ) {
    req.log.warn({ err: updateErr, mediaId }, 'postcards: feed-variant columns missing — completing without them (apply migration 0208)');
    delete baseUpdate.feed_storage_path;
    delete baseUpdate.feed_url;
    feedStoragePath = null;
    feedUrl = null;
    const retry = await sc
      .from('post_media')
      .update(overlay ? { ...baseUpdate, stamp_overlay: overlay } : baseUpdate)
      .eq('id', mediaId);
    updateErr = retry.error;
  }

  // Graceful degrade: stamp_overlay column missing (migration 0129 not applied
  // in this environment) — retry without the overlay; never block the upload.
  if (
    updateErr && overlay &&
    (updateErr as any).code === 'PGRST204' &&
    typeof updateErr.message === 'string' &&
    updateErr.message.includes('stamp_overlay')
  ) {
    req.log.warn({ err: updateErr }, 'postcards: stamp_overlay column missing — completing without overlay (apply migration 0129)');
    overlay = null;
    overlayError = 'stamp_overlay_not_supported';
    const retry = await sc.from('post_media').update(baseUpdate).eq('id', mediaId);
    updateErr = retry.error;
  }

  if (updateErr) {
    req.log.error({ err: updateErr }, 'postcards: failed to complete media upload');
    sendError(res, "db_error", "We couldn't finish your upload. Please try again.", { exposeDetail: true });
    return;
  }
  const counts = await syncPostcardAfterMediaChange(sc, postId, user, req); res.status(200).json({ ok: true, mediaCount: counts.mediaCount, hasVideo: counts.hasVideo, ...(p.stampOverlay ? (overlay ? { stampOverlayApplied: true } : { stampOverlayApplied: false, stampOverlayError: overlayError ?? 'stamp_unavailable' }) : {}) }); }); // census-media §37.9: the step below is shared with admin moderation; the response is unchanged
export async function syncPostcardAfterMediaChange(sc: any, postId: string, user: { id: string }, req: { log: { warn: (...args: any[]) => void } }, alsoGone: readonly string[] = []): Promise<PostcardStepResult> { // census-media §37.10: it also moves the passport cover (was: …, req: {…}): Promise<PostcardMediaCounts> {) // Refresh parent counts and get first-ready URL for postcard creation (census-media §37.9: /complete and POST /admin/media/:id/moderate)
  const counts = await refreshMediaCounts(sc, postId);

  // Lazily create passport_postcard on the first ready media when add_to_passport=true.
  // Uses insert-or-nothing (ON CONFLICT DO NOTHING via ignoreDuplicates) so concurrent
  // completes don't produce duplicates.
  if (counts.mediaCount === 1 && counts.firstReadyUrl) {
    const [postRes, existsRes] = await Promise.all([
      sc.from('posts')
        .select('add_to_passport, location_name, location_city, location_country, content, visibility')
        .eq('id', postId)
        .maybeSingle(),
      sc.from('passport_postcards')
        .select('id', { count: 'exact', head: true })
        .eq('post_id', postId),
    ]);

    const postData = postRes.data as any;
    const pcCount = (existsRes as any).count ?? 0;

    if (postData?.add_to_passport === true && pcCount === 0) {
      const pcIns = await sc
        .from('passport_postcards')
        .insert({
          post_id:            postId,
          user_id:            user.id,
          media_url:          counts.firstReadyUrl,
          caption:            postData.content ?? null,
          location_name:      postData.location_name ?? null,
          location_city:      postData.location_city ?? null,
          location_country:   postData.location_country ?? null,
          location_verified:  false,
          stamp_eligible:     false,
          verification_method:'unavailable',
          visibility:         postData.visibility ?? 'public',
          status:             'active',
          media_count:        counts.mediaCount,
          has_video:          counts.hasVideo,
          primary_media_type: counts.primaryMediaType,
        })
        .select('id')
        .maybeSingle();
      if (pcIns.error) {
        req.log.warn({ err: pcIns.error }, 'postcards: passport_postcard auto-create failed (non-fatal)');
      } else if (pcIns.data && counts.firstReadyUrl) {
        // Canonical dual-write (flag-gated OFF; fail-soft — legacy media_url
        // path unaffected). Records media_assets +
        // media_attachments(entityType=postcard) so the postcard photo joins
        // the §6.1 canonical model once media_canonical_enabled is lit.
        void recordEntityMedia(sc, {
          ownerUserId: user.id,
          publicUrl: counts.firstReadyUrl,
          entityType: 'postcard',
          entityId: (pcIns.data as any).id as string,
          isCover: true, sourceType: MEDIA_SOURCE_UNDECLARED, // the post's uploaded file: §6 source never declared (census-media §35, MD37)
        });
        // census-media §21 — §44 "Memory / Postcard created", at the one
        // moment the Postcard row is actually written.
        recordPostcardCreatedSignal(sc, { userId: user.id, postId });
      }
    }
  }
  const cover = await repointPassportCover(sc, postId, counts, req, alsoGone); // census-media §37.10 item 3: the step owns the one cover rule, for /complete too (was: // census-media §37.9: the cover repoint after a moderation decision is syncPostcardAfterModeration's)
  return { ...counts, cover };
}
// ── census-media §37.9 ────────────────────────────────────────────────────────────
// The /complete handler above used to end here: its 200 response (mediaCount, hasVideo and the
// stamp-overlay flags) is now sent on the line before this function, unchanged in content. The
// recount and the lazy passport postcard moved into syncPostcardAfterMediaChange IN PLACE — every
// line census-media cites inside it (the insert, the canonical cover, the created signal) kept its
// number and its text — so POST /admin/media/:id/moderate runs the same step when a moderator
// releases a held file or holds a counted one (routes/adminMedia.ts).
// (was: res.status(200).json({ ok: true, mediaCount: counts.mediaCount, hasVideo: counts.hasVideo,
// …stampOverlay… }); }); — the end of the /complete handler)

/* ============================================================================
 * DELETE /api/postcards/:id/media/:mediaId — owner-only removal
 * ============================================================================
 * Hard-deletes the post_media row, removes the storage object, and re-derives
 * the parent post's media summary columns.
 */
router.delete('/postcards/:id/media/:mediaId', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { id: postId, mediaId } = req.params;

  if (!isValidUuid(postId) || !isValidUuid(mediaId)) {
    sendError(res, 'invalid_payload', 'Invalid id');
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Load media row
  const { data: mediaRow, error: loadErr } = await sc
    .from('post_media')
    .select('id, user_id, post_id, storage_bucket, storage_path, processing_status, public_url') // census-media §37.10 item 1: the removed file's URL, to move a cover off it (was: .select('id, user_id, post_id, storage_bucket, storage_path, processing_status'))
    .eq('id', mediaId)
    .eq('post_id', postId)
    .maybeSingle();

  if (loadErr) {
    req.log.error({ err: loadErr }, 'postcards: failed to load media for delete');
    sendError(res, "db_error", "We couldn't remove that media. Please try again.", { exposeDetail: true });
    return;
  }
  if (!mediaRow) { sendError(res, 'not_found', 'Media not found'); return; }

  // Owner or admin check
  const isOwner = (mediaRow as any).user_id === user.id;
  if (!isOwner) {
    const { data: profile } = await sc
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if ((profile as any)?.role !== 'admin') {
      sendError(res, 'forbidden', 'Not your media');
      return;
    }
  }

  // Hard-delete from DB
  const { error: deleteErr } = await sc
    .from('post_media')
    .delete()
    .eq('id', mediaId);

  if (deleteErr) {
    req.log.error({ err: deleteErr }, 'postcards: failed to delete media row');
    sendError(res, "db_error", "We couldn't remove that media. Please try again.", { exposeDetail: true });
    return;
  }

  // Remove from storage (best-effort — do not fail if storage removal fails).
  // The 0208 feed variant goes with it: it is a derivative of this exact object
  // and nothing else references it, so leaving it behind would be an ORPHAN
  // OBJECT in check:media-objects' terms — wasted storage, and content believed
  // deleted that is still fetchable. `remove` tolerates absent keys, so listing
  // it unconditionally is safe for videos and pre-0208 rows alike.
  const storagePath = (mediaRow as any).storage_path as string;
  if (storagePath) {
    await sc.storage
      .from(STORAGE_BUCKET)
      .remove([storagePath, `${storagePath}.feed.jpg`])
      .then(undefined, () => {});
    // The video poster and any resumable parts are derivatives of this exact
    // object too (routes/postcardMediaTransport.ts); they go with it.
    await removeTransportArtifacts(sc.storage.from(STORAGE_BUCKET), storagePath).then(undefined, () => {});
  }

  // Re-derive parent media counts
  const counts = await refreshMediaCounts(sc, postId); await repointPassportCover(sc, postId, counts, req, [String((mediaRow as any).public_url ?? '')].filter(Boolean)); // census-media §37.10 item 1: a cover that sat on the removed file moves (or clears) by the one cover rule

  res.status(200).json({
    ok:         true,
    mediaCount: counts.mediaCount,
    hasVideo:   counts.hasVideo,
  });
});

/* ============================================================================
 * GET /api/postcards/stamp-overlay-options — stamps the caller may overlay
 * ============================================================================
 * Returns ONLY the caller's own earned stamps plus definitions matching the
 * given location (contextually eligible) — never other users' inventory.
 * Filters to approved + active universal artwork. Suggested stamps are
 * surfaced for the post's location but NEVER auto-applied — applying stays an
 * explicit user action in the composer.
 */
const overlayOptionsQuerySchema = z.object({
  city:    z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  q:       z.string().max(100).optional(),
});

const OVERLAY_DEF_COLUMNS = 'id, name, city, country, rarity, is_active, universal_artwork_url';

/** Escape LIKE wildcards in user input — we want literal matching only. */
const escLike = (s: string) => s.trim().replace(/[%_]/g, (ch) => '\\' + ch);

function hasOverlayArtwork(def: any): boolean {
  return !!def && def.is_active === true && !!def.universal_artwork_url;
}

function toOverlayOption(def: any) {
  return {
    stampDefinitionId: def.id,
    name:       def.name ?? 'Stamp',
    city:       def.city ?? null,
    country:    def.country ?? null,
    rarity:     def.rarity ?? null,
    artworkUrl: def.universal_artwork_url,
  };
}

router.get('/postcards/stamp-overlay-options', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const parsed = overlayOptionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid query');
    return;
  }
  const { city, country, q } = parsed.data;

  // Caller's own earned stamps (excluding revoked) — self-inventory only.
  let earnedDefs: any[] = [];
  try {
    const { data: stampRows, error: stampsErr } = await sc
      .from('user_stamps')
      .select('stamp_definition_id, earned_at')
      .eq('user_id', user.id)
      .eq('is_revoked', false)
      .order('earned_at', { ascending: false })
      .limit(300);
    if (!stampsErr) {
      const ids = [...new Set(
        ((stampRows ?? []) as any[]).map((r) => r.stamp_definition_id).filter(Boolean),
      )] as string[];
      if (ids.length > 0) {
        const { data: defRows } = await sc
          .from('stamp_definitions')
          .select(OVERLAY_DEF_COLUMNS)
          .in('id', ids);
        const byId = new Map(((defRows ?? []) as any[]).map((d) => [d.id, d]));
        // Preserve earned order (most recent first).
        earnedDefs = ids.map((id) => byId.get(id)).filter(hasOverlayArtwork);
      }
    }
  } catch { /* fail-open: empty earned list */ }

  // Location-matching definitions ("For this location"). The ilike queries
  // only narrow candidates — stampDefMatchesLocation() is authoritative.
  let suggestedDefs: any[] = [];
  if (city || country) {
    try {
      const candidates: any[] = [];
      if (city) {
        const { data } = await sc
          .from('stamp_definitions')
          .select(OVERLAY_DEF_COLUMNS)
          .eq('is_active', true)
          .ilike('city', escLike(city))
          .limit(25);
        candidates.push(...((data ?? []) as any[]));
      }
      if (country) {
        const { data } = await sc
          .from('stamp_definitions')
          .select(OVERLAY_DEF_COLUMNS)
          .eq('is_active', true)
          .ilike('country', escLike(country))
          .limit(25);
        candidates.push(...((data ?? []) as any[]));
      }
      const seen = new Set<string>();
      suggestedDefs = candidates.filter((d) => {
        if (!hasOverlayArtwork(d) || seen.has(d.id)) return false;
        seen.add(d.id);
        return stampDefMatchesLocation(d, city ?? null, country ?? null);
      });
      // City-level matches ahead of country-level ones.
      suggestedDefs.sort((a, b) => (a.city ? 0 : 1) - (b.city ? 0 : 1));
    } catch { /* fail-open: no suggestions */ }
  }

  // Free-text search across both lists.
  const needle = normLoc(q);
  const matchesQ = (d: any) =>
    !needle ||
    normLoc(d.name).includes(needle) ||
    normLoc(d.city).includes(needle) ||
    normLoc(d.country).includes(needle);

  const suggestedIds = new Set(suggestedDefs.map((d) => d.id));
  const suggested = suggestedDefs.filter(matchesQ).slice(0, 20).map(toOverlayOption);
  const earned = earnedDefs
    .filter((d) => !suggestedIds.has(d.id))
    .filter(matchesQ)
    .slice(0, 100)
    .map(toOverlayOption);

  res.status(200).json({ suggested, earned });
});

/* ============================================================================
 * PUT /api/postcards/:id/event-link — attach or detach an event link on edit
 * ============================================================================
 * Allows the owner to link (or unlink) a Portava Event after post creation,
 * so the Discovery event-post pipeline stays in sync when the user edits.
 *
 * Body: { eventId: string | null }
 *   - string  → upsert post_event_links row (idempotent; safe to re-send)
 *   - null    → delete the existing row (if any); no-op when absent
 *
 * The DB operation is fire-and-forget relative to the 200 response: errors
 * are logged but never surfaced to the client.  Ownership is verified
 * synchronously so the 403 guard is not bypassed by swallowing errors.
 */
const eventLinkSchema = z.object({
  eventId: z.string().uuid().nullable(),
});

router.put('/postcards/:id/event-link', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { id: postId } = req.params;

  if (!isValidUuid(postId)) { sendError(res, 'invalid_payload', 'Invalid postcard id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const parsed = eventLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid payload');
    return;
  }
  const { eventId } = parsed.data;

  // Verify post ownership (synchronous gate — must not be bypassed).
  const { data: postRow, error: postErr } = await sc
    .from('posts')
    .select('id, author_id')
    .eq('id', postId)
    .eq('status', 'active')
    .maybeSingle();

  if (postErr) {
    req.log.error({ err: postErr }, 'postcards event-link: failed to load post');
    sendError(res, "db_error", "We couldn't update the event link. Please try again.", { exposeDetail: true });
    return;
  }
  if (!postRow) { sendError(res, 'not_found', 'Postcard not found'); return; }
  if ((postRow as any).author_id !== user.id) { sendError(res, 'forbidden', 'Not your postcard'); return; }

  // Fire-and-forget: replace or remove the event link.
  // Always delete any existing row(s) for this post first so that changing
  // from event A to event B leaves only B (upsert on the composite PK would
  // stack a second row instead of replacing A).
  // Errors (e.g. unknown event_id, migration not applied) must never block the response.
  void (async () => {
    try {
      const { error: delErr } = await (sc.from('post_event_links' as any)
        .delete()
        .eq('post_id', postId) as any);
      if (delErr) {
        req.log.warn({ err: delErr, postId }, 'postcards event-link: delete existing links failed (non-fatal)');
        // Do not attempt insert if delete failed — avoid duplicate key errors.
        return;
      }
      if (eventId) {
        const { error: insErr } = await (sc.from('post_event_links' as any)
          .insert({ post_id: postId, event_id: eventId }) as any);
        if (insErr) {
          req.log.warn({ err: insErr, postId, eventId }, 'postcards event-link: insert failed (non-fatal)');
        }
      }
    } catch {
      // Swallow — supplementary operation must never crash the request.
    }
  })();

  res.status(200).json({ ok: true });
});

/* ============================================================================
 * POST /api/postcards/sweep-orphans — clean up abandoned pending uploads
 * ============================================================================
 * Postcards use a two-phase upload: the client PUTs the raw file to a signed
 * Supabase Storage URL, then calls completeUpload() so the server can download,
 * strip EXIF/GPS via Sharp, and re-upload the processed version in place.
 *
 * If the app crashes or the user backs out between the PUT and the completeUpload
 * call, the raw original (potentially carrying EXIF/GPS metadata) is left in
 * storage indefinitely. The post_media row exists (processing_status='pending')
 * but completeUpload() is never called, so no EXIF strip ever runs.
 *
 * This endpoint cleans those orphaned uploads:
 *   1. Find post_media rows with processing_status='pending' older than the
 *      cutoff (default 1 hour — long enough for any real upload to complete).
 *   2. Remove the storage objects (original + feed variant if present).
 *   3. Delete the DB rows.
 *
 * Protected by INTERNAL_API_SECRET (same guard as other internal endpoints).
 * Designed to be called on a schedule (e.g. hourly cron, deployment health job).
 * Fail-safe: a sweep failure is logged but never blocks other operations.
 *
 * Returns { swept, errors } — swept = number of orphans removed.
 */
function requireInternalSecret(req: any, res: any): boolean {
  const secret = process.env['INTERNAL_API_SECRET'];
  if (!secret) {
    res.status(503).json({
      error: 'misconfigured',
      message: 'INTERNAL_API_SECRET is not set; internal endpoints are disabled',
    });
    return false;
  }
  const provided = req.headers['x-internal-secret'];
  // Constant-time compare — a plain !== leaks how many leading characters
  // matched through response timing, which is enough to recover
  // INTERNAL_API_SECRET byte by byte, and that secret gates endpoints which
  // bypass user auth entirely. See safeSecretEquals in lib/http.ts.
  if (!safeSecretEquals(provided, secret)) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal secret' });
    return false;
  }
  return true;
}

/** How old a pending row must be before it is considered an orphan (ms). Defined with the pass, in services/media/PendingUploadSweep.ts. */
const ORPHAN_CUTOFF_MS = PENDING_UPLOAD_ORPHAN_CUTOFF_MS; // 2 h 30 of no activity — census-discovery §81 (D-W10S2-6)

router.post('/postcards/sweep-orphans', async (req, res) => {
  if (!requireInternalSecret(req, res)) return;

  const sc = getServiceClient();
  if (!sc) {
    res.status(503).json({ error: 'server_not_configured', message: 'Service client not ready' });
    return;
  }

  // ── census-discovery §56 (DV-77) — the pass moved, the rules did not ─────────
  //
  // What used to be written out here is now `sweepAbandonedPendingUploads` in
  // services/media/PendingUploadSweep.ts, called by THIS manual trigger and by
  // lib/media/pendingUploadSweepScheduler.ts — the scheduler this endpoint's
  // header asked for ("designed to be called on a schedule") and never had.
  // Two copies of a deletion pass drift, and the drift is invisible until one of
  // them deletes a row the other would have kept.
  //
  // The four rules this block used to state in code, and still holds, are:
  //
  //   1. Only `processing_status = 'pending'` rows older than the cutoff. Pending
  //      is exactly "not yet stripped": /complete strips in place, THEN marks
  //      the row ready, and a /complete that refuses the bytes leaves it pending.
  //   2. Storage objects BEFORE the row. `remove` reports failure in `{ error }`
  //      rather than by rejecting; a failed removal KEEPS the row so the next
  //      pass can find the bytes again. Deleting the row first would strand the
  //      object permanently — nothing else records where it is.
  //   3. The resumable-upload artifacts (parts, poster) under the same rule.
  //   4. A missing object is not an error: every step is idempotent, so two
  //      passes racing on one row, or a retry after a partial pass, converge.
  //
  // And three it did not have, each stated where it is implemented: the read is
  // ordered OLDEST FIRST, so a backlog larger than one batch cannot starve the
  // oldest raw original; a row with no recorded `storage_path` has its path
  // DERIVED (the old block removed nothing for it and then deleted the only
  // pointer to the bytes); and a row is re-read as still pending immediately
  // before its bytes are removed, so one that completed meanwhile is not
  // stripped of the file it now serves.
  //
  // The response is unchanged: `{ swept, errors }`, and 500 `db_error` when the
  // pending rows cannot be read — never `{ swept: 0 }` for a read that failed.
  //
  // WHAT THIS DOES NOT CHANGE: who may call it (INTERNAL_API_SECRET, compared
  // in constant time above), the cutoff (the same one hour), or the batch (the
  // same 200). The cutoff and the batch are the values this endpoint shipped
  // with on 2026-08-11; neither has been ratified, and §56 says so.
  //
  // The lines below this comment are the whole handler now. The comment is this
  // long on purpose: census-media and census-discovery cite later lines of this
  // file by number (the moderation literals, the postcard-sync helpers), and a
  // shorter block here would move every one of them. It is documentation of the
  // moved rules rather than padding, and it is the only place a reader of this
  // route will look for them.
  //
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // The manual trigger ignores the scheduler's flag on purpose. It is an
  // operator's explicit act behind the internal secret; the flag
  // (`media_pending_upload_sweep_enabled`, migration 3400, seeded FALSE) gates
  // only the UNATTENDED pass, which is the one that needs an owner's decision.
  //
  // An operator who calls this is doing, once, exactly what the scheduler would
  // do every hour with the flag on — no more, no less.
  //
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // Retry semantics, for the operator: calling this twice in a row is safe. The
  // second call finds the rows the first could not finish (their counts are in
  // `errors`) and tries them again; rows the first call finished are gone.
  //
  // Concurrency, for the operator: this and the scheduler may run at once, on
  // one instance or several. Both use the same idempotent steps, so the worst
  // outcome is a row counted in `errors` by the pass that lost the race.
  //
  // What the pass reports: `examined` rows read, `swept` rows whose bytes and
  // row are gone, `errors` rows kept for the next pass, and `more` when the
  // batch was full. Only `swept` and `errors` are returned here, as before.
  //
  const result = await sweepAbandonedPendingUploads(sc, { cutoffMs: ORPHAN_CUTOFF_MS, log: req.log });
  if (!result.ok) {
    req.log?.error?.({ reason: result.reason }, 'sweep-orphans: failed to fetch pending rows');
    res.status(500).json({ error: 'db_error', message: 'Failed to load orphaned rows' });
    return;
  }

  res.status(200).json({ swept: result.swept, errors: result.errors });
});

export default router;

// ── Media §37 (video duration, poster, resumable parts) ──────────────────────
// Imported at the TAIL so no line above moves: census-media.md cites this file
// by line (the pending/approved moderation literals). ESM hoists imports, so
// placement does not change evaluation order.
import { probeVideoContainer, resolveStoredDuration, type VideoProbe } from '../lib/videoMetadata.js';
import { admissiblePosterPath } from '../lib/mediaPosterPath.js';
import { removeTransportArtifacts } from '../lib/postcardMediaTransport.js';  import { sweepAbandonedPendingUploads, PENDING_UPLOAD_ORPHAN_CUTOFF_MS } from '../services/media/PendingUploadSweep.js';  // census-discovery §56 (DV-77)

// census-media §37 (MD269/MD283): the §36 safety-moderation stage decides the value /complete
// writes. Off (the seed), it is 'approved', as before. Imported at the TAIL, like the block above.
import { preDistributionPostMediaStatus } from '../lib/media/vendors/mediaVendorStages.js';

// ── census-media §37.8: what counts toward a postcard, and what may be its cover ──
// A file counts — in media_count, has_video and primary_media_type, and as the
// passport cover (`firstReadyUrl`) — only when it is READY and DISTRIBUTABLE.
// The moderation half is the same deny-set every post_media distribution reader
// applies (lib/mediaEligibility NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES:
// flagged, limited, rejected, removed, owner_deleted). Before this, a file an
// admin flagged or rejected, and — once 3356 is on — a file the §36 stage HOLDS
// (`flagged`), still counted, and could be copied into
// `passport_postcards.media_url`. Declared at the tail so no cited line moves;
// a function declaration is hoisted.
export function countsTowardPostcard(row: { moderation_status?: unknown }): boolean {
  return !NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES.has(String(row?.moderation_status ?? ''));
}
import { NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES } from '../lib/mediaEligibility.js';

// ── census-media §37.9: a moderation decision re-runs the postcard step ──────
//
// §37.8 made the count and the cover read only files that are READY and
// distributable, but only the upload path (/complete) and the owner's delete
// ever re-derived them. POST /admin/media/:id/moderate flips a post_media
// row's moderation_status (and its `delete` removes the row) without either, so:
//   • a moderator RELEASING a held file left the postcard at media_count 0 and
//     with no passport postcard, for good (§37.8.7 item 1);
//   • a moderator FLAGGING or REJECTING a counted file left it counted, and left
//     it as the passport cover.
// The admin route now calls `syncPostcardAfterModeration`, which decides from
// the SAME two predicates refreshMediaCounts applies (ready, and
// countsTowardPostcard) whether the file's countability changed, and if it did
// runs `syncPostcardAfterMediaChange` — the one step /complete runs. The count
// rule lives in refreshMediaCounts alone.

export type PostcardMediaCounts = Awaited<ReturnType<typeof refreshMediaCounts>>;

/** Does this post_media row count toward its postcard? The two filters refreshMediaCounts applies, composed. */
export function isCountedPostcardFile(row: { processing_status?: unknown; moderation_status?: unknown }): boolean {
  return row?.processing_status === 'ready' && countsTowardPostcard(row);
}

export type PassportCoverOutcome = 'kept' | 'repointed' | 'filled' | 'cleared' | 'no_postcard' | 'failed'; // census-media §37.10: 'cleared' replaces 'no_countable_file'; 'filled' gives a cleared cover the first file that counts again

/**
 * A passport postcard whose cover is a file of this post that NO LONGER counts
 * (held, flagged, rejected — or removed, passed in `alsoGone`) moves to the
 * first file that does. A cover that is not one of this post's uncounted files
 * is left alone: this never rewrites a cover it cannot prove is stale. With no
 * file left that counts the cover is CLEARED to null (census-media §37.10 item
 * 3; needs 3359), and a null cover is FILLED once a file counts again. NEVER throws.
 */
async function repointPassportCover(
  sc: any,
  postId: string,
  counts: PostcardMediaCounts,
  req: { log: { warn: (...args: any[]) => void } },
  alsoGone: readonly string[] = [],
): Promise<PassportCoverOutcome> {
  try {
    if (counts.unread) return 'failed'; // census-media §37.10: an unread recount proves nothing about the cover — write nothing
    const { data, error } = await sc.from('passport_postcards').select('id, media_url').eq('post_id', postId).maybeSingle();
    if (error) return 'failed';
    if (!data) return 'no_postcard';
    const cover = String((data as any).media_url ?? ''); const next = counts.firstReadyUrl ?? null;
    if (cover && !(counts.uncountedUrls.includes(cover) || alsoGone.includes(cover))) return 'kept'; // not provably stale: left alone
    if ((cover || null) === next) return 'kept'; // no cover, and no file that counts: nothing to write
    // census-media §37.10 item 3: with no file left that counts the cover is cleared to null, never left on a held or removed file
    const { error: upErr } = await sc.from('passport_postcards').update({ media_url: next }).eq('id', (data as any).id);
    if (upErr) { req.log.warn({ postId, err: upErr, clearing: next === null }, next === null ? 'postcards: the passport cover could not be CLEARED — passport_postcards.media_url is NOT NULL until 3359 is applied' : 'postcards: the passport cover could not be moved'); return 'failed'; }
    return next === null ? 'cleared' : cover ? 'repointed' : 'filled';
  } catch {
    return 'failed';
  }
}

export type PostcardModerationSync =
  /** The file counted before and after (or neither): nothing to re-derive. */
  | { state: 'unchanged' }
  /** Countability changed (or the prior state was unknown): the postcard step ran. */
  | { state: 'synced'; mediaCount: number; cover: PassportCoverOutcome }
  /** The step could not run (no post id, the recount's read failed — nothing was written — or it threw). */
  | { state: 'failed' };

/**
 * After a moderator changed (or deleted) one post_media row: re-run the
 * postcard step when the file's countability changed. `before` is the row as it
 * was (null when it could not be read — then the step runs, because a recount
 * converges on the rule whatever the prior state was); `after` is its new
 * moderation_status, or null when the row was deleted. NEVER throws.
 */
export async function syncPostcardAfterModeration(
  sc: any,
  input: {
    postId: string | null | undefined;
    ownerUserId: string | null | undefined;
    before: { processing_status?: unknown; moderation_status?: unknown; public_url?: unknown } | null;
    after: string | null; /** census-media §37.10 item 4: the file to re-read after the step; a status that moved meanwhile re-runs it. */ recheckMediaId?: string;
  },
  req: { log: { warn: (...args: any[]) => void } },
): Promise<PostcardModerationSync> {
  const postId = typeof input.postId === 'string' && input.postId ? input.postId : null;
  if (!postId) return { state: 'failed' };
  const wasCounted = input.before ? isCountedPostcardFile(input.before) : null;
  const isCounted = input.after === null || !input.before
    ? false
    : isCountedPostcardFile({ processing_status: input.before.processing_status, moderation_status: input.after });
  if (wasCounted !== null && wasCounted === isCounted) return { state: 'unchanged' };
  try {
    const gone = input.after === null && typeof input.before?.public_url === 'string' ? [input.before.public_url] : [];
    let step = await runPostcardStepForModeration(sc, postId, input.ownerUserId, req, gone);
    // census-media §37.10 item 4: re-read after the write. The recount reads, then
    // writes; a second moderator's decision landing between the two leaves this
    // step's write stale. A file whose status is no longer the one this decision
    // wrote re-runs the step, which then reads the rows as they are (bounded).
    let expected: string | null = input.after;
    for (let rerun = 0; input.recheckMediaId && !step.unread && rerun < MODERATION_STEP_RERUNS; rerun++) {
      const now = await readModerationStatusNow(sc, input.recheckMediaId);
      if (!now.read || now.status === expected) break;
      expected = now.status; // the re-run reads the rows as they are at this status
      step = await runPostcardStepForModeration(sc, postId, input.ownerUserId, req, gone);
    }
    if (step.unread) {
      req.log.warn({ postId }, 'postcards: the post_media read for the recount could not run after a moderation decision — counts left as they were');
      return { state: 'failed' };
    }
    return { state: 'synced', mediaCount: step.mediaCount, cover: step.cover };
  } catch (err) {
    req.log.warn({ err, postId }, 'postcards: re-deriving the postcard after a moderation decision failed');
    return { state: 'failed' };
  }
}

// ── census-media §37.10: the moderation step's owner, its re-read, and its result ──

/** What the postcard step returns: the recount, and what happened to the passport cover. */
export type PostcardStepResult = PostcardMediaCounts & { cover: PassportCoverOutcome };

/** How many times a moderation step re-runs after finding its file's status moved (census-media §37.10 item 4). */
export const MODERATION_STEP_RERUNS = 2;

/**
 * census-media §37.10 item 5. The passport postcard belongs to the post's
 * author: /postcards/:id/media/upload-url makes a slot only for the author, so
 * post_media.user_id IS the author (and is NOT NULL in the baseline). When the
 * moderation path has no uploader id (both of its reads of the row came back
 * without one) the author is read from the post, and the step runs whole. Only
 * when no author can be read either does it recount and move the cover without
 * making a passport postcard, whose user_id is NOT NULL: there is nobody to
 * make it for, and that is logged rather than guessed.
 */
async function runPostcardStepForModeration(
  sc: any,
  postId: string,
  ownerUserId: string | null | undefined,
  req: { log: { warn: (...args: any[]) => void } },
  gone: readonly string[],
): Promise<PostcardStepResult> {
  let owner = typeof ownerUserId === 'string' && ownerUserId ? ownerUserId : null;
  if (!owner) {
    const { data, error } = await sc.from('posts').select('author_id').eq('id', postId).maybeSingle();
    owner = !error && typeof (data as any)?.author_id === 'string' && (data as any).author_id ? (data as any).author_id : null;
    if (!owner) req.log.warn({ postId }, 'postcards: no uploader and no readable post author — recount and cover only, no passport postcard is made');
  }
  if (owner) return syncPostcardAfterMediaChange(sc, postId, { id: owner }, req, gone);
  const counts = await refreshMediaCounts(sc, postId);
  return { ...counts, cover: await repointPassportCover(sc, postId, counts, req, gone) };
}

/** The file's moderation status now: `status: null` when the row is gone; `read: false` when it could not be read. */
async function readModerationStatusNow(sc: any, mediaId: string): Promise<{ read: boolean; status: string | null }> {
  try {
    const { data, error } = await sc.from('post_media').select('moderation_status').eq('id', mediaId).maybeSingle();
    if (error) return { read: false, status: null };
    return { read: true, status: data ? String((data as any).moderation_status ?? '') : null };
  } catch {
    return { read: false, status: null };
  }
}
