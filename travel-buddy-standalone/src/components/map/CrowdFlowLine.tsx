/**
 * CrowdFlowLine — §6's "directional arrows" for §10's Crowd Flow mode.
 *
 * §10 IS THE SPECIFICATION OF THIS FILE
 * =====================================
 * "Crowd Flow shows aggregate movement between places or zones. It must never
 *  expose individual routes or imply that Portava is continuously tracking
 *  specific people."
 *
 * Three things enforce that here, and none of them is a comment:
 *
 *   1. THE PROP TYPE. `AggregateFlowObject` types `payload` as `never`, so a
 *      `MapObject` carrying a source row — a traveler, a session, a device —
 *      does not type-check as a prop to this component. There is no field on
 *      this component's input through which per-person data can arrive.
 *   2. THE COHORT FLOOR. Below `MIN_FLOW_COHORT` distinct contributors the
 *      component renders NOTHING. A line drawn from two people's transitions is
 *      those two people's route, whatever it is labelled.
 *   3. THE PRIVACY CLASS GATE. The geometry must already sit on §23's
 *      `aggregate_only` rung. A flow whose geometry was never reduced is
 *      refused rather than rendered, because the renderer cannot un-sharpen it
 *      (§18: "Nothing downstream of the projection may ever SHARPEN it").
 *
 * "Observed movement and inferred cause must be separately represented." This
 * component draws ONLY observed movement. It has no cause prop and no cause
 * layer; the inferred half is `inferredCauseStyle()` in zoneStyle.ts, rendered
 * by a separate annotation, and the two vocabularies cannot be confused —
 * observed flow can never be dashed, inferred cause is always dashed.
 *
 * SDK NOTE
 * ========
 * @maplibre/maplibre-react-native 11.3.6 exposes `GeoJSONSource` + a unified
 * `Layer type="line" | "symbol"` (symbol placement `line` is what puts arrows
 * ALONG the path). It does not export `ShapeSource`/`LineLayer`/`SymbolLayer`.
 * The safe-require pattern matches every other map component in this repo.
 */
import React, { useMemo } from 'react';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { GeoJSONSource, Layer } = _ml as typeof import('@maplibre/maplibre-react-native');

import { flowStateOf, flowStateStyle, resolveArrowDirection } from '../../features/map/render/zoneStyle.ts';
import type { ArrowDirection, FlowState } from '../../features/map/render/zoneStyle.ts';
import { isRenderable } from '../../types/mapObjects.ts';
import type { LineStringGeometry, MapObject } from '../../types/mapObjects.ts';

/**
 * §10: "High-confidence flow requires minimum cohort density."
 *
 * The minimum number of distinct contributors behind a flow before it may be
 * drawn at all. Below this the line stops being an aggregate and starts being
 * a small number of identifiable journeys — exactly the "individual routes"
 * §10 forbids and the "public real-time people tracker" of §37.
 *
 * Five is the floor used by the intel pipeline's own cohort gates. It is a
 * FLOOR, not a target: the projection is expected to apply its own, stricter
 * k-anonymity threshold server-side. This constant exists so that a projection
 * bug, a stale cache or a hand-built fixture cannot put a two-person line on
 * the map.
 */
export const MIN_FLOW_COHORT = 5;

/**
 * A crowd flow, structurally stripped of anything per-person.
 *
 * `payload?: never` is the load-bearing line: `MapObject<T>`'s escape hatch for
 * type-specific card fields is closed for this component, so a caller cannot
 * hand it a traveler row "just for the tooltip".
 */
export type AggregateFlowObject = Omit<MapObject, 'geometry' | 'payload' | 'kind'> & {
  kind: 'crowd_flow';
  geometry: LineStringGeometry;
  payload?: never;
};

export interface CrowdFlowLineProps {
  object: AggregateFlowObject;
  /**
   * §10's "Unusual movement". An anomaly is a server-side judgement against a
   * baseline the client does not hold (§19), so it arrives as a flag rather
   * than being inferred here.
   */
  anomalous?: boolean;
  /** Overrides the state derived from the object's own axes. */
  flowState?: FlowState;
  beforeId?: string;
  visible?: boolean;
}

/** Glyphs used for the along-line arrowheads. Text avoids shipping sprites. */
const ARROW_GLYPH = { forward: '▶', reverse: '◀' } as const;

/**
 * Whether this flow may be drawn at all. Exported so a legend or a debug
 * overlay can explain a missing line instead of leaving a silent hole.
 */
export function meetsCohortFloor(object: Pick<MapObject, 'count'>): boolean {
  return (object.count ?? 0) >= MIN_FLOW_COHORT;
}

/** §23: flow geometry must already have been reduced to the aggregate rung. */
export function isAggregateGeometry(object: Pick<MapObject, 'privacyClass'>): boolean {
  return object.privacyClass === 'aggregate_only';
}

export function CrowdFlowLine({
  object,
  anomalous = false,
  flowState,
  beforeId,
  visible = true,
}: CrowdFlowLineProps) {
  const state: FlowState = useMemo(
    () =>
      flowState ??
      flowStateOf({
        activity: object.activity,
        trend: object.trend,
        confidence: object.confidence,
        freshness: object.freshness,
        anomalous,
      }),
    [flowState, object.activity, object.trend, object.confidence, object.freshness, anomalous],
  );
  const style = flowStateStyle(state);
  const direction: ArrowDirection = resolveArrowDirection('crowd_flow', object.trend);

  const feature = useMemo(
    () => ({
      type: 'Feature' as const,
      id: object.id,
      geometry: object.geometry,
      // Aggregate descriptors only. `count` is a cohort SIZE, never a roster.
      properties: {
        flowState: state,
        count: object.count ?? null,
        confidence: object.confidence ?? null,
        freshness: object.freshness ?? null,
      },
    }),
    [object.id, object.geometry, object.count, object.confidence, object.freshness, state],
  );

  if (!GeoJSONSource || !Layer) return null;
  if (!visible) return null;
  if (!isRenderable(object as MapObject)) return null;
  // §10 gate 2 — a cohort too small to be anonymous is not drawn.
  if (!meetsCohortFloor(object)) return null;
  // §10 gate 3 — geometry that was never reduced to an aggregate is refused.
  if (!isAggregateGeometry(object)) return null;
  if (object.geometry.coordinates.length < 2) return null;

  const sourceId = `flow-src-${object.id}`;
  // A dispersal has no single destination, so it is drawn with arrowheads in
  // both directions rather than pointed somewhere Portava did not observe.
  const arrowLayers: ('forward' | 'reverse')[] =
    direction === 'outward' ? ['forward', 'reverse'] : direction === 'reverse' ? ['reverse'] : ['forward'];

  return (
    <GeoJSONSource id={sourceId} data={feature}>
      <Layer
        id={`flow-line-${object.id}`}
        type="line"
        beforeId={beforeId}
        paint={{
          'line-color': style.lineColor,
          'line-opacity': style.lineOpacity,
          'line-width': style.lineWidth,
          'line-blur': 0.5,
          // `lineDashArray` is typed `null` on FlowVisualStyle: §6 reserves the
          // dashed vocabulary for forecasts, and an observed movement may never
          // borrow it. There is deliberately no branch here.
        }}
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
      />
      {arrowLayers.map((glyphDir) => (
        <Layer
          key={glyphDir}
          id={`flow-arrows-${object.id}-${glyphDir}`}
          type="symbol"
          layout={{
            'symbol-placement': 'line',
            'symbol-spacing': style.arrowSpacingPx,
            'text-field': ARROW_GLYPH[glyphDir],
            'text-size': Math.max(9, style.lineWidth * 2.4),
            'text-rotation-alignment': 'map',
            'text-pitch-alignment': 'map',
            'text-keep-upright': false,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-padding': 0,
          }}
          paint={{
            'text-color': style.lineColor,
            'text-opacity': style.arrowOpacity,
          }}
        />
      ))}
    </GeoJSONSource>
  );
}

export interface CrowdFlowLayerProps {
  objects: readonly MapObject[];
  visible?: boolean;
  beforeId?: string;
  /** Ids the projection flagged as §10 "Unusual movement". */
  anomalousIds?: readonly string[];
}

/**
 * Every eligible flow in one pass.
 *
 * The filter is the same three §10 gates as the component, applied once so the
 * caller can count what survived — a Crowd Flow mode with zero eligible flows
 * should say "not enough movement to report yet", not render an empty map and
 * leave the user wondering.
 */
export function eligibleFlows(objects: readonly MapObject[]): AggregateFlowObject[] {
  return objects.filter(
    (o): o is AggregateFlowObject =>
      o.kind === 'crowd_flow' &&
      o.geometry?.type === 'LineString' &&
      o.geometry.coordinates.length >= 2 &&
      isRenderable(o) &&
      meetsCohortFloor(o) &&
      isAggregateGeometry(o),
  );
}

export function CrowdFlowLayer({
  objects,
  visible = true,
  beforeId,
  anomalousIds,
}: CrowdFlowLayerProps) {
  const flows = useMemo(() => eligibleFlows(objects), [objects]);
  if (!visible) return null;
  return (
    <>
      {flows.map((o) => (
        <CrowdFlowLine
          key={o.id}
          object={o}
          beforeId={beforeId}
          anomalous={anomalousIds?.includes(o.id) ?? false}
        />
      ))}
    </>
  );
}
