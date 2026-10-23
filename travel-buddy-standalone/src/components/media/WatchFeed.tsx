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
import { useMediaSave } from '../../hooks/useMediaSave.ts';
import { WatchFeedList } from './WatchFeedList.tsx';
import { MediaCommentSheet } from './MediaCommentSheet.tsx';
import { MediaMoreMenu } from './MediaMoreMenu.tsx';
import { WhyThisSheet } from './WhyThisSheet.tsx';
import type { WatchFeedType } from '../../types/media.ts';
import { color, type as t, space } from '../../theme/tokens.ts'; import { getOverlayHeaderTotalHeight } from '../ui/AppHeader.tsx';
import { useSession } from '../../context/SessionContext.tsx'; import { useFeatureFlags } from '../../context/FeatureFlagsContext.tsx'; import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
    gap: space.md, paddingHorizontal: space.md, paddingTop: space.xs, borderRadius: 999, backgroundColor: 'rgba(17,17,15,0.71)', // census-media §31.12: an ink backing, the least alpha at which the inactive label clears 4.5:1 over a white frame
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
  const insets = useSafeAreaInsets();
  // The Following feed is served only while MEDIA_FOLLOWING_ENABLED is on (off
  // in production, 2026-10-22): the toggle offered it anyway, the server
  // refused with feature_disabled, and the error screen had no way back to
  // For You. With the flag off there is nothing to toggle between, so no
  // toggle; a selection left on Following is moved back to For You.
  const followingOn = useFeatureFlags().isEnabled('MEDIA_FOLLOWING_ENABLED');
  useEffect(() => {
    if (!followingOn && feed.feedType === 'following') feed.setFeedType('for_you');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followingOn, feed.feedType]);

  // ── Interaction hooks (optimistic, API-backed) ──────────────────────────
  const saveHook = useMediaSave();

  // ── Sheet state ─────────────────────────────────────────────────────────
  const [commentItemId, setCommentItemId] = useState<string | null>(null);
  const [moreMenuItemId, setMoreMenuItemId] = useState<string | null>(null);
  const [whyThisItemId, setWhyThisItemId] = useState<string | null>(null);

  // Seed save state when new items arrive (seeder skips already-known ids).
  useEffect(() => {
    if (feed.items.length === 0) return;
    saveHook.seed(feed.items);
  }, [feed.items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load initial feed on mount.
  useEffect(() => {
    feed.loadFeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Interaction handlers ─────────────────────────────────────────────────

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

  // The toggle sits below the media tab's overlay header and its mode selector
  // (app/(tabs)/media.tsx), cleared the way GemsFeed clears its filter bar. At
  // `top: 0` it sat at 12–44pt: behind the Dynamic Island and under the header.
  const toggleBar = followingOn ? (
    <View
      style={[s.toggleBar, { top: getOverlayHeaderTotalHeight(insets.top) + 4 + MODE_SELECTOR_HEIGHT + TOGGLE_GAP }]}
      pointerEvents="box-none"
      testID="watch-feed-toggle-bar"
    >
      <FeedToggle feedType={feed.feedType} onChange={handleFeedTypeChange} />
    </View>
  ) : null;

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

    // The toggle stays on the error screen: a feed that failed is not a dead
    // end while the other feed is a tap away.
    return (
      <View style={{ flex: 1, backgroundColor: color.ink }}>
        {toggleBar}
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
      </View>
    );
  }

  // ── Empty feed ───────────────────────────────────────────────────────────

  if (!feed.loading && feed.items.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: color.ink }}>
        {toggleBar}
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
        onComment={handleComment}
        onSave={handleSave}
        onMore={handleMore}
        savedSet={saveHook.savedSet}
      />

      {/* Feed type toggle — floated top-center, below the overlay header */}
      {toggleBar}

      {/* ── Comment sheet ──────────────────────────────────────────────── */}
      <MediaCommentSheet
        mediaId={commentItemId}
        visible={commentItemId !== null}
        onClose={() => setCommentItemId(null)}
        onCountChange={(count) => {
          if (commentItemId) feed.setItemCommentCount(commentItemId, count);
        }}
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

/** media.tsx's mode selector pill (it sits 4pt below the overlay header), and the gap under it — GemsFeed's values. */
const MODE_SELECTOR_HEIGHT = 44;
const TOGGLE_GAP = 8;

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
    position: 'absolute', // `top` is inset-aware, set where it is drawn
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingBottom: 8,
    zIndex: 30,
  },
});
