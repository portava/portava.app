/**
 * VideoThumbnail — static poster image + centred play-triangle overlay + optional duration badge.
 *
 * Used in grids/feeds so the full video is never auto-loaded during scroll.
 * Fire onPress to open the actual player.
 *
 * The poster URL is resolved through useHydratedMedia() so that when
 * `post-media` / `profile-media` buckets go private the thumbnail still loads.
 */
import React from 'react';
import {
  View,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { Play } from 'lucide-react-native';
import { color, radius } from '../../theme/tokens.ts';
import { useHydratedMedia } from '../../services/mediaUrl.ts';

export interface VideoThumbnailProps {
  posterUri?: string | null;
  /** Video duration in seconds — renders a badge in the bottom-right corner. */
  duration?: number | null;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VideoThumbnail({ posterUri, duration, style, onPress }: VideoThumbnailProps) {
  // Hydrate the poster URL through the signed-URL layer.
  // undefined = still loading (show image with plain URI); null = server rejected
  const { resolved: hydratedMap } = useHydratedMedia(posterUri ? [posterUri] : []);
  const effectivePosterUri = posterUri
    ? (hydratedMap[posterUri] === null ? null : (hydratedMap[posterUri] ?? posterUri))
    : null;

  // When no onPress is supplied (e.g. embedded read-only inside a feed card
  // whose own Pressable handles tap/double-tap), render a plain View instead
  // of a Pressable. A nested Pressable — even with onPress=undefined — still
  // claims the touch responder and swallows taps before they reach the
  // parent card's gesture handler, breaking tap-to-open and double-tap-to-stamp.
  // The "Play video" accessibility label is kept in both cases — it's the
  // marker other components/tests use to identify a video thumbnail, whether
  // or not this particular usage is independently tappable.
  const Container = onPress ? Pressable : View;
  const containerProps = onPress
    ? { onPress, accessibilityRole: 'button' as const, accessibilityLabel: 'Play video' }
    : { accessibilityLabel: 'Play video' };

  return (
    <Container
      style={[s.container, style]}
      {...containerProps}
    >
      {effectivePosterUri ? (
        // pointerEvents="none": on web, expo-image renders a real <img> DOM
        // node. A bare <img> can intercept the second click of a rapid
        // double-click as a native drag/selection gesture in some browsers,
        // swallowing it before it reaches the card's Pressable. Forcing
        // pointer-events: none guarantees every tap — single or double —
        // is handled solely by the Container/parent Pressable, matching
        // native mobile behavior where a nested Image never steals touches.
        <Image
          source={{ uri: effectivePosterUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          pointerEvents="none"
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.placeholder]} />
      )}

      {/* Play triangle overlay */}
      <View style={s.playOverlay} pointerEvents="none">
        <View style={s.playBtn}>
          <Play size={22} color="#fff" fill="#fff" />
        </View>
      </View>

      {/* Duration badge */}
      {duration != null && duration > 0 && (
        <View style={s.durationBadge} pointerEvents="none">
          <Text style={s.durationText}>{formatDuration(duration)}</Text>
        </View>
      )}
    </Container>
  );
}

const s = StyleSheet.create({
  container: {
    backgroundColor: color.haze,
    borderRadius: radius.md,
    overflow: 'hidden',
    position: 'relative',
  },
  placeholder: {
    backgroundColor: '#D1D5DB',
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  durationBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: 'rgba(17,17,15,0.65)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  durationText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Courier',
  },
});
