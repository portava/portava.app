/**
 * Travel History screen — component tests.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. When both listMyTrips + getMyPassportStamps succeed, the screen renders
 *    the trip title and the visited-place label without crashing.
 * 2. When both return empty, the appropriate empty-state texts appear.
 * 3. When listMyTrips succeeds but getMyPassportStamps rejects (Promise.allSettled
 *    partial failure), the trip section still renders without crashing — the
 *    stamps error is silently swallowed.
 *
 * ## Why these tests exist
 *
 * The screen fetches in parallel via Promise.allSettled.  Either branch can
 * fail or return empty while the other succeeds.  Without explicit tests the
 * blank / partial-data paths can silently regress.
 */

import React from 'react';
import { render, waitFor, screen, cleanup } from '@testing-library/react-native';
import TravelHistoryScreen from '../travel-history.tsx';
import { listMyTrips } from '../../../src/services/trips.ts';
import { getMyPassportStamps } from '../../../src/services/passportStamps.ts';

// NOTE: intentional stub — only router.back / canGoBack / push / replace are
// exercised by the header back button and trip row press; full expo-router is
// not under test here.
jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
    push: jest.fn(),
    replace: jest.fn(),
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../src/services/trips', () => ({
  ...jest.requireActual('../../../src/services/trips'),
  listMyTrips: jest.fn(),
}));

jest.mock('../../../src/services/passportStamps', () => ({
  ...jest.requireActual('../../../src/services/passportStamps'),
  getMyPassportStamps: jest.fn(),
}));

const mockListMyTrips = listMyTrips as jest.Mock;
const mockGetMyPassportStamps = getMyPassportStamps as jest.Mock;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeTrip(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trip-1',
    ownerId: 'user-1',
    title: 'Rome Adventure',
    destinationCity: 'Rome',
    destinationCountry: 'Italy',
    neighborhoods: [],
    startDate: '2025-01-10',
    endDate: '2025-01-20',
    status: 'completed',
    visibility: 'private',
    travelStyle: null,
    openToMeet: false,
    coverUrl: null,
    coverMediaType: null,
    progress: 100,
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
    showHeaderPublicly: false,
    ...overrides,
  };
}

function makeStamp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stamp-1',
    stampDefinitionId: null,
    definition: null,
    stampType: 'city',
    country: 'Italy',
    city: 'Florence',
    neighborhood: null,
    titleOverride: null,
    placeId: null,
    planId: null,
    tripId: 'trip-1',
    sourceType: 'manual',
    verificationLevel: 'unverified',
    visibility: 'public',
    displayOnPassport: true,
    isRevoked: false,
    earnedAt: '2025-01-15T10:00:00Z',
    createdAt: '2025-01-15T10:00:00Z',
    catalogId: null,
    activeArtworkUrl: null,
    thumbnailUrl: null,
    ...overrides,
  };
}

// ── Teardown ──────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TravelHistoryScreen', () => {
  it('renders trip title and place label when both sources return data', async () => {
    mockListMyTrips.mockResolvedValue([makeTrip()]);
    mockGetMyPassportStamps.mockResolvedValue({
      ok: true,
      data: [makeStamp()],
      total: 1,
    });

    await render(<TravelHistoryScreen />);

    await waitFor(() =>
      expect(screen.queryByText('Travel History')).toBeTruthy(),
    );

    // Trip title must be visible
    expect(screen.getByText('Rome Adventure')).toBeTruthy();

    // Place label "Florence, Italy" from the stamp (distinct from the trip destination "Rome, Italy")
    expect(screen.getByText('Florence, Italy')).toBeTruthy();
  });

  it('shows empty-state texts when both sources return empty', async () => {
    mockListMyTrips.mockResolvedValue([]);
    mockGetMyPassportStamps.mockResolvedValue({ ok: true, data: [], total: 0 });

    await render(<TravelHistoryScreen />);

    await waitFor(() =>
      expect(screen.queryByText('PAST TRIPS')).toBeTruthy(),
    );

    expect(screen.getByText('No completed trips yet.')).toBeTruthy();
    expect(screen.getByText('No stamps collected yet.')).toBeTruthy();
  });

  it('renders the trip section without crashing when stamps fetch rejects', async () => {
    mockListMyTrips.mockResolvedValue([makeTrip()]);
    // Simulate Promise.allSettled rejection path — getMyPassportStamps throws
    mockGetMyPassportStamps.mockRejectedValue(new Error('Network failure'));

    await render(<TravelHistoryScreen />);

    await waitFor(() =>
      expect(screen.queryByText('PAST TRIPS')).toBeTruthy(),
    );

    // The trip should still appear
    expect(screen.getByText('Rome Adventure')).toBeTruthy();

    // Stamps section shows empty state (stamps error was swallowed)
    expect(screen.getByText('No stamps collected yet.')).toBeTruthy();
  });
});
