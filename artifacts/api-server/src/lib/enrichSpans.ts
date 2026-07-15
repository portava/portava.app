/**
 * enrichSpans — batch-fetch persisted @mention tags and #hashtag usages for a
 * list of content items, then compute character-level positions by searching
 * each item's text for the confirmed tokens.
 *
 * Both the `tags` and `hashtag_usage` tables store only which users/slugs
 * appeared in a piece of content — they do NOT persist character positions.
 * This module computes positions dynamically by regex-searching the content
 * text for each confirmed @handle / #slug token, producing positioned spans
 * that the client's RichText component uses for precise inline rendering.
 */

/**
 * Supported @mention entity types emitted by `enrichSpans`.
 *
 * **Current DB scope: `'user'` only.**
 * The `tags` table (migration 0043) stores `tagged_user_id` (UUID) but no
 * equivalent column for event, circle, trip, or place targets.  Until the
 * schema is extended with those FK columns, only `'user'` can be resolved
 * and enriched here.
 *
 * The client-side `RichTextEntityType` deliberately includes the full set
 * (`user | event | circle | trip | place`) so the rendering component and
 * navigation layer are ready.  When future migrations add entity-specific
 * tag rows, change this union and the fetch logic below accordingly.
 */
export type SpanEntityType = 'user';

export interface SpanTag {
  type: SpanEntityType;
  /** User UUID — used for profile API calls. */
  id: string;
  /** The handle that appears after @ in the text — used for navigation + TagPreviewSheet. */
  matchToken: string;
  /** Zero-based start character index of the @token in the source text. */
  startChar: number;
  /** Zero-based end character index (exclusive) of the @token. */
  endChar: number;
  /** True when this user blocks or is blocked by the viewer → render as plain text. */
  isBlocked?: boolean;
  /** True when the user's profile no longer exists → render as plain text. */
  isDeleted?: boolean;
  /** UUID of the `tags` table row — provided so the tagged user can self-remove. */
  tagRowId?: string;
}

export interface SpanHashtag {
  /** Canonical slug — the word after # in the text. */
  slug: string;
  hashtagId: string;
  /** Zero-based start character index of the #token in the source text. */
  startChar: number;
  /** Zero-based end character index (exclusive) of the #token. */
  endChar: number;
  /** When true the hashtag is blocked site-wide → client renders as plain text. */
  isBlocked?: boolean;
}

export interface ContentSpans {
  tags: SpanTag[];
  hashtagUsages: SpanHashtag[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface RawTag {
  type: 'user';
  id: string;
  matchToken: string;
  isBlocked?: boolean;
  isDeleted?: boolean;
  tagRowId?: string;
}

interface RawHashtag {
  slug: string;
  hashtagId: string;
  /** True when the hashtag row has is_blocked=true — client renders as plain text. */
  isBlocked?: boolean;
}

/**
 * Given a content string and raw span whitelists, search for each token in the
 * text and emit one positioned span per occurrence.  Spans not found in the
 * text are omitted; the same token appearing multiple times yields multiple
 * spans (one per occurrence), which is the correct behaviour for position-based
 * rendering.
 */
function computePositions(
  content: string,
  rawTags: RawTag[],
  rawHashtags: RawHashtag[],
): ContentSpans {
  const result: ContentSpans = { tags: [], hashtagUsages: [] };

  for (const tag of rawTags) {
    if (!tag.matchToken) continue;
    const pattern = new RegExp(`@${escapeRegex(tag.matchToken)}(?=[^\\w]|$)`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      result.tags.push({
        type: 'user',
        id: tag.id,
        matchToken: tag.matchToken,
        startChar: m.index,
        endChar: m.index + m[0].length,
        ...(tag.tagRowId   ? { tagRowId:   tag.tagRowId } : {}),
        ...(tag.isBlocked  ? { isBlocked:  true } : {}),
        ...(tag.isDeleted  ? { isDeleted:  true } : {}),
      });
    }
  }

  for (const h of rawHashtags) {
    if (!h.slug) continue;
    const pattern = new RegExp(`#${escapeRegex(h.slug)}(?=[^\\w]|$)`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      result.hashtagUsages.push({
        slug: h.slug,
        hashtagId: h.hashtagId,
        startChar: m.index,
        endChar: m.index + m[0].length,
        ...(h.isBlocked ? { isBlocked: true } : {}),
      });
    }
  }

  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * For each `{id, content}` item in `items`:
 *   1. Fetch saved @mention tags from the `tags` table (joined to profiles for handles).
 *   2. Fetch saved #hashtag usages from `hashtag_usage` (joined to `hashtags` for slugs).
 *   3. Optionally check the `blocks` table when `viewerUserId` is provided, marking
 *      blocked users' tags with `isBlocked: true` so the client renders them as plain text.
 *   4. Compute character positions by regex-searching each item's content for the
 *      confirmed tokens, producing positioned SpanTag / SpanHashtag objects.
 *
 * Returns a `Record<sourceId, ContentSpans>`.  Every input id is guaranteed to
 * have an entry (empty arrays when no spans exist), so callers can safely spread.
 *
 * @param sc           Service-role Supabase client (bypasses RLS for internal joins)
 * @param sourceType   e.g. 'post' | 'comment' | 'message'
 * @param items        Array of `{ id: string; content: string }` — the items to enrich
 * @param viewerUserId Optional viewer's user id; when provided blocks are checked
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function enrichSpans(
  sc: any,
  sourceType: string,
  items: Array<{ id: string; content: string }>,
  viewerUserId?: string,
): Promise<Record<string, ContentSpans>> {
  const result: Record<string, ContentSpans> = {};
  const contentMap: Record<string, string> = {};
  for (const item of items) {
    result[item.id]     = { tags: [], hashtagUsages: [] };
    contentMap[item.id] = item.content;
  }

  const sourceIds = items.map((i) => i.id);
  if (sourceIds.length === 0) return result;

  // ── User-mention tags ──────────────────────────────────────────────────────
  const { data: tagRows } = await sc
    .from('tags')
    .select('id, source_id, tagged_user_id')
    .eq('source_type', sourceType)
    .in('source_id', sourceIds)
    .eq('suppressed', false);

  const taggedUserIds: string[] = [
    ...new Set(((tagRows ?? []) as any[]).map((r: any) => r.tagged_user_id as string)),
  ];

  const profileMap: Record<string, string> = {};   // userId → handle
  if (taggedUserIds.length > 0) {
    const { data: profiles } = await sc
      .from('profiles')
      .select('id, handle')
      .in('id', taggedUserIds);
    for (const p of (profiles ?? []) as any[]) {
      if (p.handle) profileMap[p.id] = p.handle;
    }
  }

  // Optional block check
  const blockedSet = new Set<string>();
  if (viewerUserId && taggedUserIds.length > 0) {
    const ids = taggedUserIds.join(',');
    const { data: blockRows } = await sc
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(
        `and(blocker_id.eq.${viewerUserId},blocked_id.in.(${ids})),` +
        `and(blocked_id.eq.${viewerUserId},blocker_id.in.(${ids}))`,
      );
    for (const row of (blockRows ?? []) as any[]) {
      blockedSet.add(
        row.blocker_id === viewerUserId ? row.blocked_id : row.blocker_id,
      );
    }
  }

  // Build per-source raw tag whitelists
  const rawTagsMap: Record<string, RawTag[]> = {};
  for (const id of sourceIds) rawTagsMap[id] = [];

  for (const row of (tagRows ?? []) as any[]) {
    const uid    = row.tagged_user_id as string;
    const handle = profileMap[uid];
    if (!rawTagsMap[row.source_id]) continue;
    rawTagsMap[row.source_id].push({
      type: 'user',
      id: uid,
      matchToken: handle ?? '',
      tagRowId: row.id as string,
      ...(blockedSet.has(uid)  ? { isBlocked:  true } : {}),
      ...(!handle              ? { isDeleted:  true } : {}),
    });
  }

  // ── Hashtag usages ─────────────────────────────────────────────────────────
  const { data: usageRows } = await sc
    .from('hashtag_usage')
    .select('source_id, hashtag_id')
    .eq('source_type', sourceType)
    .in('source_id', sourceIds);

  const hashtagIds: string[] = [
    ...new Set(((usageRows ?? []) as any[]).map((r: any) => r.hashtag_id as string)),
  ];

  // hashtagId → { slug, isBlocked }
  const hashtagMetaMap: Record<string, { slug: string; isBlocked: boolean }> = {};
  if (hashtagIds.length > 0) {
    const { data: hashtags } = await sc
      .from('hashtags')
      .select('id, slug, is_blocked')
      .in('id', hashtagIds);
    for (const h of (hashtags ?? []) as any[]) {
      if (h.slug) hashtagMetaMap[h.id] = { slug: h.slug, isBlocked: !!h.is_blocked };
    }
  }

  const rawHashtagsMap: Record<string, RawHashtag[]> = {};
  for (const id of sourceIds) rawHashtagsMap[id] = [];

  for (const row of (usageRows ?? []) as any[]) {
    const meta = hashtagMetaMap[row.hashtag_id];
    if (meta && rawHashtagsMap[row.source_id]) {
      rawHashtagsMap[row.source_id].push({
        slug: meta.slug,
        hashtagId: row.hashtag_id,
        ...(meta.isBlocked ? { isBlocked: true } : {}),
      });
    }
  }

  // ── Compute positions for each item ────────────────────────────────────────
  for (const id of sourceIds) {
    result[id] = computePositions(
      contentMap[id] ?? '',
      rawTagsMap[id]     ?? [],
      rawHashtagsMap[id] ?? [],
    );
  }

  return result;
}
