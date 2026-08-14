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
import { requireUser, sendError } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { processTagging } from '../services/tagging/TaggingService.js';
import { isKillSwitchEngaged } from '../lib/featureFlags.js';
import { sniffMedia, processImage, computePHash, makeFeedVariant } from '../lib/mediaProcessing.js';

const router = Router();

const STORAGE_BUCKET = 'post-media';
const MAX_MEDIA_PER_POSTCARD = 10;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;  // 100 MB
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;   // 20 MB

const ALLOWED_MIME: Record<string, { mediaType: 'image' | 'video'; ext: string }> = {
  'image/jpeg':      { mediaType: 'image', ext: 'jpg' },
  'image/jpg':       { mediaType: 'image', ext: 'jpg' },
  'image/png':       { mediaType: 'image', ext: 'png' },
  'image/webp':      { mediaType: 'image', ext: 'webp' },
  'image/heic':      { mediaType: 'image', ext: 'heic' },
  'video/mp4':       { mediaType: 'video', ext: 'mp4' },
  'video/quicktime': { mediaType: 'video', ext: 'mov' },
  'video/webm':      { mediaType: 'video', ext: 'webm' },
};

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
  firstReadyUrl: string | null;
}> {
  const { data: mediaRows } = await sc
    .from('post_media')
    .select('media_type, processing_status, public_url, sort_order')
    .eq('post_id', postId);

  const ready = ((mediaRows ?? []) as any[])
    .filter((r: any) => r.processing_status === 'ready')
    .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

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

  return { mediaCount, hasVideo, primaryMediaType, firstReadyUrl };
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

  const parsed = createPostcardSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid payload');
    return;
  }
  const p = parsed.data;

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

  // Emergency media kill switch (audit: this path previously ignored it).
  // Fail-CLOSED: an unreadable stop engages.
  if (await isKillSwitchEngaged(sc, 'disable_media_uploads')) {
    sendError(res, 'feature_disabled', 'Media uploads are temporarily disabled');
    return;
  }

  const parsed = uploadUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid payload');
    return;
  }
  const { mimeType, fileSizeBytes } = parsed.data;

  // MIME validation
  const mimeInfo = ALLOWED_MIME[mimeType];
  if (!mimeInfo) {
    sendError(res, 'invalid_payload', `Unsupported MIME type: ${mimeType}. Supported: ${Object.keys(ALLOWED_MIME).join(', ')}`);
    return;
  }

  // Size validation
  const sizeLimit = mimeInfo.mediaType === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (fileSizeBytes > sizeLimit) {
    const limitMB = Math.round(sizeLimit / 1024 / 1024);
    sendError(res, 'invalid_payload', `File too large. Maximum ${limitMB} MB for ${mimeInfo.mediaType}.`);
    return;
  }

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
  await sc
    .from('post_media')
    .update({ storage_path: storagePath })
    .eq('id', mediaId)
    .then(undefined, () => {});

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
  // place, and measure real dimensions server-side. Fail-closed for images —
  // a corrupt image rejects completion (retryable) rather than skipping the
  // GPS strip. Videos are untouched (no transcode tier; documented).
  let measuredWidth: number | null = null;
  let measuredHeight: number | null = null;
  let computedPhash: string | null = null;
  let feedStoragePath: string | null = null;
  let feedUrl: string | null = null;
  if ((mediaRow as any).media_type === 'image') {
    try {
      const dl = await sc.storage.from(STORAGE_BUCKET).download(storagePath);
      if ((dl as any).error || !(dl as any).data) throw new Error((dl as any).error?.message ?? 'download failed');
      const rawBuf = Buffer.from(await (dl as any).data.arrayBuffer());
      const sniffed = sniffMedia(rawBuf);
      if (!sniffed || sniffed.kind !== 'image') throw new Error('uploaded bytes are not an image');
      const img = await processImage(rawBuf, sniffed);
      const { error: reErr } = await sc.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, img.buffer, { contentType: img.mime, upsert: true });
      if (reErr) throw new Error(reErr.message);
      measuredWidth = img.width;
      measuredHeight = img.height;
      // Perceptual hash for near-duplicate detection. Fail-soft: null hash
      // never blocks completion — the dedup worker skips rows where phash IS NULL.
      computedPhash = await computePHash(img.buffer);

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
      req.log.error({ err, mediaId }, 'postcards: image processing failed — completion rejected (retryable)');
      sendError(res, 'invalid_payload', 'Image could not be processed. Please re-upload.');
      return;
    }
  }

  // Compute thumbnail bare bucket/path if client supplied a thumbnail path
  let thumbnailUrl: string | null = null;
  if (p.thumbnailPath) {
    thumbnailUrl = `${STORAGE_BUCKET}/${p.thumbnailPath}`;
  }

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
    moderation_status:      'approved',
    public_url:             publicUrl,
    mime_type:              p.mimeType,
    file_size_bytes:        p.fileSizeBytes,
    duration_seconds:       p.durationSeconds ?? null,
    // Server-measured dimensions win over client-declared (audit trust fix).
    width:                  measuredWidth ?? p.width ?? null,
    height:                 measuredHeight ?? p.height ?? null,
    thumbnail_url:          thumbnailUrl,
    thumbnail_storage_path: p.thumbnailPath ?? null,
    updated_at:             new Date().toISOString(),
    // Perceptual hash for near-duplicate grouping (null for videos or when
    // computation failed — worker skips rows with phash IS NULL).
    phash:                  computedPhash,
  };

  // Dimension guard: width and height must be present before we can flip the
  // row to 'ready'. For images this is guaranteed — server-side processing
  // always measures dimensions (and rejects on failure). For videos the values
  // come from the client; if they are missing we must refuse rather than write
  // a NULL-dimension row that the thumbnail pipeline (migration 0208) would
  // silently skip on every future pass.
  if (baseUpdate.width === null || baseUpdate.height === null) {
    req.log.warn({ mediaId, mediaType: (mediaRow as any).media_type }, 'postcards: complete rejected — width/height required');
    sendError(res, 'invalid_payload', 'width and height are required to complete this upload.');
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

  // Refresh parent counts and get first-ready URL for postcard creation
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
      await sc
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
        .then(undefined, (err: any) => {
          req.log.warn({ err }, 'postcards: passport_postcard auto-create failed (non-fatal)');
        });
    }
  }

  res.status(200).json({
    ok: true,
    mediaCount: counts.mediaCount,
    hasVideo:   counts.hasVideo,
    ...(p.stampOverlay
      ? overlay
        ? { stampOverlayApplied: true }
        : { stampOverlayApplied: false, stampOverlayError: overlayError ?? 'stamp_unavailable' }
      : {}),
  });
});

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
    .select('id, user_id, post_id, storage_bucket, storage_path, processing_status')
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
  }

  // Re-derive parent media counts
  const counts = await refreshMediaCounts(sc, postId);

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
  if (provided !== secret) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal secret' });
    return false;
  }
  return true;
}

/** How old a pending row must be before it is considered an orphan (ms). */
const ORPHAN_CUTOFF_MS = 60 * 60 * 1000; // 1 hour

router.post('/postcards/sweep-orphans', async (req, res) => {
  if (!requireInternalSecret(req, res)) return;

  const sc = getServiceClient();
  if (!sc) {
    res.status(503).json({ error: 'server_not_configured', message: 'Service client not ready' });
    return;
  }

  const cutoff = new Date(Date.now() - ORPHAN_CUTOFF_MS).toISOString();

  // Load orphaned pending rows (cap at 200 per sweep to bound latency).
  const { data: orphans, error: fetchErr } = await sc
    .from('post_media')
    .select('id, storage_path, storage_bucket')
    .eq('processing_status', 'pending')
    .lt('created_at', cutoff)
    .limit(200);

  if (fetchErr) {
    req.log?.error?.({ err: fetchErr }, 'sweep-orphans: failed to fetch pending rows');
    res.status(500).json({ error: 'db_error', message: 'Failed to load orphaned rows' });
    return;
  }

  const rows = (orphans ?? []) as Array<{ id: string; storage_path: string; storage_bucket: string }>;
  if (rows.length === 0) {
    res.status(200).json({ swept: 0, errors: 0 });
    return;
  }

  let swept = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      // Remove storage objects (original + any feed variant) BEFORE deleting
      // the DB row. Order matters: if storage removal fails, we KEEP the DB row
      // so a subsequent sweep can retry. Deleting the DB row first would orphan
      // the storage object permanently — the sweep could never find it again.
      //
      // `remove` reports errors in the resolved `{ error }` field, not via
      // rejection. A missing object is not an error (idempotent); a genuine
      // bucket failure IS an error that must keep the row alive for retry.
      if (row.storage_path) {
        const { error: rmErr } = await sc.storage
          .from(row.storage_bucket || STORAGE_BUCKET)
          .remove([row.storage_path, `${row.storage_path}.feed.jpg`]);
        if (rmErr) {
          req.log?.warn?.({ err: rmErr, mediaId: row.id, storagePath: row.storage_path },
            'sweep-orphans: storage removal failed — retaining DB row for retry');
          errors++;
          continue; // Leave the DB row so the next sweep can try again.
        }
      }

      // Storage objects gone (or there was no path). Now safe to delete the row.
      const { error: delErr } = await sc
        .from('post_media')
        .delete()
        .eq('id', row.id);

      if (delErr) {
        req.log?.warn?.({ err: delErr, mediaId: row.id }, 'sweep-orphans: failed to delete row');
        errors++;
      } else {
        swept++;
      }
    } catch (err) {
      req.log?.warn?.({ err, mediaId: row.id }, 'sweep-orphans: unexpected error for row');
      errors++;
    }
  }

  res.status(200).json({ swept, errors });
});

export default router;
