/**
 * temporalView — the join between the §15 producer's per-offset payload and the
 * §15 UI (TimeMachineControl + CityTimeline).
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 * ================================
 * `toTemporalObjects` used to be handed the objects that were ON SCREEN NOW and
 * asked to relabel them for a future offset — which is exactly the §37 failure
 * "make predictions look like observations", because a live place would put on a
 * forecast badge while keeping its live evidence. Time Machine was held closed
 * for that reason.
 *
 * The objects handed to `buildTemporalView` now come from GET
 * /api/map/projection/temporal (services/mapTemporal): they are ALREADY the
 * per-offset payload — `prediction` objects for a future offset, observed
 * `freshness: 'historical'` places for a past one. Running them back through
 * `toTemporalObjects` at the SAME offset is therefore idempotent on the forecast
 * arm (a prediction stays a prediction) and simply the enforcement pass on the
 * others: it is the ONE construction point where §15/§37's invariants are
 * re-checked before the objects reach a renderer.
 *
 * The `timeline` is derived from the same real payload, so an offset with
 * nothing to show yields an EMPTY timeline — which CityTimeline renders as an
 * honest "no city trend to show" strip rather than a blank the reader would
 * mistake for "nothing is happening".
 *
 * Pure: no I/O, no clock beyond the injected `now`.
 *
 * @see src/features/map/time/timeMachine.ts
 * @see src/services/mapTemporal.ts
 */
import {
  cityTimeline,
  toTemporalObjects,
  isForecastObject,
  type CityTimeline,
  type TemporalObject,
  type TimeOffset,
  type ToTemporalOptions,
} from './timeMachine.ts';
import { CONFIDENCE_STATES, type ConfidenceState, type MapObject } from '../../../types/mapObjects.ts';

export interface TemporalView<T = unknown> {
  /** The per-offset objects, each carrying its §15 temporal mode. */
  objects: TemporalObject<T>[];
  /** The §15 city timeline. Empty bands ⇒ CityTimeline shows its honest empty state. */
  timeline: CityTimeline;
  /**
   * A single representative forecast confidence for TimeMachineControl's status
   * line — the WEAKEST among the forecast objects (fail-closed: the badge must
   * not claim more certainty than its least-certain member), or null when the
   * offset produced no forecast at all.
   */
  forecastConfidence: ConfidenceState | null;
}

/** Lower index = weaker. Mirrors CONFIDENCE_STATES' order. */
function confidenceRank(c: ConfidenceState): number {
  const i = CONFIDENCE_STATES.indexOf(c);
  return i < 0 ? 0 : i;
}

/**
 * Turn the producer's per-offset payload into everything the §15 UI needs.
 *
 * `objects` MUST be the objects fetched FOR `offset` (the temporal endpoint's
 * output), not the NOW projection — that is the whole point. Passing the NOW map
 * here would re-introduce the relabelling defect this module exists to remove.
 */
export function buildTemporalView<T = unknown>(
  objects: readonly MapObject<T>[],
  offset: TimeOffset,
  opts: ToTemporalOptions = {},
): TemporalView<T> {
  const temporalObjects = toTemporalObjects(objects, offset, opts);
  const timeline = cityTimeline(objects, offset, opts.now, opts.tz);

  let forecastConfidence: ConfidenceState | null = null;
  for (const o of temporalObjects) {
    if (!isForecastObject(o)) continue;
    if (forecastConfidence === null || confidenceRank(o.forecastConfidence) < confidenceRank(forecastConfidence)) {
      forecastConfidence = o.forecastConfidence;
    }
  }

  return { objects: temporalObjects, timeline, forecastConfidence };
}
