/**
 * Phase 2 (Geographic Core) — geographic field registration (§5, §52).
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerGeographicFields,
  GEO_FIELD_IDS,
  GEO_FIELD_CONTEXTS,
  _resetGeographicRegistration,
} from '../geoFields.ts';
import { resolveFieldPolicy, isFieldRegistered, unregisterField } from '../../contexts/fieldRegistry.ts';

// ── SEEDED 2026-09-21 (G340) ────────────────────────────────────────────────
// `registerField` derives its policy from the context descriptor, which now
// comes from the authority rather than from a local table. Without a seeded
// policy every context resolves conservative (`no_assistance`), which is the
// correct cold-start answer and makes any assertion about a context's MODE
// vacuous. Seeding states the premise these tests were always relying on:
// "the authority has answered, and permits assistance here".
import { INPUT_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests } from '../../services/policyStore.ts';
import { getContextDescriptor } from '../../contexts/inputContexts.ts';
_seedPolicyForTests(INPUT_CONTEXTS);


test('registerGeographicFields registers every geographic field with its context', () => {
  _resetGeographicRegistration();
  // Clean slate for the fields we assert on.
  for (const fieldId of Object.keys(GEO_FIELD_CONTEXTS)) unregisterField(fieldId);

  registerGeographicFields();

  const tripPolicy = resolveFieldPolicy(GEO_FIELD_IDS.tripDestination);
  assert.ok(tripPolicy, 'trip.destination should be registered');
  assert.equal(tripPolicy!.context, 'trip_destination');
  // The MODE is the authority's to state, not this test's. Asserting a
  // literal here would put a 30th copy of the policy in a test file — the
  // thing G340 deleted. What this file is actually for is the fieldId → context
  // MAPPING, which is genuinely the client's, and that is still asserted above.
  assert.equal(tripPolicy!.mode, getContextDescriptor('trip_destination').defaultMode);

  // Every declared geographic field resolves to a policy in its declared context.
  for (const [fieldId, context] of Object.entries(GEO_FIELD_CONTEXTS)) {
    assert.ok(isFieldRegistered(fieldId), `${fieldId} should be registered`);
    assert.equal(resolveFieldPolicy(fieldId)!.context, context);
  }
});

test('registerGeographicFields is idempotent (a second call is a no-op)', () => {
  _resetGeographicRegistration();
  registerGeographicFields();
  const before = resolveFieldPolicy(GEO_FIELD_IDS.eventLocation);
  registerGeographicFields(); // must not throw or duplicate
  const after = resolveFieldPolicy(GEO_FIELD_IDS.eventLocation);
  assert.equal(before!.context, after!.context);
});
