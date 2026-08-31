/**
 * Phase 2 (Geographic Core) — geographic query matching (§10).
 *
 * Proves the Đ/đ stroke-fold + alias behavior the geographic path relies on:
 *   danang → Đà Nẵng   (non-decomposing stroke letter folded)
 *   hcmc   → Ho Chi Minh City   (alias)
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchesGeographicQuery } from '../../services/queryNormalization.ts';

test('matchesGeographicQuery: đ/diacritic-insensitive prefix match', () => {
  // "danang" (no stroke, no diacritics) matches "Đà Nẵng".
  assert.equal(matchesGeographicQuery('danang', 'Đà Nẵng'), true);
  // A leading fragment matches.
  assert.equal(matchesGeographicQuery('da', 'Đà Nẵng'), true);
  // A non-prefix fragment does not.
  assert.equal(matchesGeographicQuery('nang', 'Đà Nẵng'), false);
});

test('matchesGeographicQuery: alias resolution (hcmc / saigon → Ho Chi Minh City)', () => {
  assert.equal(matchesGeographicQuery('hcmc', 'Ho Chi Minh City'), true);
  assert.equal(matchesGeographicQuery('HCMC', 'Ho Chi Minh City'), true); // case-insensitive
  assert.equal(matchesGeographicQuery('saigon', 'Ho Chi Minh City'), true);
});

test('matchesGeographicQuery: an empty query never matches', () => {
  assert.equal(matchesGeographicQuery('', 'Da Nang'), false);
  assert.equal(matchesGeographicQuery('   ', 'Da Nang'), false);
});

test('matchesGeographicQuery: unrelated query does not match', () => {
  assert.equal(matchesGeographicQuery('bangkok', 'Đà Nẵng'), false);
});
