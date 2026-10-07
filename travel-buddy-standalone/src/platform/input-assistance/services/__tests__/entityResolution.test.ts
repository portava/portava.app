/**
 * census G260 — `services/entityResolution.ts` resolves an UNRESOLVED row
 * against the local index that holds canonical identities, and refuses rather
 * than guesses.
 *
 * The unresolved row in every test is the real shipped-dictionary row shape
 * (`offlineLocalRows` → `source: 'local'`, an `entityType`, NO `entityId`), and
 * the local index is the real `localZeroState` store, written by the real
 * `recordLocalSelection` — nothing here stubs the store.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - `if (matches.size !== 1) return null` → `if (matches.size === 0) …` (take
 *     the first of several) → "AMBIGUITY: two distinct canonical entities…" red.
 *   - drop the entity-class check → "a city name never binds to a PLACE…" red.
 *   - `if (!policy) return null` removed and a public default used → "fail-closed:
 *     no policy resolves nothing" red.
 *   - `localZeroState({...policy…})` → read the store with a forced public class
 *     → "PRIVACY: a field whose class forbids retention…" red.
 *   - drop the `finite(b.lat) && finite(b.lng)` pair check → "a coordinate is
 *     taken only as a PAIR" red.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordLocalSelection,
  clearLocalZeroState,
  detachLocalRecents,
  type LocalZeroStatePolicy,
} from '../localZeroState.ts';
import { resolveSuggestion, resolveLocally, bindLocally } from '../entityResolution.ts';
import { offlineLocalRows } from '../localDictionary.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { EntityType, InputContext } from '../../types/inputContext.ts';

const CITY: LocalZeroStatePolicy = { context: 'city_picker', privacyClass: 'public', maxSuggestions: 5 };

function canonical(
  label: string,
  id: string,
  opts: { entityType?: EntityType; context?: InputContext; structuredValue?: unknown } = {},
): InputSuggestion {
  const entityType = opts.entityType ?? 'city';
  const row: InputSuggestion = {
    id: `${opts.context ?? 'city_picker'}:${entityType}:${id}`,
    type: 'entity',
    context: opts.context ?? 'city_picker',
    label,
    replacementText: label,
    entityType,
    entityId: id,
    action: { type: 'open_entity', entityType, entityId: id },
    canonicalUri: `portava:/city/${id}`,
    source: 'canonical',
    policyVersion: 'input-2026-08',
  };
  if (opts.structuredValue !== undefined) row.structuredValue = opts.structuredValue;
  return row;
}

/** An unresolved row exactly as the shipped dictionary builds it. */
function dictionaryRow(label: string, context: InputContext = 'city_picker'): InputSuggestion {
  return {
    id: `local:${context}:city:${label}`,
    type: 'entity',
    context,
    label,
    replacementText: label,
    entityType: 'city',
    source: 'local',
    policyVersion: 'input-2026-08',
  };
}

beforeEach(() => {
  detachLocalRecents();
  clearLocalZeroState();
});

test('premise: the shipped dictionary row really is unresolved (entityType, no entityId)', () => {
  const rows = offlineLocalRows(
    {
      context: 'city_picker',
      offlinePolicy: 'cached_local',
      privacyClass: 'public',
      entityTypes: ['city'],
      allowedSuggestionTypes: ['entity', 'completion'],
      maxSuggestions: 5,
    },
    'bangk',
    [],
  );
  const bangkok = rows.find((r) => r.label === 'Bangkok');
  assert.ok(bangkok, 'the dictionary offers Bangkok offline');
  assert.equal(bangkok.entityType, 'city');
  assert.equal(bangkok.entityId, undefined);
  assert.equal(bangkok.source, 'local');
});

test('intended: an unresolved name binds to the ONE canonical entity accepted in this field', async () => {
  recordLocalSelection(CITY, canonical('Bangkok', 'city-bkk', {
    structuredValue: { entityType: 'city', cityId: 'city-bkk', city: 'Bangkok', country: 'Thailand',
      countryCode: 'TH', lat: 13.75, lng: 100.5, timezone: 'Asia/Bangkok' },
  }));
  const resolved = await resolveSuggestion(dictionaryRow('Bangkok'), { policy: CITY });
  assert.deepEqual(resolved, {
    entityType: 'city',
    entityId: 'city-bkk',
    displayName: 'Bangkok',
    canonicalUri: 'portava:/city/city-bkk',
    prefill: { cityId: 'city-bkk', lat: 13.75, lng: 100.5, timezone: 'Asia/Bangkok' },
  });
});

test('intended: the match is on the FOLDED name (case, diacritics, spacing)', async () => {
  recordLocalSelection(CITY, canonical('Đà Nẵng', 'city-dad'));
  const resolved = await resolveSuggestion(dictionaryRow('da  nang'), { policy: CITY });
  assert.equal(resolved?.entityId, 'city-dad');
});

test('intended: bindLocally hands back the tapped row carrying the canonical identity and the server’s action', () => {
  recordLocalSelection(CITY, canonical('Bangkok', 'city-bkk'));
  const tapped = dictionaryRow('Bangkok');
  const bound = bindLocally(tapped, CITY);
  assert.equal(bound.entityId, 'city-bkk');
  assert.deepEqual(bound.action, { type: 'open_entity', entityType: 'city', entityId: 'city-bkk' });
  assert.equal(bound.canonicalUri, 'portava:/city/city-bkk');
  assert.equal(bound.label, 'Bangkok', 'the row the person tapped is still the row accepted');
  assert.equal(bound.source, 'local', 'and it stays honest about where it was offered from');
  assert.equal(bound.id, tapped.id);
});

test('AMBIGUITY: two distinct canonical entities with the same name resolve to NEITHER (§19)', async () => {
  recordLocalSelection(CITY, canonical('San Jose', 'city-sjc-us'));
  recordLocalSelection(CITY, canonical('San José', 'city-sjo-cr'));
  assert.equal(await resolveSuggestion(dictionaryRow('San Jose'), { policy: CITY }), null);
  const tapped = dictionaryRow('San Jose');
  assert.equal(bindLocally(tapped, CITY), tapped, 'unbound and unchanged');
});

test('the SAME entity accepted twice is not ambiguity', async () => {
  recordLocalSelection(CITY, canonical('Bangkok', 'city-bkk'));
  recordLocalSelection(CITY, { ...canonical('Bangkok', 'city-bkk'), id: 'other-row-id', type: 'recent' });
  assert.equal((await resolveSuggestion(dictionaryRow('Bangkok'), { policy: CITY }))?.entityId, 'city-bkk');
});

test('a city name never binds to a PLACE of the same name', async () => {
  recordLocalSelection(CITY, canonical('Paris', 'place-paris-cafe', { entityType: 'place' }));
  assert.equal(await resolveSuggestion(dictionaryRow('Paris'), { policy: CITY }), null);
});

test('no retained match resolves nothing', async () => {
  recordLocalSelection(CITY, canonical('Bangkok', 'city-bkk'));
  assert.equal(await resolveSuggestion(dictionaryRow('Hanoi'), { policy: CITY }), null);
  assert.equal(resolveLocally({ ...dictionaryRow(''), label: '  ', replacementText: '' }, CITY), null);
});

test('fail-closed: no policy resolves nothing', async () => {
  recordLocalSelection(CITY, canonical('Bangkok', 'city-bkk'));
  assert.equal(await resolveSuggestion(dictionaryRow('Bangkok')), null);
  assert.equal(await resolveSuggestion(dictionaryRow('Bangkok'), { policy: null }), null);
  assert.equal(resolveLocally(dictionaryRow('Bangkok'), undefined), null);
});

test('PRIVACY: a field whose class forbids retention — or was reclassified since — resolves nothing', async () => {
  recordLocalSelection(CITY, canonical('Bangkok', 'city-bkk'));
  for (const privacyClass of ['viewer_scoped', null] as const) {
    assert.equal(
      await resolveSuggestion(dictionaryRow('Bangkok'), { policy: { ...CITY, privacyClass } }),
      null,
      `privacyClass ${String(privacyClass)} must not read the retained index`,
    );
  }
});

test('rows accepted in ANOTHER field are not this field’s index', async () => {
  const TRIP: LocalZeroStatePolicy = { context: 'trip_destination', privacyClass: 'public', maxSuggestions: 5 };
  recordLocalSelection(TRIP, canonical('Bangkok', 'city-bkk', { context: 'trip_destination' }));
  assert.equal(await resolveSuggestion(dictionaryRow('Bangkok'), { policy: CITY }), null);
});

test('a coordinate is taken only as a PAIR; a malformed binding is ignored, not coerced', async () => {
  recordLocalSelection(CITY, canonical('Hue', 'city-hue', {
    structuredValue: { cityId: 'city-hue', lat: 16.46, lng: null, timezone: '' },
  }));
  const resolved = await resolveSuggestion(dictionaryRow('Hue'), { policy: CITY });
  assert.deepEqual(resolved?.prefill, { cityId: 'city-hue' });

  clearLocalZeroState();
  recordLocalSelection(CITY, canonical('Hue', 'city-hue', { structuredValue: 'not-a-binding' }));
  const bare = await resolveSuggestion(dictionaryRow('Hue'), { policy: CITY });
  assert.equal(bare?.entityId, 'city-hue');
  assert.equal(bare?.prefill, undefined);
});

test('an already-resolved row passes through unchanged (and never consults the index)', async () => {
  const row = canonical('Bangkok', 'city-bkk');
  assert.deepEqual(await resolveSuggestion(row), {
    entityType: 'city',
    entityId: 'city-bkk',
    canonicalUri: 'portava:/city/city-bkk',
    displayName: 'Bangkok',
  });
  assert.equal(bindLocally(row, CITY), row);
});
