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

// ─── GET /api/tags/suggestions ────────────────────────────────────────────────

/**
 * Returns up to 10 ranked user suggestions matching the query prefix.
 *
 * Ranking: mutual-follows (friends) first → circle members → one-way follow → everyone else.
 * Filters: excludes nobody tag_permission, excludes blocked users.
 *
 * Query params:
 *   q        (required) — handle/name prefix
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

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Build block-list (both directions)
  const { data: blockRows } = await sc
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);

  const blockedSet = new Set<string>();
  for (const b of (blockRows ?? []) as any[]) {
    if (b.blocker_id === user.id) blockedSet.add(b.blocked_id);
    else blockedSet.add(b.blocker_id);
  }

  // Fetch candidates matching prefix (fetch more than limit to allow filtering)
  const { data: rows, error } = await sc
    .from('profiles')
    .select('id, handle, name, avatar_url, tag_permission')
    .ilike('handle', `${q}%`)
    .neq('id', user.id)
    .order('handle', { ascending: true })
    .limit(limit * 5);

  if (error) {
    req.log.error({ err: error }, 'tags/suggestions query failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  const profiles = (rows ?? []) as any[];

  // Apply block-list + tag_permission filter
  const visible = profiles.filter((p) => {
    if (blockedSet.has(p.id)) return false;
    const perm: string = p.tag_permission ?? 'anyone';
    return perm !== 'nobody';
  });

  if (visible.length === 0) {
    res.status(200).json({ suggestions: [] });
    return;
  }

  const visibleIds = visible.map((p: any) => p.id);

  // Relationship context for ranking
  const [{ data: authorFollows }, { data: followsAuthor }] = await Promise.all([
    sc.from('user_follows').select('following_id').eq('follower_id', user.id).in('following_id', visibleIds),
    sc.from('user_follows').select('follower_id').eq('following_id', user.id).in('follower_id', visibleIds),
  ]);

  let inCircle = new Set<string>();
  try {
    const { data: circleRows } = await sc
      .from('circle_members')
      .select('user_id')
      .eq('owner_id', user.id)
      .in('user_id', visibleIds);
    for (const r of (circleRows ?? []) as any[]) inCircle.add(r.user_id);
  } catch { /* circle_members may not exist on all deployments */ }

  const iFollow   = new Set<string>((authorFollows ?? []).map((r: any) => r.following_id));
  const followsMe = new Set<string>((followsAuthor ?? []).map((r: any) => r.follower_id));

  function rank(id: string): number {
    const mutual  = iFollow.has(id) && followsMe.has(id);
    const circle  = inCircle.has(id);
    const follows = iFollow.has(id) || followsMe.has(id);
    if (mutual) return 0;
    if (circle) return 1;
    if (follows) return 2;
    return 3;
  }

  const ranked = visible
    .map((p: any) => ({ ...p, _rank: rank(p.id) }))
    .sort((a: any, b: any) => a._rank - b._rank || a.handle.localeCompare(b.handle))
    .slice(0, limit);

  const suggestions = ranked.map((p: any) => ({
    id: p.id,
    handle: p.handle,
    name: p.name ?? null,
    avatarUrl: p.avatar_url ?? null,
    tagPermission: p.tag_permission ?? 'anyone',
    relationshipRank: p._rank,
  }));

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
