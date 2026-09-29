/**
 * Telegraph — catch a conversation up when the device comes back.
 *
 * WHAT "SYNC ON RECONNECT" MEANS HERE, AND WHAT IT DOES NOT
 * =========================================================
 * A member who was offline, or had the app in the background, has missed
 * whatever was said meanwhile. The realtime stream does not replay a gap into a
 * screen that was not listening, so the screen has to ask again. This hook
 * decides WHEN: on the two transitions that mean "we were away and are back" —
 *
 *   - the realtime stream re-opens after it had been open and then dropped
 *     (network loss, server-side close, a token refresh), and
 *   - the app returns to the foreground from background/inactive.
 *
 * The catch-up itself is an ordinary message read, which the server
 * re-authorizes: membership (`left_at`), blocks and the §14.3 history window are
 * applied again on every call, so a member removed while away is refused, not
 * served.
 *
 * It deliberately does NOT call `POST /api/trips/:id/chat/sync` or its circle
 * twin. Those are OWNER-ONLY membership-repair endpoints (routes/groupChat.ts):
 * every non-owner gets a 403, and `GET /api/trips/:id/chat` already re-syncs
 * accepted members into the thread on every open. Firing a repair call on each
 * reconnect would be a stream of refusals for everyone but the owner and a
 * write for the owner that nothing needed.
 */
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { telegraphRealtime, type RealtimeStatus } from '../../../services/telegraphRealtimeService.ts';

/**
 * The pure half: feed it realtime statuses, it answers `true` exactly when a
 * status means "the stream came back after it had been up and went away".
 * The FIRST open is not a reconnect — the screen's own initial load covers it.
 */
export function createReconnectDetector(): (status: RealtimeStatus) => boolean {
  let everOpen = false;
  let dropped = false;
  return (status) => {
    if (status === 'open') {
      const reconnected = everOpen && dropped;
      everOpen = true;
      dropped = false;
      return reconnected;
    }
    if (everOpen) dropped = true;
    return false;
  };
}

/** Foreground transition: anything that was not `active` becoming `active`. */
export function isForegroundReturn(prev: AppStateStatus, next: AppStateStatus): boolean {
  return prev !== 'active' && next === 'active';
}

export function useReconnectCatchUp(onReconnect: () => void, enabled = true): void {
  const cb = useRef(onReconnect);
  cb.current = onReconnect;

  useEffect(() => {
    if (!enabled) return;
    const detect = createReconnectDetector();
    const unsubStatus = telegraphRealtime.onStatus((s) => {
      if (detect(s)) cb.current();
    });
    let app: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = app;
      app = next;
      if (isForegroundReturn(prev, next)) cb.current();
    });
    return () => {
      unsubStatus();
      // Optional-chained because a test renderer's AppState stub may hand back
      // no subscription; a cleanup that throws would take the screen with it.
      sub?.remove?.();
    };
  }, [enabled]);
}
