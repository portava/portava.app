/**
 * MessageMediaBubble — shared component for image and video message bubbles.
 *
 * Renders inline in both TelegraphInboxScreen (DM thread) and GroupChatScreen.
 * - image: full-width Image, tap opens full-screen ImageViewer (system viewer)
 * - video: VideoThumbnail (poster + ▶ + duration badge), tap opens SharedVideoPlayer modal
 * - uploading: circular progress ring with cancel option
 * - failed: red ✕ with Retry button
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { X, AlertCircle, RefreshCw } from 'lucide-react-native';
import { DisplayMediaImage } from './ui/DisplayMediaImage.tsx';
import { VideoThumbnail } from './ui/VideoThumbnail.tsx';
import { SharedVideoPlayer } from './ui/SharedVideoPlayer.tsx';
import { color, radius, space, type as t } from '../theme/tokens.ts';
import { TG } from '../theme/telegraphTokens.ts';

/** Max display width for inline media inside a bubble (pt). */
const BUBBLE_MEDIA_WIDTH = 260;

export interface MessageMediaBubbleProps {
  /** 'image' or 'video'. */
  mediaType: 'image' | 'video';
  mediaUrl: string | null;
  thumbnailUrl?: string | null;
  durationSeconds?: number | null;
  /** Whether this bubble belongs to the current user. */
  mine: boolean;
  /** Sender name shown for received bubbles. */
  senderName?: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** Upload state — absent for server messages. */
  uploadState?: 'uploading' | 'failed' | null;
  /** 0–1 upload progress fraction. */
  uploadProgress?: number;
  onCancel?: () => void;
  onRetry?: () => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function MessageMediaBubble({
  mediaType,
  mediaUrl,
  thumbnailUrl,
  durationSeconds,
  mine,
  senderName,
  createdAt,
  uploadState,
  uploadProgress = 0,
  onCancel,
  onRetry,
}: MessageMediaBubbleProps) {
  const [videoPlayerOpen, setVideoPlayerOpen] = useState(false);

  // ── Uploading state ───────────────────────────────────────────────────────
  if (uploadState === 'uploading') {
    return (
      <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleOther, s.uploadingBubble]}>
        {senderName && !mine && (
          <Text style={s.senderName}>{senderName}</Text>
        )}
        <View style={s.uploadingContent}>
          <View style={s.progressRingWrap}>
            <ActivityIndicator size="large" color={mine ? '#fff' : color.signal} />
            <Text style={[s.progressPct, mine && s.progressPctMine]}>
              {Math.round(uploadProgress * 100)}%
            </Text>
          </View>
          <Text style={[s.uploadingLabel, mine && s.uploadingLabelMine]}>
            {mediaType === 'video' ? 'Uploading video…' : 'Uploading image…'}
          </Text>
          {onCancel && (
            <Pressable style={s.cancelBtn} onPress={onCancel} hitSlop={8}>
              <X size={14} color={mine ? '#fff' : color.mute} />
              <Text style={[s.cancelText, mine && s.cancelTextMine]}>Cancel</Text>
            </Pressable>
          )}
        </View>
        <Text style={[s.time, mine && s.timeMine]}>{formatTime(createdAt)}</Text>
      </View>
    );
  }

  // ── Failed state ──────────────────────────────────────────────────────────
  if (uploadState === 'failed') {
    return (
      <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleOther, s.failedBubble]}>
        {senderName && !mine && (
          <Text style={s.senderName}>{senderName}</Text>
        )}
        <View style={s.failedContent}>
          <AlertCircle size={20} color="#EF4444" />
          <Text style={s.failedLabel}>Upload failed</Text>
        </View>
        {onRetry && (
          <Pressable style={s.retryBtn} onPress={onRetry} hitSlop={8}>
            <RefreshCw size={13} color={color.onInk} />
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        )}
        <Text style={[s.time, mine && s.timeMine]}>{formatTime(createdAt)}</Text>
      </View>
    );
  }

  // ── Sent / received media bubble ──────────────────────────────────────────
  function handleImagePress() {
    if (mediaUrl) {
      Linking.openURL(mediaUrl).catch(() => {});
    }
  }

  function handleVideoPress() {
    setVideoPlayerOpen(true);
  }

  return (
    <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleOther, s.mediaBubble]}>
      {senderName && !mine && (
        <Text style={s.senderName}>{senderName}</Text>
      )}

      {mediaType === 'image' ? (
        <Pressable onPress={handleImagePress} style={s.imageWrap}>
          <DisplayMediaImage
            uri={mediaUrl}
            width={BUBBLE_MEDIA_WIDTH}
            height={180}
            resizeMode="cover"
            alt="Image message"
          />
        </Pressable>
      ) : (
        <>
          <VideoThumbnail
            posterUri={thumbnailUrl ?? null}
            duration={durationSeconds ?? null}
            style={s.videoThumb}
            onPress={handleVideoPress}
          />
          {/* Full-screen player modal */}
          <Modal
            visible={videoPlayerOpen}
            transparent
            animationType="fade"
            onRequestClose={() => setVideoPlayerOpen(false)}
          >
            <View style={s.playerModal}>
              <Pressable style={s.playerClose} onPress={() => setVideoPlayerOpen(false)} hitSlop={12}>
                <X size={22} color="#fff" />
              </Pressable>
              {mediaUrl && (
                <SharedVideoPlayer
                  uri={mediaUrl}
                  poster={thumbnailUrl ?? undefined}
                  autoplay
                  muted={false}
                  style={s.playerVideo}
                  onEnd={() => setVideoPlayerOpen(false)}
                />
              )}
            </View>
          </Modal>
        </>
      )}

      <Text style={[s.time, mine && s.timeMine]}>{formatTime(createdAt)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  bubble: {
    borderRadius: 14,
    overflow: 'hidden',
    maxWidth: BUBBLE_MEDIA_WIDTH,
  },
  bubbleOther: {
    backgroundColor: TG.recvBubble,
    borderWidth: 1,
    borderColor: TG.recvBorder,
    borderBottomLeftRadius: 4,
    alignSelf: 'flex-start',
  },
  bubbleMine: {
    backgroundColor: TG.sentBubble,
    borderBottomRightRadius: 4,
    alignSelf: 'flex-end',
  },
  mediaBubble: {
    padding: 0,
    overflow: 'hidden',
  },
  senderName: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.mute,
    fontSize: 10,
    marginBottom: 2,
    paddingHorizontal: 10,
    paddingTop: 8,
    letterSpacing: 0.2,
  },
  imageWrap: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  image: {
    width: BUBBLE_MEDIA_WIDTH,
    height: 180,
  },
  videoThumb: {
    width: BUBBLE_MEDIA_WIDTH,
    height: 180,
  },
  time: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.faint,
    fontSize: 10,
    textAlign: 'right',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  timeMine: { color: TG.sentTextMute },

  // Uploading
  uploadingBubble: { padding: space.md },
  uploadingContent: { alignItems: 'center', gap: 8, paddingVertical: space.sm },
  progressRingWrap: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  progressPct: { ...t.stamp, fontSize: 11, color: color.mute, marginTop: 4 },
  progressPctMine: { color: TG.sentTextMute },
  uploadingLabel: { ...t.small, color: color.mute, fontSize: 12, textAlign: 'center' },
  uploadingLabelMine: { color: TG.sentTextMute },
  cancelBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  cancelText: { ...t.stamp, color: color.mute, fontSize: 11 },
  cancelTextMine: { color: TG.sentTextMute },

  // Failed
  failedBubble: { padding: space.md },
  failedContent: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  failedLabel: { ...t.body, color: '#EF4444', fontWeight: '600' },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#EF4444', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6, alignSelf: 'flex-start' },
  retryText: { ...t.stamp, color: color.onInk, fontWeight: '700', fontSize: 12 },

  // Video full-screen modal
  playerModal: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerClose: {
    position: 'absolute',
    top: 56,
    right: 20,
    zIndex: 10,
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
  },
  playerVideo: {
    width: '100%',
    height: 340,
  },
});
