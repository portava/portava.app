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
// The overrides are this test's PREMISE, not a restatement of the server's
// table: each names the restriction the case exists to prove the client
// honours. Seeding them here is what makes the assertions non-vacuous.
_seedPolicyForTests(INPUT_CONTEXTS, {
  telegraph_recipient: { privacyClass: 'viewer_scoped', entityTypes: ['user'] },
});


test('registerSocialFields registers telegraph.recipient in the telegraph_recipient context', () => {
  _resetSocialRegistration();
  for (const fieldId of Object.keys(SOCIAL_FIELD_CONTEXTS)) unregisterField(fieldId);

  registerSocialFields();

  const policy = resolveFieldPolicy(SOCIAL_FIELD_IDS.telegraphRecipient);
  assert.ok(policy, 'telegraph.recipient should be registered');
  assert.equal(policy!.context, 'telegraph_recipient');
  // Authority-derived, not a literal — see geoFields.test.ts for the reasoning.
  assert.equal(policy!.mode, getContextDescriptor('telegraph_recipient').defaultMode);
  // Account-enumeration-resistant recipient search is a personal-privacy field.
  assert.equal(policy!.privacyClass, 'viewer_scoped');
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
