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
  style?: StyleProp<ViewStyle>;
}

export function SharedVideoPlayer({
  uri,
  poster,
  autoplay = false,
  muted: mutedProp = true,
  loop = false,
  onEnd,
  style,
}: SharedVideoPlayerProps) {
  const videoRef = useRef<Video>(null);
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
      setIsPlaying(status.isPlaying);
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
        isLooping={loop}
        isMuted={isMuted}
        useNativeControls={false}
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
    width: avatar.xxl, height: avatar.xxl,
    borderRadius: avatar.xxl / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  muteBtn: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    width: avatar.sm, height: avatar.sm,
    borderRadius: avatar.sm / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
