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
  if (data.target?.mode === 'forecast' && (!data.forecast || data.refusal != null)) return ['events', 'accepted_plan', 'itinerary'];  // §114 (B6): a refused forecast read none of its layers
  if (!data.forecast) return [];
  return [...(data.forecast.events === null || !data.sources.includes('events') ? ['events'] : []), ...planAndItineraryUnread(data.forecast, data.sources)];  // §114 (B6): the plan and itinerary layers too
}

/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-130): a PAST answer that read no history.
 *
 * The server's past arm answers a failed `places` or snapshot-versions read `history: { available: false }` and
 * names `refusal: "history_unreadable"`; a window with genuinely nothing observed is `available: true, covering: 0`.
 * A historical target answered with no history report, or with `available: false`, read nothing — never "the past
 * was empty". The flag-off envelope (`enabled: false`) carries no target, so it is not a failed read.
 */
export function historyUnread(
  data: Pick<MapTemporalEnvelope, 'history'> & Partial<Pick<MapTemporalEnvelope, 'target'>>,
): boolean {
  return data.target?.mode === 'historical' && (!data.history || data.history.available === false);
}

/**
 * The notice the map screen hands the Time Machine (§111, §112, §113): a failed or refused read first, then a read in
 * flight (the strip is never the honest-empty state while the answer is on its way), then an unread forecast layer.
 */
export function temporalNotice(t: { failed: boolean; loading: boolean; unreadForecastLayers: string[]; history?: Pick<MapTemporalEnvelope, 'history'>['history']; /** §114 (B6): the answer was page one of several */ pageCut?: boolean }): string | null {
  if (t.failed) return "Couldn't load the map for this time";
  if (t.loading) return 'Loading the map for this time…';
  const parts = [...(t.history?.truncated || t.pageCut ? ['Only part of this time could be loaded'] : []), ...FORECAST_LAYER_NOTICE.filter(([layer]) => t.unreadForecastLayers.includes(layer)).map(([, words]) => words)];  // §113 (D-W11X2-136): a past read cut at its cap; §114 (B6): a page of several, and every unread layer
  return parts.length > 0 ? parts.join(' \u00b7 ') : null;
}

/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; the round-16 verifier's B6): the forecast's accepted-plan and
 * itinerary layers.
 *
 * The temporal gateway refuses the accepted-plan forecast over a read that failed or was cut (`read_failed`,
 * `zone_read_failed`, `zone_model_capped`, `plans_capped`, `stops_capped`) and then does not name `accepted_plan`. Three
 * refusals are the layer being OFF, not a failed read: `flag_off` (crowd flow is switched off), `no_group_key_secret`
 * (the deployment has no group-key secret, so no cohort could ever clear the floor) and `no_zone_model` (the zone model
 * was read whole and no zone is in view). Anything else — including a refusal this client does not know — is unread.
 * The itinerary is unread when the gateway reports it null or does not name it.
 */
const PLAN_OFF_STATES: ReadonlySet<string> = new Set(['flag_off', 'no_group_key_secret', 'no_zone_model']);

function planAndItineraryUnread(forecast: NonNullable<MapTemporalEnvelope['forecast']>, sources: string[]): string[] {
  const out: string[] = [];
  const refusal = forecast.plan === null ? 'unread' : forecast.plan.refusal;
  if (refusal != null && !PLAN_OFF_STATES.has(refusal)) out.push('accepted_plan');
  if (forecast.itinerary === null || !sources.includes('itinerary')) out.push('itinerary');
  return out;
}

/** What the Time Machine says for each unread forecast layer, in the order it says them. */
const FORECAST_LAYER_NOTICE: ReadonlyArray<readonly [string, string]> = [
  ['events', "Events couldn't be checked for this forecast"],
  ['accepted_plan', "Predicted crowds couldn't be checked for this time"],
  ['itinerary', "Your plans couldn't be loaded for this time"],
];
