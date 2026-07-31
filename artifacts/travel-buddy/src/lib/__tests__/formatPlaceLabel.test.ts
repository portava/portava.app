/**
 * Unit tests for formatLocationLabel — the place chip de-duplication helper.
 *
 * Guards against showing "Hanoi, Vietnam · Hanoi" when the city is already
 * present in the place name, for all combinations of name/city inputs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocationLabel } from '../formatPlaceLabel.ts';

// ── city already present in name ─────────────────────────────────────────────

test('name is exact city match — returns name only, no separator', () => {
  assert.equal(formatLocationLabel('Hanoi', 'Hanoi', ' · '), 'Hanoi');
});

test('name is exact city match (different case) — returns name only', () => {
  assert.equal(formatLocationLabel('HANOI', 'hanoi', ' · '), 'HANOI');
});

test('city is a comma-separated segment of name — returns name only', () => {
  // "Hanoi, Vietnam" contains "Hanoi" as its first segment → no duplicate
  assert.equal(formatLocationLabel('Hanoi, Vietnam', 'Hanoi', ' · '), 'Hanoi, Vietnam');
});

test('city segment match is case-insensitive — returns name only', () => {
  assert.equal(formatLocationLabel('hanoi, Vietnam', 'HANOI', ' · '), 'hanoi, Vietnam');
});

// ── city NOT present in name — should append with separator ─────────────────

test('city not in name — appends city with provided separator', () => {
  assert.equal(
    formatLocationLabel('Hoan Kiem Lake', 'Hanoi', ' · '),
    'Hoan Kiem Lake · Hanoi',
  );
});

test('city not in name — uses default comma separator when none provided', () => {
  assert.equal(
    formatLocationLabel('Eiffel Tower', 'Paris'),
    'Eiffel Tower, Paris',
  );
});

test('city is only partially contained in name (not a full segment) — appends city', () => {
  // "Han" is not "Hanoi"; partial substrings should not suppress the city
  assert.equal(
    formatLocationLabel('Han Quarter', 'Hanoi', ' · '),
    'Han Quarter · Hanoi',
  );
});

// ── city null / undefined / empty ────────────────────────────────────────────

test('city is null — returns name only', () => {
  assert.equal(formatLocationLabel('Hoan Kiem Lake', null, ' · '), 'Hoan Kiem Lake');
});

test('city is undefined — returns name only', () => {
  assert.equal(formatLocationLabel('Hoan Kiem Lake', undefined, ' · '), 'Hoan Kiem Lake');
});

test('city is empty string — returns name only', () => {
  assert.equal(formatLocationLabel('Hoan Kiem Lake', '', ' · '), 'Hoan Kiem Lake');
});

// ── name null / undefined / empty, city present ──────────────────────────────

test('name is null, city present — returns city only', () => {
  assert.equal(formatLocationLabel(null, 'Hanoi', ' · '), 'Hanoi');
});

test('name is undefined, city present — returns city only', () => {
  assert.equal(formatLocationLabel(undefined, 'Hanoi', ' · '), 'Hanoi');
});

test('name is empty string, city present — returns city only', () => {
  assert.equal(formatLocationLabel('', 'Hanoi', ' · '), 'Hanoi');
});

// ── both null / empty ─────────────────────────────────────────────────────────

test('both null — returns empty string', () => {
  assert.equal(formatLocationLabel(null, null, ' · '), '');
});

test('both undefined — returns empty string', () => {
  assert.equal(formatLocationLabel(undefined, undefined, ' · '), '');
});

test('both empty strings — returns empty string', () => {
  assert.equal(formatLocationLabel('', '', ' · '), '');
});
