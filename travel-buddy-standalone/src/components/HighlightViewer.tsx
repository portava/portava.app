/**
 * HighlightViewer — full-screen modal highlight player.
 *
 * Shows an ordered list of active highlights (for one user or multiple).
 * Features:
 *   - Segmented progress bar per item (5s for images; video duration for clips)
 *   - Tap right → next, tap left → prev
 *   - Like button, reply button, report, close
 *   - POST /highlights/:id/view on each item shown
 *   - Owner sees "👁 N" chip → opens HighlightViewersSheet
 *   - Videos play natively via expo-av; progress driven by onPlaybackStatusUpdate
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet,
  Alert, Dimensions, ActivityIndicator, TextInput, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import { getMediaFilter, buildCssFilter } from '../lib/media/filters.ts';
import { DisplayMediaImage, AvatarImage } from './ui/DisplayMediaImage.tsx';
import { useHydratedMedia } from '../services/mediaUrl.ts';
import { X, MessageCircle, Flag, Eye, Plus, Trash2, Volume2, VolumeX } from 'lucide-react-native';
import { PortavaShareIcon } from './icons/PortavaShareIcon.tsx';
import { StampIcon } from './stamps/StampIcon.tsx';
import { SaveButton } from './SaveButton.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { closeThenNavigate } from '../lib/deferredNavigate.ts';
import * as Sharing from 'expo-sharing';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import type { Highlight } from '../services/highlights.ts';
import {
  markHighlightViewed,
  toggleHighlightLike,
  replyToHighlight,
  reportHighlight,
  deleteHighlight,
} from '../services/highlights.ts';
import { markHighlightsViewed } from '../services/messaging.ts';
import { markViewed, invalidateHighlightCache } from '../hooks/useHighlightRingState.ts';
import { HighlightViewersSheet } from './HighlightViewersSheet.tsx';
import { EngagementUserListSheet } from './EngagementUserListSheet.tsx';
import { UserIdentityLink } from './interaction/UserIdentityLink.tsx';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

/** Author avatar diameter. AvatarImage needs this as a number, not a style. */
const AVATAR_SIZE = 36;
const ITEM_DURATION_MS = 5000;

const HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 };

interface Props {
  visible: boolean;
  highlights: Highlight[];
  startIndex?: number;
  currentUserId?: string;
  onClose: () => void;
  onHighlightChange?: (index: number) => void;
  onAddHighlight?: () => void;
  onDeleted?: () => void;
}

export function HighlightViewer({
  visible,
  highlights,
  startIndex = 0,
  currentUserId,
  onClose,
  onHighlightChange,
  onAddHighlight,
  onDeleted,
}: Props) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(startIndex);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [localHighlights, setLocalHighlights] = useState<Highlight[]>(highlights);
  const [likeMap, setLikeMap] = useState<Record<string, { liked: boolean; count: number }>>({});
  const [likerHighlightId, setLikerHighlightId] = useState<string | null>(null);
  const [viewersOpen, setViewersOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  // Mute state for video highlights. As component state it survives index
  // changes, so the choice carries forward as highlights advance and persists
  // for the session (not reset when the viewer reopens).
  const [isMuted, setIsMuted] = useState(false);
  // QA round 2, bug 11: a highlight whose video fails to load used to sit on a
  // black frame with a progress bar that never moved and no way to tell why.
  const [videoError, setVideoError] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const videoRef = useRef<Video>(null);
  // Separate ref for the HTML <video> element rendered on web
  const webVideoRef = useRef<any>(null);
  // goNextRef lets the stable handleVideoStatus callback call the latest goNext
  const goNextRef = useRef<() => void>(() => {});

  const current = localHighlights[index];
  const isOwner = current?.ownerId === currentUserId;
  const isVideo = (current?.mediaType ?? '').startsWith('video/');

  // Video sources hydrate exactly as SharedVideoPlayer's do (deb8c9a86).
  // post-media is a PRIVATE bucket, so the stored value is a bare
  // `post-media/<uid>/<file>.mp4` reference with no scheme — neither expo-av's
  // <Video> nor the HTML <video> can load it, and expo-av cannot raise a useful
  // error for a URI it cannot parse, so the surface just sat blank.
  //
  // This applies to the web branch too. The comment that used to sit there
  // argued the original URL had to be used because <video> cannot attach a
  // Bearer header — true but beside the point: a signed URL is
  // self-authenticating and needs no header, which is exactly what hydration
  // returns.
  const videoSourceUrl = isVideo ? (current?.mediaUrl ?? null) : null;
  const { resolved: hydratedVideo } = useHydratedMedia(videoSourceUrl ? [videoSourceUrl] : []);
  const hydratedVideoUri = videoSourceUrl ? hydratedVideo[videoSourceUrl] : undefined;
  // Until the resolve lands this is the raw value, which is correct for the
  // absolute URLs some older rows still hold.
  const playbackUri = typeof hydratedVideoUri === 'string' ? hydratedVideoUri : (videoSourceUrl ?? '');
  // Server said no: unreadable. Same user-visible outcome as a decode failure.
  const videoUnresolvable = hydratedVideoUri === null;

  // Reset when visible/startIndex changes; mark all circle highlights read when viewer opens.
  useEffect(() => {
    if (visible) {
      setLocalHighlights(highlights);
      setIndex(startIndex);
      setProgress(0);
      setPaused(false);
      setReplyOpen(false);
      setReplyText('');
      const map: Record<string, { liked: boolean; count: number }> = {};
      for (const h of highlights) map[h.id] = { liked: h.likedByMe, count: h.likeCount };
      setLikeMap(map);
      // Best-effort: advance the highlights_last_viewed_at cursor so the
      // Explore tab badge clears after the user opens any highlight viewer.
      markHighlightsViewed().catch(() => {});
    }
  }, [visible, startIndex, highlights]);

  // Mark viewed when item shown — both local ring state and server-side
  useEffect(() => {
    if (!visible || !current) return;
    markViewed(current.id, current.expiresAt);
    markHighlightViewed(current.id);
  }, [visible, current?.id]);

  // Keep goNextRef current on every render so handleVideoStatus always calls
  // the latest version without a stale closure.
  goNextRef.current = goNext;

  // Web: sync pause/resume to the HTML <video> element
  useEffect(() => {
    if (Platform.OS !== 'web' || !webVideoRef.current) return;
    if (paused) {
      webVideoRef.current.pause();
    } else {
      webVideoRef.current.play().catch(() => {});
    }
  }, [paused]);

  // Web: sync muted state to the HTML <video> element
  useEffect(() => {
    if (Platform.OS !== 'web' || !webVideoRef.current) return;
    webVideoRef.current.muted = isMuted;
  }, [isMuted]);

  // Progress timer — images only. Videos drive progress via onPlaybackStatusUpdate.
  useEffect(() => {
    if (!visible || paused || isVideo) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    if (intervalRef.current) clearInterval(intervalRef.current);
    setProgress(0);
    const tickMs = 50;
    intervalRef.current = setInterval(() => {
      setProgress((p) => {
        const next = p + tickMs / ITEM_DURATION_MS;
        if (next >= 1) {
          clearInterval(intervalRef.current!);
          goNextRef.current();
          return 1;
        }
        return next;
      });
    }, tickMs);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [visible, index, paused, isVideo]);

  // Reset video progress when navigating to a new item.
  //
  // playbackUri is in the deps deliberately. The first render passes the raw
  // bare reference, which expo-av rejects and latches into videoError; when
  // hydration lands a moment later the URL is valid but the latch would keep
  // "Video unavailable" on screen until the user navigated away. Clearing on
  // the URI change lets the resolved source actually get a chance to play.
  useEffect(() => {
    if (isVideo) setProgress(0);
    setVideoError(false); // QA round 2, bug 11: clear per item.
  }, [index, isVideo, playbackUri]);

  // Video playback status — drives progress bar and auto-advance for video items
  const handleVideoStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      // QA round 2, bug 11: the failure branch of AVPlaybackStatus was being
      // swallowed by this bare early return. Surface it instead.
      if ((status as { error?: string }).error) setVideoError(true);
      return;
    }
    const dur = status.durationMillis;
    if (dur && dur > 0) {
      setProgress(status.positionMillis / dur);
    }
    if (status.didJustFinish) {
      goNextRef.current();
    }
  }, []);

  function goNext() {
    if (index < localHighlights.length - 1) {
      const next = index + 1;
      setIndex(next);
      setProgress(0);
      onHighlightChange?.(next);
    } else {
      onClose();
    }
  }

  async function handleDelete() {
    if (!current || !isOwner) return;
    Alert.alert(
      'Delete Highlight',
      'Remove this highlight? This can\u2019t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const ownerId = current.ownerId;
            const result = await deleteHighlight(current.id);
            if (!result.ok) {
              Alert.alert('Could not delete', result.message ?? 'Please try again.');
              return;
            }
            invalidateHighlightCache(ownerId);
            onDeleted?.();
            const remaining = localHighlights.filter((h) => h.id !== current.id);
            if (remaining.length === 0) {
              onClose();
            } else {
              setLocalHighlights(remaining);
              setIndex((i) => Math.min(i, remaining.length - 1));
              setProgress(0);
            }
          },
        },
      ],
    );
  }

  const toggleMute = useCallback(() => {
    setIsMuted((m) => !m);
  }, []);

  function goPrev() {
    if (index > 0) {
      const prev = index - 1;
      setIndex(prev);
      setProgress(0);
      onHighlightChange?.(prev);
    }
  }

  const handleLike = useCallback(async () => {
    if (!current) return;
    const prev = likeMap[current.id] ?? { liked: current.likedByMe, count: current.likeCount };
    const nextLiked = !prev.liked;
    const nextCount = Math.max(0, prev.count + (nextLiked ? 1 : -1));
    setLikeMap((m) => ({ ...m, [current.id]: { liked: nextLiked, count: nextCount } }));
    const r = await toggleHighlightLike(current.id, prev.liked);
    if (r.ok && r.data) {
      setLikeMap((m) => ({ ...m, [current.id]: { liked: r.data!.likedByMe, count: r.data!.likeCount } }));
    } else {
      setLikeMap((m) => ({ ...m, [current.id]: prev }));
    }
  }, [current, likeMap]);

  async function handleReply() {
    if (!current || !replyText.trim() || replying) return;
    setReplying(true);
    try {
      const r = await replyToHighlight(current.id, replyText.trim());
      if (r.ok && r.data?.threadId) {
        setReplyOpen(false);
        setReplyText('');
        // BUG CC/CD fix: defer navigation until after the sheet close animation.
        closeThenNavigate(onClose, `/messages/${r.data.threadId}`);
      } else {
        Alert.alert('Could not send reply', r.message ?? 'Try again.');
      }
    } finally {
      setReplying(false);
    }
  }

  function handleReport() {
    if (!current) return;
    Alert.alert('Report Highlight', 'Why are you reporting this?', [
      { text: 'Inappropriate', onPress: () => reportHighlight(current.id, 'inappropriate').then(() => Alert.alert('Reported', 'Thank you.')) },
      { text: 'Spam', onPress: () => reportHighlight(current.id, 'spam').then(() => Alert.alert('Reported', 'Thank you.')) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  if (!visible || !current) return null;

  const likeState = likeMap[current.id] ?? { liked: current.likedByMe, count: current.likeCount };
  const locLabel = [current.locationName ?? current.locationCity, current.locationCountry].filter(Boolean).join(', ');

  const isVideoHighlight = (current.mediaType ?? '').startsWith('video/');
  const hasFilter = current.filterId && current.filterId !== 'original';
  const shouldApplyFilter = isVideoHighlight && hasFilter;
  const cssFilter = shouldApplyFilter
    ? buildCssFilter(getMediaFilter(current.filterId), current.filterIntensity ?? 100)
    : 'none';

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={s.container}>
        {/* Media — web <video> on web, expo-av Video on native, Image for photos */}
        {isVideo && Platform.OS === 'web' ? (
          // Web video fallback: HTML <video> element with progress/auto-advance wired
          // via onTimeUpdate / onEnded; paused and muted are synced via useEffect above.
          // src is the hydrated URL — signed URLs are self-authenticating, so no
          // Authorization header is needed here (see the note at playbackUri).
          <video
            key={`${current.id}:${playbackUri}`}
            ref={webVideoRef}
            src={playbackUri}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              ...(shouldApplyFilter ? { filter: cssFilter } : {}),
            } as any}
            autoPlay
            muted={isMuted}
            playsInline
            onTimeUpdate={(e: React.SyntheticEvent<HTMLVideoElement>) => {
              const el = e.currentTarget;
              if (el.duration > 0) setProgress(el.currentTime / el.duration);
            }}
            onEnded={() => goNextRef.current()}
            onError={() => setVideoError(true)} // QA round 2, bug 11
          />
        ) : isVideo ? (
          <Video
            // The URI is part of the key so the player remounts against the
            // signed URL once hydration resolves, rather than depending on
            // expo-av noticing a changed source prop mid-playback.
            key={`${current.id}:${playbackUri}`}
            ref={videoRef}
            source={{ uri: playbackUri }}
            style={StyleSheet.absoluteFill}
            resizeMode={ResizeMode.COVER}
            shouldPlay={!paused}
            isLooping={false}
            isMuted={isMuted}
            useNativeControls={false}
            onPlaybackStatusUpdate={handleVideoStatus}
          />
        ) : (
          // Photo branch. This was a bare RN <Image> bound straight to
          // current.mediaUrl — a private-bucket post-media reference, which
          // renders as dead whitespace unhydrated. DisplayMediaImage hydrates
          // it, gives it a designed failure state, and carries the filter.
          <DisplayMediaImage
            uri={current.mediaUrl}
            width={SCREEN_W}
            height={SCREEN_H}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            alt={current.caption ?? 'Highlight photo'}
            fallbackLabel="Photo unavailable"
            filterId={current.filterId}
            filterIntensity={current.filterIntensity}
          />
        )}

        {/* QA round 2, bug 11: tell the user the video failed instead of
            showing an indefinitely black frame. */}
        {(videoError || videoUnresolvable) && (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="none">
            <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '600', textAlign: 'center', paddingHorizontal: 24 }}>
              Video unavailable
            </Text>
          </View>
        )}

        {/* Progress bars */}
        <View style={[s.progressRow, { marginTop: insets.top + 8 }]}>
          {localHighlights.map((h, i) => (
            <View key={h.id} style={s.progressTrack}>
              <View
                style={[
                  s.progressFill,
                  { width: `${i < index ? 100 : i === index ? Math.round(progress * 100) : 0}%` },
                ]}
              />
            </View>
          ))}
        </View>

        {/* Top row: author + close */}
        <View style={s.topRow}>
          {current.author && (
            <UserIdentityLink
              userId={current.author.id}
              handle={current.author.handle}
              currentUserId={currentUserId}
              testID="highlight-author-identity"
            >
              <View style={s.authorRow}>
                {/* Was a bare RN <Image> on a profile-media URL — same private-
                    bucket class as the photo branch, rendering an empty grey
                    circle. AvatarImage hydrates and degrades to initials. */}
                <AvatarImage
                  uri={current.author.avatarUrl}
                  user={current.author}
                  size={AVATAR_SIZE}
                  style={s.avatar}
                />
                <View>
                  <Text style={s.authorName}>{current.author.name}</Text>
                  {locLabel ? <Text style={s.locText}>{locLabel}</Text> : null}
                </View>
                <View style={s.timeChip}>
                  <Text style={s.timeText}>{fmtExpiry(current.expiresAt)}</Text>
                </View>
              </View>
            </UserIdentityLink>
          )}
          <View style={{ flex: 1 }} />
          {isVideo && (
            <Pressable
              onPress={toggleMute}
              hitSlop={8}
              style={[s.closeBtn, s.muteBtn]}
              accessibilityRole="button"
              accessibilityLabel={isMuted ? 'Unmute video' : 'Mute video'}
            >
              {isMuted ? <VolumeX size={20} color="#fff" /> : <Volume2 size={20} color="#fff" />}
            </Pressable>
          )}
          {isOwner && onAddHighlight && (
            <Pressable onPress={onAddHighlight} hitSlop={8} style={[s.closeBtn, s.addBtn]}>
              <Plus size={20} color="#fff" />
            </Pressable>
          )}
          <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
            <X size={20} color="#fff" />
          </Pressable>
        </View>

        {/* Tap zones */}
        <View style={s.tapZones} pointerEvents="box-none">
          <Pressable
            style={s.tapLeft}
            onPress={goPrev}
            onLongPress={() => setPaused(true)}
            onPressOut={() => setPaused(false)}
          />
          <Pressable
            style={s.tapRight}
            onPress={goNext}
            onLongPress={() => setPaused(true)}
            onPressOut={() => setPaused(false)}
          />
        </View>

        {/* Cinematic scrim — bottom 60 % gradient, end-stop 0.85, keeps
            author / controls WCAG AA readable on bright (snowy/beach) media. */}
        <LinearGradient
          colors={['rgba(17,17,15,0)', 'rgba(17,17,15,0.85)']}
          style={s.scrim}
          pointerEvents="none"
        />

        {/* Bottom: caption + actions — keyboard-safe so the reply input stays
            above the keyboard when open */}
        <KeyboardSafeScrollView style={s.bottomWrap}>
        <View style={[s.bottom, { paddingBottom: Math.max(insets.bottom, 24) }]}>
          {current.caption ? (
            <Text style={s.caption} numberOfLines={3}>{current.caption}</Text>
          ) : null}

          {replyOpen && (
            <View style={s.replyRow}>
              <TextInput
                style={s.replyInput}
                placeholder="Send a reply…"
                placeholderTextColor="rgba(255,255,255,0.5)"
                value={replyText}
                onChangeText={setReplyText}
                autoFocus
                returnKeyType="send"
                onSubmitEditing={handleReply}
              />
              <Pressable onPress={handleReply} disabled={replying || !replyText.trim()} style={s.replyBtn}>
                {replying
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={s.replyBtnText}>Send</Text>}
              </Pressable>
            </View>
          )}

          <View style={s.actions}>
            {!isOwner && (
              <View style={s.actionBtn}>
                <Pressable
                  onPress={handleLike}
                  onLongPress={() => setLikerHighlightId(current.id)}
                  hitSlop={HIT_SLOP}
                >
                  <StampIcon
                    size={24}
                    active={likeState.liked}
                    color={likeState.liked ? color.signal : '#fff'}
                  />
                </Pressable>
                {likeState.count > 0 && (
                  <Pressable onPress={() => setLikerHighlightId(current.id)} hitSlop={6}>
                    <Text style={s.actionCount}>{likeState.count}</Text>
                  </Pressable>
                )}
              </View>
            )}

            {!isOwner && !replyOpen && (
              <Pressable onPress={() => setReplyOpen(true)} style={s.actionBtn} hitSlop={HIT_SLOP}>
                <MessageCircle size={24} color="#fff" />
              </Pressable>
            )}

            {isOwner && (
              <Pressable onPress={() => setViewersOpen(true)} style={s.actionBtn}>
                <Eye size={22} color="#fff" />
                <Text style={s.actionCount}>{current.viewCount}</Text>
              </Pressable>
            )}

            {isOwner && (
              <Pressable onPress={handleDelete} style={s.actionBtn} hitSlop={HIT_SLOP}>
                <Trash2 size={20} color="rgba(255,255,255,0.7)" />
              </Pressable>
            )}

            {!isOwner && (current.visibility === 'public' || current.visibility === 'travelers_nearby') && (
              <Pressable
                onPress={async () => {
                  const available = await Sharing.isAvailableAsync();
                  if (available) {
                    await Sharing.shareAsync(current.mediaUrl, { mimeType: current.mediaType });
                  } else {
                    Alert.alert('Sharing not available on this device');
                  }
                }}
                style={s.actionBtn}
                hitSlop={HIT_SLOP}
                accessibilityRole="button"
                accessibilityLabel="Share this highlight"
              >
                <PortavaShareIcon size={20} color="rgba(255,255,255,0.85)" />
              </Pressable>
            )}

            {!isOwner && current && (
              <SaveButton entityType="highlight" entityId={current.id} size={20} tint="rgba(255,255,255,0.85)" />
            )}

            {!isOwner && (
              <Pressable onPress={handleReport} style={s.actionBtn} hitSlop={HIT_SLOP}>
                <Flag size={20} color="rgba(255,255,255,0.7)" />
              </Pressable>
            )}
          </View>
        </View>
        </KeyboardSafeScrollView>
      </View>

      <HighlightViewersSheet
        visible={viewersOpen}
        highlightId={current.id}
        onClose={() => setViewersOpen(false)}
      />

      {likerHighlightId !== null && (
        <EngagementUserListSheet
          visible
          targetType="highlight_like"
          targetId={likerHighlightId}
          title="Liked by"
          initialTotal={likeMap[likerHighlightId]?.count ?? 0}
          onClose={() => setLikerHighlightId(null)}
        />
      )}
    </Modal>
  );
}

function fmtExpiry(expiresAt: string): string {
  const diff = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0) return `${hrs}h left`;
  return `${mins}m left`;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  progressRow: {
    position: 'absolute',
    top: 0,
    left: space.md,
    right: space.md,
    flexDirection: 'row',
    gap: 3,
    zIndex: 10,
  },
  progressTrack: {
    flex: 1,
    height: 2.5,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#fff',
    borderRadius: 2,
  },
  topRow: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    top: 42,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 10,
  },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  // Size lives in AVATAR_SIZE and is passed to AvatarImage, which needs the
  // number to lay out its initials fallback; only the ring is styled here.
  avatar: { borderWidth: 1.5, borderColor: '#fff' },
  authorName: { color: '#fff', fontWeight: '700', fontSize: 14 },
  locText: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 1 },
  timeChip: { backgroundColor: 'rgba(17,17,15,0.5)', paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.sm },
  timeText: { color: '#fff', fontSize: 11, fontFamily: 'Courier', fontWeight: '700' },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(17,17,15,0.4)' },
  addBtn: { marginRight: 8 },
  muteBtn: { marginRight: 8 },
  tapZones: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', zIndex: 5 },
  tapLeft: { flex: 1 },
  tapRight: { flex: 1 },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%', zIndex: 8 },
  bottomWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    flex: 0,
  },
  bottom: {
    padding: space.lg,
    gap: space.md,
  },
  caption: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 21,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  actionCount: { color: '#fff', fontSize: 13, fontWeight: '700' },
  replyRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  replyInput: {
    flex: 1,
    color: '#fff',
    fontSize: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    backgroundColor: 'rgba(17,17,15,0.4)',
  },
  replyBtn: { backgroundColor: color.signal, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 8 },
  replyBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});
