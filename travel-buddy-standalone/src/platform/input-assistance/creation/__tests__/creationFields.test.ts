/**
 * Phase 5 (Creation) — creation field registration (§5, §52).
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerCreationFields,
  CREATION_FIELD_IDS,
  CREATION_FIELD_CONTEXTS,
  _resetCreationRegistration,
} from '../creationFields.ts';
import {
  resolveFieldPolicy,
  isFieldRegistered,
  unregisterField,
} from '../../contexts/fieldRegistry.ts';
import { GEO_FIELD_IDS } from '../../geographic/geoFields.ts';

test('registerCreationFields registers each creation name/title field in its context', () => {
  _resetCreationRegistration();
  for (const fieldId of Object.keys(CREATION_FIELD_CONTEXTS)) unregisterField(fieldId);

  registerCreationFields();

  const gem = resolveFieldPolicy(CREATION_FIELD_IDS.gemName);
  assert.ok(gem, 'gem.name should be registered');
  assert.equal(gem!.context, 'hidden_gem_name');
  // Duplicate detection + validation ride the gem-name stream (§20/§23/§55).
  assert.ok(gem!.allowedSuggestionTypes.includes('disambiguation'));
  assert.ok(gem!.allowedSuggestionTypes.includes('validation'));

  const event = resolveFieldPolicy(CREATION_FIELD_IDS.eventTitle);
  assert.equal(event!.context, 'event_title');

  for (const [fieldId, context] of Object.entries(CREATION_FIELD_CONTEXTS)) {
    assert.ok(isFieldRegistered(fieldId), `${fieldId} should be registered`);
    assert.equal(resolveFieldPolicy(fieldId)!.context, context);
  }
});

test('registerCreationFields is idempotent (a second call is a no-op)', () => {
  _resetCreationRegistration();
  registerCreationFields();
  const before = resolveFieldPolicy(CREATION_FIELD_IDS.tripTitle);
  registerCreationFields();
  const after = resolveFieldPolicy(CREATION_FIELD_IDS.tripTitle);
  assert.equal(before!.context, after!.context);
});

test('creation name/title ids do NOT collide with the geographic location ids', () => {
  // Location fields are owned by geoFields (gem.location / event.location /
  // trip.destination); creation registers only the name/title fields.
  const creationIds = new Set(Object.values(CREATION_FIELD_IDS) as string[]);
  const geoIds = Object.values(GEO_FIELD_IDS) as string[];
  for (const geoId of geoIds) {
    assert.equal(creationIds.has(geoId), false, `${geoId} must not be a creation field id`);
  }
});
