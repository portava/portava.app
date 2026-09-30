/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-115): a forecast layer the server did not read.
 *
 * GET /api/map/projection/temporal names `events` in `sources` only over an events read that succeeded and
 * withheld nothing unchecked, and sends `forecast.events: null` over a failed one. A forecast answer without it
 * is a layer that could not be read — never "nothing is forecast there". Pure, so the rule is testable without
 * the transport (services/mapTemporal.ts pulls in the app's auth client).
 */
import type { MapTemporalEnvelope } from '../../../services/mapTemporal.ts';

export function forecastLayersUnread(
  data: Pick<MapTemporalEnvelope, 'sources' | 'forecast'>,
): string[] {
  if (!data.forecast) return [];
  return data.forecast.events === null || !data.sources.includes('events') ? ['events'] : [];
}
