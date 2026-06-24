/**
 * TaggingService
 *
 * Extraction and persistence of @user mentions and #hashtag references.
 *
 * Enforcement (all checked at write time before any insert):
 *  - tag_permission: nobody → skip; friends_only → mutual-follow check;
 *    interacted → any prior interaction check; anyone → always allowed
 *  - Block-list: if tagger blocks or is blocked by tagged user → skip
 *  - Per-item cap: max MAX_MENTIONS unique @mentions per content item
 *  - Per-hour cap: max MAX_TAGS_PER_HOUR author @tags in rolling 1-hour window
 *
 * Returns the list of user IDs successfully tagged (for notification callers).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';

// ─── Regex ────────────────────────────────────────────────────────────────────

const MENTION_RE = /@([A-Za-z0-9_]{1,64})(?![A-Za-z0-9_])/g;
const HASHTAG_RE = /#([A-Za-z0-9]{2,64})/g;

export function extractMentionHandles(content: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(content)) !== null) {
    found.push(m[1].toLowerCase());
  }
  return [...new Set(found)];
}

export function extractHashtagSlugs(content: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  HASHTAG_RE.lastIndex = 0;
  while ((m = HASHTAG_RE.exec(content)) !== null) {
    found.push(m[1].toLowerCase());
  }
  return [...new Set(found)];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MENTIONS       = 5;
const MAX_HASHTAGS       = 20;
const MAX_TAGS_PER_HOUR  = 20; // per author, rolling 1-hour window

// ─── Context ──────────────────────────────────────────────────────────────────

export interface TaggingContext {
  db: SupabaseClient;
  authorId: string;
  sourceType: 'post' | 'comment' | 'message';
  sourceId: string;
  content: string;
  city?: string | null;
  country?: string | null;
  logger?: Logger;
}

/**
 * Processes @mentions and #hashtags. Returns tagged user IDs for notifications.
 * All enforcement (permissions, block-list, rate-limit) is applied before any insert.
 */
export async function processTagging(ctx: TaggingContext): Promise<string[]> {
  const { db, authorId, sourceType, sourceId, content, city, country, logger } = ctx;
  const taggedUserIds: string[] = [];

  try {
    const mentionHandles = extractMentionHandles(content);
    const hashtagSlugs   = extractHashtagSlugs(content);

    const [tagIds] = await Promise.all([
      mentionHandles.length > 0
        ? processMentions(db, authorId, sourceType, sourceId, mentionHandles, logger)
        : Promise.resolve<string[]>([]),
      hashtagSlugs.length > 0
        ? processHashtags(db, authorId, sourceType, sourceId, hashtagSlugs, city ?? null, country ?? null, logger)
        : Promise.resolve(),
    ]);

    // Content-visibility filter: suppress notifications for tagged users who
    // cannot access the source content (post/comment visibility; message is
    // already gated by thread membership inside processMentions).
    const visibleIds = await filterByContentVisibility(db, authorId, sourceType, sourceId, tagIds, logger);
    taggedUserIds.push(...visibleIds);
  } catch (err) {
    logger?.error({ err }, 'processTagging outer error');
  }

  return taggedUserIds;
}

/**
 * Returns the subset of taggedIds whose users can actually see the source content.
 * For messages this is always a pass-through (gated earlier by thread membership).
 * For posts: filter out users who cannot see the post visibility level.
 * For comments: resolve the parent post, then apply the same post visibility check.
 */
async function filterByContentVisibility(
  db: SupabaseClient,
  authorId: string,
  sourceType: 'post' | 'comment' | 'message',
  sourceId: string,
  taggedIds: string[],
  logger?: Logger,
): Promise<string[]> {
  if (taggedIds.length === 0 || sourceType === 'message') return taggedIds;

  try {
    let postId = sourceId;

    if (sourceType === 'comment') {
      // Resolve comment → parent post
      const { data: comment } = await db
        .from('posts_comments')
        .select('post_id')
        .eq('id', sourceId)
        .maybeSingle();
      if (!comment) return []; // Comment not found — suppress all
      postId = (comment as any).post_id;
    }

    const { data: post } = await db
      .from('posts')
      .select('visibility, author_id')
      .eq('id', postId)
      .maybeSingle();

    if (!post) return taggedIds; // Post not found — pass through (can't determine visibility)

    const visibility = (post as any).visibility ?? 'public';

    if (visibility === 'public') return taggedIds; // All can see it

    if (visibility === 'private') return []; // Only author can see — no notifications

    // For followers/friends-only: only notify tagged users who follow the author
    const { data: followers } = await db
      .from('user_follows')
      .select('follower_id')
      .eq('following_id', authorId)
      .in('follower_id', taggedIds);

    const followerSet = new Set((followers ?? []).map((r: any) => r.follower_id as string));
    return taggedIds.filter(id => followerSet.has(id));
  } catch (err) {
    logger?.warn({ err }, 'filterByContentVisibility failed — suppressing all notifications');
    return []; // Safe default on error
  }
}

// ─── Mentions ─────────────────────────────────────────────────────────────────

async function processMentions(
  db: SupabaseClient,
  authorId: string,
  sourceType: 'post' | 'comment' | 'message',
  sourceId: string,
  handles: string[],
  logger?: Logger,
): Promise<string[]> {
  const capped = handles.slice(0, MAX_MENTIONS);

  // For message sourceType: restrict tagging to thread members only
  // (prevents notifying users who cannot see the message)
  let allowedUserIds: Set<string> | null = null;
  if (sourceType === 'message') {
    try {
      const { data: msgRow } = await db
        .from('messages')
        .select('thread_id')
        .eq('id', sourceId)
        .maybeSingle();
      if (msgRow) {
        const { data: memberRows } = await db
          .from('message_thread_members')
          .select('user_id')
          .eq('thread_id', (msgRow as any).thread_id);
        allowedUserIds = new Set((memberRows ?? []).map((r: any) => r.user_id as string));
      }
    } catch {
      // If lookup fails, be safe and allow no tags for this message
      allowedUserIds = new Set();
    }
  }

  // Per-hour rate-limit check: count author's tags in rolling 1-hour window
  // NOTE: schema uses tagged_at (not created_at) — see migration 0044_tags_hashtags.sql
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: hourCount } = await db
    .from('tags')
    .select('id', { count: 'exact', head: true })
    .eq('tagger_id', authorId)
    .gte('tagged_at', oneHourAgo);

  if ((hourCount ?? 0) >= MAX_TAGS_PER_HOUR) {
    logger?.warn({ authorId }, 'processMentions: hourly rate limit exceeded');
    return [];
  }

  const { data: profiles, error: pErr } = await db
    .from('profiles')
    .select('id, handle, tag_permission')
    .in('handle', capped);

  if (pErr || !profiles) {
    logger?.error({ err: pErr }, 'processMentions: profile lookup failed');
    return [];
  }

  // Fetch block-list for the author (both directions) once
  const { data: blockRows } = await db
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${authorId},blocked_id.eq.${authorId}`);

  const blockedSet = new Set<string>();
  for (const b of (blockRows ?? []) as any[]) {
    if (b.blocker_id === authorId) blockedSet.add(b.blocked_id);
    else blockedSet.add(b.blocker_id);
  }

  // Prefetch follows for interacted/friends_only checks
  const profileIds = (profiles as any[]).map((p: any) => p.id);
  let mutualFollowSet = new Set<string>();    // IDs that mutually follow author
  let followsAuthorSet = new Set<string>();   // IDs that follow author
  let authorFollowsSet = new Set<string>();   // IDs that the author follows

  if (profileIds.length > 0) {
    // Who does the author follow?
    const { data: authorFollows } = await db
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', authorId)
      .in('following_id', profileIds);
    authorFollowsSet = new Set<string>((authorFollows ?? []).map((r: any) => r.following_id));

    // Who follows the author (among the tagged profiles)?
    const { data: followsAuthor } = await db
      .from('user_follows')
      .select('follower_id')
      .eq('following_id', authorId)
      .in('follower_id', profileIds);
    for (const r of (followsAuthor ?? []) as any[]) followsAuthorSet.add(r.follower_id);

    // Mutual = both sides
    for (const id of authorFollowsSet) {
      if (followsAuthorSet.has(id)) mutualFollowSet.add(id);
    }
  }

  const taggedIds: string[] = [];
  const remainingSlots = MAX_TAGS_PER_HOUR - (hourCount ?? 0);

  for (const profile of (profiles as any[]).slice(0, remainingSlots)) {
    if (profile.id === authorId) continue;
    if (blockedSet.has(profile.id)) continue;
    // For messages: only tag users who are thread members (content-visibility guard)
    if (allowedUserIds !== null && !allowedUserIds.has(profile.id)) continue;

    const perm: string = profile.tag_permission ?? 'anyone';
    if (perm === 'nobody') continue;

    if (perm === 'friends_only' && !mutualFollowSet.has(profile.id)) continue;

    if (perm === 'interacted') {
      // Accept if either follow direction exists (mutual, author→target, target→author)
      const hasInteracted =
        mutualFollowSet.has(profile.id) ||
        followsAuthorSet.has(profile.id) ||
        authorFollowsSet.has(profile.id);
      if (!hasInteracted) {
        // Also check if there's a message thread (quick heuristic)
        const { data: threadCheck } = await db
          .from('message_thread_members')
          .select('thread_id')
          .eq('user_id', authorId)
          .limit(1);
        const authorThreadIds = (threadCheck ?? []).map((r: any) => r.thread_id);
        if (authorThreadIds.length > 0) {
          const { data: sharedThread } = await db
            .from('message_thread_members')
            .select('thread_id')
            .eq('user_id', profile.id)
            .in('thread_id', authorThreadIds)
            .maybeSingle();
          if (!sharedThread) continue;
        } else {
          continue;
        }
      }
    }

    // Dedup guard: if this (source, tagged_user) pair already exists,
    // skip — callers should not dispatch a second notification for re-processing.
    const { data: existing } = await db
      .from('tags')
      .select('id')
      .eq('source_type', sourceType)
      .eq('source_id', sourceId)
      .eq('tagged_user_id', profile.id)
      .maybeSingle();

    if (existing) continue; // Already tagged — at-most-once notification guaranteed

    const { error: insErr } = await db
      .from('tags')
      .upsert(
        { source_type: sourceType, source_id: sourceId, tagger_id: authorId, tagged_user_id: profile.id },
        { onConflict: 'source_type,source_id,tagged_user_id', ignoreDuplicates: true },
      );

    if (insErr) {
      logger?.warn({ err: insErr, handle: profile.handle }, 'tags upsert failed');
      continue;
    }

    taggedIds.push(profile.id);
  }

  return taggedIds;
}

// ─── Hashtags ─────────────────────────────────────────────────────────────────

async function processHashtags(
  db: SupabaseClient,
  authorId: string,
  sourceType: 'post' | 'comment' | 'message',
  sourceId: string,
  slugs: string[],
  city: string | null,
  country: string | null,
  logger?: Logger,
): Promise<void> {
  const capped = slugs.slice(0, MAX_HASHTAGS);

  for (const slug of capped) {
    try {
      const { data: ht, error: htErr } = await db
        .from('hashtags')
        .upsert(
          { slug, name: slug, updated_at: new Date().toISOString() },
          { onConflict: 'slug' },
        )
        .select('id, is_blocked')
        .single();

      if (htErr || !ht) {
        logger?.warn({ err: htErr, slug }, 'hashtag upsert failed');
        continue;
      }

      const htRow = ht as any;
      if (htRow.is_blocked) continue;

      // Dedup guard: only count new usage rows (prevents over-incrementing on re-process)
      const { data: existingUsage } = await db
        .from('hashtag_usage')
        .select('id')
        .eq('hashtag_id', htRow.id)
        .eq('source_type', sourceType)
        .eq('source_id', sourceId)
        .maybeSingle();

      if (existingUsage) continue; // Already counted — skip upsert and increment

      const { error: usageErr } = await db
        .from('hashtag_usage')
        .upsert(
          {
            hashtag_id: htRow.id,
            source_type: sourceType,
            source_id: sourceId,
            author_id: authorId,
            city: city ?? null,
            country: country ?? null,
          },
          { onConflict: 'hashtag_id,source_type,source_id', ignoreDuplicates: true },
        );

      if (usageErr) {
        logger?.warn({ err: usageErr, slug }, 'hashtag_usage upsert failed');
        continue;
      }

      // Atomic increment via DB helper — only reached for newly inserted rows
      await db.rpc('increment_hashtag_usage_count', { p_hashtag_id: htRow.id });
    } catch (err) {
      logger?.warn({ err, slug }, 'processHashtags item error');
    }
  }
}
