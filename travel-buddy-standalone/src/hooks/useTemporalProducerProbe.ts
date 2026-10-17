/**
 * useTemporalProducerProbe — ask the §15 producer, ONCE per map session,
 * whether it is reachable for this viewer.
 *
 * ## Why this hook exists at all
 *
 * census-map M223's criterion is the temporal route's OWN answer: with
 * `enabled: true` the TIME_MACHINE mode is enterable, with the refusal
 * envelope it is not. The screen did not have that answer. It used a proxy —
 * `entitiesSource !== 'legacy'`, i.e. "the NOW gateway answered" — reasoning
 * that the temporal route rides the same `map_projection_enabled` flag, so one
 * implies the other.
 *
 * The proxy is defensible and it is still not the criterion. Rewording M223 to
 * describe the proxy would be redefining a requirement to make it pass, so the
 * screen asks the producer instead.
 *
 * ## Why it cannot be `useTemporalEntities`
 *
 * That hook fetches only while the mode is ACTIVE and the offset is not NOW —
 * deliberately, so the present is never fetched twice and a stale forecast
 * cannot linger under NOW. Both conditions are downstream of the very
 * capability M223 is about: at NOW it never fetches, so it can never answer
 * whether the mode should open. Feeding its result into the gate would close
 * Time Machine at NOW, which is a regression with a passing test behind it.
 *
 * So this is a separate, one-shot request whose only purpose is the `enabled`
 * field.
 *
 * ## Cost, and how it is kept small
 *
 * One request per enabled interval, fired as soon as a position is known.
 * A ref latches it, so a moving camera neither cancels nor repeats the probe.
 * `limit: 1` and a viewport a few hundred metres across keep the body near
 * empty; the flag check on the server answers before any of the producers run,
 * which is the case this is actually asking about.
 *
 * ## Failing closed
 *
 * `null` while the probe is in flight, and `temporalProducerReachable(null)`
 * is false, so the control appears when the producer has said yes and not
 * before. A network error, an auth failure and an unconfigured backend all
 * resolve to a probe that does not report `enabled: true`, which is the same
 * answer — the mode stays shut rather than opening on an unestablished result.
 */
import { useEffect, useRef, useState } from 'react';

import { fetchMapTemporal } from '../services/mapTemporal.ts';
import { bboxFromCenter } from '../services/mapProjection.ts';
import { type TimeOffset } from '../features/map/time/timeMachine.ts';

/**
 * A future offset, because the route parses the target BEFORE it serves and
 * refuses a request it cannot resolve to an instant. Thirty minutes is the
 * first stop on §15's own control, so the probe asks a question the product
 * actually asks rather than a synthetic one.
 */
const PROBE_OFFSET: TimeOffset = { kind: 'relative', minutes: 30 };

/** Small enough that the producers have almost nothing to do if they do run. */
const PROBE_RADIUS_KM = 0.5;

export interface UseTemporalProducerProbeArgs {
  lat: number | null;
  lng: number | null;
  /** IANA zone the named offsets resolve in. Omit for device-local. */
  tz?: string;
  /** Set false to suppress the probe entirely (e.g. a non-map mode). */
  enabled?: boolean;
}

/** The shape `temporalProducerReachable` consumes. `null` means "not yet". */
export type TemporalProducerProbe =
  | { ok: boolean; data?: { enabled?: boolean } | null }
  | null;

export function useTemporalProducerProbe(
  args: UseTemporalProducerProbeArgs,
): TemporalProducerProbe {
  const { lat, lng, tz, enabled = true } = args;
  const [probe, setProbe] = useState<TemporalProducerProbe>(null);
  const requestRef = useRef<{ controller: AbortController } | null>(null);

  useEffect(() => {
    setProbe(null);
    return () => {
      requestRef.current?.controller.abort();
      requestRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (requestRef.current) return;
    if (lat == null || lng == null) return;

    const request = { controller: new AbortController() };
    requestRef.current = request;
    void (async () => {
      try {
        const result = await fetchMapTemporal({
          bbox: bboxFromCenter(lat, lng, PROBE_RADIUS_KM),
          zoom: 12,
          offset: PROBE_OFFSET,
          tz,
          limit: 1,
          signal: request.controller.signal,
        });
        if (requestRef.current === request) setProbe(result);
      } catch {
        if (requestRef.current === request) setProbe({ ok: false });
      }
    })();
  }, [enabled, lat, lng, tz]);

  return enabled ? probe : null;
}
