/**
 * TripsTab — video play badge tests
 *
 * Confirms that:
 * 1. A featured trip with coverMediaType='video' renders VideoThumbnail — play badge visible.
 * 2. A featured trip with coverMediaType='image' renders a plain Image — no play badge.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 *
 * ## Mock strategy
 *
 * useBottomInset is mocked at the hook boundary to avoid dragging in reanimated
 * native binaries (makeMutable crashes in the jest-expo runner).
 * expo-image is mocked exhaustively because it relies on native ExpoView/ImageModule
 * internals unavailable under jest-expo.
 * expo-router is already aliased via moduleNameMapper (expo-router.tsx stub).
 * lucide-react-native is already aliased via moduleNameMapper (renders each icon
 * as <View testID="icon-<Name>" />).
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { TripsTab } from '../TripsTab.tsx';
import type { TripRow } from '../../services/trips.ts';

// NOTE: intentionally exhaustive — useBottomInset.ts imports useNavBarCollapse
// which calls makeMutable() (reanimated) at module scope; requireActual would
// execute that import chain and crash the JSDOM suite.
jest.mock('../../hooks/useBottomInset.ts', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
}));

// NOTE: intentionally exhaustive — expo-image uses native ExpoView and
// ImageModule internals that crash the jest-expo runner when loaded via
// requireActual.  A lightweight stub is sufficient for these render tests.
jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ testID, ...rest }: { testID?: string; [k: string]: unknown }) =>
      React.createElement(View, { testID: testID ?? 'expo-image', ...rest }),
  };
});

// ── Fixture factory ───────────────────────────────────────────────────────────

function makeTrip(overrides: Partial<TripRow> = {}): TripRow {
  return {
    id: 'trip-1',
    ownerId: 'owner-1',
    title: 'Tokyo Adventure',
    destinationCity: 'Tokyo',
    destinationCountry: 'Japan',
    neighborhoods: [],
    startDate: '2026-09-01',
    endDate: '2026-09-15',
    status: 'active',
    visibility: 'public',
    travelStyle: null,
    openToMeet: true,
    coverUrl: null,
    coverMediaType: null,
    progress: 0,
    tripType: null,
    timezone: null,
    destinationLat: 35.68,
    destinationLng: 139.69,
    destinationPlaceId: null,
    tripNotes: null,
    showOnProfile: true,
    showInDiscovery: true,
    allowFriendSuggestions: true,
    allowTripCrewInvites: true,
    allowJoinRequests: false,
    showExactDates: true,
    showDestinationCity: true,
    delayedPostingDefault: false,
    preciseLocationVisible: false,
    planEditPermission: null,
    ...overrides,
  };
}

// ── Tests — video cover ───────────────────────────────────────────────────────

describe('TripsTab — video cover trip', () => {
  it('renders the play badge (VideoThumbnail) for a featured trip with coverMediaType="video"', async () => {
    const trip = makeTrip({
      coverMediaType: 'video',
      coverUrl: 'https://example.com/cover.mp4',
    });
    await render(<TripsTab trips={[trip]} isOwner />);

    // VideoThumbnail exposes accessibilityLabel="Play video" on its Pressable.
    expect(screen.getByLabelText('Play video')).toBeTruthy();
  });

  it('shows the play icon inside VideoThumbnail for a video cover trip', async () => {
    const trip = makeTrip({
      coverMediaType: 'video',
      coverUrl: 'https://example.com/cover.mp4',
    });
    await render(<TripsTab trips={[trip]} isOwner />);

    // The lucide mock renders Play as <View testID="icon-Play" />.
    expect(screen.getByTestId('icon-Play')).toBeTruthy();
  });
});

// ── Tests — image cover ───────────────────────────────────────────────────────

describe('TripsTab — image cover trip', () => {
  it('renders no play badge for a featured trip with coverMediaType="image"', async () => {
    const trip = makeTrip({
      coverMediaType: 'image',
      coverUrl: 'https://example.com/cover.jpg',
    });
    await render(<TripsTab trips={[trip]} isOwner />);

    // VideoThumbnail must not be present — no play badge accessibility label.
    expect(screen.queryByLabelText('Play video')).toBeNull();
  });

  it('renders no play icon for a featured trip with coverMediaType="image"', async () => {
    const trip = makeTrip({
      coverMediaType: 'image',
      coverUrl: 'https://example.com/cover.jpg',
    });
    await render(<TripsTab trips={[trip]} isOwner />);

    // The lucide Play icon is only rendered by VideoThumbnail.
    expect(screen.queryByTestId('icon-Play')).toBeNull();
  });
});
