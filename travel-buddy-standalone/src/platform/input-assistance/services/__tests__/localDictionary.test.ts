/**
 * §32/§34 — the OFFLINE LOCAL SURFACE, pure half (census G197, G198, G212,
 * G350, G13).
 *
 * These prove the RULES: which fields may be answered from a shipped artifact
 * at all, which artifact answers which field, what a local row may and may not
 * claim, and what happens when nothing matches. That the HOOK consults them
 * while the network is down is a separate, wiring assertion and lives in
 * hooks/__tests__/useInputAssistance.offline.component.test.tsx — "the logic is
 * right and nothing reaches it" is the exact state this layer was built to end
 * (`offlinePolicy` was enforced with nothing behind `static_dictionary`).
 *
 * MUTATION LOG — see the bottom of this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  offlineLocalRows,
  localDictionaryFor,
  SURFACE_ENTITY_CLASSES,
  type LocalDictionaryPolicy,
} from '../localDictionary.ts';
import { offlineSurfaceAllowed } from '../../contexts/policyFallback.ts';
import type { OfflineInputPolicy } from '../../types/inputContext.ts';
import { COUNTRY_DICTIONARY } from '../../data/countries.ts';
import { CITY_INDEX } from '../../data/cities.ts';
import { LANGUAGE_DICTIONARY } from '../../data/languages.ts';
import { INTEREST_DICTIONARY } from '../../data/interests.ts';
import { COUNTRY_CENTROIDS } from '../../../../lib/countryCentroids.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const COUNTRY_PICKER: LocalDictionaryPolicy = {
  context: 'country_picker',
  offlinePolicy: 'static_dictionary',
  privacyClass: 'public',
  entityTypes: ['country'],
  allowedSuggestionTypes: ['entity', 'recent'],
  maxSuggestions: 8,
};

const CITY_PICKER: LocalDictionaryPolicy = {
  context: 'city_picker',
  offlinePolicy: 'cached_local',
  privacyClass: 'public',
  entityTypes: ['city', 'country'],
  allowedSuggestionTypes: ['entity', 'recent'],
  maxSuggestions: 8,
};

const LANGUAGE_FIELD: LocalDictionaryPolicy = {
  context: 'language',
  offlinePolicy: 'static_dictionary',
  privacyClass: 'public',
  entityTypes: ['language'],
  allowedSuggestionTypes: ['entity'],
  maxSuggestions: 8,
};

const INTEREST_FIELD: LocalDictionaryPolicy = {
  context: 'interest',
  offlinePolicy: 'static_dictionary',
  privacyClass: 'public',
  entityTypes: ['interest'],
  allowedSuggestionTypes: ['entity'],
  maxSuggestions: 8,
};

/** `place_picker` — the authority declines an offline surface for it. */
const PLACE_PICKER: LocalDictionaryPolicy = {
  context: 'place_picker',
  offlinePolicy: 'server_required',
  privacyClass: 'public',
  entityTypes: ['place', 'city'],
  allowedSuggestionTypes: ['entity', 'recent', 'disambiguation', 'action', 'validation'],
  maxSuggestions: 8,
};

/** `display_name` — manual, no entity suggestions, ever. */
const DISPLAY_NAME: LocalDictionaryPolicy = {
  context: 'display_name',
  offlinePolicy: 'unavailable',
  privacyClass: 'viewer_scoped',
  entityTypes: [],
  allowedSuggestionTypes: [],
  maxSuggestions: 0,
};

const GLOBAL_SEARCH: LocalDictionaryPolicy = {
  context: 'global_search',
  offlinePolicy: 'cached_local',
  privacyClass: 'public',
  entityTypes: ['city', 'country', 'place', 'user'],
  allowedSuggestionTypes: ['entity', 'recent', 'completion', 'action'],
  maxSuggestions: 8,
};

const labels = (rows: readonly InputSuggestion[]) => rows.map((r) => r.label);

// ── the shipped artifacts themselves ────────────────────────────────────────

test('G197: the country dictionary is a real shipped artifact, not a stub', () => {
  assert.ok(COUNTRY_DICTIONARY.length > 200, `only ${COUNTRY_DICTIONARY.length} countries`);
  assert.ok(COUNTRY_DICTIONARY.some((c) => c.label === 'Thailand'));
  assert.ok(COUNTRY_DICTIONARY.some((c) => c.label === 'Czech Republic'));
});

test('G197: every country the PASSPORT MAP can pin is reachable in the dictionary', () => {
  // The pin that stops this becoming a second, drifting country list. Every key
  // of `lib/countryCentroids.ts` — the artifact that already shipped — must
  // resolve here, as a label or as an alias.
  const reachable = new Set<string>();
  for (const e of COUNTRY_DICTIONARY) {
    reachable.add(e.label.toLowerCase());
    for (const a of e.aliases ?? []) reachable.add(a.toLowerCase());
  }
  const missing = Object.keys(COUNTRY_CENTROIDS).filter((k) => !reachable.has(k.toLowerCase()));
  assert.deepEqual(missing, [], `unreachable country names: ${missing.join(', ')}`);
});

test('G198: the city index is compact and bounded — cities only, no regions', () => {
  assert.ok(CITY_INDEX.length > 150, `only ${CITY_INDEX.length} cities`);
  assert.ok(CITY_INDEX.length < 2000, `${CITY_INDEX.length} is not a COMPACT index`);
  const names = new Set(CITY_INDEX.map((c) => c.label));
  assert.ok(names.has('Bangkok'));
  // `REGION_CENTROIDS` and the country map live in the same source file and are
  // deliberately not read: a continent is not a city.
  for (const notACity of ['Europe', 'Southeast Asia', 'Asia', 'Latin America']) {
    assert.ok(!names.has(notACity), `${notACity} is not a city`);
  }
});

test('G197: languages and interests ship as dictionaries too', () => {
  assert.ok(LANGUAGE_DICTIONARY.length >= 30);
  assert.ok(INTEREST_DICTIONARY.length >= 30);
  assert.ok(LANGUAGE_DICTIONARY.some((l) => l.label === 'Vietnamese'));
  assert.ok(INTEREST_DICTIONARY.some((i) => i.label === 'Diving'));
});

// ── which artifact answers which field ──────────────────────────────────────

test('G212: the dictionary is chosen from the POLICY, not from a hard-coded field name', () => {
  assert.equal(localDictionaryFor(COUNTRY_PICKER)[0]?.source, COUNTRY_DICTIONARY);
  assert.equal(localDictionaryFor(LANGUAGE_FIELD)[0]?.source, LANGUAGE_DICTIONARY);
  assert.equal(localDictionaryFor(INTEREST_FIELD)[0]?.source, INTEREST_DICTIONARY);
  // A city field licenses BOTH the city index and the country dictionary,
  // because the authority declares `entityTypes: ['city', 'country']` for it.
  const city = localDictionaryFor(CITY_PICKER).map((d) => d.source);
  assert.ok(city.includes(CITY_INDEX));
  assert.ok(city.includes(COUNTRY_DICTIONARY));
});

test('§32: the surface map is keyed EXACTLY by the surfaces the authority licenses', () => {
  // This assertion carries the licence check that `localDictionaryFor` does
  // NOT duplicate as an `if`. Measured: deleting such an `if` changed no test
  // result at all, because the map lookup already answers `undefined` for an
  // unlicensed surface — so the coupling is asserted here instead of restated
  // in code that cannot fail. Adding `server_required` to that map reddens this
  // case AND the behavioural case below, which is what a real gate looks like.
  const ALL: OfflineInputPolicy[] = [
    'static_dictionary', 'cached_local', 'recent_only', 'server_required', 'unavailable',
  ];
  for (const surface of ALL) {
    assert.equal(
      surface in SURFACE_ENTITY_CLASSES,
      offlineSurfaceAllowed(surface),
      `${surface}: the dictionary map and the authority's licence disagree`,
    );
  }
  // And an unrecognised surface is not a key either — fail-closed by absence.
  assert.equal('crew_scoped_cache' in SURFACE_ENTITY_CLASSES, false);
});

test('§32: a field the authority marks server_required gets NO local dictionary', () => {
  assert.deepEqual(localDictionaryFor(PLACE_PICKER), []);
  assert.deepEqual(offlineLocalRows(PLACE_PICKER, 'bang', []), []);
});

test('§32: a server_required field does not even get its RETAINED rows back from here', () => {
  // The retained list is passed through by the hook; this function must not be
  // the thing that re-admits it for a field with no offline surface.
  const retained = [retainedCity('Bangkok', 'c1')];
  assert.deepEqual(offlineLocalRows(PLACE_PICKER, '', retained), []);
});

test('G5/display_name: a manual field is offered nothing, offline or on', () => {
  assert.deepEqual(localDictionaryFor(DISPLAY_NAME), []);
  assert.deepEqual(offlineLocalRows(DISPLAY_NAME, 'ann', []), []);
});

// ── what a local row may claim ──────────────────────────────────────────────

test('G13: a local row is DISTINGUISHABLE from a server row and claims no resolution', () => {
  const rows = offlineLocalRows(COUNTRY_PICKER, 'thai', []);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.label, 'Thailand');
  // The distinguishing mark in the projected result.
  assert.equal(r.source, 'local');
  // A resolution the server never returned would be a fabricated one.
  assert.equal(r.action, undefined);
  assert.equal(r.entityId, undefined);
  assert.equal(r.destination, undefined);
  assert.equal(r.canonicalUri, undefined);
  assert.equal(r.structuredValue, undefined);
  // And never a live claim (§31) — offline is when a stale label would hurt most.
  assert.equal(r.freshness, undefined);
  // It is still usable: accepting it puts the app's own display spelling in.
  assert.equal(r.replacementText, 'Thailand');
});

test('G350: an ALIAS finds the row and the DISPLAY spelling is what is offered', () => {
  const rows = offlineLocalRows(COUNTRY_PICKER, 'uk', []);
  assert.equal(labels(rows)[0], 'United Kingdom');
  assert.equal(rows[0]!.replacementText, 'United Kingdom');
});

test('§33: prefix matches come before mid-string matches', () => {
  const rows = offlineLocalRows(COUNTRY_PICKER, 'ind', []);
  assert.equal(labels(rows)[0], 'India');
  assert.ok(labels(rows).includes('Indonesia'));
  // "British Indian Ocean Territory" contains "ind" mid-string, so it may
  // appear — but never ahead of a country that STARTS with it.
  const first = labels(rows).indexOf('India');
  const mid = labels(rows).indexOf('British Indian Ocean Territory');
  if (mid >= 0) assert.ok(first < mid);
});

test('§29 fold: diacritics and case do not hide a row', () => {
  assert.equal(labels(offlineLocalRows(COUNTRY_PICKER, 'COTE', []))[0], "Côte d'Ivoire");
});

test('G198: a city query is answered from the compact index', () => {
  const rows = offlineLocalRows(CITY_PICKER, 'bangk', []);
  assert.equal(labels(rows)[0], 'Bangkok');
  assert.equal(rows[0]!.entityType, 'city');
  assert.equal(rows[0]!.source, 'local');
});

test('G198: the city ALIAS map ships with the index — "hcmc" finds Ho Chi Minh City', () => {
  assert.equal(labels(offlineLocalRows(CITY_PICKER, 'hcmc', []))[0], 'Ho Chi Minh City');
});

test('§33: the field cap is honoured', () => {
  const capped = offlineLocalRows({ ...COUNTRY_PICKER, maxSuggestions: 3 }, 'a', []);
  assert.equal(capped.length, 3);
  assert.deepEqual(offlineLocalRows({ ...COUNTRY_PICKER, maxSuggestions: 0 }, 'a', []), []);
});

test('§14: an EMPTY query is offered the head of the dictionary, not the whole of it', () => {
  const rows = offlineLocalRows(COUNTRY_PICKER, '', []);
  assert.equal(rows.length, COUNTRY_PICKER.maxSuggestions);
});

test('§2: a query that matches nothing invents nothing', () => {
  assert.deepEqual(offlineLocalRows(COUNTRY_PICKER, 'zzzzqqq', []), []);
});

// ── the ladder: retained rows first, then the artifact ──────────────────────

test('G241: RETAINED rows come first and a dictionary row never displaces one', () => {
  const retained = [retainedCity('Bangkok', 'c1')];
  const rows = offlineLocalRows(CITY_PICKER, 'ban', retained);
  assert.equal(rows[0]!.id, 'server-row:c1');
  assert.equal(rows[0]!.source, 'canonical');
});

test('G241: the same place is not offered twice — the retained row wins the dedupe', () => {
  const retained = [retainedCity('Bangkok', 'c1')];
  const rows = offlineLocalRows(CITY_PICKER, 'bangkok', retained);
  assert.deepEqual(labels(rows), ['Bangkok']);
  assert.equal(rows[0]!.source, 'canonical');
});

// ── the raw-query rung ──────────────────────────────────────────────────────

test('G350: offline with nothing matching, a search field still offers the RAW QUERY', () => {
  const rows = offlineLocalRows(GLOBAL_SEARCH, 'zzzzqqq', []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'completion');
  assert.equal(rows[0]!.replacementText, 'zzzzqqq');
  assert.deepEqual(rows[0]!.action, { type: 'submit_search', query: 'zzzzqqq' });
  assert.equal(rows[0]!.source, 'local');
});

test('G350: the raw-query rung obeys allowedSuggestionTypes — a PICKER gets none', () => {
  // `country_picker` does not allow `completion`, so the raw query is not a row
  // the authority licensed for it. Offering one would be the client deciding
  // what a field may show.
  assert.deepEqual(offlineLocalRows(COUNTRY_PICKER, 'zzzzqqq', []), []);
});

test('G350: the raw-query rung is LAST — it never displaces a real match', () => {
  const rows = offlineLocalRows(GLOBAL_SEARCH, 'bangk', []);
  assert.equal(labels(rows)[0], 'Bangkok');
  assert.equal(rows[rows.length - 1]!.type, 'completion');
});

// ── §29: the privacy gate, on the read side as well ─────────────────────────

test('§29: a field whose privacy class forbids local retention is answered from nothing', () => {
  // `telegraph_recipient` is viewer-scoped. Even if a future policy licensed an
  // offline surface for it, a local list may not be published around §29's
  // eligibility gate — so the gate is here too, not only in the hook.
  const viewerScoped: LocalDictionaryPolicy = {
    context: 'telegraph_recipient',
    offlinePolicy: 'recent_only',
    privacyClass: 'viewer_scoped',
    entityTypes: ['user'],
    allowedSuggestionTypes: ['entity', 'recent'],
    maxSuggestions: 8,
  };
  assert.deepEqual(offlineLocalRows(viewerScoped, 'al', [retainedCity('Alice', 'u1')]), []);
});

test('§32 fail-closed: an offline policy this build cannot name serves nothing', () => {
  const future = { ...COUNTRY_PICKER, offlinePolicy: 'crew_scoped_cache' as never };
  assert.deepEqual(offlineLocalRows(future, 'thai', []), []);
  assert.deepEqual(offlineLocalRows({ ...COUNTRY_PICKER, offlinePolicy: undefined }, 'thai', []), []);
});

test('§32: recent_only licenses RETAINED rows but never a dictionary', () => {
  const recentOnly: LocalDictionaryPolicy = { ...CITY_PICKER, offlinePolicy: 'recent_only' };
  assert.deepEqual(localDictionaryFor(recentOnly), []);
  const rows = offlineLocalRows(recentOnly, 'ban', [retainedCity('Bangkok', 'c1')]);
  assert.deepEqual(labels(rows), ['Bangkok']);
  assert.equal(rows[0]!.source, 'canonical');
});

function retainedCity(label: string, id: string): InputSuggestion {
  return {
    id: `server-row:${id}`,
    type: 'recent',
    context: 'city_picker',
    label,
    entityType: 'city',
    entityId: id,
    action: { type: 'open_entity', entityType: 'city', entityId: id },
    source: 'canonical',
    policyVersion: 'input-2026-08',
  };
}

/*
 * MUTATION LOG — each applied to the SHIPPED module, run, watched, reverted.
 * Baseline: 26/26 here, 76/76 across the nine input-assistance component files.
 *
 *  1. localDictionary.ts: delete gate 1 (`offlineSurfaceAllowed`) in
 *     `offlineLocalRows` → 25/26. "a server_required field does not even get
 *     its RETAINED rows back from here" goes red. The COMPONENT suite stays
 *     76/76, because the hook applies the same licence before calling — see 5.
 *  2. localDictionary.ts: add `server_required` to `SURFACE_ENTITY_CLASSES`
 *     → 24/26. Both "the surface map is keyed EXACTLY …" and "a field the
 *     authority marks server_required gets NO local dictionary" go red.
 *  3. localDictionary.ts: delete the §29 `isCacheablePrivacyClass` gate in
 *     `offlineLocalRows` → 25/26. The viewer-scoped case goes red.
 *  4. localDictionary.ts: `allows()` → `return true` → 21/26. Five go red,
 *     including both raw-query cases and the `recent_only` case.
 *  5. useInputAssistance.ts: drop the `mayRetain ?` gate on the offline arm →
 *     76/76 AND 26/26. IT DOES NOT LAND ALONE, and that is recorded rather
 *     than hidden: since `offlineLocalRows` re-applies the same licence, the
 *     two are each other's backstop. Removing BOTH (5 + 1) → 75/76, and
 *     removing all three server_required defences (5 + 1 + 2) → 74/76, with
 *     both `server_required` component cases red. That last run is what makes
 *     those two assertions non-vacuous.
 *  6. localDictionary.ts: `dictionaryRow` gains `entityId`, an `open_entity`
 *     action and `source: 'canonical'` → 24/26 here and 73/76 component. This
 *     is G13's mutation: a local row asserting a resolution nobody gave it.
 *  7. localDictionary.ts: `rows` starts empty instead of `[...retained]`
 *     → 23/26 here and 72/76 component — including both restated assertions in
 *     the other lanes' files, which is how those were re-proven after being
 *     rewritten.
 *  8. localDictionary.ts: `RANK_EXACT_ALIAS = 3` (an exact alias demoted below
 *     a label prefix) → 25/26; "uk" starts offering Ukraine first.
 *     NOT LANDED, recorded: merely swapping the ORDER of the two checks
 *     without changing the rank values leaves every test green — the ranks are
 *     the contract, the check order is not.
 *  9. data/countries.ts: drop the `Ivory Coast` alias → 25/26. The
 *     passport-map pin goes red, which is the point of it.
 * 10. data/cities.ts: fold `REGION_CENTROIDS` into the index → 25/26. "cities
 *     only, no regions" goes red.
 * 11. useInputAssistance.ts: call `offlineLocalRows` from the TRANSIENT-error
 *     arm as well → 75/76. "a TRANSIENT error is not offline" goes red.
 */
