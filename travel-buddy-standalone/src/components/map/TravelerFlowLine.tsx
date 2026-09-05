/**
 * TravelerFlowLine — §36 Phase 7's city→city aggregate movement edge.
 *
 * WHY THIS IS NOT `CrowdFlowLine` WITH A WIDER KIND UNION
 * ======================================================
 * The two look alike on screen and are structurally opposite, and collapsing
 * them would have destroyed the guarantee each one carries.
 *
 *   CrowdFlowLine REQUIRES a count.  `meetsCohortFloor` refuses a §10 flow with
 *   fewer than MIN_FLOW_COHORT distinct contributors, because a line drawn from
 *   two people's transitions is those two people's route.
 *
 *   TravelerFlowLine FORBIDS a count. §36 Phase 7's brief says a flow edge's
 *   counts are "bucketed, never exact", so the server publishes an
 *   `ActivityLevel` bucket and no number at all. Widening `AggregateFlowObject`
 *   to accept this kind would have meant deleting the cohort floor for both, or
 *   making it conditional — and a conditional privacy floor is not one.
 *
 * So the guarantee is inverted and made STRUCTURAL, the same way §10's is:
 *
 *   1. `count?: never` — an object carrying an exact cohort does not type-check
 *      as a prop to this component. There is no field through which a headcount
 *      can arrive, so no renderer built on it can ever draw one.
 *   2. `payload` is typed down to the bucketed shape, so a per-person row
 *      cannot ride in on it "just for the tooltip" (§10's rule, kept).
 *   3. THE BUCKET GATE. `very_quiet` is the rung the server's `bucketCohort`
 *      reserves for cohorts that are never published; seeing one means
 *      something upstream published below its own floor, so it renders NOTHING
 *      rather than a faint line.
 *   4. THE PRIVACY CLASS GATE. §23's `aggregate_only` rung, or nothing. The
 *      renderer cannot un-sharpen geometry (§18), so it refuses instead.
 *
 * §37, WHICH IS THE OTHER HALF OF THE POINT. A city→city edge is a THIRTY-DAY
 * aggregate of accepted plans, not a live arrow. `zoneStyle`'s freshness factor
 * already dims a `historical` line to 45%, which is the honest weight for it,
 * and the label never says "now": it says how long the window was. Nothing here
 * can make it read as a live movement, and it is not a forecast either — no
 * dash, because it is not predicting anything.
 *
 * SDK NOTE
 * ========
 * Same safe-require pattern as every other map component here: v11 exposes
 * `GeoJSONSource` + a unified `Layer`, not `ShapeSource`/`LineLayer`.
 */
import React, { useMemo } from 'react';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { GeoJSONSource, Layer } = _ml as typeof import('@maplibre/maplibre-react-native');

import { ACTIVITY_RAMP, DEFAULT_ACTIVITY } from '../../features/map/render/zoneStyle.ts';
import { ACTIVITY_LABELS, isRenderable } from '../../types/mapObjects.ts';
import type {
  ActivityLevel,
  FreshnessState,
  LineStringGeometry,
  MapObject,
} from '../../types/mapObjects.ts';

/**
 * The bucket the server reserves for a cohort it will NOT publish. An edge
 * carrying it did not come from `bucketCohort`, so it is refused.
 */
export const UNPUBLISHABLE_BUCKET: ActivityLevel = 'very_quiet';

/** The payload half this renderer is allowed to see. No cohort size, ever. */
export interface TravelerFlowRenderPayload {
  cohortBucket: ActivityLevel;
  fromCityLabel: string | null;
  toCityLabel: string | null;
  windowDays: number;
  singleFamily: boolean;
}

/**
 * A traveler-flow edge, structurally stripped of any exact cohort.
 *
 * `count?: never` is the load-bearing line — see the header. It is the mirror
 * image of `AggregateFlowObject`'s cohort floor: §10 refuses a flow WITHOUT
 * enough people, §36 Phase 7 refuses one that names how many.
 */
export type TravelerFlowObject = Omit<MapObject, 'geometry' | 'payload' | 'kind' | 'count'> & {
  kind: 'traveler_flow';
  geometry: LineStringGeometry;
  count?: never;
  payload: TravelerFlowRenderPayload;
};

/** §23: edge geometry must already sit on the aggregate rung. */
export function isAggregateEdge(object: Pick<MapObject, 'privacyClass'>): boolean {
  return object.privacyClass === 'aggregate_only';
}

/** Did this bucket come from a cohort the server was willing to publish? */
export function isPublishableBucket(bucket: unknown): bucket is ActivityLevel {
  return (
    typeof bucket === 'string' &&
    bucket !== UNPUBLISHABLE_BUCKET &&
    Object.prototype.hasOwnProperty.call(ACTIVITY_RAMP, bucket)
  );
}

/**
 * Opacity for the edge. Weakest-wins, like every other §6 surface: a 30-day
 * aggregate carries `historical` freshness and an `unverified` band, so it
 * draws faint — which is the correct weight for it, not a defect to compensate
 * for.
 */
const FRESHNESS_FACTOR: Record<FreshnessState, number> = {
  live: 1.0,
  recent: 0.95,
  aging: 0.85,
  stale: 0.7,
  historical: 0.6,
  unknown: 0.5,
};

export const MIN_EDGE_OPACITY = 0.15;
export const MAX_EDGE_OPACITY = 0.75;

export interface TravelerFlowLineProps {
  object: TravelerFlowObject;
  beforeId?: string;
  visible?: boolean;
}

/** The legend one edge shows. Never a number of people. */
export function travelerFlowLabel(object: TravelerFlowObject): string {
  const p = object.payload;
  const route =
    p.fromCityLabel && p.toCityLabel ? `${p.fromCityLabel} → ${p.toCityLabel}` : 'Between cities';
  const level = ACTIVITY_LABELS[p.cohortBucket] ?? ACTIVITY_LABELS[DEFAULT_ACTIVITY];
  // The window is stated because the alternative — saying nothing — lets a
  // 30-day aggregate read as a live arrow (§37).
  return `${route} · ${level} over ${p.windowDays} days`;
}

export function TravelerFlowLine({ object, beforeId, visible = true }: TravelerFlowLineProps) {
  const eligible =
    isRenderable(object) &&
    isAggregateEdge(object) &&
    isPublishableBucket(object.payload?.cohortBucket) &&
    object.geometry?.type === 'LineString' &&
    object.geometry.coordinates.length >= 2;

  const style = useMemo(() => {
    const bucket = object.payload?.cohortBucket ?? DEFAULT_ACTIVITY;
    const entry = ACTIVITY_RAMP[bucket] ?? ACTIVITY_RAMP[DEFAULT_ACTIVITY];
    const factor = FRESHNESS_FACTOR[object.freshness ?? 'unknown'] ?? FRESHNESS_FACTOR.unknown;
    const raw = (0.35 + entry.baseFillOpacity) * factor;
    return {
      color: entry.fill,
      opacity: raw < MIN_EDGE_OPACITY ? MIN_EDGE_OPACITY : raw > MAX_EDGE_OPACITY ? MAX_EDGE_OPACITY : raw,
      width: 1.5 + entry.baseFillOpacity * 6,
    };
  }, [object.payload?.cohortBucket, object.freshness]);

  const shape = useMemo(
    () => ({
      type: 'Feature' as const,
      properties: { label: travelerFlowLabel(object) },
      geometry: object.geometry,
    }),
    [object],
  );

  if (!visible || !eligible || !GeoJSONSource || !Layer) return null;

  return (
    <GeoJSONSource id={`traveler-flow-${object.id}`} data={shape}>
      <Layer
        id={`traveler-flow-line-${object.id}`}
        type="line"
        beforeId={beforeId}
        paint={{
          'line-color': style.color,
          'line-opacity': style.opacity,
          'line-width': style.width,
        }}
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
      />
    </GeoJSONSource>
  );
}

export interface TravelerFlowLayerProps {
  objects: readonly MapObject[];
  beforeId?: string;
  visible?: boolean;
}

/**
 * Every eligible edge in one pass.
 *
 * Exported separately so a legend can explain a missing edge instead of leaving
 * a silent hole — the same reason `eligibleFlows` is exported from
 * CrowdFlowLine.
 */
export function eligibleTravelerFlows(
  objects: readonly MapObject[],
): TravelerFlowObject[] {
  return objects.filter(
    (o): o is TravelerFlowObject =>
      o.kind === 'traveler_flow' &&
      o.geometry?.type === 'LineString' &&
      o.geometry.coordinates.length >= 2 &&
      isRenderable(o) &&
      isAggregateEdge(o) &&
      // Belt and braces against a cached or hand-built object: the server never
      // puts a count on this kind, so one appearing here means the object did
      // not come from the Phase 7 producer.
      o.count == null &&
      isPublishableBucket((o.payload as TravelerFlowRenderPayload | undefined)?.cohortBucket),
  );
}

export function TravelerFlowLayer({ objects, beforeId, visible = true }: TravelerFlowLayerProps) {
  const edges = useMemo(() => eligibleTravelerFlows(objects), [objects]);
  if (!visible) return null;
  return (
    <>
      {edges.map((o) => (
        <TravelerFlowLine key={o.id} object={o} beforeId={beforeId} />
      ))}
    </>
  );
}
