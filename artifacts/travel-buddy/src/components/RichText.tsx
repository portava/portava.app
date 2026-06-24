/**
 * RichText — inline renderer that turns @handle and #hashtag tokens in plain text
 * into tappable, styled spans. Short-press navigates; long-press opens a preview sheet.
 *
 * Usage:
 *   <RichText content={post.content} style={styles.caption} numberOfLines={4} />
 */
import React, { useState } from 'react';
import { Text, StyleSheet, type TextStyle, type StyleProp } from 'react-native';
import { router } from 'expo-router';
import { color } from '../theme/tokens';
import { TagPreviewSheet } from './TagPreviewSheet';

// Captures @word and #word, splits everything else as plain text.
const SPAN_RE = /(@\w+|#[a-zA-Z0-9_]+)/g;

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; handle: string }
  | { kind: 'hashtag'; slug: string };

function parseSegments(content: string): Segment[] {
  const parts = content.split(SPAN_RE);
  return parts
    .filter((p) => p.length > 0)
    .map((p): Segment => {
      if (p[0] === '@' && p.length > 1) return { kind: 'mention', handle: p.slice(1) };
      if (p[0] === '#' && p.length > 1) return { kind: 'hashtag', slug: p.slice(1) };
      return { kind: 'text', text: p };
    });
}

interface PreviewState {
  type: 'user' | 'hashtag';
  id: string;
}

export interface RichTextProps {
  content: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /**
   * Suppress navigation on tap (e.g. inside a larger Pressable card).
   * Long-press previews still work.
   */
  disableNavigation?: boolean;
  /** Override colours for @mention and #hashtag spans (e.g. for dark/inverted bubbles). */
  mentionColor?: string;
  hashtagColor?: string;
}

export function RichText({
  content, style, numberOfLines, disableNavigation,
  mentionColor, hashtagColor,
}: RichTextProps) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const segments = parseSegments(content);

  const hasInteractiveSpan = segments.some((seg) => seg.kind !== 'text');

  const mentionStyle = mentionColor ? { color: mentionColor, fontWeight: '600' as const } : s.mention;
  const hashtagStyle = hashtagColor ? { color: hashtagColor, fontWeight: '600' as const } : s.hashtag;

  return (
    <>
      <Text style={style} numberOfLines={numberOfLines}>
        {segments.map((seg, i) => {
          if (seg.kind === 'text') {
            return <Text key={i}>{seg.text}</Text>;
          }
          if (seg.kind === 'mention') {
            return (
              <Text
                key={i}
                style={mentionStyle}
                onPress={
                  disableNavigation
                    ? undefined
                    : () => router.push(`/u/${seg.handle}` as any)
                }
                onLongPress={() => setPreview({ type: 'user', id: seg.handle })}
                suppressHighlighting={!disableNavigation}
              >
                @{seg.handle}
              </Text>
            );
          }
          return (
            <Text
              key={i}
              style={hashtagStyle}
              onPress={
                disableNavigation
                  ? undefined
                  : () => router.push(`/hashtag/${seg.slug}` as any)
              }
              onLongPress={() => setPreview({ type: 'hashtag', id: seg.slug })}
              suppressHighlighting={!disableNavigation}
            >
              #{seg.slug}
            </Text>
          );
        })}
      </Text>

      {hasInteractiveSpan && (
        <TagPreviewSheet
          visible={!!preview}
          type={preview?.type ?? 'hashtag'}
          id={preview?.id ?? ''}
          onClose={() => setPreview(null)}
          onNavigate={() => {
            const p = preview;
            setPreview(null);
            if (!p) return;
            if (p.type === 'hashtag') {
              router.push(`/hashtag/${p.id}` as any);
            } else {
              router.push(`/u/${p.id}` as any);
            }
          }}
        />
      )}
    </>
  );
}

const s = StyleSheet.create({
  mention: {
    color: color.signal,
    fontWeight: '600',
  },
  hashtag: {
    color: color.deep,
    fontWeight: '600',
  },
});
