/**
 * RichText — renders user-generated text with tappable @mention and #hashtag spans.
 *
 * Data model:
 *   - `tags`          — @entity mentions from the `tags` table (start/end indices).
 *   - `hashtagUsages` — #hashtag spans from the `hashtag_usage` table (start/end indices).
 *
 * Fallback behaviour:
 *   - When BOTH `tags` and `hashtagUsages` are absent (or empty), the content is
 *     rendered as **plain text** with no interactivity. No regex auto-linking is applied.
 *     This ensures that content without saved metadata is never spuriously linked.
 *
 * Blocked / deleted / private entities:
 *   - Tags or hashtags flagged as `isBlocked`, `isDeleted`, or `isPrivate` are
 *     rendered as plain, non-interactive text with normal body styling.
 *
 * Short-press → navigate; long-press → TagPreviewSheet mini-card.
 */
import React, { useState } from 'react';
import { Text, StyleSheet, type TextStyle, type StyleProp } from 'react-native';
import { router } from 'expo-router';
import { color } from '../theme/tokens';
import { TagPreviewSheet, type PreviewEntityType } from './TagPreviewSheet';

// ── Public types ───────────────────────────────────────────────────────────────

export type RichTextEntityType = 'user' | 'event' | 'circle' | 'trip' | 'place';

/** A persisted @mention annotation returned by the API. */
export interface RichTextTag {
  /** The entity type of the tagged target. */
  type: RichTextEntityType;
  /**
   * For `user`: the handle (used for navigation and preview fetch).
   * For all other types: the entity UUID (used for navigation).
   */
  id: string;
  /** The text slice as it appears in `content`, e.g. "@alice" or "@Sunset Dinner". */
  displayText: string;
  startChar: number;
  endChar: number;
  /** When true the target is blocked by (or blocking) the viewer → render as plain text. */
  isBlocked?: boolean;
  /** When true the target has been deleted → render as plain text. */
  isDeleted?: boolean;
  /** When true the target is private/inaccessible → render as plain text. */
  isPrivate?: boolean;
}

/** A persisted #hashtag annotation returned by the API. */
export interface RichTextHashtag {
  /** The canonical slug without the `#` prefix. */
  slug: string;
  /** The text slice as it appears in `content`, e.g. "#travel". */
  displayText: string;
  startChar: number;
  endChar: number;
  /** When true the hashtag is blocked by the viewer → render as plain text. */
  isBlocked?: boolean;
}

export interface RichTextProps {
  content: string;
  /** @mention spans from the API. When absent and hashtagUsages also absent, renders plain text. */
  tags?: RichTextTag[];
  /** #hashtag spans from the API. When absent and tags also absent, renders plain text. */
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

type PlainSegment = { kind: 'plain'; text: string };
type MentionSegment = {
  kind: 'mention';
  tag: RichTextTag;
  interactive: boolean; // false when blocked/deleted/private
};
type HashtagSegment = {
  kind: 'hashtag';
  hashtag: RichTextHashtag;
  interactive: boolean;
};
type Segment = PlainSegment | MentionSegment | HashtagSegment;

// ── Segment builder ────────────────────────────────────────────────────────────

type AnySpan =
  | { kind: 'mention'; start: number; end: number; tag: RichTextTag }
  | { kind: 'hashtag'; start: number; end: number; hashtag: RichTextHashtag };

function buildSegments(
  content: string,
  tags: RichTextTag[],
  hashtagUsages: RichTextHashtag[],
): Segment[] {
  const spans: AnySpan[] = [
    ...tags.map((t) => ({
      kind: 'mention' as const,
      start: Math.max(0, Math.min(t.startChar, content.length)),
      end:   Math.max(0, Math.min(t.endChar,   content.length)),
      tag: t,
    })),
    ...hashtagUsages.map((h) => ({
      kind: 'hashtag' as const,
      start: Math.max(0, Math.min(h.startChar, content.length)),
      end:   Math.max(0, Math.min(h.endChar,   content.length)),
      hashtag: h,
    })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  const segs: Segment[] = [];
  let cursor = 0;

  for (const sp of spans) {
    if (sp.start < cursor) continue; // overlapping span — skip
    if (sp.start > cursor) {
      segs.push({ kind: 'plain', text: content.slice(cursor, sp.start) });
    }
    if (sp.kind === 'mention') {
      const blocked = !!(sp.tag.isBlocked || sp.tag.isDeleted || sp.tag.isPrivate);
      segs.push({ kind: 'mention', tag: sp.tag, interactive: !blocked });
    } else {
      segs.push({ kind: 'hashtag', hashtag: sp.hashtag, interactive: !sp.hashtag.isBlocked });
    }
    cursor = sp.end;
  }

  if (cursor < content.length) {
    segs.push({ kind: 'plain', text: content.slice(cursor) });
  }

  return segs;
}

// ── Navigation ─────────────────────────────────────────────────────────────────

function navigateTag(tag: RichTextTag) {
  switch (tag.type) {
    case 'user':   router.push(`/u/${tag.id}` as any); break;
    case 'trip':   router.push(`/trip/${tag.id}` as any); break;
    case 'circle': router.push(`/circle/${tag.id}` as any); break;
    // event and place have no dedicated detail route yet
    default: break;
  }
}

function navigateHashtag(slug: string) {
  router.push(`/hashtag/${slug}` as any);
}

// ── Preview state ──────────────────────────────────────────────────────────────

type PreviewState =
  | { kind: 'tag'; tag: RichTextTag }
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

  // ── Plain-text fast-path ─────────────────────────────────────────────────────
  if (!hasTags && !hasHashtags) {
    return <Text style={style} numberOfLines={numberOfLines}>{content}</Text>;
  }

  // ── Span-based rendering ─────────────────────────────────────────────────────
  const segments = buildSegments(content, tags ?? [], hashtagUsages ?? []);

  const canNavTag = (tag: RichTextTag) =>
    !disableNavigation && (tag.type === 'user' || tag.type === 'trip' || tag.type === 'circle');

  function renderSegment(seg: Segment, i: number): React.ReactNode {
    if (seg.kind === 'plain') {
      return <Text key={i}>{seg.text}</Text>;
    }
    if (seg.kind === 'mention') {
      if (!seg.interactive) {
        // Blocked / deleted / private → plain text
        return <Text key={i}>{seg.tag.displayText}</Text>;
      }
      return (
        <Text
          key={i}
          style={[_s.mention, mentionColor ? { color: mentionColor } : null]}
          onPress={canNavTag(seg.tag) ? () => navigateTag(seg.tag) : undefined}
          onLongPress={() => setPreview({ kind: 'tag', tag: seg.tag })}
          suppressHighlighting={canNavTag(seg.tag)}
        >
          {seg.tag.displayText}
        </Text>
      );
    }
    // hashtag
    if (!seg.interactive) {
      return <Text key={i}>{seg.hashtag.displayText}</Text>;
    }
    return (
      <Text
        key={i}
        style={[_s.hashtag, hashtagColor ? { color: hashtagColor } : null]}
        onPress={!disableNavigation ? () => navigateHashtag(seg.hashtag.slug) : undefined}
        onLongPress={() => setPreview({ kind: 'hashtag', hashtag: seg.hashtag })}
        suppressHighlighting={!disableNavigation}
      >
        {seg.hashtag.displayText}
      </Text>
    );
  }

  function handleSheetNavigate() {
    const p = preview;
    setPreview(null);
    if (!p) return;
    if (p.kind === 'tag') navigateTag(p.tag);
    else navigateHashtag(p.hashtag.slug);
  }

  const sheetType: PreviewEntityType = preview
    ? preview.kind === 'tag' ? preview.tag.type : 'hashtag'
    : 'hashtag';
  const sheetId = preview
    ? preview.kind === 'tag' ? preview.tag.id : preview.hashtag.slug
    : '';
  const sheetLabel = preview
    ? preview.kind === 'tag' ? preview.tag.displayText : preview.hashtag.displayText
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
