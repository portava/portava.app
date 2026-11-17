/** API names mapped to the canonical columns compared under the kernel lock. */
export const MEMORY_EDIT_COLUMNS = {
  title: 'title', caption: 'caption', visibility: 'visibility',
  allowedUserIds: 'allowed_user_ids', hiddenUserIds: 'hidden_user_ids',
  placeId: 'place_id', canonicalLocationId: 'canonical_location_id',
  locationCity: 'location_city', locationCountry: 'location_country',
  locationLat: 'location_lat', locationLng: 'location_lng', locationPrecision: 'location_precision',
  memoryType: 'memory_type', placeDisplayNameAtOccurrence: 'place_display_name_at_occurrence',
  startsAt: 'starts_at', endsAt: 'ends_at', state: 'state',
} as const;

export function memoryEditBase(expected: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(MEMORY_EDIT_COLUMNS)
    .filter(([key]) => Object.hasOwn(expected, key))
    .map(([key, column]) => [column, expected[key]]));
}
