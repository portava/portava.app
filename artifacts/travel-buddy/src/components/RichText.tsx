/**
 * RichText — renders user-generated text with tappable @mention and #hashtag spans.
 *
 * Data model (whitelist-based):
 *   - `tags`          — saved @mention annotations from the `tags` table.
 *                       Each entry has a `matchToken` (handle) used to validate
 *                       regex-found `@word` tokens in the raw text.
 *   - `hashtagUsages` — saved #hashtag annotations from the `hashtag_usage` table.
 *                       Each entry has a `slug` used to validate `#word` tokens.
 *
 * Rendering pipeline:
 *   1. Split `content` by `@word` / `#word` regex.
 *   2. Each `@word` token is interactive only when its lowercased word matches a
 *      `matchToken` in the `tags` whitelist AND the tag is not blocked/deleted/private.
 *   3. Each `#word` token is interactive only when its lowercased word matches a
 *      `slug` in the `hashtagUsages` whitelist AND the hashtag is not blocked.
 *   4. Unmatched tokens (spurious @/# in text) render as plain text.
 *
 * Fallback behaviour:
 *   When BOTH `tags` and `hashtagUsages` are absent (or empty arrays), the content
 *   renders as plain `<Text>` with no interactivity and no regex processing.
 *   This ensures content without saved metadata is never spuriously linked.
 *
 * Short-press → navigate; long-press → TagPreviewSheet mini-card.
 * Navigation routes: user → /u/:handle  |  trip → /trip/:id  |  place → /gems/:id
 * circle and event have no dedicated detail route — long-press preview only.
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
  /**
   * UUID of the entity — used for TagPreviewSheet API calls.
   * For `user` type this is the profile UUID.
   */
  id: string;
  /**
   * The token that appears after `@` in the text, e.g. `"alice"` for `@alice`.
   * Matching is case-insensitive. For user mentions this equals the handle.
   */
  matchToken: string;
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
  /** When true the hashtag is blocked by the viewer → plain text. */
  isBlocked?: boolean;
}

export interface RichTextProps {
  content: string;
  /** @mention whitelist from the API. When absent AND hashtagUsages absent → plain text. */
  tags?: RichTextTag[];
  /** #hashtag whitelist from the API. When absent AND tags absent → plain text. */
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
type MentionSegment = { kind: 'mention'; tag: RichTextTag;     displayText: string; interactive: boolean };
type HashtagSegment = { kind: 'hashtag'; hashtag: RichTextHashtag; displayText: string; interactive: boolean };
type Segment = PlainSegment | MentionSegment | HashtagSegment;

// ── Whitelist-based segment builder ───────────────────────────────────────────

function buildSegments(
  content: string,
  tags: RichTextTag[],
  hashtagUsages: RichTextHashtag[],
): Segment[] {
  // Build O(1) lookup maps (lowercased keys for case-insensitive matching)
  const tagMap = new Map<string, RichTextTag>();
  for (const t of tags) tagMap.set(t.matchToken.toLowerCase(), t);

  const hashMap = new Map<string, RichTextHashtag>();
  for (const h of hashtagUsages) hashMap.set(h.slug.toLowerCase(), h);

  // Split on @word / #word boundaries; the capture group keeps the delimiters
  const parts = content.split(/(@\w+|#[a-zA-Z0-9_]+)/g);
  const segs: Segment[] = [];

  for (const part of parts) {
    if (!part) continue;

    if (part[0] === '@') {
      const token = part.slice(1).toLowerCase();
      const tag   = tagMap.get(token);
      if (!tag) {
        segs.push({ kind: 'plain', text: part });
      } else {
        const interactive = !(tag.isBlocked || tag.isDeleted || tag.isPrivate);
        segs.push({ kind: 'mention', tag, displayText: part, interactive });
      }
      continue;
    }

    if (part[0] === '#') {
      const token  = part.slice(1).toLowerCase();
      const hashtag = hashMap.get(token);
      if (!hashtag) {
        segs.push({ kind: 'plain', text: part });
      } else {
        segs.push({ kind: 'hashtag', hashtag, displayText: part, interactive: !hashtag.isBlocked });
      }
      continue;
    }

    segs.push({ kind: 'plain', text: part });
  }

  return segs;
}

// ── Navigation ─────────────────────────────────────────────────────────────────

/** Short-press navigation — routes that actually exist in the app. */
function navigateTag(tag: RichTextTag) {
  switch (tag.type) {
    case 'user':
      router.push(`/u/${tag.matchToken}` as any);
      break;
    case 'trip':
      router.push(`/trip/${tag.id}` as any);
      break;
    case 'place':
      // Hidden-gems / discovery place detail screen
      router.push(`/gems/${tag.id}` as any);
      break;
    // 'circle' — app/circle.tsx is the viewer's own circle, no /circle/:id route
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

  // ── Whitelist-based rendering ─────────────────────────────────────────────
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
  const sheetId = preview
    ? preview.kind === 'tag' ? preview.tag.id : preview.hashtag.slug
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
