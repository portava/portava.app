/**
 * DiscoveryHub — Back-nav closes the Layover Mode sheet (web guard)
 *
 * Task 3661 confirmed that the back-nav guard for LayoverModeSheet uses the
 * same capture-phase + dismissedByBack pattern as the PlaceDetailSheet guard
 * (fixed in Task 3657).  This test covers the popstate path for layoverOpen.
 *
 * Confirmed behaviours:
 *   1. The sheet becomes visible after the Layover FAB is pressed.
 *   2. Firing a `popstate` event closes the sheet.
 *   3. The Discovery screen is still rendered (router.push was not called).
 *   4. After a popstate close, history.back is NOT called a second time.
 *   5. A subsequent popstate (after the sheet is already closed) has no effect.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';

// ── react-native Proxy mock ───────────────────────────────────────────────────
// Stubs Modal (animation lifecycle causes act-scope corruption) and
// ActivityIndicator (Proxy getter can hit uninitialised native-module stubs).
// Also overrides Platform to return OS:'web' so the history-based back-nav
// guard in discovery.tsx activates — without this override the guard's first
// line (`if (Platform.OS !== 'web') return;`) exits immediately.
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

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/featured', () => ({
  getFeaturedHub: jest.fn().mockResolvedValue({ ok: false }),
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

// ── Prop-capture stub ─────────────────────────────────────────────────────────
// Capture visible from LayoverModeSheet so the test can assert it changes.
// Renders a sentinel testID when visible so the test can confirm the sheet opened.
let capturedLayoverVisible: boolean | undefined = undefined;

jest.mock('../../../src/components/layover/LayoverModeSheet', () => {
  const R = require('react');
  const actual = jest.requireActual('react-native');
  return {
    LayoverModeSheet: (props: { visible?: boolean; onClose?: () => void }) => {
      capturedLayoverVisible = props.visible;
      return props.visible
        ? R.createElement(actual.View, { testID: 'layover-mode-sheet' })
        : null;
    },
  };
});

// ── Remaining heavy sub-components ───────────────────────────────────────────
const Null = () => null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({
  DiscoveryCategoryTab: (props: { listHeaderComponent?: React.ReactElement | null }) =>
    props.listHeaderComponent ?? null,
  FilterStrip: () => null,
  SORT_LABELS: {},
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',       () => ({ PlaceDetailSheet:         Null }));
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
  capturedLayoverVisible = undefined;
  windowListeners.clear();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;

  w.addEventListener = (_type: string, cb: SimpleListener) => {
    if (!windowListeners.has(_type)) windowListeners.set(_type, new Set());
    windowListeners.get(_type)!.add(cb);
  };
  w.removeEventListener = (_type: string, cb: SimpleListener) => {
    windowListeners.get(_type)?.delete(cb);
  };
  w.dispatchEvent = (event: { type: string }) => {
    windowListeners.get(event.type)?.forEach((cb) => cb());
    return true;
  };
  // Minimal history stub — pushState and back are recorded but do not mutate
  // history.state (so the cleanup branch `if (!dismissedByBack && state?._layoverSheet)`
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — back-nav closes Layover Mode sheet (web guard)', () => {
  it('popstate closes the layover sheet and does not call history.back() a second time', async () => {
    const view = await render(<DiscoveryHub />);
    await act(async () => {});

    // ── Precondition: Discovery screen rendered, layover sheet closed ──────────
    expect(view.getByText('Discover')).toBeTruthy();
    expect(capturedLayoverVisible).toBe(false);
    expect(view.queryByTestId('layover-mode-sheet')).toBeNull();

    // Layover FAB must be visible (it is hidden only when detailVisible=true).
    expect(view.getByText('Layover Mode')).toBeTruthy();

    // ── Open the Layover Mode sheet via the FAB ────────────────────────────────
    // One fireEvent.press is within the per-file RNTL + React 19 press budget.
    await act(async () => {
      fireEvent.press(view.getByText('Layover Mode'));
    });

    // Sheet sentinel must be present — LayoverModeSheet received visible=true.
    expect(view.queryByTestId('layover-mode-sheet')).not.toBeNull();
    expect(capturedLayoverVisible).toBe(true);

    // The guard must have pushed a synthetic history entry when the sheet opened.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).history.pushState).toHaveBeenCalledWith(
      { _layoverSheet: true },
      '',
      'http://localhost/',
    );

    // A popstate listener must be attached.
    expect(windowListeners.get('popstate')?.size).toBeGreaterThan(0);

    // ── Fire a browser Back (popstate) event ──────────────────────────────────
    // The useEffect in discovery.tsx attached a popstate listener when
    // layoverOpen became true.  Dispatching via our minimal window emitter
    // exercises the exact same handler the browser's Back button would invoke.
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dispatchEvent({ type: 'popstate' });
    });

    // ── Assert: sheet closed, Discovery still shown ───────────────────────────
    expect(view.queryByTestId('layover-mode-sheet')).toBeNull();
    expect(capturedLayoverVisible).toBe(false);

    // Discovery screen must still be rendered — the user was NOT navigated away.
    expect(view.getByText('Discover')).toBeTruthy();

    // router.push must NOT have been called — no tab navigation occurred.
    const { router } = require('expo-router') as { router: { push: jest.Mock } };
    expect(router.push).not.toHaveBeenCalled();

    // history.back must NOT have been called by the cleanup.  The dismissedByBack
    // flag in the effect closure prevents a redundant back() when the sheet was
    // already closed by the browser's own Back button.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).history.back).not.toHaveBeenCalled();

    // ── Subsequent popstate has no effect (listener was cleaned up) ───────────
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dispatchEvent({ type: 'popstate' });
    });
    expect(view.getByText('Discover')).toBeTruthy();
    expect(view.queryByTestId('layover-mode-sheet')).toBeNull();
  });
});
