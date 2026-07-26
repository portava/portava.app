/**
 * WatchFeedList — full-screen paging FlatList for Watch mode.
 *
 * - One item per viewport, snapToInterval = screen height.
 * - Viewability tracking drives isActive prop on each cell.
 * - Gesture layer: single-tap → toggle play/pause, double-tap → like,
 *   press-and-hold → pause while held.
 * - Progress bar driven by playback status updates.
 * - Heart animation on double-tap.
 * - Mute/unmute button with AsyncStorage persistence.
 */

import React, {
  useCallback,
  useRef,
  useState,
  useEffect,
  useMemo,
} from 'react';
import {
  FlatList,
  View,
  Pressable,
  StyleSheet,
  Dimensions,
  Animated,
  Text,
  type ViewToken,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Volume2, VolumeX } from 'lucide-react-native';
import type { Video } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WatchVideoCell } from './WatchVideoCell.tsx';
import { WatchItemOverlay } from './WatchItemOverlay.tsx';
import { useWatchPlayback } from '../../hooks/useWatchPlayback.ts';
import type { MediaFeedItem } from '../../types/media.ts';
import { color, radius } from '../../theme/tokens.ts';

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get('window');
const MUTE_KEY = 'media:muted';

// ── Viewability config ────────────────────────────────────────────────────────

const VIEWABILITY_CONFIG = {
  minimumViewTime: 150,
  itemVisiblePercentThreshold: 60,
};

// ── Per-cell gesture + progress wrapper ───────────────────────────────────────

interface CellWrapperProps {
  item: MediaFeedItem;
  isActive: boolean;
  isMuted: boolean;
  currentUserId?: string;
  onLike: (id: string) => void;
  onComment: (id: string) => void;
  onSave: (id: string) => void;
  onMore: (id: string) => void;
  onVideoRef: (id: string, ref: React.RefObject<Video | null>) => void;
  onVideoUnmount: (id: string) => void;
  // Local like state passed from parent
  isLiked: boolean;
  isSaved: boolean;
  likeCount: number;
}

const CellWrapper = React.memo(function CellWrapper({
  item,
  isActive,
  isMuted,
  currentUserId,
  onLike,
  onComment,
  onSave,
  onMore,
  onVideoRef,
  onVideoUnmount,
  isLiked,
  isSaved,
  likeCount,
}: CellWrapperProps) {
  // Per-cell playback progress (0–1).
  const [progress, setProgress] = useState(0);
  // Play/pause local toggle (driven by gesture; isActive resets it).
  const [userPaused, setUserPaused] = useState(false);
  const videoRefLocal = useRef<Video>(null);

  // Reset user-pause when the cell becomes active/inactive.
  useEffect(() => {
    if (!isActive) {
      setUserPaused(false);
      setProgress(0);
    }
  }, [isActive]);

  // Heart animation state.
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;

  const triggerHeartAnim = useCallback(() => {
    heartScale.setValue(0);
    heartOpacity.setValue(1);
    Animated.sequence([
      Animated.spring(heartScale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 12 }),
      Animated.delay(400),
      Animated.timing(heartOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start();
  }, [heartScale, heartOpacity]);

  const handleLike = useCallback(() => {
    onLike(item.id);
    triggerHeartAnim();
  }, [item.id, onLike, triggerHeartAnim]);

  // Double-tap: always show heart anim, but only fire the like action when the
  // item is not already liked. Double-tap is idempotent like-once — it never
  // unlikes (unlike the action-button which is a full toggle).
  const handleDoubleTapLike = useCallback(() => {
    if (!isLiked) {
      onLike(item.id);
    }
    triggerHeartAnim();
  }, [item.id, isLiked, onLike, triggerHeartAnim]);

  // ── Gestures ──────────────────────────────────────────────────────────────

  // Double-tap → like (idempotent) + heart anim.
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(250)
    .runOnJS(true)
    .onEnd(() => {
      handleDoubleTapLike();
    });

  // Single tap → toggle play/pause.
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .maxDuration(250)
    .requireExternalGestureToFail(doubleTap)
    .runOnJS(true)
    .onEnd(() => {
      if (!isActive) return;
      setUserPaused((p) => !p);
    });

  // Long press → pause while held.
  const longPress = Gesture.LongPress()
    .minDuration(400)
    .runOnJS(true)
    .onStart(() => {
      setUserPaused(true);
    })
    .onEnd(() => {
      setUserPaused(false);
    })
    .onFinalize(() => {
      setUserPaused(false);
    });

  const composed = Gesture.Exclusive(doubleTap, singleTap, longPress);

  const effectiveActive = isActive && !userPaused;

  const handleVideoRef = useCallback(
    (id: string, ref: React.RefObject<Video | null>) => {
      onVideoRef(id, ref);
    },
    [onVideoRef],
  );

  return (
    <View style={s.cellContainer}>
      <WatchVideoCell
        id={item.id}
        videoUrl={item.videoUrl}
        posterUrl={item.posterUrl}
        isActive={effectiveActive}
        isMuted={isMuted}
        onProgress={setProgress}
        onVideoRef={handleVideoRef}
        onVideoUnmount={onVideoUnmount}
      />

      {/* Gesture layer over the video */}
      <GestureDetector gesture={composed}>
        <View style={StyleSheet.absoluteFill} />
      </GestureDetector>

      {/* Overlay (creator info, captions, actions) */}
      <WatchItemOverlay
        item={item}
        currentUserId={currentUserId}
        isLiked={isLiked}
        isSaved={isSaved}
        likeCount={likeCount}
        onLike={() => handleLike()}
        onComment={() => onComment(item.id)}
        onSave={() => onSave(item.id)}
        onMore={() => onMore(item.id)}
      />

      {/* Playback progress bar */}
      <View style={s.progressTrack} pointerEvents="none">
        <View style={[s.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>

      {/* Heart animation overlay */}
      <Animated.View
        style={[s.heartAnim, { transform: [{ scale: heartScale }], opacity: heartOpacity }]}
        pointerEvents="none"
      >
        <Text style={s.heartEmoji}>❤️</Text>
      </Animated.View>

      {/* Pause indicator */}
      {userPaused ? (
        <View style={s.pauseIndicator} pointerEvents="none">
          <View style={s.pauseIcon}>
            <View style={s.pauseBar} />
            <View style={s.pauseBar} />
          </View>
        </View>
      ) : null}
    </View>
  );
});

// ── Props ─────────────────────────────────────────────────────────────────────

export interface WatchFeedListProps {
  items: MediaFeedItem[];
  activeIndex: number;
  currentUserId?: string;
  onActiveIndexChange: (idx: number) => void;
  onEndReached: () => void;
  onLike: (id: string) => void;
  onComment: (id: string) => void;
  onSave: (id: string) => void;
  onMore: (id: string) => void;
  /** Liked items set (id → true). */
  likedSet: Record<string, boolean>;
  /** Saved items set (id → true). */
  savedSet: Record<string, boolean>;
  /** Like counts (id → count). */
  likeCounts: Record<string, number>;
}

// ── Main component ────────────────────────────────────────────────────────────

export function WatchFeedList({
  items,
  activeIndex,
  currentUserId,
  onActiveIndexChange,
  onEndReached,
  onLike,
  onComment,
  onSave,
  onMore,
  likedSet,
  savedSet,
  likeCounts,
}: WatchFeedListProps) {
  const insets = useSafeAreaInsets();
  const playback = useWatchPlayback();

  // Mute state — persisted to AsyncStorage.
  const [isMuted, setIsMuted] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(MUTE_KEY).then((val) => {
      if (val !== null) setIsMuted(val === 'true');
    }).catch(() => {});
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((m) => {
      const next = !m;
      AsyncStorage.setItem(MUTE_KEY, String(next)).catch(() => {});
      return next;
    });
  }, []);

  // ── Viewability ────────────────────────────────────────────────────────────

  // Keep a ref to the latest onActiveIndexChange so viewability events always
  // target the CURRENT feed type's slot — not a stale closure from before the
  // last feed-type switch (for_you ↔ following).
  const onActiveIndexChangeRef = useRef(onActiveIndexChange);
  useEffect(() => {
    onActiveIndexChangeRef.current = onActiveIndexChange;
  }, [onActiveIndexChange]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length === 0) return;
      const first = viewableItems[0];
      const idx = first.index ?? 0;
      onActiveIndexChangeRef.current(idx); // always calls the latest version
      const item = first.item as MediaFeedItem;
      playback.setActiveId(item.id);
    },
  ).current;

  // ── Render item ────────────────────────────────────────────────────────────

  const renderItem = useCallback(
    ({ item, index }: { item: MediaFeedItem; index: number }) => (
      <CellWrapper
        item={item}
        isActive={index === activeIndex}
        isMuted={isMuted}
        currentUserId={currentUserId}
        onLike={onLike}
        onComment={onComment}
        onSave={onSave}
        onMore={onMore}
        onVideoRef={playback.registerRef}
        onVideoUnmount={playback.unregisterRef}
        isLiked={likedSet[item.id] ?? item.likedByMe}
        isSaved={savedSet[item.id] ?? item.savedByMe}
        likeCount={likeCounts[item.id] ?? item.likeCount}
      />
    ),
    [activeIndex, isMuted, currentUserId, onLike, onComment, onSave, onMore,
      playback.registerRef, playback.unregisterRef, likedSet, savedSet, likeCounts],
  );

  const keyExtractor = useCallback((item: MediaFeedItem) => item.id, []);

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: SCREEN_H,
      offset: SCREEN_H * index,
      index,
    }),
    [],
  );

  return (
    <View style={s.root}>
      <FlatList
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        pagingEnabled
        snapToInterval={SCREEN_H}
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={VIEWABILITY_CONFIG}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        windowSize={5}
        maxToRenderPerBatch={3}
        initialNumToRender={2}
        removeClippedSubviews
        scrollEventThrottle={16}
      />

      {/* Mute / unmute button — floats top-right */}
      <Pressable
        style={[s.muteBtn, { top: insets.top + 60 }]}
        onPress={toggleMute}
        accessibilityRole="button"
        accessibilityLabel={isMuted ? 'Unmute' : 'Mute'}
        hitSlop={8}
      >
        {isMuted
          ? <VolumeX size={18} color="#fff" />
          : <Volume2 size={18} color="#fff" />}
      </Pressable>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.ink,
  },
  cellContainer: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: color.ink,
    overflow: 'hidden',
  },
  progressTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: color.signal,
  },
  heartAnim: {
    position: 'absolute',
    top: '35%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  heartEmoji: {
    fontSize: 80,
  },
  pauseIndicator: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseIcon: {
    flexDirection: 'row',
    gap: 6,
    width: 44,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseBar: {
    width: 6,
    height: 32,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  muteBtn: {
    position: 'absolute',
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
});
