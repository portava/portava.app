/**
 * enrichSpans — batch-fetch persisted @mention tags and #hashtag usages for a
 * list of content items, keyed by source_id.
 *
 * Both the `tags` and `hashtag_usage` tables store only which users/slugs
 * appeared in a piece of content — they do NOT store character positions.
 * The client's RichText component uses these whitelists to validate regex-found
 * tokens (`@handle`, `#slug`) in the raw text, so only confirmed saved
 * annotations become interactive.
 */

export interface SpanTag {
  type: 'user';
  /** User UUID — used for TagPreviewSheet profile API calls. */
  id: string;
  /** The handle that appears after @ in the text (case-sensitive to original,
   *  matching is done case-insensitively on the client). */
  matchToken: string;
}

export interface SpanHashtag {
  /** Canonical slug — the word after # in the text. */
  slug: string;
  hashtagId: string;
}

export interface ContentSpans {
  tags: SpanTag[];
  hashtagUsages: SpanHashtag[];
}

/**
 * For each id in `sourceIds`, fetch the saved @mention tags (joined to
 * profiles for handles) and #hashtag usages (joined to hashtags for slugs).
 *
 * Returns a Record<sourceId, ContentSpans>.  If a source has no saved spans
 * the entry will have empty arrays — callers can safely spread into responses.
 *
 * @param sc     Service-role Supabase client (bypasses RLS for this internal join)
 * @param sourceType  e.g. 'post' | 'comment' | 'message'
 * @param sourceIds   UUIDs of the content items to enrich
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function enrichSpans(
  sc: any,
  sourceType: string,
  sourceIds: string[],
): Promise<Record<string, ContentSpans>> {
  const result: Record<string, ContentSpans> = {};
  for (const id of sourceIds) result[id] = { tags: [], hashtagUsages: [] };

  if (sourceIds.length === 0) return result;

  // ── User-mention tags ──────────────────────────────────────────────────────
  const { data: tagRows } = await sc
    .from('tags')
    .select('source_id, tagged_user_id')
    .eq('source_type', sourceType)
    .in('source_id', sourceIds);

  const taggedUserIds = [
    ...new Set(((tagRows ?? []) as any[]).map((r: any) => r.tagged_user_id as string)),
  ];

  if (taggedUserIds.length > 0) {
    const { data: profiles } = await sc
      .from('profiles')
      .select('id, handle')
      .in('id', taggedUserIds);

    const profileMap: Record<string, string> = {};
    for (const p of (profiles ?? []) as any[]) {
      if (p.handle) profileMap[p.id] = p.handle;
    }

    for (const row of (tagRows ?? []) as any[]) {
      const handle = profileMap[row.tagged_user_id];
      if (handle && result[row.source_id]) {
        result[row.source_id].tags.push({
          type: 'user',
          id: row.tagged_user_id,
          matchToken: handle,
        });
      }
    }
  }

  // ── Hashtag usages ─────────────────────────────────────────────────────────
  const { data: usageRows } = await sc
    .from('hashtag_usage')
    .select('source_id, hashtag_id')
    .eq('source_type', sourceType)
    .in('source_id', sourceIds);

  const hashtagIds = [
    ...new Set(((usageRows ?? []) as any[]).map((r: any) => r.hashtag_id as string)),
  ];

  if (hashtagIds.length > 0) {
    const { data: hashtags } = await sc
      .from('hashtags')
      .select('id, slug')
      .in('id', hashtagIds);

    const hashtagMap: Record<string, string> = {};
    for (const h of (hashtags ?? []) as any[]) {
      if (h.slug) hashtagMap[h.id] = h.slug;
    }

    for (const row of (usageRows ?? []) as any[]) {
      const slug = hashtagMap[row.hashtag_id];
      if (slug && result[row.source_id]) {
        result[row.source_id].hashtagUsages.push({
          slug,
          hashtagId: row.hashtag_id,
        });
      }
    }
  }

  return result;
}
