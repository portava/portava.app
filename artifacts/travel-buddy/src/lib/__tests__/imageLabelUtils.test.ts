/**
 * imageLabelUtils — nine-type source-badge mapping regression test.
 *
 * Locks down that every one of the nine ImageSourceType classifications
 * (see artifacts/api-server/src/lib/visuals/types.ts) resolves to its
 * intended badge category — so a misclassified image never silently shows
 * the wrong badge, and an unrecognized source type is never mistaken for a
 * legitimate "no badge" fallback case.
 *
 * Pure-logic test — runs under node:test (see scripts/run-node-tests.mjs).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePlaceImageSourceLabel,
  shortLabelText,
  type PlaceImageSourceLabel,
} from '../imageLabelUtils.ts';

describe('derivePlaceImageSourceLabel — all nine source types', () => {
  const cases: Array<{
    type: string;
    disclaimerRequired?: boolean;
    expected: PlaceImageSourceLabel;
  }> = [
    { type: 'official', expected: 'official_photo' },
    { type: 'trusted_provider', expected: 'official_photo' },
    { type: 'tourism_authority', expected: 'official_photo' },
    { type: 'verified_owner', expected: 'venue_provided' },
    { type: 'verified_user_photo', expected: 'traveler_photo' },
    { type: 'reference_grounded_ai', expected: 'reference_ai' },
    { type: 'generic_ai_illustration', disclaimerRequired: true, expected: 'illustrative' },
    { type: 'category_fallback', disclaimerRequired: true, expected: 'illustrative' },
    { type: 'map_fallback', disclaimerRequired: true, expected: 'illustrative' },
  ];

  for (const { type, disclaimerRequired, expected } of cases) {
    test(`maps "${type}" (disclaimerRequired=${!!disclaimerRequired}) to "${expected}"`, () => {
      assert.equal(derivePlaceImageSourceLabel(type, disclaimerRequired), expected);
    });
  }

  test('the three trusted-source types all resolve to a real, non-null badge (never accidentally suppressed)', () => {
    for (const type of ['official', 'trusted_provider', 'tourism_authority']) {
      const label = derivePlaceImageSourceLabel(type, false);
      assert.equal(label, 'official_photo');
      assert.notEqual(shortLabelText(label), null);
    }
  });

  test('the three fallback/illustration types suppress the badge when disclaimerRequired is false — not shown as a trusted badge', () => {
    for (const type of ['generic_ai_illustration', 'category_fallback', 'map_fallback']) {
      assert.equal(derivePlaceImageSourceLabel(type, false), null);
      assert.equal(derivePlaceImageSourceLabel(type, null), null);
      assert.equal(derivePlaceImageSourceLabel(type, undefined), null);
    }
  });

  test('null/undefined imageSourceType (legacy/unclassified sources) maps to no badge', () => {
    assert.equal(derivePlaceImageSourceLabel(null, false), null);
    assert.equal(derivePlaceImageSourceLabel(undefined, false), null);
  });

  test('an unrecognized imageSourceType string never maps to a real badge — fails safe, not silently masquerading as a trusted source', () => {
    const label = derivePlaceImageSourceLabel('totally_bogus_source_type', true);
    assert.equal(label, null);
    // Critically: it must never resolve to 'official_photo' or 'venue_provided'
    // (the two categories most valuable to spoof).
    assert.notEqual(label, 'official_photo');
    assert.notEqual(label, 'venue_provided');
  });

  test('no two distinct badge categories share the same short label text', () => {
    const categories: PlaceImageSourceLabel[] = [
      'official_photo', 'venue_provided', 'traveler_photo', 'reference_ai', 'illustrative',
    ];
    const texts = categories.map((c) => shortLabelText(c));
    assert.equal(new Set(texts).size, texts.length);
    assert.ok(texts.every((txt) => typeof txt === 'string' && txt.length > 0));
  });
});
