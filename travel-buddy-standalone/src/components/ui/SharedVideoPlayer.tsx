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
 * Video URIs are passed through directly — signed URLs are self-authenticating
 * and require no Authorization header injection.
 */
import React, { useRef, useCallback, useState } from 'react';
import {
  View,
  Pressable,
  StyleSheet,
  Image,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Video, type AVPlaybackStatus } from 'expo-av';
import { Play, Volume2, VolumeX } from 'lucide-react-native';
import { color, radius } from '../../theme/tokens.ts';
import { useSmartVideoFit } from '../../hooks/useSmartVideoFit.ts';
import { VideoBlurBackdrop } from './VideoBlurBackdrop.tsx';

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

  if (hasError) {
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
      {needsLetterbox ? <VideoBlurBackdrop uri={poster} /> : null}
      <Video
        ref={videoRef}
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        resizeMode={resizeMode}
        shouldPlay={autoplay}
        isLooping={loop}
        isMuted={isMuted}
        useNativeControls={false}
        onPlaybackStatusUpdate={handlePlaybackStatus}
        onReadyForDisplay={onReadyForDisplay}
      />

      {/* Poster shown while paused and poster uri is provided */}
      {!isPlaying && poster ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Image
            testID="poster-image"
            source={{ uri: poster }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
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
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  muteBtn: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
