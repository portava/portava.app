/**
 * Phase 2 (Geographic Core) — §19 progressive disambiguation tiers.
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyGeoDisambiguation } from '../geoDisambiguation.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

function cand(confidence: number, label = 'Paris'): InputSuggestion {
  return {
    id: `${label}-${confidence}`,
    type: 'entity',
    context: 'city_picker',
    label,
    source: 'canonical',
    confidence,
    policyVersion: 'input-2026-08',
  };
}

test('empty candidates → very_low, no auto-select', () => {
  const r = classifyGeoDisambiguation([]);
  assert.equal(r.tier, 'very_low');
  assert.equal(r.top, null);
  assert.equal(r.autoSelect, false);
});

test('a lone strong candidate → high (direct, auto-select)', () => {
  const r = classifyGeoDisambiguation([cand(0.95, 'Da Nang')]);
  assert.equal(r.tier, 'high');
  assert.equal(r.autoSelect, true);
  assert.equal(r.top!.label, 'Da Nang');
});

test('a clear winner over a weak runner-up → high', () => {
  // Paris, France (0.92) clearly beats Paris, Texas (0.4).
  const r = classifyGeoDisambiguation([cand(0.4, 'Paris, TX'), cand(0.92, 'Paris, FR')]);
  assert.equal(r.tier, 'high');
  assert.equal(r.top!.label, 'Paris, FR'); // sorted highest-first
});

test('two close viable choices → medium (show the disambiguation sheet)', () => {
  // Paris, France (0.8) vs Paris, Texas (0.72): both viable, no clear winner.
  const r = classifyGeoDisambiguation([cand(0.8, 'Paris, FR'), cand(0.72, 'Paris, TX')]);
  assert.equal(r.tier, 'medium');
  assert.equal(r.autoSelect, false);
  assert.equal(r.candidates.length, 2);
});

test('a weak top → low (offer suggestions, keep raw search prominent)', () => {
  const r = classifyGeoDisambiguation([cand(0.45, 'Parys')]);
  assert.equal(r.tier, 'low');
  assert.equal(r.autoSelect, false);
});

test('a near-zero top → very_low (never auto-replace)', () => {
  const r = classifyGeoDisambiguation([cand(0.1, 'Parys')]);
  assert.equal(r.tier, 'very_low');
});

test('candidates are returned sorted by confidence, highest first', () => {
  const r = classifyGeoDisambiguation([cand(0.3, 'C'), cand(0.9, 'A'), cand(0.6, 'B')]);
  assert.deepEqual(r.candidates.map((c) => c.label), ['A', 'B', 'C']);
});
