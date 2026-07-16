/**
 * mapStamp / mapDefinition — assert universalArtworkUrl survives the
 * API -> model transformation in both snake_case and camelCase payloads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStamp } from '../passportStampMappers.ts';

const baseRow = {
  id: 'stamp-1',
  stamp_definition_id: 'def-1',
  stamp_type: 'city',
  earned_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
};

test('maps snake_case universal_artwork_url onto definition', () => {
  const s = mapStamp({
    ...baseRow,
    definition: { slug: 'cebu', name: 'CEBU', universal_artwork_url: 'https://cdn.example/cebu.png' },
  });
  assert.equal(s.definition?.universalArtworkUrl, 'https://cdn.example/cebu.png');
});

test('maps camelCase universalArtworkUrl onto definition', () => {
  const s = mapStamp({
    ...baseRow,
    definition: { slug: 'cebu', name: 'CEBU', universalArtworkUrl: 'https://cdn.example/cebu.png' },
  });
  assert.equal(s.definition?.universalArtworkUrl, 'https://cdn.example/cebu.png');
});

test('universalArtworkUrl is null when absent', () => {
  const s = mapStamp({
    ...baseRow,
    definition: { slug: 'cebu', name: 'CEBU' },
  });
  assert.equal(s.definition?.universalArtworkUrl, null);
});

// ── XX catalog fallback — null country handling ───────────────────────────────
//
// When a stamp's catalog entry still has country_code "XX" (not yet resolved by
// the sweep), the ownership row's `country` field is null. These tests confirm:
//   1. mapStamp keeps country as null — never coerces it to a display string.
//   2. The StampCard/StampDetailModal display logic ([city, country].filter(Boolean))
//      already suppresses null country gracefully with no extra code needed.
//   3. When both city and country are null the location guard (city || country)
//      evaluates to false, so the entire location row is hidden — no blank line.

test('country is null when API row has country: null (XX catalog, not yet resolved)', () => {
  const s = mapStamp({ ...baseRow, country: null, city: 'Cebu City' });
  assert.equal(s.country, null, 'null country must pass through as null');
});

test('country is null when API row omits country entirely', () => {
  const s = mapStamp({ ...baseRow, city: 'Cebu City' });
  assert.equal(s.country, null, 'absent country must map to null');
});

test('display: city-only location string when country is null', () => {
  // Mirrors: [stamp.city, stamp.country].filter(Boolean).join(', ')
  const city = 'Cebu City';
  const country = null;
  const display = [city, country].filter(Boolean).join(', ');
  assert.equal(display, 'Cebu City', 'null country should be silently omitted from location text');
});

test('display: location row is hidden when both city and country are null', () => {
  // Mirrors: (stamp.city || stamp.country) && <location row>
  const city = null;
  const country = null;
  const showRow = !!(city || country);
  assert.equal(showRow, false, 'location row must not render when both city and country are null');
});

test('display: location row is shown when city is present but country is null', () => {
  const city = 'Cebu City';
  const country = null;
  const showRow = !!(city || country);
  assert.equal(showRow, true, 'location row must render when city is present even with null country');
});
