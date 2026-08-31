/**
 * Phase 7 (Compass + AI) — the suggest request body builder (§22 opt-in, §29).
 *
 * Pure logic — runs under node:test. Proves the AI opt-in only reaches the wire
 * when the caller explicitly opts in, and that a default (non-AI) request body is
 * byte-for-byte the pre-Phase-7 shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSuggestBody } from '../suggestBody.ts';
import type { SuggestRequest } from '../../types/inputSuggestion.ts';

function base(overrides: Partial<SuggestRequest> = {}): SuggestRequest {
  return {
    context: 'compass_prompt',
    fieldId: 'compass.prompt',
    text: 'where should I',
    limit: 8,
    ...overrides,
  };
}

test('a default request omits aiAssist entirely (opt-in is real; default body unchanged)', () => {
  const body = buildSuggestBody(base());
  assert.equal('aiAssist' in body, false, 'aiAssist must not be present by default');
  // The classic fields are all present and unchanged.
  assert.equal(body.context, 'compass_prompt');
  assert.equal(body.fieldId, 'compass.prompt');
  assert.equal(body.text, 'where should I');
  assert.equal(body.limit, 8);
  // No coarse AI-context keys leak in when not set.
  assert.equal('city' in body, false);
  assert.equal('draft' in body, false);
  assert.equal('tz' in body, false);
});

test('aiAssist:true is forwarded; aiAssist:false / undefined never sets the key', () => {
  assert.equal(buildSuggestBody(base({ aiAssist: true })).aiAssist, true);
  assert.equal('aiAssist' in buildSuggestBody(base({ aiAssist: false })), false);
  assert.equal('aiAssist' in buildSuggestBody(base({ aiAssist: undefined })), false);
  // Only a literal boolean true opts in — a truthy non-boolean must NOT.
  assert.equal('aiAssist' in buildSuggestBody(base({ aiAssist: 1 as unknown as boolean })), false);
});

test('coarse city/tz/draft are forwarded only when meaningfully set (§29)', () => {
  const body = buildSuggestBody(
    base({ aiAssist: true, city: 'Da Nang', tz: 'Asia/Ho_Chi_Minh', draft: { city: 'Da Nang', category: 'food' } }),
  );
  assert.equal(body.city, 'Da Nang');
  assert.equal(body.tz, 'Asia/Ho_Chi_Minh');
  assert.deepEqual(body.draft, { city: 'Da Nang', category: 'food' });

  // Blank / empty values are dropped.
  const blank = buildSuggestBody(base({ city: '   ', tz: '', draft: {} }));
  assert.equal('city' in blank, false);
  assert.equal('tz' in blank, false);
  assert.equal('draft' in blank, false);
});
