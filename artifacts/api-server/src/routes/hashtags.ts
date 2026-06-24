/**
 * Hashtag routes
 *
 * User-facing:
 *   GET  /api/hashtags/suggestions   — autocomplete suggestions by prefix
 *   GET  /api/hashtags/trending      — trending hashtags (recent usage weighted)
 *   GET  /api/hashtags/:slug         — fetch a single hashtag's metadata
 *   POST /api/hashtags/:slug/follow  — follow a hashtag
 *   DELETE /api/hashtags/:slug/follow — unfollow a hashtag
 *   GET  /api/hashtags/:slug/feed    — public posts that used this hashtag
 *   GET  /api/me/hashtag-follows     — list all hashtags the caller follows
 *
 * Admin:
 *   POST  /api/admin/hashtags/:slug/block   — block a hashtag (removes from trending)
 *   POST  /api/admin/hashtags/:slug/unblock — unblock a hashtag
 *   GET   /api/admin/hashtags               — list all hashtags (paginated)
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireUser, sendError } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';

const router = Router();

// ─── Shared admin guard ───────────────────────────────────────────────────────

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

// ─── GET /api/hashtags/suggestions ───────────────────────────────────────────

/**
 * Returns up to 10 hashtags whose slug starts with `q`.
 * Query params: q (required), limit (optional, max 20)
 */
router.get('/hashtags/suggestions', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().replace(/^#/, '') : '';
  if (!q) {
    sendError(res, 'invalid_payload', 'q is required');
    return;
  }

  const limit = Math.min(Number(req.query.limit ?? 10), 20);

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data, error } = await sc
    .from('hashtags')
    .select('id, slug, name, usage_count')
    .ilike('slug', `${q}%`)
    .eq('is_blocked', false)
    .order('usage_count', { ascending: false })
    .limit(limit);

  if (error) {
    req.log.error({ err: error }, 'hashtags/suggestions failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  const suggestions = (data ?? []).map((h: any) => ({
    id: h.id,
    slug: h.slug,
    name: h.name,
    usageCount: h.usage_count,
  }));

  res.status(200).json({ suggestions });
});

// ─── GET /api/hashtags/trending ──────────────────────────────────────────────

/**
 * Returns up to 20 trending hashtags ranked by recent usage.
 * Trending score: usage in last 48 h (recent window).
 * Query params: limit (optional, max 50), city (optional filter)
 */
router.get('/hashtags/trending', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const limit = Math.min(Number(req.query.limit ?? 20), 50);
  const city = typeof req.query.city === 'string' ? req.query.city.trim() : null;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Recent window: 48 h
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  let usageQ = sc
    .from('hashtag_usage')
    .select('hashtag_id')
    .gte('created_at', since);

  if (city) usageQ = usageQ.eq('city', city);

  const { data: usageRows, error: usageErr } = await usageQ;

  if (usageErr) {
    req.log.error({ err: usageErr }, 'hashtags/trending usage query failed');
    sendError(res, 'db_error', usageErr.message);
    return;
  }

  // Aggregate counts in JS (avoids needing a GROUP BY RPC)
  const counts: Record<string, number> = {};
  for (const row of (usageRows ?? []) as any[]) {
    counts[row.hashtag_id] = (counts[row.hashtag_id] ?? 0) + 1;
  }

  const topIds = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (topIds.length === 0) {
    res.status(200).json({ trending: [] });
    return;
  }

  const { data: hashtags, error: htErr } = await sc
    .from('hashtags')
    .select('id, slug, name, usage_count')
    .in('id', topIds)
    .eq('is_blocked', false)
    .eq('is_hidden_from_trending', false);

  if (htErr) {
    req.log.error({ err: htErr }, 'hashtags/trending lookup failed');
    sendError(res, 'db_error', htErr.message);
    return;
  }

  // Sort by the recent-window count we computed (not the all-time count)
  const ranked = (hashtags ?? [])
    .map((h: any) => ({ ...h, recentCount: counts[h.id] ?? 0 }))
    .sort((a: any, b: any) => b.recentCount - a.recentCount);

  const trending = ranked.map((h: any) => ({
    id: h.id,
    slug: h.slug,
    name: h.name,
    usageCount: h.usage_count,
    recentCount: h.recentCount,
  }));

  res.status(200).json({ trending });
});

// ─── GET /api/hashtags/:slug ──────────────────────────────────────────────────

router.get('/hashtags/:slug', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: ht, error } = await sc
    .from('hashtags')
    .select('id, slug, name, usage_count, is_blocked, created_at')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, 'hashtags/:slug failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const htRow = ht as any;
  if (htRow.is_blocked) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  // Is the caller following it?
  const { data: follow } = await sc
    .from('user_hashtag_follows')
    .select('hashtag_id')
    .eq('user_id', user.id)
    .eq('hashtag_id', htRow.id)
    .maybeSingle();

  res.status(200).json({
    id: htRow.id,
    slug: htRow.slug,
    name: htRow.name,
    usageCount: htRow.usage_count,
    isFollowing: follow !== null,
    createdAt: htRow.created_at,
  });
});

// ─── POST /api/hashtags/:slug/follow ─────────────────────────────────────────

router.post('/hashtags/:slug/follow', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: ht, error: htErr } = await sc
    .from('hashtags')
    .select('id, is_blocked')
    .eq('slug', slug)
    .maybeSingle();

  if (htErr) { sendError(res, 'db_error', htErr.message); return; }
  if (!ht || (ht as any).is_blocked) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const htId = (ht as any).id;

  const { error: insErr } = await sc
    .from('user_hashtag_follows')
    .upsert({ user_id: user.id, hashtag_id: htId }, { onConflict: 'user_id,hashtag_id', ignoreDuplicates: true });

  if (insErr) {
    req.log.error({ err: insErr }, 'hashtag follow insert failed');
    sendError(res, 'db_error', insErr.message);
    return;
  }

  res.status(200).json({ ok: true, following: true });
});

// ─── DELETE /api/hashtags/:slug/follow ───────────────────────────────────────

router.delete('/hashtags/:slug/follow', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: ht } = await sc
    .from('hashtags')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const { error } = await sc
    .from('user_hashtag_follows')
    .delete()
    .eq('user_id', user.id)
    .eq('hashtag_id', (ht as any).id);

  if (error) {
    req.log.error({ err: error }, 'hashtag unfollow failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true, following: false });
});

// ─── GET /api/hashtags/:slug/feed ────────────────────────────────────────────

/**
 * Returns the most recent public posts that used this hashtag.
 * Query params: limit (optional, max 50), before (ISO datetime cursor)
 */
router.get('/hashtags/:slug/feed', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');
  const limit = Math.min(Number(req.query.limit ?? 20), 50);
  const before = typeof req.query.before === 'string' ? req.query.before : null;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: ht } = await sc
    .from('hashtags')
    .select('id, is_blocked')
    .eq('slug', slug)
    .maybeSingle();

  if (!ht || (ht as any).is_blocked) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const htId = (ht as any).id;

  // Get usage rows to find post source_ids
  let usageQ = sc
    .from('hashtag_usage')
    .select('source_id, created_at')
    .eq('hashtag_id', htId)
    .eq('source_type', 'post')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) usageQ = usageQ.lt('created_at', before);

  const { data: usageRows, error: usageErr } = await usageQ;

  if (usageErr) {
    req.log.error({ err: usageErr }, 'hashtag feed usage query failed');
    sendError(res, 'db_error', usageErr.message);
    return;
  }

  const postIds = (usageRows ?? []).map((u: any) => u.source_id);

  if (postIds.length === 0) {
    res.status(200).json({ posts: [], hasMore: false });
    return;
  }

  const { data: posts, error: postsErr } = await sc
    .from('posts')
    .select('id, author_id, content, media_urls, visibility, created_at, like_count, comment_count')
    .in('id', postIds)
    .eq('status', 'active')
    .eq('visibility', 'public')
    .order('created_at', { ascending: false });

  if (postsErr) {
    req.log.error({ err: postsErr }, 'hashtag feed posts query failed');
    sendError(res, 'db_error', postsErr.message);
    return;
  }

  const authorIds = [...new Set((posts ?? []).map((p: any) => p.author_id))];
  let profileMap: Record<string, any> = {};
  if (authorIds.length > 0) {
    const { data: profiles } = await sc.from('profiles').select('id, handle, name, avatar_url').in('id', authorIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
  }

  const feedPosts = (posts ?? []).map((p: any) => {
    const pr = profileMap[p.author_id];
    return {
      id: p.id,
      content: p.content,
      mediaUrls: p.media_urls ?? [],
      createdAt: p.created_at,
      likeCount: p.like_count ?? 0,
      commentCount: p.comment_count ?? 0,
      author: pr
        ? { id: pr.id, handle: pr.handle, name: pr.name, avatarUrl: pr.avatar_url ?? null }
        : null,
    };
  });

  res.status(200).json({ posts: feedPosts, hasMore: feedPosts.length === limit });
});

// ─── GET /api/me/hashtag-follows ─────────────────────────────────────────────

router.get('/me/hashtag-follows', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data, error } = await sc
    .from('user_hashtag_follows')
    .select('hashtag_id, created_at, hashtags(id, slug, name, usage_count)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    req.log.error({ err: error }, 'me/hashtag-follows failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  const follows = (data ?? []).map((row: any) => {
    const ht = row.hashtags;
    return {
      hashtagId: row.hashtag_id,
      followedAt: row.created_at,
      hashtag: ht
        ? { id: ht.id, slug: ht.slug, name: ht.name, usageCount: ht.usage_count }
        : null,
    };
  });

  res.status(200).json({ follows });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/admin/hashtags ─────────────────────────────────────────────────

router.get('/admin/hashtags', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : null;
  const blocked = req.query.blocked === 'true';

  let query = sc
    .from('hashtags')
    .select('id, slug, name, usage_count, is_blocked, is_hidden_from_trending, blocked_at, blocked_reason, created_at', { count: 'exact' })
    .order('usage_count', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q) query = query.ilike('slug', `%${q}%`);
  if (blocked) query = query.eq('is_blocked', true);

  const { data, error, count } = await query;

  if (error) {
    req.log.error({ err: error }, 'admin/hashtags list failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ hashtags: data ?? [], total: count ?? 0, limit, offset });
});

// ─── POST /api/admin/hashtags/:slug/block ────────────────────────────────────

const BlockSchema = z.object({ reason: z.string().max(500).optional() });

router.post('/admin/hashtags/:slug/block', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');
  const parsed = BlockSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const { data: ht } = await sc.from('hashtags').select('id').eq('slug', slug).maybeSingle();
  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const { error } = await sc
    .from('hashtags')
    .update({
      is_blocked: true,
      is_hidden_from_trending: true,
      blocked_at: new Date().toISOString(),
      blocked_reason: parsed.data.reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', (ht as any).id);

  if (error) {
    req.log.error({ err: error }, 'admin/hashtags/:slug/block failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true, slug, blocked: true });
});

// ─── POST /api/admin/hashtags/:slug/unblock ──────────────────────────────────

router.post('/admin/hashtags/:slug/unblock', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');

  const { data: ht } = await sc.from('hashtags').select('id').eq('slug', slug).maybeSingle();
  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const { error } = await sc
    .from('hashtags')
    .update({
      is_blocked: false,
      blocked_at: null,
      blocked_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', (ht as any).id);

  if (error) {
    req.log.error({ err: error }, 'admin/hashtags/:slug/unblock failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true, slug, blocked: false });
});

// ─── PATCH /api/admin/hashtags/:slug ─────────────────────────────────────────

const AdminPatchSchema = z.object({
  isHiddenFromTrending: z.boolean().optional(),
  name: z.string().max(100).optional(),
});

router.patch('/admin/hashtags/:slug', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');
  const parsed = AdminPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const { data: ht } = await sc.from('hashtags').select('id').eq('slug', slug).maybeSingle();
  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.isHiddenFromTrending !== undefined) patch.is_hidden_from_trending = parsed.data.isHiddenFromTrending;
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;

  const { data, error } = await sc
    .from('hashtags')
    .update(patch)
    .eq('id', (ht as any).id)
    .select('id, slug, name, is_blocked, is_hidden_from_trending, usage_count')
    .single();

  if (error) {
    req.log.error({ err: error }, 'admin/hashtags/:slug patch failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true, hashtag: data });
});

export default router;
