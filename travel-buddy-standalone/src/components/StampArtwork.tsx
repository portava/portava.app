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
 */
import React, { useState } from 'react';
import { Pressable, Image, View, StyleSheet } from 'react-native';
import type { PassportStamp } from '../types/models';
import { StampIcon } from './StampIcon';
import { StampCard } from './StampCard';
import { StampDetailArtwork } from './StampDetailArtwork';

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
    // AI-generated universal artwork — render the image; fall back to the
    // procedural design if the image fails to load.
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
          resizeMode="cover"
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
export { StampIcon } from './StampIcon';
export { StampCard } from './StampCard';
export { StampDetailArtwork } from './StampDetailArtwork';
export { StampShareCard } from './StampShareCard';
export type { StampShareVisibility } from './StampShareCard';
