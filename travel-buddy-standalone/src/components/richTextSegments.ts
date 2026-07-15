/**
 * richTextSegments.ts — pure segment-building logic for RichText.
 *
 * No React, no Expo, no native modules — safe to import in node:test.
 * RichText.tsx imports from here; tests import from here too, so there
 * is a single canonical source of truth for the parsing logic.
 */

// ── Public types (mirrors models.ts Post.tags / Post.hashtagUsages shapes) ────

export type RichTextEntityType = 'user' | 'event' | 'circle' | 'trip' | 'place';

/** A persisted @mention annotation returned by the API (from the `tags` table). */
export interface RichTextTag {
  type: RichTextEntityType;
  id: string;
  /**
   * The token that appears after `@` in the text, e.g. `"alice"` for `@alice`.
   * For `user` type this equals the handle; used for navigation and TagPreviewSheet.
   */
  matchToken: string;
  startChar: number;
  endChar: number;
  isBlocked?: boolean;
  isDeleted?: boolean;
  isPrivate?: boolean;
  tagRowId?: string;
}

/** A persisted #hashtag annotation returned by the API (from `hashtag_usage`). */
export interface RichTextHashtag {
  slug: string;
  startChar: number;
  endChar: number;
  isBlocked?: boolean;
}

// ── Segment types ─────────────────────────────────────────────────────────────

export type PlainSegment   = { kind: 'plain';   text: string };
export type MentionSegment = { kind: 'mention'; tag: RichTextTag;         displayText: string; interactive: boolean };
export type HashtagSegment = { kind: 'hashtag'; hashtag: RichTextHashtag; displayText: string; interactive: boolean };
export type Segment = PlainSegment | MentionSegment | HashtagSegment;

// ── Segment builder ───────────────────────────────────────────────────────────

/**
 * Split `content` into plain, mention, and hashtag segments using server-side
 * position annotations. Overlapping or out-of-bounds spans are skipped.
 */
export function buildSegments(
  content: string,
  tags: RichTextTag[],
  hashtagUsages: RichTextHashtag[],
): Segment[] {
  type SpanEntry =
    | { start: number; end: number; tag: RichTextTag }
    | { start: number; end: number; hashtag: RichTextHashtag };

  const spans: SpanEntry[] = [
    ...tags.map((t) => ({ start: t.startChar, end: t.endChar, tag: t })),
    ...hashtagUsages.map((h) => ({ start: h.startChar, end: h.endChar, hashtag: h })),
  ];

  spans.sort((a, b) => a.start - b.start);

  const segs: Segment[] = [];
  let cursor = 0;

  for (const span of spans) {
    if (span.start < cursor || span.end > content.length || span.start >= span.end) continue;
    if (span.start > cursor) {
      segs.push({ kind: 'plain', text: content.slice(cursor, span.start) });
    }
    const displayText = content.slice(span.start, span.end);
    if ('tag' in span) {
      const { tag } = span;
      const interactive = !(tag.isBlocked || tag.isDeleted || tag.isPrivate);
      segs.push({ kind: 'mention', tag, displayText, interactive });
    } else {
      const { hashtag } = span;
      segs.push({ kind: 'hashtag', hashtag, displayText, interactive: !hashtag.isBlocked });
    }
    cursor = span.end;
  }

  if (cursor < content.length) {
    segs.push({ kind: 'plain', text: content.slice(cursor) });
  }

  return segs;
}

// ── Navigation route helpers (pure, no router) ────────────────────────────────

/**
 * Returns the in-app route string for a @mention short-press, or `null` when
 * no parameterised route exists for the entity type (e.g. 'circle').
 */
export function mentionNavigationRoute(tag: RichTextTag): string | null {
  switch (tag.type) {
    case 'user':   return `/u/${tag.matchToken}`;
    case 'trip':   return `/trip/${tag.id}`;
    case 'place':  return `/gems/${tag.id}`;
    case 'event':  return `/meetup/${tag.id}`;
    default:       return null;
  }
}

/** Returns the in-app route string for a #hashtag short-press. */
export function hashtagNavigationRoute(slug: string): string {
  return `/hashtag/${slug}`;
}
