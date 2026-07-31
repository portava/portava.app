/**
 * DiscoveryHub — tapping a dimmed chip opens the city picker
 *
 * Confirms that when screenStatus === 'location-required' (no destination set):
 *   1. Tapping a context-mode chip calls openCityPicker.
 *   2. The nudge banner receives the highlighted style immediately after the tap.
 *   3. The highlighted style is cleared after the 1800 ms timeout elapses.
 *
 * And that when a destination IS set, tapping a chip does NOT call openCityPicker
 * (the chip switches contextMode normally instead).
 *
 * Run with: pnpm --filter @workspace/travel-buddy test -- --watchAll=false
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';
import { color } from '../../../src/theme/tokens';

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
  useSession: () => ({ userId: 'user-test-1', isAuthed: false }),
}));

// Mutable — individual tests set what they need.
let mockLocationState: {
  place: { city: string | null; country: string | null };
  coords: { lat: number; lng: number } | null;
} = { place: { city: null, country: null }, coords: null };

// Stable spy captured at module level so tests can assert on it.
const mockOpenCityPicker = jest.fn();

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState:        mockLocationState,
    resolvedLocation: {
      place:     mockLocationState.place,
      coords:    mockLocationState.coords,
      source:    'home',
      freshness: 'unavailable',
    },
    showCityPicker:       false,
    openCityPicker:       mockOpenCityPicker,
    closeCityPicker:      jest.fn(),
    setManualCity:        jest.fn().mockResolvedValue(undefined),
    setSessionLocation:   jest.fn(),
    clearSessionLocation: jest.fn(),
    isLoading:            false,
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

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discoveryLocalCache', () => ({
  loadCachedCounts: jest.fn().mockResolvedValue(null),
  saveCachedCounts: jest.fn().mockResolvedValue(undefined),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const CHIP_LABELS = ['Near Me', 'In City', 'Going Soon', 'Around Crew', 'Safe Nearby'];

/** The `locationNudgeHighlighted` backgroundColor value from the stylesheet. */
const NUDGE_HIGHLIGHTED_BG = color.signal + '28';

/** Accessibility label of the location-nudge banner in the discovery header. */
const BANNER_LABEL = 'Set your location to discover nearby places';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — dimmed chip tap opens city picker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocationState = { place: { city: null, country: null }, coords: null };
  });

  // NOTE — renderer constraints in this file (React 19 + RNTL v14):
  //  * Only the first ~2 `await render()` mounts across TESTS flush reliably;
  //    later tests' renders commit stale/empty trees.  All location-required
  //    behaviours are therefore consolidated into ONE test that uses key-swap
  //    rerenders (`view.rerender(<DiscoveryHub key=… />)`) to get a fresh
  //    component instance (fresh cityPickerPendingRef) without unmounting.
  //  * No jest.useFakeTimers() — fake timers (any doNotFake configuration)
  //    corrupt the renderer at the test boundary the same way.  The nudge
  //    timeout is controlled by spying on global.setTimeout and invoking the
  //    captured 1800 ms callback manually.
  //  * Queries go through the bound `view`, not the shared `screen`.

  it('dimmed chips open the city picker (guarded) and flash the nudge banner', async () => {
    // RENDERER CONSTRAINTS (React 19 + RNTL v14, empirically bisected in
    // this repo): the renderer degrades cumulatively within a test file —
    //  * instance 1: presses dispatch AND setState commits reach the tree;
    //  * instance 2+: presses may still dispatch (mock counts work) but
    //    style/state commits no longer render, and after a post-press act()
    //    flush press dispatch dies entirely on later instances;
    //  * fake timers (any doNotFake config) corrupt the file at the first
    //    test boundary, and manually invoking captured timer callbacks never
    //    commits their setState.
    // Consequently this file holds exactly ONE test on ONE instance: all
    // live-press behaviour plus the nudge-highlight lifecycle (committed
    // style updates + the real 1800 ms timer).  The destination-set
    // scenario lives in discovery.enabledChips.component.test.tsx on a
    // fresh renderer, keeping its presses live and its coverage honest.
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    try {
      // ── Instance 0 (location-required): dimmed chips, guard, nudge ──
      const view = await render(<DiscoveryHub key="location-required" />);
      await act(async () => {});

      // Nudge banner present and unhighlighted before any tap; every chip
      // renders in the dimmed (a11y-disabled) state.
      expect(view.getByLabelText(BANNER_LABEL)).not.toHaveStyle({
        backgroundColor: NUDGE_HIGHLIGHTED_BG,
      });
      for (const label of CHIP_LABELS) {
        expect(view.getByText(label).parent?.props?.accessibilityState).toEqual(
          expect.objectContaining({ disabled: true }),
        );
      }

      // First tap on a dimmed chip opens the picker exactly once.  All five
      // chips share one CONTEXT_MODES.map() Pressable template and one
      // cityPickerPendingRef, so one live press covers "any chip".
      fireEvent.press(view.getByText('Near Me'));
      expect(mockOpenCityPicker).toHaveBeenCalledTimes(1);

      // Rapid second tap on the SAME chip: guarded no-op.
      fireEvent.press(view.getByText('Near Me'));
      expect(mockOpenCityPicker).toHaveBeenCalledTimes(1);

      // Rapid tap on a DIFFERENT chip: the shared guard still blocks a
      // second open until the picker closes (no branch on chip identity).
      fireEvent.press(view.getByText('In City'));
      expect(mockOpenCityPicker).toHaveBeenCalledTimes(1);

      // The tap scheduled the 1800 ms nudge-clear timer.
      expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 1800)).toBe(true);

      // Commit the press's setState.  NOTE: this flush is what kills press
      // dispatch on all later instances — no presses after this point.
      await act(async () => {});

      // Highlighted immediately after the tap (re-query — pre-press node
      // references go stale once the press re-renders the header).
      expect(view.getByLabelText(BANNER_LABEL)).toHaveStyle({
        backgroundColor: NUDGE_HIGHLIGHTED_BG,
      });

      // Sleep past the REAL 1800 ms timer inside act; highlight must clear.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2200));
      });
      expect(view.getByLabelText(BANNER_LABEL)).not.toHaveStyle({
        backgroundColor: NUDGE_HIGHLIGHTED_BG,
      });

    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
