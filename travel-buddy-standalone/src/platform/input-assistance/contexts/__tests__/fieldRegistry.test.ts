/**
 * Field registry + policy resolution tests (spec §5, §6, §44).
 *
 * Pure logic — no React, no network — so it runs under the node:test runner
 * (`pnpm test`), which auto-discovers src/ ** /*.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INPUT_CONTEXTS } from '../../types/inputContext.ts';
import { getContextDescriptor, inputPolicyVersion, conservativeDescriptor } from '../inputContexts.ts';
import {
  sharedPolicyStore,
  _seedPolicyForTests,
  _PERMISSIVE_TEST_POLICY,
} from '../../services/policyStore.ts';
import { buildDefaultPolicy, DEFAULT_DEBOUNCE_MS } from '../inputPolicies.ts';
import {
  registerField,
  resolveFieldPolicy,
  isFieldRegistered,
  unregisterField,
  registeredFieldIds,
  _resetRegistry,
} from '../fieldRegistry.ts';

// ── REWRITTEN 2026-09-21 (G340) ─────────────────────────────────────────────
//
// This file used to assert against `INPUT_CONTEXT_REGISTRY`, the client's local
// 29-context table. That table is gone: the server is the authority, and a
// client-side assertion about what `city_picker`'s mode SHOULD be would be the
// second source of truth all over again, just expressed as a test.
//
// What is asserted now is the client's actual contract, which is narrower and
// more useful: given the authority says X, the resolver produces X — and given
// no authority, it produces something that grants nothing.

test('every InputContext resolves, with no authority, to a descriptor that grants nothing', () => {
  sharedPolicyStore.clear();
  sharedPolicyStore.setActiveAccount(null);
  for (const ctx of INPUT_CONTEXTS) {
    const d = getContextDescriptor(ctx);
    assert.equal(d.context, ctx, `descriptor.context mismatch for ${ctx}`);
    assert.equal(d.authoritative, false, `${ctx} must not claim authority before a fetch`);
    assert.deepEqual(d, conservativeDescriptor(ctx), `${ctx} must be exactly the conservative descriptor`);
  }
});

test('every InputContext resolves to what the AUTHORITY said, once it has said it', () => {
  _seedPolicyForTests(INPUT_CONTEXTS, { city_picker: { minChars: 1, mode: 'canonical_picker' } });
  for (const ctx of INPUT_CONTEXTS) {
    const d = getContextDescriptor(ctx);
    assert.equal(d.authoritative, true, `${ctx} should have resolved from the seeded table`);
    assert.equal(d.context, ctx);
  }
  const city = getContextDescriptor('city_picker');
  assert.equal(city.defaultMode, 'canonical_picker', 'the per-context override must win');
  assert.equal(city.minChars, 1);
  const other = getContextDescriptor('trip_title');
  assert.equal(other.defaultMode, _PERMISSIVE_TEST_POLICY.mode, 'un-overridden contexts take the template');
  sharedPolicyStore.clear();
});

test('buildDefaultPolicy derives a coherent default from the context descriptor', () => {
  // Seeded, because the descriptor it derives from now comes from the
  // authority. `canonical_picker` is asserted as the SEEDED value, not as a
  // fact about `trip_destination` — what that context's real mode is, is the
  // server's to say.
  _seedPolicyForTests(['trip_destination'], { trip_destination: { mode: 'canonical_picker' } });
  const p = buildDefaultPolicy('trip.destination', 'trip_destination');
  assert.equal(p.fieldId, 'trip.destination');
  assert.equal(p.context, 'trip_destination');
  assert.equal(p.mode, 'canonical_picker');
  assert.equal(p.debounceMs, DEFAULT_DEBOUNCE_MS);
  assert.ok(p.minChars >= 0);
  assert.ok(Array.isArray(p.allowedSuggestionTypes));
  // §44/G33 — the shape is the server's, and the server sets `logRawText`
  // false on every one of its 29 contexts. A `public` class buys the FULL
  // event vocabulary, not permission to log the user's typed text.
  assert.equal(p.telemetryPolicy.logRawText, false);
  assert.ok(p.telemetryPolicy.events.includes('suggestion_rendered'));
});

test('private_message context never captures raw text in telemetry (§44)', () => {
  const p = buildDefaultPolicy('telegraph.message', 'telegraph_message');
  assert.equal(p.privacyClass, 'private_message');
  assert.equal(p.telemetryPolicy.logRawText, false);
  // And it gets the NARROWED vocabulary, mirroring the server's
  // METADATA_ONLY_TELEMETRY — not merely the same list with a flag off.
  assert.deepEqual(p.telemetryPolicy.events, [
    'suggestion_request_completed',
    'suggestion_selected',
    'action_completed',
  ]);
});

test('overriding privacyClass re-derives the telemetry policy', () => {
  // A public context overridden to sensitive_location must not keep the public
  // context's derived telemetry policy.
  const p = buildDefaultPolicy('gem.location', 'place_picker', { privacyClass: 'sensitive_location' });
  assert.equal(p.privacyClass, 'sensitive_location');
  assert.equal(p.telemetryPolicy.logRawText, false);
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

test('the reported policy version is what the client HOLDS, not what it was built against', () => {
  // The constant this replaced (`INPUT_POLICY_VERSION = 'input-2026-08'`) was
  // baked in at build time, so the one field designed to detect client/server
  // skew always reported agreement. Nothing could have made it report a skew.
  sharedPolicyStore.clear();
  sharedPolicyStore.setActiveAccount(null);
  assert.equal(inputPolicyVersion(), 'unfetched', 'with no table held, it must say so');

  _seedPolicyForTests(['city_picker'], {}, sharedPolicyStore, 'input-2026-12');
  assert.equal(inputPolicyVersion(), 'input-2026-12');
  sharedPolicyStore.clear();
});
