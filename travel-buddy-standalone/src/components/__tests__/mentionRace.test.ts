/**
 * MentionInput request-cancellation decision (§33) — a stale/aborted response
 * must never replace the current suggestion list. Pure logic — node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldApplyMentionResponse } from '../mentionRace.ts';

test('applies a response for the still-active trigger', () => {
  assert.equal(
    shouldApplyMentionResponse({ aborted: false, responseStartIndex: 5, activeStartIndex: 5 }),
    true,
  );
});

test('drops an aborted response even if the index still matches', () => {
  // The core cancellation guarantee: a newer keystroke aborted this request, so
  // its late-arriving response is ignored.
  assert.equal(
    shouldApplyMentionResponse({ aborted: true, responseStartIndex: 5, activeStartIndex: 5 }),
    false,
  );
});

test('drops a response whose trigger position moved (superseded keystroke)', () => {
  assert.equal(
    shouldApplyMentionResponse({ aborted: false, responseStartIndex: 5, activeStartIndex: 8 }),
    false,
  );
});

test('drops a response when no trigger is active any more (dismissed/blurred)', () => {
  assert.equal(
    shouldApplyMentionResponse({ aborted: false, responseStartIndex: 5, activeStartIndex: null }),
    false,
  );
});

test('out-of-order arrival: the older response for a moved trigger is ignored', () => {
  // Simulate: request A (index 3) is slow; user types, trigger now at index 7,
  // request B fired and aborted A. A finally resolves — it must not commit.
  const older = { aborted: true, responseStartIndex: 3, activeStartIndex: 7 };
  const newer = { aborted: false, responseStartIndex: 7, activeStartIndex: 7 };
  assert.equal(shouldApplyMentionResponse(older), false);
  assert.equal(shouldApplyMentionResponse(newer), true);
});
