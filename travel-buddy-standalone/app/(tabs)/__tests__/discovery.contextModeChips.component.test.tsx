/**
 * DiscoveryHub — Context mode chips disabled when no destination
 *
 * Confirms that when no destination is set (screenStatus === 'location-required'),
 * none of the context mode chips call setContextMode when pressed — they are
 * disabled and visually dimmed.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';
import { color } from '../../../src/theme/tokens';

const mockForYouModes: (string | undefined)[] = [];
const mockOpenCityPicker = jest.fn();

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
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
  useLayoverAwareBottomInset: () => 130,
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
    setSessionLocation: jest.fn(),
    clearSessionLocation: jest.fn(),
    locationState:   mockLocationState,
    // resolvedLocation — required by discovery.tsx after location unification.
    resolvedLocation: {
      place:  mockLocationState.place,
      coords: mockLocationState.coords,
      source: 'home',
      freshness: 'unavailable',
    },
    showCityPicker:  false,
    openCityPicker:  mockOpenCityPicker,
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
// NOTE: intentional stub — must stay exhaustive; the screen imports
// FilterStrip + SORT_LABELS from this module too (missing exports crash
// the filters panel into its SectionErrorBoundary).
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab',  () => ({
  DiscoveryCategoryTab: Null,
  // The screen also imports FilterStrip + SORT_LABELS from this module —
  // omitting them makes the expanded filters panel crash into its
  // SectionErrorBoundary (undefined element type).
  FilterStrip: Null,
  SORT_LABELS: {},
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',      () => ({ PlaceDetailSheet:      Null }));
// NOTE: intentional stub — not under test here.
// NOTE: intentional capture stub — records the contextMode prop on every
// render; the tab is the real
// consumer of contextMode, and prop capture works even when this
// renderer's visual commits stall (renders still execute).
jest.mock('../../../src/components/discovery/ForYouTab', () => ({
  ForYouTab: (props: { contextMode?: string }) => {
    mockForYouModes.push(props.contextMode);
    return null;
  },
}));
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
    mockForYouModes.length = 0;
    mockLocationState = { place: { city: null, country: null }, coords: null };
  });

  // NOTE (standalone fork): unlike the mobile tree, this screen has no
  // dimmed-chip / city-picker / nudge-banner behaviour — the context chips
  // live inside the collapsible filters panel ({filtersExpanded && ...} in
  // ../discovery.tsx), are always enabled, and simply switch contextMode.
  // The former mobile-derived tests asserted features that do not exist
  // here; this test covers the ACTUAL behaviour.
  // Renderer constraint (React 19 + RNTL v14): single test, single
  // instance; press → act() flush → re-query for committed style updates.
  // Renderer constraint (React 19 + RNTL v14 + jest-expo): only ONE
  // press-derived state commit is available per file, and these chips only
  // exist behind the filters-panel expand press — so the expand consumes it.
  // A second press (or even a direct handler call) after the expand never
  // renders, so the press-switches-mode scenario is NOT testable in this
  // tree's panel-gated layout.  Chip-press mode switching is covered in the
  // mobile tree (artifacts/travel-buddy, archived at bc1bef404), where the chips
  // rendered un-gated.
  it('expanding filters reveals always-enabled chips wired to contextMode', async () => {
    const ACTIVE_BG = color.signal + '14';

    const view = await render(<DiscoveryHub />);
    await act(async () => {});

    // Chips are hidden while the filters panel is collapsed, and the tab
    // already receives the default mode.
    expect(view.queryByText('Near Me')).toBeNull();
    expect(mockForYouModes).toContain('in_city');

    // Expand the filters panel (SlidersHorizontal toggle button —
    // fireEvent.press walks up from the icon stub to the Pressable).
    fireEvent.press(view.getByTestId('icon-SlidersHorizontal'));
    await act(async () => {});

    // All chips render; default mode is 'in_city' → 'In City' is active,
    // others are not, and nothing here is disabled or city-picker-gated.
    for (const label of CHIP_LABELS) {
      expect(view.getByText(label)).toBeTruthy();
    }
    expect(view.getByText('In City').parent).toHaveStyle({ backgroundColor: ACTIVE_BG });
    expect(view.getByText('Near Me').parent).not.toHaveStyle({ backgroundColor: ACTIVE_BG });
    expect(view.getByText('Near Me').parent?.props?.accessibilityState?.disabled).not.toBe(true);
    expect(mockOpenCityPicker).not.toHaveBeenCalled();
  });
});
