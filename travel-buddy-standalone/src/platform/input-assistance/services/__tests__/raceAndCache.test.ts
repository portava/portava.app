/**
 * Race guard + suggestion cache + normalization + ranking tests
 * (spec §33 race safety / SWR, §10 normalization, §20/§36 dedupe).
 *
 * Pure logic — no React/network — runs under the node:test runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSequenceGuard } from '../raceGuard.ts';
import { SuggestionCache } from '../suggestionCache.ts';
import { foldForMatch, resolveLocalAlias, isFoldedPrefix } from '../queryNormalization.ts';
import {
  dedupeSuggestions,
  capSuggestions,
  finalizeSuggestions,
  narrowToQuery,
} from '../suggestionRanking.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    type: over.type ?? 'entity',
    context: over.context ?? 'global_search',
    label: over.label ?? 'X',
    source: over.source ?? 'canonical',
    policyVersion: 'input-2026-08',
    ...over,
  };
}

// ── race guard (§33 "older response must never replace newer text") ───────────

test('sequence guard: only the latest request is current', () => {
  const g = createSequenceGuard();
  const a = g.next();
  const b = g.next();
  assert.equal(g.isCurrent(a), false, 'older request must be stale');
  assert.equal(g.isCurrent(b), true, 'latest request must be current');
});

test('sequence guard: an out-of-order (older) response is rejected', () => {
  const g = createSequenceGuard();
  const first = g.next(); // keystroke 1
  const second = g.next(); // keystroke 2 supersedes
  // Simulate first response arriving AFTER second was issued.
  assert.equal(g.isCurrent(first), false);
  // Second response arrives and is accepted.
  assert.equal(g.isCurrent(second), true);
});

test('sequence guard: invalidate() makes all in-flight requests stale', () => {
  const g = createSequenceGuard();
  const s = g.next();
  g.invalidate(); // e.g. field cleared / disabled / unmounted
  assert.equal(g.isCurrent(s), false);
});

// ── SWR cache (§33) ───────────────────────────────────────────────────────────

test('cache: serves fresh entries and expires past TTL', () => {
  let now = 1_000;
  const cache = new SuggestionCache({ ttlMs: 100, max: 10 }, () => now);
  const key = SuggestionCache.key('discovery.search', 'sky');
  cache.set(key, [sug({ label: 'Sky36' })]);

  assert.ok(cache.get(key), 'fresh entry should be served');
  now += 50;
  assert.ok(cache.get(key), 'still fresh within TTL');
  now += 100;
  assert.equal(cache.get(key), null, 'expired entry must not be served');
});

test('cache key: coord jitter under ~1km does not bust the key', () => {
  const a = SuggestionCache.key('f', 'da', 16.0544, 108.2022);
  const b = SuggestionCache.key('f', 'DA ', 16.0548, 108.2019); // case + <1km drift
  assert.equal(a, b, 'folded query + rounded coords must produce the same key');
});

test('cache: LRU eviction drops the oldest, keeps the most-recently-used', () => {
  const cache = new SuggestionCache({ ttlMs: 10_000, max: 2 }, () => 0);
  cache.set('k1', [sug()]);
  cache.set('k2', [sug()]);
  // Touch k1 so it becomes most-recent, then insert k3 → k2 should be evicted.
  assert.ok(cache.get('k1'));
  cache.set('k3', [sug()]);
  assert.ok(cache.get('k1'), 'recently-used entry survives');
  assert.ok(cache.get('k3'), 'newest entry present');
  assert.equal(cache.get('k2'), null, 'least-recently-used entry evicted');
});

// ── normalization (§10) ───────────────────────────────────────────────────────

test('foldForMatch: case + diacritic + stroke-letter + whitespace insensitive', () => {
  // đ (D-with-stroke) does not decompose under NFKD; foldForMatch still folds it.
  assert.equal(foldForMatch('  Đà  Nẵng '), 'da nang');
  // Precomposed diacritics DO decompose (ú, ố).
  assert.equal(foldForMatch('Phú Quốc'), 'phu quoc');
  // The important invariant: divergent spellings fold to the same key.
  assert.equal(foldForMatch('Đà Nẵng'), foldForMatch('da nang'));
});

test('resolveLocalAlias: known aliases map to canonical display; unknown stays null', () => {
  assert.equal(resolveLocalAlias('danang'), 'Đà Nẵng');
  assert.equal(resolveLocalAlias('HCMC'), 'Ho Chi Minh City');
  assert.equal(resolveLocalAlias('saigon'), 'Ho Chi Minh City');
  assert.equal(resolveLocalAlias('somewhere unknown'), null);
});

test('isFoldedPrefix: diacritic-insensitive prefix match', () => {
  assert.equal(isFoldedPrefix('da', 'Đà Nẵng'), true);
  assert.equal(isFoldedPrefix('nang', 'Đà Nẵng'), false);
  assert.equal(isFoldedPrefix('', 'anything'), false);
});

// ── ranking helpers (§20 dedupe, §33 cap) ─────────────────────────────────────

test('dedupeSuggestions: collapses same canonical entity, keeps first', () => {
  const list = [
    sug({ id: 'a', entityType: 'city', entityId: 'city_da_nang', label: 'first' }),
    sug({ id: 'b', entityType: 'city', entityId: 'city_da_nang', label: 'dup' }),
    sug({ id: 'c', entityType: 'city', entityId: 'city_da_lat', label: 'other' }),
  ];
  const out = dedupeSuggestions(list);
  assert.equal(out.length, 2);
  assert.equal(out[0].label, 'first');
  assert.equal(out[1].entityId, 'city_da_lat');
});

test('capSuggestions + finalizeSuggestions respect the max', () => {
  const list = Array.from({ length: 12 }, (_, i) => sug({ id: `s${i}`, entityId: `e${i}`, entityType: 'place' }));
  assert.equal(capSuggestions(list, 5).length, 5);
  assert.equal(capSuggestions(list, 0).length, 0);
  assert.equal(finalizeSuggestions(list, 8).length, 8);
});

// ── §33 tier 1 / §34 local prefix tier ────────────────────────────────────────
//
// MUTATION LOG (each applied, watched go red, reverted, `cmp` byte-identical):
//   - suggestionCache.longestPrefix: start the scan at `n = q.length` instead of
//     `q.length - 1` → the "exact key is the caller's SWR hit, not the prefix
//     tier" assertion goes red.
//   - suggestionCache.longestPrefix: scan `n` upward from 0 → the longest-prefix
//     assertion goes red (it returns the shortest cached prefix instead).
//   - suggestionRanking.narrowToQuery: drop the LOCALLY_REUSABLE_TYPES test →
//     the "a completion row is never reused for a longer query" assertion goes
//     red, because the stale `replacementText` survives.
//   - suggestionRanking.narrowToQuery: `return suggestions` unfiltered → the
//     "narrowing removes the rows that no longer match" assertion goes red.

test('cache.longestPrefix: returns the LONGEST cached strict prefix', () => {
  const cache = new SuggestionCache({ ttlMs: 10_000, max: 20 }, () => 0);
  cache.set(SuggestionCache.key('geo.city', 'b'), [sug({ label: 'B-answer' })]);
  cache.set(SuggestionCache.key('geo.city', 'ban'), [sug({ label: 'BAN-answer' })]);

  const hit = cache.longestPrefix('geo.city', 'bangk');
  assert.ok(hit, 'a cached prefix must be found');
  assert.equal(hit.query, 'ban', 'the LONGEST cached prefix wins, not the first found');
  assert.equal(hit.suggestions[0].label, 'BAN-answer');
});

test('cache.longestPrefix: the empty zero-state entry is a usable prefix', () => {
  const cache = new SuggestionCache({ ttlMs: 10_000, max: 20 }, () => 0);
  // The zero-character list a field caches under the empty query (§14).
  cache.set(SuggestionCache.key('geo.city', ''), [sug({ label: 'Bangkok' })]);
  const hit = cache.longestPrefix('geo.city', 'b');
  assert.ok(hit, 'a 1-character query must be servable from the zero-state entry');
  assert.equal(hit.query, '');
});

test('cache.longestPrefix: never returns the EXACT key (that is the SWR hit)', () => {
  const cache = new SuggestionCache({ ttlMs: 10_000, max: 20 }, () => 0);
  cache.set(SuggestionCache.key('geo.city', 'bang'), [sug({ label: 'exact' })]);
  assert.equal(cache.longestPrefix('geo.city', 'bang'), null, 'a strict prefix only');
});

test('cache.longestPrefix: an expired prefix entry is not served', () => {
  let now = 1_000;
  const cache = new SuggestionCache({ ttlMs: 100, max: 20 }, () => now);
  cache.set(SuggestionCache.key('geo.city', 'ban'), [sug({ label: 'BAN' })]);
  assert.ok(cache.longestPrefix('geo.city', 'bangk'), 'fresh prefix is served');
  now += 200;
  assert.equal(cache.longestPrefix('geo.city', 'bangk'), null, 'no stale-as-fresh prefix');
});

test('cache.longestPrefix: coords participate — a different place does not leak in', () => {
  const cache = new SuggestionCache({ ttlMs: 10_000, max: 20 }, () => 0);
  cache.set(SuggestionCache.key('geo.city', 'ba', 16.05, 108.2), [sug({ label: 'near Da Nang' })]);
  assert.ok(cache.longestPrefix('geo.city', 'bang', 16.05, 108.2));
  assert.equal(
    cache.longestPrefix('geo.city', 'bang', 13.75, 100.5),
    null,
    'a prefix cached at other coordinates must not be reused here',
  );
});

test('narrowToQuery: keeps the rows that still match, drops the rest', () => {
  const rows = [
    sug({ id: 'a', type: 'entity', label: 'Bangkok', entityType: 'city', entityId: 'c1' }),
    sug({ id: 'b', type: 'entity', label: 'Ban Phe', entityType: 'city', entityId: 'c2' }),
    sug({ id: 'c', type: 'entity', label: 'Battambang', entityType: 'city', entityId: 'c3' }),
  ];
  const out = narrowToQuery(rows, 'bangk');
  assert.deepEqual(out.map((s) => s.label), ['Bangkok'], 'only the still-matching row survives');
  // Substring match, not prefix — the server's own ilike %q% semantics.
  assert.deepEqual(
    narrowToQuery(rows, 'tamb').map((s) => s.label),
    ['Battambang'],
  );
});

test('narrowToQuery: folds diacritics and resolves a local alias', () => {
  const rows = [
    sug({ id: 'a', type: 'entity', label: 'Đà Nẵng', entityType: 'city', entityId: 'c1' }),
    sug({ id: 'b', type: 'entity', label: 'Ho Chi Minh City', entityType: 'city', entityId: 'c2' }),
  ];
  assert.deepEqual(narrowToQuery(rows, 'danang').map((s) => s.label), ['Đà Nẵng']);
  // "hcmc" shares neither letters nor order with the label — only the alias map
  // connects them, which is why matchesGeographicQuery is consulted.
  assert.deepEqual(narrowToQuery(rows, 'hcmc').map((s) => s.label), ['Ho Chi Minh City']);
});

test('narrowToQuery: a completion / correction / AI row is NEVER reused', () => {
  const rows = [
    sug({ id: 'a', type: 'completion', label: 'Search for "ban"', replacementText: 'ban' }),
    sug({ id: 'b', type: 'correction', label: 'Did you mean ban?' }),
    sug({ id: 'c', type: 'validation', label: 'ban is too short' }),
    sug({ id: 'd', type: 'disambiguation', label: 'ban (city) or ban (block)?' }),
    sug({ id: 'e', type: 'action', label: 'Search ban' }),
    sug({ id: 'f', type: 'ai_suggestion', label: 'banana bread in ban' }),
  ];
  // Every label above CONTAINS the typed text, so only the type gate can drop them.
  assert.deepEqual(narrowToQuery(rows, 'ban'), [], 'query-derived rows must not outlive their query');
});

test('narrowToQuery: entity, recent, personalized and structured_value survive', () => {
  const rows = [
    sug({ id: 'a', type: 'entity', label: 'Bangkok', entityType: 'city', entityId: 'c1' }),
    sug({ id: 'b', type: 'recent', label: 'Bangkok Airport', entityType: 'place', entityId: 'p1' }),
    sug({ id: 'c', type: 'personalized', label: 'Bangrak', entityType: 'place', entityId: 'p2' }),
    sug({ id: 'd', type: 'structured_value', label: 'Bang Na', entityType: 'place', entityId: 'p3' }),
  ];
  assert.equal(narrowToQuery(rows, 'bang').length, 4, 'thing-rows are the reusable ones');
});

test('narrowToQuery: an empty query narrows to nothing (the zero-state is its own key)', () => {
  const rows = [sug({ id: 'a', type: 'entity', label: 'Bangkok', entityType: 'city', entityId: 'c1' })];
  assert.deepEqual(narrowToQuery(rows, ''), []);
  assert.deepEqual(narrowToQuery(rows, '   '), []);
});

test('narrowToQuery: is subtractive only — it never reorders or rewrites', () => {
  const rows = [
    sug({ id: 'a', type: 'entity', label: 'Bang Na', entityType: 'place', entityId: 'p1', confidence: 0.4 }),
    sug({ id: 'b', type: 'entity', label: 'Bangkok', entityType: 'city', entityId: 'c1', confidence: 0.99 }),
  ];
  const out = narrowToQuery(rows, 'bang');
  assert.deepEqual(out.map((s) => s.id), ['a', 'b'], 'server order is preserved, not re-ranked');
  assert.deepEqual(out[0], rows[0], 'rows are passed through byte-identical');
});
