/**
 * VideoStoryTrimSheet — post-pick crop-preview modal for story videos.
 *
 * iOS's expo-image-picker silently ignores allowsEditing/aspect for video
 * assets, so in-picker cropping cannot enforce the 9:16 story ratio.
 * This sheet fills that gap: after a video is picked it is shown inside a
 * 9:16 clip frame so the user can see exactly how it will appear in their
 * story before confirming.
 *
 * The video plays looped and muted for preview. The user either confirms
 * ("Use video") — the original asset URI is forwarded to onConfirm — or
 * cancels ("Re-pick") — onReject is called so the caller can re-open the
 * source sheet.
 *
 * Actual pixel cropping to 9:16 is enforced at upload/render time by the
 * ResizeMode.COVER + fixed 9:16 container; no native video-processing
 * dependency is required here.
 */
import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import { RefreshCw, CheckCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { ImagePickerAsset } from 'expo-image-picker';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VideoStoryTrimSheetProps {
  /** Whether the sheet is visible. */
  visible: boolean;
  /** The video asset to preview. */
  asset: ImagePickerAsset | null;
  /** Called when the user confirms — receives the original asset. */
  onConfirm: (asset: ImagePickerAsset) => void;
  /** Called when the user wants to re-pick (cancel). */
  onReject: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VideoStoryTrimSheet({
  visible,
  asset,
  onConfirm,
  onReject,
}: VideoStoryTrimSheetProps) {
  const videoRef = useRef<Video>(null);
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const handlePlaybackStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      if ((status as any).error) setHasError(true);
      return;
    }
    setLoading(false);
  }, []);

  // Reset loading/error state whenever the asset URI or visibility changes so
  // that a re-pick (new URI) or a sheet re-open always starts fresh.
  const uri = asset?.uri ?? '';
  useEffect(() => {
    setLoading(true);
    setHasError(false);
  }, [uri, visible]);

  function handleConfirm() {
    if (asset) onConfirm(asset);
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onReject}
      statusBarTranslucent
    >
      <View style={s.overlay}>
        <View style={s.sheet}>
          {/* Handle */}
          <View style={s.handle} />

          <Text style={s.title}>Preview your story video</Text>
          <Text style={s.subtitle}>
            Stories display in 9:16 — your video will be cropped to fit.
          </Text>

          {/* 9:16 crop frame */}
          <View style={s.frameOuter}>
            <View style={s.frame}>
              {uri !== '' && !hasError ? (
                <Video
                  ref={videoRef}
                  source={{ uri }}
                  style={StyleSheet.absoluteFill}
                  resizeMode={ResizeMode.COVER}
                  shouldPlay
                  isLooping
                  isMuted
                  useNativeControls={false}
                  onPlaybackStatusUpdate={handlePlaybackStatus}
                />
              ) : null}

              {/* Loading overlay */}
              {loading && !hasError && uri !== '' && (
                <View style={s.loadingOverlay} pointerEvents="none">
                  <ActivityIndicator size="large" color="#fff" />
                </View>
              )}

              {hasError && (
                <View style={s.errorOverlay}>
                  <Text style={s.errorText}>Could not load video preview</Text>
                </View>
              )}

              {/* Crop guide corners */}
              {!hasError && (
                <>
                  <View style={[s.corner, s.cornerTL]} />
                  <View style={[s.corner, s.cornerTR]} />
                  <View style={[s.corner, s.cornerBL]} />
                  <View style={[s.corner, s.cornerBR]} />
                </>
              )}
            </View>

            {/* 9:16 badge */}
            <View style={s.badge}>
              <Text style={s.badgeText}>9:16</Text>
            </View>
          </View>

          {/* Actions */}
          <View style={s.actions}>
            <Pressable
              style={s.rejectBtn}
              onPress={onReject}
              accessibilityRole="button"
              accessibilityLabel="Re-pick video"
            >
              <RefreshCw size={16} color={color.mute} />
              <Text style={s.rejectText}>Re-pick</Text>
            </Pressable>

            <Pressable
              style={[s.confirmBtn, hasError && s.confirmBtnDisabled]}
              onPress={handleConfirm}
              disabled={hasError}
              accessibilityRole="button"
              accessibilityLabel="Use this video"
            >
              <CheckCircle size={16} color="#fff" />
              <Text style={s.confirmText}>Use this video</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const FRAME_WIDTH = 200;
const FRAME_HEIGHT = Math.round((FRAME_WIDTH * 16) / 9); // ≈ 356
const CORNER = 16;

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: space.lg,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
    paddingTop: space.md,
    alignItems: 'center',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    marginBottom: space.md,
  },
  title: {
    ...t.heading,
    color: color.ink,
    textAlign: 'center',
    marginBottom: space.xs ?? 4,
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    marginBottom: space.lg,
  },
  frameOuter: {
    alignItems: 'center',
    marginBottom: space.lg,
  },
  frame: {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
    position: 'relative',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
  errorText: {
    color: color.faint,
    ...t.small,
    textAlign: 'center',
    paddingHorizontal: space.md,
  },
  // Crop-guide corners
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderColor: '#fff',
    opacity: 0.8,
  },
  cornerTL: { top: 8, left: 8, borderTopWidth: 2, borderLeftWidth: 2 },
  cornerTR: { top: 8, right: 8, borderTopWidth: 2, borderRightWidth: 2 },
  cornerBL: { bottom: 8, left: 8, borderBottomWidth: 2, borderLeftWidth: 2 },
  cornerBR: { bottom: 8, right: 8, borderBottomWidth: 2, borderRightWidth: 2 },
  badge: {
    marginTop: space.sm,
    backgroundColor: color.deep + '22',
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  badgeText: {
    ...t.small,
    color: color.deep,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    gap: space.md,
    width: '100%',
  },
  rejectBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingVertical: 13,
  },
  rejectText: {
    ...t.body,
    color: color.mute,
    fontWeight: '500',
  },
  confirmBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.deep,
    borderRadius: radius.pill,
    paddingVertical: 13,
  },
  confirmBtnDisabled: {
    opacity: 0.4,
  },
  confirmText: {
    ...t.body,
    color: '#fff',
    fontWeight: '700',
  },
});
