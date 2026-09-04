/**
 * DiscoveryHub — Back-nav closes the Route Builder sheet (web guard)
 *
 * Task 3661 confirmed that the back-nav guard for RouteBuilderSheet uses the
 * same capture-phase + dismissedByBack pattern as the PlaceDetailSheet guard
 * (fixed in Task 3657).  This test covers the popstate path for routeBuilderOpen.
 *
 * The sheet is opened by capturing the `onAddToRoute` prop from the
 * DiscoveryCategoryTab stub and calling it directly inside act() — the same
 * prop-capture pattern as discovery.backNavClosesSheet.component.test.tsx —
 * so no fireEvent.press is needed (avoiding the React 19 + RNTL press budget).
 *
 * Confirmed behaviours:
 *   1. The sheet becomes visible after onAddToRoute is called.
 *   2. Firing a `popstate` event closes the sheet.
 *   3. The Discovery screen is still rendered (router.push was not called).
 *   4. After a popstate close, history.back is NOT called a second time.
 *   5. A subsequent popstate (after the sheet is already closed) has no effect.
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';
import type { RouteStopDraft } from '../../../src/components/RouteBuilderSheet';

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

// ── Prop-capture stubs ────────────────────────────────────────────────────────
// Capture onAddToRoute from DiscoveryCategoryTab so the test can trigger
// routeBuilderOpen=true without fireEvent.press (avoiding the React 19 + RNTL
// press-budget constraint that limits reliable presses to one per file).
let capturedOnAddToRoute: ((draft: RouteStopDraft) => void) | null = null;

// NOTE: also exports FilterStrip and SORT_LABELS, both imported by discovery.tsx
// for the filter panel — omitting them crashes the filters panel.
jest.mock('../../../src/components/discovery/DiscoveryCategoryTab', () => ({
  DiscoveryCategoryTab: (props: {
    onAddToRoute?: (draft: RouteStopDraft) => void;
    listHeaderComponent?: React.ReactElement | null;
  }) => {
    capturedOnAddToRoute = props.onAddToRoute ?? null;
    return props.listHeaderComponent ?? null;
  },
  FilterStrip: () => null,
  SORT_LABELS: {},
}));

// Capture visible from RouteBuilderSheet so the test can assert it changes.
// Renders a sentinel testID when visible so the test can confirm the sheet opened.
let capturedRouteBuilderVisible: boolean | undefined = undefined;

jest.mock('../../../src/components/RouteBuilderSheet', () => {
  const R = require('react');
  const actual = jest.requireActual('react-native');
  return {
    RouteBuilderSheet: (props: { visible?: boolean; onClose?: () => void }) => {
      capturedRouteBuilderVisible = props.visible;
      return props.visible
        ? R.createElement(actual.View, { testID: 'route-builder-sheet' })
        : null;
    },
  };
});

// ── Remaining heavy sub-components ───────────────────────────────────────────
const Null = () => null;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/PlaceDetailSheet',       () => ({ PlaceDetailSheet:         Null }));
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
jest.mock('../../../src/components/discovery/SubmitPlaceSheet',       () => ({ SubmitPlaceSheet:         Null }));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/discovery/SectionErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Fake route stop draft ─────────────────────────────────────────────────────
// The real RouteStopDraft shape. This used to be `{ placeId, placeName, address }`
// — an older shape with ZERO fields in common with the current interface, held
// in place by an `as RouteStopDraft` cast. The test only checks that the sheet
// opens, so nothing noticed; a test that read the draft would have seen
// undefined for every field.
const FAKE_DRAFT: RouteStopDraft = {
  id:    'place-test-1',
  title: 'Test Ramen Shop',
  lat:   35.6762,
  lng:   139.6503,
};

// ── Window event emitter ──────────────────────────────────────────────────────
// jest-expo's native environment has a `window` global but no DOM event APIs.
// The back-nav guard in discovery.tsx calls window.addEventListener /
// removeEventListener / dispatchEvent and window.history.pushState — none of
// which exist in the native runner.  Install a minimal emitter before each
// test so the guard can attach and receive its popstate listener.

type SimpleListener = () => void;
const windowListeners = new Map<string, Set<SimpleListener>>();

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnAddToRoute        = null;
  capturedRouteBuilderVisible = undefined;
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
  // history.state (so the cleanup branch `if (!dismissedByBack && state?._routeBuilderSheet)`
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

describe('DiscoveryHub — back-nav closes Route Builder sheet (web guard)', () => {
  // React 19 + RNTL v14 note: this test avoids fireEvent.press entirely.
  // Instead it calls the captured prop callback directly inside act() — the
  // same function a real "Add to Route" press would invoke — so the
  // routeBuilderOpen state transition is honest and not mocked.
  it('popstate closes the route builder sheet and does not call history.back() a second time', async () => {
    const view = await render(<DiscoveryHub />);
    await act(async () => {});

    // ── Precondition: screen rendered, prop-capture hooks fired ───────────────
    expect(view.getByText('Discover')).toBeTruthy();
    expect(typeof capturedOnAddToRoute).toBe('function');
    expect(capturedRouteBuilderVisible).toBe(false);
    expect(view.queryByTestId('route-builder-sheet')).toBeNull();

    // ── Open the Route Builder sheet via the captured onAddToRoute prop ───────
    // Equivalent to the user pressing "Add to Route" on a place card.
    await act(async () => {
      capturedOnAddToRoute!(FAKE_DRAFT);
    });

    // Sheet sentinel must be present — RouteBuilderSheet received visible=true.
    expect(view.queryByTestId('route-builder-sheet')).not.toBeNull();
    expect(capturedRouteBuilderVisible).toBe(true);

    // The guard must have pushed a synthetic history entry when the sheet opened.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).history.pushState).toHaveBeenCalledWith(
      { _routeBuilderSheet: true },
      '',
      'http://localhost/',
    );

    // A popstate listener must be attached.
    expect(windowListeners.get('popstate')?.size).toBeGreaterThan(0);

    // ── Fire a browser Back (popstate) event ──────────────────────────────────
    // The useEffect in discovery.tsx attached a popstate listener when
    // routeBuilderOpen became true.  Dispatching via our minimal window emitter
    // exercises the exact same handler the browser's Back button would invoke.
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).dispatchEvent({ type: 'popstate' });
    });

    // ── Assert: sheet closed, Discovery still shown ───────────────────────────
    expect(view.queryByTestId('route-builder-sheet')).toBeNull();
    expect(capturedRouteBuilderVisible).toBe(false);

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
    expect(view.queryByTestId('route-builder-sheet')).toBeNull();
  });
});
