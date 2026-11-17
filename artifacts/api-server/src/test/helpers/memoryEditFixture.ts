import { MEMORY_EDIT_COLUMNS } from '../../services/memory/memoryEditBase.js';

/** A test client's loaded base. Construct before an interleaving edit; never
 * call this inside the fake writer to manufacture a successful precondition. */
export function memoryEditFixture(row: Record<string, unknown>, changes: Record<string, unknown>) {
  const keys = new Set([...Object.keys(changes), 'state']);
  if (['visibility', 'allowedUserIds', 'hiddenUserIds'].some(k => keys.has(k))) {
    for (const k of ['visibility', 'allowedUserIds', 'hiddenUserIds']) keys.add(k);
  }
  if (['placeId', 'canonicalLocationId', 'locationCity', 'locationCountry', 'locationLat', 'locationLng', 'placeDisplayNameAtOccurrence'].some(k => keys.has(k))) {
    for (const k of ['placeId', 'canonicalLocationId', 'locationCity', 'locationCountry', 'locationLat', 'locationLng', 'placeDisplayNameAtOccurrence']) keys.add(k);
  }
  if (keys.has('startsAt') || keys.has('endsAt')) { keys.add('startsAt'); keys.add('endsAt'); }
  const expected = Object.fromEntries(Object.entries(MEMORY_EDIT_COLUMNS).filter(([key]) => keys.has(key))
    .map(([key, column]) => [key, structuredClone(row[column] ?? (key === 'locationPrecision' ? 'exact' : null))]));
  return { ...changes, expected };
}
