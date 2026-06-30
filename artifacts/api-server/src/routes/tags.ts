/**
 * Tag routes
 *
 * GET  /api/tags/suggestions         — ranked @-mentionable user suggestions
 * GET  /api/me/tag-permission         — get caller's tag_permission setting
 * PATCH /api/me/tag-permission        — update tag_permission setting
 * DELETE /api/admin/tags/:id          — admin: remove a tag row
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireUser, sendError } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { isUuid } from '../lib/followDecisions.js';
import { resolveInteractionPermissions } from '../services/interactionPermissions.js';
import { isFlagEnabled } from '../lib/featureFlags.js';

const router = Router();

// ─── Admin guard ──────────────────────────────────────────────────────────────

async function requireAdmin(req: any, res: any): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data, error } = await client
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !data || (data as any).role !== 'admin') {
    res.status(403).json({ error: 'forbidden', message: 'Admin role required' });
    return null;
  }

  const sc = getServiceClient() ?? client;
  return { userId: user.id, sc };
}

// ─── POST /api/tags — create a tag (tagger → tagged_user_id) ─────────────────
//
// Body: { source_type: 'post'|'comment'|'message', source_id: uuid, tagged_user_id: uuid }
// Permission engine enforces: block-both-directions → 403, tag_permission gate (canTag).

const VALID_SOURCE_TYPES = new Set(['post', 'comment', 'message', 'place_checkin', 'place_mention']);
// Location-type sources require a friend connection (stricter than default tag_permission).
const LOCATION_SOURCE_TYPES = new Set(['place_checkin', 'place_mention']);

const CreateTagSchema = z.object({
  source_type:    z.string().refine((v) => VALID_SOURCE_TYPES.has(v), 'source_type must be post, comment, or message'),
  source_id:      z.string().refine(isUuid, 'source_id must be a valid UUID'),
  tagged_user_id: z.string().refine(isUuid, 'tagged_user_id must be a valid UUID'),
});

router.post('/tags', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = CreateTagSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const { source_type, source_id, tagged_user_id } = parsed.data;

  if (tagged_user_id === user.id) {
    sendError(res, 'invalid_payload', 'Cannot tag yourself');
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Emergency flag: disable_tagging — fail-open (allow) on DB error
  if (await isFlagEnabled(sc, 'disable_tagging')) {
    sendError(res, 'feature_disabled', 'Tagging is temporarily disabled');
    return;
  }

  // Permission engine — enforces:
  //   1. Block (either direction) → 403
  //   2. tag_permission policy (canTag / canTagPending)
  //   3. Location-type sources require friendship (stricter privacy for location context)
  let perms: Awaited<ReturnType<typeof resolveInteractionPermissions>>;
  try {
    perms = await resolveInteractionPermissions(sc, user.id, tagged_user_id);
  } catch (err) {
    req.log.error({ err }, 'permission engine failed for tag create');
    sendError(res, 'db_error', 'Permission check failed');
    return;
  }

  // Location-type sources require a friend connection regardless of tag_permission setting.
  // canSeeFriendOnlyPosts === isFriend (see permission engine), so it's the correct friendship proxy.
  if (LOCATION_SOURCE_TYPES.has(source_type) && !perms.canSeeFriendOnlyPosts) {
    sendError(res, 'forbidden', 'Location tags require a friend connection');
    return;
  }

  if (!perms.canTag && !perms.canTagPending) {
    sendError(res, 'forbidden', perms.reasonCodes.includes('blocked')
      ? 'Cannot tag a user you have blocked or who has blocked you'
      : 'This user does not allow tags from you');
    return;
  }

  // approval_required: insert with status='pending' and return 202 Accepted
  const tagStatus = perms.canTagPending ? 'pending' : 'approved';

  const { data, error } = await sc
    .from('tags')
    .insert({ source_type, source_id, tagger_id: user.id, tagged_user_id, status: tagStatus })
    .select('id')
    .single();

  if (error) {
    // Unique constraint violation → already tagged (idempotent)
    if ((error as any).code === '23505') {
      const { data: existing } = await sc
        .from('tags')
        .select('id, status')
        .eq('source_type', source_type)
        .eq('source_id', source_id)
        .eq('tagged_user_id', tagged_user_id)
        .maybeSingle();
      const existingStatus = (existing as any)?.status ?? 'approved';
      res.status(existingStatus === 'pending' ? 202 : 200).json({
        tagId: (existing as any)?.id ?? null,
        alreadyTagged: true,
        status: existingStatus,
      });
      return;
    }
    req.log.error({ err: error }, 'tags insert failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(tagStatus === 'pending' ? 202 : 201).json({ tagId: (data as any).id, status: tagStatus });
});

// ─── GET /api/tags/suggestions ────────────────────────────────────────────────

/**
 * Returns up to 20 ranked suggestions matching the query prefix.
 * Entity types returned: user, trip, circle, place.
 *
 * User ranking: mutual-follows (friends) first → circle members → one-way follow → everyone else.
 * tag_permission enforcement at suggestion time:
 *   nobody        → excluded entirely
 *   friends_only  → only included when caller and profile are mutual follows
 *   interacted    → only included when caller follows OR is followed by the profile
 *   anyone        → always included (after block-list check)
 *
 * Query params:
 *   q        (required) — handle / name prefix
 *   surface  (optional) — 'post' | 'comment' | 'message'
 *   limit    (optional, max 20)
 */
router.get('/tags/suggestions', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  if (!q || q.length < 1) {
    sendError(res, 'invalid_payload', 'q is required');
    return;
  }

  const limit = Math.min(Number(req.query.limit ?? 10), 20);

  // surface: 'post' | 'comment' | 'message' — controls whether entity suggestions
  // (trips, circles, places) are included or only user @mentions are returned.
  // Defaults to 'post' so entity context is available unless caller says otherwise.
  const surface = typeof req.query.surface === 'string' ? req.query.surface : 'post';
  const includeEntities = surface !== 'message'; // messages only support @user mentions

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // ── Block-list (both directions) ────────────────────────────────────────────
  const { data: blockRows } = await sc
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);

  const blockedSet = new Set<string>();
  for (const b of (blockRows ?? []) as any[]) {
    if (b.blocker_id === user.id) blockedSet.add(b.blocked_id);
    else blockedSet.add(b.blocker_id);
  }

  // ── User candidates: match on handle prefix OR name substring ────────────────
  const { data: rows, error } = await sc
    .from('profiles')
    .select('id, handle, name, avatar_url, tag_permission')
    .or(`handle.ilike.${q}%,name.ilike.%${q}%`)
    .neq('id', user.id)
    .order('handle', { ascending: true })
    .limit(limit * 5);

  if (error) {
    req.log.error({ err: error }, 'tags/suggestions query failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  const profiles = ((rows ?? []) as any[]).filter((p) => !blockedSet.has(p.id));
  const visibleIds = profiles.map((p: any) => p.id);

  // ── Relationship sets (ranking: crew > circle > mutual > any-follow > other) ──
  let iFollow   = new Set<string>();
  let followsMe = new Set<string>();
  let inCircle  = new Set<string>();
  let inCrew    = new Set<string>(); // trip co-members (highest proximity tier)

  if (visibleIds.length > 0) {
    const [{ data: authorFollows }, { data: followsAuthor }] = await Promise.all([
      sc.from('user_follows').select('following_id').eq('follower_id', user.id).in('following_id', visibleIds),
      sc.from('user_follows').select('follower_id').eq('following_id', user.id).in('follower_id', visibleIds),
    ]);
    iFollow   = new Set<string>((authorFollows ?? []).map((r: any) => r.following_id));
    followsMe = new Set<string>((followsAuthor ?? []).map((r: any) => r.follower_id));

    try {
      const { data: circleRows } = await sc
        .from('circle_members')
        .select('user_id')
        .eq('owner_id', user.id)
        .in('user_id', visibleIds);
      for (const r of (circleRows ?? []) as any[]) inCircle.add(r.user_id);
    } catch { /* circle_members may not exist on all deployments */ }

    // Crew = people who share a trip with the viewer
    try {
      const { data: myTripRows } = await sc
        .from('trip_members').select('trip_id').eq('user_id', user.id);
      const myTripIds = (myTripRows ?? []).map((r: any) => r.trip_id as string);
      if (myTripIds.length > 0) {
        const { data: crewRows } = await sc
          .from('trip_members').select('user_id')
          .in('trip_id', myTripIds)
          .in('user_id', visibleIds)
          .neq('user_id', user.id);
        for (const r of (crewRows ?? []) as any[]) inCrew.add(r.user_id);
      }
    } catch { /* trip_members may not exist on all deployments */ }
  }

  // rank 0 = crew (trip co-members), 1 = circle, 2 = mutual follow, 3 = any follow, 4 = other
  function rank(id: string): number {
    if (inCrew.has(id)) return 0;
    if (inCircle.has(id)) return 1;
    if (iFollow.has(id) && followsMe.has(id)) return 2;
    if (iFollow.has(id) || followsMe.has(id)) return 3;
    return 4;
  }

  const PER_TYPE_CAP = 10;

  // Apply tag_permission at suggestion time (friends_only and interacted enforced here)
  // Cap at PER_TYPE_CAP users to match per-type cap applied to entity suggestions
  const userSuggestions = profiles
    .filter((p) => {
      const perm: string = p.tag_permission ?? 'anyone';
      if (perm === 'nobody') return false;
      if (perm === 'friends_only') return iFollow.has(p.id) && followsMe.has(p.id);
      if (perm === 'interacted')  return iFollow.has(p.id) || followsMe.has(p.id);
      return true;
    })
    .map((p: any) => ({
      id: p.id,
      type: 'user' as const,
      handle: p.handle,
      name: p.name ?? null,
      avatarUrl: p.avatar_url ?? null,
      tagPermission: p.tag_permission ?? 'anyone',
      relationshipRank: rank(p.id),
    }))
    .sort((a, b) => a.relationshipRank - b.relationshipRank || a.handle.localeCompare(b.handle))
    .slice(0, PER_TYPE_CAP);

  // ── Entity suggestions: trips, circles, places, events (post/comment only) ──
  // surface='message' → only @user mentions are meaningful; skip entity lookup
  const entitySuggestions: any[] = [];
  if (includeEntities) {
    // Trips the caller is a member of
    try {
      const { data: memberRows } = await sc
        .from('trip_members')
        .select('trip_id, trips(id, name, destination, status)')
        .eq('user_id', user.id)
        .limit(100);
      for (const r of (memberRows ?? []) as any[]) {
        const t = r.trips;
        if (t && (t.name ?? '').toLowerCase().includes(q)) {
          entitySuggestions.push({
            id: t.id, type: 'trip',
            name: t.name, destination: t.destination ?? null,
          });
        }
      }
    } catch { /* trip_members may not exist on all deployments */ }

    // Circles owned by the caller
    try {
      const { data: circleRows } = await sc
        .from('circles')
        .select('id, name')
        .eq('owner_id', user.id)
        .ilike('name', `%${q}%`)
        .limit(20);
      for (const c of (circleRows ?? []) as any[]) {
        entitySuggestions.push({ id: c.id, type: 'circle', name: c.name });
      }
    } catch { /* circles may not exist on all deployments */ }

    // Discovery places matching query
    try {
      const { data: placeRows } = await sc
        .from('discovery_places')
        .select('id, name, city, place_type')
        .ilike('name', `%${q}%`)
        .eq('status', 'approved')
        .limit(10);
      for (const p of (placeRows ?? []) as any[]) {
        entitySuggestions.push({
          id: p.id, type: 'place',
          name: p.name, city: p.city ?? null, placeType: p.place_type ?? null,
        });
      }
    } catch { /* discovery_places may not exist on all deployments */ }

    // Events matching query
    try {
      const { data: eventRows } = await sc
        .from('events')
        .select('id, name, location, start_at')
        .ilike('name', `%${q}%`)
        .limit(10);
      for (const e of (eventRows ?? []) as any[]) {
        entitySuggestions.push({
          id: e.id, type: 'event',
          name: e.name, location: e.location ?? null, startAt: e.start_at ?? null,
        });
      }
    } catch { /* events table may not exist on all deployments */ }
  }

  // Cap each entity type at PER_TYPE_CAP before merging
  const typeCounts: Record<string, number> = {};
  const cappedEntities = entitySuggestions.filter((e) => {
    typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    return typeCounts[e.type] <= PER_TYPE_CAP;
  });

  const suggestions = [...userSuggestions, ...cappedEntities].slice(0, limit);
  res.status(200).json({ suggestions });
});

// ─── GET /api/me/tag-permission ───────────────────────────────────────────────

router.get('/me/tag-permission', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data, error } = await client
    .from('profiles')
    .select('tag_permission')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, 'tag-permission fetch failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ tagPermission: (data as any)?.tag_permission ?? 'anyone' });
});

// ─── PATCH /api/me/tag-permission ─────────────────────────────────────────────

const TagPermissionSchema = z.object({
  tagPermission: z.enum(['anyone', 'interacted', 'friends_only', 'nobody']),
});

router.patch('/me/tag-permission', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = TagPermissionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const { data, error } = await client
    .from('profiles')
    .update({ tag_permission: parsed.data.tagPermission })
    .eq('id', user.id)
    .select('tag_permission')
    .single();

  if (error) {
    req.log.error({ err: error }, 'tag-permission update failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ tagPermission: (data as any).tag_permission });
});

// ─── DELETE /api/tags/:id — tagged user removes their own @mention tag ────────

router.delete('/tags/:id', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const tagId = req.params.id;
  if (!isUuid(tagId)) {
    sendError(res, 'invalid_payload', 'Invalid tag id');
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: existing } = await sc
    .from('tags')
    .select('id, tagged_user_id')
    .eq('id', tagId)
    .maybeSingle();

  if (!existing) {
    sendError(res, 'not_found', 'Tag not found');
    return;
  }

  if ((existing as any).tagged_user_id !== user.id) {
    sendError(res, 'forbidden', 'You can only remove your own tags');
    return;
  }

  // Soft-delete: preserve the row so the unique constraint (source_type, source_id,
  // tagged_user_id) prevents a future re-tag from bypassing the suppression signal.
  const { error } = await sc
    .from('tags')
    .update({ suppressed: true, suppressed_at: new Date().toISOString() })
    .eq('id', tagId);

  if (error) {
    req.log.error({ err: error }, 'tags/:id self-suppress failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true });
});

// ─── DELETE /api/admin/tags/:id ───────────────────────────────────────────────

router.delete('/admin/tags/:id', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const tagId = req.params.id;
  if (!isUuid(tagId)) {
    sendError(res, 'invalid_payload', 'Invalid tag id');
    return;
  }

  const { data: existing } = await sc
    .from('tags')
    .select('id')
    .eq('id', tagId)
    .maybeSingle();

  if (!existing) {
    sendError(res, 'not_found', 'Tag not found');
    return;
  }

  const { error } = await sc.from('tags').delete().eq('id', tagId);

  if (error) {
    req.log.error({ err: error }, 'admin/tags/:id delete failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true });
});

export default router;
