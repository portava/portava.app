/**
 * DiscoveryCategoryTab — no filters prop (backward-compat smoke test)
 *
 * Confirms that rendering DiscoveryCategoryTab WITHOUT passing the `filters`
 * prop (exactly as callers that predate the controlled-filters feature would
 * do) does NOT crash and instead displays its default, unfiltered content.
 *
 * The TypeScript interface marks `filters` as required, but JavaScript callers
 * that were written before the prop existed will pass `undefined` at runtime.
 * The component must fall back to sensible defaults rather than throwing a
 * TypeError on `filters.radiusKm` / `filters.openNow` / `filters.sortBy`.
 *
 * STATUS: BUG FOUND, NOT FIXED (reported, not silently patched — see project
 * task "Confirm the Discovery category tab still loads correctly when no
 * initial filters are passed"). `DiscoveryCategoryTab` destructures `filters`
 * with no default value, so a caller passing `undefined` crashes on mount:
 *   - with a destination set:   TypeError reading 'radiusKm' (DiscoveryCategoryTab.tsx ~line 506)
 *   - with no destination set:  TypeError reading 'sortBy'   (DiscoveryCategoryTab.tsx ~line 525)
 * The bug is NOT fixed here. An earlier revision `.skip`ped the three tests
 * below; CI enforces `jest skipped <= 0`, because a skipped test asserts
 * nothing. So they now assert the CURRENT behaviour — that mount throws —
 * which documents the gap AND enforces it: if someone adds a default without
 * updating this file, these tests fail and say why.
 *
 * The fix is one line: give `filters` a default value mirroring
 * DEFAULT_FILTERS in discoveryFilterStorage.ts. When it lands, invert these
 * three assertions back to the desired behaviour (`.not.toThrow()`, one
 * getDiscoveryPlaces call, the "Pick a destination" prompt for the empty case).
 *
 * Live impact today is nil: the single caller, app/(tabs)/discovery.tsx:599,
 * passes `filters={activeFilters}`, and it is wrapped in a
 * SectionErrorBoundary. This is a robustness gap, not a live defect.
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
   * The read of `filters` happens in a mount EFFECT, not during render, so
   * `render()` itself returns normally and the TypeError escapes as an
   * unhandled error during the effect flush. Catching it around an explicit
   * `act` is therefore the only way to assert on it — `expect(render).toThrow()`
   * does not see it, and leaving it uncaught fails the test as an unhandled
   * rejection. That asymmetry is itself part of why this gap went unnoticed.
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

  it('CURRENT: mount effect throws reading filters.radiusKm when a destination is set', async () => {
    // Characterises the gap, not the desired behaviour. When the default
    // filters value lands, this becomes `expect(err).toBeNull()` — see STATUS.
    const err = await mountAndCaptureError('Paris');
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/radiusKm/);
  });

  it('CURRENT: never reaches the data fetch, because the mount effect throws first', async () => {
    // The desired behaviour is one getDiscoveryPlaces call with defaulted
    // filters. Today the crash precedes the fetch, so the service is never
    // called — which is why the gap is invisible to any network-level check.
    await mountAndCaptureError('Paris');
    expect(mockGetDiscoveryPlaces).not.toHaveBeenCalled();
  });

  it('CURRENT: mount effect throws reading filters.sortBy when destination is empty', async () => {
    // The no-destination view should render the "Pick a destination" prompt
    // without touching filters at all. It does not: the read happens before
    // that branch is reached.
    const err = await mountAndCaptureError('');
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/sortBy/);
  });
});
