/**
 * Field registry + policy resolution tests (spec §5, §6, §44).
 *
 * Pure logic — no React, no network — so it runs under the node:test runner
 * (`pnpm test`), which auto-discovers src/ ** /*.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INPUT_CONTEXTS } from '../../types/inputContext.ts';
import { INPUT_CONTEXT_REGISTRY, INPUT_POLICY_VERSION } from '../inputContexts.ts';
import { buildDefaultPolicy, DEFAULT_DEBOUNCE_MS } from '../inputPolicies.ts';
import {
  registerField,
  resolveFieldPolicy,
  isFieldRegistered,
  unregisterField,
  registeredFieldIds,
  _resetRegistry,
} from '../fieldRegistry.ts';

test('every InputContext has exactly one registry descriptor', () => {
  for (const ctx of INPUT_CONTEXTS) {
    const d = INPUT_CONTEXT_REGISTRY[ctx];
    assert.ok(d, `missing descriptor for ${ctx}`);
    assert.equal(d.context, ctx, `descriptor.context mismatch for ${ctx}`);
  }
  // No stray keys beyond the union.
  assert.equal(Object.keys(INPUT_CONTEXT_REGISTRY).length, INPUT_CONTEXTS.length);
});

test('buildDefaultPolicy derives a coherent default from the context descriptor', () => {
  const p = buildDefaultPolicy('trip.destination', 'trip_destination');
  assert.equal(p.fieldId, 'trip.destination');
  assert.equal(p.context, 'trip_destination');
  assert.equal(p.mode, 'canonical_picker');
  assert.equal(p.debounceMs, DEFAULT_DEBOUNCE_MS);
  assert.ok(p.minChars >= 0);
  assert.ok(Array.isArray(p.allowedSuggestionTypes));
  // Public field → telemetry may capture text.
  assert.equal(p.telemetryPolicy.captureRawText, true);
});

test('private_message context never captures raw text in telemetry (§44)', () => {
  const p = buildDefaultPolicy('telegraph.message', 'telegraph_message');
  assert.equal(p.privacyClass, 'private_message');
  assert.equal(p.telemetryPolicy.captureRawText, false);
});

test('overriding privacyClass re-derives the telemetry policy', () => {
  // A public context overridden to sensitive must flip captureRawText off.
  const p = buildDefaultPolicy('gem.location', 'place_picker', { privacyClass: 'sensitive' });
  assert.equal(p.privacyClass, 'sensitive');
  assert.equal(p.telemetryPolicy.captureRawText, false);
});

test('overrides are shallow-merged and cannot change fieldId/context', () => {
  const p = buildDefaultPolicy('username', 'username', {
    maxSuggestions: 3,
    minChars: 3,
    // Attempt to override identity fields — must be ignored.
    fieldId: 'hacked' as unknown as string,
    context: 'generic_text',
  });
  assert.equal(p.fieldId, 'username');
  assert.equal(p.context, 'username');
  assert.equal(p.maxSuggestions, 3);
  assert.equal(p.minChars, 3);
});

test('registerField stores, resolveFieldPolicy reads, unregisterField removes', () => {
  _resetRegistry();
  assert.equal(isFieldRegistered('event.location'), false);

  const registered = registerField('event.location', 'event_location');
  assert.equal(registered.context, 'event_location');
  assert.equal(isFieldRegistered('event.location'), true);

  const resolved = resolveFieldPolicy('event.location');
  assert.ok(resolved);
  assert.equal(resolved!.fieldId, 'event.location');
  assert.deepEqual(registeredFieldIds(), ['event.location']);

  unregisterField('event.location');
  assert.equal(isFieldRegistered('event.location'), false);
  assert.equal(resolveFieldPolicy('event.location'), null);
});

test('resolveFieldPolicy returns an ephemeral policy for a fallback context without registering', () => {
  _resetRegistry();
  const ephemeral = resolveFieldPolicy('never.registered', 'city_picker');
  assert.ok(ephemeral);
  assert.equal(ephemeral!.context, 'city_picker');
  // It must NOT have been stored (migration aid, not a silent registration).
  assert.equal(isFieldRegistered('never.registered'), false);
});

test('resolveFieldPolicy returns null for an unknown field with no fallback (fail-safe)', () => {
  _resetRegistry();
  assert.equal(resolveFieldPolicy('unknown.field'), null);
});

test('policy version constant matches the spec projection example', () => {
  assert.equal(INPUT_POLICY_VERSION, 'input-2026-08');
});
