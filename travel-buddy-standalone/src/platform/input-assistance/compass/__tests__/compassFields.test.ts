/**
 * Phase 7 (Compass + AI) — compass + writing field registration (§5, §52).
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registerCompassFields,
  COMPASS_FIELD_IDS,
  COMPASS_FIELD_CONTEXTS,
  AI_WRITING_FIELD_IDS,
  AI_WRITING_FIELD_CONTEXTS,
  _resetCompassRegistration,
} from '../compassFields.ts';
import {
  resolveFieldPolicy,
  isFieldRegistered,
  unregisterField,
} from '../../contexts/fieldRegistry.ts';

function freshRegister() {
  _resetCompassRegistration();
  for (const id of Object.keys(COMPASS_FIELD_CONTEXTS)) unregisterField(id);
  for (const id of Object.keys(AI_WRITING_FIELD_CONTEXTS)) unregisterField(id);
  registerCompassFields();
}

test('registerCompassFields registers every compass + writing field in its context', () => {
  freshRegister();

  for (const [fieldId, context] of Object.entries(COMPASS_FIELD_CONTEXTS)) {
    assert.ok(isFieldRegistered(fieldId), `${fieldId} should be registered`);
    assert.equal(resolveFieldPolicy(fieldId)!.context, context);
  }
  for (const [fieldId, context] of Object.entries(AI_WRITING_FIELD_CONTEXTS)) {
    assert.ok(isFieldRegistered(fieldId), `${fieldId} should be registered`);
    assert.equal(resolveFieldPolicy(fieldId)!.context, context);
  }
});

test('the compass prompt policy is AI-assisted, opt-in-capable, and accepts ai_suggestion', () => {
  freshRegister();
  const prompt = resolveFieldPolicy(COMPASS_FIELD_IDS.compassPrompt);
  assert.ok(prompt);
  assert.equal(prompt!.context, 'compass_prompt');
  assert.equal(prompt!.mode, 'ai_assisted');
  assert.equal(prompt!.allowAI, true);
  assert.ok(prompt!.allowedSuggestionTypes.includes('ai_suggestion'));
});

test('the caption + event_description writing fields allow AI writing', () => {
  freshRegister();
  const caption = resolveFieldPolicy(AI_WRITING_FIELD_IDS.caption);
  assert.equal(caption!.context, 'caption');
  assert.equal(caption!.allowAI, true);
  assert.ok(caption!.allowedSuggestionTypes.includes('ai_suggestion'));

  const desc = resolveFieldPolicy(AI_WRITING_FIELD_IDS.eventDescription);
  assert.equal(desc!.context, 'event_description');
  assert.equal(desc!.allowAI, true);
  assert.ok(desc!.allowedSuggestionTypes.includes('ai_suggestion'));
});

test('registerCompassFields is idempotent (a second call is a no-op)', () => {
  freshRegister();
  const before = resolveFieldPolicy(COMPASS_FIELD_IDS.compassPrompt);
  registerCompassFields();
  const after = resolveFieldPolicy(COMPASS_FIELD_IDS.compassPrompt);
  assert.equal(before!.context, after!.context);
});
