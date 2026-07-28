/**
 * Content translation route
 *
 * GET /api/content/:entityType/:entityId/translation?lang=<iso>
 *
 * On-demand translation for posts, comments, events, trips, and bios.
 * Caches results in the `content_translations` table so repeat requests
 * for the same (entity, language) pair are served instantly.
 *
 * Authorization: each entity type re-uses the same visibility / access rules as
 * its primary read route — private/blocked/member-only content is rejected.
 */
import { Router } from 'express';
import { requireUser, sendError, isAcceptedTripMember } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  translateContentFields,
  type ContentEntityType,
  type TranslatedFields,
} from '../services/contentTranslation.js';

const router = Router();

const VALID_ENTITY_TYPES = new Set<string>(['post', 'comment', 'event', 'trip', 'bio']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// ── Per-entity authorization guards ──────────────────────────────────────────

/**
 * Check whether viewerId can read a post.
 * Returns the post row if permitted, null otherwise.
 * Mirrors the access rules in GET /posts/:postId.
 */
async function authorizePost(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  postId: string,
  viewerId: string,
) {
  const { data: post } = await sc
    .from('posts')
    .select('id, author_id, visibility, trip_id, content, original_language, post_status')
    .eq('id', postId)
    .eq('status', 'active')
    .maybeSingle();
  if (!post) return null;

  const visibility = (post as any).visibility as string;

  // Unpublished posts (pending_location_exit, pending_delay, etc.) are author-only.
  // Mirrors the "author sees own pending; others need published" rule in GET /posts/:postId.
  const postStatus = (post as any).post_status as string | null;
  if (postStatus && postStatus !== 'published') {
    if ((post as any).author_id !== viewerId) return null;
  }

  // Block check: either direction
  const { count: blockCount } = await sc
    .from('blocks')
    .select('id', { count: 'exact', head: true })
    .or(`and(blocker_id.eq.${viewerId},blocked_id.eq.${(post as any).author_id}),and(blocker_id.eq.${(post as any).author_id},blocked_id.eq.${viewerId})`);
  if ((blockCount ?? 0) > 0) return null;

  // Private post: only the author
  if (visibility === 'private') {
    if ((post as any).author_id !== viewerId) return null;
  }

  // trip_only: must be accepted trip member
  if (visibility === 'trip_only') {
    const tripId = (post as any).trip_id as string | null;
    if (!tripId) return null;
    // Use user-scoped client for RLS-based membership check
    const isMember = await isAcceptedTripMember(sc, tripId, viewerId);
    if (!isMember) return null;
  }

  // followers_only: must follow the author
  if (visibility === 'followers') {
    if ((post as any).author_id !== viewerId) {
      const { count: followCount } = await sc
        .from('user_follows')
        .select('follower_id', { count: 'exact', head: true })
        .eq('follower_id', viewerId)
        .eq('following_id', (post as any).author_id);
      if ((followCount ?? 0) === 0) return null;
    }
  }

  return post as any;
}

/**
 * Check whether viewerId can read a comment.
 * The comment is readable if the parent post is readable.
 */
async function authorizeComment(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  commentId: string,
  viewerId: string,
) {
  const { data: comment } = await sc
    .from('posts_comments')
    .select('id, post_id, body, original_language')
    .eq('id', commentId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!comment) return null;

  // Delegate post-level authorization
  const post = await authorizePost(sc, (comment as any).post_id, viewerId);
  if (!post) return null;

  return comment as any;
}

/**
 * Check whether viewerId can read an event.
 * Mirrors canViewEvent() + isBlocked() from events.ts exactly:
 *  - block check overrides all other relationships
 *  - host always allowed
 *  - co_host/moderator role always allowed
 *  - public events: only if state is NOT draft/cancelled/archived
 *  - friends_only: friendship OR existing RSVP/role
 *  - circle: circle membership
 *  - trip: trip member
 *  - invite_only/unknown: RSVP or role
 */
async function authorizeEvent(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  eventId: string,
  viewerId: string,
) {
  const { data: ev } = await sc
    .from('events')
    .select('id, host_id, visibility, state, circle_id, trip_id, title, description, original_language')
    .eq('id', eventId)
    .maybeSingle();
  if (!ev) return null;
  const e = ev as any;

  // Block check — overrides all other relationships.
  const { data: blockRows } = await sc
    .from('blocks')
    .select('id')
    .or(`and(blocker_id.eq.${viewerId},blocked_id.eq.${e.host_id}),and(blocker_id.eq.${e.host_id},blocked_id.eq.${viewerId})`)
    .limit(1);
  if (((blockRows as any[]) ?? []).length > 0) return null;

  // Host always has access.
  if (e.host_id === viewerId) return e;

  // Staff (co_host/moderator) always have access.
  const { data: staffRole } = await sc
    .from('event_roles')
    .select('role')
    .eq('event_id', eventId)
    .eq('user_id', viewerId)
    .maybeSingle();
  if (staffRole && ['co_host', 'moderator'].includes((staffRole as any).role)) return e;

  const visibility = e.visibility as string;
  const state = e.state as string;

  if (visibility === 'public') {
    // Public events are blocked if draft/cancelled/archived.
    if (['draft', 'cancelled', 'archived'].includes(state)) return null;
    return e;
  }

  if (visibility === 'friends_only') {
    const { data: friendship } = await sc
      .from('user_friendships')
      .select('user_a')
      .or(`and(user_a.eq.${viewerId},user_b.eq.${e.host_id}),and(user_b.eq.${viewerId},user_a.eq.${e.host_id})`)
      .maybeSingle();
    if (friendship) return e;
    // Also allow existing attendees/role holders.
    const [rsvp, role] = await Promise.all([
      sc.from('event_rsvps').select('status').eq('event_id', eventId).eq('user_id', viewerId).maybeSingle(),
      sc.from('event_roles').select('role').eq('event_id', eventId).eq('user_id', viewerId).maybeSingle(),
    ]);
    return (rsvp as any).data || (role as any).data ? e : null;
  }

  if (visibility === 'circle') {
    if (!e.circle_id) return null;
    // Circle membership: owner (circle_id === userId) or explicit member row.
    if (e.circle_id === viewerId) return e;
    const { data: mem } = await sc
      .from('circle_memberships')
      .select('other_id')
      .eq('user_id', e.circle_id)
      .eq('other_id', viewerId)
      .maybeSingle();
    return mem ? e : null;
  }

  if (visibility === 'trip') {
    if (!e.trip_id) return null;
    const { data: tripMem } = await sc
      .from('trip_members')
      .select('role')
      .eq('trip_id', e.trip_id)
      .eq('user_id', viewerId)
      .maybeSingle();
    if (!tripMem) return null;
    const tm = tripMem as any;
    const acceptedRoles = ['owner', 'co_host', 'member', 'viewer'];
    if (!acceptedRoles.includes(tm.role)) return null;
    if (tm.status != null && tm.status !== 'accepted') return null;
    return e;
  }

  // invite_only / unknown: must have RSVP or role.
  const [rsvp, role] = await Promise.all([
    sc.from('event_rsvps').select('status').eq('event_id', eventId).eq('user_id', viewerId).maybeSingle(),
    sc.from('event_roles').select('role').eq('event_id', eventId).eq('user_id', viewerId).maybeSingle(),
  ]);
  return (rsvp as any).data || (role as any).data ? e : null;
}

/**
 * Check whether viewerId can read a trip.
 * Public trips are open; private trips require accepted membership.
 */
async function authorizeTrip(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  tripId: string,
  viewerId: string,
) {
  const { data: trip } = await sc
    .from('trips')
    .select('id, owner_id, visibility, title, trip_notes, original_language')
    .eq('id', tripId)
    .maybeSingle();
  if (!trip) return null;

  const visibility = (trip as any).visibility as string;
  if (visibility === 'public') return trip as any;
  if ((trip as any).owner_id === viewerId) return trip as any;

  // buddies/private: must be accepted member
  const isMember = await isAcceptedTripMember(sc, tripId, viewerId);
  if (!isMember) return null;

  return trip as any;
}

/**
 * Check whether viewerId can read a bio.
 * Public profiles are open; private profiles require a follow.
 */
async function authorizeBio(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  profileId: string,
  viewerId: string,
) {
  const { data: profile } = await sc
    .from('profiles')
    .select('id, is_private, bio, bio_original_language')
    .eq('id', profileId)
    .maybeSingle();
  if (!profile || !(profile as any).bio) return null;

  // Block check
  const { count: blockCount } = await sc
    .from('blocks')
    .select('id', { count: 'exact', head: true })
    .or(`and(blocker_id.eq.${viewerId},blocked_id.eq.${profileId}),and(blocker_id.eq.${profileId},blocked_id.eq.${viewerId})`);
  if ((blockCount ?? 0) > 0) return null;

  if (!(profile as any).is_private) return profile as any;
  if (profileId === viewerId) return profile as any;

  // Private profile: must follow
  const { count: followCount } = await sc
    .from('user_follows')
    .select('follower_id', { count: 'exact', head: true })
    .eq('follower_id', viewerId)
    .eq('following_id', profileId);
  if ((followCount ?? 0) > 0) return profile as any;

  return null;
}

// ── Entity content + authorization dispatcher ─────────────────────────────────

async function fetchAuthorizedEntityContent(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  entityType: ContentEntityType,
  entityId: string,
  viewerId: string,
): Promise<{ fields: TranslatedFields; sourceLanguage: string | null } | null> {
  switch (entityType) {
    case 'post': {
      const row = await authorizePost(sc, entityId, viewerId);
      if (!row) return null;
      return {
        fields: { content: row.content ?? '' },
        sourceLanguage: row.original_language ?? null,
      };
    }
    case 'comment': {
      const row = await authorizeComment(sc, entityId, viewerId);
      if (!row) return null;
      return {
        fields: { body: row.body ?? '' },
        sourceLanguage: row.original_language ?? null,
      };
    }
    case 'event': {
      const row = await authorizeEvent(sc, entityId, viewerId);
      if (!row) return null;
      const fields: TranslatedFields = { title: row.title ?? '' };
      if (row.description) fields.description = row.description;
      return { fields, sourceLanguage: row.original_language ?? null };
    }
    case 'trip': {
      const row = await authorizeTrip(sc, entityId, viewerId);
      if (!row) return null;
      const fields: TranslatedFields = { title: row.title ?? '' };
      if (row.trip_notes) fields.trip_notes = row.trip_notes;
      return { fields, sourceLanguage: row.original_language ?? null };
    }
    case 'bio': {
      const row = await authorizeBio(sc, entityId, viewerId);
      if (!row) return null;
      return {
        fields: { bio: row.bio },
        // bio_original_language is the auto-detected language of the bio text.
        // default_language is the user's own preference — never used here.
        sourceLanguage: row.bio_original_language ?? null,
      };
    }
    default:
      return null;
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/content/:entityType/:entityId/translation?lang=<iso>
 *
 * Returns translated fields for the given entity. Caches results so repeated
 * calls for the same (entity, lang) pair are served without re-translating.
 *
 * Access control: the caller must be able to read the entity under normal
 * visibility / block / membership rules.  Unauthorized requests get 404
 * (same sentinel as the primary read routes — no existence leakage).
 *
 * Query params:
 *   lang  (required)  — ISO 639-1 target language code, e.g. "es"
 */
router.get('/content/:entityType/:entityId/translation', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { entityType, entityId } = req.params;
  const targetLang = typeof req.query.lang === 'string' ? req.query.lang.trim().toLowerCase() : '';

  if (!VALID_ENTITY_TYPES.has(entityType)) {
    sendError(res, 'invalid_payload', `Invalid entity type. Must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}`);
    return;
  }

  if (!isValidUuid(entityId)) {
    sendError(res, 'invalid_payload', 'Invalid entity id');
    return;
  }

  if (!targetLang || targetLang.length < 2 || targetLang.length > 8) {
    sendError(res, 'invalid_payload', 'lang query param is required (ISO 639-1 code, e.g. "es")');
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, 'server_not_configured', 'Service client not ready');
    return;
  }

  // Fetch entity content with full authorization checks.
  const entityContent = await fetchAuthorizedEntityContent(sc, entityType as ContentEntityType, entityId, user.id);
  if (!entityContent) {
    // Return 404 regardless of reason — no existence/permission leakage.
    sendError(res, 'not_found', 'Entity not found');
    return;
  }

  const { fields, sourceLanguage } = entityContent;

  // If we could not detect the source language at write time, skip.
  if (!sourceLanguage) {
    res.json({ ok: true, skipped: true, reason: 'source_language_unknown' });
    return;
  }

  // Same language — nothing to translate.
  if (sourceLanguage === targetLang) {
    res.json({ ok: true, skipped: true, sourceLanguage, targetLanguage: targetLang });
    return;
  }

  // Filter out empty fields.
  const nonEmptyFields = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => typeof v === 'string' && (v as string).trim().length > 0),
  ) as TranslatedFields;

  if (Object.keys(nonEmptyFields).length === 0) {
    res.json({ ok: true, skipped: true, reason: 'no_translatable_content' });
    return;
  }

  const result = await translateContentFields(sc, {
    entityType: entityType as ContentEntityType,
    entityId,
    fields: nonEmptyFields,
    sourceLanguage,
    targetLanguage: targetLang,
    logger: req.log,
  });

  if (result.status === 'failed') {
    res.json({ ok: false, status: 'failed', error: 'translation_failed' });
    return;
  }

  res.json({
    ok: true,
    status: result.status,
    sourceLanguage: result.sourceLanguage,
    targetLanguage: result.targetLanguage,
    translatedFields: result.translatedFields,
    translationLabel: result.translationLabel,
  });
}));

export default router;
