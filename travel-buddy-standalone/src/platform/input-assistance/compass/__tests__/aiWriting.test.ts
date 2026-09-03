/**
 * Phase 7 (Compass + AI) — AI-writing projection (§22, §2, §38).
 *
 * Pure logic — runs under node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_WRITING_CONTEXTS,
  isAiWritingContext,
  isAiTextContext,
  isAiSuggestion,
  toAiWritingProposal,
  mapAiWritingSuggestions,
  partitionCanonicalAndAi,
  orderCanonicalFirst,
} from '../aiWriting.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const POLICY = 'input-2026-08';

function aiRow(overrides: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: 'caption:aiwrite:0',
    type: 'ai_suggestion',
    context: 'caption',
    label: 'Golden hour over the rice terraces 🌾',
    replacementText: 'Golden hour over the rice terraces 🌾',
    action: { type: 'replace_text', text: 'Golden hour over the rice terraces 🌾' },
    confidence: 0.4,
    source: 'ai',
    reason: 'AI-suggested draft',
    policyVersion: POLICY,
    ...overrides,
  };
}

function entityRow(overrides: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: 'city:danang',
    type: 'entity',
    context: 'global_search',
    label: 'Da Nang',
    entityType: 'city',
    entityId: 'danang',
    source: 'canonical',
    policyVersion: POLICY,
    ...overrides,
  };
}

test('an ai_suggestion maps to a provenance-marked tap-to-insert proposal (never auto-applied)', () => {
  const p = toAiWritingProposal(aiRow());
  assert.ok(p, 'a valid ai_suggestion should map to a proposal');
  // §8 provenance-marked.
  assert.equal(p!.provenance, 'ai');
  // §22 the insert text is the editable replacement — a proposal, not a commit.
  assert.equal(p!.insertText, 'Golden hour over the rice terraces 🌾');
  assert.equal(p!.text, 'Golden hour over the rice terraces 🌾');
  // §22 NO auto-apply / auto-commit affordance exists on the view-model — the
  // only path to the field is the consumer handling a tap via insertText.
  assert.equal('autoApply' in (p as object), false);
  assert.equal('commit' in (p as object), false);
  assert.equal('applied' in (p as object), false);
  assert.equal('submit' in (p as object), false);
  // The originating suggestion is carried for telemetry / §43 dispatch.
  assert.equal(p!.suggestion.type, 'ai_suggestion');
});

test('the insert text falls back to the replace_text action, then the label', () => {
  const fromAction = toAiWritingProposal(
    aiRow({ replacementText: undefined, action: { type: 'replace_text', text: 'From action' } }),
  );
  assert.equal(fromAction!.insertText, 'From action');

  const fromLabel = toAiWritingProposal(
    aiRow({ replacementText: undefined, action: undefined, label: 'From label' }),
  );
  assert.equal(fromLabel!.insertText, 'From label');
});

test('a canonical (non-AI) row is NEVER lifted into an AI proposal', () => {
  assert.equal(toAiWritingProposal(entityRow()), null);
  // A row typed ai_suggestion but not sourced 'ai' is also rejected (provenance
  // must be genuine, §8).
  assert.equal(toAiWritingProposal(aiRow({ source: 'canonical' })), null);
});

test('an ai row with no insertable text is dropped (no dead affordance)', () => {
  const empty = toAiWritingProposal(
    aiRow({ replacementText: undefined, action: undefined, label: '' }),
  );
  assert.equal(empty, null);
});

test('degrade: no ai rows ⇒ [] and never throws (flag-off path)', () => {
  assert.deepEqual(mapAiWritingSuggestions([]), []);
  assert.deepEqual(mapAiWritingSuggestions(null), []);
  assert.deepEqual(mapAiWritingSuggestions(undefined), []);
  // A list of ONLY canonical rows (what an off-flag gateway returns) yields nothing extra.
  assert.deepEqual(mapAiWritingSuggestions([entityRow(), entityRow({ id: 'x' })]), []);
});

test('mapAiWritingSuggestions keeps only ai rows, preserving order', () => {
  const list = [entityRow(), aiRow({ id: 'a1' }), entityRow({ id: 'e2' }), aiRow({ id: 'a2' })];
  const proposals = mapAiWritingSuggestions(list);
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals.map((p) => p.id), ['a1', 'a2']);
});

test('AI is SECONDARY: orderCanonicalFirst puts every canonical row before every AI row', () => {
  // Adversarial input: an AI row placed FIRST must still sort after canonical.
  const list = [aiRow({ id: 'a1' }), entityRow({ id: 'e1' }), aiRow({ id: 'a2' }), entityRow({ id: 'e2' })];
  const ordered = orderCanonicalFirst(list);
  assert.deepEqual(ordered.map((s) => s.id), ['e1', 'e2', 'a1', 'a2']);

  const { canonical, ai } = partitionCanonicalAndAi(list);
  assert.deepEqual(canonical.map((s) => s.id), ['e1', 'e2']);
  assert.deepEqual(ai.map((s) => s.id), ['a1', 'a2']);
});

test('context predicates: writing contexts vs compass vs neither', () => {
  for (const c of ['caption', 'event_title', 'event_description', 'trip_title', 'plan_title'] as const) {
    assert.equal(isAiWritingContext(c), true, `${c} is a writing context`);
    assert.equal(AI_WRITING_CONTEXTS.has(c), true);
    assert.equal(isAiTextContext(c), true);
  }
  // compass_prompt is an AI-text context but NOT in the writing set (it also has
  // deterministic starters produced without the flag).
  assert.equal(isAiWritingContext('compass_prompt'), false);
  assert.equal(isAiTextContext('compass_prompt'), true);
  // A plain search context is neither.
  assert.equal(isAiWritingContext('global_search'), false);
  assert.equal(isAiTextContext('global_search'), false);
});

test('isAiSuggestion recognizes only genuine ai_suggestion + source ai rows', () => {
  assert.equal(isAiSuggestion(aiRow()), true);
  assert.equal(isAiSuggestion(entityRow()), false);
  assert.equal(isAiSuggestion(aiRow({ source: 'provider' })), false);
});
