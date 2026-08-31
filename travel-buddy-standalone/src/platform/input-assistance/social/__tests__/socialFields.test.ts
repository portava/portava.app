/**
 * Phase 4 (Social Identity) — social field registration (§5, §52).
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerSocialFields,
  SOCIAL_FIELD_IDS,
  SOCIAL_FIELD_CONTEXTS,
  _resetSocialRegistration,
} from '../socialFields.ts';
import { resolveFieldPolicy, isFieldRegistered, unregisterField } from '../../contexts/fieldRegistry.ts';

test('registerSocialFields registers telegraph.recipient in the telegraph_recipient context', () => {
  _resetSocialRegistration();
  for (const fieldId of Object.keys(SOCIAL_FIELD_CONTEXTS)) unregisterField(fieldId);

  registerSocialFields();

  const policy = resolveFieldPolicy(SOCIAL_FIELD_IDS.telegraphRecipient);
  assert.ok(policy, 'telegraph.recipient should be registered');
  assert.equal(policy!.context, 'telegraph_recipient');
  assert.equal(policy!.mode, 'search'); // recipient search, not a picker
  // Account-enumeration-resistant recipient search is a personal-privacy field.
  assert.equal(policy!.privacyClass, 'personal');
  assert.deepEqual(policy!.entityTypes, ['user']);
  // minChars override → zero-state recents/crew/followed at 0 chars (§14).
  assert.equal(policy!.minChars, 0);

  for (const [fieldId, context] of Object.entries(SOCIAL_FIELD_CONTEXTS)) {
    assert.ok(isFieldRegistered(fieldId), `${fieldId} should be registered`);
    assert.equal(resolveFieldPolicy(fieldId)!.context, context);
  }
});

test('registerSocialFields is idempotent (a second call is a no-op)', () => {
  _resetSocialRegistration();
  registerSocialFields();
  const before = resolveFieldPolicy(SOCIAL_FIELD_IDS.telegraphRecipient);
  registerSocialFields(); // must not throw or duplicate
  const after = resolveFieldPolicy(SOCIAL_FIELD_IDS.telegraphRecipient);
  assert.equal(before!.minChars, after!.minChars);
});
