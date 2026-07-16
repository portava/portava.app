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
  View, Text, Image, Pressable, Modal, StyleSheet,
  Alert, Dimensions, ActivityIndicator, TextInput, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import { getMediaFilter, buildCssFilter } from '../lib/media/filters.ts';
import { X, Heart, MessageCircle, Flag, Eye, Share2, Plus, Trash2, Volume2, VolumeX } from 'lucide-react-native';
import { SaveButton } from './SaveButton.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { color, space, radius, type as t } from '../theme/tokens.ts';
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

const { width: SCREEN_W } = Dimensions.get('window');
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
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const videoRef = useRef<Video>(null);
  // goNextRef lets the stable handleVideoStatus callback call the latest goNext
  const goNextRef = useRef<() => void>(() => {});

  const current = localHighlights[index];
  const isOwner = current?.ownerId === currentUserId;
  const isVideo = (current?.mediaType ?? '').startsWith('video/');

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

  // Reset video progress when navigating to a new item
  useEffect(() => {
    if (isVideo) setProgress(0);
  }, [index, isVideo]);

  // Video playback status — drives progress bar and auto-advance for video items
  const handleVideoStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
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
        onClose();
        router.push(`/messages/${r.data.threadId}` as any);
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
        {/* Media — native video player for clips, Image for photos */}
        {isVideo ? (
          <Video
            key={current.id}
            ref={videoRef}
            source={{ uri: current.mediaUrl }}
            style={[
              StyleSheet.absoluteFill,
              shouldApplyFilter && Platform.OS === 'web' ? { filter: cssFilter } as any : undefined,
            ]}
            resizeMode={ResizeMode.COVER}
            shouldPlay={!paused}
            isLooping={false}
            isMuted={isMuted}
            useNativeControls={false}
            onPlaybackStatusUpdate={handleVideoStatus}
          />
        ) : (
          <Image
            source={{ uri: current.mediaUrl }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
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
            <View style={s.authorRow}>
              <Image source={{ uri: current.author.avatarUrl ?? undefined }} style={s.avatar} />
              <View>
                <Text style={s.authorName}>{current.author.name}</Text>
                {locLabel ? <Text style={s.locText}>{locLabel}</Text> : null}
              </View>
              <View style={s.timeChip}>
                <Text style={s.timeText}>{fmtExpiry(current.expiresAt)}</Text>
              </View>
            </View>
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

        {/* Bottom: caption + actions */}
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
                  <Heart
                    size={24}
                    color={likeState.liked ? color.signal : '#fff'}
                    fill={likeState.liked ? color.signal : 'transparent'}
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
              >
                <Share2 size={20} color="rgba(255,255,255,0.85)" />
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
  avatar: { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: '#fff', backgroundColor: '#333' },
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
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.lg,
    gap: space.md,
    zIndex: 10,
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
