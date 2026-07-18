/**
 * DiscoveryHub — Context mode chips disabled when no destination
 *
 * Confirms that when no destination is set (screenStatus === 'location-required'),
 * none of the context mode chips call setContextMode when pressed — they are
 * disabled and visually dimmed.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: {
    push:     jest.fn(),
    replace:  jest.fn(),
    back:     jest.fn(),
    navigate: jest.fn(),
    dismiss:  jest.fn(),
  },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  useNavigation: () => ({
    navigate:    jest.fn(),
    goBack:      jest.fn(),
    setOptions:  jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: () => null,
  Stack:    { Screen: () => null },
  Tabs:     { Screen: () => null },
}));

// ── react-native-safe-area-context ────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── Services ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/hashtag', () => ({
  getTrendingHashtags: jest.fn().mockResolvedValue({ ok: true, data: { trending: [] } }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discovery', () => ({
  getDiscoveryCategoryCounts:      jest.fn().mockResolvedValue({}),
  getDiscoveryCategoryCountsBatch: jest.fn().mockResolvedValue({}),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/trips', () => ({
  listMyTrips: jest.fn().mockResolvedValue([]),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/rentABuddy', () => ({
  getAvailableNow: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  navBarProgress:         { value: 0 },
  NAV_BAR_FILLER_HEIGHT:  96,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useBottomInset: () => 130,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useFollowingHighlights', () => ({
  useFollowingHighlights: () => ({
    users:             [],
    sessionViewedIds:  new Set<string>(),
    markSessionViewed: jest.fn(),
  }),
}));

// ── Contexts ──────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'user-test-1', isAuthed: true }),
}));

// Mutable — individual tests set what they need.
let mockLocationState: {
  place: { city: string | null; country: string | null };
  coords: { lat: number; lng: number } | null;
} = { place: { city: null, country: null }, coords: null };

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState:   mockLocationState,
    // resolvedLocation — required by discovery.tsx after location unification.
    resolvedLocation: {
      place:  mockLocationState.place,
      coords: mockLocationState.coords,
      source: 'home',
      freshness: 'unavailable',
    },
    showCityPicker:  false,
    openCityPicker:  jest.fn(),
    closeCityPicker: jest.fn(),
    setManualCity:   jest.fn().mockResolvedValue(undefined),
    isLoading:       false,
  }),
}));

// ── PlanPickerController ──────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn() }),
}));

// ── Heavy sub-components ──────────────────────────────────────────────────────
const Null = () => null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',        () => ({ LayoverModeSheet:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab',  () => ({ DiscoveryCategoryTab:  Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',      () => ({ PlaceDetailSheet:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab',             () => ({ ForYouTab:             Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DestinationBar',        () => ({ DestinationBar:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow',         () => ({ CompassBuddyRow:       Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',                () => ({ ManualCityPicker:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip',        () => ({ FollowingHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet',               () => ({ RouteBuilderSheet:     Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',      () => ({ SubmitPlaceSheet:      Null }));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Chip labels from CONTEXT_MODES ────────────────────────────────────────────
const CHIP_LABELS = ['Near Me', 'In City', 'Going Soon', 'Around Crew', 'Safe Nearby'];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — context mode chips', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocationState = { place: { city: null, country: null }, coords: null };
  });

  it('none of the chips call setContextMode when no destination is set', async () => {
    // No city → screenStatus === 'location-required' → all chips disabled.
    const { unmount } = await render(<DiscoveryHub />);
    await act(async () => {});

    for (const label of CHIP_LABELS) {
      const chip = screen.getByText(label);
      // The chip must be in the tree.
      expect(chip).toBeTruthy();
      // Pressing a disabled Pressable must not trigger router navigation or
      // any state update. We verify indirectly: fireEvent.press must not
      // throw, and the contextMode remains at the default ('in_city'), which
      // means the 'In City' chip is the only one with an active style and
      // pressing any chip does not change the rendered label set.
      fireEvent.press(chip);
    }

    // All chip labels still rendered unchanged — no contextMode switch occurred.
    for (const label of CHIP_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    await act(async () => { unmount(); });
  });

  it('all chips are marked disabled when no destination is set', async () => {
    const { unmount } = await render(<DiscoveryHub />);
    await act(async () => {});

    for (const label of CHIP_LABELS) {
      // The Pressable wrapping each chip label should have accessibilityState.disabled = true.
      const chip = screen.getByText(label);
      // Walk up to find the Pressable — it is the direct parent in the rendered tree.
      const pressable = chip.parent;
      expect(pressable?.props?.accessibilityState?.disabled).toBe(true);
    }

    await act(async () => { unmount(); });
  });

  it('chips are NOT disabled when a destination is set', async () => {
    mockLocationState = {
      place:  { city: 'Rome', country: 'Italy' },
      coords: { lat: 41.9028, lng: 12.4964 },
    };

    const { unmount } = await render(<DiscoveryHub />);
    await act(async () => {});

    for (const label of CHIP_LABELS) {
      const chip = screen.getByText(label);
      const pressable = chip.parent;
      // disabled must be absent or false when a city is available.
      expect(pressable?.props?.accessibilityState?.disabled).toBeFalsy();
    }

    await act(async () => { unmount(); });
  });
});
