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
  data: Pick<MapTemporalEnvelope, 'sources' | 'forecast'> & Partial<Pick<MapTemporalEnvelope, 'target' | 'refusal'>>,
): string[] {
  // census-discovery §112 (DV-83, D-W11X2-121): a forecast target answered without a forecast report, or refused
  // (the server's `block_set_unreadable` / `protection_unreadable`), read no layer — never "nothing is forecast".
  if (data.target?.mode === 'forecast' && (!data.forecast || data.refusal != null)) return ['events'];
  if (!data.forecast) return [];
  return data.forecast.events === null || !data.sources.includes('events') ? ['events'] : [];
}

/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-130): a PAST answer that read no history.
 *
 * The server's past arm answers a failed `places` or snapshot-versions read `history: { available: false }` and
 * names `refusal: "history_unreadable"`; a window with genuinely nothing observed is `available: true, covering: 0`.
 * A historical target answered with no history report, or with `available: false`, read nothing — never "the past
 * was empty". The flag-off envelope (`enabled: false`) is not a failed read.
 */
export function historyUnread(
  data: Pick<MapTemporalEnvelope, 'enabled' | 'history'> & Partial<Pick<MapTemporalEnvelope, 'target'>>,
): boolean {
  return data.enabled && data.target?.mode === 'historical' && (!data.history || data.history.available === false);
}

/**
 * The notice the map screen hands the Time Machine (§111, §112, §113): a failed or refused read first, then a read in
 * flight (the strip is never the honest-empty state while the answer is on its way), then an unread forecast layer.
 */
export function temporalNotice(t: { failed: boolean; loading: boolean; unreadForecastLayers: string[] }): string | null {
  if (t.failed) return "Couldn't load the map for this time";
  if (t.loading) return 'Loading the map for this time…';
  return t.unreadForecastLayers.includes('events') ? "Events couldn't be checked for this forecast" : null;
}
