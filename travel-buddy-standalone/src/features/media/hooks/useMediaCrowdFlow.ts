/**
 * useMediaCrowdFlow — drives "WHERE THE NIGHT IS MOVING" for the NOW lens
 * (spec §22; census-media MD162 §51).
 *
 * Wires the real reads into `services/mediaCrowdFlow.loadNightFlowCards`:
 * the canonical Map gateway asked only for `crowd_flow`, in the Media Map's own
 * city-scale viewport, then `GET /media/map` from the network. Cancels in
 * flight on unmount and on a new location, city or refresh key; never throws.
 *
 * A shown flow is dropped when it stops being current (its `expiresAt`, or the
 * end of the `recent` freshness bucket): one timer re-evaluates the list at the
 * soonest expiry, so a card left open does not keep presenting a stale flow as
 * where the night is moving (§37).
 */
import { useEffect, useMemo, useState } from 'react';
import { bboxFromCenter, fetchMapProjection } from '../../../services/mapProjection.ts';
import { fetchMediaMap } from '../services/mediaProjection.ts';
import { MEDIA_MAP_RADIUS_KM, MEDIA_MAP_ZOOM } from './useMediaMap.ts';
import {
  loadNightFlowCards,
  NIGHT_FLOW_KINDS,
  NIGHT_FLOW_PAGE_LIMIT,
  type NightFlowSources,
} from '../services/mediaCrowdFlow.ts';
import { liveNightFlowCards, type NightFlowCardModel } from '../state/crowdFlowPairing.ts';

export const NIGHT_FLOW_SOURCES: NightFlowSources = {
  readFlows: async ({ center, signal }) => {
    const r = await fetchMapProjection({
      bbox: bboxFromCenter(center.lat, center.lng, MEDIA_MAP_RADIUS_KM),
      zoom: MEDIA_MAP_ZOOM,
      kinds: [...NIGHT_FLOW_KINDS],
      limit: NIGHT_FLOW_PAGE_LIMIT,
      signal,
    });
    return r.ok ? { ok: true, enabled: r.data.enabled, sources: r.data.sources, objects: r.data.objects } : { ok: false };
  },
  readClusters: async ({ city, signal }) => {
    const r = await fetchMediaMap({ city, signal });
    return r.ok && r.data ? { ok: true, clusters: r.data.clusters } : { ok: false };
  },
};

export interface UseMediaCrowdFlowOptions {
  center: { lat: number; lng: number } | null;
  city: string | null;
  /** Re-read when this changes (the World dashboard's own `generatedAt`). */
  refreshKey?: string | null;
}

export function useMediaCrowdFlow({ center, city, refreshKey = null }: UseMediaCrowdFlowOptions): NightFlowCardModel[] {
  const [cards, setCards] = useState<NightFlowCardModel[]>([]);
  const [clock, setClock] = useState(() => Date.now());
  const lat = center?.lat ?? null;
  const lng = center?.lng ?? null;

  useEffect(() => {
    setCards([]);
    if (lat == null || lng == null) return undefined;
    const controller = new AbortController();
    void loadNightFlowCards(
      { center: { lat, lng }, city, nowMs: Date.now(), signal: controller.signal },
      NIGHT_FLOW_SOURCES,
    ).then((next) => {
      if (controller.signal.aborted) return;
      setClock(Date.now());
      setCards(next);
    });
    return () => controller.abort();
  }, [lat, lng, city, refreshKey]);

  const live = useMemo(() => liveNightFlowCards(cards, clock), [cards, clock]);

  useEffect(() => {
    if (live.length === 0) return undefined;
    const soonest = Math.min(...live.map((c) => c.liveUntilMs));
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, soonest - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [live]);

  return live;
}
