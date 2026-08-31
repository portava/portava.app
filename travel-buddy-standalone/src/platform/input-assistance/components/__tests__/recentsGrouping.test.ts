/**
 * Phase 8 (Personalization) — zero-character recents render as a "Recent" group
 * (spec §14 zero-char assistance / §35 selection memory).
 *
 * Pure logic — runs under node:test. The gateway returns a user's prior explicit
 * selections as `type: 'recent'` suggestions on an empty field; the SDK panel
 * must surface them under their own "Recent" header rather than folding them into
 * their entity-type group (Cities), so the user's recents read as recents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupSuggestions, defaultLabelFor } from '../suggestionGrouping.ts';
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

test('recent-typed suggestions render under a "Recent" group, not their entity group', () => {
  const sections = groupSuggestions([
    sug({ id: 'r1', type: 'recent', entityType: 'city', label: 'Bangkok' }),
    sug({ id: 'r2', type: 'recent', entityType: 'country', label: 'Thailand' }),
  ]);
  // All recents collapse into ONE "Recent" section (regardless of entity type).
  assert.equal(sections.length, 1);
  assert.equal(sections[0].label, 'Recent');
  assert.equal(sections[0].suggestions.length, 2);
  assert.equal(defaultLabelFor('recent'), 'Recent');
});

test('recents form a distinct group above fresh entity groups', () => {
  const sections = groupSuggestions([
    sug({ id: 'r1', type: 'recent', entityType: 'city', label: 'Bangkok' }),
    sug({ id: 'c1', type: 'entity', entityType: 'city', label: 'Chiang Mai' }),
  ]);
  // The recent city must NOT merge into "Cities" — the two are separate groups.
  const labels = sections.map((s) => s.label);
  assert.deepEqual(labels, ['Recent', 'Cities']);
  assert.equal(sections[0].suggestions[0].id, 'r1');
  assert.equal(sections[1].suggestions[0].id, 'c1');
});

test('non-recent grouping is unchanged (entity type still drives the group)', () => {
  const sections = groupSuggestions([
    sug({ id: 'c1', type: 'entity', entityType: 'city', label: 'Bangkok' }),
    sug({ id: 'u1', type: 'entity', entityType: 'user', label: 'Ann' }),
  ]);
  assert.deepEqual(sections.map((s) => s.label), ['Cities', 'People']);
});
