/**
 * Hashtag routes
 *
 * User-facing:
 *   GET  /api/hashtags/suggestions        — autocomplete (followed > trending > prefix)
 *   GET  /api/hashtags/trending           — trending (weighted score, scope=global|city)
 *   GET  /api/hashtags/:slug              — fetch/create hashtag record (upsert-on-read)
 *   POST /api/hashtags/:slug/follow       — follow a hashtag
 *   DELETE /api/hashtags/:slug/follow     — unfollow a hashtag
 *   GET  /api/hashtags/:slug/feed         — posts feed (tab=top|recent, scope=global|city)
 *   GET  /api/me/hashtag-follows          — list caller's followed hashtags
 *
 * Admin (profiles.role = 'admin' required):
 *   GET   /api/admin/hashtags             — list all (paginated, searchable)
 *   POST  /api/admin/hashtags/:slug/block         — block
 *   POST  /api/admin/hashtags/:slug/unblock       — unblock
 *   POST  /api/admin/hashtags/:slug/hide-trending — hide from trending
 *   POST  /api/admin/hashtags/merge               — merge source → target
 *   PATCH /api/admin/hashtags/:slug               — rename / patch flags
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireUser, sendError } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';

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

// ─── GET /api/hashtags/suggestions ───────────────────────────────────────────

/**
 * Ordering: followed hashtags first → trending for city → prefix matches.
 * Blocked hashtags always excluded.
 * Query params: q (required), city (optional), limit (optional, max 20)
 */
router.get('/hashtags/suggestions', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const q = typeof req.query.q === 'string'
    ? req.query.q.trim().toLowerCase().replace(/^#/, '')
    : '';
  if (!q) {
    sendError(res, 'invalid_payload', 'q is required');
    return;
  }

  const limit = Math.min(Number(req.query.limit ?? 10), 20);
  const city  = typeof req.query.city === 'string' ? req.query.city.trim() : null;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Fetch candidate hashtags matching prefix
  const { data: candidates, error } = await sc
    .from('hashtags')
    .select('id, slug, name, usage_count')
    .ilike('slug', `${q}%`)
    .eq('is_blocked', false)
    .order('usage_count', { ascending: false })
    .limit(limit * 3);

  if (error) {
    req.log.error({ err: error }, 'hashtags/suggestions fetch failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  const allCandidates = (candidates ?? []) as any[];
  if (allCandidates.length === 0) {
    res.status(200).json({ suggestions: [] });
    return;
  }

  const candidateIds = allCandidates.map((h: any) => h.id);

  // Fetch which ones the caller follows
  const { data: followed } = await sc
    .from('user_hashtag_follows')
    .select('hashtag_id')
    .eq('user_id', user.id)
    .in('hashtag_id', candidateIds);

  const followedSet = new Set<string>((followed ?? []).map((r: any) => r.hashtag_id));

  // Fetch city-trending scores (usage in last 48h for user's city)
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  let cityTrendSet = new Set<string>();

  if (city) {
    const { data: cityUsage } = await sc
      .from('hashtag_usage')
      .select('hashtag_id')
      .in('hashtag_id', candidateIds)
      .eq('city', city)
      .gte('created_at', since);

    const cityCountMap: Record<string, number> = {};
    for (const row of (cityUsage ?? []) as any[]) {
      cityCountMap[row.hashtag_id] = (cityCountMap[row.hashtag_id] ?? 0) + 1;
    }
    // Mark those with at least 1 city usage as city-trending
    for (const id of Object.keys(cityCountMap)) cityTrendSet.add(id);
  }

  // Rank: followed (0) > city-trending (1) > others (2)
  function suggestRank(id: string): number {
    if (followedSet.has(id)) return 0;
    if (cityTrendSet.has(id)) return 1;
    return 2;
  }

  const ranked = allCandidates
    .map((h: any) => ({ ...h, _rank: suggestRank(h.id) }))
    .sort((a: any, b: any) => a._rank - b._rank || b.usage_count - a.usage_count)
    .slice(0, limit);

  res.status(200).json({
    suggestions: ranked.map((h: any) => ({
      id: h.id,
      slug: h.slug,
      name: h.name,
      usageCount: h.usage_count,
      isFollowing: followedSet.has(h.id),
    })),
  });
});

// ─── GET /api/hashtags/trending ──────────────────────────────────────────────

/**
 * Weighted trending score per spec:
 *   score = recent_usage × 0.35
 *         + engagement  × 0.25
 *         + city_share  × 0.20
 *         + event_act   × 0.15
 *         − spam_pen    × 0.25
 *
 * Where:
 *   recent_usage = count of hashtag_usage rows in last 48 h
 *   engagement   = sum(like_count + comment_count) of linked public posts
 *   city_share   = city_count / max(recent_usage, 1) (relevance factor 0–1)
 *   event_act    = 0 (no events table in scope — placeholder)
 *   spam_pen     = 1 if unique-author-count < 3, else 0 (single-author spam signal)
 *
 * Query params: scope=global|city, city_id (city name), limit (max 50)
 */
router.get('/hashtags/trending', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const limit  = Math.min(Number(req.query.limit ?? 20), 50);
  const scope  = req.query.scope === 'city' ? 'city' : 'global';
  const cityId = typeof req.query.city_id === 'string' ? req.query.city_id.trim() : null;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Fetch usage rows in window
  let usageQ = sc
    .from('hashtag_usage')
    .select('hashtag_id, author_id, city')
    .gte('created_at', since);

  if (scope === 'city' && cityId) usageQ = usageQ.eq('city', cityId);

  const { data: usageRows, error: usageErr } = await usageQ;

  if (usageErr) {
    req.log.error({ err: usageErr }, 'hashtags/trending usage failed');
    sendError(res, 'db_error', usageErr.message);
    return;
  }

  // Aggregate per hashtag: total count, unique authors, city count
  const usageByHt: Record<string, { total: number; authors: Set<string>; cityCount: number }> = {};
  for (const row of (usageRows ?? []) as any[]) {
    if (!usageByHt[row.hashtag_id]) {
      usageByHt[row.hashtag_id] = { total: 0, authors: new Set(), cityCount: 0 };
    }
    usageByHt[row.hashtag_id].total++;
    usageByHt[row.hashtag_id].authors.add(row.author_id);
    if (cityId && row.city === cityId) usageByHt[row.hashtag_id].cityCount++;
  }

  if (Object.keys(usageByHt).length === 0) {
    res.status(200).json({ trending: [] });
    return;
  }

  // Fetch engagement for posts using these hashtags in the window
  const htIds = Object.keys(usageByHt);
  const { data: postUsage } = await sc
    .from('hashtag_usage')
    .select('hashtag_id, source_id')
    .eq('source_type', 'post')
    .in('hashtag_id', htIds)
    .gte('created_at', since);

  const postsByHt: Record<string, string[]> = {};
  for (const row of (postUsage ?? []) as any[]) {
    if (!postsByHt[row.hashtag_id]) postsByHt[row.hashtag_id] = [];
    postsByHt[row.hashtag_id].push(row.source_id);
  }

  const allPostIds = [...new Set(Object.values(postsByHt).flat())];
  let engagementMap: Record<string, number> = {};

  if (allPostIds.length > 0) {
    const { data: postsData } = await sc
      .from('posts')
      .select('id, like_count, comment_count')
      .in('id', allPostIds);

    const postEngMap: Record<string, number> = {};
    for (const p of (postsData ?? []) as any[]) {
      postEngMap[p.id] = (p.like_count ?? 0) + (p.comment_count ?? 0);
    }

    for (const [htId, pIds] of Object.entries(postsByHt)) {
      engagementMap[htId] = pIds.reduce((s, pid) => s + (postEngMap[pid] ?? 0), 0);
    }
  }

  // Compute weighted scores
  const scored = htIds.map((htId) => {
    const u = usageByHt[htId];
    const recent_usage = u.total;
    const engagement   = engagementMap[htId] ?? 0;
    const city_share   = cityId ? u.cityCount / Math.max(recent_usage, 1) : 0;
    const spam_pen     = u.authors.size < 3 ? 1 : 0;
    const event_act    = 0; // events out of scope

    const score =
      recent_usage * 0.35 +
      engagement   * 0.25 +
      city_share   * 0.20 +
      event_act    * 0.15 -
      spam_pen     * 0.25;

    return { htId, score };
  });

  const topIds = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.htId);

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

  const scoreMap = Object.fromEntries(scored.map((s) => [s.htId, s.score]));
  const trending = (hashtags ?? [])
    .map((h: any) => ({
      id: h.id,
      slug: h.slug,
      name: h.name,
      usageCount: h.usage_count,
      trendingScore: Math.max(0, scoreMap[h.id] ?? 0),
    }))
    .sort((a: any, b: any) => b.trendingScore - a.trendingScore);

  res.status(200).json({ trending, scope, city: cityId ?? null });
});

// ─── GET /api/hashtags/:slug ──────────────────────────────────────────────────

/**
 * Returns hashtag metadata. Auto-creates the record on first read (upsert-on-read),
 * so callers can request a slug without knowing if it exists yet.
 */
router.get('/hashtags/:slug', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Upsert-on-read: create if first use, return if exists
  const { data: ht, error } = await sc
    .from('hashtags')
    .upsert(
      { slug, name: slug, updated_at: new Date().toISOString() },
      { onConflict: 'slug' },
    )
    .select('id, slug, name, usage_count, is_blocked, created_at')
    .single();

  if (error || !ht) {
    req.log.error({ err: error }, 'hashtags/:slug upsert-on-read failed');
    sendError(res, 'db_error', error?.message ?? 'Failed to resolve hashtag');
    return;
  }

  const htRow = ht as any;
  // Blocked hashtags are invisible to regular users
  if (htRow.is_blocked) { sendError(res, 'not_found', 'Hashtag not found'); return; }

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

  const { data: ht } = await sc
    .from('hashtags')
    .select('id, is_blocked')
    .eq('slug', slug)
    .maybeSingle();

  if (!ht || (ht as any).is_blocked) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const { error } = await sc
    .from('user_hashtag_follows')
    .upsert({ user_id: user.id, hashtag_id: (ht as any).id }, { onConflict: 'user_id,hashtag_id', ignoreDuplicates: true });

  if (error) {
    req.log.error({ err: error }, 'hashtag follow failed');
    sendError(res, 'db_error', error.message);
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
 * Query params:
 *   tab    = top | recent (default: recent)
 *   scope  = global | city (default: global)
 *   city   (required when scope=city)
 *   limit  (max 50)
 *   before (ISO datetime cursor for pagination)
 */
router.get('/hashtags/:slug/feed', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const slug  = req.params.slug.toLowerCase().replace(/^#/, '');
  const limit = Math.min(Number(req.query.limit ?? 20), 50);
  const tab   = req.query.tab === 'top' ? 'top' : 'recent';
  const scope = req.query.scope === 'city' ? 'city' : 'global';
  const city  = typeof req.query.city === 'string' ? req.query.city.trim() : null;
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

  // Find post source_ids via hashtag_usage
  let usageQ = sc
    .from('hashtag_usage')
    .select('source_id, created_at')
    .eq('hashtag_id', htId)
    .eq('source_type', 'post');

  if (scope === 'city' && city) usageQ = usageQ.eq('city', city);
  if (before) usageQ = usageQ.lt('created_at', before);

  usageQ = usageQ.order('created_at', { ascending: false }).limit(limit);

  const { data: usageRows, error: usageErr } = await usageQ;

  if (usageErr) {
    req.log.error({ err: usageErr }, 'hashtag feed usage failed');
    sendError(res, 'db_error', usageErr.message);
    return;
  }

  const postIds = (usageRows ?? []).map((u: any) => u.source_id);

  if (postIds.length === 0) {
    res.status(200).json({ posts: [], hasMore: false, tab, scope });
    return;
  }

  // Fetch public active posts only
  let postsQ = sc
    .from('posts')
    .select('id, author_id, content, media_urls, visibility, created_at, like_count, comment_count')
    .in('id', postIds)
    .eq('status', 'active')
    .eq('visibility', 'public');

  // Sort by tab: top = most liked, recent = newest
  postsQ = tab === 'top'
    ? postsQ.order('like_count', { ascending: false })
    : postsQ.order('created_at', { ascending: false });

  const { data: posts, error: postsErr } = await postsQ;

  if (postsErr) {
    req.log.error({ err: postsErr }, 'hashtag feed posts failed');
    sendError(res, 'db_error', postsErr.message);
    return;
  }

  const authorIds = [...new Set((posts ?? []).map((p: any) => p.author_id))];
  let profileMap: Record<string, any> = {};
  if (authorIds.length > 0) {
    const { data: profiles } = await sc
      .from('profiles')
      .select('id, handle, name, avatar_url')
      .in('id', authorIds);
    for (const p of (profiles ?? []) as any[]) profileMap[p.id] = p;
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

  res.status(200).json({ posts: feedPosts, hasMore: feedPosts.length === limit, tab, scope });
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

router.get('/admin/hashtags', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit  = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);
  const q      = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : null;
  const blocked = req.query.blocked === 'true';

  let query = sc
    .from('hashtags')
    .select(
      'id, slug, name, usage_count, is_blocked, is_hidden_from_trending, blocked_at, blocked_reason, created_at',
      { count: 'exact' },
    )
    .order('usage_count', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q)      query = query.ilike('slug', `%${q}%`);
  if (blocked) query = query.eq('is_blocked', true);

  const { data, error, count } = await query;

  if (error) {
    req.log.error({ err: error }, 'admin/hashtags list failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ hashtags: data ?? [], total: count ?? 0, limit, offset });
});

const BlockSchema = z.object({ reason: z.string().max(500).optional() });

router.post('/admin/hashtags/:slug/block', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const slug   = req.params.slug.toLowerCase().replace(/^#/, '');
  const parsed = BlockSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const { data: ht } = await sc.from('hashtags').select('id').eq('slug', slug).maybeSingle();
  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const { error } = await sc.from('hashtags').update({
    is_blocked: true,
    is_hidden_from_trending: true,
    blocked_at: new Date().toISOString(),
    blocked_reason: parsed.data.reason ?? null,
    updated_at: new Date().toISOString(),
  }).eq('id', (ht as any).id);

  if (error) { sendError(res, 'db_error', error.message); return; }
  res.status(200).json({ ok: true, slug, blocked: true });
});

router.post('/admin/hashtags/:slug/unblock', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');
  const { data: ht } = await sc.from('hashtags').select('id').eq('slug', slug).maybeSingle();
  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const { error } = await sc.from('hashtags').update({
    is_blocked: false,
    blocked_at: null,
    blocked_reason: null,
    updated_at: new Date().toISOString(),
  }).eq('id', (ht as any).id);

  if (error) { sendError(res, 'db_error', error.message); return; }
  res.status(200).json({ ok: true, slug, blocked: false });
});

// ─── POST /api/admin/hashtags/:slug/hide-trending ────────────────────────────

router.post('/admin/hashtags/:slug/hide-trending', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');
  const hide = req.body?.hide !== false; // default true; pass { hide: false } to unhide

  const { data: ht } = await sc.from('hashtags').select('id').eq('slug', slug).maybeSingle();
  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const { error } = await sc.from('hashtags').update({
    is_hidden_from_trending: hide,
    updated_at: new Date().toISOString(),
  }).eq('id', (ht as any).id);

  if (error) { sendError(res, 'db_error', error.message); return; }
  res.status(200).json({ ok: true, slug, hiddenFromTrending: hide });
});

// ─── POST /api/admin/hashtags/merge ──────────────────────────────────────────

const MergeSchema = z.object({
  sourceSlug: z.string().min(1),
  targetSlug: z.string().min(1),
});

router.post('/admin/hashtags/merge', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = MergeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const { sourceSlug, targetSlug } = parsed.data;
  if (sourceSlug === targetSlug) {
    sendError(res, 'invalid_payload', 'sourceSlug and targetSlug must differ');
    return;
  }

  const [{ data: src }, { data: tgt }] = await Promise.all([
    sc.from('hashtags').select('id, usage_count').eq('slug', sourceSlug.toLowerCase()).maybeSingle(),
    sc.from('hashtags').select('id, usage_count').eq('slug', targetSlug.toLowerCase()).maybeSingle(),
  ]);

  if (!src) { sendError(res, 'not_found', `Source hashtag '${sourceSlug}' not found`); return; }
  if (!tgt) { sendError(res, 'not_found', `Target hashtag '${targetSlug}' not found`); return; }

  const srcRow = src as any;
  const tgtRow = tgt as any;

  // Re-point hashtag_usage rows from source → target
  await sc.from('hashtag_usage')
    .update({ hashtag_id: tgtRow.id })
    .eq('hashtag_id', srcRow.id);

  // Re-point user_hashtag_follows from source → target (ignore duplicates)
  const { data: srcFollows } = await sc
    .from('user_hashtag_follows')
    .select('user_id')
    .eq('hashtag_id', srcRow.id);

  for (const f of (srcFollows ?? []) as any[]) {
    await sc.from('user_hashtag_follows')
      .upsert({ user_id: f.user_id, hashtag_id: tgtRow.id }, { onConflict: 'user_id,hashtag_id', ignoreDuplicates: true });
  }

  // Delete source follows + source hashtag row
  await sc.from('user_hashtag_follows').delete().eq('hashtag_id', srcRow.id);

  // Update target usage_count to combined total
  const combinedCount = (srcRow.usage_count ?? 0) + (tgtRow.usage_count ?? 0);
  await sc.from('hashtags').update({
    usage_count: combinedCount,
    updated_at: new Date().toISOString(),
  }).eq('id', tgtRow.id);

  await sc.from('hashtags').delete().eq('id', srcRow.id);

  res.status(200).json({ ok: true, merged: sourceSlug, into: targetSlug, combinedUsageCount: combinedCount });
});

// ─── PATCH /api/admin/hashtags/:slug ─────────────────────────────────────────

const AdminPatchSchema = z.object({
  name: z.string().max(100).optional(),
  isHiddenFromTrending: z.boolean().optional(),
});

router.patch('/admin/hashtags/:slug', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const slug   = req.params.slug.toLowerCase().replace(/^#/, '');
  const parsed = AdminPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const { data: ht } = await sc.from('hashtags').select('id').eq('slug', slug).maybeSingle();
  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.isHiddenFromTrending !== undefined) patch.is_hidden_from_trending = parsed.data.isHiddenFromTrending;

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
