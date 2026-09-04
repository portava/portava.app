/**
 * useTemporalEntities — the §15 Time Machine's data source on the client.
 *
 * The NOW map comes from useMapEntities. When the user scrubs the §15 control to
 * a non-NOW offset, the map must show a DIFFERENT instant, and — critically — it
 * must NOT be the NOW map relabelled (§37: "do not make predictions look like
 * observations"). This hook fetches the real per-offset payload from GET
 * /api/map/projection/temporal (services/mapTemporal): `prediction` objects for
 * a future offset, observed `freshness: 'historical'` places for a past one.
 *
 * It fetches ONLY while the mode is active AND the offset is not NOW — at NOW the
 * screen keeps using useMapEntities, so there is no second request for the
 * present. When idle it clears its payload, so a stale forecast can never linger
 * under NOW or a closed mode.
 *
 * Fail-soft, like the NOW gateway: `enabled: false` (the flag is off) yields no
 * objects and is NOT treated as "no history here" — that distinction is the
 * caller's (see the temporal report fields).
 */
import { useEffect, useState } from 'react';

import type { MapObject } from '../types/mapObjects.ts';
import {
  fetchMapTemporal,
  type TemporalForecastReport,
  type TemporalHistoryReport,
} from '../services/mapTemporal.ts';
import { bboxFromCenter } from '../services/mapProjection.ts';
import { NOW_OFFSET, offsetKey, offsetsEqual, type TimeOffset } from '../features/map/time/timeMachine.ts';

/** Matches useMapEntities' DEFAULT_VIEWPORT_RADIUS_KM, so both viewports agree. */
const DEFAULT_VIEWPORT_RADIUS_KM = 25;

export interface UseTemporalEntitiesArgs {
  lat: number | null;
  lng: number | null;
  zoom?: number;
  radiusKm?: number;
  /** The §15 control position. */
  offset: TimeOffset;
  /** Fetch only while the mode is reachable (the TIME_MACHINE capability). */
  active: boolean;
  /** IANA zone the named offsets resolve in. Omit for device-local. */
  tz?: string;
}

export interface UseTemporalEntitiesResult {
  /** The per-offset objects, or [] while idle / loading / disabled. */
  objects: MapObject[];
  /** Whether the temporal producer answered `enabled` for this session. */
  enabled: boolean;
  /** Forecast counts + accepted_plan refusal — present only for a future offset. */
  forecast: TemporalForecastReport | null;
  /** `available:false` is the honest "no history yet" — present only for a past offset. */
  history: TemporalHistoryReport | null;
  loading: boolean;
}

export function useTemporalEntities(args: UseTemporalEntitiesArgs): UseTemporalEntitiesResult {
  const { lat, lng, zoom = 12, radiusKm = DEFAULT_VIEWPORT_RADIUS_KM, offset, active, tz } = args;

  const [objects, setObjects] = useState<MapObject[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [forecast, setForecast] = useState<TemporalForecastReport | null>(null);
  const [history, setHistory] = useState<TemporalHistoryReport | null>(null);
  const [loading, setLoading] = useState(false);

  const isNow = offsetsEqual(offset, NOW_OFFSET);
  const shouldFetch = active && !isNow && lat != null && lng != null;

  useEffect(() => {
    if (!shouldFetch) {
      // Idle: drop the previous offset's payload so it can never show under NOW
      // or a closed mode.
      setObjects([]);
      setForecast(null);
      setHistory(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);

    fetchMapTemporal({
      bbox: bboxFromCenter(lat as number, lng as number, radiusKm),
      zoom,
      offset,
      tz,
      limit: 200,
      signal: controller.signal,
    })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setEnabled(res.data.enabled);
          setObjects(res.data.enabled ? res.data.objects : []);
          setForecast(res.data.forecast);
          setHistory(res.data.history);
        }
      })
      .catch(() => {
        /* fail-soft: keep the last successful payload cleared, never crash */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `offsetKey(offset)` is the stable identity of the control position; lat/lng
    // are rounded into the same viewport bucket the fetch uses.
  }, [shouldFetch, offsetKey(offset), offset, lat, lng, zoom, radiusKm, tz]);

  return { objects, enabled, forecast, history, loading };
}
