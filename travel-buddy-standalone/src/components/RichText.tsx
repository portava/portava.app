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
 * Navigation routes:
 *   user   → /u/:matchToken  (by handle)
 *   trip   → /trip/:id
 *   place  → /gems/:id
 *   event  → /meetup/:id  (events are modelled as meetups in this app)
 *   circle → long-press preview only (circles are per-user singletons, no /circle/:id route)
 *
 * TagPreviewSheet contract:
 *   For `user` type the sheet expects a *handle* (calls getUserByHandle internally),
 *   so we pass `tag.matchToken` — NOT `tag.id` — as the sheet `id` prop.
 */
import React, { useState } from 'react';
import { Text, StyleSheet, Alert, type TextStyle, type StyleProp } from 'react-native';
import { router } from 'expo-router';
import { color } from '../theme/tokens.ts';
import { navigateToProfile } from '../lib/navigateToProfile.ts';
import { TagPreviewSheet, type PreviewEntityType } from './TagPreviewSheet.tsx';
import { removeSelfTag } from '../services/tagging.ts';
import {
  buildSegments,
  type RichTextEntityType,
  type RichTextTag,
  type RichTextHashtag,
  type Segment,
} from './richTextSegments.ts';
import { errorCopy } from '../lib/errorCopy.ts';

// Re-export public types so consumers can import from 'RichText' as before.
export type { RichTextEntityType, RichTextTag, RichTextHashtag };

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
  /**
   * When provided, long-pressing the viewer's own @mention shows a
   * "Remove this tag" action (calls DELETE /api/tags/:id).
   */
  currentUserId?: string;
}

// ── Navigation ─────────────────────────────────────────────────────────────────

/** Short-press navigation — routes that actually exist in the app. */
function navigateTag(tag: RichTextTag, currentUserId?: string) {
  switch (tag.type) {
    case 'user':
      // Navigate by handle (matchToken), not UUID. Self-taps → own Passport tab.
      navigateToProfile(tag.matchToken, tag.id, currentUserId);
      break;
    case 'trip':
      router.push(`/trip/${tag.id}` as any);
      break;
    case 'place':
      // Hidden-gems / discovery place detail screen
      router.push(`/gems/${tag.id}` as any);
      break;
    case 'event':
      // Events are modelled as meetups in this app — app/meetup/[id].tsx
      router.push(`/meetup/${tag.id}` as any);
      break;
    // 'circle' — app/circle.tsx is the viewer's own circle; there is no parameterised
    //            /circle/:id route (circles are per-user singletons).  Long-press
    //            preview sheet is available instead.
    default:
      break;
  }
}

/** Returns true only for entity types that have a real detail route. */
function canNavigateShortPress(tag: RichTextTag): boolean {
  return (
    tag.type === 'user' ||
    tag.type === 'trip' ||
    tag.type === 'place' ||
    tag.type === 'event'
  );
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
  currentUserId,
}: RichTextProps) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [removedTagRowIds, setRemovedTagRowIds] = useState<Set<string>>(new Set());

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
      // Self-removed tags render as plain text immediately without a round-trip
      if (seg.tag.tagRowId && removedTagRowIds.has(seg.tag.tagRowId)) {
        return <Text key={i}>{seg.displayText}</Text>;
      }
      if (!seg.interactive) {
        return <Text key={i}>{seg.displayText}</Text>;
      }
      const canNav = !disableNavigation && canNavigateShortPress(seg.tag);

      // Self-tag: long-press shows "Remove this tag" action sheet
      const isSelfTag =
        currentUserId &&
        seg.tag.type === 'user' &&
        seg.tag.id === currentUserId &&
        !!seg.tag.tagRowId;

      const handleLongPress = isSelfTag
        ? () => {
            const tagRowId = seg.tag.tagRowId!;
            Alert.alert(
              'Tag options',
              undefined,
              [
                {
                  text: 'Remove this tag',
                  style: 'destructive',
                  onPress: async () => {
                    const res = await removeSelfTag(tagRowId);
                    if (res.ok) {
                      setRemovedTagRowIds((prev) => new Set(prev).add(tagRowId));
                    } else {
                      Alert.alert('Could not remove tag', errorCopy(res.error, 'Please try again.'));
                    }
                  },
                },
                { text: 'View profile', onPress: () => setPreview({ kind: 'tag', tag: seg.tag }) },
                { text: 'Cancel', style: 'cancel' },
              ],
              { cancelable: true },
            );
          }
        : () => setPreview({ kind: 'tag', tag: seg.tag });

      return (
        <Text
          key={i}
          style={[_s.mention, mentionColor ? { color: mentionColor } : null]}
          onPress={canNav ? () => navigateTag(seg.tag, currentUserId) : undefined}
          onLongPress={handleLongPress}
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
      if (canNavigateShortPress(p.tag)) navigateTag(p.tag, currentUserId);
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
