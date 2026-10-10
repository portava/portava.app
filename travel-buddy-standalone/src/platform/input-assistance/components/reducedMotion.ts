/**
 * §46/§49 reduced motion for the input-assistance layer (census G351).
 *
 * The layer animates exactly two things: the `DisambiguationSheet` and the
 * `PasteReviewSheet` Modals slide up. Nothing else in the layer uses an
 * animation primitive, and `components/__tests__/reducedMotion.component.test.tsx`
 * pins that, so this one hook is the whole of the layer's motion policy.
 *
 * It reads the OS "reduce motion" setting through `AccessibilityInfo` and
 * follows changes while mounted, the pattern `features/wall/hooks/useReducedMotionSetting.ts`
 * and `components/StampCard.tsx` already use. It is not imported from the Wall
 * feature, because a platform layer that depended on a feature would invert the
 * layering.
 *
 * An unreadable setting leaves the value at `false`, which is the platform's own
 * default (motion allowed). Reduced motion is an accessibility preference, not a
 * privacy gate, so there is nothing to fail closed TO.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduce(enabled === true);
      })
      .catch(() => {
        // Best-effort: an unreadable setting stays at the platform default.
      });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled: boolean) => {
      if (mounted) setReduce(enabled === true);
    });
    return () => {
      mounted = false;
      sub?.remove?.();
    };
  }, []);
  return reduce;
}
