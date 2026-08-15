/**
 * DiscoveryHub — Back-nav closes the place detail sheet (web guard)
 *
 * Task 3642: pressing Back from the place detail sheet sent users to /passport
 * instead of staying on Discovery. Fix: push a synthetic history entry when the
 * sheet opens and absorb the resulting `popstate` to close the sheet.
 *
 * Task 3657: the sheet then STAYED OPEN on /discovery instead of dismissing —
 * reproduced twice in the field, Tops Lookout and House of Lechon. Fix
 * (`96f503f04`): register the popstate listener in CAPTURE phase so it runs
 * before any bubble-phase listener, plus a `dismissedByBack` flag so the cleanup
 * does not call `history.back()` a second time.
 *
 * WHY THIS FILE WAS REWRITTEN
 * ===========================
 * The 3642 guard was in place, green, and did not catch 3657. It could not have:
 * its window stub said so in its own header — *"the event-emitter stub ignores
 * the capture/bubble argument (third arg) since there is no second listener
 * competing in tests"* — and its `history` stub never mutated `state`, leaving
 * the cleanup branch `if (w.history.state?._discoverySheet)` permanently falsy.
 *
 * So BOTH mechanisms of the 3657 fix were invisible to it, and both of its
 * headline assertions were vacuous: the sheet closed because the stub fired
 * every listener regardless of phase, and `history.back` was "not called
 * a second time" because it could never have been called once. Reverting the
 * fix left the file green.
 *
 * It is replaced with `webHistoryHarness.ts`, which orders capture before
 * bubble, honours `stopPropagation` / `stopImmediatePropagation`, and keeps a
 * real entry stack so `history.state` and history depth mean something. Each
 * test below is annotated with what removing it would break.
 *
 * WHAT IS AND IS NOT ESTABLISHED
 * ==============================
 * Confirmed by reading `@react-navigation/native`: `createMemoryHistory`
 * (`:206`, `:228`) does register a bubble-phase popstate listener at app-init
 * time, before any component effect. NOT confirmed: that it stops propagation —
 * it calls neither `stopPropagation` nor `stopImmediatePropagation`. The
 * competitor in `capture phase wins the race` is therefore the HAZARD THE
 * CAPTURE FLAG EXISTS TO DEFEAT, modelled deliberately — not a replay of the
 * field failure, which was not reproduced here (no browser in this harness).
 * Do not read a green run as proof the field symptom is gone.
 *
 * RED-PROOF, AND ONE FINDING FROM IT
 * ==================================
 * Each mechanism was removed in turn and the suite re-run:
 *
 *   capture flag dropped        → RED (2 tests)
 *   cleanup's history.back()    → RED (1 test)
 *   `dismissedByBack` removed   → GREEN. Nothing here catches it.
 *
 * That last line is a finding about the fix, not a gap in the tests, and it is
 * recorded rather than papered over. `dismissedByBack` guards the cleanup
 * against calling `history.back()` after the Back button already dismissed the
 * sheet — but by then the browser has popped the synthetic entry, so
 * `history.state` is the baseline entry's and `state?._discoverySheet` is
 * already falsy. The branch it protects is unreachable in every sequence that
 * could be modelled. It is harmless and defensible as belt-and-braces; it is
 * not load-bearing, and no test in this file should be contorted to pretend
 * otherwise. Manufacturing a scenario purely to turn it red would be inventing
 * evidence.
 *
 * Test harness notes:
 *   - Platform.OS is forced to 'web' via the react-native Proxy mock so the
 *     guard's `if (Platform.OS !== 'web') return;` does not short-circuit.
 *   - No `fireEvent.press`: captured prop callbacks are invoked directly inside
 *     act(), the same functions a real press would invoke, to stay inside the
 *     React 19 + RNTL v14 press budget.
 *
 * Run with: pnpm --dir travel-buddy-standalone test:component
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
let capturedSheetOnClose: (() => void) | null = null;

jest.mock('../../../src/components/discovery/PlaceDetailSheet', () => {
  const R = require('react');
  const actual = jest.requireActual('react-native');
  return {
    PlaceDetailSheet: (props: { visible?: boolean; onClose?: () => void }) => {
      capturedSheetVisible = props.visible;
      capturedSheetOnClose = props.onClose ?? null;
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

// ── Window + history harness ────────────────────────────────────
// jest-expo's native environment has a `window` global but no DOM event APIs.
// See webHistoryHarness.ts for what it models and, more importantly, what it
// does not.

import { installWebHistoryHarness, type WebHistoryHarness } from './webHistoryHarness.ts';

let dom: WebHistoryHarness;

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnSelectPlace = null;
  capturedSheetVisible  = undefined;
  capturedSheetOnClose  = null;
  dom = installWebHistoryHarness();
});

afterEach(async () => {
  // Drain any concurrent work scheduled outside act() before RNTL cleanup.
  await act(async () => {});
  dom.restore();
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
  /** Render the hub and open the detail sheet, as tapping a place card does. */
  async function openSheet() {
    const view = await render(<DiscoveryHub />);
    await act(async () => {});
    expect(view.getByText('Discover')).toBeTruthy();
    expect(typeof capturedOnSelectPlace).toBe('function');
    // Layover FAB visible ⇒ sheet not open yet.
    expect(view.queryByText('Layover Mode')).not.toBeNull();

    await act(async () => { capturedOnSelectPlace!(FAKE_PLACE); });

    expect(view.queryByTestId('place-detail-sheet')).not.toBeNull();
    expect(capturedSheetVisible).toBe(true);
    // Hidden while the sheet is open ({!detailVisible && ...}).
    expect(view.queryByText('Layover Mode')).toBeNull();
    return view;
  }

  it('Back closes the sheet and returns to the results, still on Discovery', async () => {
    const view = await openSheet();

    // The guard pushed a synthetic entry at the same URL.
    expect(dom.depth()).toBe(2);
    expect((window as any).history.state).toEqual({ _discoverySheet: true });

    await act(async () => { dom.pressBack(); });

    // Sheet dismissed.
    expect(view.queryByTestId('place-detail-sheet')).toBeNull();
    expect(capturedSheetVisible).toBe(false);
    // Back on the results, not navigated away.
    expect(view.getByText('Discover')).toBeTruthy();
    expect(view.queryByText('Layover Mode')).not.toBeNull();
    const { router } = require('expo-router') as { router: { push: jest.Mock } };
    expect(router.push).not.toHaveBeenCalled();

    // And the guard did not then walk the user further back. Under the old stub
    // this could not fail: `history.state` never changed, so the cleanup branch
    // was unreachable and `back()` could never have been called even once.
    expect(dom.backCalls()).toBe(0);
    expect(dom.index()).toBe(0);

    // Listener released — a later Back is the app's to handle, not ours.
    expect(dom.listeners.get('popstate')?.length ?? 0).toBe(0);
  });

  it('registers the popstate listener in CAPTURE phase', async () => {
    // The mechanism assertion, stated directly rather than inferred from an
    // outcome. RED if the third argument to addEventListener is dropped.
    //
    // It matters beyond ordering: removeEventListener matches on
    // (type, callback, capture), so a listener added with capture and removed
    // without it is never removed at all. Pinning the flag here pins both ends.
    await openSheet();

    const attached = dom.listeners.get('popstate') ?? [];
    expect(attached).toHaveLength(1);
    expect(attached[0]!.capture).toBe(true);
  });

  it('capture phase wins the race against a bubble-phase listener that stops propagation', async () => {
    // THE HAZARD, MODELLED — not a replay of the field failure. See the file
    // header: @react-navigation/native does register its popstate listener in
    // bubble phase at app-init time, before any component effect, but it does
    // NOT stop propagation. This competitor does, which is what makes listener
    // ORDER decide the outcome and therefore what makes this test able to fail.
    //
    // RED without capture: registered second and in bubble phase, the guard's
    // handler would never run, the sheet would stay open, and the URL would
    // still be correct — exactly the shape reported in 3657.
    const competitor = jest.fn((ev: { stopImmediatePropagation(): void }) => {
      ev.stopImmediatePropagation();
    });
    // Registered BEFORE the component mounts, as an app-init subscriber is.
    dom.addCompetitor('popstate', competitor as never, false);

    const view = await openSheet();
    await act(async () => { dom.pressBack(); });

    expect(view.queryByTestId('place-detail-sheet')).toBeNull();
    expect(capturedSheetVisible).toBe(false);
    // Our handler ran FIRST, in capture, before the bubble pass reached the
    // competitor. The competitor still runs — nothing here stops it, and
    // nothing should: the point is only that it can no longer pre-empt us.
    expect(dom.fireOrder).toEqual(['capture', 'bubble']);
    expect(competitor).toHaveBeenCalledTimes(1);
  });

  it('closing through the UI pops the synthetic entry instead of leaving it stranded', async () => {
    // The other half of "returns to results": if the sheet is dismissed by the
    // close button, the synthetic entry is still on the stack and the NEXT Back
    // press would be swallowed doing nothing. RED if the cleanup's history.back()
    // is removed.
    const view = await openSheet();
    expect(dom.depth()).toBe(2);
    expect(dom.index()).toBe(1);

    // Dismiss the way the close button does.
    await act(async () => { capturedSheetOnClose!(); });

    expect(view.queryByTestId('place-detail-sheet')).toBeNull();
    expect(dom.backCalls()).toBe(1);
    expect(dom.index()).toBe(0); // synthetic entry popped, back at the baseline
  });

  it('a second Back after the sheet has closed is not ours to absorb', async () => {
    const view = await openSheet();
    await act(async () => { dom.pressBack(); });
    expect(view.queryByTestId('place-detail-sheet')).toBeNull();

    // Nothing of ours is left listening, so this is a no-op here — the app's
    // router owns it.
    await act(async () => { (window as any).dispatchEvent({ type: 'popstate' }); });

    expect(view.getByText('Discover')).toBeTruthy();
    expect(view.queryByTestId('place-detail-sheet')).toBeNull();
  });
});
