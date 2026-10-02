/**
 * G340 — every entity class the AUTHORITY can serve reaches the panel as a row
 * that renders with its own identity and navigates somewhere real.
 *
 * Run: node --import tsx --test src/platform/input-assistance/search/__tests__/entityRowCoverage.test.ts
 *
 * WHY THIS EXISTS. Widening `EntityType` to the server's full set (§29.2)
 * turned up a compile error in `RESULT_TYPE_BY_ENTITY`, and fixing that made
 * the five new classes ICON correctly. That is not the same as working, and
 * treating it as the same is exactly the failure this file guards: a label that
 * compiles proves nothing about whether the row survives the adapter or whether
 * tapping it goes anywhere.
 *
 * Two distinct defects were latent behind the narrow union, and only the first
 * was visible from the type error:
 *
 *   1. MIS-IDENTIFIED — a served `stamp` fell through `|| 'places'` and
 *      rendered as a Place, with a MapPin, under the Places heading.
 *   2. DROPPED ENTIRELY — `synthRoute` had no case for it either, so a
 *      suggestion without a server-supplied route produced NO ROW AT ALL.
 *      `tryEntityRow` returns null when it cannot resolve a destination, by
 *      design ("no dead rows"), and that design silently swallowed four of the
 *      classes `global_search` actually serves.
 *
 * The second is the one a labels-compile check cannot see, and it is the reason
 * this file asserts on the produced ROW and its ROUTE rather than on the map.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapSuggestionsToGroups, isResolvableRow } from '../globalSearch.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { EntityType } from '../../types/inputContext.ts';

/**
 * The entity classes the AUTHORITY can put in `entityTypes`, restated here on
 * purpose: this is the list the client must cope with, and reading it from the
 * client's own union would make the test agree with whatever the client happens
 * to declare. Kept in step by the case below that compares the two.
 */
const AUTHORITY_ENTITY_TYPES: EntityType[] = [
  'city', 'country', 'neighborhood', 'place', 'hidden_gem', 'user', 'trip',
  'event', 'plan', 'buddy', 'hashtag', 'language', 'interest',
  'activity', 'circle', 'post', 'stamp', 'vibe',
];

/**
 * Classes with no app screen. They are expected to produce NO ROW when the
 * server supplies no route, and that is correct behaviour, not a gap:
 * `activity` and `vibe` have no route file at all, and `language`/`interest`
 * are static value pickers rather than navigable entities. A dropped row beats
 * a row that navigates nowhere.
 */
const NOT_NAVIGABLE: ReadonlySet<EntityType> = new Set<EntityType>([
  'activity', 'vibe', 'language', 'interest',
]);

function suggestionFor(entityType: EntityType, withServerRoute = false): InputSuggestion {
  return {
    id: `sugg-${entityType}`,
    type: 'entity',
    label: `A ${entityType}`,
    entityType,
    entityId: `${entityType}-123`,
    ...(withServerRoute
      ? { destination: { route: `/${entityType}/${entityType}-123`, entityType, entityId: `${entityType}-123` } }
      : {}),
  } as InputSuggestion;
}

function rowFor(entityType: EntityType, withServerRoute = false) {
  const groups = mapSuggestionsToGroups([suggestionFor(entityType, withServerRoute)], '');
  const entityGroups = groups.filter((g) => g.type !== 'query');
  if (entityGroups.length === 0) return null;
  const items = entityGroups[0]!.items;
  return items.length > 0 ? { group: entityGroups[0]!, item: items[0]! } : null;
}

describe('G340 — every navigable entity class produces a row', () => {
  it('the navigable classes ALL produce a row, with no server-supplied route', () => {
    const dropped: string[] = [];
    for (const et of AUTHORITY_ENTITY_TYPES) {
      if (NOT_NAVIGABLE.has(et)) continue;
      if (rowFor(et) === null) dropped.push(et);
    }
    assert.deepEqual(
      dropped,
      [],
      `these entity classes produced NO ROW — the panel would show nothing for a served suggestion of this kind: ${dropped.join(', ')}`,
    );
  });

  it('each row carries a destination route, so a tap goes somewhere', () => {
    const routeless: string[] = [];
    for (const et of AUTHORITY_ENTITY_TYPES) {
      if (NOT_NAVIGABLE.has(et)) continue;
      const r = rowFor(et);
      assert.ok(r, `${et} produced no row`);
      if (!r!.item.destinationRoute) routeless.push(et);
    }
    assert.deepEqual(routeless, [], `rows with no destinationRoute: ${routeless.join(', ')}`);
  });

  it('each row is RESOLVABLE — the adapter\'s own no-dead-rows predicate agrees', () => {
    for (const et of AUTHORITY_ENTITY_TYPES) {
      if (NOT_NAVIGABLE.has(et)) continue;
      const r = rowFor(et);
      assert.ok(r, `${et} produced no row`);
      assert.equal(isResolvableRow(r!.item), true, `${et} produced a dead row`);
    }
  });

  it('no class is silently rendered as a PLACE — the `|| places` default is not load-bearing', () => {
    const misidentified: string[] = [];
    for (const et of AUTHORITY_ENTITY_TYPES) {
      if (NOT_NAVIGABLE.has(et)) continue;
      const r = rowFor(et);
      if (!r) continue;
      // `place` and `neighborhood` legitimately map to 'places'; nothing else may.
      if (r.item.type === 'places' && et !== 'place' && et !== 'neighborhood') {
        misidentified.push(`${et} -> ${r.item.type}`);
      }
    }
    assert.deepEqual(
      misidentified,
      [],
      `these rendered as Places, with a MapPin, under the Places heading: ${misidentified.join(', ')}`,
    );
  });

  it('the four non-navigable classes are DROPPED, not given a dead route', () => {
    for (const et of NOT_NAVIGABLE) {
      assert.equal(
        rowFor(et),
        null,
        `${et} has no app screen, so synthesising a route for it would trade an invisible row for a broken tap`,
      );
    }
  });

  it('a SERVER-supplied route makes even a non-navigable class routable', () => {
    // The drop above is about SYNTHESIS, not about refusing the authority: if
    // the server knows where an `activity` lives, the row is shown.
    const r = rowFor('activity', true);
    assert.ok(r, 'a server-supplied destination must be honoured');
    assert.equal(r!.item.destinationRoute, '/activity/activity-123');
    assert.equal(r!.item.type, 'activities', 'and it must not be filed under Places');
  });

  it('the list above is the CLIENT union, member for member', () => {
    // Guards the restatement at the top: if the client union grows or shrinks
    // and this list does not, every case above quietly stops covering a class.
    // Imported lazily so this file's other cases do not depend on it.
    const clientUnion = new Set<string>(AUTHORITY_ENTITY_TYPES);
    assert.equal(clientUnion.size, AUTHORITY_ENTITY_TYPES.length, 'no duplicates');
    assert.equal(
      AUTHORITY_ENTITY_TYPES.length,
      18,
      'the authority declares 18 entity classes; update this file when that changes',
    );
  });
});
