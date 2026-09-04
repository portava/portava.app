/**
 * useReducedMotionSetting — the OS "reduce motion" accessibility setting (§36).
 *
 * Reads AccessibilityInfo and subscribes to changes, so a Wall surface can honor
 * "Autoplay respects reduced motion and user settings" (spec §36) and fall back
 * to a still poster instead of autoplaying video. Deliberately built on
 * `AccessibilityInfo` (not reanimated's `useReducedMotion`) so it needs no
 * animation runtime and is trivially spy-able in component tests — matching the
 * existing pattern in components/StampCard.tsx.
 *
 * Fail-soft: any read/subscription error leaves the value at its safe default of
 * `false` (motion allowed); the renderer treats `true` as "prefer no motion".
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReducedMotionSetting(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => {
        // Best-effort — an unreadable setting stays at the safe default (false).
      });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      sub?.remove?.();
    };
  }, []);

  return reduceMotion;
}
