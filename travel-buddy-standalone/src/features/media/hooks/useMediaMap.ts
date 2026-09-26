/**
 * useMediaMap — drives `state/mediaMapStore` for one Media Map surface
 * (spec §21 / §40; census-media §19).
 *
 * TWO READS, NEITHER OF WHICH OWNS GEOMETRY ON MEDIA'S BEHALF:
 *   1. the cluster source — `GET /media/map` for the world, or the owner's own
 *      My World media grouped by canonical place (`clustersFromOwnMedia`);
 *   2. the canonical Map gateway, `GET /map/projection`, for the viewer's
 *      coarse viewport, asking only for `place` (and, when gems are drawn,
 *      `hidden_gem`) objects.
 *
 * With no viewer location there is no viewport, so the gateway is NOT called
 * and the reducer records `no_location` — the list still renders, nothing is
 * placed. Cancels in flight on unmount / reload; never throws.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { fetchMapProjection, bboxFromCenter } from '../../../services/mapProjection.ts';
import type { MapObjectKind } from '../../../types/mapObjects.ts';
import type { ProjectionResult } from '../types/media.ts';
import {
  INITIAL_MEDIA_MAP_STATE,
  mediaMapReducer,
  type MapPositionsResult,
  type MediaMapCluster,
  type MediaMapLayer,
  type MediaMapState,
} from '../state/mediaMapStore.ts';

/** City scale: the viewport the Media Map positions clusters inside. */
export const MEDIA_MAP_RADIUS_KM = 10;
export const MEDIA_MAP_ZOOM = 12;

export interface UseMediaMapOptions {
  /** Loads the clusters to position (world counts, or the owner's own). */
  loadClusters: (opts: { signal: AbortSignal }) => Promise<ProjectionResult<MediaMapCluster[]>>;
  /** The viewer's COARSE location — the viewport centre. Null ⇒ nothing is positioned. */
  center: { lat: number; lng: number } | null;
  /** Ask the canonical Map for `hidden_gem` objects too (§46.1 zones). */
  includeGems?: boolean;
  /** Re-load when any of these change. */
  deps?: readonly unknown[];
}

export interface UseMediaMapResult {
  state: MediaMapState;
  reload: () => void;
  selectCluster: (placeId: string | null) => void;
  toggleLayer: (layer: MediaMapLayer) => void;
}

export function useMediaMap({ loadClusters, center, includeGems = false, deps = [] }: UseMediaMapOptions): UseMediaMapResult {
  const [state, dispatch] = useReducer(mediaMapReducer, INITIAL_MEDIA_MAP_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const loadRef = useRef(loadClusters);
  loadRef.current = loadClusters;

  const lat = center?.lat ?? null;
  const lng = center?.lng ?? null;

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: 'load_start' });

    const kinds: MapObjectKind[] = includeGems ? ['place', 'hidden_gem'] : ['place'];
    const positionsPromise: Promise<MapPositionsResult> =
      lat == null || lng == null
        ? Promise.resolve({ ok: false, reason: 'no_location' })
        : fetchMapProjection({
            bbox: bboxFromCenter(lat, lng, MEDIA_MAP_RADIUS_KM),
            zoom: MEDIA_MAP_ZOOM,
            kinds,
            limit: 200,
            signal: controller.signal,
          }).then(
            (r): MapPositionsResult =>
              r.ok ? { ok: true, enabled: r.data.enabled, objects: r.data.objects } : { ok: false, reason: 'map_failed' },
          );

    void Promise.all([
      loadRef.current({ signal: controller.signal }),
      positionsPromise.catch((): MapPositionsResult => ({ ok: false, reason: 'map_failed' })),
    ]).then(([clusters, positions]) => {
      if (controller.signal.aborted) return;
      dispatch({ type: 'load_result', clusters, positions, expectGems: includeGems });
    });
  }, [lat, lng, includeGems]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  const selectCluster = useCallback((placeId: string | null) => dispatch({ type: 'select_cluster', placeId }), []);
  const toggleLayer = useCallback((layer: MediaMapLayer) => dispatch({ type: 'toggle_layer', layer }), []);

  return { state, reload: load, selectCluster, toggleLayer };
}
