/**
 * WatchVideoCell — full-screen video cell for the Watch paging list.
 *
 * Responsibilities:
 *   - Plays when isActive=true, pauses (and optionally resets position) when false.
 *   - Shows poster image while buffering to avoid black flashes.
 *   - Reports playback progress via onProgress(ratio 0–1).
 *   - After 3 consecutive load failures, shows the playback-failed state.
 *   - Respects isMuted prop (controlled by parent mute preference).
 *   - Exposes videoRef so useWatchPlayback can manage it externally.
 */

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import {
  View,
  Image,
  Text,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import { WifiOff, PlayCircle } from 'lucide-react-native';
import { color, type as t } from '../../theme/tokens.ts';

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get('window');
const MAX_FAILURES = 3;

export interface WatchVideoCellProps {
  id: string;
  videoUrl: string;
  posterUrl: string | null;
  isActive: boolean;
  isMuted: boolean;
  onProgress: (ratio: number) => void;
  /** Called once the cell is fully registered so the playback manager can control it. */
  onVideoRef?: (id: string, ref: React.RefObject<Video | null>) => void;
  onVideoUnmount?: (id: string) => void;
}

export interface WatchVideoCellHandle {
  videoRef: React.RefObject<Video | null>;
}

export const WatchVideoCell = forwardRef<WatchVideoCellHandle, WatchVideoCellProps>(
  function WatchVideoCell(
    { id, videoUrl, posterUrl, isActive, isMuted, onProgress, onVideoRef, onVideoUnmount },
    ref,
  ) {
    const videoRef = useRef<Video>(null);
    const [isBuffering, setIsBuffering] = useState(true);
    const [failureCount, setFailureCount] = useState(0);
    const [hasHardFailed, setHasHardFailed] = useState(false);
    const mountedRef = useRef(true);

    // Expose videoRef to parent via imperative handle.
    useImperativeHandle(ref, () => ({ videoRef }), []);

    // Register / unregister with the playback manager.
    useEffect(() => {
      onVideoRef?.(id, videoRef as React.RefObject<Video | null>);
      return () => {
        mountedRef.current = false;
        onVideoUnmount?.(id);
      };
    }, [id, onVideoRef, onVideoUnmount]);

    // React to isActive changes: play or pause.
    useEffect(() => {
      if (hasHardFailed) return;
      if (isActive) {
        videoRef.current?.playAsync().catch(() => {});
      } else {
        videoRef.current?.pauseAsync().catch(() => {});
        // Reset position so the next time this cell becomes active it starts fresh.
        videoRef.current?.setPositionAsync(0).catch(() => {});
      }
    }, [isActive, hasHardFailed]);

    const handleStatus = useCallback(
      (status: AVPlaybackStatus) => {
        if (!mountedRef.current) return;

        if (!status.isLoaded) {
          if ((status as any).error) {
            setFailureCount((c) => {
              const next = c + 1;
              if (next >= MAX_FAILURES) setHasHardFailed(true);
              return next;
            });
          }
          return;
        }

        // Reset failure count on successful load.
        if (failureCount > 0) setFailureCount(0);

        setIsBuffering(status.isBuffering ?? false);

        const dur = status.durationMillis;
        if (dur && dur > 0) {
          onProgress(status.positionMillis / dur);
        }
      },
      [failureCount, onProgress],
    );

    // ── Failure state ─────────────────────────────────────────────────────────

    if (hasHardFailed) {
      return (
        <View style={s.cell}>
          {posterUrl ? (
            <Image source={{ uri: posterUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : null}
          <View style={s.failureOverlay}>
            <PlayCircle size={40} color="rgba(255,255,255,0.7)" />
            <Text style={s.failureText}>Video unavailable</Text>
          </View>
        </View>
      );
    }

    return (
      <View style={s.cell}>
        <Video
          ref={videoRef}
          source={{ uri: videoUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode={ResizeMode.COVER}
          shouldPlay={isActive}
          isLooping
          isMuted={isMuted}
          useNativeControls={false}
          onPlaybackStatusUpdate={handleStatus}
        />

        {/* Poster: shown while buffering (avoids black flash during seek). */}
        {isBuffering && posterUrl ? (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Image
              source={{ uri: posterUrl }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
            />
          </View>
        ) : null}

        {/* Buffering spinner overlay */}
        {isBuffering && isActive ? (
          <View style={s.spinnerOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="rgba(255,255,255,0.8)" />
          </View>
        ) : null}
      </View>
    );
  },
);

const s = StyleSheet.create({
  cell: {
    width: SCREEN_W,
    height: SCREEN_H,
    backgroundColor: color.ink,
    overflow: 'hidden',
  },
  spinnerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  failureOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  failureText: {
    ...t.small,
    color: 'rgba(255,255,255,0.7)',
  },
});
