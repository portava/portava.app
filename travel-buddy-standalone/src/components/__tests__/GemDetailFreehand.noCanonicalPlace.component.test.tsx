/**
 * GemDetailScreen — freehand gem (no canonicalPlaceId) rendering test.
 *
 * Confirms the detail screen renders correctly when the gem has no linked
 * canonical place (canonicalPlaceId is absent/null) — no crash from a missing
 * place enrichment call, and the About section falls back to the user-entered
 * description and category.
 *
 * ## What this verifies
 * - canonicalPlaceId absent: getCanonicalPlace is never called
 * - The gem name, category, and description render without crashing
 * - The About section is still shown (description-based fallback)
 *
 * ## Act strategy
 * Bare fireEvent + waitFor — same pattern as GemDetailShare.reasonModal.
 * Avoids overlapping act() scopes under React 19 concurrent renderer.
 */
import React from 'react';
import { render, waitFor, screen } from '@testing-library/react-native';
import GemDetailScreen from '../../../app/gems/[id].tsx';
import { getCanonicalPlace } from '../../services/places.ts';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'freehand-gem-1' }),
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

// NOTE: intentionally exhaustive stubs — importing the actual modules would
// pull heavy/native dependencies into the jest environment.
jest.mock('../RouteBuilderSheet', () => ({ RouteBuilderSheet: () => null }));
jest.mock('../discovery/TripWishlistPicker', () => ({ TripWishlistPicker: () => null }));
jest.mock('../ReviewsSection', () => ({ ReviewsSection: () => null }));
// NOTE: intentionally exhaustive stub — GemMapPreview imports MapLibre native
// modules that are unavailable in jest and would crash the suite on requireActual.
jest.mock('../discovery/GemMapPreview', () => ({ GemMapPreview: () => null }));
// NOTE: intentionally exhaustive stub — WorthItVoteRow imports animation/haptic
// native modules that are unsafe under jest.
jest.mock('../WorthItVoteRow', () => ({ WorthItVoteRow: () => null }));

// NOTE: intentionally exhaustive stub — PlaceInfoSection may pull native
// dependencies (maps, images) that are unsafe under jest.
jest.mock('../place/PlaceInfoSection', () => ({
  PlaceInfoSection: ({ description }: { description?: string | null }) => {
    const { Text } = require('react-native');
    return description ? <Text testID="place-info-description">{description}</Text> : null;
  },
}));

// NOTE: intentionally exhaustive stub — resolveHeaderImage may import sharp or
// other Node-native image processing modules that crash under jest-expo.
jest.mock('../../lib/visuals/resolveHeaderImage', () => ({
  resolveHeaderImage: () => null,
}));

// NOTE: intentionally exhaustive stub — fallbackAssets references bundled
// asset requires that are resolved by Metro, not jest, and throw on requireActual.
jest.mock('../../lib/visuals/fallbackAssets', () => ({
  fallbackUriFor: () => null,
}));

// NOTE: intentionally exhaustive stub — CachedImage imports expo-image which
// has a native module that is unavailable under jest.
jest.mock('../../components/CachedImage', () => ({
  CachedImage: () => null,
}));

jest.mock('../../hooks/useBottomInset', () => ({
  ...jest.requireActual('../../hooks/useBottomInset'),
  PlainBottomFiller: () => null,
}));

// NOTE: intentionally exhaustive stub — ReasonPromptModal imports animation
// libraries that have native modules unavailable under jest.
jest.mock('../ReasonPromptModal', () => ({
  ReasonPromptModal: () => null,
}));

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

// NOTE: intentionally exhaustive stub — the places service may import Supabase
// client initialisation that fails under jest; only getCanonicalPlace is needed.
jest.mock('../../services/places', () => ({
  getCanonicalPlace: jest.fn(),
}));

const { useGemDetail } = require('../../hooks/useHiddenGems.ts');
const mockGetCanonicalPlace = getCanonicalPlace as jest.Mock;

/** A freehand gem — no canonicalPlaceId field at all. */
const freehandGem = {
  id: 'freehand-gem-1',
  name: 'Hidden Waterfall Trail',
  category: 'nature',
  neighborhood: 'Ubud',
  city: 'Bali',
  country: 'Indonesia',
  coordsPrecision: 'exact',
  lat: -8.5069,
  lng: 115.2625,
  sensitivityLevel: 'public',
  verificationLevel: 'community',
  vibeTags: [],
  saveCount: 7,
  description: 'A secluded waterfall only locals know about.',
  priceRange: null,
  bestTimeToGo: null,
  layoverSafe: false,
  minimumLayoverMinutes: null,
  safetyNotes: null,
  localEtiquette: null,
  imageUrl: null,
  // canonicalPlaceId intentionally absent — this is the freehand path
};

// Validation runs multiple full jest suites concurrently; widen per-test budget.
jest.setTimeout(20000);

describe('GemDetailScreen — freehand gem (no canonicalPlaceId)', () => {
  beforeEach(() => {
    mockGetCanonicalPlace.mockClear();
    (useGemDetail as jest.Mock).mockReturnValue({
      gem: freehandGem,
      savedByMe: false,
      guideProfile: null,
      loading: false,
      error: null,
      refresh: jest.fn(),
      toggleSave: jest.fn(),
    });
  });

  it('renders the gem name and category without crashing when canonicalPlaceId is absent', async () => {
    await render(<GemDetailScreen />);
    await waitFor(() =>
      expect(screen.getByText('Hidden Waterfall Trail')).toBeTruthy(),
    );
    expect(screen.getByText('nature')).toBeTruthy();
  });

  it('does not call getCanonicalPlace when canonicalPlaceId is absent', async () => {
    await render(<GemDetailScreen />);
    await waitFor(() =>
      expect(screen.getByText('Hidden Waterfall Trail')).toBeTruthy(),
    );
    expect(mockGetCanonicalPlace).not.toHaveBeenCalled();
  });

  it('renders the About section using the user-entered description as fallback', async () => {
    await render(<GemDetailScreen />);
    await waitFor(() =>
      expect(screen.getByTestId('place-info-description')).toBeTruthy(),
    );
    expect(screen.getByTestId('place-info-description').props.children).toBe(
      'A secluded waterfall only locals know about.',
    );
  });

  it('renders without crashing when canonicalPlaceId is explicitly null', async () => {
    (useGemDetail as jest.Mock).mockReturnValue({
      gem: { ...freehandGem, canonicalPlaceId: null },
      savedByMe: false,
      guideProfile: null,
      loading: false,
      error: null,
      refresh: jest.fn(),
      toggleSave: jest.fn(),
    });

    await render(<GemDetailScreen />);
    await waitFor(() =>
      expect(screen.getByText('Hidden Waterfall Trail')).toBeTruthy(),
    );
    expect(mockGetCanonicalPlace).not.toHaveBeenCalled();
  });
});
