/**
 * useScreenTiming — lightweight dev-only screen performance instrumentation.
 *
 * Usage in screens:
 *   const { markFirstContent, epoch } = useScreenTiming('Pulse');
 *
 *   // Add epoch to the useEffect dep array so the effect re-fires on every
 *   // focus cycle — including warm opens where the data boolean hasn't changed.
 *   useEffect(() => {
 *     if (items.length > 0) markFirstContent();
 *   }, [epoch, items.length > 0]);
 *
 * In dev builds it logs to the console:
 *   [PerfTiming] <screen> cold=Xms   (first open since component mount)
 *   [PerfTiming] <screen> warm=Xms   (subsequent focus cycles)
 *
 * In production the callbacks are no-ops and tree-shake cleanly.
 *
 * `epoch` increments by 1 on every focus event. Screens use it as a
 * useEffect dependency so the effect re-evaluates even when the data
 * booleans in their dep array have not changed (warm re-open with
 * already-loaded data).
 */
import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

export function useScreenTiming(screenName: string): {
  markFirstContent: () => void;
  /** Increments on every focus event — use as a useEffect dep so warm
   *  opens re-evaluate the content-ready condition even without data changes. */
  epoch: number;
} {
  // All hooks are called unconditionally; __DEV__ guard is inside callbacks.
  const focusedAt = useRef<number>(0);
  const hasMounted = useRef(false);
  const marked = useRef(false);
  const [epoch, setEpoch] = useState(0);

  useFocusEffect(
    useCallback(() => {
      if (!__DEV__) return;
      focusedAt.current = Date.now();
      marked.current = false;          // reset so each focus cycle gets its own log
      setEpoch((e) => e + 1);          // drive dependent useEffects in the screen
    }, []),
  );

  const markFirstContent = useCallback(() => {
    if (!__DEV__) return;
    if (marked.current) return;        // only fire once per focus cycle
    marked.current = true;
    const elapsed = Date.now() - focusedAt.current;
    const label = hasMounted.current ? 'warm' : 'cold';
    hasMounted.current = true;
    // eslint-disable-next-line no-console
    console.log(`[PerfTiming] ${screenName} ${label}=${elapsed}ms`);
  }, [screenName]);

  return { markFirstContent, epoch };
}
