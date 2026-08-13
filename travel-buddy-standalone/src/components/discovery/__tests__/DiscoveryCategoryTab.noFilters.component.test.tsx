/**
 * DiscoveryCategoryTab — no filters prop (backward-compat smoke test)
 *
 * Confirms that rendering DiscoveryCategoryTab WITHOUT passing the `filters`
 * prop (exactly as callers that predate the controlled-filters feature would
 * do) does NOT crash and instead displays its default, unfiltered content.
 *
 * The TypeScript interface marks `filters` as optional now, and
 * `DiscoveryCategoryTab` defaults it to `DEFAULT_FILTERS` (radiusKm: 10,
 * openNow: false, minRating: null) when the prop is omitted, so a caller
 * passing `undefined` mounts cleanly instead of throwing on
 * `filters.radiusKm` / `filters.sortBy`.
 *
 * STATUS: FIXED (see project task "Confirm the Discovery category tab still
 * loads correctly when no initial filters are passed"). These tests were
 * originally written to characterise the crash (`.not.toThrow()` inverted to
 * assert the throw, per the project's no-skipped-tests policy); they now
 * assert the fixed, desired behaviour directly.
 *
 * Live impact was nil even before the fix: the single caller,
 * app/(tabs)/discovery.tsx:616, always passes `filters={activeFilters}`, and
 * is wrapped in a SectionErrorBoundary. This closes a robustness gap, not a
 * live defect.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';

// ── Services ──────────────────────────────────────────────────────────────────

const mockGetDiscoveryPlaces       = jest.fn();
const mockGetCachedDiscoveryPlaces = jest.fn();

// NOTE: intentionally exhaustive — the real module imports Supabase; spreading
// requireActual would load the client and OOM the Jest runner.
jest.mock('../../../services/discovery', () => ({
  getDiscoveryPlaces:       (...args: unknown[]) => mockGetDiscoveryPlaces(...args),
  getCachedDiscoveryPlaces: (...args: unknown[]) => mockGetCachedDiscoveryPlaces(...args),
}));

// ── Hooks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real hook fetches from a remote API.
jest.mock('../../../hooks/usePopularCities', () => ({
  usePopularCities: () => ({ places: [], loading: false }),
}));

// ── Component stubs ───────────────────────────────────────────────────────────

const Null = () => null;

// NOTE: intentional stub — not under test; real PlaceCard pulls react-native-maps.
jest.mock('../PlaceCard', () => ({ __esModule: true, default: Null }));
// NOTE: intentional stub — not under test; pulls reanimated animations.
jest.mock('../PlaceSkeleton', () => ({ PlaceSkeletonList: Null }));
// NOTE: intentional stub — not under test; pulls native modules + navigation.
jest.mock('../../selectors/GlobalPlacePicker', () => ({
  POPULAR: [],
  GlobalPlacePicker: Null,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { DiscoveryCategoryTab } from '../DiscoveryCategoryTab.tsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_PLACE = {
  id: 'p1',
  name: 'Eiffel Tower',
  category: 'places',
  type: null,
  description: null,
  distanceKm: null,
  lat: null,
  lng: null,
  address: null,
  openingHours: null,
  rating: null,
  photoUrl: null,
  visitCount: null,
  savedCount: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiscoveryCategoryTab — no filters prop (pre-filters-feature caller)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedDiscoveryPlaces.mockReturnValue(null);
    mockGetDiscoveryPlaces.mockResolvedValue({
      ok: true,
      data: { places: [MOCK_PLACE], total: 1 },
    });
  });

  afterEach(async () => {
    // Drain any async work (e.g. load() resolving) so it doesn't bleed into
    // the next test.
    await act(async () => {});
  });

  // Cast to `any` to suppress the TypeScript required-prop error — this
  // simulates a pre-filters-feature caller that doesn't know about the prop.
  const noFiltersProps = (destination: string) =>
    ({
      category: 'places' as const,
      destination,
      onSelectPlace: jest.fn(),
      onAddToPlan: jest.fn(),
    }) as any;

  /**
   * The read of `filters` happens in a mount EFFECT, not during render, so a
   * pre-fix `render()` itself returns normally and the TypeError escapes as
   * an unhandled error during the effect flush. Catching it around an
   * explicit `act` is therefore the only way to assert on it — this helper is
   * red-proof: run against the pre-fix component (no default value on the
   * `filters` destructure), it still catches and returns the TypeError.
   */
  const mountAndCaptureError = async (destination: string): Promise<Error | null> => {
    try {
      await act(async () => {
        render(<DiscoveryCategoryTab {...noFiltersProps(destination)} />);
      });
      return null;
    } catch (e) {
      return e as Error;
    }
  };

  it('mounts without throwing when filters.radiusKm would be read, with a destination set', async () => {
    const err = await mountAndCaptureError('Paris');
    expect(err).toBeNull();
  });

  it('reaches the data fetch with defaulted filters, because mount no longer throws first', async () => {
    await mountAndCaptureError('Paris');
    expect(mockGetDiscoveryPlaces).toHaveBeenCalledTimes(1);
    // Defaulted filters (DEFAULT_FILTERS): unfiltered radius/rating/openNow.
    // Call shape: getDiscoveryPlaces(destination, category, filters, ...).
    const [, , filtersArg] = mockGetDiscoveryPlaces.mock.calls[0];
    expect(filtersArg).toEqual({ radiusKm: 10, openNow: false, minRating: null });
  });

  it('mounts without throwing when filters.sortBy would be read, with no destination set', async () => {
    const err = await mountAndCaptureError('');
    expect(err).toBeNull();
  });
});
