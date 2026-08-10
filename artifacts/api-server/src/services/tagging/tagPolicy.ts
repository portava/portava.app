/**
 * tagPolicy — the tag-write rules that BOTH write paths must satisfy.
 *
 * WHY THIS MODULE EXISTS
 * ======================
 *
 * There are two ways a row lands in `tags`:
 *
 *   1. src/services/tagging/TaggingService.ts — inline `@handle` in the body of
 *      a post/comment/message, processed as the author writes the content.
 *   2. POST /api/tags (src/routes/tags.ts) — an explicit tag from a client.
 *
 * Until this module existed, (1) enforced a per-item mention cap, a per-author
 * hourly cap, and — structurally, by only ever being called with content its own
 * author was composing — the rule that you may only tag your own content. (2)
 * enforced none of the three: it validated that `source_id` parsed as a UUID and
 * inserted. It uses the service client, so `tags_insert`'s RLS `WITH CHECK
 * (tagger_id = auth.uid())` (0044:37) did not backstop it either — that policy
 * constrains who the TAGGER is, never which source is being tagged.
 *
 * The caps were not missing from the route because anyone decided the route
 * should be exempt. They were missing because they were written as local
 * constants and inline queries inside the other file, where a second caller
 * could not reach them and no reader of the route could see they existed. So the
 * fix is not a second copy of the same checks over here — a second copy is how
 * these two paths came to disagree in the first place. It is one implementation
 * that both import, and the constants live here so there is exactly one
 * MAX_MENTIONS in the codebase.
 *
 * WHAT THIS MODULE DOES NOT DECIDE
 * ================================
 *
 * Block-list and tag_permission are NOT here. The route resolves them through
 * services/interactionPermissions.ts, which is richer than TaggingService's
 * inline checks (it also knows about account state, restrictions and
 * approval_required). Folding those into this module would mean picking one of
 * the two implementations for both callers, which is a behavioural change well
 * beyond closing the authorization hole. That divergence is real and is left
 * documented rather than silently half-merged.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';

/** Max unique @mentions honoured per content item. */
export const MAX_MENTIONS = 5;
/** Max hashtags honoured per content item. */
export const MAX_HASHTAGS = 20;
/** Max tags a single author may create in a rolling 1-hour window. */
export const MAX_TAGS_PER_HOUR = 20;

export type TagSourceType = 'post' | 'comment' | 'message';

export type SourceAuthorityResult =
  | { ok: true }
  | { ok: false; code: 'unknown_source_type' | 'not_found' | 'not_author'; message: string };

/**
 * May `userId` attach tags to this source?
 *
 * The rule is the one TaggingService has always enforced implicitly: tags on a
 * piece of content are created by the person who wrote that content. Stated
 * explicitly here because the REST path has no structural reason to be true.
 *
 * FAILS CLOSED. A source that cannot be found is refused rather than allowed:
 * "I could not establish who owns this" is not a licence to write to it.
 */
export async function assertMayTagSource(
  db: SupabaseClient,
  userId: string,
  sourceType: string,
  sourceId: string,
): Promise<SourceAuthorityResult> {
  const NOT_FOUND: SourceAuthorityResult = {
    ok: false,
    code: 'not_found',
    message: 'Source content not found',
  };

  // ── THREE LITERAL SITES, NOT ONE DYNAMIC ONE ────────────────────────────────
  //
  // The author column differs per table — posts.author_id,
  // posts_comments.user_id, messages.sender_id — all three read off the LIVE
  // schema (src/lib/database.types.ts) rather than the migrations, which for
  // this area disagree with production.
  //
  // The obvious spelling is a {sourceType → {table, column}} map and one
  // `.from(spec.table).select(\`id, ${'${spec.column}'}\`)`. That is shorter and it is
  // worse: check:write-path-columns resolves select lists statically, so a
  // runtime table name and an interpolated column make the site opaque to it —
  // it can no longer prove any of these three columns exists live. Before this
  // function was added the checker could verify every site in src/services; one
  // dynamic call would have been the first it could not, and the fix for
  // "the checker cannot see this" is to make it visible, not to allowlist it.
  //
  // So: a switch, three literal `.from()` calls, three literal select lists.
  // Same behaviour, three verifiable sites instead of one blind spot. Keep it
  // this way — collapsing it back into a table-driven lookup silently removes
  // the columns from the check's subject.
  let authorId: unknown;

  switch (sourceType) {
    case 'post': {
      const { data, error } = await db
        .from('posts')
        .select('id, author_id')
        .eq('id', sourceId)
        .maybeSingle();
      if (error || !data) return NOT_FOUND;
      authorId = data.author_id;
      break;
    }
    case 'comment': {
      const { data, error } = await db
        .from('posts_comments')
        .select('id, user_id')
        .eq('id', sourceId)
        .maybeSingle();
      if (error || !data) return NOT_FOUND;
      authorId = data.user_id;
      break;
    }
    case 'message': {
      const { data, error } = await db
        .from('messages')
        .select('id, sender_id')
        .eq('id', sourceId)
        .maybeSingle();
      if (error || !data) return NOT_FOUND;
      authorId = data.sender_id;
      break;
    }
    default:
      return {
        ok: false,
        code: 'unknown_source_type',
        message: `Cannot verify ownership of source_type '${sourceType}'`,
      };
  }

  if (authorId !== userId) {
    return { ok: false, code: 'not_author', message: 'You can only tag your own content' };
  }
  return { ok: true };
}

export type HourlyLimitResult =
  | { ok: true; used: number; remaining: number }
  | { ok: false; code: 'lookup_failed' | 'exceeded'; used: number };

/**
 * The rolling per-author hourly cap.
 *
 * Counts on `created_at`, not `tagged_at`: 0044 declares `tagged_at` and the
 * three indexes over it, and none of them were ever applied to the live schema
 * (see docs/migrations.md). `created_at` is what the table actually has.
 *
 * FAILS CLOSED on a lookup error, matching TaggingService's existing behaviour —
 * an uncountable budget is not an unlimited one.
 */
export async function checkHourlyTagLimit(
  db: SupabaseClient,
  authorId: string,
  logger?: Logger,
): Promise<HourlyLimitResult> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await db
    .from('tags')
    .select('id', { count: 'exact', head: true })
    .eq('tagger_id', authorId)
    .gte('created_at', oneHourAgo);

  if (error) {
    logger?.error({ err: error, authorId }, 'tagPolicy: hourly rate-limit lookup failed');
    return { ok: false, code: 'lookup_failed', used: 0 };
  }

  const used = count ?? 0;
  if (used >= MAX_TAGS_PER_HOUR) return { ok: false, code: 'exceeded', used };
  return { ok: true, used, remaining: MAX_TAGS_PER_HOUR - used };
}

export type MentionCapResult =
  | { ok: true; existing: number }
  | { ok: false; code: 'lookup_failed' | 'exceeded'; existing: number };

/**
 * The per-item cap, counted against rows already stored for this source.
 *
 * TaggingService applies MAX_MENTIONS by slicing the handles it extracted from
 * one piece of text, which is a cap on a single pass. The REST path adds one tag
 * per call, so the equivalent question is how many tags this source already
 * carries — otherwise five separate calls reach a total the inline path would
 * have refused in one.
 *
 * FAILS CLOSED on a lookup error, for the same reason as the hourly cap.
 */
export async function checkPerSourceMentionCap(
  db: SupabaseClient,
  sourceType: string,
  sourceId: string,
  logger?: Logger,
): Promise<MentionCapResult> {
  const { count, error } = await db
    .from('tags')
    .select('id', { count: 'exact', head: true })
    .eq('source_type', sourceType)
    .eq('source_id', sourceId);

  if (error) {
    logger?.error({ err: error, sourceId }, 'tagPolicy: per-source mention cap lookup failed');
    return { ok: false, code: 'lookup_failed', existing: 0 };
  }

  const existing = count ?? 0;
  if (existing >= MAX_MENTIONS) return { ok: false, code: 'exceeded', existing };
  return { ok: true, existing };
}
