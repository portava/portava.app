import { zoneCovers, type ProtectedZone } from './protectedLocations.js';
export const PERSONAL_PROTECTED_CATEGORIES = ['home', 'work', 'school'] as const;
export interface PersonalProtectedPlace { id: string; category: typeof PERSONAL_PROTECTED_CATEGORIES[number]; lat: number; lng: number; radiusMeters: number }
/** Owner-scoped only. No cache: adding/removing a protection affects the next read. */
export async function loadPersonalProtectedZones(db: any, ownerIds: readonly string[]): Promise<Map<string, ProtectedZone[]> | null> {
  const output = new Map<string, ProtectedZone[]>();
  const owners = [...new Set(ownerIds)];
  for (const owner of owners) output.set(owner, []);
  try {
    for (let offset = 0; offset < owners.length; offset += 100) {
      const { data, error, count } = await db.from('map_personal_protected_places').select('id,owner_user_id,category,center_lat,center_lng,radius_meters', { count: 'exact' }).in('owner_user_id', owners.slice(offset, offset + 100)).limit(301);
      if (error || !Array.isArray(data) || !Number.isInteger(count) || count !== data.length || data.length > 300) return null;
      for (const row of data) {
        if (!output.has(row.owner_user_id)) return null;
        output.get(row.owner_user_id)!.push({ id: String(row.id), category: 'private_residence', action: 'suppress', shape: 'circle', center: { lat: Number(row.center_lat), lng: Number(row.center_lng) }, radiusMeters: Number(row.radius_meters) });
      }
    }
    return output;
  } catch { return null; }
}
/** Unknown policy/geometry is never interpreted as an unprotected point. */
export function personalPointSuppressed(zones: readonly ProtectedZone[] | null | undefined, point: { lat: number; lng: number }): boolean {
  if (!zones || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return true;
  return zones.some(zone => zoneCovers(zone, [[point.lng, point.lat]]) !== false);
}
