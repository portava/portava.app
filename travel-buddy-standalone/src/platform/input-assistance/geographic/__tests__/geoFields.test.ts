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

test('registerGeographicFields registers every geographic field with its context', () => {
  _resetGeographicRegistration();
  // Clean slate for the fields we assert on.
  for (const fieldId of Object.keys(GEO_FIELD_CONTEXTS)) unregisterField(fieldId);

  registerGeographicFields();

  const tripPolicy = resolveFieldPolicy(GEO_FIELD_IDS.tripDestination);
  assert.ok(tripPolicy, 'trip.destination should be registered');
  assert.equal(tripPolicy!.context, 'trip_destination');
  assert.equal(tripPolicy!.mode, 'canonical_picker');

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
