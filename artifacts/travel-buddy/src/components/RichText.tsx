/**
 * RichText — inline renderer that turns @mention and #hashtag tokens into
 * tappable, styled spans. Short-press navigates; long-press opens TagPreviewSheet.
 *
 * Two modes:
 *  1. Positional (preferred) — caller passes `spans` with startChar/endChar positions,
 *     allowing multi-word entity names (e.g. "@Trip Title") to render correctly.
 *  2. Regex fallback — when no spans are provided; handles @handle + #slug tokens only
 *     (single-word tokens, fine for user handles and hashtag slugs).
 *
 * Usage:
 *   // Regex fallback (no span data from backend yet)
 *   <RichText content={post.content} style={styles.caption} numberOfLines={4} />
 *
 *   // With positional spans from API
 *   <RichText content={msg.body} spans={msg.richSpans} style={styles.bubble} />
 */
import React, { useState } from 'react';
import { Text, StyleSheet, type TextStyle, type StyleProp } from 'react-native';
import { router } from 'expo-router';
import { color } from '../theme/tokens';
import { TagPreviewSheet } from './TagPreviewSheet';

// ── Types ──────────────────────────────────────────────────────────────────────

export type RichTextEntityType = 'user' | 'event' | 'circle' | 'trip' | 'place' | 'hashtag';

/**
 * A positional span annotation from the API (e.g. from `tags` / `hashtag_usage` tables).
 * `id` is the entity's UUID for trips/circles/events/places, the handle for users,
 * and the slug for hashtags.
 */
export interface RichTextSpan {
  type: RichTextEntityType;
  id: string;
  displayText: string; // e.g. "@alice", "#travel", "@Sunset Dinner"
  startChar: number;
  endChar: number;
}

// ── Segment model ──────────────────────────────────────────────────────────────

type TextSegment = { kind: 'text'; text: string };
type SpanSegment = { kind: 'span'; span: RichTextSpan };
type Segment = TextSegment | SpanSegment;

function buildSegmentsFromSpans(content: string, spans: RichTextSpan[]): Segment[] {
  const sorted = [...spans].sort((a, b) => a.startChar - b.startChar);
  const segs: Segment[] = [];
  let cursor = 0;
  for (const span of sorted) {
    const start = Math.max(0, Math.min(span.startChar, content.length));
    const end   = Math.max(start, Math.min(span.endChar, content.length));
    if (start > cursor) segs.push({ kind: 'text', text: content.slice(cursor, start) });
    segs.push({ kind: 'span', span });
    cursor = end;
  }
  if (cursor < content.length) segs.push({ kind: 'text', text: content.slice(cursor) });
  return segs;
}

const SPAN_RE = /(@\w+|#[a-zA-Z0-9_]+)/g;

function buildSegmentsFromRegex(content: string): Segment[] {
  const parts = content.split(SPAN_RE);
  return parts
    .filter((p) => p.length > 0)
    .map((p): Segment => {
      if (p[0] === '@' && p.length > 1) {
        return {
          kind: 'span',
          span: { type: 'user', id: p.slice(1), displayText: p, startChar: -1, endChar: -1 },
        };
      }
      if (p[0] === '#' && p.length > 1) {
        return {
          kind: 'span',
          span: { type: 'hashtag', id: p.slice(1), displayText: p, startChar: -1, endChar: -1 },
        };
      }
      return { kind: 'text', text: p };
    });
}

// ── Navigation helper ──────────────────────────────────────────────────────────

function navigateTo(span: RichTextSpan) {
  switch (span.type) {
    case 'user':    router.push(`/u/${span.id}` as any); break;
    case 'trip':    router.push(`/trip/${span.id}` as any); break;
    case 'circle':  router.push(`/circle/${span.id}` as any); break;
    case 'hashtag': router.push(`/hashtag/${span.id}` as any); break;
    // event and place have no dedicated route yet — long-press preview only
    default:        break;
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

interface PreviewState {
  span: RichTextSpan;
}

export interface RichTextProps {
  content: string;
  /** Positional span annotations from the API. When provided, multi-word entity names work. */
  spans?: RichTextSpan[];
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** Suppress short-press navigation (long-press preview still works). */
  disableNavigation?: boolean;
  /** Colour overrides for dark/inverted backgrounds (e.g. mine-bubble on signal red). */
  mentionColor?: string;
  hashtagColor?: string;
}

export function RichText({
  content,
  spans,
  style,
  numberOfLines,
  disableNavigation,
  mentionColor,
  hashtagColor,
}: RichTextProps) {
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const segments: Segment[] =
    spans && spans.length > 0
      ? buildSegmentsFromSpans(content, spans)
      : buildSegmentsFromRegex(content);

  const hasInteractiveSpan = segments.some((seg) => seg.kind === 'span');

  function spanStyle(type: RichTextEntityType): { color: string; fontWeight: '600' } {
    if (type === 'hashtag') return { color: hashtagColor ?? color.deep, fontWeight: '600' };
    return { color: mentionColor ?? color.signal, fontWeight: '600' };
  }

  const canNavigate = (span: RichTextSpan) =>
    !disableNavigation && (span.type === 'user' || span.type === 'trip' ||
      span.type === 'circle' || span.type === 'hashtag');

  return (
    <>
      <Text style={style} numberOfLines={numberOfLines}>
        {segments.map((seg, i) => {
          if (seg.kind === 'text') return <Text key={i}>{seg.text}</Text>;
          const { span } = seg;
          return (
            <Text
              key={i}
              style={spanStyle(span.type)}
              onPress={canNavigate(span) ? () => navigateTo(span) : undefined}
              onLongPress={() => setPreview({ span })}
              suppressHighlighting={canNavigate(span)}
            >
              {span.displayText}
            </Text>
          );
        })}
      </Text>

      {hasInteractiveSpan && (
        <TagPreviewSheet
          visible={!!preview}
          type={preview?.span.type ?? 'hashtag'}
          id={preview?.span.id ?? ''}
          label={preview?.span.displayText ?? ''}
          onClose={() => setPreview(null)}
          onNavigate={() => {
            const p = preview;
            setPreview(null);
            if (p) navigateTo(p.span);
          }}
        />
      )}
    </>
  );
}

const _s = StyleSheet.create({
  mention: { color: color.signal, fontWeight: '600' },
  hashtag: { color: color.deep,   fontWeight: '600' },
});
