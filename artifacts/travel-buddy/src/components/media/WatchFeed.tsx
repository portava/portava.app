/**
 * WatchFeed — full-screen vertical video feed for Watch mode.
 *
 * Fetches from GET /api/media/feed?mode=fullscreen, renders a paging list,
 * and manages like/save state with real API calls (optimistic updates).
 *
 * Empty, error, offline, and end-of-feed states all render intentional UI.
 */

import React, { useEffect, useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import {
  WifiOff,
  Frown,
  Film,
} from 'lucide-react-native';
import { useWatchFeed } from '../../hooks/useWatchFeed.ts';
import { useMediaLike } from '../../hooks/useMediaLike.ts';
import { useMediaSave } from '../../hooks/useMediaSave.ts';
import { WatchFeedList } from './WatchFeedList.tsx';
import { MediaCommentSheet } from './MediaCommentSheet.tsx';
import { MediaMoreMenu } from './MediaMoreMenu.tsx';
import { WhyThisSheet } from './WhyThisSheet.tsx';
import type { WatchFeedType } from '../../types/media.ts';
import { color, type as t, space } from '../../theme/tokens.ts';
import { useSession } from '../../context/SessionContext.tsx';
// SessionContextValue exposes `userId` (string | null), not `user`

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
  const session = useSession();
  const currentUserId = session?.userId ?? undefined;

  // ── Interaction hooks (optimistic, API-backed) ──────────────────────────
  const likeHook = useMediaLike();
  const saveHook = useMediaSave();

  // ── Sheet state ─────────────────────────────────────────────────────────
  const [commentItemId, setCommentItemId] = useState<string | null>(null);
  const [moreMenuItemId, setMoreMenuItemId] = useState<string | null>(null);
  const [whyThisItemId, setWhyThisItemId] = useState<string | null>(null);

  // Seed like/save state when new items arrive (seeder skips already-known ids).
  useEffect(() => {
    if (feed.items.length === 0) return;
    likeHook.seed(feed.items);
    saveHook.seed(feed.items);
  }, [feed.items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load initial feed on mount.
  useEffect(() => {
    feed.loadFeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Interaction handlers ─────────────────────────────────────────────────

  const handleLike = useCallback((id: string) => {
    likeHook.toggleLike(id);
  }, [likeHook]);

  const handleComment = useCallback((id: string) => {
    setCommentItemId(id);
  }, []);

  const handleSave = useCallback((id: string) => {
    saveHook.toggleSave(id);
  }, [saveHook]);

  const handleMore = useCallback((id: string) => {
    setMoreMenuItemId(id);
  }, []);

  // ── Feed type switch ─────────────────────────────────────────────────────

  const handleFeedTypeChange = useCallback(
    (type: WatchFeedType) => {
      feed.setFeedType(type);
    },
    [feed],
  );

  // ── Item removed (e.g. from more-menu delete/block/hide) ────────────────
  // Feed will pick this up on next refresh; for now the item stays visible
  // until the user pulls to refresh. (Full filtering is a follow-up.)

  // ── More-menu active item ────────────────────────────────────────────────
  const moreMenuItem = feed.items.find((i) => i.id === moreMenuItemId) ?? null;
  const whyThisItem = feed.items.find((i) => i.id === whyThisItemId) ?? null;

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
        currentUserId={currentUserId}
        onActiveIndexChange={feed.setActiveIndex}
        onEndReached={feed.loadMore}
        onLike={handleLike}
        onComment={handleComment}
        onSave={handleSave}
        onMore={handleMore}
        likedSet={likeHook.likedSet}
        savedSet={saveHook.savedSet}
        likeCounts={likeHook.likeCounts}
      />

      {/* Feed type toggle — floated top-center */}
      <View style={s.toggleBar} pointerEvents="box-none">
        <FeedToggle feedType={feed.feedType} onChange={handleFeedTypeChange} />
      </View>

      {/* ── Comment sheet ──────────────────────────────────────────────── */}
      <MediaCommentSheet
        mediaId={commentItemId}
        visible={commentItemId !== null}
        onClose={() => setCommentItemId(null)}
      />

      {/* ── More menu ──────────────────────────────────────────────────── */}
      <MediaMoreMenu
        visible={moreMenuItemId !== null}
        mediaId={moreMenuItemId}
        creatorId={moreMenuItem?.creator?.id ?? null}
        isOwner={
          !!currentUserId &&
          !!moreMenuItem &&
          moreMenuItem.creator?.id === currentUserId
        }
        isGems={false}
        onWhyThis={() => {
          setMoreMenuItemId(null);
          setWhyThisItemId(moreMenuItemId);
        }}
        onItemRemoved={() => {
          setMoreMenuItemId(null);
          // Item stays in feed until next refresh
        }}
        onClose={() => setMoreMenuItemId(null)}
      />

      {/* ── Why This? sheet ────────────────────────────────────────────── */}
      <WhyThisSheet
        visible={whyThisItemId !== null}
        explanation={(whyThisItem as any)?.compassExplanation ?? null}
        onClose={() => setWhyThisItemId(null)}
      />
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
