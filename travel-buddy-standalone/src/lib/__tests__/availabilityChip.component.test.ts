/**
 * Unit tests for resolveAvailabilityChip — pure availability chip resolver.
 *
 * Covers:
 *  - opted-in with a quickStatus (secondary shown)
 *  - opted-in without any secondary context (primary only)
 *  - opted-out (no render — returns null)
 *  - busy quickStatus overrides openToMeet (returns null)
 *  - active trip window adds secondary context at city level
 *  - homeCity shown when no trip is active and showHomeCity=true
 *  - homeCity hidden when showHomeCity=false
 */

import { resolveAvailabilityChip } from '../availabilityChip.ts';
import type { TripWindow } from '../../types/models.ts';

// Fixed "now" for deterministic results: 2026-07-17T14:00:00Z (afternoon)
const NOW = '2026-07-17T14:00:00.000Z';

const NO_TRIPS: TripWindow[] = [];

describe('resolveAvailabilityChip', () => {
  // ── opted-out ──────────────────────────────────────────────────────────────

  it('returns null when openToMeet is false', () => {
    expect(resolveAvailabilityChip({
      openToMeet: false,
      quickStatus: null,
      trips: NO_TRIPS,
      homeCity: 'Manila',
      showHomeCity: true,
      nowISO: NOW,
    })).toBeNull();
  });

  it('returns null when quickStatus is busy (even if openToMeet is true)', () => {
    expect(resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: 'busy',
      trips: NO_TRIPS,
      homeCity: null,
      showHomeCity: false,
      nowISO: NOW,
    })).toBeNull();
  });

  // ── opted-in, no secondary context ────────────────────────────────────────

  it('returns primary only when openToMeet=true, no quickStatus, no trips, showHomeCity=false', () => {
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: null,
      trips: NO_TRIPS,
      homeCity: null,
      showHomeCity: false,
      nowISO: NOW,
    });
    expect(result).not.toBeNull();
    expect(result!.primary).toBe('Open to meet');
    expect(result!.secondary).toBeUndefined();
  });

  it('returns primary only when homeCity present but showHomeCity=false', () => {
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: null,
      trips: NO_TRIPS,
      homeCity: 'Cebu',
      showHomeCity: false,
      nowISO: NOW,
    });
    expect(result).not.toBeNull();
    expect(result!.secondary).toBeUndefined();
  });

  // ── opted-in WITH quickStatus ──────────────────────────────────────────────

  it('includes "Free now" secondary for quickStatus=free_now', () => {
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: 'free_now',
      trips: NO_TRIPS,
      homeCity: 'Manila',
      showHomeCity: true,
      nowISO: NOW,
    });
    expect(result).not.toBeNull();
    expect(result!.primary).toBe('Open to meet');
    expect(result!.secondary).toBe('Free now');
  });

  it('includes "Free tonight" secondary for quickStatus=free_tonight', () => {
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: 'free_tonight',
      trips: NO_TRIPS,
      homeCity: null,
      showHomeCity: false,
      nowISO: NOW,
    });
    expect(result!.secondary).toBe('Free tonight');
  });

  it('includes "Open to plans" secondary for quickStatus=open_to_plans', () => {
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: 'open_to_plans',
      trips: NO_TRIPS,
      homeCity: null,
      showHomeCity: false,
      nowISO: NOW,
    });
    expect(result!.secondary).toBe('Open to plans');
  });

  // quickStatus takes priority over trip window
  it('quickStatus takes priority over an active trip window', () => {
    const trip: TripWindow = {
      id: 'w1',
      citySlug: 'cebu',
      startDate: '2026-07-15',
      endDate: '2026-07-20',
      blocks: ['afternoon'],
    };
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: 'free_now',
      trips: [trip],
      homeCity: null,
      showHomeCity: false,
      nowISO: NOW,
    });
    expect(result!.secondary).toBe('Free now');
  });

  // ── active trip window ─────────────────────────────────────────────────────

  it('shows "Traveling in Cebu" when a trip window is active today (city-level only)', () => {
    const trip: TripWindow = {
      id: 'w1',
      citySlug: 'cebu',
      startDate: '2026-07-15',
      endDate: '2026-07-20',
      blocks: ['afternoon'],
    };
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: null,
      trips: [trip],
      homeCity: 'Manila',
      showHomeCity: true,
      nowISO: NOW,
    });
    expect(result!.secondary).toBe('Traveling in Cebu');
  });

  it('does NOT show trip context when trip window is in the past', () => {
    const pastTrip: TripWindow = {
      id: 'w2',
      citySlug: 'bangkok',
      startDate: '2026-07-01',
      endDate: '2026-07-10',
      blocks: ['evening'],
    };
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: null,
      trips: [pastTrip],
      homeCity: 'Manila',
      showHomeCity: true,
      nowISO: NOW,
    });
    // Falls back to homeCity
    expect(result!.secondary).toBe('Local in Manila');
  });

  // ── homeCity fallback ──────────────────────────────────────────────────────

  it('shows "Local in [city]" when no trip active and showHomeCity=true', () => {
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: null,
      trips: NO_TRIPS,
      homeCity: 'Manila',
      showHomeCity: true,
      nowISO: NOW,
    });
    expect(result!.secondary).toBe('Local in Manila');
  });

  it('hyphenated city slugs are formatted correctly', () => {
    const trip: TripWindow = {
      id: 'w3',
      citySlug: 'ho-chi-minh',
      startDate: '2026-07-10',
      endDate: '2026-07-25',
      blocks: ['evening'],
    };
    const result = resolveAvailabilityChip({
      openToMeet: true,
      quickStatus: null,
      trips: [trip],
      homeCity: null,
      showHomeCity: false,
      nowISO: NOW,
    });
    expect(result!.secondary).toBe('Traveling in Ho chi minh');
  });
});
