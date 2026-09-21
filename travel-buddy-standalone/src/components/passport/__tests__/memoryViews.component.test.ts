/**
 * memoryViews — pure grouping for the §15 Memories views this lane can build.
 *
 * §15 names five views: Trips, Places, People, Timeline and Map. Timeline
 * already shipped (`src/lib/memoryTimeline.ts`). This module covers **Trips,
 * Places and Map**. It deliberately does NOT cover **People**: `PassportMemory`
 * carries no participant field, and the memory-participant visibility work that
 * would give it one belongs to the Highlights/Memories lane
 * (`artifacts/api-server/src/services/memory/**`). Building a People view here
 * would mean inventing a contract this lane does not own.
 *
 * Every function is pure and deterministic — no `Date.now`, no locale-dependent
 * formatting — so the grouping is unit-testable without rendering.
 */
import type { PassportMemory } from '../../../services/passportStamps.ts';
import type { TripRow } from '../../../services/trips.ts';
import {
  groupMemoriesByTrip,
  groupMemoriesByPlace,
  buildMemoryMap,
  UNTRIPPED_KEY,
  UNPLACED_KEY,
} from '../memoryViews.ts';

function mem(over: Partial<PassportMemory>): PassportMemory {
  return {
    id: 'm', status: 'active', title: 'Untitled', description: null, country: null, city: null,
    neighborhood: null, category: null, visibility: 'public', verificationLevel: 'none',
    sourceType: null, photoUrl: null, mediaType: null, planId: null, tripId: null,
    suggestionReason: null, earnedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
    ...over,
  } as PassportMemory;
}

function trip(over: Partial<TripRow>): TripRow {
  return {
    id: 't', ownerId: 'u', title: 'A Trip', destinationCity: 'Bangkok', destinationCountry: 'Thailand',
    neighborhoods: [], startDate: null, endDate: null, status: 'planning', visibility: 'private',
    travelStyle: null, openToMeet: false, coverUrl: null, coverMediaType: null, progress: 0,
    tripType: null, timezone: null, destinationLat: null, destinationLng: null,
    destinationPlaceId: null,
    ...over,
  } as TripRow;
}

// ── Trips view ────────────────────────────────────────────────────────────────

describe('groupMemoriesByTrip', () => {
  it('groups by tripId and titles each section from the matching trip', () => {
    const memories = [
      mem({ id: 'a', tripId: 't1', earnedAt: '2026-09-10T00:00:00Z' }),
      mem({ id: 'b', tripId: 't2', earnedAt: '2026-09-20T00:00:00Z' }),
      mem({ id: 'c', tripId: 't1', earnedAt: '2026-09-11T00:00:00Z' }),
    ];
    const trips = [trip({ id: 't1', title: 'Songkran' }), trip({ id: 't2', title: 'Hanoi Week' })];

    const out = groupMemoriesByTrip(memories, trips);

    // Newest-first by the section's most recent memory: t2 (Sep 20) before t1 (Sep 11).
    expect(out.map((s) => s.key)).toEqual(['t2', 't1']);
    expect(out[0].label).toBe('Hanoi Week');
    expect(out[1].label).toBe('Songkran');
    expect(out[1].memories.map((m) => m.id)).toEqual(['c', 'a']); // newest first within section
  });

  it('renders the untripped bucket rather than dropping memories with no trip', () => {
    const memories = [
      mem({ id: 'a', tripId: 't1', earnedAt: '2026-09-10T00:00:00Z' }),
      mem({ id: 'loose', tripId: null, earnedAt: '2026-09-25T00:00:00Z' }),
    ];
    const out = groupMemoriesByTrip(memories, [trip({ id: 't1', title: 'Songkran' })]);

    const untripped = out.find((s) => s.key === UNTRIPPED_KEY);
    expect(untripped).toBeTruthy();
    expect(untripped!.memories.map((m) => m.id)).toEqual(['loose']);
    // The untripped bucket always sorts last, however recent it is.
    expect(out[out.length - 1].key).toBe(UNTRIPPED_KEY);
    // Nothing is lost.
    expect(out.flatMap((s) => s.memories)).toHaveLength(2);
  });

  it('falls back to a neutral label when no trip row matches the id', () => {
    const out = groupMemoriesByTrip([mem({ id: 'a', tripId: 'gone' })], []);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('gone');
    expect(out[0].label).toBe('Trip');
  });
});

// ── Places view ───────────────────────────────────────────────────────────────

describe('groupMemoriesByPlace', () => {
  it('groups by city+country, newest first, preserving display casing', () => {
    const memories = [
      mem({ id: 'a', city: 'Bangkok', country: 'Thailand', earnedAt: '2026-09-10T00:00:00Z' }),
      mem({ id: 'b', city: 'Hanoi', country: 'Vietnam', earnedAt: '2026-09-20T00:00:00Z' }),
      mem({ id: 'c', city: 'Bangkok', country: 'Thailand', earnedAt: '2026-09-12T00:00:00Z' }),
    ];
    const out = groupMemoriesByPlace(memories);

    expect(out.map((s) => s.label)).toEqual(['Hanoi', 'Bangkok']);
    expect(out[0].sublabel).toBe('Vietnam');
    expect(out[1].memories.map((m) => m.id)).toEqual(['c', 'a']);
  });

  it('merges cities that differ only by Unicode form or casing', () => {
    // Precomposed 'Bogotá' vs decomposed 'Bogotá' — the shared
    // destination grouping (src/utils/destinationGrouping.ts) NFC-normalises
    // for exactly this reason and this view matches that convention.
    const memories = [
      mem({ id: 'a', city: 'Bogotá', country: 'Colombia' }),
      mem({ id: 'b', city: 'Bogotá', country: 'colombia' }),
    ];
    const out = groupMemoriesByPlace(memories);
    expect(out).toHaveLength(1);
    expect(out[0].memories).toHaveLength(2);
  });

  it('renders an unplaced bucket rather than dropping memories with no city', () => {
    const out = groupMemoriesByPlace([
      mem({ id: 'a', city: 'Bangkok', country: 'Thailand' }),
      mem({ id: 'nowhere', city: null }),
    ]);
    const unplaced = out.find((s) => s.key === UNPLACED_KEY);
    expect(unplaced).toBeTruthy();
    expect(unplaced!.memories.map((m) => m.id)).toEqual(['nowhere']);
    expect(out[out.length - 1].key).toBe(UNPLACED_KEY);
  });
});

// ── Map view ──────────────────────────────────────────────────────────────────

describe('buildMemoryMap', () => {
  it('plots one pin per city using the shared city centroid table', () => {
    const out = buildMemoryMap([
      mem({ id: 'a', city: 'Bangkok', country: 'Thailand' }),
      mem({ id: 'b', city: 'Bangkok', country: 'Thailand' }),
      mem({ id: 'c', city: 'Hanoi', country: 'Vietnam' }),
    ], []);

    expect(out.pins).toHaveLength(2);
    const bangkok = out.pins.find((p) => p.city === 'Bangkok')!;
    // Values come from src/lib/cityCentroids.ts — not restated by hand here
    // beyond the assertion that they are the real, finite coordinates.
    expect(bangkok.lat).toBeCloseTo(13.7563, 3);
    expect(bangkok.lng).toBeCloseTo(100.5018, 3);
    expect(bangkok.memories).toHaveLength(2);
    expect(out.unplotted).toHaveLength(0);
  });

  it('prefers a trip destination coordinate over the centroid table when present', () => {
    const out = buildMemoryMap(
      [mem({ id: 'a', city: 'Bangkok', country: 'Thailand', tripId: 't1' })],
      [trip({ id: 't1', destinationCity: 'Bangkok', destinationLat: 13.9, destinationLng: 100.9 })],
    );
    expect(out.pins).toHaveLength(1);
    expect(out.pins[0].lat).toBeCloseTo(13.9, 3);
    expect(out.pins[0].lng).toBeCloseTo(100.9, 3);
  });

  it('reports memories it cannot plot instead of silently dropping them', () => {
    // A map that quietly loses memories is a lie about the collection's size;
    // the caller needs the count so the UI can say so.
    const out = buildMemoryMap([
      mem({ id: 'a', city: 'Bangkok', country: 'Thailand' }),
      mem({ id: 'b', city: 'Nowhereville', country: 'Atlantis' }),
      mem({ id: 'c', city: null }),
    ], []);

    expect(out.pins).toHaveLength(1);
    expect(out.unplotted.map((m) => m.id).sort()).toEqual(['b', 'c']);
    // Every memory is accounted for in exactly one place.
    expect(out.pins.flatMap((p) => p.memories).length + out.unplotted.length).toBe(3);
  });
});
