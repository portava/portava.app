/**
 * mapSearch — the Map search sheet's field, request and envelope (census-discovery
 * §80, A08 reason 3, register D-W10-S1-5; DV-83, D-W10-S1-2).
 *
 * Pure logic — no React, no network, no token — under the node:test runner.
 *
 *   B  the body names the `map.search` field of `global_search`, and carries the
 *      position at the top level, where the gateway route reads it;
 *   R  the envelope becomes the rows the Map's adapter reads: only rows that
 *      carry a `mapResult`, in order, with their geometry intact;
 *   C  each lane's coverage survives the parse, tolerant of a malformed refusal
 *      the way `services/discovery.ts` `parseRefusal` is;
 *   A  the parsed rows go through the Map's own adapter to the same §27 results
 *      the route's rows did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_SEARCH_FIELD_ID,
  buildMapSearchBody,
  parseMapSearchEnvelope,
  parseMapSearchRefusal,
} from '../mapSearch.ts';
import { parseSuggestBody } from '../../services/suggestResponse.ts';
import { toMapSearchResults } from '../../../../features/map/search/searchAdapter.ts';

const row = (id: string, serverType: string, title: string, metadata: Record<string, unknown> | null) => ({
  id: `global_search:${serverType}:${id}`,
  type: 'entity',
  context: 'global_search',
  label: title,
  entityType: 'place',
  entityId: id,
  action: { type: 'open_entity', entityType: 'place', entityId: id },
  source: 'canonical',
  policyVersion: 'input-2026-08',
  mapResult: {
    serverType, subtitle: 'food', locationPreview: 'Lisbon', destinationRoute: `/place/${id}`, startsAt: null, metadata,
  },
});

test('B1: the body names the map.search field of global_search and puts the position at the top level', () => {
  assert.equal(MAP_SEARCH_FIELD_ID, 'map.search');
  assert.deepEqual(buildMapSearchBody('kopi', { lat: 1.3, lng: 103.8, city: ' Singapore ' }), {
    context: 'global_search', fieldId: 'map.search', text: 'kopi', sessionContext: { surface: 'map' },
    lat: 1.3, lng: 103.8, city: 'Singapore',
  });
});

test('B2: an absent or non-finite position is omitted, never sent as null or NaN', () => {
  const b = buildMapSearchBody('kopi', { lat: Number.NaN, city: '  ' });
  assert.ok(!('lat' in b) && !('lng' in b) && !('city' in b));
});

test('R1: rows come from mapResult, in order; a row without one is not a search-page row', () => {
  const page = parseMapSearchEnvelope({
    suggestions: [
      row('p1', 'places', 'Kopi One', { lat: 1.3, lng: 103.8 }),
      { id: 'global_search:completion:kopi', type: 'completion', label: 'Search for "kopi"' },
      row('s1', 'saved', 'Kopi Saved', { savedKind: 'place', lat: 1.31, lng: 103.81 }),
    ],
  });
  assert.deepEqual(page.results.map((r) => [r.type, r.id]), [['places', 'p1'], ['saved', 's1']]);
  assert.deepEqual(page.results[1]!.metadata, { savedKind: 'place', lat: 1.31, lng: 103.81 });
  assert.equal(page.results[0]!.destinationRoute, '/place/p1');
  assert.equal(page.refusal, undefined);
  assert.equal(page.savedRefusal, undefined);
});

test('C1: each lane\'s coverage survives, and a malformed refusal is no refusal', () => {
  const page = parseMapSearchEnvelope({
    suggestions: [],
    refusal: { class: 'transient_db', code: 'search_sources_unreadable', route: 'POST /input-assistance/suggest', coverage: 'partial', failedSources: ['hashtags', 7] },
    laneRefusals: { saved: { class: 'transient_db', code: 'search_failed', route: 'x', coverage: 'nothing' } },
  });
  assert.equal(page.refusal?.coverage, 'partial');
  assert.deepEqual(page.refusal?.failedSources, ['hashtags']);
  assert.equal(page.savedRefusal?.coverage, 'nothing');
  assert.equal(parseMapSearchRefusal('refused'), undefined);
  assert.equal(parseMapSearchRefusal({ code: 'x' }), undefined);
  assert.equal(parseMapSearchRefusal({ class: 'a', code: 'b', coverage: 'weird' })?.coverage, 'nothing', 'anything but partial reads as the stronger claim');
});

test('C2: the typeahead envelope carries its refusal through parseSuggestBody, and nothing when absent', () => {
  const r = { class: 'transient_db', code: 'visibility_state_unreadable', route: 'POST /input-assistance/suggest', coverage: 'nothing' };
  assert.deepEqual(parseSuggestBody({ requestId: 'r', suggestions: [], refusal: r }).refusal, r);
  assert.ok(!('refusal' in parseSuggestBody({ requestId: 'r', suggestions: [] })));
});

test('A1: the parsed rows reach the Map adapter as the same §27 results the route rows did', () => {
  const page = parseMapSearchEnvelope({ suggestions: [row('p1', 'places', 'Kopi One', { lat: 1.3, lng: 103.8 })] });
  const viaGateway = toMapSearchResults(page.results);
  const viaRoute = toMapSearchResults([{
    id: 'p1', type: 'places', title: 'Kopi One', subtitle: 'food', locationPreview: 'Lisbon',
    destinationRoute: '/place/p1', startsAt: null, metadata: { lat: 1.3, lng: 103.8, hostId: 'ignored' },
  }]);
  assert.deepEqual(viaGateway, viaRoute);
});
