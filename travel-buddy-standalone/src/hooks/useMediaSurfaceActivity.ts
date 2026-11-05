import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { NavigationContext } from '@react-navigation/native';

/** Optional navigation ownership: embedded/standalone previews need no navigator.
 * Retire synchronously on blur/background so a late native promise cannot open
 * private media while the covered screen remains mounted. Each retirement also
 * invalidates callbacks across a blur/refocus cycle batched into one render. */
export function useMediaSurfaceActivity(onInactive: () => void) {
  const navigation = useContext(NavigationContext);
  const nav = useRef(navigation);
  nav.current = navigation;
  const retire = useRef(onInactive);
  retire.current = onInactive;
  // Before the native bridge supplies a state, preserve the visible preview;
  // a known inactive/background state always withholds the decoder.
  const foreground = useRef(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [state, setState] = useState(() => ({ active: foreground.current && (navigation?.isFocused() ?? true), epoch: 0 }));
  const current = useRef(state);

  useEffect(() => {
    let mounted = true;
    const update = () => {
      if (!mounted) return;
      const active = foreground.current && (navigation?.isFocused() ?? true);
      if (active === current.current.active) return;
      const next = { active, epoch: current.current.epoch + (active ? 0 : 1) };
      current.current = next;
      if (!active) retire.current();
      setState(next);
    };
    const focus = navigation?.addListener('focus', update);
    const blur = navigation?.addListener('blur', update);
    const appState = AppState.addEventListener('change', value => { foreground.current = value === 'active'; update(); });
    update();
    return () => { mounted = false; focus?.(); blur?.(); appState.remove(); };
  }, [navigation]);

  const isCurrent = useCallback(() => current.current.active && current.current.epoch === state.epoch
    && (nav.current?.isFocused() ?? true), [state.epoch]);
  return { ...state, isCurrent };
}
