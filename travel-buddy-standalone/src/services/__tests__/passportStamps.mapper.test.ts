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
