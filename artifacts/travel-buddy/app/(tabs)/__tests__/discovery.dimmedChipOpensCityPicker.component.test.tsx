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
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import DiscoveryHub from '../discovery.tsx';
import { color } from '../../../src/theme/tokens';

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

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/discoveryLocalCache', () => ({
  loadCachedCounts: jest.fn().mockResolvedValue(null),
  saveCachedCounts: jest.fn().mockResolvedValue(undefined),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const CHIP_LABELS = ['Near Me', 'In City', 'Going Soon', 'Around Crew', 'Safe Nearby'];

/** The `locationNudgeHighlighted` backgroundColor value from the stylesheet. */
const NUDGE_HIGHLIGHTED_BG = color.signal + '28';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryHub — dimmed chip tap opens city picker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocationState = { place: { city: null, country: null }, coords: null };
  });

  describe('when no destination is set (location-required)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    it('tapping a dimmed chip calls openCityPicker', async () => {
      const { unmount } = await render(<DiscoveryHub />);
      await act(async () => {});

      const chip = screen.getByText('Near Me');
      fireEvent.press(chip);

      expect(mockOpenCityPicker).toHaveBeenCalledTimes(1);

      await act(async () => { unmount(); });
    });

    it('tapping any dimmed chip calls openCityPicker', async () => {
      const { unmount } = await render(<DiscoveryHub />);
      await act(async () => {});

      for (const label of CHIP_LABELS) {
        mockOpenCityPicker.mockClear();
        fireEvent.press(screen.getByText(label));
        expect(mockOpenCityPicker).toHaveBeenCalledTimes(1);
      }

      await act(async () => { unmount(); });
    });

    it('nudge banner receives highlighted style immediately after tap', async () => {
      const { unmount } = await render(<DiscoveryHub />);
      await act(async () => {});

      const nudgeBanner = screen.getByLabelText('Set your location to discover nearby places');

      // Before tap: no highlighted background.
      expect(nudgeBanner).not.toHaveStyle({ backgroundColor: NUDGE_HIGHLIGHTED_BG });

      fireEvent.press(screen.getByText('In City'));

      // After tap: highlighted background must be applied immediately.
      expect(nudgeBanner).toHaveStyle({ backgroundColor: NUDGE_HIGHLIGHTED_BG });

      await act(async () => { unmount(); });
    });

    it('highlighted style is cleared after the 1800 ms timeout', async () => {
      const { unmount } = await render(<DiscoveryHub />);
      await act(async () => {});

      const nudgeBanner = screen.getByLabelText('Set your location to discover nearby places');

      fireEvent.press(screen.getByText('Going Soon'));

      // Highlight is active immediately.
      expect(nudgeBanner).toHaveStyle({ backgroundColor: NUDGE_HIGHLIGHTED_BG });

      // Advance past the 1800 ms timeout.
      act(() => { jest.advanceTimersByTime(1800); });

      // Highlight must be cleared after the timeout elapses.
      expect(nudgeBanner).not.toHaveStyle({ backgroundColor: NUDGE_HIGHLIGHTED_BG });

      await act(async () => { unmount(); });
    });

    it('highlight has not cleared before the timeout elapses', async () => {
      const { unmount } = await render(<DiscoveryHub />);
      await act(async () => {});

      const nudgeBanner = screen.getByLabelText('Set your location to discover nearby places');

      fireEvent.press(screen.getByText('Around Crew'));

      act(() => { jest.advanceTimersByTime(1799); });

      // Still highlighted just before the deadline.
      expect(nudgeBanner).toHaveStyle({ backgroundColor: NUDGE_HIGHLIGHTED_BG });

      await act(async () => { unmount(); });
    });

    it('a rapid double-tap on a dimmed chip only calls openCityPicker once', async () => {
      const { unmount } = await render(<DiscoveryHub />);
      await act(async () => {});

      const chip = screen.getByText('Near Me');

      // Fire two presses back-to-back without any await between them.
      fireEvent.press(chip);
      fireEvent.press(chip);

      // The picker must have been opened exactly once — the second tap is a no-op
      // because the guard (`cityPickerPendingRef`) is already set.
      expect(mockOpenCityPicker).toHaveBeenCalledTimes(1);

      await act(async () => { unmount(); });
    });

    it('a rapid double-tap on different dimmed chips still only calls openCityPicker once', async () => {
      const { unmount } = await render(<DiscoveryHub />);
      await act(async () => {});

      // Tap two different chips in rapid succession.
      fireEvent.press(screen.getByText('In City'));
      fireEvent.press(screen.getByText('Going Soon'));

      expect(mockOpenCityPicker).toHaveBeenCalledTimes(1);

      await act(async () => { unmount(); });
    });
  });

  describe('when a destination IS set', () => {
    beforeEach(() => {
      mockLocationState = {
        place:  { city: 'Tokyo', country: 'Japan' },
        coords: { lat: 35.6895, lng: 139.6917 },
      };
    });

    it('tapping a chip does NOT call openCityPicker', async () => {
      const { unmount } = await render(<DiscoveryHub />);
      await act(async () => {});

      for (const label of CHIP_LABELS) {
        fireEvent.press(screen.getByText(label));
      }

      expect(mockOpenCityPicker).not.toHaveBeenCalled();

      await act(async () => { unmount(); });
    });

    it('nudge banner is not rendered when a destination is set', async () => {
      const { unmount } = await render(<DiscoveryHub />);
      await act(async () => {});

      expect(
        screen.queryByLabelText('Set your location to discover nearby places'),
      ).toBeNull();

      await act(async () => { unmount(); });
    });
  });
});
