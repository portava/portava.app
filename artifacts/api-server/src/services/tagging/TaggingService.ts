/**
 * TaggingService
 *
 * Extraction and persistence of @user mentions and #hashtag references
 * from post content, comment bodies, and messages.
 *
 * Design notes:
 * - All DB writes use the service-role client (bypasses RLS).
 * - Mentions are resolved by handle (case-insensitive).
 * - Hashtags are normalised to lowercase slugs (letters + digits only).
 * - Max 5 unique @mentions per content item to limit notification spam.
 * - Max 20 hashtags per content item.
 * - All operations are fire-and-forget safe; errors are caught and logged.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';

// ─── Regex ────────────────────────────────────────────────────────────────────

/** @handle — word boundary after the @; 1–64 word-chars. */
const MENTION_RE = /@([A-Za-z0-9_]{1,64})/g;

/** #hashtag — letters + digits only, 2–64 chars. */
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
 * Processes @mentions and #hashtags in content, persisting to the DB.
 * Returns the list of tagged user IDs (for the caller to send notifications).
 *
 * Designed to be called fire-and-forget; errors are caught internally.
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

    taggedUserIds.push(...tagIds);
  } catch (err) {
    logger?.error({ err }, 'processTagging outer error');
  }

  return taggedUserIds;
}

// ─── Mentions ─────────────────────────────────────────────────────────────────

const MAX_MENTIONS = 5;

async function processMentions(
  db: SupabaseClient,
  authorId: string,
  sourceType: 'post' | 'comment' | 'message',
  sourceId: string,
  handles: string[],
  logger?: Logger,
): Promise<string[]> {
  const capped = handles.slice(0, MAX_MENTIONS);

  const { data: profiles, error: pErr } = await db
    .from('profiles')
    .select('id, handle, tag_permission')
    .in('handle', capped);

  if (pErr || !profiles) {
    logger?.error({ err: pErr }, 'processMentions: profile lookup failed');
    return [];
  }

  const taggedIds: string[] = [];

  for (const profile of profiles as any[]) {
    if (profile.id === authorId) continue;

    const perm: string = profile.tag_permission ?? 'anyone';
    if (perm === 'nobody') continue;

    const { error: insErr } = await db
      .from('tags')
      .upsert(
        {
          source_type: sourceType,
          source_id: sourceId,
          tagger_id: authorId,
          tagged_user_id: profile.id,
        },
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

const MAX_HASHTAGS = 20;

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

      // Atomic increment via the DB helper function (defined in migration 0043)
      await db.rpc('increment_hashtag_usage_count', { p_hashtag_id: htRow.id });
    } catch (err) {
      logger?.warn({ err, slug }, 'processHashtags item error');
    }
  }
}
