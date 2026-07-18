/**
 * useLazyVideo — defers video playback until the item is visible.
 *
 * On native: pass `viewable` in from the parent FlatList's
 * `onViewableItemsChanged` callback (item is visible → true).
 *
 * On web: uses IntersectionObserver via a ref callback. Call `setRef` on the
 * outermost container View of the video item. Falls back to a simple boolean
 * prop if IntersectionObserver is not available.
 *
 * Returns `{ shouldPlay, setRef }`.
 *   - shouldPlay: true when the item is considered visible — safe to load/play.
 *   - setRef: ref callback for the container view (web only; no-op on native).
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Platform } from 'react-native';

export interface UseLazyVideoOptions {
  /**
   * Native path: pass the viewable boolean directly from the FlatList's
   * onViewableItemsChanged for this item. Ignored on web.
   */
  viewable?: boolean;
  /**
   * IntersectionObserver threshold (web only). Default: 0.25
   */
  threshold?: number;
}

export interface UseLazyVideoResult {
  shouldPlay: boolean;
  /** Attach to the outermost container view of the video item (web only). */
  setRef: (node: any) => void;
}

export function useLazyVideo(options: UseLazyVideoOptions = {}): UseLazyVideoResult {
  const { viewable, threshold = 0.25 } = options;

  // Native: derive directly from the viewable prop.
  // Web: drive via IntersectionObserver.
  const [webVisible, setWebVisible] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nodeRef = useRef<Element | null>(null);

  const setRef = useCallback(
    (node: any) => {
      if (Platform.OS !== 'web') return;

      // Disconnect previous observer
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (!node) {
        nodeRef.current = null;
        return;
      }

      nodeRef.current = node;

      if (typeof IntersectionObserver === 'undefined') {
        // Fallback: assume visible if IntersectionObserver is unavailable
        setWebVisible(true);
        return;
      }

      observerRef.current = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (entry) {
            setWebVisible(entry.isIntersecting);
          }
        },
        { threshold },
      );

      observerRef.current.observe(node);
    },
    [threshold],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  const shouldPlay =
    Platform.OS === 'web' ? webVisible : (viewable ?? false);

  return { shouldPlay, setRef };
}
