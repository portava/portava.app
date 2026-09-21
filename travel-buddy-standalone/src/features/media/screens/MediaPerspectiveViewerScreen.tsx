/**
 * MediaPerspectiveViewerScreen — the §14 CONTEXTUAL media viewer.
 *
 * This is NOT a TikTok-style vertical stranger-video feed (§46.2). It opens on
 * the perspective the user tapped and lets them move between the OTHER
 * perspectives of the SAME entity — the collection is scoped to the entry
 * context (a Place's other perspectives when opened from a Place, etc.), never a
 * global engagement-ranked feed. Each frame shows, per §14:
 *   ← An Thuong                                   •••
 *   [            MEDIA (poster — no autoplay)            ]
 *   Perspective: Street · 4 min ago
 *   Maya ✓  · Trusted nightlife contributor
 *   "It's filling up fast."
 *   Stamp   View Place   Ask Compass
 *   RELATED PERSPECTIVES   [Entrance] [Rooftop] [Street] [Club]
 *
 * It reuses IntelligenceStrip (evidence class + freshness + perspective label)
 * and StampButton; it never plays full-screen stranger video on open (§46.2) —
 * video renders its poster with a play affordance. It degrades cleanly (§33/§39):
 * an empty / missing collection shows a clean empty state and never throws.
 *
 * Additive: the existing generic media viewer (app/media-viewer/[id]) and the
 * media tab are untouched; this is a separate, shell-only surface.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Dimensions,
  FlatList,
  type ViewToken,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  MoreHorizontal,
  Play,
  Pause,
  MapPin,
  Compass,
  Check,
  Volume2,
  VolumeX,
  Captions,
  RotateCcw,
  Rewind,
  FastForward,
} from 'lucide-react-native';

import { color, space, radius, avatar, icon, dot } from '../../../theme/tokens.ts';
import { CachedImage } from '../../../components/CachedImage.tsx';
import { useHydratedMedia } from '../../../services/mediaUrl.ts';
import { Avatar } from '../../../components/ui/Avatar.tsx';
import { StampButton } from '../../../components/stamps/StampButton.tsx';

import { IntelligenceStrip } from '../components/IntelligenceStrip.tsx';
import { ContributorTrustChips } from '../components/ContributorTrustChips.tsx';
import type { MediaProjection } from '../types/media.ts';
import type {
  BuildPerspectiveCollectionInput,
  PerspectiveCollection,
} from '../state/perspectiveViewer.ts';
import {
  buildPerspectiveCollection,
  isEmptyCollection,
  clampIndex,
  initialIndexForMedia,
  activeGroupKeyAt,
  groupLabelFor,
  firstIndexOfGroup,
  relatedPerspectives,
} from '../state/perspectiveViewer.ts';
import { relativeAgeLabel } from '../state/freshness.ts';

const { width: SCREEN_W } = Dimensions.get('window');

export interface MediaPerspectiveViewerScreenProps {
  /** Raw entry-context inputs (kind, entity, groups, media). Null → empty state. */
  input: BuildPerspectiveCollectionInput | null;
  /** The tapped media id; the viewer opens on it (falls back to the first). */
  initialMediaId: string | null;
  onClose: () => void;
  /** §14 "View Place" — open the entity's place screen (when a place id is known). */
  onViewPlace?: (placeId: string) => void;
  /** §14 "Ask Compass" — hand the entity to Compass. */
  onAskCompass?: (entityId: string | null) => void;
}

export function MediaPerspectiveViewerScreen({
  input,
  initialMediaId,
  onClose,
  onViewPlace,
  onAskCompass,
}: MediaPerspectiveViewerScreenProps) {
  const insets = useSafeAreaInsets();

  // Build the entry-context collection once (pure; never throws on partial data).
  const collection = useMemo<PerspectiveCollection | null>(
    () => (input ? buildPerspectiveCollection(input) : null),
    [input],
  );

  const empty = isEmptyCollection(collection);

  const [activeIndex, setActiveIndex] = useState(() =>
    collection ? initialIndexForMedia(collection, initialMediaId) : 0,
  );

  const listRef = useRef<FlatList<MediaProjection>>(null);
  // Pinned identity — FlatList requires onViewableItemsChanged to be stable.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (viewableItems.length > 0) setActiveIndex(viewableItems[0].index ?? 0);
  }).current;

  const jumpToIndex = useCallback((index: number) => {
    setActiveIndex(index);
    // Best-effort — the viewable-items callback keeps activeIndex authoritative.
    try {
      listRef.current?.scrollToIndex({ index, animated: true });
    } catch {
      /* index momentarily out of range during layout — ignore */
    }
  }, []);

  // ── Empty / degraded state ────────────────────────────────────────────────
  if (empty || !collection) {
    return (
      <View style={styles.screen}>
        <TopBar entityLabel={input?.entityLabel ?? null} onClose={onClose} insetsTop={insets.top} />
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No perspective to show</Text>
          <Text style={styles.emptyBody}>
            This view isn't available right now. Your other lenses still work.
          </Text>
        </View>
      </View>
    );
  }

  const safeIndex = clampIndex(collection, activeIndex);
  const activeMedia = collection.items[safeIndex] ?? null;
  const activeKey = activeGroupKeyAt(collection, safeIndex);
  const activeLabel = groupLabelFor(collection, activeKey);
  const related = relatedPerspectives(collection, safeIndex);
  const entityLabel = collection.entityLabel ?? input?.entityLabel ?? null;

  return (
    <View style={styles.screen}>
      {/* Horizontal pager over the entry-context collection (NOT a global feed). */}
      <FlatList<MediaProjection>
        ref={listRef}
        data={collection.items}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={SCREEN_W}
        snapToAlignment="center"
        initialScrollIndex={safeIndex}
        getItemLayout={(_, index) => ({ length: SCREEN_W, offset: SCREEN_W * index, index })}
        keyExtractor={(m, i) => m.id || `p${i}`}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={2}
        renderItem={({ item }) => <PerspectiveFrame media={item} />}
      />

      {/* Top bar — back to the entity + overflow. */}
      <TopBar entityLabel={entityLabel} onClose={onClose} insetsTop={insets.top} />

      {/* Bottom contextual overlay. */}
      <View
        style={[styles.overlay, { paddingBottom: Math.max(insets.bottom + space.md, space.xl) }]}
        pointerEvents="box-none"
      >
        {activeMedia ? (
          <PerspectiveContext
            media={activeMedia}
            perspectiveLabel={activeLabel}
            entityId={collection.entityId}
            onViewPlace={onViewPlace}
            onAskCompass={onAskCompass}
          />
        ) : null}

        {/* RELATED PERSPECTIVES — jump between the entity's other groups (§14). */}
        {collection.grouped && related.length > 0 ? (
          <View style={styles.relatedBlock}>
            <Text style={styles.relatedHeading}>Related perspectives</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.relatedChips}
            >
              {related.map((r) => (
                <Pressable
                  key={r.key}
                  style={[styles.chip, r.active && styles.chipActive]}
                  onPress={() => jumpToIndex(firstIndexOfGroup(collection, r.key))}
                  accessibilityRole="button"
                  accessibilityState={{ selected: r.active }}
                  accessibilityLabel={`${r.label} perspectives`}
                >
                  <Text style={[styles.chipText, r.active && styles.chipTextActive]}>{r.label}</Text>
                  {r.count > 0 ? (
                    <Text style={[styles.chipCount, r.active && styles.chipTextActive]}>{r.count}</Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function TopBar({
  entityLabel,
  onClose,
  insetsTop,
}: {
  entityLabel: string | null;
  onClose: () => void;
  insetsTop: number;
}) {
  return (
    <View style={[styles.topBar, { paddingTop: insetsTop + space.sm }]} pointerEvents="box-none">
      <Pressable
        style={styles.iconBtn}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={8}
      >
        <ChevronLeft size={22} color={color.onInk} strokeWidth={2.5} />
      </Pressable>
      {entityLabel ? (
        <Text style={styles.topTitle} numberOfLines={1}>
          {entityLabel}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      <View style={styles.iconBtn} pointerEvents="none">
        <MoreHorizontal size={20} color={color.onInk} strokeWidth={2.2} />
      </View>
    </View>
  );
}

// ── One media frame (poster; no autoplay — §46.2) ─────────────────────────────

function PerspectiveFrame({ media }: { media: MediaProjection }) {
  const uri = media.url ?? media.thumbnailUrl ?? null;
  const isVideo = media.mediaType === 'video' && Boolean(media.url);
  /**
   * `MediaProjection.url` MAY BE A BARE BUCKET PATH (`post-media/<uid>/x.mp4`)
   * — post-media is a PRIVATE bucket and that is what the rows hold. expo-av
   * cannot even parse a reference with no scheme, so handing `media.url`
   * straight to <Video> renders a silent blank frame with no error, which is
   * the exact defect documented at the top of components/ui/SharedVideoPlayer.
   * The image arm does not need this because CachedImage hydrates internally.
   *
   * Until the resolve lands `hydrated[url]` is undefined and the plain value is
   * used, which is already correct for the absolute URLs some rows hold; a
   * `null` means the server refused to sign it, which is a playback error.
   */
  const { resolved: hydrated } = useHydratedMedia(isVideo && media.url ? [media.url] : []);
  const hydratedUrl = media.url ? hydrated[media.url] : undefined;
  const playbackUri = typeof hydratedUrl === 'string' ? hydratedUrl : media.url ?? null;
  const unresolvable = hydratedUrl === null;
  const videoRef = useRef<Video>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [hasPlaybackError, setHasPlaybackError] = useState(false);
  const [showCaptions, setShowCaptions] = useState(false);
  const [progress, setProgress] = useState(0);
  const durationRef = useRef(media.durationMs ?? 0);

  useEffect(() => {
    AsyncStorage.getItem('media:muted')
      .then((value) => {
        if (value !== null) setIsMuted(value === 'true');
      })
      .catch(() => {});
  }, []);

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    setHasPlaybackError(false);
    if (isPlaying) {
      videoRef.current.pauseAsync().catch(() => {});
    } else {
      videoRef.current.playAsync().catch(() => setHasPlaybackError(true));
    }
    setIsPlaying((playing) => !playing);
  }, [isPlaying]);

  const seekBy = useCallback((deltaMs: number) => {
    const video = videoRef.current;
    if (!video || durationRef.current <= 0) return;
    video.getStatusAsync().then((status) => {
      if (!status.isLoaded) return;
      const next = Math.max(0, Math.min(durationRef.current, status.positionMillis + deltaMs));
      video.setPositionAsync(next).catch(() => {});
    }).catch(() => {});
  }, []);

  const retryPlayback = useCallback(() => {
    setHasPlaybackError(false);
    setIsBuffering(true);
    videoRef.current?.replayAsync().then(() => {
      setIsPlaying(true);
    }).catch(() => setHasPlaybackError(true));
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((muted) => {
      const next = !muted;
      AsyncStorage.setItem('media:muted', String(next)).catch(() => {});
      return next;
    });
  }, []);

  const handleStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      if (status.error) setHasPlaybackError(true);
      return;
    }
    durationRef.current = status.durationMillis ?? durationRef.current;
    setProgress(status.durationMillis ? status.positionMillis / status.durationMillis : 0);
    setIsBuffering(status.isBuffering);
    setIsPlaying(status.isPlaying);
  }, []);

  return (
    <View style={styles.frame}>
      {uri ? (
        isVideo && playbackUri && !unresolvable ? (
          <Video
            ref={videoRef}
            source={{ uri: playbackUri }}
            style={StyleSheet.absoluteFill}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay={false}
            isLooping={false}
            isMuted={isMuted}
            useNativeControls={false}
            onPlaybackStatusUpdate={handleStatus}
          />
        ) : (
          // A video whose reference could not be signed shows its POSTER, not
          // the reference the server just refused — CachedImage would only fail
          // on it a second time.
          <CachedImage
            source={{ uri: isVideo && unresolvable ? (media.thumbnailUrl ?? uri) : uri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            fallbackLabel=""
          />
        )
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.frameFallback]} />
      )}
      {isVideo ? (
        <>
          {hasPlaybackError || unresolvable ? (
            <Pressable
              style={styles.playBadge}
              onPress={retryPlayback}
              accessibilityRole="button"
              accessibilityLabel="Retry video playback"
            >
              <RotateCcw size={18} color={color.onInk} strokeWidth={2.2} />
              <Text style={styles.controlLabel}>Retry</Text>
            </Pressable>
          ) : (
            <Pressable
              style={styles.playBadge}
              onPress={togglePlay}
              accessibilityRole="button"
              accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
            >
              {isPlaying
                ? <Pause size={18} color={color.onInk} strokeWidth={2.2} />
                : <Play size={18} color={color.onInk} strokeWidth={2.2} fill={color.onInk} />}
            </Pressable>
          )}
          <View style={styles.videoControls} accessibilityLabel="Video controls">
            <Pressable
              style={styles.controlButton}
              onPress={() => seekBy(-10_000)}
              accessibilityRole="button"
              accessibilityLabel="Rewind 10 seconds"
            >
              <Rewind size={16} color={color.onInk} />
            </Pressable>
            <Pressable
              style={styles.controlButton}
              onPress={toggleMute}
              accessibilityRole="button"
              accessibilityLabel={isMuted ? 'Unmute video' : 'Mute video'}
            >
              {isMuted ? <VolumeX size={16} color={color.onInk} /> : <Volume2 size={16} color={color.onInk} />}
            </Pressable>
            <Pressable
              style={styles.controlButton}
              onPress={() => seekBy(10_000)}
              accessibilityRole="button"
              accessibilityLabel="Forward 10 seconds"
            >
              <FastForward size={16} color={color.onInk} />
            </Pressable>
            {media.note ? (
              <Pressable
                style={[styles.controlButton, showCaptions && styles.controlButtonActive]}
                onPress={() => setShowCaptions((visible) => !visible)}
                accessibilityRole="button"
                accessibilityLabel={showCaptions ? 'Hide captions' : 'Show captions'}
                accessibilityState={{ selected: showCaptions }}
              >
                <Captions size={16} color={color.onInk} />
              </Pressable>
            ) : null}
          </View>
          <View
            style={styles.videoProgressTrack}
            accessibilityRole="progressbar"
            accessibilityLabel="Video progress"
            accessibilityValue={{ min: 0, max: 1, now: progress }}
          >
            <View style={[styles.videoProgressFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
          {showCaptions && media.note ? (
            <View style={styles.captionBox} accessibilityRole="text">
              <Text style={styles.captionText}>{media.note}</Text>
            </View>
          ) : null}
          {isBuffering ? <Text style={styles.bufferingLabel}>Loading video…</Text> : null}
        </>
      ) : null}
    </View>
  );
}

// ── Contextual overlay body: perspective + contributor + note + actions ───────

function PerspectiveContext({
  media,
  perspectiveLabel,
  entityId,
  onViewPlace,
  onAskCompass,
}: {
  media: MediaProjection;
  perspectiveLabel: string | null;
  entityId: string | null;
  onViewPlace?: (placeId: string) => void;
  onAskCompass?: (entityId: string | null) => void;
}) {
  const contributor = media.contributor ?? null;
  const age = media.freshnessLabel ?? relativeAgeLabel(media.ageMinutes);
  // "Perspective: Street · 4m ago" — the §14 contextual headline.
  const headline = perspectiveLabel
    ? age
      ? `Perspective: ${perspectiveLabel} · ${age}`
      : `Perspective: ${perspectiveLabel}`
    : age
      ? `Perspective · ${age}`
      : 'Perspective';

  // A View Place target only when this entry context is a real canonical place.
  const placeId = media.place?.id ?? entityId ?? null;

  return (
    <View style={styles.contextBlock}>
      <Text style={styles.headline}>{headline}</Text>

      {/* Evidence class + freshness + perspective group — reused, honest strip. */}
      <IntelligenceStrip
        observationClass={media.observationClass}
        freshness={media.freshness}
        ageMinutes={media.ageMinutes}
        perspectiveLabel={perspectiveLabel}
      />

      {/* Contributor + trust context — visible but secondary (§14/§46). */}
      {contributor ? (
        <>
          <View style={styles.contributorRow}>
            <Avatar
              uri={contributor.avatarUrl}
              name={contributor.displayName}
              size={avatar.s40}
              style={styles.avatarRing}
            />
            <View style={styles.contributorText}>
              <View style={styles.contributorNameRow}>
                <Text style={styles.contributorName} numberOfLines={1}>
                  {contributor.displayName}
                </Text>
                {contributor.verified ? (
                  <View style={styles.verifiedDot}>
                    <Check size={10} color={color.ink} strokeWidth={3} />
                  </View>
                ) : null}
              </View>
              {contributor.trustLabel ? (
                <Text style={styles.trustLabel} numberOfLines={1}>
                  {contributor.trustLabel}
                </Text>
              ) : null}
            </View>
          </View>
          {/* §25 intelligence-trust dimensions — calm trust CONTEXT, NOT
              popularity. Flag-gated + self-hides when empty/off/error. */}
          <ContributorTrustChips contributorId={contributor.id} subjectId={placeId} />
        </>
      ) : null}

      {/* On-the-ground note — "It's filling up fast." (§14). */}
      {media.note ? (
        <Text style={styles.note} numberOfLines={3}>
          “{media.note}”
        </Text>
      ) : null}

      {/* Actions — the media connects to a social contribution + context (§2/§14/§15). */}
      <View style={styles.actionRow}>
        {media.id ? (
          <StampButton
            key={media.id}
            entityType="media"
            entityId={media.id}
            initialCount={0}
            initialIsStamped={false}
            iconSize={22}
            style={styles.stampBtn}
          />
        ) : null}

        {onViewPlace && placeId ? (
          <Pressable
            style={styles.pillBtn}
            onPress={() => onViewPlace(placeId)}
            accessibilityRole="button"
            accessibilityLabel="View place"
          >
            <MapPin size={14} color={color.onInk} strokeWidth={2} />
            <Text style={styles.pillText}>View Place</Text>
          </Pressable>
        ) : null}

        {onAskCompass ? (
          <Pressable
            style={styles.pillBtn}
            onPress={() => onAskCompass(entityId)}
            accessibilityRole="button"
            accessibilityLabel="Ask Compass"
          >
            <Compass size={14} color={color.onInk} strokeWidth={2} />
            <Text style={styles.pillText}>Ask Compass</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.ink },

  // Top bar
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    zIndex: 10,
  },
  iconBtn: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    flex: 1,
    color: color.onInk,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.3,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Media frame
  frame: {
    width: SCREEN_W,
    flex: 1,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  frameFallback: { backgroundColor: '#1B1B18' },
  playBadge: {
    width: icon.s26,
    height: icon.s26,
    borderRadius: icon.s26 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(17,17,15,0.5)',
  },
  controlLabel: { color: color.onInk, fontSize: 11, fontWeight: '700' },
  videoControls: {
    position: 'absolute',
    bottom: 14,
    right: 14,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  controlButton: {
    width: avatar.s44,
    height: avatar.s44,
    borderRadius: avatar.s44 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(17,17,15,0.7)',
  },
  controlButtonActive: { backgroundColor: 'rgba(250,249,246,0.32)' },
  videoProgressTrack: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 6,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(250,249,246,0.26)',
  },
  videoProgressFill: {
    height: 3,
    borderRadius: 2,
    backgroundColor: color.signal,
  },
  captionBox: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 70,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(17,17,15,0.74)',
  },
  captionText: { color: color.onInk, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  bufferingLabel: {
    position: 'absolute',
    top: '52%',
    alignSelf: 'center',
    color: color.onInkMute,
    fontSize: 12,
    fontWeight: '700',
  },

  // Bottom overlay
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: space.md,
    paddingTop: space.lg,
    backgroundColor: 'rgba(17,17,15,0.62)',
  },
  contextBlock: { paddingHorizontal: space.lg, gap: space.sm },
  headline: {
    color: color.onInk,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.2,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Contributor
  contributorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatarRing: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.6)' },
  contributorText: { flex: 1 },
  contributorNameRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  contributorName: { color: color.onInk, fontSize: 14, fontWeight: '800', letterSpacing: -0.2, flexShrink: 1 },
  verifiedDot: {
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    backgroundColor: color.onInk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trustLabel: { color: color.onInkMute, fontSize: 12, fontWeight: '600', marginTop: 1 },

  note: { color: color.onInk, fontSize: 15, fontStyle: 'italic', lineHeight: 20 },

  // Actions
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginTop: space.xs },
  stampBtn: { alignItems: 'center', justifyContent: 'center' },
  pillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.14)',
  },
  pillText: { color: color.onInk, fontSize: 13, fontWeight: '700' },

  // Related perspectives
  relatedBlock: { gap: space.xs },
  relatedHeading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
  },
  relatedChips: { gap: space.sm, paddingHorizontal: space.lg },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.10)',
  },
  chipActive: { backgroundColor: color.onInk },
  chipText: { color: color.onInkMute, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: color.ink },
  chipCount: { color: color.faint, fontSize: 12, fontWeight: '700' },

  // Empty state
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl, gap: space.sm },
  emptyTitle: { color: color.onInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  emptyBody: { color: color.onInkMute, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
