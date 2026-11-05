import { buildFlowZoneModel, parseFlowZones, FLOW_ZONE_TYPES } from './mapProjection.js';
import { loadActiveProtectedZones } from './protectedZoneStore.js';
import { personalPointSuppressed } from './mapPersonalProtection.js';
import { readRouteFlowConsent } from './mapRouteFlowConsent.js';
export interface NavigationContributionInput { origin: { lat: number; lng: number }; destination: { lat: number; lng: number }; observedAt: number; displayedVersion: string }
/** Ephemeral input only: never persists raw coordinates or infers a starting point. */
export async function recordNavigationContribution(db: any, userId: string, input: NavigationContributionInput, now = Date.now()): Promise<{ stored: boolean; reason?: string }> {
  if (input.observedAt > now + 5000 || now - input.observedAt > 60000) return { stored: false, reason: 'stale_origin' };
  const consent = await readRouteFlowConsent(db, userId);
  if (!consent.available || !consent.granted || !consent.current || !consent.disclosure || input.displayedVersion !== consent.disclosure.version) return { stored: false, reason: 'not_consented' };
  const protectedZones = await loadActiveProtectedZones(db);
  if (!protectedZones) throw new Error('protection_unreadable');
  if (personalPointSuppressed(protectedZones, input.origin) || personalPointSuppressed(protectedZones, input.destination)) return { stored: false, reason: 'protected' };
  const zones = await db.from('geo_zones').select('id,name,zone_type,center_lat,center_lng,radius_meters,polygon_geojson').in('zone_type', [...FLOW_ZONE_TYPES]).limit(2001);
  if (zones.error || !Array.isArray(zones.data) || zones.data.length > 2000) throw new Error('zones_unreadable');
  const model = buildFlowZoneModel(parseFlowZones(zones.data));
  const from = model.resolveZoneForPoint(input.origin); const to = model.resolveZoneForPoint(input.destination);
  if (!from || !to || from === to) return { stored: false, reason: 'not_covered' };
  // SQL serializes consent withdrawal and personal protection changes with this
  // write and checks both again. No read-then-write race can restore a withdrawn hop.
  const result = await db.rpc('record_map_navigation_contribution', { p_user_id: userId, p_version: consent.disclosure.version, p_from: from, p_to: to, p_from_lat: input.origin.lat, p_from_lng: input.origin.lng, p_to_lat: input.destination.lat, p_to_lng: input.destination.lng });
  if (result.error) throw new Error('navigation_write_failed');
  return { stored: result.data === true };
}

/** Reads only current, consented zone hops. No per-person history or group credit. */
export async function readNavigationContributionSignals(db: any, now = Date.now()): Promise<{ signals: import('./crowdFlowProducer.js').MovementSignal[]; refusal: string | null }> {
  const empty = (refusal: string | null) => ({ signals: [], refusal });
  try {
    const { routeFlowDisclosure } = await import('./mapRouteFlowConsent.js');
    const { readFlagState } = await import('./capability/schemaCapability.js');
    const words = routeFlowDisclosure();
    if (!words || await readFlagState(db, 'map_route_flow_consent_enabled') !== 'on') return empty('not_available');
    const read = await db.from('map_navigation_contributions').select('user_id,from_zone_id,to_zone_id,observed_at,expires_at', { count: 'exact' }).gt('expires_at', new Date(now).toISOString()).limit(2001);
    if (read.error || !Array.isArray(read.data) || !Number.isInteger(read.count) || read.count !== read.data.length || read.data.length > 2000) return empty('read_failed');
    const owners = [...new Set<string>(read.data.map((r: any) => r.user_id))];
    const allowed = new Set<string>();
    for (let offset = 0; offset < owners.length; offset += 500) {
      const consent = await db.from('route_flow_contribution_consent').select('user_id').in('user_id', owners.slice(offset, offset + 500)).eq('enabled', true).eq('consent_version', words.version).is('withdrawn_at', null);
      if (consent.error || !Array.isArray(consent.data)) return empty('consent_unreadable');
      for (const row of consent.data) allowed.add(row.user_id);
    }
    return { refusal: null, signals: read.data.flatMap((row: any) => {
      const observed = Date.parse(row.observed_at); const expires = Date.parse(row.expires_at);
      if (!allowed.has(row.user_id) || !Number.isFinite(observed) || observed > now || now - observed > 900000 || !Number.isFinite(expires) || expires <= now || expires > observed + 900000 || typeof row.from_zone_id !== 'string' || typeof row.to_zone_id !== 'string' || row.from_zone_id === row.to_zone_id) return [];
      return [{ actorId: row.user_id, groupKey: null, family: 'navigation_start', fromZoneId: row.from_zone_id, toZoneId: row.to_zone_id, observedAt: observed }];
    }) };
  } catch { return empty('read_failed'); }
}
