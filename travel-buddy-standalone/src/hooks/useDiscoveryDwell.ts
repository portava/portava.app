/**
 * useDiscoveryDwell — mounts `04` §7 dwell measurement on one Discovery place
 * surface (census-discovery DV-41, §55). The classifier and the sender are
 * `services/discoveryDwell.ts`; this hook only feeds them the device's real
 * signals and decides WHEN to send.
 *
 * TRACKS ONLY WHEN ALL HOLD
 * =========================
 *   • `discovery_dwell_telemetry_enabled` is on (3395, seeded FALSE);
 *   • the surface is 'discovery' (the Layover card's sheet passes none);
 *   • the served place carried a well-formed `recommendationId`;
 *   • the surface is visible.
 * Otherwise nothing is timed and nothing is sent. Signed-out viewers are
 * stopped at the sender (no token ⇒ nothing sent).
 *
 * WHEN IT SENDS
 * =============
 *   • the app leaves the foreground — what was measured so far is sent AT ONCE,
 *     because a backgrounded app may never run again; the idle time that follows
 *     is measured from then on and sent with the next emission;
 *   • the surface closes, shows another place, or unmounts.
 * Each send is its own emission with its own `client_event_id`.
 */
import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import {
  DISCOVERY_DWELL_FLAG,
  createDwellTracker,
  dwellEmissionFor,
  newClientEventId,
  sendDwellEmission,
  servedExposureId,
  type DwellTracker,
} from '../services/discoveryDwell.ts';

/** A monotonic clock where the runtime has one: a wall-clock step must not become dwell. */
function nowMs(): number {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

export function useDiscoveryDwell({
  surface,
  itemId,
  recommendationId,
  visible,
}: {
  surface: string | null | undefined;
  itemId: string | null | undefined;
  recommendationId: string | null | undefined;
  visible: boolean;
}): { noteInteraction: () => void } {
  const { isEnabled } = useFeatureFlags();
  const enabled = isEnabled(DISCOVERY_DWELL_FLAG);
  const rid = servedExposureId(recommendationId);
  const tracking = enabled && surface === 'discovery' && !!itemId && !!rid && visible;

  const tracker = useRef<DwellTracker | null>(null);
  // The flag as of THIS render. A flag turned off mid-view must stop the final
  // send too, and the cleanup below runs after the render that saw it off.
  const enabledNow = useRef(enabled);
  enabledNow.current = enabled;

  useEffect(() => {
    if (!tracking || !itemId || !rid) return;
    const t = createDwellTracker(nowMs(), { foreground: AppState.currentState === 'active' });
    tracker.current = t;
    const flush = (at: number) => {
      const emission = dwellEmissionFor(itemId, rid, t.drain(at), newClientEventId());
      if (emission) void sendDwellEmission(emission, { enabled: enabledNow.current });
    };
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      const at = nowMs();
      if (state === 'active') {
        t.noteForeground(at);
      } else if (t.foreground) {
        t.noteBackground(at);
        flush(at);                            // backgrounding mid-dwell: send what was measured now
      }
    });
    return () => {
      sub.remove();
      if (tracker.current === t) tracker.current = null;
      flush(nowMs());                         // closed, another place, or unmounted
    };
  }, [tracking, itemId, rid]);

  const noteInteraction = useCallback(() => {
    tracker.current?.noteInteraction(nowMs());
  }, []);

  return { noteInteraction };
}
