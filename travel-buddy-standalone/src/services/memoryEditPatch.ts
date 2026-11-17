import type { Memory, UpdateMemoryInput } from './memories.ts';

const fields = ['title', 'caption', 'visibility', 'placeId', 'canonicalLocationId',
  'locationCity', 'locationCountry', 'locationLat', 'locationLng', 'memoryType',
  'placeDisplayNameAtOccurrence', 'startsAt', 'endsAt', 'state'] as const;
const placeFields = ['placeId', 'canonicalLocationId', 'locationCity', 'locationCountry', 'locationLat', 'locationLng'] as const;

/** Build one edit from the owner's loaded snapshot, never from a fresh save-time
 * read that would silently accept somebody else's intervening changes. */
export function memoryEditPatch(base: Memory, candidate: UpdateMemoryInput): UpdateMemoryInput | null {
  const patch: Record<string, unknown> = {};
  const expected: Record<string, unknown> = { state: base.state };
  for (const field of fields) {
    if (candidate[field] !== undefined && candidate[field] !== base[field]) {
      patch[field] = candidate[field];
      expected[field] = base[field] ?? null;
    }
  }
  if (Object.keys(patch).length === 0) return null;
  if (Object.hasOwn(patch, 'visibility')) {
    expected.visibility = base.visibility;
    expected.allowedUserIds = [...base.allowedUserIds];
    expected.hiddenUserIds = [...base.hiddenUserIds];
  }
  if (placeFields.some(field => Object.hasOwn(patch, field)) || Object.hasOwn(patch, 'placeDisplayNameAtOccurrence')) {
    for (const field of placeFields) expected[field] = base[field];
    expected.placeDisplayNameAtOccurrence = base.placeDisplayNameAtOccurrence ?? null;
    // The API clears the old canonical reference when a newly picked place
    // carries none; compare that dependent field even if omitted from the patch.
  }
  if (Object.hasOwn(patch, 'startsAt') || Object.hasOwn(patch, 'endsAt')) {
    expected.startsAt = base.startsAt; expected.endsAt = base.endsAt;
  }
  return { ...patch, expected };
}
