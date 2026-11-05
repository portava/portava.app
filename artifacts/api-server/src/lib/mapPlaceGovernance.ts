import { readCanonicalPlaceVisibility } from './places/placeGovernance.js';
import { governDiscoveryPlaces } from './discoveryPlaceGovernance.js';
import { liveSubjectIdFor } from './mapProjection.js';
import type { MapObject } from './mapObjects.js';
/** Re-check current canonical governance before aggregation or serializing cached rows. */
export async function filterMapPlaceGovernance(db: any, objects: readonly MapObject[]): Promise<{ objects: MapObject[]; readable: boolean }> {
  const canonical = (object: MapObject) => {
    const value = (object.payload as { canonicalPlaceId?: unknown } | undefined)?.canonicalPlaceId;
    return typeof value === 'string' && value ? value : liveSubjectIdFor(object);
  };
  const ids = objects.flatMap(object => { const id = canonical(object); return id ? [id] : []; });
  // Saved and Memory pins can carry a community UUID or provider ID without a
  // canonicalPlaceId. Resolve that identity afresh, including for cached pins.
  const alias = (object: MapObject): string => {
    const payload = object.payload as { placeId?: unknown; subjectType?: unknown; subjectId?: unknown } | undefined;
    const value = object.kind === 'saved_place' ? payload?.placeId
      : object.kind === 'memory' && payload?.subjectType === 'place' ? payload.subjectId : null;
    return typeof value === 'string' ? value : '';
  };
  const aliased = objects.filter(object => alias(object));
  const [visibility, aliases] = await Promise.all([
    readCanonicalPlaceVisibility(db, ids),
    governDiscoveryPlaces(db, aliased, alias),
  ]);
  const allowedAliases = new Set(aliases.rows);
  return { readable: visibility.ok && aliases.readable, objects: objects.filter(object => {
    const id = canonical(object);
    return (!id || (visibility.ok && visibility.visibleIds.has(id))) && (!alias(object) || allowedAliases.has(object));
  }) };
}
