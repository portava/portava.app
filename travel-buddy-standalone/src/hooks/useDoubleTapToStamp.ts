/**
 * useDoubleTapToStamp — Instagram-style double-tap-to-like disambiguation.
 *
 * Wraps a single `onPress` handler on a Pressable so that:
 *  - A single tap fires `onSingleTap` after a short delay (so it can be
 *    cancelled if a second tap arrives in time).
 *  - Two taps within the window fire `onDoubleTap` instead, and the single
 *    tap's action (e.g. navigation) is suppressed entirely.
 *
 * This intentionally does NOT use a gesture-handler TapGestureHandler
 * because the surface already has a `Pressable` driving navigation +
 * press-opacity feedback; adding a GestureDetector on top of that Pressable
 * causes the two gesture systems to fight over the same touch stream. Plain
 * timestamp-based tap counting composes cleanly with the existing Pressable.
 */
import { useCallback, useRef } from 'react';

const DOUBLE_TAP_WINDOW_MS = 260;

export function useDoubleTapToStamp(onSingleTap: () => void, onDoubleTap: () => void) {
  const lastTapAtRef = useRef(0);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePress = useCallback(() => {
    const now = Date.now();
    const sinceLastTap = now - lastTapAtRef.current;

    if (sinceLastTap < DOUBLE_TAP_WINDOW_MS) {
      // Second tap arrived in time — cancel the pending single-tap action
      // and treat this as a double-tap.
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      lastTapAtRef.current = 0;
      onDoubleTap();
      return;
    }

    lastTapAtRef.current = now;
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      onSingleTap();
    }, DOUBLE_TAP_WINDOW_MS);
  }, [onSingleTap, onDoubleTap]);

  return handlePress;
}
