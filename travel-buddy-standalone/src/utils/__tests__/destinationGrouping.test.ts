/**
 * Unit tests for groupByDestination utility.
 *
 * Covers: basic grouping, case-insensitive deduplication, city stamps matched
 * by label, trip-only destinations, hero image preference, totalCount, and
 * mostRecentAt sort order.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupByDestination } from '../destinationGrouping.ts';
import type { PassportMemory } from '../../services/passportStamps.ts';
import type { PassportStamp, PassportPostcard } from '../../types/models.ts';
import type { TripRow } from '../../services/trips.ts';

// ── Minimal fixture builders ─────────────────────────────────────────────────

function makeMemory(overrides: Partial<PassportMemory> = {}): PassportMemory {
  return {
    id: 'm-1',
    status: 'active',
    title: 'A memory',
    description: null,
    country: 'US',
    city: 'Miami',
    neighborhood: null,
    category: 'city',
    visibility: 'public',
    verificationLevel: 'none',
    sourceType: null,
    photoUrl: null,
    // Required by PassportMemory.
    mediaType: null,
    planId: null,
    tripId: null,
    suggestionReason: null,
    earnedAt: '2026-01-15T00:00:00Z',
    createdAt: '2026-01-15T00:00:00Z',
    ...overrides,
  };
}

function makeStamp(overrides: Partial<PassportStamp> = {}): PassportStamp {
  return {
    id: 's-1',
    kind: 'city',
    label: 'MIAMI',
    sublabel: 'US · 2026',
    earnedAt: '2026-01-10T00:00:00Z',
    locked: false,
    ...overrides,
  };
}

function makePostcard(overrides: Partial<PassportPostcard> = {}): PassportPostcard {
  return {
    id: 'p-1',
    postId: 'post-1',
    mediaUrl: 'https://example.com/img.jpg',
    caption: 'Great view',
    locationName: 'South Beach',
    locationCity: 'Miami',
    locationCountry: 'US',
    locationVerified: false,
    stampEligible: false,
    visibility: 'public',
    status: 'active',
    pinnedAt: null,
    note: null,
    createdAt: '2026-01-20T00:00:00Z',
    ...overrides,
  };
}

function makeTrip(overrides: Partial<TripRow> = {}): TripRow {
  return {
    id: 't-1',
    ownerId: 'u-1',
    title: 'Miami Trip',
    destinationCity: 'Miami',
    destinationCountry: 'US',
    neighborhoods: [],
    startDate: '2026-02-01',
    endDate: null,
    status: 'upcoming',
    visibility: 'private',
    travelStyle: null,
    openToMeet: false,
    coverUrl: null,
    // Required by TripRow.
    coverMediaType: null,
    progress: 0,
    tripType: null,
    timezone: null,
    destinationLat: null,
    destinationLng: null,
    destinationPlaceId: null,
    tripNotes: null,
    showOnProfile: true,
    showInDiscovery: false,
    allowFriendSuggestions: true,
    allowTripCrewInvites: true,
    allowJoinRequests: false,
    showExactDates: true,
    showDestinationCity: true,
    delayedPostingDefault: false,
    preciseLocationVisible: false,
    planEditPermission: null,
    // Required by TripRow.
    showHeaderPublicly: false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('groupByDestination', () => {
  it('returns an empty array when all inputs are empty', () => {
    const result = groupByDestination([], [], [], []);
    assert.deepEqual(result, []);
  });

  it('creates one group for memories, postcards and trips with the same city', () => {
    const result = groupByDestination(
      [makeMemory()],
      [],
      [makePostcard()],
      [makeTrip()],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].city, 'Miami');
    assert.equal(result[0].memories.length, 1);
    assert.equal(result[0].postcards.length, 1);
    assert.equal(result[0].trips.length, 1);
    assert.equal(result[0].totalCount, 3);
  });

  it('merges memory and postcard with different city casing into one group', () => {
    // Different casing — should still be the same destination
    const result = groupByDestination(
      [makeMemory({ city: 'Miami' })],
      [],
      [makePostcard({ locationCity: 'miami' })],
      [],
    );
    assert.equal(result.length, 1, 'Expected one merged destination group');
    assert.equal(result[0].memories.length, 1);
    assert.equal(result[0].postcards.length, 1);
    // Display name is preserved from the first item encountered
    assert.equal(result[0].city.toLowerCase(), 'miami');
  });

  it('creates separate groups for genuinely different cities', () => {
    const result = groupByDestination(
      [makeMemory({ id: 'm-1', city: 'Miami', country: 'US' })],
      [],
      [makePostcard({ id: 'p-1', locationCity: 'Barcelona', locationCountry: 'ES' })],
      [],
    );
    assert.equal(result.length, 2);
    const cities = result.map((g) => g.city.toLowerCase()).sort();
    assert.deepEqual(cities, ['barcelona', 'miami']);
  });

  it('creates a destination group for a trip even when no memories or postcards exist', () => {
    // "Destinations opened before Plans" scenario — trips only
    const result = groupByDestination([], [], [], [makeTrip()]);
    assert.equal(result.length, 1);
    assert.equal(result[0].trips.length, 1);
    assert.equal(result[0].memories.length, 0);
    assert.equal(result[0].postcards.length, 0);
  });

  it('attaches a city stamp to the matching destination group', () => {
    const result = groupByDestination(
      [makeMemory({ city: 'Miami' })],
      [makeStamp({ kind: 'city', label: 'MIAMI' })],
      [],
      [],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].stamps.length, 1);
  });

  it('does not attach a non-city stamp to any destination', () => {
    const result = groupByDestination(
      [makeMemory({ city: 'Miami' })],
      [makeStamp({ kind: 'plan', label: 'MIAMI' })],
      [],
      [],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].stamps.length, 0);
  });

  it('does not attach a locked city stamp to any destination', () => {
    const result = groupByDestination(
      [makeMemory({ city: 'Miami' })],
      [makeStamp({ kind: 'city', label: 'MIAMI', locked: true })],
      [],
      [],
    );
    assert.equal(result[0].stamps.length, 0);
  });

  it('prefers postcard mediaUrl as hero image over trip coverUrl', () => {
    const result = groupByDestination(
      [],
      [],
      [makePostcard({ mediaUrl: 'https://example.com/postcard.jpg' })],
      [makeTrip({ coverUrl: 'https://example.com/cover.jpg' })],
    );
    assert.equal(result[0].heroImageUrl, 'https://example.com/postcard.jpg');
  });

  it('falls back to trip coverUrl when no postcard has media', () => {
    const result = groupByDestination(
      [],
      [],
      [makePostcard({ mediaUrl: null })],
      [makeTrip({ coverUrl: 'https://example.com/cover.jpg' })],
    );
    assert.equal(result[0].heroImageUrl, 'https://example.com/cover.jpg');
  });

  it('sorts destinations by most recent activity, newest first', () => {
    const result = groupByDestination(
      [
        makeMemory({ id: 'm-old', city: 'Tokyo', country: 'JP', earnedAt: '2025-01-01T00:00:00Z' }),
        makeMemory({ id: 'm-new', city: 'Miami', country: 'US', earnedAt: '2026-06-01T00:00:00Z' }),
      ],
      [],
      [],
      [],
    );
    assert.equal(result[0].city, 'Miami');
    assert.equal(result[1].city, 'Tokyo');
  });

  it('skips memories and postcards with no city', () => {
    const result = groupByDestination(
      [makeMemory({ city: null as any })],
      [],
      [makePostcard({ locationCity: null as any })],
      [],
    );
    assert.equal(result.length, 0);
  });

  it('merges a memory and trip that share an accented city in different Unicode forms (NFC vs NFD)', () => {
    // 'Bogotá' in NFC (precomposed U+00E1) vs NFD (a + combining U+0301) —
    // visually identical but different byte sequences.  groupByDestination must
    // normalise to NFC before keying so they land in the same group.
    const nfcCity = 'Bogot\u00E1';        // precomposed á
    const nfdCity = 'Bogota\u0301';       // a + combining acute accent
    assert.notEqual(nfcCity, nfdCity, 'pre-condition: raw strings differ');

    const result = groupByDestination(
      [makeMemory({ id: 'm-bog', city: nfcCity, country: 'CO' })],
      [],
      [],
      [makeTrip({ id: 't-bog', destinationCity: nfdCity, destinationCountry: 'CO' })],
    );

    assert.equal(result.length, 1, 'NFC and NFD forms of the same city must merge into one group');
    assert.equal(result[0].memories.length, 1);
    assert.equal(result[0].trips.length, 1);
    assert.equal(result[0].totalCount, 2);
  });
});
