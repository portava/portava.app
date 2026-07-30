/**
 * LayoverSessionContext — single fetch of the active layover session per
 * Pulse tab focus, shared to all consumers on the screen.
 *
 * Wrapping the Pulse screen with <LayoverSessionProvider> means
 * `ActiveLayoverPill` and `useLayoverAwareBottomInset` both read from the same
 * state instead of each firing their own `getActiveLayoverSession` call on
 * every focus event.
 */
import React, { createContext, useCallback, useContext, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  getActiveLayoverSession,
  type LayoverSession,
  type PublicAirport,
} from '../services/layover.ts';

export interface LayoverSessionState {
  session: LayoverSession | null;
  airport: PublicAirport | undefined;
  /** True during the initial fetch on each focus; false once the promise settles. */
  loading: boolean;
}

const DEFAULT_STATE: LayoverSessionState = {
  session: null,
  airport: undefined,
  loading: true,
};

const LayoverSessionContext = createContext<LayoverSessionState>(DEFAULT_STATE);

/**
 * Place this provider at the Pulse screen root (wrapping the component that
 * renders both <ActiveLayoverPill> and calls useLayoverAwareBottomInset).
 */
export function LayoverSessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LayoverSessionState>(DEFAULT_STATE);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      // No synchronous setState here: calling setState inside a synchronously-
      // invoked useFocusEffect (as test stubs do) creates an infinite
      // setState → re-render → effect → setState loop. The initial `loading:
      // true` set by useState is sufficient for the first-mount case.
      getActiveLayoverSession()
        .then((res) => {
          if (!alive) return;
          const newSession = res?.session ?? null;
          const newAirport = res?.airport;
          // Use a functional updater that returns the previous state object when
          // nothing has changed. This gives React an identical reference so it
          // bails out rather than scheduling another re-render — which is critical
          // when useFocusEffect fires on every render (e.g. synchronous test stub).
          setState((prev) => {
            if (
              prev.session === newSession &&
              prev.airport === newAirport &&
              prev.loading === false
            ) {
              return prev;
            }
            return { session: newSession, airport: newAirport, loading: false };
          });
        })
        .catch(() => {
          if (alive) setState((prev) => {
            if (prev.session === null && prev.airport === undefined && prev.loading === false) {
              return prev;
            }
            return { session: null, airport: undefined, loading: false };
          });
        });
      return () => { alive = false; };
    }, []),
  );

  return (
    <LayoverSessionContext.Provider value={state}>
      {children}
    </LayoverSessionContext.Provider>
  );
}

/** Read the shared layover session fetched by the nearest LayoverSessionProvider. */
export function useLayoverSessionContext(): LayoverSessionState {
  return useContext(LayoverSessionContext);
}
