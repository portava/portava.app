/**
 * ActivityZone — §6's "soft filled zone" as a MapLibre layer stack.
 *
 * Renders one `MapObject` of kind `activity_zone`, `social_zone`, `buddy_zone`
 * or `prediction`. It owns NO colours, NO opacities and NO dash patterns: every
 * visual decision comes from `zoneStyleForObject` in
 * src/features/map/render/zoneStyle.ts, which is pure and unit-tested. The map
 * SDK is jest-mocked in this repo, so anything decided here would be untestable
 * — that is why nothing is decided here.
 *
 * §6: zones "should not imply scientifically exact borders". Three layers, in
 * draw order, are what makes that true in pixels:
 *
 *   1. FILL    — a low-opacity wash. Deliberately WITHOUT `fill-outline-color`;
 *                that property draws a 1 px hairline at the exact polygon edge,
 *                which is precisely the false precision §6 forbids.
 *   2. HALO    — a very wide, very blurred line in the fill colour, sitting on
 *                the boundary. This is the soft edge: the fill fades out over
 *                ~12 pt instead of stopping at a line.
 *   3. OUTLINE — a thin, still-blurred, capped-opacity line carrying the §6
 *                boundary VOCABULARY (solid / pulsing / dashed). Never opaque,
 *                never sharp.
 *
 * A `Point` geometry is expanded to a circle rather than dropped: the
 * projection often has a zone centroid and a radius rather than a traced
 * boundary, and a circle is the honest shape for an aggregate anyway.
 *
 * SDK NOTE
 * ========
 * @maplibre/maplibre-react-native 11.3.6 exposes `GeoJSONSource` + a unified
 * `Layer type="fill" | "line" | "symbol"` with style-spec `paint`/`layout`
 * props. It does NOT export `ShapeSource` / `FillLayer` / `LineLayer`. The
 * safe-require pattern below matches every other map component in this repo
 * (see .agents/memory/maplibre-safe-require.md): a static import evaluates
 * TurboModuleRegistry at module load and crashes route registration.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { GeoJSONSource, Layer } = _ml as typeof import('@maplibre/maplibre-react-native');

import { circlePolygon } from '../../features/map/render/collision.ts';
import { isZoneKind, zoneStyleForObject } from '../../features/map/render/zoneStyle.ts';
import type { PulseSpec, ZoneVisualStyle } from '../../features/map/render/zoneStyle.ts';
import { centroidOf, isRenderable } from '../../types/mapObjects.ts';
import type { MapObject, PolygonGeometry } from '../../types/mapObjects.ts';

/**
 * Radius used when a zone arrives as a bare centroid with no radius hint.
 *
 * 300 m is roughly a city block cluster — big enough to read as an area rather
 * than an oversized pin, small enough not to claim a whole neighbourhood.
 */
export const DEFAULT_POINT_ZONE_RADIUS_M = 300;

/**
 * Drive a paint opacity between two values without re-rendering at frame rate.
 *
 * One `setState` per half-period (≈1.2 s), paired with MapLibre's own
 * `*-opacity-transition`, hands the actual interpolation to the GPU. §34: "Keep
 * animation layers GPU-friendly." A JS-driven 60 fps pulse would re-render a
 * paint object 60 times a second per zone on screen.
 */
export function useOpacityPulse(pulse: PulseSpec | null, fallback: number): {
  opacity: number;
  transitionMs: number;
} {
  const [bright, setBright] = useState(true);
  const halfPeriod = pulse ? Math.max(200, Math.round(pulse.periodMs / 2)) : 0;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!pulse) return undefined;
    timer.current = setInterval(() => setBright((b) => !b), halfPeriod);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [pulse, halfPeriod]);

  if (!pulse) return { opacity: fallback, transitionMs: 0 };
  return {
    opacity: bright ? pulse.maxOpacity : pulse.minOpacity,
    transitionMs: halfPeriod,
  };
}

export interface ActivityZoneProps {
  object: MapObject;
  /**
   * Radius for a centroid-only zone, in metres. Ignored when the geometry is
   * already a polygon.
   */
  radiusMetres?: number;
  /** Draw this zone beneath an existing layer id (§5's level ordering). */
  beforeId?: string;
  /** Set false to keep the source mounted but draw nothing (layer toggling). */
  visible?: boolean;
}

/** The polygon this object should be drawn as, or null if it is not a zone. */
export function zonePolygon(
  object: MapObject,
  radiusMetres = DEFAULT_POINT_ZONE_RADIUS_M,
): PolygonGeometry | null {
  const geometry = object.geometry;
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return geometry;
  if (geometry.type === 'Point') {
    const c = centroidOf(geometry);
    return c ? circlePolygon(c.lat, c.lng, radiusMetres) : null;
  }
  // A LineString is a route or a flow, not an area — CrowdFlowLine owns it.
  return null;
}

export function ActivityZone({
  object,
  radiusMetres = DEFAULT_POINT_ZONE_RADIUS_M,
  beforeId,
  visible = true,
}: ActivityZoneProps) {
  const style: ZoneVisualStyle = useMemo(() => zoneStyleForObject(object), [object]);
  const polygon = useMemo(() => zonePolygon(object, radiusMetres), [object, radiusMetres]);

  const pulse = useOpacityPulse(style.outlineStyle === 'pulsing' ? style.pulse : null, style.outlineOpacity);

  const feature = useMemo(
    () =>
      polygon
        ? {
            type: 'Feature' as const,
            id: object.id,
            geometry: polygon,
            // Only aggregate descriptors travel with the feature. Nothing here
            // identifies a person, and the payload is deliberately not copied.
            properties: {
              kind: object.kind,
              activity: object.activity ?? null,
              trend: object.trend ?? null,
              confidence: object.confidence ?? null,
              freshness: object.freshness ?? null,
              isForecast: style.isForecast,
            },
          }
        : null,
    [polygon, object, style.isForecast],
  );

  // The SDK is stubbed under jest and absent in Expo Go; render nothing rather
  // than throwing "Element type is invalid" inside someone else's test.
  if (!GeoJSONSource || !Layer) return null;
  if (!visible || !feature) return null;
  if (!isZoneKind(object.kind) || !isRenderable(object)) return null;

  const sourceId = `zone-src-${object.id}`;

  return (
    <GeoJSONSource id={sourceId} data={feature}>
      {/* 1 — the wash. No fill-outline-color: §6 forbids the hairline. */}
      <Layer
        id={`zone-fill-${object.id}`}
        type="fill"
        beforeId={beforeId}
        paint={{
          'fill-color': style.fillColor,
          'fill-opacity': style.fillOpacity,
          'fill-antialias': true,
        }}
      />
      {/* 2 — the soft edge. A wide blurred line in the fill colour is how a
          fill gets a feathered boundary; the style spec has no `fill-blur`. */}
      <Layer
        id={`zone-halo-${object.id}`}
        type="line"
        paint={{
          'line-color': style.fillColor,
          'line-opacity': style.fillOpacity,
          'line-width': style.fillBlurPx,
          'line-blur': style.fillBlurPx,
        }}
      />
      {/* 3 — the §6 boundary vocabulary. */}
      <Layer
        id={`zone-outline-${object.id}`}
        type="line"
        paint={{
          'line-color': style.outlineColor,
          'line-opacity': pulse.opacity,
          'line-opacity-transition': { duration: pulse.transitionMs, delay: 0 },
          'line-width': style.outlineWidth,
          'line-blur': style.outlineBlurPx,
          ...(style.dashArray ? { 'line-dasharray': [...style.dashArray] } : {}),
        }}
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
      />
    </GeoJSONSource>
  );
}

export interface ActivityZoneLayerProps {
  objects: readonly MapObject[];
  beforeId?: string;
  visible?: boolean;
  radiusMetres?: number;
}

/**
 * Every zone in one pass, drawn quietest-first so a peak zone is never buried
 * under a very-quiet one. Zones do not participate in §31 collision
 * (`participatesInCollision` is false for polygons) — they are Level 2 of §5's
 * hierarchy and are meant to sit under the markers.
 */
export function ActivityZoneLayer({
  objects,
  beforeId,
  visible = true,
  radiusMetres,
}: ActivityZoneLayerProps) {
  const zones = useMemo(
    () =>
      objects
        .filter((o) => isZoneKind(o.kind) && isRenderable(o))
        .sort((a, b) => zoneStyleForObject(a).fillOpacity - zoneStyleForObject(b).fillOpacity),
    [objects],
  );
  if (!visible) return null;
  return (
    <>
      {zones.map((o) => (
        <ActivityZone key={o.id} object={o} beforeId={beforeId} radiusMetres={radiusMetres} />
      ))}
    </>
  );
}
