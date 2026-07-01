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
import React from 'react';
import { Pressable } from 'react-native';
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
  let child: React.ReactElement;

  if (size < 56) {
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

// Re-export sub-components and types for convenience
export { StampIcon } from './StampIcon';
export { StampCard } from './StampCard';
export { StampDetailArtwork } from './StampDetailArtwork';
export { StampShareCard } from './StampShareCard';
export type { StampShareVisibility } from './StampShareCard';
