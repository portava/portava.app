/**
 * Phase 5 (Creation) — duplicate detection (§8 → DuplicateCandidate, §20/§55).
 *
 * Pure logic — no React/network — runs under the node:test runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapDuplicateCandidates,
  suggestionToDuplicate,
  hasLikelyDuplicate,
  duplicateKindsForContext,
  GEM_DUPLICATE_KINDS,
  EVENT_DUPLICATE_KINDS,
} from '../duplicateDetection.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    type: over.type ?? 'entity',
    context: over.context ?? 'hidden_gem_name',
    label: over.label ?? 'Blue Bottle Cave',
    source: over.source ?? 'canonical',
    policyVersion: over.policyVersion ?? 'input-2026-08',
    ...over,
  };
}

test('surfaces an existing Gem candidate for a gem-name creation stream (§55)', () => {
  const rows = mapDuplicateCandidates(
    [
      sug({
        label: 'Blue Bottle Cave',
        subtitle: 'Da Nang, Vietnam',
        entityType: 'hidden_gem',
        entityId: 'gem_123',
        reason: 'Same name nearby',
        confidence: 0.82,
        destination: { route: '/hidden-gem/gem_123', entityType: 'hidden_gem', entityId: 'gem_123' },
      }),
    ],
    { allowedKinds: GEM_DUPLICATE_KINDS },
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].entityId, 'gem_123');
  assert.equal(rows[0].entityType, 'hidden_gem');
  assert.equal(rows[0].label, 'Blue Bottle Cave');
  assert.equal(rows[0].subtitle, 'Da Nang, Vietnam');
  assert.equal(rows[0].reason, 'Same name nearby');
  assert.equal(rows[0].confidence, 0.82);
  assert.equal(rows[0].route, '/hidden-gem/gem_123');
  assert.equal(hasLikelyDuplicate(rows), true);
});

test('resolves identity from an open_entity action when top-level id is absent', () => {
  const cand = suggestionToDuplicate(
    sug({
      label: 'Batang Sunset Point',
      type: 'disambiguation',
      action: { type: 'open_entity', entityType: 'place', entityId: 'place_9' },
    }),
    GEM_DUPLICATE_KINDS,
  );
  assert.ok(cand);
  assert.equal(cand!.entityId, 'place_9');
  assert.equal(cand!.entityType, 'place');
});

test('drops non-entity rows (completion / action / correction / validation) — no dead duplicate rows', () => {
  const rows = mapDuplicateCandidates(
    [
      sug({ type: 'completion', label: 'Blue Bottle', replacementText: 'Blue Bottle' }),
      sug({ type: 'correction', label: 'Did you mean Phu Quoc?' }),
      sug({ type: 'validation', label: 'This may already exist' }),
      sug({ type: 'action', label: 'Drop a pin', action: { type: 'drop_pin' } }),
      sug({ type: 'entity', label: 'Real Gem', entityType: 'hidden_gem', entityId: 'gem_ok' }),
    ],
    { allowedKinds: GEM_DUPLICATE_KINDS },
  );
  assert.deepEqual(rows.map((r) => r.entityId), ['gem_ok']);
});

test('drops entities whose kind is not allowed for the surface', () => {
  // A user/trip/event is not a Gem duplicate; only Gem/Place are allowed here.
  const rows = mapDuplicateCandidates(
    [
      sug({ label: 'A person', entityType: 'user', entityId: 'user_x' }),
      sug({ label: 'An event', entityType: 'event', entityId: 'ev_x' }),
      sug({ label: 'A place', entityType: 'place', entityId: 'place_x' }),
    ],
    { allowedKinds: GEM_DUPLICATE_KINDS },
  );
  assert.deepEqual(rows.map((r) => r.entityId), ['place_x']);
});

test('event creation accepts Event + Place candidates', () => {
  const rows = mapDuplicateCandidates(
    [
      sug({ context: 'event_title', label: 'Sunset Hike', entityType: 'event', entityId: 'ev_1' }),
      sug({ context: 'event_title', label: 'Mount Batang', entityType: 'place', entityId: 'pl_1' }),
      sug({ context: 'event_title', label: 'A gem', entityType: 'hidden_gem', entityId: 'gem_1' }),
    ],
    { allowedKinds: EVENT_DUPLICATE_KINDS },
  );
  assert.deepEqual(rows.map((r) => r.entityType), ['event', 'place']);
});

test('de-duplicates by entity, keeping the first (highest-ranked) occurrence', () => {
  const rows = mapDuplicateCandidates(
    [
      sug({ label: 'Cave (canonical)', entityType: 'hidden_gem', entityId: 'gem_1', source: 'canonical' }),
      sug({ label: 'Cave (recent)', type: 'recent', entityType: 'hidden_gem', entityId: 'gem_1', source: 'recent' }),
    ],
    { allowedKinds: GEM_DUPLICATE_KINDS },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Cave (canonical)');
  assert.equal(rows[0].source, 'canonical');
});

test('caps the candidate list at the requested limit', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    sug({ label: `Gem ${i}`, entityType: 'hidden_gem', entityId: `gem_${i}` }),
  );
  const rows = mapDuplicateCandidates(many, { allowedKinds: GEM_DUPLICATE_KINDS, limit: 3 });
  assert.equal(rows.length, 3);
});

test('degrade path: empty / nullish stream ⇒ no candidates, no throw', () => {
  assert.deepEqual(mapDuplicateCandidates([]), []);
  assert.deepEqual(mapDuplicateCandidates(null), []);
  assert.deepEqual(mapDuplicateCandidates(undefined), []);
  assert.equal(hasLikelyDuplicate([]), false);
});

test('duplicateKindsForContext maps each creation context to its allowed kinds', () => {
  assert.deepEqual([...duplicateKindsForContext('hidden_gem_name')], ['hidden_gem', 'place']);
  assert.deepEqual([...duplicateKindsForContext('event_title')], ['event', 'place']);
  assert.deepEqual([...duplicateKindsForContext('event_location')], ['event', 'place']);
  assert.deepEqual([...duplicateKindsForContext('place_picker')], ['place', 'hidden_gem']);
});
