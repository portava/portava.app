import React from 'react';
import { View, Text, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { color, space, radius, type as t, shadow } from '../theme/tokens.ts';
import type { PostRow } from '../services/posts.ts';
import { formatRelativeTime } from '../lib/dateTime/formatters.ts';

/**
 * Real-posts list — renders ACTUAL backend posts from GET /api/posts (via
 * useGlobalFeed). This is a proof-of-round-trip surface, not the final feed
 * design. The rich mock PulseFeedItem cards remain elsewhere on the screen.
 *
 * Pass data/loading/error/reload from useGlobalFeed() in the parent so refetch
 * can be triggered on screen focus (after the composer creates a post).
 */

function RealPostCard({ post }: { post: PostRow }) {
  return (
    <View style={s.card}>
      <View style={s.metaRow}>
        <Text style={s.author} numberOfLines={1}>{shortId(post.authorId)}</Text>
        <View style={{ flex: 1 }} />
        <View style={[s.badge, post.visibility !== 'public' && s.badgeAlt]}>
          <Text style={s.badgeText}>{post.visibility}</Text>
        </View>
      </View>
      <Text style={s.body}>{post.content}</Text>
      <View style={s.footRow}>
        {post.tripId ? <Text style={s.trip}>· trip post</Text> : null}
        <View style={{ flex: 1 }} />
        <Text style={s.time}>{formatRelativeTime(post.createdAt)}</Text>
      </View>
    </View>
  );
}

function shortId(id: string): string {
  // No author profile join in this proof step; show a short stable handle.
  return id ? `@${id.slice(0, 8)}` : '@unknown';
}

export function RealPostsList({
  data, loading, error, onRetry,
}: {
  data: PostRow[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <View style={s.section}>
      <View style={s.headRow}>
        <Text style={s.heading}>Live posts</Text>
        <View style={s.liveDot} />
      </View>

      {loading && data.length === 0 ? (
        <View style={s.stateBox}><ActivityIndicator color={color.signal} /></View>
      ) : error ? (
        <View style={s.stateBox}>
          <Text style={s.errText}>{error}</Text>
          {onRetry ? (
            <Pressable onPress={onRetry} style={s.retry}><Text style={s.retryText}>Retry</Text></Pressable>
          ) : null}
        </View>
      ) : data.length === 0 ? (
        <View style={s.stateBox}>
          <Text style={s.emptyText}>No posts yet. Be the first to share something.</Text>
        </View>
      ) : (
        <View style={{ gap: space.sm }}>
          {data.map((p) => <RealPostCard key={p.id} post={p} />)}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  section: { paddingHorizontal: space.lg, gap: space.sm, marginBottom: space.lg },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading: { ...t.title, color: color.ink, fontSize: 18 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.success },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, ...shadow.card },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  author: { ...t.bodyStrong, color: color.ink, fontSize: 14, maxWidth: 160 },
  badge: { paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: color.haze },
  badgeAlt: { backgroundColor: color.deep },
  badgeText: { ...t.small, fontSize: 11, fontWeight: '700', color: color.onInk },
  body: { ...t.body, color: color.ink },
  footRow: { flexDirection: 'row', alignItems: 'center' },
  trip: { ...t.small, color: color.mute },
  time: { ...t.small, color: color.mute },
  stateBox: { padding: space.lg, alignItems: 'center', gap: space.sm, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  errText: { ...t.body, color: '#B23B3B', textAlign: 'center' },
  retry: { paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: color.ink, borderRadius: radius.pill },
  retryText: { ...t.small, color: color.onInk, fontWeight: '700' },
});
