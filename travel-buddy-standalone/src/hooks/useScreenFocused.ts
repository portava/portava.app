/**
 * useScreenFocused — true while the screen this component sits on is the one
 * in front.
 *
 * A screen pushed on top of another leaves the one underneath MOUNTED, so a
 * video on it kept playing: once videos autoplay with sound (2026-11-04), the
 * post you opened a profile from went on talking under the profile. Players
 * fold this into whether they play.
 *
 * Starts true, so a component rendered outside a navigator (a test, a web
 * render with no screen around it) behaves exactly as before. State is only
 * set when it CHANGES (the ref), so a focus callback run during render — as
 * some component tests' useFocusEffect stand-ins do — never loops.
 */
import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

export function useScreenFocused(): boolean {
  const [focused, setFocused] = useState(true);
  const focusedRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (!focusedRef.current) {
        focusedRef.current = true;
        setFocused(true);
      }
      return () => {
        focusedRef.current = false;
        setFocused(false);
      };
    }, []),
  );
  return focused;
}
