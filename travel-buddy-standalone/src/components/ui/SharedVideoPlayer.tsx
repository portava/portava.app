/**
 * SharedVideoPlayer — reusable video player wrapping expo-av's Video.
 *
 * Features:
 *   - Play/pause overlay button when paused
 *   - Tap-to-unmute icon in non-fullscreen mode (muted by default)
 *   - Poster image shown while paused / loading
 *   - Load-error fallback view
 *   - onEnd callback
 *
 * ## URIs must be hydrated before they reach <Video>
 *
 * This used to pass `uri` through untouched, on the assumption that it was
 * already a signed URL. It is not: post-media is a PRIVATE bucket and the
 * stored value is a bare `post-media/<uid>/<file>.mp4` reference with no
 * scheme. expo-av cannot report a useful error for a URI it cannot even parse,
 * so this surface rendered a truly blank box — the worst of the four.
 *
 * Both `uri` and `poster` go through useHydratedMedia. A null resolve is
 * treated exactly like a playback error: the "Video unavailable" state, never
 * an empty frame.
 */
import React, { useRef, useCallback, useState } from 'react';
import {
  View,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Video, type AVPlaybackStatus } from 'expo-av';
import { Play, Volume2, VolumeX } from 'lucide-react-native';
import { color, radius, avatar } from '../../theme/tokens.ts';
import { useSmartVideoFit } from '../../hooks/useSmartVideoFit.ts';
import { VideoBlurBackdrop } from './VideoBlurBackdrop.tsx';
import { useHydratedMedia } from '../../services/mediaUrl.ts';
import { DisplayMediaImage } from './DisplayMediaImage.tsx';

export interface SharedVideoPlayerProps {
  uri: string;
  poster?: string;
  /** Start playing immediately. Default: false */
  autoplay?: boolean;
  /** Start muted. Default: true */
  muted?: boolean;
  loop?: boolean;
  onEnd?: () => void;
  style?: StyleProp<ViewStyle>; /** census-highlights-memories H184 (B58 MEM-SEGMENTS): play only [startMs, endMs) of this video — start at startMs, pause and rewind at endMs. Absent or null: exactly the player as it was. */ segment?: VideoSegmentWindow | null;
}

export function SharedVideoPlayer({
  uri,
  poster,
  autoplay = false,
  muted: mutedProp = true,
  loop = false,
  onEnd,
  style, segment = null,
}: SharedVideoPlayerProps) {
  const videoRef = useRef<Video>(null); const segmentWindow = useSegmentWindow(videoRef, segment); // H184: inert without a segment
  const [isPlaying, setIsPlaying] = useState(autoplay);
  const [isMuted, setIsMuted] = useState(mutedProp);
  const [hasError, setHasError] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // Private-bucket references resolve to signed URLs here. Until the resolve
  // lands, `hydrated[uri]` is undefined and the plain value is used, which is
  // correct for the already-absolute URLs some rows still hold.
  const { resolved: hydrated } = useHydratedMedia([uri, poster ?? null]);
  const hydratedUri = hydrated[uri];
  const playbackUri = typeof hydratedUri === 'string' ? hydratedUri : uri;
  const posterUri = poster
    ? (typeof hydrated[poster] === 'string' ? (hydrated[poster] as string) : poster)
    : undefined;
  // Server said no: unreadable, same user-visible outcome as a decode failure.
  const unresolvable = hydratedUri === null;
  const { resizeMode, needsLetterbox, onReadyForDisplay } = useSmartVideoFit(
    containerSize.w,
    containerSize.h,
  );

  const handlePlaybackStatus = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) {
        if ((status as any).error) {
          setHasError(true);
        }
        return;
      }
      setIsPlaying(status.isPlaying); if (segmentWindow.onStatus(status)) { setIsPlaying(false); onEnd?.(); return; } // H184: the window's end is this player's end
      if (status.didJustFinish && !loop) {
        onEnd?.();
      }
    },
    [loop, onEnd],
  );

  const togglePlay = useCallback(async () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      await videoRef.current.pauseAsync();
    } else {
      await videoRef.current.playAsync();
    }
  }, [isPlaying]);

  const toggleMute = useCallback(async () => {
    if (!videoRef.current) return;
    const next = !isMuted;
    setIsMuted(next);
    await videoRef.current.setStatusAsync({ isMuted: next });
  }, [isMuted]);

  if (hasError || unresolvable) {
    return (
      <View style={[s.container, s.error, style]}>
        <Text style={s.errorText}>Video unavailable</Text>
      </View>
    );
  }

  return (
    <View
      style={[s.container, style]}
      onLayout={(e) =>
        setContainerSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
      }
    >
      {needsLetterbox ? <VideoBlurBackdrop uri={posterUri} /> : null}
      <Video
        ref={videoRef}
        source={{ uri: playbackUri }}
        style={StyleSheet.absoluteFill}
        resizeMode={resizeMode}
        shouldPlay={autoplay}
        isLooping={loop && !segment}
        isMuted={isMuted}
        useNativeControls={false} {...segmentWindow.videoProps}
        onPlaybackStatusUpdate={handlePlaybackStatus}
        onReadyForDisplay={onReadyForDisplay}
      />

      {/* Poster shown while paused and poster uri is provided. DisplayMediaImage
          rather than a bare <Image>: the poster is a post-media object too, and
          a failed one must show the designed fallback, not an empty frame. */}
      {!isPlaying && posterUri ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <DisplayMediaImage
            testID="poster-image"
            uri={posterUri}
            width={containerSize.w}
            height={containerSize.h}
            resizeMode="cover"
            style={StyleSheet.absoluteFill}
            fallbackLabel=""
          />
        </View>
      ) : null}

      {/* Tap anywhere to play/pause */}
      <Pressable style={StyleSheet.absoluteFill} onPress={togglePlay} accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'} />

      {/* Play overlay when paused */}
      {!isPlaying && (
        <View style={s.playOverlay} pointerEvents="none">
          <View style={s.playBtn}>
            <Play size={28} color="#fff" fill="#fff" />
          </View>
        </View>
      )}

      {/* Mute toggle — bottom right */}
      <Pressable
        style={s.muteBtn}
        onPress={toggleMute}
        accessibilityRole="button"
        accessibilityLabel={isMuted ? 'Unmute' : 'Mute'}
        hitSlop={8}
      >
        {isMuted ? (
          <VolumeX size={18} color="#fff" />
        ) : (
          <Volume2 size={18} color="#fff" />
        )}
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    backgroundColor: color.haze,
    borderRadius: radius.md,
    overflow: 'hidden',
    position: 'relative',
  },
  error: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
  },
  errorText: {
    color: color.mute,
    fontSize: 13,
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: avatar.s56, height: avatar.s56,
    borderRadius: avatar.s56 / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  muteBtn: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});


// ── census-highlights-memories H184 (B58 MEM-SEGMENTS): a LOGICAL segment of the video ──
// Appended at the tail so every line above keeps its number (census-wall W43/W170 and census-media MD278 cite them).
// A segment is a window over the SAME object this player already plays: nothing is cut, copied or re-encoded. The
// player starts at startMs (expo-av's initial positionMillis, re-seeked once on load if the native side ignored it),
// and when playback reaches endMs it pauses and rewinds to startMs, so the next press plays the window again.

/** A window over the video, in milliseconds: [startMs, endMs). */
export interface VideoSegmentWindow { startMs: number; endMs: number }

/** How far the first loaded position may sit from the window's start before the player re-seeks. */
export const SEGMENT_SEEK_TOLERANCE_MS = 250;
/** How often expo-av reports progress while a window plays, so the stop lands within ~0.1 s of endMs. */
export const SEGMENT_PROGRESS_INTERVAL_MS = 100;

/** Has playback reached the end of the window? Pure. */
export function segmentWindowEnded(segment: VideoSegmentWindow | null | undefined, positionMillis: unknown): boolean {
  return !!segment && typeof positionMillis === 'number' && positionMillis >= segment.endMs;
}

function useSegmentWindow(videoRef: React.RefObject<Video | null>, segment: VideoSegmentWindow | null) {
  const segmentRef = useRef(segment);
  const stoppedRef = useRef(false);
  const seededRef = useRef(false);
  const key = segment ? `${segment.startMs}:${segment.endMs}` : '';
  const keyRef = useRef(key);
  segmentRef.current = segment;
  if (keyRef.current !== key) { keyRef.current = key; stoppedRef.current = false; seededRef.current = false; }
  const onStatus = useCallback((status: AVPlaybackStatus): boolean => {
    const win = segmentRef.current;
    if (!win || !status.isLoaded) return false;
    const v = videoRef.current;
    const at = status.positionMillis;
    if (!seededRef.current) {
      seededRef.current = true;
      if (typeof at === 'number' && Math.abs(at - win.startMs) > SEGMENT_SEEK_TOLERANCE_MS && at < win.endMs) void v?.setPositionAsync(win.startMs);
    }
    if (segmentWindowEnded(win, at)) {
      if (stoppedRef.current) return false;
      stoppedRef.current = true;
      void v?.pauseAsync();
      void v?.setPositionAsync(win.startMs);
      return true;
    }
    stoppedRef.current = false;
    return false;
  }, [videoRef]);
  const videoProps = segment ? { positionMillis: segment.startMs, progressUpdateIntervalMillis: SEGMENT_PROGRESS_INTERVAL_MS } : {};
  return { onStatus, videoProps };
}
