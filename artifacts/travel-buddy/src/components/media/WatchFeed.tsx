/**
 * WatchFeed — full-screen vertical video feed for Watch mode.
 *
 * Fetches from GET /api/media/feed?mode=fullscreen, renders a paging list,
 * and manages local like/save state (connected to real API in a follow-up task).
 *
 * Empty, error, offline, and end-of-feed states all render intentional UI.
 */

import React, { useEffect, useCallback, useState, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import {
  WifiOff,
  Frown,
  Film,
  RefreshCw,
} from 'lucide-react-native';
import { useWatchFeed } from '../../hooks/useWatchFeed.ts';
import { WatchFeedList } from './WatchFeedList.tsx';
import type { WatchFeedType } from '../../types/media.ts';
import { color, type as t, space } from '../../theme/tokens.ts';

// ── Empty / error state components ───────────────────────────────────────────

function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={e.container}>
      {icon}
      <Text style={e.title}>{title}</Text>
      {subtitle ? <Text style={e.subtitle}>{subtitle}</Text> : null}
      {action ? (
        <Pressable onPress={action.onPress} style={e.btn}>
          <Text style={e.btnText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const e = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.ink,
    gap: 12,
    paddingHorizontal: 40,
  },
  title: {
    ...t.heading,
    color: color.onInk,
    textAlign: 'center',
  },
  subtitle: {
    ...t.body,
    color: color.onInkMute,
    textAlign: 'center',
  },
  btn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  btnText: {
    ...t.bodyStrong,
    color: color.onInk,
  },
});

// ── Feed type toggle bar ──────────────────────────────────────────────────────

interface FeedToggleProps {
  feedType: WatchFeedType;
  onChange: (t: WatchFeedType) => void;
}

function FeedToggle({ feedType, onChange }: FeedToggleProps) {
  return (
    <View style={ft.row}>
      {(['for_you', 'following'] as WatchFeedType[]).map((type) => (
        <Pressable
          key={type}
          onPress={() => onChange(type)}
          style={[ft.tab, feedType === type && ft.tabActive]}
          hitSlop={6}
        >
          <Text style={[ft.label, feedType === type && ft.labelActive]}>
            {type === 'for_you' ? 'For You' : 'Following'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const ft = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.md,
  },
  tab: {
    paddingBottom: 4,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: color.onInk,
  },
  label: {
    ...t.bodyStrong,
    color: color.onInkMute,
  },
  labelActive: {
    color: color.onInk,
  },
});

// ── Main WatchFeed component ──────────────────────────────────────────────────

export function WatchFeed() {
  const feed = useWatchFeed();

  // Local interaction state — will connect to real API in the interactions task.
  const [likedSet, setLikedSet] = useState<Record<string, boolean>>({});
  const [savedSet, setSavedSet] = useState<Record<string, boolean>>({});
  const [likeCounts, setLikeCounts] = useState<Record<string, number>>({});
  const initializedRef = useRef(false);

  // Initialise local state from feed items when they first arrive.
  useEffect(() => {
    if (feed.items.length === 0 || initializedRef.current) return;
    initializedRef.current = true;
    const liked: Record<string, boolean> = {};
    const saved: Record<string, boolean> = {};
    const counts: Record<string, number> = {};
    for (const item of feed.items) {
      liked[item.id] = item.likedByMe;
      saved[item.id] = item.savedByMe;
      counts[item.id] = item.likeCount;
    }
    setLikedSet(liked);
    setSavedSet(saved);
    setLikeCounts(counts);
  }, [feed.items]);

  // Seed new items as they arrive (infinite scroll).
  useEffect(() => {
    setLikedSet((prev) => {
      const next = { ...prev };
      for (const item of feed.items) {
        if (!(item.id in next)) next[item.id] = item.likedByMe;
      }
      return next;
    });
    setSavedSet((prev) => {
      const next = { ...prev };
      for (const item of feed.items) {
        if (!(item.id in next)) next[item.id] = item.savedByMe;
      }
      return next;
    });
    setLikeCounts((prev) => {
      const next = { ...prev };
      for (const item of feed.items) {
        if (!(item.id in next)) next[item.id] = item.likeCount;
      }
      return next;
    });
  }, [feed.items]);

  // Load initial feed on mount.
  useEffect(() => {
    feed.loadFeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Interaction handlers ─────────────────────────────────────────────────

  const handleLike = useCallback((id: string) => {
    setLikedSet((prev) => {
      const wasLiked = prev[id] ?? false;
      setLikeCounts((counts) => ({
        ...counts,
        [id]: Math.max(0, (counts[id] ?? 0) + (wasLiked ? -1 : 1)),
      }));
      return { ...prev, [id]: !wasLiked };
    });
    // TODO (interactions task): call like/unlike API
  }, []);

  const handleComment = useCallback((_id: string) => {
    // TODO (interactions task): open comment sheet
  }, []);

  const handleSave = useCallback((id: string) => {
    setSavedSet((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }));
    // TODO (interactions task): call save/unsave API
  }, []);

  const handleMore = useCallback((_id: string) => {
    Alert.alert('Options', '', [
      { text: 'Report', style: 'destructive', onPress: () => {} },
      { text: 'Not interested', onPress: () => {} },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, []);

  // ── Feed type switch ─────────────────────────────────────────────────────

  const handleFeedTypeChange = useCallback(
    (type: WatchFeedType) => {
      initializedRef.current = false;
      feed.setFeedType(type);
    },
    [feed],
  );

  // ── Loading state (initial, no items yet) ────────────────────────────────

  if (feed.loading && feed.items.length === 0) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color={color.signal} />
      </View>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────

  if (feed.error && feed.items.length === 0) {
    const isOffline =
      feed.error.toLowerCase().includes('network') ||
      feed.error.toLowerCase().includes('failed to fetch');

    return (
      <EmptyState
        icon={
          isOffline
            ? <WifiOff size={48} color={color.onInkMute} />
            : <Frown size={48} color={color.onInkMute} />
        }
        title={isOffline ? 'You\'re offline' : 'Something went wrong'}
        subtitle={
          isOffline
            ? 'Check your connection and try again.'
            : 'We couldn\'t load the feed right now.'
        }
        action={{ label: 'Retry', onPress: () => feed.loadFeed() }}
      />
    );
  }

  // ── Empty feed ───────────────────────────────────────────────────────────

  if (!feed.loading && feed.items.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: color.ink }}>
        <View style={s.toggleBar}>
          <FeedToggle feedType={feed.feedType} onChange={handleFeedTypeChange} />
        </View>
        <EmptyState
          icon={<Film size={48} color={color.onInkMute} />}
          title={
            feed.feedType === 'following'
              ? 'No videos yet'
              : 'Nothing here yet'
          }
          subtitle={
            feed.feedType === 'following'
              ? 'Follow creators to see their videos here.'
              : 'Check back soon for fresh travel content.'
          }
        />
      </View>
    );
  }

  // ── Feed list ────────────────────────────────────────────────────────────

  return (
    <View style={s.root}>
      <WatchFeedList
        items={feed.items}
        activeIndex={feed.activeIndex}
        currentUserId={undefined}
        onActiveIndexChange={feed.setActiveIndex}
        onEndReached={feed.loadMore}
        onLike={handleLike}
        onComment={handleComment}
        onSave={handleSave}
        onMore={handleMore}
        likedSet={likedSet}
        savedSet={savedSet}
        likeCounts={likeCounts}
      />

      {/* Feed type toggle — floated top-center */}
      <View style={s.toggleBar} pointerEvents="box-none">
        <FeedToggle feedType={feed.feedType} onChange={handleFeedTypeChange} />
      </View>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.ink,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.ink,
  },
  toggleBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 8,
    zIndex: 30,
  },
});
