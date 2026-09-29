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
 * the default costs one small request. This hook renders nothing and claims
 * nothing, but a failed or partial check is never recorded as a clean one: the
 * wait after it is SENSE_RETRY_MIN_INTERVAL_MS, not the full throttle (§32).
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { runSenseCheck, senseCheckIsClean } from './senseNudges.ts';

export const SENSE_FOREGROUND_MIN_INTERVAL_MS = 10 * 60_000;
export const SENSE_MOVE_MIN_INTERVAL_MS = 2 * 60_000;

/** A coarse key for "has the traveller moved": ~1 km cells when coordinates exist, else the city. */
export function senseLocationKey(loc: { coords?: { lat: number; lng: number } | null; place?: { city?: string | null } | null } | null | undefined): string | null {
  if (!loc) return null;
  if (loc.coords && Number.isFinite(loc.coords.lat) && Number.isFinite(loc.coords.lng)) {
    return `${loc.coords.lat.toFixed(2)},${loc.coords.lng.toFixed(2)}`;
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
  // Whether the LAST check read every source. The throttle below exists so a
  // clean answer is not asked for again too soon; a partial or failed check is
  // not that answer, so after one the next trigger may ask again within a minute.
  const lastClean = useRef(true);

  const ask = useRef((minInterval: number) => {});
  ask.current = (minInterval: number) => {
    if (!enabled || inFlight.current) return;
    const t = now();
    const wait = lastClean.current ? minInterval : Math.min(minInterval, SENSE_RETRY_MIN_INTERVAL_MS);
    if (lastAt.current !== null && t - lastAt.current < wait) return;
    lastAt.current = t;
    inFlight.current = true;
    void run()
      .then((r) => { lastClean.current = senseCheckIsClean(r); }, () => { lastClean.current = false; })
      .finally(() => { inFlight.current = false; });
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

/** After a failed or partial check, the next trigger may ask again this soon (not the full throttle). */
export const SENSE_RETRY_MIN_INTERVAL_MS = 60_000;
