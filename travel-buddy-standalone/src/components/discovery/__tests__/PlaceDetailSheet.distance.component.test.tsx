/**
 * PlaceDetailSheet — distance rendering test
 *
 * Confirms that:
 *   1. When place.distanceKm is set, the distance row is shown.
 *   2. When place.distanceKm is null but the user's location has coords and
 *      the place has lat/lng, the distance is computed and shown.
 *   3. When neither source provides distance, the distance row is absent.
 *
 * ## Modal strategy
 * PlaceDetailSheet IS a Modal. The Modal Proxy replaces react-native's Modal
 * with a synchronous View so act() scopes don't overlap.
 * Must be declared before any imports that touch react-native.
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports.
// Avoids overlapping act() from Modal animation lifecycle — see
// .agents/memory/modal-proxy-mock.md.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { PlaceDetailSheet } from '../PlaceDetailSheet.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals; only getPlaceLiveStatus is needed and its return value is
// controlled entirely by this stub.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatus: jest.fn().mockResolvedValue(null),
  getWikidataEnrichment: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules
// that are not safe under jest-expo; only the stubs are needed.
jest.mock('../../../services/collections', () => ({
  checkSaved:  jest.fn().mockResolvedValue({ saved: false }),
  toggleSave:  jest.fn().mockResolvedValue(false),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker has its own Modal chain;
// stubbing to null prevents a secondary act() scope.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — useBottomInset reads safe-area native
// modules that crash under jest-expo; a constant inset of 0 is sufficient.
jest.mock('../../../hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 0,
}));

// NOTE: intentionally exhaustive — expo-image pulls in native modules that
// crash under jest-expo; the fallback branch is all we need.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, children, testID }: any) => {
    const { View } = require('react-native');
    if (!uri && fallback) return <View testID={testID ?? 'sheet-img'}>{fallback}</View>;
    return <View testID={testID ?? 'sheet-img'}>{children ?? null}</View>;
  },
  MediaFallback: () => {
    const { View } = require('react-native');
    return <View testID="sheet-media-fallback" />;
  },
}));

// mockResolvedLocation is mutated per-test to control user location.
const mockResolvedLocation = {
  coords: null as { lat: number; lng: number } | null,
  source: 'none' as const,
  freshness: 'unavailable' as const,
  place: null,
};
// NOTE: intentionally exhaustive — LocationContext reads session + GPS state
// from multiple native hooks; we only need resolvedLocation.coords here.
jest.mock('../../../context/LocationContext', () => ({
  useLocationContext: () => ({ resolvedLocation: mockResolvedLocation }),
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs suffice.

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PLACE: DiscoveryPlace = {
  id:           'place-dist-1',
  name:         'Test Place',
  category:     'places',
  type:         'landmark',
  description:  null,
  distanceKm:   null,
  lat:          48.8566,
  lng:          2.3522,
  tags:         [],
  address:      '1 Place du Louvre, Paris',
  website:      null,
  phone:        null,
  openingHours: null,
  rating:       null,
  isOpenNow:    null,
};

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountSheet(place: DiscoveryPlace) {
  return render(
    <PlaceDetailSheet
      place={place}
      visible
      onClose={jest.fn()}
      onAddToPlan={jest.fn()}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceDetailSheet — distance row', () => {
  beforeEach(() => {
    // Reset to no user location before each test.
    mockResolvedLocation.coords = null;
  });

  afterEach(() => jest.clearAllMocks());

  it('shows distance row when place.distanceKm is set', async () => {
    const place: DiscoveryPlace = { ...BASE_PLACE, distanceKm: 1.4 };

    const { getByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(getByTestId('place-sheet-distance')).toBeTruthy();
    });
  });

  it('shows distance row when place.distanceKm is null but user location is provided', async () => {
    // User is nearby in Paris — haversine distance will be small but non-null.
    mockResolvedLocation.coords = { lat: 48.8500, lng: 2.3460 };
    const place: DiscoveryPlace = { ...BASE_PLACE, distanceKm: null };

    const { getByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(getByTestId('place-sheet-distance')).toBeTruthy();
    });
  });

  it('does not show distance row when no distance source is available', async () => {
    // No distanceKm and no user location coords.
    mockResolvedLocation.coords = null;
    const place: DiscoveryPlace = { ...BASE_PLACE, distanceKm: null };

    const { queryByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(queryByTestId('place-sheet-distance')).toBeNull();
    });
  });
});
