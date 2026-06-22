/**
 * HighlightViewer — full-screen modal highlight player.
 *
 * Shows an ordered list of active highlights (for one user or multiple).
 * Features:
 *   - Segmented progress bar per item (5s auto-advance)
 *   - Tap right → next, tap left → prev
 *   - Like button, reply button, report, close
 *   - POST /highlights/:id/view on each item shown
 *   - Owner sees "👁 N" chip → opens HighlightViewersSheet
 *   - Videos shown as static thumbnails with a play badge (no native player needed)
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Image, Pressable, Modal, StyleSheet,
  Alert, Dimensions, ActivityIndicator, TextInput,
} from 'react-native';
import { X, Heart, MessageCircle, Flag, Eye, PlayCircle, Share2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { color, space, radius, type as t } from '../theme/tokens';
import type { Highlight } from '../services/highlights';
import {
  markHighlightViewed,
  toggleHighlightLike,
  replyToHighlight,
  reportHighlight,
} from '../services/highlights';
import { markViewed } from '../hooks/useHighlightRingState';
import { HighlightViewersSheet } from './HighlightViewersSheet';

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
}

export function HighlightViewer({
  visible,
  highlights,
  startIndex = 0,
  currentUserId,
  onClose,
  onHighlightChange,
}: Props) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(startIndex);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [likeMap, setLikeMap] = useState<Record<string, { liked: boolean; count: number }>>({});
  const [viewersOpen, setViewersOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const current = highlights[index];
  const isOwner = current?.ownerId === currentUserId;
  const isVideo = (current?.mediaType ?? '').startsWith('video/');

  // Reset when visible/startIndex changes
  useEffect(() => {
    if (visible) {
      setIndex(startIndex);
      setProgress(0);
      setPaused(false);
      setReplyOpen(false);
      setReplyText('');
      const map: Record<string, { liked: boolean; count: number }> = {};
      for (const h of highlights) map[h.id] = { liked: h.likedByMe, count: h.likeCount };
      setLikeMap(map);
    }
  }, [visible, startIndex, highlights]);

  // Mark viewed when item shown — both local ring state and server-side
  useEffect(() => {
    if (!visible || !current) return;
    markViewed(current.id);
    markHighlightViewed(current.id);
  }, [visible, current?.id]);

  // Progress timer — for videos, respect actual video_duration_seconds (capped at 10s);
  // for images, use the default 5s dwell time.
  useEffect(() => {
    if (!visible || paused) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    setProgress(0);
    const videoDurMs = isVideo && current?.videoDurationSeconds
      ? Math.min(current.videoDurationSeconds, 10) * 1000
      : null;
    const totalMs = videoDurMs ?? ITEM_DURATION_MS;
    const tickMs = 50;
    intervalRef.current = setInterval(() => {
      setProgress((p) => {
        const next = p + tickMs / totalMs;
        if (next >= 1) {
          clearInterval(intervalRef.current!);
          goNext();
          return 1;
        }
        return next;
      });
    }, tickMs);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [visible, index, paused]);

  function goNext() {
    if (index < highlights.length - 1) {
      const next = index + 1;
      setIndex(next);
      setProgress(0);
      onHighlightChange?.(next);
    } else {
      onClose();
    }
  }

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

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={s.container}>
        {/* Media */}
        <Image
          source={{ uri: current.mediaUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />

        {/* Video indicator overlay */}
        {isVideo && (
          <View style={s.videoOverlay} pointerEvents="none">
            <PlayCircle size={56} color="rgba(255,255,255,0.85)" />
            {current.videoDurationSeconds != null && (
              <View style={s.durationBadge}>
                <Text style={s.durationText}>{current.videoDurationSeconds.toFixed(1)}s</Text>
              </View>
            )}
          </View>
        )}

        {/* Progress bars */}
        <View style={[s.progressRow, { marginTop: insets.top + 8 }]}>
          {highlights.map((h, i) => (
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
              <Pressable onPress={handleLike} style={s.actionBtn} hitSlop={HIT_SLOP}>
                <Heart
                  size={24}
                  color={likeState.liked ? color.signal : '#fff'}
                  fill={likeState.liked ? color.signal : 'transparent'}
                />
                {likeState.count > 0 && <Text style={s.actionCount}>{likeState.count}</Text>}
              </Pressable>
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
  videoOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  durationBadge: {
    position: 'absolute',
    bottom: 120,
    right: 16,
    backgroundColor: 'rgba(17,17,15,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  durationText: { fontFamily: 'Courier', fontSize: 12, color: '#fff', fontWeight: '700' },
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
  tapZones: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', zIndex: 5 },
  tapLeft: { flex: 1 },
  tapRight: { flex: 1 },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.lg,
    gap: space.md,
    zIndex: 10,
    backgroundColor: 'rgba(0,0,0,0.0)',
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
