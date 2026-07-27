/**
 * WatchFeedList — full-screen paging FlatList for Watch mode.
 *
 * - One item per viewport, snapToInterval = screen height.
 * - Viewability tracking drives isActive prop on each cell.
 * - Gesture layer: single-tap → toggle play/pause, double-tap → like,
 *   press-and-hold → pause while held.
 * - HeartBurst animation on double-tap (multi-particle).
 * - Progress bar at the bottom with scrubbing (pan to seek).
 * - Mute/unmute button with AsyncStorage persistence.
 * - Poster prefetch for upcoming items on active-index change.
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
  Text,
  Image,
  type ViewToken,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Volume2, VolumeX } from 'lucide-react-native';
import type { Video } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WatchVideoCell, type WatchVideoCellHandle } from './WatchVideoCell.tsx';
import { WatchItemOverlay } from './WatchItemOverlay.tsx';
import { HeartBurst, type HeartBurstHandle } from './HeartBurst.tsx';
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
  // ── Playback state ─────────────────────────────────────────────────────────
  const [progress, setProgress] = useState(0);
  const [userPaused, setUserPaused] = useState(false);

  // ── Scrub state ────────────────────────────────────────────────────────────
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubProgress, setScrubProgress] = useState(0);
  const isScrubbingRef = useRef(false);
  const scrubProgressRef = useRef(0);
  const durationMsRef = useRef<number | null>(null);
  const lastSeekRef = useRef(0);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const cellVideoHandle = useRef<WatchVideoCellHandle>(null);
  const heartBurstRef = useRef<HeartBurstHandle>(null);

  // Reset user-pause and scrub when the cell becomes active/inactive.
  useEffect(() => {
    if (!isActive) {
      setUserPaused(false);
      setProgress(0);
      setScrubProgress(0);
      isScrubbingRef.current = false;
      setIsScrubbing(false);
    }
  }, [isActive]);

  // ── Progress callback ──────────────────────────────────────────────────────

  const handleProgress = useCallback((ratio: number, durMs: number | null) => {
    if (!isScrubbingRef.current) {
      setProgress(ratio);
    }
    if (durMs != null) {
      durationMsRef.current = durMs;
    }
  }, []);

  // ── Like helpers ───────────────────────────────────────────────────────────

  const handleLike = useCallback(() => {
    onLike(item.id);
    heartBurstRef.current?.trigger();
  }, [item.id, onLike]);

  // Double-tap: always show burst, but only fire the like action when not
  // already liked. Double-tap is idempotent like-once — never unlikes.
  const handleDoubleTapLike = useCallback(() => {
    if (!isLiked) {
      onLike(item.id);
    }
    heartBurstRef.current?.trigger();
  }, [item.id, isLiked, onLike]);

  // ── Main gesture (full-screen layer) ──────────────────────────────────────

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(250)
    .runOnJS(true)
    .onEnd(() => { handleDoubleTapLike(); });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .maxDuration(250)
    .requireExternalGestureToFail(doubleTap)
    .runOnJS(true)
    .onEnd(() => {
      if (!isActive) return;
      setUserPaused((p) => !p);
    });

  const longPress = Gesture.LongPress()
    .minDuration(400)
    .runOnJS(true)
    .onStart(() => { setUserPaused(true); })
    .onEnd(() => { setUserPaused(false); })
    .onFinalize(() => { setUserPaused(false); });

  const composed = Gesture.Exclusive(doubleTap, singleTap, longPress);

  // ── Scrub gesture (progress bar area) ─────────────────────────────────────

  const scrubGesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(1)
        .runOnJS(true)
        .onBegin((e) => {
          isScrubbingRef.current = true;
          setIsScrubbing(true);
          const ratio = Math.max(0, Math.min(1, e.absoluteX / SCREEN_W));
          scrubProgressRef.current = ratio;
          setScrubProgress(ratio);
        })
        .onChange((e) => {
          const ratio = Math.max(0, Math.min(1, e.absoluteX / SCREEN_W));
          scrubProgressRef.current = ratio;
          setScrubProgress(ratio);
          // Throttle actual seek calls to ≈12 fps to avoid hammering expo-av
          const now = Date.now();
          if (now - lastSeekRef.current >= 80 && durationMsRef.current) {
            lastSeekRef.current = now;
            cellVideoHandle.current?.videoRef.current
              ?.setPositionAsync(ratio * durationMsRef.current)
              .catch(() => {});
          }
        })
        .onFinalize(() => {
          isScrubbingRef.current = false;
          setIsScrubbing(false);
          // Final seek to exact scrub position
          if (durationMsRef.current) {
            cellVideoHandle.current?.videoRef.current
              ?.setPositionAsync(scrubProgressRef.current * durationMsRef.current)
              .catch(() => {});
          }
        }),
    [], // all values accessed via refs — safe to skip as deps
  );

  // ── Video ref forwarding (for playback manager) ────────────────────────────

  const handleVideoRef = useCallback(
    (id: string, ref: React.RefObject<Video | null>) => {
      onVideoRef(id, ref);
    },
    [onVideoRef],
  );

  const effectiveActive = isActive && !userPaused;
  const displayProgress = isScrubbing ? scrubProgress : progress;

  return (
    <View style={s.cellContainer}>
      <WatchVideoCell
        ref={cellVideoHandle}
        id={item.id}
        videoUrl={item.videoUrl}
        posterUrl={item.posterUrl}
        isActive={effectiveActive}
        isMuted={isMuted}
        onProgress={handleProgress}
        onVideoRef={handleVideoRef}
        onVideoUnmount={onVideoUnmount}
      />

      {/* Full-screen gesture layer (tap / double-tap / long press) */}
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

      {/* ── Progress bar with scrub gesture ──────────────────────────── */}
      <GestureDetector gesture={scrubGesture}>
        <View style={[s.progressHitArea, isScrubbing && s.progressHitAreaActive]}>
          <View style={[s.progressTrack, isScrubbing && s.progressTrackActive]}>
            <View
              style={[
                s.progressFill,
                { width: `${Math.round(displayProgress * 100)}%` as any },
              ]}
            />
            {/* Scrub handle dot — visible only while scrubbing */}
            {isScrubbing ? (
              <View
                style={[
                  s.scrubHandle,
                  { left: displayProgress * SCREEN_W - 6 },
                ]}
              />
            ) : null}
          </View>
        </View>
      </GestureDetector>

      {/* Heart burst animation overlay */}
      <HeartBurst ref={heartBurstRef} />

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

  // ── Poster prefetch — preload upcoming items so they start fast ────────────

  useEffect(() => {
    // Prefetch poster images for the next 2 items whenever the active item changes.
    const nextItems = items.slice(activeIndex + 1, activeIndex + 3);
    for (const ni of nextItems) {
      if (ni.posterUrl) {
        Image.prefetch(ni.posterUrl).catch(() => {});
      }
    }
  }, [activeIndex, items]);

  // ── Viewability ────────────────────────────────────────────────────────────

  const onActiveIndexChangeRef = useRef(onActiveIndexChange);
  useEffect(() => {
    onActiveIndexChangeRef.current = onActiveIndexChange;
  }, [onActiveIndexChange]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length === 0) return;
      const first = viewableItems[0];
      const idx = first.index ?? 0;
      onActiveIndexChangeRef.current(idx);
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
        style={s.list}
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
        windowSize={7}
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
  list: {
    flex: 1,
  },
  cellContainer: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: color.ink,
    overflow: 'hidden',
  },

  // ── Progress bar ──────────────────────────────────────────────────────────
  progressHitArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 28,      // large touch target
    justifyContent: 'flex-end',
  },
  progressHitAreaActive: {
    height: 36,      // slightly larger while scrubbing for easier control
  },
  progressTrack: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  progressTrackActive: {
    height: 5,
  },
  progressFill: {
    height: '100%',
    backgroundColor: color.signal,
  },
  scrubHandle: {
    position: 'absolute',
    bottom: -4.5,   // vertically centre on the 3-px track
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },

  // ── Pause indicator ───────────────────────────────────────────────────────
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

  // ── Mute button ───────────────────────────────────────────────────────────
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
