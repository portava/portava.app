/**
 * SharedVideoPlayer — reusable video player wrapping expo-av's Video.
 *
 * Features:
 *   - Play/pause overlay button when paused
 *   - Tap-to-unmute icon in non-fullscreen mode (muted by default)
 *   - Poster image shown while paused / loading
 *   - Load-error fallback view
 *   - onEnd callback
 */
import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Pressable,
  StyleSheet,
  Image,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import { Play, Volume2, VolumeX } from 'lucide-react-native';
import { color, radius } from '../../theme/tokens.ts';

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
    <View style={[s.container, style]}>
      <Video
        ref={videoRef}
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        resizeMode={ResizeMode.COVER}
        shouldPlay={autoplay}
        isLooping={loop}
        isMuted={isMuted}
        useNativeControls={false}
        onPlaybackStatusUpdate={handlePlaybackStatus}
      />

      {/* Poster shown while paused and poster uri is provided */}
      {!isPlaying && poster ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Image
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
