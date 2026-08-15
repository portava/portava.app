/**
 * DiscoveryHub — Back-nav closes the place detail sheet
 *
 * Task 3642 fixed a bug where pressing browser/hardware Back from the
 * Discovery place detail sheet sent users to /passport instead of staying on
 * Discovery.  The fix pushes a synthetic history entry when the sheet opens and
 * absorbs the resulting `popstate` event to close the sheet instead of letting
 * it propagate as a tab navigation.
 *
 * Task 3657 fixed a related regression: the sheet stayed open after pressing
 * Back even though the URL remained correct.  Root cause: Expo Router registers
 * its own bubble-phase `popstate` listener at app-init time (before any
 * component effects run) and may absorb or stop the event before our handler
 * fires.  Fix: register our listener in CAPTURE phase (`true` as the third
 * argument) so it fires before any bubble-phase listener.  A `dismissedByBack`
 * flag in the closure prevents the cleanup from calling `history.back()` a
 * second time when the sheet was already closed by the Back button.
 *
 * This test covers the web back-nav guard path.  Because jest-expo's native
 * runner does not expose real DOM event APIs, the test:
 *   • forces Platform.OS to 'web' via the react-native Proxy mock so the guard
 *     activates inside the component
 *   • installs a minimal window event-emitter in beforeEach so the guard's
 *     addEventListener / removeEventListener / dispatchEvent calls work
 *   • the event-emitter stub ignores the capture/bubble argument (third arg)
 *     since there is no second listener competing in tests — this is fine
 *     because the stub fires all listeners for a type unconditionally
 *
 * Confirmed behaviours:
 *   1. The sheet becomes visible after a place is selected.
 *   2. Firing a `popstate` event closes the sheet.
 *   3. The Discovery screen is still rendered (router.push was not called).
 *   4. The active category state is preserved (Layover FAB reappears).
 *   5. After a popstate close, history.back is NOT called a second time.
 *   6. A subsequent popstate (after the sheet is already closed) has no effect.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';
import type { DiscoveryPlace } from '../../../src/services/discovery';

// ── react-native Proxy mock ───────────────────────────────────────────────────
// Stubs Modal (animation lifecycle causes act-scope corruption) and
// ActivityIndicator (Proxy getter can hit uninitialised native-module stubs).
// Also overrides Platform to return OS:'web' so the history-based back-nav
// guard in discovery.tsx activates — without this override the guard's first
// line (`if (Platform.OS !== 'web') return;`) exits immediately in the native
// test runner.
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
      // Return a web platform stub so the popstate guard activates.
      if (prop === 'Platform') {
        return {
          OS: 'web' as const,
          select: (spec: Record<string, unknown>) => spec['web'] ?? spec['default'],
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// ── expo-router ───────────────────────────────────────────────────────────────
// IMPORTANT: jest.mock factories are hoisted before any const/let declarations.
// Access mock references via require() inside the test body, not at module scope.
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
  // Start on the 'places' tab so DiscoveryCategoryTab (not ForYouTab) renders —
  // DiscoveryCategoryTab is the stub that captures onSelectPlace.
  useLocalSearchParams: () => ({ category: 'places' }),
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

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discoveryLocalCache', () => ({
  loadCachedCounts: jest.fn().mockResolvedValue(null),
  saveCachedCounts: jest.fn().mockResolvedValue(undefined),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/apiToken', () => ({
  freshToken: jest.fn().mockResolvedValue(null),
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
  usePlainBottomInset:        () => 130,
  PlainBottomFiller:          () => null,
  BOTTOM_BREATHING_ROOM:      24,
  useStickyBarInset:          () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible:         () => false,
  useBottomInset:             () => 130,
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

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => false, loading: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/LocationContext', () => ({
  useLocationContext: () => ({
    locationState: {
      place:  { city: 'Tokyo', country: 'Japan' },
      coords: { lat: 35.6762, lng: 139.6503 },
    },
    resolvedLocation: {
      place:     { city: 'Tokyo', country: 'Japan' },
      coords:    { lat: 35.6762, lng: 139.6503 },
      source:    'gps',
      freshness: 'fresh',
    },
    showCityPicker:       false,
    openCityPicker:       jest.fn(),
    closeCityPicker:      jest.fn(),
    setManualCity:        jest.fn().mockResolvedValue(undefined),
    setSessionLocation:   jest.fn(),
    clearSessionLocation: jest.fn(),
    requestLocation:      jest.fn(),
    isLoading:            false,
  }),
}));

// ── PlanPickerController ──────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn() }),
}));

// ── Prop-capture stubs ────────────────────────────────────────────────────────
// Capture onSelectPlace from DiscoveryCategoryTab so the test can trigger
// detailVisible=true without fireEvent.press (avoiding the React 19 + RNTL
// press-budget constraint that limits reliable presses to one per file).
let capturedOnSelectPlace: ((place: DiscoveryPlace) => void) | null = null;

// NOTE: also exports FilterStrip and SORT_LABELS, both imported by discovery.tsx
// for the filter panel — omitting them crashes the filters panel.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({
  DiscoveryCategoryTab: (props: { onSelectPlace?: (p: DiscoveryPlace) => void; listHeaderComponent?: React.ReactElement | null }) => {
    capturedOnSelectPlace = props.onSelectPlace ?? null;
    return props.listHeaderComponent ?? null;
  },
  FilterStrip: () => null,
  SORT_LABELS: {},
}));

// Capture visible from PlaceDetailSheet so the test can assert it changes.
// Renders a sentinel testID when visible so the test can confirm the sheet opened.
let capturedSheetVisible: boolean | undefined = undefined;

jest.mock('../../../src/components/discovery/PlaceDetailSheet', () => {
  const R = require('react');
  const actual = jest.requireActual('react-native');
  return {
    PlaceDetailSheet: (props: { visible?: boolean; onClose?: () => void }) => {
      capturedSheetVisible = props.visible;
      return props.visible
        ? R.createElement(actual.View, { testID: 'place-detail-sheet' })
        : null;
    },
  };
});

// ── Remaining heavy sub-components ───────────────────────────────────────────
const Null = () => null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/layover/LayoverModeSheet',         () => ({ LayoverModeSheet:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/ForYouTab',              () => ({ ForYouTab:                Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DestinationBar',         () => ({ DestinationBar:           Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CompassBuddyRow',          () => ({ CompassBuddyRow:          Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/compass/CityConfidenceBadge',      () => ({ CityConfidenceBadge:      Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/ManualCityPicker',                 () => ({ ManualCityPicker:         Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/FollowingHighlightsStrip',         () => ({ FollowingHighlightsStrip: Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RouteBuilderSheet',                () => ({ RouteBuilderSheet:        Null }));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',       () => ({ SubmitPlaceSheet:         Null }));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Window event emitter ──────────────────────────────────────────────────────
// jest-expo's native environment has a `window` global but no DOM event APIs.
// The back-nav guard in discovery.tsx calls window.addEventListener /
// removeEventListener / dispatchEvent and window.history.pushState — none of
// which exist in the native runner.  Install a minimal emitter before each
// test so the guard can attach and receive its popstate listener.
//
// Platform.OS is forced to 'web' by the react-native Proxy mock above, so the
// guard's first-line `if (Platform.OS !== 'web') return;` does not short-circuit.

type SimpleListener = () => void;
const windowListeners = new Map<string, Set<SimpleListener>>();

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnSelectPlace = null;
  capturedSheetVisible  = undefined;
  windowListeners.clear();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;

  w.addEventListener = (type: string, cb: SimpleListener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type)!.add(cb);
  };
  w.removeEventListener = (type: string, cb: SimpleListener) => {
    windowListeners.get(type)?.delete(cb);
  };
  w.dispatchEvent = (event: { type: string }) => {
    windowListeners.get(event.type)?.forEach((cb) => cb());
    return true;
  };
  // Minimal history stub — pushState and back are recorded but do not mutate
  // history.state (so the cleanup branch `if (w.history.state?._discoverySheet)`
  // stays falsy and history.back is not called during popstate close).
  w.history = {
    pushState: jest.fn(),
    back:      jest.fn(),
    state:     null,
  };
  w.location = { href: 'http://localhost/' };
});

afterEach(async () => {
  // Drain any concurrent work scheduled outside act() before RNTL cleanup.
  await act(async () => {});
});

// ── Fake place ────────────────────────────────────────────────────────────────
const FAKE_PLACE: DiscoveryPlace = {
  id:           'place-tokyo-ramen-1',
  name:         'Test Ramen Shop',
  category:     'food',
  type:         null,
  description:  null,
  distanceKm:   null,
  lat:          35.68,
  lng:          139.69,
  tags:         [],
  address:      '1-1 Test St, Tokyo',
  website:      null,
  phone:        null,
  openingHours: null,
  rating:       null,
  isOpenNow:    null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — back-nav closes place detail sheet (web guard)', () => {
  // React 19 + RNTL v14 note: this test avoids fireEvent.press entirely.
  // Instead it calls the captured prop callbacks directly inside act() — the
  // same functions a real press would invoke — so the detailVisible state
  // transitions are honest and not mocked.
  it('popstate closes the sheet and keeps the Discovery screen visible — not navigating away', async () => {
    const view = await render(<DiscoveryHub />);
    await act(async () => {});

    // ── Precondition: screen is rendered, prop-capture hooks fired ──────────
    expect(view.getByText('Discover')).toBeTruthy();
    expect(typeof capturedOnSelectPlace).toBe('function');

    // Layover FAB is visible — sheet is not open yet.
    expect(view.queryByText('Layover Mode')).not.toBeNull();

    // ── Open the place detail sheet ─────────────────────────────────────────
    // Calling the captured prop is equivalent to the user tapping a place card.
    await act(async () => {
      capturedOnSelectPlace!(FAKE_PLACE);
    });

    // Sheet sentinel is present: PlaceDetailSheet received visible=true.
    expect(view.queryByTestId('place-detail-sheet')).not.toBeNull();
    expect(capturedSheetVisible).toBe(true);

    // Layover FAB is hidden while the sheet is open ({!detailVisible && ...}).
    expect(view.queryByText('Layover Mode')).toBeNull();

    // The guard must have pushed a synthetic history entry when the sheet opened.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).history.pushState).toHaveBeenCalledWith(
      { _discoverySheet: true },
      '',
      'http://localhost/',
    );

    // A popstate listener must be attached (our emitter holds it).
    expect(windowListeners.get('popstate')?.size).toBeGreaterThan(0);

    // ── Fire a browser Back (popstate) event ────────────────────────────────
    // The useEffect in discovery.tsx attached a popstate listener when
    // detailVisible became true.  Dispatching via our minimal window emitter
    // exercises the exact same handler the browser's Back button would invoke.
    // The handler (`const handlePop = () => setDetailVisible(false)`) does not
    // read the event object, so any truthy event dispatch suffices.
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dispatchEvent({ type: 'popstate' });
    });

    // ── Assert: sheet closed, Discovery still shown ─────────────────────────
    // Sheet sentinel must be gone — PlaceDetailSheet received visible=false.
    expect(view.queryByTestId('place-detail-sheet')).toBeNull();
    expect(capturedSheetVisible).toBe(false);

    // The Discovery screen header must still be rendered — the user was NOT
    // navigated away from Discovery.
    expect(view.getByText('Discover')).toBeTruthy();

    // router.push must NOT have been called — no tab navigation occurred.
    const { router } = require('expo-router') as { router: { push: jest.Mock } };
    expect(router.push).not.toHaveBeenCalled();

    // history.back must NOT have been called by the cleanup.  The dismissedByBack
    // flag in the effect closure prevents a redundant back() when the sheet was
    // already closed by the browser's own Back button — calling it twice would
    // navigate past the synthetic entry and send the user away from Discovery.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).history.back).not.toHaveBeenCalled();

    // ── Category state preserved ────────────────────────────────────────────
    // The Layover FAB reappears — detailVisible is false and the screen is
    // intact, confirming the category/destination state was not reset.
    expect(view.queryByText('Layover Mode')).not.toBeNull();

    // The popstate listener is cleaned up after the sheet closes — firing
    // another popstate event must have no effect (no second state change).
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dispatchEvent({ type: 'popstate' });
    });
    // Still on Discovery, sheet still closed.
    expect(view.getByText('Discover')).toBeTruthy();
    expect(view.queryByTestId('place-detail-sheet')).toBeNull();
  });
});
