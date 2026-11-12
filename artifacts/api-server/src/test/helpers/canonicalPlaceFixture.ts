import { makeSchemaStrictClient, type Row } from './schemaStrictSupabase.js';

/** Place reads in test fixtures use the database column defaults and real
 * selection/count semantics. A fixture can still seed a held place or a merge. */
export function canonicalPlaceFixture(rows: Row[]) {
  const places = rows.map(row => ({ moderation_status: 'visible', merged_into_place_id: null, ...row }));
  return makeSchemaStrictClient({ places }).from('places');
}
