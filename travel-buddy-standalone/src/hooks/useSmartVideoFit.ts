/**
 * useSmartVideoFit — TikTok-style adaptive video fitting.
 *
 * Compares the video's natural aspect ratio against the container's:
 *   - Within 20% → COVER  (slight crop, fills frame)
 *   - Beyond 20% → CONTAIN (no crop; caller should layer a VideoBlurBackdrop)
 *
 * Wire `onReadyForDisplay` to <Video onReadyForDisplay={onReadyForDisplay} />.
 */
import { useState, useCallback } from 'react';
import { ResizeMode, type VideoReadyForDisplayEvent } from 'expo-av';

/** Relative gap (bigger/smaller − 1) above which we switch from COVER to CONTAIN. */
const COVER_THRESHOLD = 0.20;

export function useSmartVideoFit(containerW: number, containerH: number) {
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  const onReadyForDisplay = useCallback((event: VideoReadyForDisplayEvent) => {
    // react-native-web does not populate event.naturalSize — guard before destructuring.
    const { width, height } = event?.naturalSize ?? {};
    if (width && height && width > 0 && height > 0) setNaturalSize({ w: width, h: height });
  }, []);

  let needsLetterbox = false;
  if (naturalSize && containerW > 0 && containerH > 0) {
    const videoRatio = naturalSize.w / naturalSize.h;
    const containerRatio = containerW / containerH;
    const bigger = Math.max(containerRatio, videoRatio);
    const smaller = Math.min(containerRatio, videoRatio);
    needsLetterbox = smaller > 0 && (bigger - smaller) / smaller > COVER_THRESHOLD;
  }

  return {
    resizeMode: needsLetterbox ? ResizeMode.CONTAIN : ResizeMode.COVER,
    needsLetterbox,
    onReadyForDisplay,
  };
}
