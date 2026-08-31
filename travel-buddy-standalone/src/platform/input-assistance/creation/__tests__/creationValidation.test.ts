/**
 * Phase 5 (Creation) — §23 validation-row mapping (§8 → CreationValidationView).
 *
 * Pure logic — no React/network — runs under the node:test runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapCreationValidation,
  suggestionToValidation,
  kindFromRule,
} from '../creationValidation.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    type: over.type ?? 'validation',
    context: over.context ?? 'hidden_gem_name',
    label: over.label ?? '',
    source: over.source ?? 'canonical',
    policyVersion: over.policyVersion ?? 'input-2026-08',
    ...over,
  };
}

test('city-country mismatch → a correction the user may accept (§23)', () => {
  const view = mapCreationValidation([
    sug({
      type: 'validation',
      structuredValue: { kind: 'city_country_match' },
      reason: 'Da Nang is in Vietnam, not Thailand.',
      replacementText: 'Vietnam',
    }),
  ]);
  assert.ok(view);
  assert.equal(view!.kind, 'city_country_mismatch');
  assert.equal(view!.message, 'Da Nang is in Vietnam, not Thailand.');
  assert.equal(view!.correctionText, 'Vietnam');
  assert.equal(view!.acceptLabel, 'Use canonical');
});

test('trip date conflict → an explanation, preserving user control (no forced fix)', () => {
  const view = mapCreationValidation([
    sug({
      context: 'trip_title',
      type: 'validation',
      structuredValue: { kind: 'date_conflict' },
      reason: 'These dates overlap your Tokyo trip.',
    }),
  ]);
  assert.ok(view);
  assert.equal(view!.kind, 'date_conflict');
  assert.equal(view!.message, 'These dates overlap your Tokyo trip.');
  // No canonical text to apply → info-only, no accept affordance (non-blocking).
  assert.equal(view!.correctionText, null);
  assert.equal(view!.acceptLabel, null);
});

test('unresolved address stays info-only (map-pin/nearby/raw fallback is the screen’s, §23)', () => {
  const view = mapCreationValidation([
    sug({
      context: 'event_location',
      type: 'validation',
      structuredValue: { kind: 'address_resolvable' },
      replacementText: '123 Real St', // even with text, no single "use this"
    }),
  ]);
  assert.ok(view);
  assert.equal(view!.kind, 'unresolved_address');
  assert.equal(view!.acceptLabel, null);
});

test('invalid hashtag → normalization explanation with the canonical form to apply', () => {
  const view = mapCreationValidation([
    sug({
      context: 'hashtag',
      type: 'correction',
      label: '#night life',
      structuredValue: { kind: 'hashtag_format' },
      action: { type: 'replace_text', text: '#nightlife' },
    }),
  ]);
  assert.ok(view);
  assert.equal(view!.kind, 'invalid_hashtag');
  assert.equal(view!.correctionText, '#nightlife');
  assert.equal(view!.acceptLabel, 'Use this');
});

test('a high-confidence hard validation reads as tone "error"; a soft one as "warning"', () => {
  const hard = suggestionToValidation(
    sug({ type: 'validation', structuredValue: { kind: 'username_available' }, confidence: 0.98 }),
  );
  assert.equal(hard!.kind, 'invalid_handle');
  assert.equal(hard!.tone, 'error');

  const soft = suggestionToValidation(
    sug({ type: 'validation', structuredValue: { kind: 'duplicate_entity' }, confidence: 0.5 }),
  );
  assert.equal(soft!.tone, 'warning');
});

test('falls back to a §23-faithful default message when the projection carries none', () => {
  const view = suggestionToValidation(
    sug({ type: 'validation', structuredValue: { kind: 'city_country_match' } }),
  );
  assert.equal(view!.message, 'That city may not be in that country.');
});

test('a validation row wins over a correction row when both are present', () => {
  const view = mapCreationValidation([
    sug({ type: 'correction', label: 'minor correction' }),
    sug({ type: 'validation', structuredValue: { kind: 'date_conflict' }, reason: 'overlap' }),
  ]);
  assert.equal(view!.kind, 'date_conflict');
});

test('non-validation rows never map to a banner', () => {
  assert.equal(suggestionToValidation(sug({ type: 'entity', label: 'A place' })), null);
  assert.equal(suggestionToValidation(sug({ type: 'completion', label: 'Blue' })), null);
});

test('degrade path: a stream with no validation/correction ⇒ null (no banner), no throw', () => {
  assert.equal(mapCreationValidation([]), null);
  assert.equal(mapCreationValidation(null), null);
  assert.equal(mapCreationValidation(undefined), null);
  assert.equal(
    mapCreationValidation([sug({ type: 'entity', label: 'X', entityType: 'place', entityId: 'p' })]),
    null,
  );
});

test('kindFromRule maps every §6 ValidationRule kind used by creation', () => {
  assert.equal(kindFromRule('duplicate_entity'), 'duplicate');
  assert.equal(kindFromRule('city_country_match'), 'city_country_mismatch');
  assert.equal(kindFromRule('date_conflict'), 'date_conflict');
  assert.equal(kindFromRule('address_resolvable'), 'unresolved_address');
  assert.equal(kindFromRule('hashtag_format'), 'invalid_hashtag');
  assert.equal(kindFromRule('username_available'), 'invalid_handle');
  assert.equal(kindFromRule('required'), 'generic');
});
