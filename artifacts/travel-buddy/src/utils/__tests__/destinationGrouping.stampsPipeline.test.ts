/**
 * v2 stamps pipeline -> legacy destination grouping.
 *
 * The passport screen derives its legacy stamp list from the v2 pipeline via
 * toLegacyStamp, whose label prefers definition?.name / titleOverride over the
 * city name. Destination grouping must still attach city stamps to their
 * destination even when the display label diverges from the city — it matches
 * on the carried-through `city` field first, falling back to `label`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toLegacyStamp } from '../../services/passportStampMappers.ts';
import type { PassportStampNew, StampDefinition } from '../../services/passportStamps.ts';
import { groupByDestination } from '../destinationGrouping.ts';
import type { PassportMemory } from '../../services/passportStamps.ts';

function makeDefinition(overrides: Partial<StampDefinition> = {}): StampDefinition {
  return {
    slug: 'cebu',
    name: 'CEBU',
    iconUrl: null,
    universalArtworkUrl: null,
    rarity: 'common',
    stampType: 'city',
    category: null,
    description: null,
    ...overrides,
  };
}

function makeV2Stamp(overrides: Partial<PassportStampNew> = {}): PassportStampNew {
  return {
    id: 'v2-1',
    stampDefinitionId: 'def-1',
    definition: null,
    stampType: 'city',
    country: 'PH',
    city: 'Cebu',
    neighborhood: null,
    titleOverride: null,
    placeId: null,
    planId: null,
    tripId: null,
    sourceType: 'system',
    verificationLevel: 'unverified',
    visibility: 'public',
    displayOnPassport: true,
    isRevoked: false,
    earnedAt: '2026-01-10T00:00:00Z',
    createdAt: '2026-01-10T00:00:00Z',
    catalogId: null,
    activeArtworkUrl: null,
    ...overrides,
  } as PassportStampNew;
}

function makeMemory(overrides: Partial<PassportMemory> = {}): PassportMemory {
  return {
    id: 'm-1',
    status: 'active',
    title: 'A memory',
    description: null,
    country: 'PH',
    city: 'Cebu',
    neighborhood: null,
    category: 'city',
    visibility: 'public',
    verificationLevel: 'none',
    sourceType: null,
    photoUrl: null,
    planId: null,
    tripId: null,
    suggestionReason: null,
    earnedAt: '2026-01-15T00:00:00Z',
    createdAt: '2026-01-15T00:00:00Z',
    ...overrides,
  } as PassportMemory;
}

describe('v2 stamps -> toLegacyStamp -> groupByDestination', () => {
  it('city stamp without a definition (label falls back to city) lands in its destination group', () => {
    const legacy = toLegacyStamp(makeV2Stamp({ definition: null }));
    assert.equal(legacy.label, 'Cebu', 'label falls back to city when no definition');

    const result = groupByDestination([makeMemory()], [legacy], [], []);
    assert.equal(result.length, 1);
    assert.equal(result[0].stamps.length, 1, 'stamp must attach to the Cebu group');
  });

  it('city stamp whose definition name matches the city still lands in its group', () => {
    const legacy = toLegacyStamp(
      makeV2Stamp({ definition: makeDefinition({ name: 'CEBU' }) }),
    );
    const result = groupByDestination([makeMemory()], [legacy], [], []);
    assert.equal(result[0].stamps.length, 1);
  });

  it('city stamp whose definition name DIFFERS from the city still lands in its group', () => {
    // Regression: label prefers definition?.name, which can diverge from the
    // city — grouping must match on the carried-through city field.
    const legacy = toLegacyStamp(
      makeV2Stamp({ definition: makeDefinition({ name: 'Queen City of the South' }) }),
    );
    assert.equal(legacy.label, 'Queen City of the South');
    assert.equal(legacy.city, 'Cebu', 'toLegacyStamp must carry the source city through');

    const result = groupByDestination([makeMemory()], [legacy], [], []);
    assert.equal(result.length, 1);
    assert.equal(result[0].stamps.length, 1, 'stamp with divergent definition name must still match its destination');
  });

  it('city stamp with a titleOverride still lands in its group', () => {
    const legacy = toLegacyStamp(makeV2Stamp({ titleOverride: 'My Special Stamp' }));
    const result = groupByDestination([makeMemory()], [legacy], [], []);
    assert.equal(result[0].stamps.length, 1);
  });

  it('city match handles NFC/NFD unicode and case differences', () => {
    const legacy = toLegacyStamp(
      makeV2Stamp({
        city: 'bogota\u0301', // NFD, lowercase
        country: 'CO',
        definition: makeDefinition({ name: 'Bogotá Wanderer' }),
      }),
    );
    const result = groupByDestination(
      [makeMemory({ city: 'Bogot\u00E1', country: 'CO' })], // NFC
      [legacy],
      [],
      [],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].stamps.length, 1);
  });

  it('stamp does not attach when neither city nor label matches any destination', () => {
    const legacy = toLegacyStamp(
      makeV2Stamp({ city: 'Davao', definition: makeDefinition({ name: 'Durian King' }) }),
    );
    const result = groupByDestination([makeMemory({ city: 'Cebu' })], [legacy], [], []);
    assert.equal(result[0].stamps.length, 0);
  });

  it('revoked v2 stamp maps to locked and is not attached', () => {
    const legacy = toLegacyStamp(makeV2Stamp({ isRevoked: true }));
    assert.equal(legacy.locked, true);
    const result = groupByDestination([makeMemory()], [legacy], [], []);
    assert.equal(result[0].stamps.length, 0);
  });
});
