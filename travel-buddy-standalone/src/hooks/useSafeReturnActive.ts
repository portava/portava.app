/**
 * useSafeReturnActive — is the traveler currently in an active Safe Return /
 * emergency state?
 *
 * The Intelligence Gathering spec requires that NO capture prompt is shown while
 * Safe Return / emergency suppression is active. There is no global Safe Return
 * store in the app; components read it ad hoc via `getActiveSession()`. This hook
 * centralises that read for the capture surfaces: it fetches on mount and again
 * whenever the app returns to the foreground, and returns `true` only when a
 * session exists and is in the live ('active') or escalated ('missed') state.
 *
 * FAIL-SAFE: while the first fetch is in flight `active` is `false` (we do not
 * block prompts on a slow network); a throw leaves `active` at its last known
 * value. Callers that must be conservative can gate on `loading` too.
 *
 * INERT WHEN OFF: pass `enabled = false` and the hook makes NO network call and
 * always reports `active = false`. Callers gate this on the intel flags so that,
 * with capture off, mounting a place page never touches the Safe Return API.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { getActiveSession } from '../services/safeReturn.ts';

export interface SafeReturnActive {
  active: boolean;
  loading: boolean;
  refresh: () => void;
}

export function useSafeReturnActive(enabled: boolean = true): SafeReturnActive {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    getActiveSession()
      .then((r) => {
        if (!mounted.current) return;
        const s = r.session;
        setActive(!!s && (s.status === 'active' || s.status === 'missed'));
      })
      .catch(() => {
        /* keep last known value */
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, [enabled]);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) {
      // Inert: never call the API, and report "not in emergency".
      setActive(false);
      setLoading(false);
      return () => {
        mounted.current = false;
      };
    }
    refresh();
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') refresh();
    });
    return () => {
      mounted.current = false;
      sub.remove();
    };
  }, [enabled, refresh]);

  return { active, loading, refresh };
}
