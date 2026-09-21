/**
 * Phase 7 (Compass + AI) — compass-prompt starters (§56, §14), as the SHARED
 * LAYER serves them (census-compass CG-01 / census-input-intelligence G359).
 *
 * The client no longer builds a starter list of its own: the server's
 * `COMPASS_STARTER_SET` is served through the gateway, and this module only
 * adapts the served rows to chips. These cases pin the adapter — and that no
 * curated list survives here.
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startersFromSuggestions, isCompassPromptContext } from '../compassPrompt.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function served(over: Partial<InputSuggestion> & { starterId?: string | null } = {}): InputSuggestion {
  const { starterId = null, ...rest } = over;
  return {
    id: 'compass_prompt:ai:0',
    type: 'ai_suggestion',
    context: 'compass_prompt',
    label: 'Right now',
    replacementText: 'What should I do right now?',
    action: { type: 'replace_text', text: 'What should I do right now?' },
    structuredValue: { kind: 'compass_prompt', surface: 'compass', starterId },
    confidence: 0.5,
    source: 'ai',
    reason: 'Suggested prompt',
    policyVersion: 'test',
    ...rest,
  } as InputSuggestion;
}

test('served ai_suggestion rows become chips: server label, full prompt, stable id from starterId', () => {
  const chips = startersFromSuggestions([
    served({ starterId: 'right_now' }),
    served({ id: 'compass_prompt:ai:1', label: 'Tonight', replacementText: 'What should I do tonight?', starterId: 'tonight' }),
  ]);
  assert.deepEqual(chips, [
    { id: 'right_now', label: 'Right now', prompt: 'What should I do right now?' },
    { id: 'tonight', label: 'Tonight', prompt: 'What should I do tonight?' },
  ]);
});

test('a contextual starter with no starterId keys on the served id; a missing label falls back to the prompt', () => {
  const chips = startersFromSuggestions([served({ id: 'compass_prompt:ai:3', label: '', replacementText: 'Where should I eat in Da Nang?' })]);
  assert.deepEqual(chips, [{ id: 'compass_prompt:ai:3', label: 'Where should I eat in Da Nang?', prompt: 'Where should I eat in Da Nang?' }]);
});

test('only ai_suggestion rows with a replacement text are starters; duplicates by id collapse; order is the server\'s', () => {
  const chips = startersFromSuggestions([
    served({ id: 'e1', type: 'entity', label: 'Han Market', replacementText: 'Han Market' } as any),
    served({ id: 'c1', type: 'completion', replacementText: 'What should' } as any),
    served({ starterId: 'right_now' }),
    served({ id: 'dup', starterId: 'right_now' }),
    served({ id: 'blank', replacementText: '   ' }),
  ]);
  assert.deepEqual(chips.map((c) => c.id), ['right_now']);
});

test('nothing served ⇒ no chips, never a list of this module\'s own', () => {
  assert.deepEqual(startersFromSuggestions(null), []);
  assert.deepEqual(startersFromSuggestions(undefined), []);
  assert.deepEqual(startersFromSuggestions([]), []);
});

test('the client carries NO curated starter list (the server\'s COMPASS_STARTER_SET is the one)', () => {
  const src = readFileSync(join(HERE, '..', 'compassPrompt.ts'), 'utf8');
  assert.doesNotMatch(src, /What should I do right now\?/);
  assert.doesNotMatch(src, /buildCompassStarters/);
  assert.doesNotMatch(src, /COMPASS_STARTERS\b/);
});

test('isCompassPromptContext', () => {
  assert.equal(isCompassPromptContext('compass_prompt'), true);
  assert.equal(isCompassPromptContext('global_search' as any), false);
});
