import { enrichSpans } from '../lib/enrichSpans';
import { resolveMediaForPosts } from "../lib/postMediaResolve.js";

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
import { nameVisibilitySet } from '../lib/publicIdentity.js';

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

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

  // City→global fallback: when city scope yields no trending items, silently
  // retry with all global usage in the same 48 h window and note the fallback.
  let effectiveScope: 'global' | 'city' = scope;
  if (scope === 'city' && Object.keys(usageByHt).length === 0) {
    effectiveScope = 'global';
    const { data: fbRows } = await sc
      .from('hashtag_usage')
      .select('hashtag_id, author_id, city')
      .gte('created_at', since);
    for (const row of (fbRows ?? []) as any[]) {
      if (!usageByHt[row.hashtag_id]) {
        usageByHt[row.hashtag_id] = { total: 0, authors: new Set(), cityCount: 0 };
      }
      usageByHt[row.hashtag_id].total++;
      usageByHt[row.hashtag_id].authors.add(row.author_id);
      if (cityId && row.city === cityId) usageByHt[row.hashtag_id].cityCount++;
    }
  }

  if (Object.keys(usageByHt).length === 0) {
    res.status(200).json({ trending: [], scope: effectiveScope, city: cityId ?? null });
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

  // Compute event activity (hashtag_usage rows where source_type='event' in window)
  const eventActMap: Record<string, number> = {};
  try {
    const { data: evtUsage } = await sc
      .from('hashtag_usage')
      .select('hashtag_id')
      .eq('source_type', 'event')
      .in('hashtag_id', htIds)
      .gte('created_at', since);
    for (const row of (evtUsage ?? []) as any[]) {
      eventActMap[row.hashtag_id] = (eventActMap[row.hashtag_id] ?? 0) + 1;
    }
  } catch { /* events table may not exist on all deployments */ }

  // Compute weighted scores
  const scored = htIds.map((htId) => {
    const u = usageByHt[htId];
    const recent_usage = u.total;
    const engagement   = engagementMap[htId] ?? 0;
    const city_share   = cityId ? u.cityCount / Math.max(recent_usage, 1) : 0;
    const spam_pen     = u.authors.size < 3 ? 1 : 0;
    const event_act    = eventActMap[htId] ?? 0;

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

  res.status(200).json({ trending, scope: effectiveScope, city: cityId ?? null });
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
  const nowMs = Date.now();

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Upsert-on-read: create if first use, return if exists
  const { data: ht, error } = await sc
    .from('hashtags')
    .upsert(
      { slug, name: slug, updated_at: new Date(nowMs).toISOString() },
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

  const [followRes, cityRes] = await Promise.all([
    sc
      .from('user_hashtag_follows')
      .select('hashtag_id')
      .eq('user_id', user.id)
      .eq('hashtag_id', htRow.id)
      .maybeSingle(),
    // Find the city that has used this hashtag most in the last 30 days
    sc
      .from('hashtag_usage')
      .select('city')
      .eq('hashtag_id', htRow.id)
      .not('city', 'is', null)
      .gte('created_at', new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString())
      .limit(200),
  ]);

  // Tally city counts and pick the winner
  let topCity: string | null = null;
  if (cityRes.data && cityRes.data.length > 0) {
    const cityCount: Record<string, number> = {};
    for (const row of cityRes.data as any[]) {
      if (row.city) cityCount[row.city] = (cityCount[row.city] ?? 0) + 1;
    }
    const topEntry = Object.entries(cityCount).sort((a, b) => b[1] - a[1])[0];
    if (topEntry) topCity = topEntry[0];
  }

  res.status(200).json({
    id: htRow.id,
    slug: htRow.slug,
    name: htRow.name,
    usageCount: htRow.usage_count,
    isFollowing: followRes.data !== null,
    topCity,
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
 * Multi-tab hashtag feed.
 *
 * Query params:
 *   tab    = top | recent | events | people | places | circles | trips (default: recent)
 *   scope  = global | city | nearby (default: global)
 *   city   (required when scope=city or nearby)
 *   limit  (max 50)
 *   before (ISO datetime cursor for pagination)
 */
router.get('/hashtags/:slug/feed', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const slug  = req.params.slug.toLowerCase().replace(/^#/, '');
  const limit = Math.min(Number(req.query.limit ?? 20), 50);

  const VALID_TABS = ['top', 'recent', 'events', 'people', 'places', 'circles', 'trips'] as const;
  type FeedTab = typeof VALID_TABS[number];
  const rawTab = req.query.tab as string | undefined;
  const tab: FeedTab = VALID_TABS.includes(rawTab as FeedTab) ? rawTab as FeedTab : 'recent';

  const rawScope = req.query.scope as string | undefined;
  const scope = rawScope === 'city' ? 'city' : rawScope === 'nearby' ? 'nearby' : 'global';
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

  // Map tab → source_type for hashtag_usage lookup
  const SOURCE_TYPE_MAP: Record<FeedTab, string> = {
    top:     'post',
    recent:  'post',
    events:  'event',
    people:  'profile',
    places:  'discovery_place',
    circles: 'circle',
    trips:   'trip',
  };
  const sourceType = SOURCE_TYPE_MAP[tab];

  // Fetch source_ids via hashtag_usage (with optional scope + cursor filters)
  let usageQ = sc
    .from('hashtag_usage')
    .select('source_id, created_at')
    .eq('hashtag_id', htId)
    .eq('source_type', sourceType);

  if ((scope === 'city' || scope === 'nearby') && city) usageQ = usageQ.eq('city', city);
  if (before) usageQ = usageQ.lt('created_at', before);

  usageQ = usageQ.order('created_at', { ascending: false }).limit(limit);

  const { data: usageRows, error: usageErr } = await usageQ;

  if (usageErr) {
    req.log.error({ err: usageErr }, 'hashtag feed usage failed');
    sendError(res, 'db_error', usageErr.message);
    return;
  }

  const sourceIds = (usageRows ?? []).map((u: any) => u.source_id);
  // Cursor points to the oldest usage row in this page; callers pass it as `before` for the next page.
  const nextCursor = (usageRows ?? []).at(-1)?.created_at ?? null;

  if (sourceIds.length === 0) {
    res.status(200).json({ items: [], posts: [], hasMore: false, nextCursor: null, tab, scope });
    return;
  }

  // ── Viewer block-list (needed for post-tab visibility filtering) ────────────
  const { data: feedBlockRows } = await sc
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);
  const feedBlockedSet = new Set<string>();
  for (const b of (feedBlockRows ?? []) as any[]) {
    if (b.blocker_id === user.id) feedBlockedSet.add(b.blocked_id);
    else feedBlockedSet.add(b.blocker_id);
  }

  // Dispatch per tab type — fetch the underlying entities for each source_type
  if (tab === 'top' || tab === 'recent') {
    // Posts: public-only + exclude blocked authors (RLS-equivalent visibility guard)
    let postsQ = sc
      .from('posts')
      .select('id, author_id, content, media_urls, created_at, like_count, comment_count')
      .in('id', sourceIds)
      .eq('visibility', 'public')
      .neq('status', 'deleted');
    postsQ = tab === 'top'
      ? postsQ.order('like_count', { ascending: false })
      : postsQ.order('created_at', { ascending: false });

    const { data: posts, error: postsErr } = await postsQ;
    if (postsErr) { req.log.error({ err: postsErr }, 'hashtag feed posts failed'); sendError(res, 'db_error', postsErr.message); return; }

    const visiblePosts = (posts ?? []).filter((p: any) => !feedBlockedSet.has(p.author_id));

    const authorIds = [...new Set(visiblePosts.map((p: any) => p.author_id))];
    let profileMap: Record<string, any> = {};
    // Universal display-name rule: only include a real name when the author opted in.
    const allowedAuthorNames = await nameVisibilitySet(sc, authorIds as string[]);
    if (authorIds.length > 0) {
      const { data: profiles } = await sc.from('profiles').select('id, handle, name, avatar_url').in('id', authorIds);
      for (const p of (profiles ?? []) as any[]) profileMap[p.id] = p;
    }

    const spansMap = await enrichSpans(
      sc, 'post',
      visiblePosts.map((p: any) => ({ id: p.id as string, content: (p.content ?? '') as string })),
      user.id,
    );

    // post_media is canonical for storage-backed media; posts.media_urls holds
    // external references only (ruled 2026-08-12). See lib/postMediaResolve.ts.
    const mediaByPost = await resolveMediaForPosts(sc, visiblePosts as any[]);
    const items = visiblePosts.map((p: any) => {
      const pr    = profileMap[p.author_id];
      const spans = spansMap[p.id] ?? { tags: [], hashtagUsages: [] };
      return {
        id: p.id, type: 'post', content: p.content, mediaUrls: mediaByPost.get(p.id) ?? p.media_urls ?? [],
        createdAt: p.created_at, likeCount: p.like_count ?? 0, commentCount: p.comment_count ?? 0,
        author: pr
          ? {
              id: pr.id,
              handle: pr.handle,
              name: (pr.id === user.id || allowedAuthorNames.has(pr.id)) ? (pr.name ?? null) : null,
              avatarUrl: pr.avatar_url ?? null,
            }
          : null,
        tags: spans.tags,
        hashtagUsages: spans.hashtagUsages,
      };
    });
    res.status(200).json({ items, posts: items, hasMore: items.length === limit, nextCursor, tab, scope });

  } else if (tab === 'people') {
    // Exclude blocked/blocking profiles
    const { data: profiles } = await sc
      .from('profiles').select('id, handle, name, avatar_url').in('id', sourceIds);
    const visiblePeople = (profiles ?? []).filter((p: any) => !feedBlockedSet.has(p.id));
    // Universal display-name rule: real name only when the subject opted in.
    const allowedPeopleNames = await nameVisibilitySet(sc, visiblePeople.map((p: any) => p.id as string));
    const items = visiblePeople
      .map((p: any) => ({
        id: p.id,
        type: 'user',
        handle: p.handle,
        name: (p.id === user.id || allowedPeopleNames.has(p.id)) ? (p.name ?? null) : null,
        avatarUrl: p.avatar_url ?? null,
      }));
    res.status(200).json({ items, posts: [], hasMore: items.length === limit, nextCursor, tab, scope });

  } else if (tab === 'places') {
    try {
      // submitted_by allows filtering out content from blocked users
      const { data: places } = await sc
        .from('discovery_places').select('id, name, city, place_type, image_url, submitted_by').in('id', sourceIds);
      const items = (places ?? [])
        .filter((p: any) => !feedBlockedSet.has(p.submitted_by))
        .map((p: any) => ({
          id: p.id, type: 'place', name: p.name, city: p.city ?? null,
          placeType: p.place_type ?? null, imageUrl: p.image_url ?? null,
        }));
      res.status(200).json({ items, posts: [], hasMore: items.length === limit, nextCursor, tab, scope });
    } catch { res.status(200).json({ items: [], posts: [], hasMore: false, nextCursor: null, tab, scope }); }

  } else if (tab === 'trips') {
    try {
      // Visibility: only show public trips OR trips the viewer is a member/owner of
      const { data: memberRows } = await sc
        .from('trip_members').select('trip_id').eq('user_id', user.id).in('trip_id', sourceIds);
      const viewerTripIds = new Set((memberRows ?? []).map((r: any) => r.trip_id as string));

      const { data: trips } = await sc
        .from('trips').select('id, title, destination_city, status, owner_id, visibility').in('id', sourceIds);
      const items = (trips ?? [])
        .filter((t: any) =>
          !feedBlockedSet.has(t.owner_id) &&
          (t.visibility === 'public' || t.owner_id === user.id || viewerTripIds.has(t.id))
        )
        .map((t: any) => ({
          id: t.id, type: 'trip', name: t.title, destination: t.destination_city ?? null, status: t.status,
        }));
      res.status(200).json({ items, posts: [], hasMore: items.length === limit, nextCursor, tab, scope });
    } catch { res.status(200).json({ items: [], posts: [], hasMore: false, nextCursor: null, tab, scope }); }

  } else if (tab === 'circles') {
    try {
      // Visibility: only show circles the viewer owns, is a member of, or are public.
      // Live membership table is circle_memberships(user_id = circle owner,
      // other_id = member) — membership is keyed by circle OWNER, not circle id.
      const { data: circles } = await sc.from('circles').select('id, name, owner_id, visibility').in('id', sourceIds);
      const ownerIds = [...new Set((circles ?? []).map((c: any) => c.owner_id as string))];
      let viewerCircleOwnerIds = new Set<string>();
      if (ownerIds.length > 0) {
        const { data: memberRows } = await sc
          .from('circle_memberships').select('user_id').eq('other_id', user.id).in('user_id', ownerIds);
        viewerCircleOwnerIds = new Set((memberRows ?? []).map((r: any) => r.user_id as string));
      }
      const items = (circles ?? [])
        .filter((c: any) =>
          !feedBlockedSet.has(c.owner_id) &&
          (c.visibility === 'public' || c.owner_id === user.id || viewerCircleOwnerIds.has(c.owner_id))
        )
        .map((c: any) => ({ id: c.id, type: 'circle', name: c.name }));
      res.status(200).json({ items, posts: [], hasMore: items.length === limit, nextCursor, tab, scope });
    } catch { res.status(200).json({ items: [], posts: [], hasMore: false, nextCursor: null, tab, scope }); }

  } else if (tab === 'events') {
    try {
      // Events are public by nature; filter out those by blocked organizers
      const { data: events } = await sc
        .from('events').select('id, title, location_name, starts_at, ends_at, host_id').in('id', sourceIds);
      const items = (events ?? [])
        .filter((e: any) => !feedBlockedSet.has(e.host_id))
        .map((e: any) => ({
          id: e.id, type: 'event', name: e.title, location: e.location_name ?? null,
          startAt: e.starts_at ?? null, endAt: e.ends_at ?? null,
        }));
      res.status(200).json({ items, posts: [], hasMore: items.length === limit, nextCursor, tab, scope });
    } catch { res.status(200).json({ items: [], posts: [], hasMore: false, nextCursor: null, tab, scope }); }

  } else {
    res.status(200).json({ items: [], posts: [], hasMore: false, nextCursor: null, tab, scope });
  }
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

// ─── POST /api/hashtags/:slug/report ─────────────────────────────────────────

const ReportSchema = z.object({
  reason: z.enum(['spam', 'misleading', 'abusive']),
});

router.post('/hashtags/:slug/report', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const slug = req.params.slug.toLowerCase().replace(/^#/, '');
  const parsed = ReportSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: ht } = await sc.from('hashtags').select('id').eq('slug', slug).maybeSingle();
  if (!ht) { sendError(res, 'not_found', 'Hashtag not found'); return; }

  const { error } = await sc.from('hashtag_reports').insert({
    hashtag_id: (ht as any).id,
    reporter_id: user.id,
    reason: parsed.data.reason,
  });

  if (error) {
    req.log.error({ err: error }, 'hashtag report insert failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(201).json({ ok: true });
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
      'id, slug, name, usage_count, is_blocked, is_hidden_from_trending, blocked_at, blocked_reason, created_at, hashtag_reports(count)',
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

  const hashtags = (data ?? []).map((h: any) => ({
    id: h.id,
    slug: h.slug,
    name: h.name,
    usageCount: h.usage_count,
    isBlocked: h.is_blocked,
    hideTrending: h.is_hidden_from_trending,
    blockedAt: h.blocked_at,
    blockedReason: h.blocked_reason,
    createdAt: h.created_at,
    reportCount: Array.isArray(h.hashtag_reports)
      ? (h.hashtag_reports[0]?.count ?? 0)
      : 0,
  }));

  res.status(200).json({ hashtags, total: count ?? 0, limit, offset });
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

  // Re-point hashtag_usage rows: delete rows that would conflict on the unique
  // (hashtag_id, source_type, source_id) index, then update the rest.
  const { data: tgtUsage } = await sc
    .from('hashtag_usage')
    .select('source_type, source_id')
    .eq('hashtag_id', tgtRow.id);
  const tgtSet = new Set<string>(
    (tgtUsage ?? []).map((r: any) => `${r.source_type}:${r.source_id}`),
  );

  const { data: srcUsage } = await sc
    .from('hashtag_usage')
    .select('id, source_type, source_id')
    .eq('hashtag_id', srcRow.id);

  const conflictIds = (srcUsage ?? [])
    .filter((r: any) => tgtSet.has(`${r.source_type}:${r.source_id}`))
    .map((r: any) => r.id);
  if (conflictIds.length > 0) {
    await sc.from('hashtag_usage').delete().in('id', conflictIds);
  }

  // Update remaining source rows to point to target
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
  newSlug: z.string().min(2).max(64).regex(/^[A-Za-z0-9]+$/, 'newSlug must be alphanumeric').optional(),
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

  // Rename: update slug, normalized_name, and (if name not separately supplied) display name
  if (parsed.data.newSlug !== undefined) {
    const normalizedSlug = parsed.data.newSlug.toLowerCase();
    // Conflict check: another hashtag already owns this slug
    const { data: conflict } = await sc
      .from('hashtags')
      .select('id')
      .eq('slug', normalizedSlug)
      .neq('id', (ht as any).id)
      .maybeSingle();
    if (conflict) {
      sendError(res, 'invalid_payload', `Slug '${normalizedSlug}' is already in use`);
      return;
    }
    patch.slug = normalizedSlug;
    if (parsed.data.name === undefined) patch.name = parsed.data.newSlug;
  }

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
