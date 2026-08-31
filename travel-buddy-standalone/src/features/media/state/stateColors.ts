/**
 * features/media — semantic state → color mapping (spec §46).
 *
 * Observed, inferred, and predicted states MUST use distinct visual treatments
 * (§46). Freshness reads as a single-hue recency ramp so it never competes with
 * the observation-class hue. Signal red (color.signal) is deliberately NOT used
 * here — tokens.ts reserves it for primary actions / the live pulse, and §46.2
 * forbids fake-live treatment.
 *
 * Pure string constants — no react-native import, safe for node:test.
 */
import type { FreshnessClass, ObservationClass } from '../types/media.ts';
import type { CityZoneState } from '../types/mediaContext.ts';

/** Recency ramp (teal, dimming with age). One hue so it reads as "how fresh". */
export const FRESHNESS_COLOR: Record<FreshnessClass, string> = {
  live: '#3DD6C4',
  fresh: '#35B4A6',
  recent: '#7C9C98',
  historical: '#6B6862',
};

/**
 * Observation-class hue — the semantic distinction §46 requires.
 *  observed   teal    — real, directly-captured evidence
 *  inferred   indigo  — derived by the intelligence layer
 *  user_claimed slate — asserted, uncorroborated
 *  predicted  amber   — forecast / likely-next (§17 forecasts are distinct)
 *  generated  mute    — illustrative fallback, lowest evidence weight
 */
export const OBSERVATION_COLOR: Record<ObservationClass, string> = {
  observed: '#3DD6C4',
  inferred: '#8B9DFF',
  user_claimed: '#9C988F',
  predicted: '#E6A94B', // amber
  generated: '#6B6862',
};

/** Whether an observation class should render as a dashed / forecast treatment. */
export function isForecastClass(cls: ObservationClass): boolean {
  return cls === 'predicted';
}

/** City-zone-state accent (calm, no alarm red). */
export const ZONE_COLOR: Record<CityZoneState, string> = {
  starting: '#5AB0FF',
  building: '#3DD6C4',
  peak: '#E6A94B',
  moderate: '#8B9DFF',
  quiet: '#7C9C98',
  winding_down: '#9C988F',
};
