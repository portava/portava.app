/**
 * WatchFeedList — full-screen paging FlatList for Watch mode.
 *
 * - One item per viewport, snapToInterval = screen height.
 * - Viewability tracking drives isActive prop on each cell.
 * - Gesture layer: single-tap → toggle play/pause, double-tap → like,
 *   press-and-hold → pause while held + open radial quick-menu.
 * - Swipe right (≥60 px) → Route It place sheet.
 * - HeartBurst animation on double-tap (multi-particle).
 * - Progress bar at the bottom with scrubbing (pan to seek).
 * - Mute/unmute button with AsyncStorage persistence.
 * - Poster prefetch for upcoming items on active-index change.
 * - Swipe-right hint arrow shown after the first 3 videos.
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
  Animated,
  type ViewToken,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Volume2, VolumeX } from 'lucide-react-native';
import type { Video } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { WatchVideoCell, type WatchVideoCellHandle } from './WatchVideoCell.tsx';
import { WatchItemOverlay } from './WatchItemOverlay.tsx';
import { HeartBurst, type HeartBurstHandle } from './HeartBurst.tsx';
import { RouteItPlaceSheet } from './RouteItPlaceSheet.tsx';
import { WatchRadialMenu } from './WatchRadialMenu.tsx';
import { useWatchPlayback } from '../../hooks/useWatchPlayback.ts';
import { useWatchStamp } from '../../hooks/useWatchStamp.ts';
import type { MediaFeedItem } from '../../types/media.ts';
import { color, radius } from '../../theme/tokens.ts';
import { usePlanPicker } from '../PlanPickerController.tsx';
import { Share } from 'react-native';

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
  onComment: (id: string) => void;
  onSave: (id: string) => void;
  onMore: (id: string) => void;
  onVideoRef: (id: string, ref: React.RefObject<Video | null>) => void;
  onVideoUnmount: (id: string) => void;
  isSaved: boolean;
  /** Show a faint swipe-right hint arrow (after user has seen ≥3 videos). */
  showSwipeHint?: boolean;
}

const CellWrapper = React.memo(function CellWrapper({
  item,
  isActive,
  isMuted,
  currentUserId,
  onComment,
  onSave,
  onMore,
  onVideoRef,
  onVideoUnmount,
  isSaved,
  showSwipeHint = false,
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

  // ── Stamp state — single shared controller for the rail button AND the
  // double-tap-on-content gesture below (bug fix: previously the rail button
  // and double-tap each had no shared source of truth / no wiring at all).
  const stamp = useWatchStamp(item);

  // ── Route It state ────────────────────────────────────────────────────────
  const [showRouteIt, setShowRouteIt] = useState(false);
  const routeItTriggeredRef = useRef(false);

  // Swipe hint arrow opacity — fades in after showSwipeHint becomes true,
  // then fades out once the Route It gesture fires.
  const swipeHintOpacity = useRef(new Animated.Value(0)).current;
  const swipeHintShownRef = useRef(false);

  useEffect(() => {
    if (showSwipeHint && isActive && !swipeHintShownRef.current) {
      swipeHintShownRef.current = true;
      Animated.sequence([
        Animated.delay(800),
        Animated.timing(swipeHintOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.delay(2000),
        Animated.timing(swipeHintOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start();
    }
  }, [showSwipeHint, isActive, swipeHintOpacity]);

  // ── Radial menu state ────────────────────────────────────────────────────
  const [showRadialMenu, setShowRadialMenu] = useState(false);
  const { open: openPlanPicker } = usePlanPicker();

  // Reset user-pause and scrub when the cell becomes active/inactive.
  useEffect(() => {
    if (!isActive) {
      setUserPaused(false);
      setProgress(0);
      setScrubProgress(0);
      isScrubbingRef.current = false;
      setIsScrubbing(false);
      setShowRadialMenu(false);
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

  // ── Double-tap → Stamp ───────────────────────────────────────────────────

  // Bug fix (2026-07-28): double-tap used to only fire a heart-burst visual
  // and had no effect on stamp state. Per the Universal Stamp spec,
  // double-tapping anywhere on the content must trigger the full stamp
  // animation launched FROM the tap coordinates, sharing state with the
  // rail's stamp button via `stamp` (useWatchStamp).
  const handleDoubleTapStamp = useCallback(
    (x: number, y: number) => {
      console.log('[STAMP_DEBUG] handleDoubleTapStamp fired', { x, y });
      heartBurstRef.current?.trigger();
      stamp.triggerAt(x, y);
    },
    [stamp],
  );

  // ── Radial menu action callbacks ──────────────────────────────────────────

  const handleSaveGem = useCallback(() => {
    router.push('/media/add-gem' as any);
  }, []);

  const handleAddToTrip = useCallback(() => {
    const locationParts = [item.place?.name, item.place?.city].filter(Boolean);
    openPlanPicker({
      id: item.place?.id ?? item.id,
      type: 'place',
      title: item.place?.name ?? (item.caption.slice(0, 60) || 'Video'),
      city: item.place?.city ?? undefined,
      locationName: locationParts.join(', ') || undefined,
    });
  }, [item, openPlanPicker]);

  const handleShareTelegraph = useCallback(() => {
    Share.share({
      message: item.caption
        ? `${item.caption} — via Portava`
        : 'Check this out on Portava!',
    }).catch(() => {});
  }, [item.caption]);

  const handleFindHere = useCallback(() => {
    const query = item.place?.name ?? item.place?.city ?? '';
    router.push((`/discover?q=${encodeURIComponent(query)}`) as any);
  }, [item.place]);

  const handleRadialDismiss = useCallback(() => {
    setShowRadialMenu(false);
    setUserPaused(false);
  }, []);

  // ── Main gesture (full-screen layer) ──────────────────────────────────────

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(250)
    .runOnJS(true)
    .onEnd((e) => { handleDoubleTapStamp(e.absoluteX, e.absoluteY); });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .maxDuration(250)
    .requireExternalGestureToFail(doubleTap)
    .runOnJS(true)
    .onEnd(() => {
      if (!isActive) return;
      setUserPaused((p) => !p);
    });

  // Long-press: pause video AND open radial quick-menu.
  const longPress = Gesture.LongPress()
    .minDuration(400)
    .runOnJS(true)
    .onStart(() => {
      setUserPaused(true);
      setShowRadialMenu(true);
    })
    .onEnd(() => { setUserPaused(false); })
    .onFinalize(() => { setUserPaused(false); });

  // ── Route It pan gesture (swipe right ≥60 px, horizontal-only) ────────────

  const routeItPan = useMemo(
    () =>
      Gesture.Pan()
        // Only activate after 60+ px of rightward horizontal movement
        .activeOffsetX([60, 99999])
        // Fail if vertical drift exceeds ±15 px — keeps vertical scroll intact
        .failOffsetY([-15, 15])
        .runOnJS(true)
        .onStart(() => {
          if (!routeItTriggeredRef.current) {
            routeItTriggeredRef.current = true;
            setShowRouteIt(true);
            // Fade out hint once gesture fires
            Animated.timing(swipeHintOpacity, {
              toValue: 0,
              duration: 200,
              useNativeDriver: true,
            }).start();
          }
        })
        .onFinalize(() => {
          routeItTriggeredRef.current = false;
        }),
    // swipeHintOpacity is a ref — safe to omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Bug fix (2026-07-28): these four gestures used to be composed as
  // Simultaneous(Exclusive(tap gestures), routeItPan). Simultaneous meant the
  // swipe-right pan could activate independently WHILE a tap/double-tap was
  // still being recognized — a normal finger's lateral drift during a
  // double-tap was enough to also satisfy routeItPan's 60px activeOffsetX,
  // so double-tapping content could spuriously open the Route It sheet.
  // A single Exclusive group ensures only one gesture ever wins per touch.
  const composed = Gesture.Exclusive(doubleTap, singleTap, longPress, routeItPan);

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

      {/* Full-screen gesture layer (tap / double-tap / long press / swipe right) */}
      <GestureDetector gesture={composed}>
        <View style={StyleSheet.absoluteFill} />
      </GestureDetector>

      {/* Overlay (creator info, captions, actions) */}
      <WatchItemOverlay
        item={item}
        currentUserId={currentUserId}
        isSaved={isSaved}
        onComment={() => onComment(item.id)}
        onSave={() => onSave(item.id)}
        onMore={() => onMore(item.id)}
        stampGroupRef={stamp.stampGroupRef}
        stampVisualIsStamped={stamp.visualIsStamped}
        stampVisualCount={stamp.visualCount}
        stampButtonStyle={stamp.buttonStyle}
        onStampPress={stamp.handleStampPress}
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

      {/* ── Swipe-right hint arrow ─────────────────────────────── */}
      <Animated.View
        style={[s.swipeHint, { opacity: swipeHintOpacity }]}
        pointerEvents="none"
      >
        <Text style={s.swipeHintArrow}>›</Text>
        <Text style={s.swipeHintLabel}>Route It</Text>
      </Animated.View>

      {/* ── Route It place sheet ───────────────────────────────── */}
      <RouteItPlaceSheet
        visible={showRouteIt}
        place={item.place}
        mediaId={item.id}
        mediaTitle={item.place?.name}
        onClose={() => setShowRouteIt(false)}
      />

      {/* ── Radial quick-menu ──────────────────────────────────── */}
      <WatchRadialMenu
        visible={showRadialMenu}
        onDismiss={handleRadialDismiss}
        onSaveGem={handleSaveGem}
        onAddToTrip={handleAddToTrip}
        onShareTelegraph={handleShareTelegraph}
        onFindHere={handleFindHere}
      />
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
  onComment: (id: string) => void;
  onSave: (id: string) => void;
  onMore: (id: string) => void;
  /** Saved items set (id → true). */
  savedSet: Record<string, boolean>;
}

// ── Main component ────────────────────────────────────────────────────────────

export function WatchFeedList({
  items,
  activeIndex,
  currentUserId,
  onActiveIndexChange,
  onEndReached,
  onComment,
  onSave,
  onMore,
  savedSet,
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

  // Track how many unique videos have been seen to trigger the swipe hint.
  const videoSeenCountRef = useRef(0);
  const [showSwipeHint, setShowSwipeHint] = useState(false);

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

      // Increment seen-video counter for swipe hint discovery
      videoSeenCountRef.current += 1;
      if (videoSeenCountRef.current >= 3) {
        setShowSwipeHint(true);
      }
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
        onComment={onComment}
        onSave={onSave}
        onMore={onMore}
        onVideoRef={playback.registerRef}
        onVideoUnmount={playback.unregisterRef}
        isSaved={savedSet[item.id] ?? item.savedByMe}
        showSwipeHint={showSwipeHint}
      />
    ),
    [activeIndex, isMuted, currentUserId, onComment, onSave, onMore,
      playback.registerRef, playback.unregisterRef, savedSet,
      showSwipeHint],
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

  // ── Swipe-right hint arrow ────────────────────────────────────────────────
  swipeHint: {
    position: 'absolute',
    right: 68,   // just left of the right-rail action buttons
    top: '50%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  swipeHintArrow: {
    fontSize: 20,
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '300',
    lineHeight: 22,
  },
  swipeHintLabel: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '600',
  },
});
