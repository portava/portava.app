/**
 * Phase 3 (Global Search) — search field registration (§5, §52).
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerSearchFields,
  SEARCH_FIELD_IDS,
  SEARCH_FIELD_CONTEXTS,
  _resetSearchRegistration,
} from '../searchFields.ts';
import { resolveFieldPolicy, isFieldRegistered, unregisterField } from '../../contexts/fieldRegistry.ts';

test('registerSearchFields registers discovery.search in the global_search context', () => {
  _resetSearchRegistration();
  for (const fieldId of Object.keys(SEARCH_FIELD_CONTEXTS)) unregisterField(fieldId);

  registerSearchFields();

  const policy = resolveFieldPolicy(SEARCH_FIELD_IDS.globalSearch);
  assert.ok(policy, 'discovery.search should be registered');
  assert.equal(policy!.context, 'global_search');
  assert.equal(policy!.mode, 'search'); // §13 grouped search, not a picker
  assert.equal(policy!.privacyClass, 'public');
  assert.equal(policy!.minChars, 2);

  for (const [fieldId, context] of Object.entries(SEARCH_FIELD_CONTEXTS)) {
    assert.ok(isFieldRegistered(fieldId), `${fieldId} should be registered`);
    assert.equal(resolveFieldPolicy(fieldId)!.context, context);
  }
});

test('registerSearchFields is idempotent (a second call is a no-op)', () => {
  _resetSearchRegistration();
  registerSearchFields();
  const before = resolveFieldPolicy(SEARCH_FIELD_IDS.globalSearch);
  registerSearchFields(); // must not throw or duplicate
  const after = resolveFieldPolicy(SEARCH_FIELD_IDS.globalSearch);
  assert.equal(before!.context, after!.context);
});
