/**
 * counterFormat tests — node:test + node:assert only.
 * Run: node --import tsx/esm --test src/lib/__tests__/counterFormat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCompactCount, formatExactCount, actionAccessibilityLabel } from '../counterFormat.ts';

test('1. counts below 1,000 render as-is', () => {
  assert.equal(formatCompactCount(0), '0');
  assert.equal(formatCompactCount(1), '1');
  assert.equal(formatCompactCount(999), '999');
});

test('2. thousands scale to K with one decimal below 10K-scaled value', () => {
  assert.equal(formatCompactCount(1000), '1K');
  assert.equal(formatCompactCount(1200), '1.2K');
  assert.equal(formatCompactCount(9_949), '9.9K');
});

test('3. thousands drop the decimal at 10K-scaled and above', () => {
  assert.equal(formatCompactCount(10_000), '10K');
  assert.equal(formatCompactCount(24_000), '24K');
  assert.equal(formatCompactCount(999_000), '999K');
});

test('4. millions follow the same K/M/B decimal rule', () => {
  assert.equal(formatCompactCount(1_000_000), '1M');
  assert.equal(formatCompactCount(1_200_000), '1.2M');
  assert.equal(formatCompactCount(24_000_000), '24M');
  assert.equal(formatCompactCount(999_000_000), '999M');
});

test('5. billions follow the same rule (documented up to 999M+)', () => {
  assert.equal(formatCompactCount(1_000_000_000), '1B');
  assert.equal(formatCompactCount(1_200_000_000), '1.2B');
  assert.equal(formatCompactCount(24_000_000_000), '24B');
});

test('6. negative/fractional input is floored and clamped to 0, never abbreviated to a negative unit', () => {
  assert.equal(formatCompactCount(-5), '0');
  assert.equal(formatCompactCount(4.9), '4');
});

test('7. formatExactCount never abbreviates and comma-groups', () => {
  assert.equal(formatExactCount(0), '0');
  assert.equal(formatExactCount(999), '999');
  assert.equal(formatExactCount(24_000_000), '24,000,000');
  assert.equal(formatExactCount(1_234_567_890), '1,234,567,890');
});

test('8. actionAccessibilityLabel appends the exact count when present', () => {
  assert.equal(actionAccessibilityLabel('Comment', 24_000_000), 'Comment, 24,000,000');
  assert.equal(actionAccessibilityLabel('Comment', 3), 'Comment, 3');
});

test('9. actionAccessibilityLabel omits the count suffix when count is absent or zero', () => {
  assert.equal(actionAccessibilityLabel('Share'), 'Share');
  assert.equal(actionAccessibilityLabel('Comment', 0), 'Comment');
});
