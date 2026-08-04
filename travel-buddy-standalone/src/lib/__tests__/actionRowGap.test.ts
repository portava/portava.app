/**
 * actionRowGap tests — node:test + node:assert only.
 * Run: node --import tsx/esm --test src/lib/__tests__/actionRowGap.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeActionGap, ACTION_GAP_MIN, ACTION_GAP_MAX } from '../actionRowGap.ts';

test('1. no counters at all (all undefined) yields the baseline gap', () => {
  assert.equal(computeActionGap([undefined, undefined]), ACTION_GAP_MIN);
});

test('2. a single-digit counter yields the baseline gap', () => {
  assert.equal(computeActionGap(['0', '3']), ACTION_GAP_MIN);
});

test('3. gap grows monotonically as the widest counter label widens', () => {
  const g1 = computeActionGap(['3']);
  const g2 = computeActionGap(['1.2K']);
  const g3 = computeActionGap(['999K']);
  assert.ok(g1 < g2, `expected ${g1} < ${g2}`);
  assert.ok(g2 <= g3, `expected ${g2} <= ${g3}`);
});

test('4. gap never exceeds the documented max even for very wide labels', () => {
  const g = computeActionGap(['999.9B', 'much wider than any real counter']);
  assert.equal(g, ACTION_GAP_MAX);
});

test('5. only the widest label in the cluster drives the gap', () => {
  const gapMixed = computeActionGap(['3', '24M']);
  const gapWideAlone = computeActionGap(['24M']);
  assert.equal(gapMixed, gapWideAlone);
});

test('6. gap stays within the documented [14, 24] range for realistic tiers', () => {
  for (const label of ['0', '1', '99', '1.2K', '24K', '999K', '1.2M', '24M', '999M', '1.2B']) {
    const g = computeActionGap([label]);
    assert.ok(g >= ACTION_GAP_MIN && g <= ACTION_GAP_MAX, `${label} -> ${g} out of range`);
  }
});
