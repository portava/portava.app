/**
 * PlaceDetailSheet — "Generate header image" button visibility test
 *
 * Confirms that:
 *   1. Admin session + flag enabled  → button IS visible (testID place-sheet-generate-header-btn)
 *   2. Non-admin session + flag enabled → button is ABSENT
 *   3. Admin session + flag disabled  → button is ABSENT
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
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
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

// NOTE: intentionally exhaustive — LocationContext reads session + GPS state
// from multiple native hooks; we only need a stub resolvedLocation here.
jest.mock('../../../context/LocationContext', () => ({
  useLocationContext: () => ({
    resolvedLocation: { coords: null, source: 'none', freshness: 'unavailable', place: null },
  }),
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs suffice.

// Mutable flag control — mutated per-test via mockFlagEnabled.
let mockFlagEnabled = false;

// NOTE: intentionally exhaustive — FeatureFlagsContext fetches from the network
// on mount; only isEnabled is needed and its value is controlled per-test.
jest.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    isEnabled: (key: string) => key === 'ai_place_headers_enabled' && mockFlagEnabled,
    loading: false,
  }),
}));

// Mutable role control — mutated per-test via mockRole.
let mockRole: string | null = null;

// NOTE: intentionally exhaustive — SessionContext calls Supabase auth and
// profile endpoints on mount; only `role` is needed and is controlled per-test.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({
    userId: 'user-123',
    isAuthed: true,
    loading: false,
    configured: true,
    signOut: async () => {},
    role: mockRole,
    roleLoaded: true,
    accountStatus: 'active',
    accountStatusLoaded: true,
    deletionScheduledAt: null,
    refreshAccountStatus: async () => {},
  }),
}));

// NOTE: intentionally exhaustive — GenerateHeaderSheet has its own Modal chain
// and makes network calls; stubbing to null prevents secondary act() scopes.
jest.mock('../../events/GenerateHeaderSheet', () => ({
  GenerateHeaderSheet: () => null,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PLACE: DiscoveryPlace = {
  id:           'place-gen-hdr-1',
  name:         'Test Café',
  category:     'food',
  type:         'cafe',
  description:  'A nice café',
  distanceKm:   null,
  lat:          48.8566,
  lng:          2.3522,
  tags:         [],
  address:      '1 Rue de Rivoli, Paris',
  website:      null,
  phone:        null,
  openingHours: null,
  rating:       null,
  isOpenNow:    null,
};

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountSheet(place: DiscoveryPlace = BASE_PLACE) {
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

describe('PlaceDetailSheet — Generate header image button visibility', () => {
  beforeEach(() => {
    mockFlagEnabled = false;
    mockRole = null;
  });

  afterEach(() => jest.clearAllMocks());

  it('shows the generate-header button for an admin when the flag is enabled', async () => {
    mockRole = 'admin';
    mockFlagEnabled = true;

    const { getByTestId } = await mountSheet();

    await waitFor(() => {
      expect(getByTestId('place-sheet-generate-header-btn')).toBeTruthy();
    });
  });

  it('does not show the generate-header button for a non-admin even when the flag is enabled', async () => {
    mockRole = 'user';
    mockFlagEnabled = true;

    const { queryByTestId } = await mountSheet();

    await waitFor(() => {
      expect(queryByTestId('place-sheet-generate-header-btn')).toBeNull();
    });
  });

  it('does not show the generate-header button for an admin when the flag is disabled', async () => {
    mockRole = 'admin';
    mockFlagEnabled = false;

    const { queryByTestId } = await mountSheet();

    await waitFor(() => {
      expect(queryByTestId('place-sheet-generate-header-btn')).toBeNull();
    });
  });
});
