/**
 * §11/§12 neighbourhoods as their own id-space (census G66).
 *
 * `entityMap.ts` maps the `neighborhood` entity type onto the CITY path
 * ("Phase 1: neighborhoods resolve through the city path"), so a
 * `neighborhood_picker` answered with cities and no neighbourhood could ever be
 * bound. The id-space exists: `geo_zones` rows with `zone_type = 'neighborhood'`
 * (baseline `CREATE TABLE public.geo_zones`, publicly readable). This module is
 * the resolver over it, read-only.
 *
 * WHICH ZONES (lead, 2026-10-07): every `zone_type = 'neighborhood'` row. The
 * lead ruled against filtering on `is_system`, because the zones admins create
 * carry `is_system = false`; the table is publicly readable
 * (`geo_zones_public_read`), so the picker offers nothing a reader could not
 * already list. Production holds no neighbourhood rows today: that is a data
 * gap, not a code gap.
 *
 * WHAT A ROW CARRIES. A canonical binding the field can set — the zone id, its
 * name, city and country code, and the IANA timezone of the zone's centre.
 * NO POSITION (census G187: no suggestion carries a coordinate; the lead allowed
 * the timezone derived from the centre). No person, no owner, no polygon.
 *
 * FAIL-CLOSED. An unreadable `geo_zones` answers nothing and says so through the
 * caller's coverage note; it is never an empty result.
 */
import { matchTier } from './searchQueryHelpers';
import { timezoneForCoords } from './geoResolver';
import type { InputContext, InputSuggestion } from './types';

export interface NeighborhoodBinding {
  entityType: 'neighborhood';
  neighborhoodId: string;
  name: string;
  city: string | null;
  countryCode: string | null;
  /** IANA zone of the zone's centre, or null. Never the centre itself (G187). */
  timezone: string | null;
}

export interface NeighborhoodResolution {
  rows: InputSuggestion[];
  /** True when `geo_zones` could not be read — the caller notes it, never treats it as "none". */
  unreadable: boolean;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The centre's timezone — computed from a full pair only, and the pair never leaves. */
function centreTimezone(lat: unknown, lng: unknown): string | null {
  const a = finiteOrNull(lat);
  const b = finiteOrNull(lng);
  return a === null || b === null ? null : timezoneForCoords(a, b);
}

function tierConfidence(tier: number): number {
  return tier === 3 ? 0.99 : tier === 2 ? 0.85 : tier === 1 ? 0.6 : 0.4;
}

/** LIKE pattern for a PostgREST `ilike` value: wildcards and the escape character escaped. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * The neighbourhood rows for a typed query in a field whose policy names the
 * `neighborhood` entity type. Read-only; at most `max` rows; system zones only.
 */
export async function resolveNeighborhoodRows(
  sc: any,
  q: string,
  context: InputContext,
  policyVersion: string,
  max: number,
): Promise<NeighborhoodResolution> {
  const query = q.trim();
  if (query.length < 2 || max <= 0) return { rows: [], unreadable: false };
  let data: any[] | null = null;
  try {
    const res = await sc
      .from('geo_zones')
      .select('id, name, city, country_code, center_lat, center_lng')
      .eq('zone_type', 'neighborhood')
      .ilike('name', likePattern(query))
      .limit(Math.max(1, max));
    if (res?.error) return { rows: [], unreadable: true };
    data = Array.isArray(res?.data) ? res.data : null;
  } catch {
    return { rows: [], unreadable: true };
  }
  if (!data) return { rows: [], unreadable: true };

  const rows: InputSuggestion[] = [];
  for (const z of data) {
    const id = typeof z?.id === 'string' ? z.id : null;
    const name = typeof z?.name === 'string' ? z.name.trim() : '';
    if (!id || !name) continue;
    const binding: NeighborhoodBinding = {
      entityType: 'neighborhood',
      neighborhoodId: id,
      name,
      city: typeof z.city === 'string' && z.city.trim() ? z.city.trim() : null,
      countryCode: typeof z.country_code === 'string' && z.country_code.trim() ? z.country_code.trim() : null,
      timezone: centreTimezone(z.center_lat, z.center_lng),
    };
    const subtitle = [binding.city, binding.countryCode].filter(Boolean).join(', ');
    const row: InputSuggestion = {
      id: `${context}:neighborhood:${id}`,
      type: 'entity',
      context,
      label: name,
      entityType: 'neighborhood',
      entityId: id,
      action: { type: 'set_structured_value', value: binding },
      structuredValue: binding,
      confidence: tierConfidence(matchTier(name, query, subtitle || null)),
      source: 'canonical',
      policyVersion,
    };
    if (subtitle) row.subtitle = subtitle;
    rows.push(row);
  }
  rows.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return { rows: rows.slice(0, max), unreadable: false };
}
