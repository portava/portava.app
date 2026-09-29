/**
 * TM-live (WP-11) COMP-F11 — who asks Compass Sense to look.
 *
 * `POST /compass/sense/check` is the ONLY caller of the server's runSense: no
 * scheduler runs it. Before this hook nothing in the app called it, so a
 * traveller who turned Sense on never received a nudge. The server reads the
 * traveller's own signals (saved events, route plans, today's plans, circle
 * meetups, free time) and enforces every gate — presence level, category
 * permission, quiet hours, dedupe, the daily cap — so the client decides only
 * WHEN to ask:
 *
 *   - when the signed-in tabs mount,
 *   - when the app returns to the foreground (at most every 10 minutes),
 *   - when the device's resolved location moves to another ~1 km cell or city
 *     (at most every 2 minutes) — the "move to a place" step of the flow.
 *
 * A check with Sense on Passive evaluates and sends nothing (server rule), so
 * the default costs one small request. Failures are silent HERE on purpose:
 * this hook renders nothing and claims nothing; the Sense panel in Compass
 * preferences is where a check's result, or its failure, is shown.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { runSenseCheck } from './senseNudges.ts';

export const SENSE_FOREGROUND_MIN_INTERVAL_MS = 10 * 60_000;
export const SENSE_MOVE_MIN_INTERVAL_MS = 2 * 60_000;

/** A coarse key for "has the traveller moved": ~1 km cells when coordinates exist, else the city. */
export function senseLocationKey(loc: { coords?: { latitude: number; longitude: number } | null; place?: { city?: string | null } | null } | null | undefined): string | null {
  if (!loc) return null;
  if (loc.coords && Number.isFinite(loc.coords.latitude) && Number.isFinite(loc.coords.longitude)) {
    return `${loc.coords.latitude.toFixed(2)},${loc.coords.longitude.toFixed(2)}`;
  }
  return loc.place?.city ? `city:${loc.place.city}` : null;
}

export function useSenseAutoCheck(opts: {
  enabled: boolean;
  locationKey: string | null;
  /** Test seams. */
  run?: typeof runSenseCheck;
  now?: () => number;
}): void {
  const { enabled, locationKey } = opts;
  const run = opts.run ?? runSenseCheck;
  const now = opts.now ?? Date.now;
  const lastAt = useRef<number | null>(null);
  const inFlight = useRef(false);
  const lastKey = useRef<string | null>(null);

  const ask = useRef((minInterval: number) => {});
  ask.current = (minInterval: number) => {
    if (!enabled || inFlight.current) return;
    const t = now();
    if (lastAt.current !== null && t - lastAt.current < minInterval) return;
    lastAt.current = t;
    inFlight.current = true;
    void run().catch(() => undefined).finally(() => { inFlight.current = false; });
  };

  // Mount / sign-in.
  useEffect(() => { if (enabled) ask.current(SENSE_FOREGROUND_MIN_INTERVAL_MS); }, [enabled]);

  // Moving: a new cell or city.
  useEffect(() => {
    if (!enabled || !locationKey) return;
    if (lastKey.current !== null && lastKey.current !== locationKey) ask.current(SENSE_MOVE_MIN_INTERVAL_MS);
    lastKey.current = locationKey;
  }, [enabled, locationKey]);

  // Foreground.
  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') ask.current(SENSE_FOREGROUND_MIN_INTERVAL_MS); });
    return () => sub.remove();
  }, [enabled]);
}
