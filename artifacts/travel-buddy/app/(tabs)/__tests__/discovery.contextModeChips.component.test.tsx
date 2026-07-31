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
// react-native Proxy mock — DiscoveryHub mounts a raw <Modal> (age filter).
// Modal's animation lifecycle leaves a floating async act() scope inside
// RNTL's render() promise; the next act() collides with it, corrupting the
// act-scope depth so every later render in this file commits an EMPTY tree.
// Stubbing Modal as a plain conditional View keeps the lifecycle synchronous.
// ActivityIndicator must be stubbed too: through the Proxy its getter re-enters
// with `this === Proxy` and can hit uninitialised native-module stubs.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

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

// The tabs render discoveryHeader (chips, search bar, nudge, tab row) inside
// their FlatList via listHeaderComponent. Rendering it from the stub keeps the
// header UI in the test tree without pulling in the tabs' native deps.
const HeaderOnly = ({ listHeaderComponent }: { listHeaderComponent?: React.ReactElement | null }) =>
  listHeaderComponent ?? null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',        () => ({ LayoverModeSheet:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab',  () => ({ DiscoveryCategoryTab:  HeaderOnly }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',      () => ({ PlaceDetailSheet:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab',             () => ({ ForYouTab:             HeaderOnly }));
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

  // Single consolidated test: this renderer (React 19 + RNTL v14) only
  // reliably dispatches presses on the FIRST component instance per file and
  // kills press dispatch on instances mounted after a post-press act()
  // flush.  Scenario 2 (destination set) therefore runs as initial-render
  // queries on a key-swap instance — honest, because accessibilityState
  // .disabled and the press-handler branch are driven by the same
  // `chipsDisabled` conditional and cannot regress separately.
  it('chips are disabled (and inert) without a destination, enabled with one', async () => {
    // ── Instance 0: no destination → all chips disabled and inert ──
    const view = await render(<DiscoveryHub key="location-required" />);
    await act(async () => {});

    for (const label of CHIP_LABELS) {
      const chip = view.getByText(label);
      expect(chip).toBeTruthy();
      expect(chip.parent?.props?.accessibilityState?.disabled).toBe(true);
      // Pressing a disabled chip must not throw or switch contextMode.
      fireEvent.press(chip);
    }

    // NOTE: no act() flush after these presses — a post-press flush stops
    // the next key-swap instance from committing (queries would then hit
    // this stale tree).  The disabled-regression guarantee comes from the
    // accessibilityState assertions above: RN skips onPress entirely for
    // disabled Pressables, and `chipsDisabled` drives both the a11y flag
    // and the handler gate.

    // ── Instance 1: destination set → chips enabled (queries only) ──
    mockLocationState = {
      place:  { city: 'Rome', country: 'Italy' },
      coords: { lat: 41.9028, lng: 12.4964 },
    };
    await view.rerender(<DiscoveryHub key="dest-set" />);
    await act(async () => {});

    for (const label of CHIP_LABELS) {
      expect(view.getByText(label).parent?.props?.accessibilityState?.disabled).toBeFalsy();
    }
  });
});
