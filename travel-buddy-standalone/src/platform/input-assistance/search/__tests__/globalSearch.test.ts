/**
 * Phase 3 (Global Search) — gateway ⇄ grouped-row mapping (§13, §43).
 *
 * Pure logic — no React/network — runs under the node:test runner. The
 * discovery types are `type`-only imports, so nothing here loads Supabase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapSuggestionsToGroups,
  getSubmitQuery,
  isResolvableRow,
  QUERY_GROUP_TYPE,
} from '../globalSearch.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { SuggestGroup } from '../../../../services/discovery.ts';

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    type: over.type ?? 'entity',
    context: over.context ?? 'global_search',
    label: over.label ?? 'Sky Bar',
    source: over.source ?? 'canonical',
    policyVersion: over.policyVersion ?? 'input-2026-08',
    ...over,
  };
}

function allRows(groups: SuggestGroup[]) {
  return groups.flatMap((g) => g.items);
}

// ── mapping ─────────────────────────────────────────────────────────────────

test('maps entity suggestions into typed groups the panel renders', () => {
  const groups = mapSuggestionsToGroups(
    [
      sug({ label: 'Sky36', subtitle: 'Da Nang', entityType: 'place', entityId: 'place_sky36' }),
      sug({ label: '@skylar', subtitle: 'Traveler', entityType: 'user', entityId: 'user_skylar' }),
      sug({ label: 'Hidden Rooftop', subtitle: 'Son Tra', entityType: 'hidden_gem', entityId: 'gem_hr' }),
    ],
    'sky',
  );

  const byType = Object.fromEntries(groups.map((g) => [g.type, g]));
  assert.ok(byType.places, 'has a places group');
  assert.equal(byType.places.label, 'Places');
  assert.equal(byType.places.items[0].title, 'Sky36');
  assert.equal(byType.places.items[0].subtitle, 'Da Nang');
  // Place route is synthesised in the backend convention resolveRoute understands.
  assert.equal(byType.places.items[0].destinationRoute, '/place/place_sky36');

  assert.ok(byType.travelers, 'has a people group');
  assert.equal(byType.travelers.label, 'People');
  assert.equal(byType.travelers.items[0].destinationRoute, '/passport/user_skylar');

  assert.ok(byType.hidden_gems, 'has a hidden gems group');
  assert.equal(byType.hidden_gems.items[0].destinationRoute, '/hidden-gem/gem_hr');
});

test('prefers a gateway-provided UI-ready destination.route over the synthesised one', () => {
  const groups = mapSuggestionsToGroups(
    [
      sug({
        label: 'Da Nang',
        entityType: 'city',
        entityId: 'city_da_nang',
        destination: { route: '/destination/da-nang?country=Vietnam', entityType: 'city' },
      }),
    ],
    'da',
  );
  assert.equal(groups[0].items[0].destinationRoute, '/destination/da-nang?country=Vietnam');
});

test('derives entity identity from an open_entity action when top-level ids are absent', () => {
  const groups = mapSuggestionsToGroups(
    [sug({ label: 'Bangkok', type: 'action', action: { type: 'open_entity', entityType: 'city', entityId: 'city_bkk' } })],
    'bang',
  );
  assert.equal(groups[0].type, 'cities');
  assert.equal(groups[0].items[0].destinationRoute, '/city/city_bkk');
});

// ── "SEARCH FOR …" query completions (§13) ───────────────────────────────────

test('query completions become a trailing "Search for" group carrying submitQuery', () => {
  const groups = mapSuggestionsToGroups(
    [
      sug({ label: 'Sky36', entityType: 'place', entityId: 'place_sky36' }),
      sug({ id: 'c1', type: 'completion', label: 'sky nightlife' }),
      sug({ id: 'c2', type: 'completion', label: 'sky bars near me', action: { type: 'submit_search', query: 'sky bars near me' } }),
    ],
    'sky',
  );

  // Entity groups sort before the query group (§9 canonical-first).
  assert.equal(groups[groups.length - 1].type, QUERY_GROUP_TYPE);
  const q = groups.find((g) => g.type === QUERY_GROUP_TYPE)!;
  assert.equal(q.label, 'Search for');
  assert.equal(q.items.length, 2);
  assert.equal(q.items[0].title, 'sky nightlife');
  assert.equal(getSubmitQuery(q.items[0]), 'sky nightlife');
  assert.equal(getSubmitQuery(q.items[1]), 'sky bars near me');
  // Query rows never carry a route — they submit, not open.
  assert.equal(q.items[0].destinationRoute, null);
});

test('drops a completion that just repeats the typed query (avoids duplicating the always-first row)', () => {
  const groups = mapSuggestionsToGroups(
    [
      sug({ id: 'c1', type: 'completion', label: 'Sky' }), // == typed "sky" after folding
      sug({ id: 'c2', type: 'completion', label: 'sky nightlife' }),
    ],
    'sky',
  );
  const q = groups.find((g) => g.type === QUERY_GROUP_TYPE);
  assert.ok(q);
  assert.deepEqual(q!.items.map((i) => getSubmitQuery(i)), ['sky nightlife']);
});

test('treats a recent/personalized search string (no entity) as a submit row', () => {
  const groups = mapSuggestionsToGroups(
    [sug({ id: 'r1', type: 'recent', label: 'rooftop bars', replacementText: 'rooftop bars' })],
    'roof',
  );
  const q = groups.find((g) => g.type === QUERY_GROUP_TYPE)!;
  assert.equal(getSubmitQuery(q.items[0]), 'rooftop bars');
});

// ── no-dead-rows invariant (§13) ─────────────────────────────────────────────

test('NO DEAD ROWS: every emitted row resolves to an entity route OR a submit query', () => {
  const groups = mapSuggestionsToGroups(
    [
      sug({ label: 'Sky36', entityType: 'place', entityId: 'place_sky36' }),
      sug({ label: '@skylar', entityType: 'user', entityId: 'user_skylar' }),
      sug({ id: 'c1', type: 'completion', label: 'sky nightlife' }),
      // Dead candidate: no route, no query, no entity id → must be dropped.
      sug({ id: 'x1', type: 'entity', label: '', entityType: 'place' }),
      // Dead candidate: action with no submit query and no resolvable entity.
      sug({ id: 'x2', type: 'action', label: 'Do a thing', action: { type: 'drop_pin' } }),
    ],
    'sky',
  );

  const rows = allRows(groups);
  assert.ok(rows.length >= 3, 'the resolvable rows survive');
  for (const row of rows) {
    assert.ok(
      isResolvableRow(row),
      `row "${row.title}" (${row.type}) must be resolvable (route or submitQuery)`,
    );
  }
  // The two dead candidates never made it into any group.
  assert.equal(rows.some((r) => r.id === 'x1' || r.id === 'x2'), false);
});

// ── degrade path (§38) ────────────────────────────────────────────────────────

test('DEGRADE: empty suggestions → empty groups (hook then keeps the legacy list, no throw)', () => {
  assert.deepEqual(mapSuggestionsToGroups([], 'sky'), []);
  // @ts-expect-error — defensively tolerant of a nullish list (never throws).
  assert.deepEqual(mapSuggestionsToGroups(undefined, 'sky'), []);
});

test('DEGRADE: an all-dead-rows response yields no groups, so the caller falls back', () => {
  const groups = mapSuggestionsToGroups(
    [
      sug({ id: 'x1', type: 'entity', label: 'No identity' }), // no entityId → no route
      sug({ id: 'x2', type: 'action', label: 'Pin', action: { type: 'drop_pin' } }),
    ],
    'sky',
  );
  assert.deepEqual(groups, []);
});

test('does not throw on malformed / partial suggestions', () => {
  assert.doesNotThrow(() => {
    mapSuggestionsToGroups(
      [
        // Missing subtitle/reason/destination — all optional.
        sug({ label: 'Trip to Hue', entityType: 'trip', entityId: 't1' }),
        // Completion with only a label.
        sug({ type: 'completion', label: 'hue food' }),
      ],
      '',
    );
  });
});

// ── ordering + helpers ────────────────────────────────────────────────────────

test('orders entity groups canonical-first with the query group always last', () => {
  const groups = mapSuggestionsToGroups(
    [
      sug({ id: 'q', type: 'completion', label: 'paris nightlife' }),
      sug({ label: 'A Place', entityType: 'place', entityId: 'p1' }),
      sug({ label: 'Paris', entityType: 'city', entityId: 'c1' }),
    ],
    'par',
  );
  assert.deepEqual(groups.map((g) => g.type), ['cities', 'places', QUERY_GROUP_TYPE]);
});

test('getSubmitQuery returns null for entity rows and the query for completion rows', () => {
  const groups = mapSuggestionsToGroups(
    [
      sug({ label: 'Paris', entityType: 'city', entityId: 'c1' }),
      sug({ type: 'completion', label: 'paris cafes' }),
    ],
    'par',
  );
  const city = groups.find((g) => g.type === 'cities')!.items[0];
  const q = groups.find((g) => g.type === QUERY_GROUP_TYPE)!.items[0];
  assert.equal(getSubmitQuery(city), null);
  assert.equal(getSubmitQuery(q), 'paris cafes');
});

// ── §21 smart actions are lifted to the action lane, NOT the search groups ─────

test('an add_to_trip row is NOT rendered as a city entity row (it dispatches, not navigates)', () => {
  // The gateway's add_to_trip row carries a /city route + city identity, which
  // would otherwise mis-map to a "cities" entity row that navigates to the city
  // page. It must be skipped here so the action-chip lane owns it.
  const groups = mapSuggestionsToGroups(
    [
      sug({ label: 'Bangkok', entityType: 'city', entityId: 'c_real' }), // a real city entity
      sug({
        id: 'add',
        type: 'action',
        label: 'Add Bangkok to your trip',
        entityType: 'city',
        entityId: 'c_bkk',
        subtitle: 'Thailand',
        action: { type: 'add_to_trip', entityId: 'c_bkk' },
        destination: { route: '/city/bangkok', entityType: 'city', entityId: 'c_bkk' },
      }),
    ],
    'bang',
  );
  const allIds = allRows(groups).map((r) => r.id);
  assert.equal(allIds.includes('add'), false, 'the add_to_trip row is not in any search group');
  assert.equal(allIds.includes('c_real'), true, 'the real city entity still renders');
  // Only the real city entity group survives — no duplicate "cities" row for the action.
  const cities = groups.find((g) => g.type === 'cities');
  assert.equal(cities!.items.length, 1);
});

// ── staged / sequenced rows render in order (§18 sequence) ────────────────────

test('sequenced stage rows (submit_search) render as ordered "Search for" rows', () => {
  // buildSequencedRows emits one submit_search row per stage, in order; the
  // mapper must preserve that order within the query group.
  const groups = mapSuggestionsToGroups(
    [
      sug({ id: 's1', type: 'action', label: '1. Dinner', action: { type: 'submit_search', query: 'dinner' } }),
      sug({ id: 's2', type: 'action', label: '2. Nightlife', action: { type: 'submit_search', query: 'nightlife' } }),
      sug({ id: 's3', type: 'action', label: '3. Late-night food', action: { type: 'submit_search', query: 'late night food' } }),
    ],
    'dinner then drinks then food',
  );
  const q = groups.find((g) => g.type === QUERY_GROUP_TYPE)!;
  assert.deepEqual(q.items.map((i) => getSubmitQuery(i)), ['dinner', 'nightlife', 'late night food']);
  assert.deepEqual(q.items.map((i) => i.title), ['1. Dinner', '2. Nightlife', '3. Late-night food']);
});
