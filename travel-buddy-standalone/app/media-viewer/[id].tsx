/**
 * MediaViewer — full-screen edge-to-edge viewer for grid items.
 *
 * Wave C upgrades:
 *   - Horizontal FlatList pager — swipe left/right between all items that
 *     were loaded in the grid when the tile was tapped.
 *   - ViewerOverlay: author, caption, place, like/comment/save/share actions.
 *   - Like/save backed by useMediaLike + useMediaSave (optimistic, API-synced).
 *   - Full post data is lazy-fetched for the active and adjacent items so the
 *     overlay fills in progressively without blocking the transition.
 *   - Mute/unmute toggle for videos.
 *   - Falls back to a single-item view when opened via deep-link (no context).
 *
 * Web: CSS injection forces expo-av <video> to cover-fill with !important.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  StyleSheet,
  Pressable,
  Dimensions,
  ActivityIndicator,
  Text,
  FlatList,
  Share,
  Platform,
  type ViewToken,
} from 'react-native';
import { Avatar } from '../../src/components/ui/Avatar';
import { CachedImage } from '../../src/components/CachedImage';
import { useLocalSearchParams, router } from 'expo-router';
import { Video, ResizeMode } from 'expo-av';
import {
  X,
  MessageCircle,
  Bookmark,
  MapPin,
  Volume2,
  VolumeX,
  ChevronLeft,
  Zap,
  Compass,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { fetchMediaFeedItemById } from '../../src/services/mediaFeed.ts';
import { VerifiedLocationStamp } from '../../src/components/media/VerifiedLocationStamp.tsx';
import { useMediaSave } from '../../src/hooks/useMediaSave.ts';
import { StampButton } from '../../src/components/stamps/StampButton.tsx';
import { recordMediaShare } from '../../src/services/mediaInteractions.ts';
import { MediaCommentSheet } from '../../src/components/media/MediaCommentSheet.tsx';
import {
  getViewerContext,
  clearViewerContext,
  type ViewerContextItem,
} from '../../src/lib/viewerContext.ts';
import { formatLocationLabel } from '../../src/lib/formatPlaceLabel.ts';
import { PortavaShareIcon } from '../../src/components/icons/PortavaShareIcon.tsx';
import { color, space, type as t, radius, avatar, dot} from '../../src/theme/tokens.ts';
import { useSession } from '../../src/context/SessionContext.tsx';
import { PlaceQuickActions } from '../../src/components/PlaceQuickActions.tsx';
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext.tsx';
import { MediaActionRail } from '../../src/features/media/components/MediaActionRail.tsx';

// ── Web: force expo-av <video> to cover-fill ──────────────────────────────────
if (typeof document !== 'undefined') {
  const _s = document.createElement('style');
  _s.textContent =
    '[id^="mv-"] video{' +
    'position:absolute!important;inset:0!important;' +
    'width:100%!important;height:100%!important;object-fit:cover!important;}';
  document.head.appendChild(_s);
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ── Post data shape used in the viewer ───────────────────────────────────────

interface ViewerPost {
  id: string;
  mediaUrl: string | null;
  isVideo: boolean;
  posterUrl: string | null;
  caption: string;
  authorId: string | null;
  authorHandle: string | null;
  authorName: string | null;
  authorAvatarUrl: string | null;
  locationName: string | null;
  locationCity: string | null;
  likeCount: number;
  commentCount: number;
  saveCount: number;
  likedByMe: boolean;
  savedByMe: boolean;
  /** Number of distinct viewers who stamped this post. From MediaFeedStats.stampItCount. */
  stampItCount: number;
}

function mapMediaFeedItem(item: import('../../src/types/media.ts').MediaFeedItem): ViewerPost {
  return {
    id: item.id,
    mediaUrl: item.videoUrl || null,
    isVideo: Boolean(item.videoUrl),
    posterUrl: item.posterUrl,
    caption: item.caption ?? '',
    authorId: item.creator.id,
    authorHandle: item.creator.username,
    authorName: item.creator.displayName,
    authorAvatarUrl: item.creator.avatarUrl,
    locationName: item.place?.name ?? null,
    locationCity: item.place?.city ?? null,
    likeCount: item.likeCount,
    commentCount: item.commentCount,
    saveCount: item.saveCount,
    likedByMe: item.likedByMe,
    savedByMe: item.savedByMe,
    stampItCount: item.stampItCount ?? 0,
  };
}

// ── Count formatter ───────────────────────────────────────────────────────────

function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

// ── Viewer overlay ────────────────────────────────────────────────────────────

interface OverlayProps {
  post: ViewerPost | null;
  isSaved: boolean;
  saveCount: number;
  commentCount: number;
  isMuted: boolean;
  isVideo: boolean;
  onClose: () => void;
  onComment: () => void;
  onSave: () => void;
  onShare: () => void;
  onMuteToggle: () => void;
  /** True when the media was GPS-verified at the tagged place at upload time. */
  locationVerified?: boolean;
  /** Location name for the verified stamp — sourced from viewer context. */
  locationName?: string | null;
  /** True when the viewing user is the post's creator. */
  isOwner: boolean;
  /** Number of distinct viewers who stamped this post. Shown only to the creator. */
  stampItCount: number;
  /** Media v2 World shell (§15): show the action-rail entry when enabled. */
  showActions?: boolean;
  /** Opens the media action rail. */
  onActions?: () => void;
}

function ViewerOverlay({
  post,
  isSaved,
  saveCount,
  commentCount,
  isMuted,
  isVideo,
  onClose,
  onComment,
  onSave,
  onShare,
  onMuteToggle,
  locationVerified,
  locationName,
  isOwner,
  stampItCount,
  showActions,
  onActions,
}: OverlayProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Bottom gradient scrim */}
      <LinearGradient
        colors={[color.scrimTop, color.scrimBottom]}
        style={ov.scrim}
        pointerEvents="none"
      />

      {/* ── Top bar: close + mute ────────────────────────────────────── */}
      <View style={[ov.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable
          style={ov.iconBtn}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}
        >
          <ChevronLeft size={22} color="#fff" strokeWidth={2.5} />
        </Pressable>

        {isVideo ? (
          <Pressable
            style={ov.iconBtn}
            onPress={onMuteToggle}
            accessibilityRole="button"
            accessibilityLabel={isMuted ? 'Unmute' : 'Mute'}
            hitSlop={8}
          >
            {isMuted
              ? <VolumeX size={18} color="#fff" />
              : <Volume2 size={18} color="#fff" />}
          </Pressable>
        ) : null}
      </View>

      {/* ── Bottom area: author + actions ────────────────────────────── */}
      <View
        style={[ov.bottom, { paddingBottom: Math.max(insets.bottom + 16, 24) }]}
        pointerEvents="box-none"
      >
        {/* Left column: author + caption + place */}
        <View style={ov.leftCol} pointerEvents="box-none">
          {post ? (
            <>
              {/* Author row */}
              {post.authorHandle ? (
                <Pressable
                  style={ov.authorRow}
                  onPress={() => {
                    if (post.authorHandle) {
                      router.push(`/u/${post.authorHandle}` as any);
                    }
                  }}
                  hitSlop={4}
                >
                  <Avatar
                    uri={post.authorAvatarUrl}
                    name={post.authorName || post.authorHandle}
                    size={36}
                    style={ov.avatarRing}
                  />
                  <View>
                    {post.authorName ? (
                      <Text style={ov.authorName} numberOfLines={1}>{post.authorName}</Text>
                    ) : null}
                    <Text style={ov.authorHandle} numberOfLines={1}>
                      @{post.authorHandle}
                    </Text>
                  </View>
                </Pressable>
              ) : null}

              {/* Caption */}
              {post.caption ? (
                <Text style={ov.caption} numberOfLines={3}>{post.caption}</Text>
              ) : null}

              {/* Verified location stamp */}
              {locationVerified && locationName ? (
                <VerifiedLocationStamp locationName={locationName} />
              ) : null}

              {/* Place chip */}
              {post.locationName ? (
                <View style={ov.placeChip} pointerEvents="none">
                  <MapPin size={10} color="rgba(255,255,255,0.85)" />
                  <Text style={ov.placeText} numberOfLines={1}>
                    {formatLocationLabel(post.locationName, post.locationCity, ' · ')}
                  </Text>
                </View>
              ) : null}

              {/* Quick actions — shown when a location is tagged */}
              {post.locationName ? (
                <PlaceQuickActions
                  place={{
                    name: post.locationName,
                    city: post.locationCity ?? null,
                  }}
                  sourceId={post.id}
                  variant="dark"
                />
              ) : null}
            </>
          ) : (
            /* Loading shimmer */
            <View style={ov.loadingRow}>
              <ActivityIndicator size="small" color="rgba(255,255,255,0.5)" />
            </View>
          )}
        </View>

        {/* Right column: action buttons */}
        <View style={ov.rightCol}>
          {/* Stamp — key forces remount when the active post changes so stamp state resets */}
          {post ? (
            <StampButton
              key={post.id}
              entityType="media"
              entityId={post.id}
              initialCount={post.likeCount}
              initialIsStamped={post.likedByMe}
              iconSize={28}
              style={ov.stampBtnWrapper}
            />
          ) : null}

          {/* Comment */}
          <Pressable style={ov.actionBtn} onPress={onComment} hitSlop={6} accessibilityRole="button" accessibilityLabel="Comment">
            <MessageCircle size={28} color="#fff" strokeWidth={1.8} />
            {commentCount > 0 ? <Text style={ov.actionCount}>{fmtCount(commentCount)}</Text> : null}
          </Pressable>

          {/* Save */}
          <Pressable style={ov.actionBtn} onPress={onSave} hitSlop={6} accessibilityRole="button" accessibilityLabel={isSaved ? 'Unsave' : 'Save'}>
            <Bookmark size={28} color={isSaved ? color.signal : '#fff'} fill={isSaved ? color.signal : 'transparent'} strokeWidth={isSaved ? 0 : 1.8} />
            {saveCount > 0 ? <Text style={ov.actionCount}>{fmtCount(saveCount)}</Text> : null}
          </Pressable>

          {/* Stamp count — creator-only analytics signal */}
          {isOwner && stampItCount > 0 ? (
            <View style={ov.actionBtn} pointerEvents="none" accessibilityLabel={`${stampItCount} stamps`}>
              <Zap size={26} color="rgba(255,220,80,0.9)" fill="rgba(255,220,80,0.9)" strokeWidth={0} />
              <Text style={ov.actionCount}>{fmtCount(stampItCount)}</Text>
            </View>
          ) : null}

          {/* Share */}
          <Pressable style={ov.actionBtn} onPress={onShare} hitSlop={6} accessibilityRole="button" accessibilityLabel="Share this media">
            <PortavaShareIcon size={26} color="#fff" />
          </Pressable>

          {/* Media v2 action rail entry — additive, only when the World shell is on */}
          {showActions && onActions ? (
            <Pressable style={ov.actionBtn} onPress={onActions} hitSlop={6} accessibilityRole="button" accessibilityLabel="More actions">
              <Compass size={28} color="#fff" strokeWidth={1.8} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const ov = StyleSheet.create({
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '60%',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    zIndex: 10,
  },
  iconBtn: {
    width: avatar.s38, height: avatar.s38,
    borderRadius: avatar.s38 / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: space.lg,
  },
  leftCol: {
    flex: 1,
    gap: 6,
    paddingRight: space.sm,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Sizing/shape come from <Avatar size>; this is the contrast ring only.
  avatarRing: {
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  authorName: {
    ...t.bodyStrong,
    color: color.onInk,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  authorHandle: {
    ...t.stamp,
    color: color.onInkMute,
  },
  caption: {
    ...t.body,
    color: color.onInk,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  placeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  placeText: {
    ...t.stamp,
    color: 'rgba(255,255,255,0.9)',
    flexShrink: 1,
  },
  loadingRow: {
    height: 36,
    justifyContent: 'center',
  },
  rightCol: {
    alignItems: 'center',
    gap: space.xl,
    paddingBottom: 4,
  },
  actionBtn: {
    alignItems: 'center',
    gap: 4,
  },
  stampBtnWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionCount: {
    ...t.stamp,
    color: color.onInk,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});

// ── Per-page media renderer ───────────────────────────────────────────────────

interface ViewerPageProps {
  item: ViewerContextItem;
  isActive: boolean;
  isMuted: boolean;
  postData: ViewerPost | null;
}

function ViewerPage({ item, isActive, isMuted, postData }: ViewerPageProps) {
  const videoRef = useRef<InstanceType<typeof Video>>(null);
  const [showPoster, setShowPoster] = useState(true);

  // Autoplay/pause based on active state
  useEffect(() => {
    if (item.mediaType !== 'video') return;
    if (isActive) {
      videoRef.current?.playAsync().catch(() => {});
    } else {
      videoRef.current?.pauseAsync().catch(() => {});
      videoRef.current?.setPositionAsync(0).catch(() => {});
      setShowPoster(true);
    }
  }, [isActive, item.mediaType]);

  // Media URL: from full post data when available, thumbnail for images
  const mediaUrl = postData?.mediaUrl
    ?? (item.mediaType === 'image' ? (item.thumbnailUrl ?? item.posterUrl) : null);
  const posterUrl = postData?.posterUrl ?? item.posterUrl ?? item.thumbnailUrl;
  const isVideo = postData?.isVideo ?? item.mediaType === 'video';

  return (
    <View
      style={pg.screen}
      nativeID={`mv-${item.id}`}
    >
      {!mediaUrl ? (
        /* Still fetching */
        <View style={pg.loadingWrap}>
          {posterUrl ? (
            <CachedImage source={{ uri: posterUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" fallbackLabel="" />
          ) : null}
          <ActivityIndicator size="large" color={color.onInk} />
        </View>
      ) : isVideo ? (
        <>
          <Video
            ref={videoRef}
            source={{ uri: mediaUrl }}
            style={pg.video}
            resizeMode={ResizeMode.COVER}
            shouldPlay={isActive}
            isLooping
            isMuted={isMuted}
            useNativeControls={false}
            onPlaybackStatusUpdate={(status) => {
              if (status.isLoaded && !status.isBuffering && showPoster) {
                setShowPoster(false);
              }
            }}
          />
          {/* Poster until first frame renders */}
          {showPoster && posterUrl && Platform.OS !== 'web' ? (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <CachedImage source={{ uri: posterUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" fallbackLabel="" />
            </View>
          ) : null}
        </>
      ) : (
        <CachedImage source={{ uri: mediaUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      )}
    </View>
  );
}

const pg = StyleSheet.create({
  screen: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  loadingWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  video: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCREEN_W,
    height: SCREEN_H,
  },
});

// ── Main MediaViewer ──────────────────────────────────────────────────────────

export default function MediaViewer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const currentUserId = session?.userId ?? undefined;
  const { isEnabled } = useFeatureFlags();
  // Media v2 World shell (§15): the action rail is ADDITIVE and only appears
  // when the World shell flag is on — the existing viewer is untouched otherwise.
  const worldShellEnabled = isEnabled('MEDIA_WORLD_SHELL_ENABLED');
  const [actionsOpen, setActionsOpen] = useState(false);

  // ── Read viewer context (snapshot on mount) ────────────────────────────────
  const [items] = useState<ViewerContextItem[]>(() => {
    const ctx = getViewerContext();
    if (ctx.items.length > 0) return ctx.items;
    // Fallback: single item from deep-link
    if (id) {
      return [{
        id,
        posterUrl: null,
        thumbnailUrl: null,
        mediaType: 'video',
      }];
    }
    return [];
  });

  const [initialIndex] = useState<number>(() => {
    const ctx = getViewerContext();
    if (ctx.items.length === 0) return 0;
    const found = ctx.items.findIndex((i) => i.id === id);
    return found !== -1 ? found : ctx.initialIndex;
  });

  // Clear context so it doesn't leak to future opens
  useEffect(() => {
    return () => { clearViewerContext(); };
  }, []);

  // ── Active index tracking ──────────────────────────────────────────────────
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const flatListRef = useRef<FlatList<ViewerContextItem>>(null);
  // Hoisted above the early returns below so hook order stays stable across
  // renders. useRef(fn).current intentionally pins the first callback identity,
  // which FlatList requires of onViewableItemsChanged.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (viewableItems.length > 0) {
      setActiveIndex(viewableItems[0].index ?? 0);
    }
  }).current;

  useEffect(() => {
    if (initialIndex > 0 && flatListRef.current) {
      setTimeout(() => {
        flatListRef.current?.scrollToIndex({ index: initialIndex, animated: false });
      }, 50);
    }
  }, [initialIndex]);

  // ── Save hook ──────────────────────────────────────────────────────────────
  const saveHook = useMediaSave();

  // ── Mute state — shared with WatchFeedList via AsyncStorage ───────────────
  const MUTE_KEY = 'media:muted';
  const [isMuted, setIsMuted] = useState(false);

  // Load persisted mute preference on mount (same key as WatchFeedList).
  useEffect(() => {
    AsyncStorage.getItem(MUTE_KEY).then((val) => {
      if (val !== null) setIsMuted(val === 'true');
    }).catch(() => {});
  }, []);

  // ── Full post data per item ────────────────────────────────────────────────
  const [postDataMap, setPostDataMap] = useState<Record<string, ViewerPost>>({});
  const fetchingRef = useRef(new Set<string>());

  const fetchItem = useCallback(
    (item: ViewerContextItem) => {
      if (!item || fetchingRef.current.has(item.id) || postDataMap[item.id]) return;
      fetchingRef.current.add(item.id);

      fetchMediaFeedItemById(item.id)
        .then((result) => {
          if (result.ok && result.data) {
            const vp = mapMediaFeedItem(result.data);
            setPostDataMap((prev) => ({ ...prev, [item.id]: vp }));
            // Seed save state from server data; stamp state is managed by StampButton
            saveHook.seed([{ id: item.id, savedByMe: vp.savedByMe }]);
          }
        })
        .catch(() => {})
        .finally(() => { fetchingRef.current.delete(item.id); });
    },
    [postDataMap, saveHook],
  );

  // Fetch active item and its immediate neighbours
  useEffect(() => {
    const toFetch = [activeIndex - 1, activeIndex, activeIndex + 1].filter(
      (i) => i >= 0 && i < items.length,
    );
    for (const i of toFetch) {
      fetchItem(items[i]);
    }
  }, [activeIndex, items]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Comment sheet ──────────────────────────────────────────────────────────
  const [commentItemId, setCommentItemId] = useState<string | null>(null);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSave = useCallback(() => {
    const item = items[activeIndex];
    if (item) saveHook.toggleSave(item.id);
  }, [activeIndex, items, saveHook]);

  const handleComment = useCallback(() => {
    const item = items[activeIndex];
    if (item) setCommentItemId(item.id);
  }, [activeIndex, items]);

  const handleShare = useCallback(async () => {
    const item = items[activeIndex];
    if (!item) return;
    try {
      await Share.share({ message: 'Check this out on Portava!' });
      recordMediaShare(item.id, 'native').catch(() => {});
    } catch { /* dismissed */ }
  }, [activeIndex, items]);

  const handleMuteToggle = useCallback(() => {
    setIsMuted((m) => {
      const next = !m;
      AsyncStorage.setItem(MUTE_KEY, String(next)).catch(() => {});
      return next;
    });
  }, []);

  const handleClose = useCallback(() => {
    router.back();
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (items.length === 0) {
    return (
      <View style={ms.screen}>
        <Pressable
          style={[ms.closeBtn, { top: insets.top + 12 }]}
          onPress={handleClose}
          hitSlop={8}
        >
          <View style={ms.closeBtnInner}>
            <X size={20} color={color.onInk} strokeWidth={2.5} />
          </View>
        </Pressable>
        <Text style={ms.errText}>Media not available</Text>
      </View>
    );
  }

  const activeItem = items[activeIndex];
  const activePost = activeItem ? postDataMap[activeItem.id] ?? null : null;

  // Counts — save is optimistic via hook; stamp is managed by StampButton itself
  const activeIsSaved      = activeItem ? (saveHook.savedSet[activeItem.id] ?? activePost?.savedByMe ?? false) : false;
  const activeSaveCount    = activePost?.saveCount ?? 0;
  const activeCommentCount = activePost?.commentCount ?? 0;
  const activeStampItCount = activePost?.stampItCount ?? 0;
  const activeIsOwner      = Boolean(activePost && currentUserId && activePost.authorId === currentUserId);

  return (
    <View style={ms.screen}>
      {/* ── Horizontal pager ──────────────────────────────────────── */}
      <FlatList<ViewerContextItem>
        ref={flatListRef}
        data={items}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={SCREEN_W}
        snapToAlignment="center"
        initialScrollIndex={initialIndex}
        getItemLayout={(_, index) => ({
          length: SCREEN_W,
          offset: SCREEN_W * index,
          index,
        })}
        keyExtractor={(item) => item.id}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={2}
        renderItem={({ item, index }) => (
          <ViewerPage
            item={item}
            isActive={index === activeIndex}
            isMuted={isMuted}
            postData={postDataMap[item.id] ?? null}
          />
        )}
      />

      {/* ── Overlay (always on top) ───────────────────────────────── */}
      <ViewerOverlay
        post={activePost}
        isSaved={activeIsSaved}
        saveCount={activeSaveCount}
        commentCount={activeCommentCount}
        isMuted={isMuted}
        isVideo={activeItem?.mediaType === 'video' || activePost?.isVideo === true}
        onClose={handleClose}
        onComment={handleComment}
        onSave={handleSave}
        onShare={handleShare}
        onMuteToggle={handleMuteToggle}
        locationVerified={activeItem?.locationVerified}
        locationName={activeItem?.locationName}
        isOwner={activeIsOwner}
        stampItCount={activeStampItCount}
        showActions={worldShellEnabled}
        onActions={() => setActionsOpen(true)}
      />

      {/* ── Comment sheet ─────────────────────────────────────────── */}
      <MediaCommentSheet
        mediaId={commentItemId}
        visible={commentItemId !== null}
        onClose={() => setCommentItemId(null)}
      />

      {/* ── Media v2 action rail (§15) — additive, World-shell-gated ── */}
      {worldShellEnabled ? (
        <MediaActionRail
          mediaId={activeItem?.id ?? null}
          visible={actionsOpen}
          onClose={() => setActionsOpen(false)}
        />
      ) : null}

      {/* Page indicator dots (only when multiple items) */}
      {items.length > 1 ? (
        <View
          style={[ms.dots, { bottom: Math.max(insets.bottom + 80, 90) }]}
          pointerEvents="none"
        >
          {items.map((_, i) => (
            <View
              key={i}
              style={[ms.dot, i === activeIndex && ms.dotActive]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const ms = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.ink,
  },
  closeBtn: {
    position: 'absolute',
    left: 16,
    zIndex: 20,
  },
  closeBtnInner: {
    width: avatar.s36, height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: 'rgba(17,17,15,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errText: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 14,
    alignSelf: 'center',
    marginTop: '50%',
  },
  dots: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
  },
  dot: {
    width: dot.s5,
    height: dot.s5,
    borderRadius: dot.s5 / 2,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  dotActive: {
    backgroundColor: '#fff',
    width: 14,
    borderRadius: 2.5,
  },
});
