/**
 * useInViewAutoplay — drives muted looping autoplay for a single grid video tile.
 *
 * When `isVisible` flips true the video starts playing; when false it pauses.
 * The caller is responsible for mounting the Video component with
 * `isMuted={true}` and `isLooping={true}`.
 */

import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { Video } from 'expo-av';

export function useInViewAutoplay(
  ref: RefObject<InstanceType<typeof Video> | null>,
  isVisible: boolean,
): void {
  useEffect(() => {
    if (isVisible) {
      ref.current?.playAsync().catch(() => {});
    } else {
      ref.current?.pauseAsync().catch(() => {});
    }
  }, [isVisible, ref]);
}
