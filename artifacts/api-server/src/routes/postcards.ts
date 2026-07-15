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
});
// NOTE: `eventId` was removed from this schema. posts has no event_id column
// (event feeds live in the separate event_posts table); writing it made
// PostgREST reject EVERY composer insert with PGRST204 → db_error. zod objects
// are non-strict, so legacy clients still sending eventId are ignored safely.

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
    sendError(res, 'db_error', "We couldn't create your postcard. Please try again.");
    return;
  }

  const postId = (post as any).id as string;

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
    sendError(res, 'db_error', "We couldn't prepare your upload. Please try again.");
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
    sendError(res, 'db_error', "We couldn't prepare your upload. Please try again.");
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
    sendError(res, 'db_error', "We couldn't prepare your upload. Please try again.");
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
  width:           z.number().int().positive().optional(),
  height:          z.number().int().positive().optional(),
  thumbnailPath:   z.string().max(500).optional(),
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
    sendError(res, 'db_error', "We couldn't finish your upload. Please try again.");
    return;
  }
  if (!mediaRow) { sendError(res, 'not_found', 'Media not found'); return; }
  if ((mediaRow as any).user_id !== user.id) { sendError(res, 'forbidden', 'Not your media'); return; }

  // Idempotent: already ready
  if ((mediaRow as any).processing_status === 'ready') {
    res.status(200).json({ ok: true });
    return;
  }

  // Compute public URL from storage path
  const storagePath = (mediaRow as any).storage_path as string;
  const { data: urlData } = sc.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
  const publicUrl = (urlData as any)?.publicUrl ?? '';

  // Compute thumbnail public URL if client supplied a thumbnail path
  let thumbnailUrl: string | null = null;
  if (p.thumbnailPath) {
    const { data: tData } = sc.storage.from(STORAGE_BUCKET).getPublicUrl(p.thumbnailPath);
    thumbnailUrl = (tData as any)?.publicUrl ?? null;
  }

  // Mark ready + store metadata
  const { error: updateErr } = await sc
    .from('post_media')
    .update({
      processing_status:      'ready',
      moderation_status:      'approved',
      public_url:             publicUrl,
      mime_type:              p.mimeType,
      file_size_bytes:        p.fileSizeBytes,
      duration_seconds:       p.durationSeconds ?? null,
      width:                  p.width ?? null,
      height:                 p.height ?? null,
      thumbnail_url:          thumbnailUrl,
      thumbnail_storage_path: p.thumbnailPath ?? null,
      updated_at:             new Date().toISOString(),
    })
    .eq('id', mediaId);

  if (updateErr) {
    req.log.error({ err: updateErr }, 'postcards: failed to complete media upload');
    sendError(res, 'db_error', "We couldn't finish your upload. Please try again.");
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
    sendError(res, 'db_error', "We couldn't remove that media. Please try again.");
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
    sendError(res, 'db_error', "We couldn't remove that media. Please try again.");
    return;
  }

  // Remove from storage (best-effort — do not fail if storage removal fails)
  const storagePath = (mediaRow as any).storage_path as string;
  if (storagePath) {
    await sc.storage.from(STORAGE_BUCKET).remove([storagePath]).then(undefined, () => {});
  }

  // Re-derive parent media counts
  const counts = await refreshMediaCounts(sc, postId);

  res.status(200).json({
    ok:         true,
    mediaCount: counts.mediaCount,
    hasVideo:   counts.hasVideo,
  });
});

export default router;
