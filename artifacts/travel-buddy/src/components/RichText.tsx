/**
 * RichText — renders user-generated text with tappable @mention and #hashtag spans.
 *
 * Data model (position-based):
 *   - `tags`          — saved @mention annotations from the `tags` table.
 *                       Each entry carries `startChar`/`endChar` (computed server-side
 *                       by searching the content for the confirmed @handle token).
 *   - `hashtagUsages` — saved #hashtag annotations from the `hashtag_usage` table.
 *                       Each entry carries `startChar`/`endChar` similarly computed.
 *
 * Rendering pipeline:
 *   1. All spans (tags + hashtags) are sorted by `startChar`.
 *   2. The text is sliced into plain and interactive segments using the positions.
 *   3. Overlapping or out-of-bounds spans are skipped gracefully.
 *   4. Blocked/deleted/private tags render as plain text (no link, no press).
 *
 * Fallback behaviour:
 *   When BOTH `tags` and `hashtagUsages` are absent (or empty arrays), the content
 *   renders as plain `<Text>` with no regex processing and no interactivity.
 *
 * Short-press → navigate; long-press → TagPreviewSheet mini-card.
 * Navigation routes: user → /u/:matchToken  |  trip → /trip/:id  |  place → /gems/:id
 * circle and event have no dedicated detail route — long-press preview only.
 *
 * TagPreviewSheet contract:
 *   For `user` type the sheet expects a *handle* (calls getUserByHandle internally),
 *   so we pass `tag.matchToken` — NOT `tag.id` — as the sheet `id` prop.
 */
import React, { useState } from 'react';
import { Text, StyleSheet, type TextStyle, type StyleProp } from 'react-native';
import { router } from 'expo-router';
import { color } from '../theme/tokens';
import { TagPreviewSheet, type PreviewEntityType } from './TagPreviewSheet';

// ── Public types ───────────────────────────────────────────────────────────────

export type RichTextEntityType = 'user' | 'event' | 'circle' | 'trip' | 'place';

/** A persisted @mention annotation returned by the API (from the `tags` table). */
export interface RichTextTag {
  /** Entity type of the tagged target. */
  type: RichTextEntityType;
  /** UUID of the entity — used for trip/place navigation and circle/event preview sheet. */
  id: string;
  /**
   * The token that appears after `@` in the text, e.g. `"alice"` for `@alice`.
   * For `user` type this equals the handle; used for navigation and TagPreviewSheet.
   */
  matchToken: string;
  /** Zero-based start character index of the @token in the source text. */
  startChar: number;
  /** Zero-based end character index (exclusive) of the @token. */
  endChar: number;
  /** When true the target is blocked by (or blocking) the viewer → plain text. */
  isBlocked?: boolean;
  /** When true the target has been deleted → plain text. */
  isDeleted?: boolean;
  /** When true the target is private/inaccessible → plain text. */
  isPrivate?: boolean;
}

/** A persisted #hashtag annotation returned by the API (from `hashtag_usage`). */
export interface RichTextHashtag {
  /** Canonical slug without the `#` prefix, e.g. `"travel"` for `#travel`. */
  slug: string;
  /** Zero-based start character index of the #token in the source text. */
  startChar: number;
  /** Zero-based end character index (exclusive) of the #token. */
  endChar: number;
  /** When true the hashtag is blocked by the viewer → plain text. */
  isBlocked?: boolean;
}

export interface RichTextProps {
  content: string;
  /** @mention spans from the API. When absent AND hashtagUsages absent → plain text. */
  tags?: RichTextTag[];
  /** #hashtag spans from the API. When absent AND tags absent → plain text. */
  hashtagUsages?: RichTextHashtag[];
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** Suppress short-press navigation (long-press preview still works). */
  disableNavigation?: boolean;
  /** Colour override for @mentions on dark/inverted backgrounds. */
  mentionColor?: string;
  /** Colour override for #hashtags on dark/inverted backgrounds. */
  hashtagColor?: string;
}

// ── Internal segment types ─────────────────────────────────────────────────────

type PlainSegment   = { kind: 'plain';   text: string };
type MentionSegment = { kind: 'mention'; tag: RichTextTag;        displayText: string; interactive: boolean };
type HashtagSegment = { kind: 'hashtag'; hashtag: RichTextHashtag; displayText: string; interactive: boolean };
type Segment = PlainSegment | MentionSegment | HashtagSegment;

// ── Position-based segment builder ────────────────────────────────────────────

function buildSegments(
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

  // Sort by start position; discard out-of-bounds spans
  spans.sort((a, b) => a.start - b.start);

  const segs: Segment[] = [];
  let cursor = 0;

  for (const span of spans) {
    // Skip overlapping or out-of-bounds spans
    if (span.start < cursor || span.end > content.length || span.start >= span.end) continue;

    // Plain text before this span
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

  // Trailing plain text
  if (cursor < content.length) {
    segs.push({ kind: 'plain', text: content.slice(cursor) });
  }

  return segs;
}

// ── Navigation ─────────────────────────────────────────────────────────────────

/** Short-press navigation — routes that actually exist in the app. */
function navigateTag(tag: RichTextTag) {
  switch (tag.type) {
    case 'user':
      // Navigate by handle (matchToken), not UUID
      router.push(`/u/${tag.matchToken}` as any);
      break;
    case 'trip':
      router.push(`/trip/${tag.id}` as any);
      break;
    case 'place':
      // Hidden-gems / discovery place detail screen
      router.push(`/gems/${tag.id}` as any);
      break;
    // 'circle' — app/circle.tsx is the viewer's own circle; no /circle/:id route exists
    // 'event'  — no event detail route exists yet
    // → long-press preview sheet is available for these types; no short-press nav
    default:
      break;
  }
}

/** Returns true only for entity types that have a real detail route. */
function canNavigateShortPress(tag: RichTextTag): boolean {
  return tag.type === 'user' || tag.type === 'trip' || tag.type === 'place';
}

function navigateHashtag(slug: string) {
  router.push(`/hashtag/${slug}` as any);
}

// ── Preview state ──────────────────────────────────────────────────────────────

type PreviewState =
  | { kind: 'tag';     tag: RichTextTag }
  | { kind: 'hashtag'; hashtag: RichTextHashtag };

// ── Component ──────────────────────────────────────────────────────────────────

export function RichText({
  content,
  tags,
  hashtagUsages,
  style,
  numberOfLines,
  disableNavigation,
  mentionColor,
  hashtagColor,
}: RichTextProps) {
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const hasTags     = (tags?.length ?? 0) > 0;
  const hasHashtags = (hashtagUsages?.length ?? 0) > 0;

  // ── Plain-text fast-path — no saved metadata → no interactivity ──────────
  if (!hasTags && !hasHashtags) {
    return <Text style={style} numberOfLines={numberOfLines}>{content}</Text>;
  }

  // ── Position-based rendering ──────────────────────────────────────────────
  const segments = buildSegments(content, tags ?? [], hashtagUsages ?? []);

  function renderSegment(seg: Segment, i: number): React.ReactNode {
    if (seg.kind === 'plain') {
      return <Text key={i}>{seg.text}</Text>;
    }

    if (seg.kind === 'mention') {
      if (!seg.interactive) {
        return <Text key={i}>{seg.displayText}</Text>;
      }
      const canNav = !disableNavigation && canNavigateShortPress(seg.tag);
      return (
        <Text
          key={i}
          style={[_s.mention, mentionColor ? { color: mentionColor } : null]}
          onPress={canNav ? () => navigateTag(seg.tag) : undefined}
          onLongPress={() => setPreview({ kind: 'tag', tag: seg.tag })}
          suppressHighlighting={canNav}
        >
          {seg.displayText}
        </Text>
      );
    }

    // hashtag
    if (!seg.interactive) {
      return <Text key={i}>{seg.displayText}</Text>;
    }
    return (
      <Text
        key={i}
        style={[_s.hashtag, hashtagColor ? { color: hashtagColor } : null]}
        onPress={!disableNavigation ? () => navigateHashtag(seg.hashtag.slug) : undefined}
        onLongPress={() => setPreview({ kind: 'hashtag', hashtag: seg.hashtag })}
        suppressHighlighting={!disableNavigation}
      >
        {seg.displayText}
      </Text>
    );
  }

  function handleSheetNavigate() {
    const p = preview;
    setPreview(null);
    if (!p) return;
    if (p.kind === 'tag') {
      if (canNavigateShortPress(p.tag)) navigateTag(p.tag);
    } else {
      navigateHashtag(p.hashtag.slug);
    }
  }

  const sheetType: PreviewEntityType = preview
    ? preview.kind === 'tag' ? preview.tag.type : 'hashtag'
    : 'hashtag';

  // TagPreviewSheet calls getUserByHandle for 'user' type, so pass the handle
  // (matchToken), not the UUID.  All other types use the entity UUID.
  const sheetId = preview
    ? preview.kind === 'tag'
      ? preview.tag.type === 'user'
        ? preview.tag.matchToken
        : preview.tag.id
      : preview.hashtag.slug
    : '';

  const sheetLabel = preview
    ? preview.kind === 'tag'
      ? `@${preview.tag.matchToken}`
      : `#${preview.hashtag.slug}`
    : '';

  return (
    <>
      <Text style={style} numberOfLines={numberOfLines}>
        {segments.map(renderSegment)}
      </Text>
      <TagPreviewSheet
        visible={!!preview}
        type={sheetType}
        id={sheetId}
        label={sheetLabel}
        onClose={() => setPreview(null)}
        onNavigate={handleSheetNavigate}
      />
    </>
  );
}

const _s = StyleSheet.create({
  mention: { color: color.signal, fontWeight: '600' },
  hashtag: { color: color.deep,   fontWeight: '600' },
});
