/**
 * StampArtwork — master stamp component.
 *
 * Routes to the right sub-component based on `size`:
 *   size < 56   → StampIcon    (compact badge for lists/chips)
 *   56–119      → StampCard    (medium badge for grids/strips)
 *   120+        → StampDetailArtwork  (full artwork for modals)
 *
 * All three sub-components share the same props contract so callers never
 * need to think about which one to use — just pass a `size`.
 *
 * When `stamp.universalArtworkUrl` is set the composited AI image is rendered
 * via expo-image with contentFit="contain" so the transparent frame is never
 * cropped. Falls back to the procedural art system on load error.
 */
import React, { useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import type { PassportStamp } from '../types/models.ts';
import { StampIcon } from './StampIcon.tsx';
import { StampCard } from './StampCard.tsx';
import { StampDetailArtwork } from './StampDetailArtwork.tsx';

export interface StampArtworkProps {
  stamp: PassportStamp;
  /**
   * Width = height of the stamp. Controls which sub-component renders.
   * Default: 88.
   */
  size?: number;
  /** Optional tilt in degrees (forwarded to StampCard). */
  rotate?: number;
  /** Tap handler. Wraps the component in a Pressable when provided. */
  onPress?: () => void;
}

export function StampArtwork({ stamp, size = 88, rotate = 0, onPress }: StampArtworkProps) {
  const [artFailed, setArtFailed] = useState(false);
  let child: React.ReactElement;

  if (stamp.universalArtworkUrl && !artFailed) {
    // AI-generated universal artwork — render the image via expo-image for
    // memory/disk caching; fall back to the procedural design on error.
    // contentFit="contain" preserves the transparent stamp frame (never crop).
    child = (
      <View
        style={[
          artStyles.frame,
          {
            width: size,
            height: size,
            borderRadius: size / 8,
            transform: rotate ? [{ rotate: `${rotate}deg` }] : undefined,
          },
          stamp.locked && artStyles.locked,
        ]}
      >
        <Image
          source={{ uri: stamp.universalArtworkUrl }}
          style={{ width: '100%', height: '100%' }}
          contentFit="contain"
          cachePolicy="memory-disk"
          onError={() => setArtFailed(true)}
          accessibilityIgnoresInvertColors
        />
      </View>
    );
  } else if (size < 56) {
    child = <StampIcon stamp={stamp} size={size} />;
  } else if (size < 120) {
    child = <StampCard stamp={stamp} size={size} rotate={rotate} />;
  } else {
    child = <StampDetailArtwork stamp={stamp} size={size} />;
  }

  if (onPress) {
    return (
      <Pressable onPress={onPress} hitSlop={4}>
        {child}
      </Pressable>
    );
  }

  return child;
}

const artStyles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  locked: {
    opacity: 0.35,
  },
});

// Re-export sub-components and types for convenience
export { StampIcon } from './StampIcon.tsx';
export { StampCard } from './StampCard.tsx';
export { StampDetailArtwork } from './StampDetailArtwork.tsx';
export { StampShareCard } from './StampShareCard.tsx';
export type { StampShareVisibility } from './StampShareCard.tsx';
