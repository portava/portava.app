/**
 * Gem detail screen — duplicate/missing canonical place graceful fallback.
 *
 * When a gem carries a canonicalPlaceId that resolves to null (e.g. the
 * referenced place was merged or marked duplicate after the gem was submitted),
 * the detail screen must:
 *   1. Not crash or blank out.
 *   2. Show the About section using gem description/category only (no enriched
 *      phone, hours, or address rows from the now-dead place).
 *   3. Omit the About section entirely when the gem also has no description or
 *      category — rather than rendering a broken empty card.
 *   4. Never call getCanonicalPlace when canonicalPlaceId is absent.
 *
 * ## Act strategy
 *
 * All fireEvent calls are bare (no act() wrapper).  The canonical-place effect
 * resolves via a deferred Promise (setTimeout 0) so its continuation runs
 * outside the initial render's act() scope — matching the pattern in
 * GemDetailShare.reasonModal.component.test.tsx to avoid "overlapping act()"
 * warnings under React 19 + jest-expo.
 */
import React from 'react';
import { render, waitFor, screen } from '@testing-library/react-native';
import GemDetailScreen from '../../../app/gems/[id].tsx';
import { getCanonicalPlace } from '../../services/places.ts';

// ── Global mock overrides ─────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'gem-1' }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: ({ children }: any) => <View>{children}</View>,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-location', () => ({}));
jest.mock('../../hooks/useNavBarCollapse', () => ({
  ...jest.requireActual('../../hooks/useNavBarCollapse'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));
jest.mock('../../context/SessionContext', () => ({
  ...jest.requireActual('../../context/SessionContext'),
  useSession: () => ({ isAuthed: true, loading: false }),
}));
// NOTE: intentionally exhaustive stubs — requiring the actual modules would
// execute heavy/native dependency imports under jest.
jest.mock('../RouteBuilderSheet', () => ({ RouteBuilderSheet: () => null }));
jest.mock('../discovery/TripWishlistPicker', () => ({ TripWishlistPicker: () => null }));
jest.mock('../ReviewsSection', () => ({ ReviewsSection: () => null }));
// NOTE: intentionally exhaustive stub — requiring the actual module would
// execute MapLibre native-module imports that crash under jest.
jest.mock('../discovery/GemMapPreview', () => ({ GemMapPreview: () => null }));
jest.mock('../../hooks/useHiddenGems', () => ({
  ...jest.requireActual('../../hooks/useHiddenGems'),
  useGemDetail: jest.fn(),
  useGemCheckin: () => ({ checkin: jest.fn(), loading: false, result: null }),
  useGemReport: () => ({ report: jest.fn(), loading: false, done: false }),
}));
jest.mock('../../services/hiddenGems', () => ({
  ...jest.requireActual('../../services/hiddenGems'),
  verificationBadge: () => 'Community verified',
  sensitivityLabel: () => 'Public',
  shareGemToTelegraph: jest.fn(),
}));
jest.mock('../../services/places', () => ({
  ...jest.requireActual('../../services/places'),
  getCanonicalPlace: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const { useGemDetail } = require('../../hooks/useHiddenGems.ts');
const mockGetCanonicalPlace = getCanonicalPlace as jest.Mock;

/** Defer resolution to the next macrotask so continuations fire outside act(). */
const deferred = <T,>(value: T): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), 0));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseGem = {
  id: 'gem-1',
  name: 'Hidden Cove',
  category: 'nature' as const,
  neighborhood: null,
  city: 'Split',
  country: 'Croatia',
  coordsPrecision: 'exact',
  lat: 43.5,
  lng: 16.4,
  sensitivityLevel: 'public',
  verificationLevel: 'community',
  vibeTags: [],
  saveCount: 5,
  description: null,
  priceRange: null,
  bestTimeToGo: null,
  layoverSafe: false,
  minimumLayoverMinutes: null,
  safetyNotes: null,
  localEtiquette: null,
};

// Validation runs multiple full jest suites concurrently; the default 5s
// per-test budget flakes under that load.
jest.setTimeout(20000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Gem detail — duplicate/missing canonical place', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders without crashing and shows the About section from gem fields when the linked place resolves null', async () => {
    const gem = {
      ...baseGem,
      canonicalPlaceId: 'place-dead-001',
      description: 'A peaceful hidden cove away from the crowds.',
    };
    (useGemDetail as jest.Mock).mockReturnValue({
      gem,
      savedByMe: false,
      guideProfile: null,
      loading: false,
      error: null,
      refresh: jest.fn(),
      toggleSave: jest.fn(),
    });
    // Simulate the place having been merged/marked duplicate — fetch returns null.
    mockGetCanonicalPlace.mockImplementation(() => deferred(null));

    await render(<GemDetailScreen />);

    // Wait for the canonical-place effect to fire and settle.
    await waitFor(() =>
      expect(mockGetCanonicalPlace).toHaveBeenCalledWith('place-dead-001'),
    );

    // Screen must not crash — gem name is visible.
    expect(screen.getByText('Hidden Cove')).toBeTruthy();

    // About section renders using the gem's own description.
    expect(screen.getByText('A peaceful hidden cove away from the crowds.')).toBeTruthy();

    // No enriched contact fields should appear — the place fetch returned null.
    expect(screen.queryByText(/Provisional — verify on arrival/i)).toBeNull();
  });

  it('omits the About section entirely when the place resolves null and the gem has no description or category', async () => {
    // Override to strip both description and category so no fallback content exists.
    const gem = {
      ...baseGem,
      category: null as any,
      description: null,
      canonicalPlaceId: 'place-dead-002',
    };
    (useGemDetail as jest.Mock).mockReturnValue({
      gem,
      savedByMe: false,
      guideProfile: null,
      loading: false,
      error: null,
      refresh: jest.fn(),
      toggleSave: jest.fn(),
    });
    mockGetCanonicalPlace.mockImplementation(() => deferred(null));

    await render(<GemDetailScreen />);

    await waitFor(() =>
      expect(mockGetCanonicalPlace).toHaveBeenCalledWith('place-dead-002'),
    );

    // Screen must not crash — gem name is still visible.
    expect(screen.getByText('Hidden Cove')).toBeTruthy();

    // About section header must be absent — nothing to render in it.
    expect(screen.queryByText('About')).toBeNull();
  });

  it('does not call getCanonicalPlace when the gem has no canonicalPlaceId', async () => {
    const gem = {
      ...baseGem,
      canonicalPlaceId: undefined,
      description: 'A peaceful hidden cove.',
    };
    (useGemDetail as jest.Mock).mockReturnValue({
      gem,
      savedByMe: false,
      guideProfile: null,
      loading: false,
      error: null,
      refresh: jest.fn(),
      toggleSave: jest.fn(),
    });

    await render(<GemDetailScreen />);
    await waitFor(() => expect(screen.getByText('Hidden Cove')).toBeTruthy());

    // Effect guard (if (!gem?.canonicalPlaceId)) must prevent the fetch.
    expect(mockGetCanonicalPlace).not.toHaveBeenCalled();

    // About section still renders from gem description.
    expect(screen.getByText('A peaceful hidden cove.')).toBeTruthy();
  });
});
