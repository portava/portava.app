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
import { dedupeSuggestions, capSuggestions, finalizeSuggestions } from '../suggestionRanking.ts';
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
