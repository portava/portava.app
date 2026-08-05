/**
 * Gem detail — hook-order stability across the loading transition.
 *
 * ## Why this test exists
 *
 * The Sentry-reporting useEffect once sat between two early returns:
 * `if (loading)` and `if (error || !gem)`. useGemDetail starts
 * loading=true, so the first render ran 16 hooks and bailed at the
 * loading return; when the fetch resolved the next render reached a
 * 17th hook and React threw "Rendered more hooks than during the
 * previous render". That crashed every hidden-gem detail view.
 *
 * The three sibling gem tests could not catch it: each mocks
 * useGemDetail with a CONSTANT `loading: false`, so the component
 * mounts straight into its final hook shape and the transition never
 * happens.
 *
 * This test therefore deliberately does NOT mock useGemDetail. It mocks
 * the underlying getGem service with a deferred promise and lets the
 * real hook drive loading: true -> false inside a single mount, which
 * is the only shape that exercises the bug.
 */
import React from 'react';
import { render, waitFor, screen } from '@testing-library/react-native';
import GemDetailScreen from '../../../app/gems/[id].tsx';
import { getGem } from '../../services/hiddenGems.ts';

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
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../RouteBuilderSheet', () => ({ RouteBuilderSheet: () => null }));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../discovery/TripWishlistPicker', () => ({ TripWishlistPicker: () => null }));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../ReviewsSection', () => ({ ReviewsSection: () => null }));
// NOTE: intentionally an exhaustive stub — requiring the actual component module
// would execute its heavy/native dependency imports under jest.
jest.mock('../discovery/GemMapPreview', () => ({ GemMapPreview: () => null }));
// useGemDetail is deliberately NOT mocked — the real hook provides the
// loading transition this test exists to exercise.
jest.mock('../../hooks/useHiddenGems', () => ({
  ...jest.requireActual('../../hooks/useHiddenGems'),
  useGemCheckin: () => ({ checkin: jest.fn(), loading: false, result: null }),
  useGemReport: () => ({ report: jest.fn(), loading: false, done: false }),
}));
jest.mock('../../services/hiddenGems', () => ({
  ...jest.requireActual('../../services/hiddenGems'),
  verificationBadge: () => 'Community verified',
  sensitivityLabel: () => 'Public',
  getGem: jest.fn(),
}));

const mockGetGem = getGem as jest.Mock;

const gem = {
  id: 'gem-1', name: 'Secret Cove', category: 'nature',
  neighborhood: null, city: 'Split', country: 'Croatia',
  coordsPrecision: 'exact', lat: 1, lng: 2,
  sensitivityLevel: 'public', verificationLevel: 'community',
  vibeTags: [], saveCount: 3,
  description: null, priceRange: null, bestTimeToGo: null,
  layoverSafe: false, minimumLayoverMinutes: null,
  safetyNotes: null, localEtiquette: null,
};

// Validation runs multiple full jest suites concurrently; the default 5s
// per-test budget flakes under that load. Local runs finish in <1s — this
// only widens headroom, it does not mask regressions.
jest.setTimeout(20000);

describe('Gem detail — hook order across the loading transition', () => {
  it('renders through loading=true -> false in one mount without a hook-order error', async () => {
    const hookOrderErrors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
      if (/Rendered (more|fewer) hooks/.test(text)) hookOrderErrors.push(text);
    });

    // Resolve on a later macrotask so the component genuinely commits a
    // loading=true render first, then transitions.
    mockGetGem.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ gem, savedByMe: false, guideProfile: null }), 0),
        ),
    );

    try {
      render(<GemDetailScreen />);

      // The loaded screen renders the gem name; reaching it proves the
      // component survived the transition.
      let renderError: unknown = null;
      try {
        await waitFor(() => expect(screen.getByText('Secret Cove')).toBeTruthy());
      } catch (e) {
        renderError = e;
      }

      // Assert the specific regression first so a reintroduced hook-order
      // violation reports itself by name rather than as a missing element.
      expect(hookOrderErrors).toEqual([]);
      if (renderError) throw renderError;
    } finally {
      spy.mockRestore();
    }
  });
});
