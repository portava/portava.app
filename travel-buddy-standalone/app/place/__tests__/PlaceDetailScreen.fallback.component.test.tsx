/**
 * PlaceDetailScreen — living/fallback branching component tests.
 *
 * Covers:
 *  1. When getPlaceLiving returns null (endpoint unavailable), the canonical
 *     place renders in the classic PlaceCard layout — the
 *     "place-detail-report-btn" testID must be visible, confirming the screen
 *     does not produce a blank view.
 *  2. When getPlaceLiving returns a valid payload, LivingDestinationPage
 *     renders instead of the classic layout.
 *
 * Run with:  pnpm test:component
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import PlaceDetailScreen from '../[id].tsx';
import type { CanonicalPlace } from '../../../src/types/canonicalPlace.ts';
import type { PlaceLivingResponse } from '../../../src/types/placeLiving.ts';

// ── Controllable mock state (must be `mock`-prefixed for jest hoisting) ────────

const mockGetCanonicalPlace = jest.fn<Promise<CanonicalPlace | null>, [string]>();
const mockGetPlaceLiving    = jest.fn<Promise<PlaceLivingResponse | null>, [string]>();

// ── Module mocks ───────────────────────────────────────────────────────────────

// Override useLocalSearchParams so the screen receives a canonical UUID id.
// jest.requireActual resolves through the moduleNameMapper to the global
// expo-router mock at src/__mocks__/expo-router.tsx — safe to spread.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: 'place-uuid-1' }),
}));

jest.mock('../../../src/services/places.ts', () => ({
  ...jest.requireActual('../../../src/services/places.ts'),
  getCanonicalPlace: (...args: unknown[]) => mockGetCanonicalPlace(...(args as [string])),
  getPlaceLiving:    (...args: unknown[]) => mockGetPlaceLiving(...(args as [string])),
}));

// NOTE: intentionally exhaustive — the real module pulls Supabase native deps
// that are not safe under jest-expo.
jest.mock('../../../src/context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, isLivePlacesEnabled: () => true }),
}));

jest.mock('../../../src/context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../../src/context/SessionContext.tsx'),
  useSession: () => ({ isAuthed: true, userId: 'user-test-1' }),
}));

// NOTE: intentionally exhaustive — react-native-safe-area-context pulls native
// modules unavailable in jest-expo; stubbing avoids a crash at SafeAreaView.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => {
    const { View } = require('react-native');
    return <View>{children}</View>;
  },
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — PlaceCard, PlaceInfoSection, and
// MapEntityActionRow pull in expo-image and other native-module-backed
// components that are not safe under jest-expo.
jest.mock('../../../src/components/place/PlaceCard.tsx', () => ({
  PlaceCard: () => {
    const { View } = require('react-native');
    return <View testID="place-card-stub" />;
  },
}));

// NOTE: intentionally exhaustive — PlaceInfoSection has the same native dep
// chain as PlaceCard.
jest.mock('../../../src/components/place/PlaceInfoSection.tsx', () => ({
  PlaceInfoSection: () => null,
}));

// NOTE: intentionally exhaustive — PlaceReportSheet pulls in bottom-sheet
// native dependencies unavailable in jest-expo.
jest.mock('../../../src/components/PlaceReportSheet.tsx', () => ({
  PlaceReportSheet: () => null,
}));

// NOTE: intentionally exhaustive — MapEntityActionRow depends on MapLibre and
// gesture-handler native modules unavailable in jest-expo.
jest.mock('../../../src/components/map/MapEntityActionRow.tsx', () => ({
  MapEntityActionRow: () => null,
}));

// NOTE: intentionally exhaustive — TripWishlistPicker pulls in bottom-sheet
// and other native dependencies unavailable in jest-expo.
jest.mock('../../../src/components/discovery/TripWishlistPicker.tsx', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — ReviewsSection pulls in rich text and
// image-picker native dependencies unavailable in jest-expo.
jest.mock('../../../src/components/ReviewsSection.tsx', () => ({
  ReviewsSection: () => null,
}));

// NOTE: intentionally exhaustive — WorthItVoteRow depends on Supabase-backed
// hooks that are not safe under jest-expo.
jest.mock('../../../src/components/WorthItVoteRow.tsx', () => ({
  WorthItVoteRow: () => null,
}));

// NOTE: intentionally exhaustive — LivingDestinationPage is the component
// under test here; it is replaced by a lightweight stub so the branch
// assertion does not drag in its full native-module dep chain.
jest.mock('../../../src/components/place/living/LivingDestinationPage.tsx', () => ({
  LivingDestinationPage: () => {
    const { View } = require('react-native');
    return <View testID="living-destination-page-stub" />;
  },
}));

// NOTE: intentionally exhaustive — useBottomInset/PlainBottomFiller has no
// useful native-free path under jest-expo.
jest.mock('../../../src/hooks/useBottomInset.ts', () => ({
  PlainBottomFiller: () => null,
  useBottomInset:    () => 0,
  useLayoverAwareBottomInset: () => 0,
}));

jest.mock('../../../src/services/collections.ts', () => ({
  ...jest.requireActual('../../../src/services/collections.ts'),
  checkSaved:  jest.fn().mockResolvedValue({ saved: false }),
  toggleSave:  jest.fn().mockResolvedValue(false),
}));

jest.mock('../../../src/services/discovery.ts', () => ({
  ...jest.requireActual('../../../src/services/discovery.ts'),
  getPlaceLiveStatus: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — categoryColor is a pure helper exported
// from the discovery PlaceCard; importing the real module pulls in its full
// native-component tree.
jest.mock('../../../src/components/discovery/PlaceCard.tsx', () => ({
  categoryColor: () => '#888888',
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePlace(overrides: Partial<CanonicalPlace> = {}): CanonicalPlace {
  return {
    id:           'place-uuid-1',
    name:         'Test Waterfall',
    category:     'nature',
    coordinates:  { lat: 14.5, lng: 121.0 },
    address:      '1 Falls Road',
    city:         'Quezon City',
    neighborhood: null,
    countryCode:  'PH',
    status:       'active',
    detailRoute:  '/place/place-uuid-1',
    attribution:  ['© OpenStreetMap contributors'],
    sources:      [],
    fieldFreshness: {},
    ...overrides,
  };
}

function makeLiving(): PlaceLivingResponse {
  return {
    placeId:      'place-uuid-1',
    sparseMode:   true,
    hero:         { imageUrl: null, videoUrl: null },
    rating:       null,
    bestTime:     null,
    crowdLevel:   null,
    weather:      null,
    directionsUrl: null,
    // The real `LivingOfficialInfo` shape. This fixture used to carry
    // `{ name, openingHours, admissionFee, officialTips }` — an older API shape
    // in which NONE of the four fields PlaceOfficialInfoCard actually reads
    // (address, hours, priceLevel, isOpenNow) was present. The card's
    // `hasContent` check was therefore falsy for the wrong reason, and the test
    // passed by accident. All-null keeps `hasContent` falsy honestly.
    officialInfo: {
      hours: null,
      isOpenNow: null,
      address: null,
      phone: null,
      website: null,
      priceLevel: null,
      rating: null,
      reviewCount: null,
      bookingUrl: null,
      attribution: [],
    },
    aiSummary:    null,
    buckets:      [],
    timeline:     { slice: 'week', posts: [], crowdLevel: null, weatherBrief: null },
    bestOf:       null,
    dedupGroups:  [],
    topContributor: null,
    thinBuckets:  [],
    generatedAt:  '2026-07-28T00:00:00.000Z',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetCanonicalPlace.mockReset();
  mockGetPlaceLiving.mockReset();
});

describe('PlaceDetailScreen — living endpoint unavailable (null)', () => {
  it('renders the classic PlaceCard fallback — place-detail-report-btn is visible', async () => {
    mockGetCanonicalPlace.mockResolvedValue(makePlace());
    mockGetPlaceLiving.mockResolvedValue(null);

    const { getByTestId } = await render(<PlaceDetailScreen />);

    await waitFor(() => {
      expect(getByTestId('place-detail-report-btn')).toBeTruthy();
    });
  });

  it('does not render the LivingDestinationPage stub when living is null', async () => {
    mockGetCanonicalPlace.mockResolvedValue(makePlace());
    mockGetPlaceLiving.mockResolvedValue(null);

    const { queryByTestId } = await render(<PlaceDetailScreen />);

    await waitFor(() => {
      expect(queryByTestId('living-destination-page-stub')).toBeNull();
    });
  });
});

describe('PlaceDetailScreen — living endpoint returns valid payload', () => {
  it('renders LivingDestinationPage when getPlaceLiving returns a payload', async () => {
    mockGetCanonicalPlace.mockResolvedValue(makePlace());
    mockGetPlaceLiving.mockResolvedValue(makeLiving());

    const { getByTestId } = await render(<PlaceDetailScreen />);

    await waitFor(() => {
      expect(getByTestId('living-destination-page-stub')).toBeTruthy();
    });
  });

  it('does not render the classic report button when LivingDestinationPage is active', async () => {
    mockGetCanonicalPlace.mockResolvedValue(makePlace());
    mockGetPlaceLiving.mockResolvedValue(makeLiving());

    const { queryByTestId } = await render(<PlaceDetailScreen />);

    await waitFor(() => {
      expect(queryByTestId('place-detail-report-btn')).toBeNull();
    });
  });
});
