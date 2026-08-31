/**
 * Phase 4 (Social Identity) — Telegraph recipient mapping (§8 → RecipientRow).
 *
 * Pure logic — no React/network — runs under the node:test runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapRecipientSuggestions,
  suggestionToRecipient,
} from '../telegraphRecipients.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    type: over.type ?? 'entity',
    context: over.context ?? 'telegraph_recipient',
    label: over.label ?? 'Maya Torres',
    source: over.source ?? 'canonical',
    policyVersion: over.policyVersion ?? 'input-2026-08',
    ...over,
  };
}

test('maps a user suggestion into a recipient row', () => {
  const rows = mapRecipientSuggestions([
    sug({
      label: 'Maya Torres',
      subtitle: '@maya',
      entityType: 'user',
      entityId: 'user_maya',
      reason: 'Trip Crew',
      source: 'recent',
    }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 'user_maya');
  assert.equal(rows[0].name, 'Maya Torres');
  assert.equal(rows[0].handle, 'maya');
  assert.equal(rows[0].subtitle, '@maya');
  assert.equal(rows[0].reason, 'Trip Crew');
  assert.equal(rows[0].source, 'recent');
});

test('resolves the user id from an open_entity action when top-level id is absent', () => {
  const row = suggestionToRecipient(
    sug({
      label: '@skylar',
      action: { type: 'open_entity', entityType: 'user', entityId: 'user_skylar' },
    }),
  );
  assert.ok(row);
  assert.equal(row!.userId, 'user_skylar');
  // Handle is extracted from a leading-@ label when no subtitle carries one.
  assert.equal(row!.handle, 'skylar');
});

test('drops suggestions with no resolvable user id (never a dead row)', () => {
  const rows = mapRecipientSuggestions([
    sug({ label: 'A place', entityType: 'place', entityId: 'place_x' }),
    sug({ label: 'No identity at all', entityType: undefined, entityId: undefined }),
    sug({ label: 'Maya', entityType: 'user', entityId: 'user_maya' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 'user_maya');
});

test('trusts the backend list: keeps every eligible user, does not re-filter', () => {
  // Two eligible users the backend already vetted — both survive unchanged.
  const rows = mapRecipientSuggestions([
    sug({ label: 'A', entityType: 'user', entityId: 'user_a' }),
    sug({ label: 'B', entityType: 'user', entityId: 'user_b' }),
  ]);
  assert.deepEqual(rows.map((r) => r.userId), ['user_a', 'user_b']);
});

test('de-duplicates by userId keeping the first (highest-ranked) occurrence', () => {
  const rows = mapRecipientSuggestions([
    sug({ label: 'Maya (recent)', entityType: 'user', entityId: 'user_maya', source: 'recent' }),
    sug({ label: 'Maya (search)', entityType: 'user', entityId: 'user_maya', source: 'provider' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Maya (recent)');
  assert.equal(rows[0].source, 'recent');
});

test('falls back to the handle then the id when the label is empty', () => {
  const withHandle = suggestionToRecipient(
    sug({ label: '', subtitle: '@ghost', entityType: 'user', entityId: 'user_ghost' }),
  );
  assert.equal(withHandle!.name, '@ghost');

  const idOnly = suggestionToRecipient(
    sug({ label: '', subtitle: undefined, entityType: 'user', entityId: 'user_x' }),
  );
  assert.equal(idOnly!.name, 'user_x');
});

test('degrade path: empty / nullish suggestion lists yield no rows, never throw', () => {
  assert.deepEqual(mapRecipientSuggestions([]), []);
  assert.deepEqual(mapRecipientSuggestions(null), []);
  assert.deepEqual(mapRecipientSuggestions(undefined), []);
});

test('reads avatarUrl from the projection structuredValue bag when present', () => {
  const row = suggestionToRecipient(
    sug({
      label: 'Maya',
      entityType: 'user',
      entityId: 'user_maya',
      structuredValue: { avatarUrl: 'https://cdn.example/a.jpg' },
    }),
  );
  assert.equal(row!.avatarUrl, 'https://cdn.example/a.jpg');
});
