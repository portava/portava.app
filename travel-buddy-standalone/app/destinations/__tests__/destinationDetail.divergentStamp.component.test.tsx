/**
 * Destination detail screen — divergent-label city stamp visibility.
 *
 * groupByDestination matches city stamps by the carried-through `city` field
 * (falling back to label). The detail screen must render stamps from the
 * DestinationGroup.stamps array — NOT by re-matching stamp.label against the
 * city — so a stamp whose display label diverges from the city name (e.g.
 * definition name "CEBU HERITAGE" for city "Cebu") is still shown.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import DestinationDetailScreen from '../[city].tsx';
import { encodeDestinationKey } from '../../../src/utils/destinationGrouping.ts';
import type { PassportStamp } from '../../../src/types/models.ts';
import type { PassportMemory } from '../../../src/services/passportStamps.ts';

// ── expo-router — intentionally exhaustive ───────────────────────────────────
// moduleNameMapper redirects expo-router to src/__mocks__/expo-router.tsx, so
// jest.requireActual is safe here (it resolves through the mapper, not native).
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({
    // Group key for city "Cebu" with no country: 'cebu|'
    city: require('../../../src/utils/destinationGrouping.ts').encodeDestinationKey('cebu|'),
  })),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── usePassport ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the real hook calls Supabase and the full
// network stack; only the fields the detail screen reads are provided.
jest.mock('../../../src/hooks/usePassport', () => ({
  usePassport: jest.fn(),
  isProfileStaleSince: jest.fn(() => false),
  markProfileStale: jest.fn(),
}));

// NOTE: intentional stub — trips service imports Supabase; not under test.
jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

import { usePassport } from '../../../src/hooks/usePassport.ts';

const mockUsePassport = usePassport as jest.Mock;

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** A memory in Cebu creates the destination group. */
const cebuMemory = {
  id: 'm1',
  userId: 'user-1',
  city: 'Cebu',
  country: null,
  title: 'Memory in Cebu',
  description: null,
  photoUrl: null,
  earnedAt: '2024-05-01T00:00:00Z',
} as unknown as PassportMemory;

/**
 * A city stamp whose display label DIVERGES from the city name — the v2
 * pipeline carries the source city through `city`, while `label` comes from
 * the definition name / title override.
 */
const divergentStamp: PassportStamp = {
  id: 's1',
  kind: 'city',
  label: 'CEBU HERITAGE',
  earnedAt: '2024-05-02T00:00:00Z',
  locked: false,
  city: 'Cebu',
};

function passportState(stamps: PassportStamp[]) {
  return {
    memories: [cebuMemory],
    stamps,
    postcards: [],
    loading: false,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DestinationDetailScreen — divergent-label city stamps', () => {
  it('shows a stamp whose label diverges from the city name', async () => {
    mockUsePassport.mockReturnValue(passportState([divergentStamp]));

    await render(<DestinationDetailScreen />);

    // Group resolves (header shows the city)
    // "Cebu" appears in both the header and the hero placeholder.
    await waitFor(() =>
      expect(screen.getAllByText('Cebu').length).toBeGreaterThan(0),
    );

    // The Stamps section counts the divergent-label stamp…
    expect(screen.getByText('Stamps (1)')).toBeTruthy();
    // …and the stamp badge itself is visible (StampBadge renders the label).
    expect(screen.getByText('CEBU HERITAGE')).toBeTruthy();
    // No empty-state placeholder for stamps.
    expect(screen.queryByText(/No stamps for this destination/i)).toBeNull();
  });

  it('sanity: encodeDestinationKey round-trips the fixture key', () => {
    expect(decodeURIComponent(encodeDestinationKey('cebu|'))).toBe('cebu|');
  });
});
