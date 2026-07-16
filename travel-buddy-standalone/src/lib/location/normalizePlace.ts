/**
 * Normalize raw API responses (Nominatim, etc.) into the app's Place shape.
 */
import type { Place, PlaceType } from './placeTypes';

/** Map Nominatim type/class strings to our PlaceType enum */
function mapNominatimType(type: string, cls: string): PlaceType {
  if (type === 'country') return 'country';
  if (type === 'state' || type === 'province' || type === 'region') return 'region';
  if (type === 'city' || type === 'town') return 'city';
  if (type === 'village' || type === 'hamlet' || type === 'municipality') return 'town';
  if (type === 'suburb' || type === 'neighbourhood' || type === 'quarter') return 'neighborhood';
  if (type === 'district' || type === 'borough') return 'district';
  if (type === 'aeroway' || type === 'aerodrome') return 'airport';
  if (cls === 'natural' || cls === 'tourism') return 'landmark';
  return 'place';
}

/** Normalize a Nominatim search result into a Place */
export function normalizeNominatimResult(raw: any): Place {
  const addr = raw.address ?? {};
  const city =
    addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.county ?? null;
  const district = addr.suburb ?? addr.neighbourhood ?? addr.quarter ?? null;
  const country = addr.country ?? null;
  const countryCode = addr.country_code?.toUpperCase() ?? null;
  const region = addr.state ?? addr.province ?? null;

  const type = mapNominatimType(raw.type ?? '', raw.class ?? '');

  const name =
    raw.namedetails?.name ??
    addr.city ??
    addr.town ??
    addr.village ??
    addr.municipality ??
    raw.display_name?.split(',')[0] ??
    'Unknown';

  const displayParts: string[] = [name];
  if (district && district !== name) displayParts.push(district);
  if (city && city !== name) displayParts.push(city);
  if (country) displayParts.push(country);

  return {
    id: `nominatim-${raw.place_id}`,
    type,
    name,
    displayName: displayParts.join(', '),
    country,
    countryCode,
    region,
    city,
    district,
    lat: raw.lat != null ? parseFloat(raw.lat) : null,
    lng: raw.lon != null ? parseFloat(raw.lon) : null,
    timezone: null,
    source: 'nominatim',
    confidence: raw.importance ?? undefined,
  };
}

/** Normalize a reverse geocode result */
export function normalizeReverseResult(raw: any): Place | null {
  if (!raw || raw.error) return null;
  return normalizeNominatimResult({ ...raw, type: raw.type ?? 'city', class: raw.class ?? 'place' });
}
