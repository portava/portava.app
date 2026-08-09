/**
 * PlaceCard — "Powered by Foursquare" photo credit tests
 *
 * Covers:
 *   1. "Powered by Foursquare" is visible when the resolved image URL is from
 *      the Foursquare CDN (fastly.4sqi.net) — required by FSQ API terms.
 *   2. "Powered by Foursquare" is absent when useFsqPhoto returns null
 *      (no photo found — credit must not appear as a stray label).
 *   3. "Powered by Foursquare" is absent when the displayed URL is from
 *      Google (the non-FSQ fallback in useFsqPhoto) — credit is FSQ-specific.
 *
 * Run with:  pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { PlaceCard } from '../PlaceCard.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: useFsqPhoto is the subject of this test — controlled per-test via
// mockReturnValue so we can simulate FSQ-resolved, null, and Google-resolved
// scenarios without real network calls.
const mockUseFsqPhoto = jest.fn<string | null, [string, number | null | undefined, number | null | undefined, string | undefined]>();
jest.mock('../../../hooks/useFsqPhoto', () => ({
  useFsqPhoto: (...args: [string, number | null | undefined, number | null | undefined, string | undefined]) =>
    mockUseFsqPhoto(...args),
}));

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatusCached: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules
// not safe under jest-expo.
jest.mock('../../../services/collections', () => ({
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
  saveItem:   jest.fn().mockResolvedValue(true),
  unsaveItem: jest.fn().mockResolvedValue(true),
}));

// NOTE: intentionally exhaustive — discoveryBookmarks imports AsyncStorage and
// Supabase; only the Set return is needed.
jest.mock('../../../services/discoveryBookmarks', () => ({
  getSavedListIds: jest.fn().mockResolvedValue(new Set()),
}));

// NOTE: intentionally exhaustive — PlanPickerController renders a full portal
// tree with Reanimated internals; only isAdded is needed here.
jest.mock('../../PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: TripWishlistPicker has its own Modal chain; null prevents act() leaks.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: expo-image pulls in native modules that crash under jest-expo.
// DisplayMediaImage renders its fallback only when uri is falsy — matching
// real component behaviour so the photo-vs-fallback assertion is stable.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, testID }: any) => {
    const { View } = require('react-native');
    if (!uri && fallback) return <View testID={testID ?? 'display-media-image'}>{fallback}</View>;
    return <View testID={testID ?? 'display-media-image'} />;
  },
  MediaFallback: ({ label, icon }: any) => {
    const { Text, View } = require('react-native');
    return (
      <View testID="media-fallback">
        {icon ?? null}
        {label ? <Text testID="media-fallback-label">{label}</Text> : null}
      </View>
    );
  },
}));

// NOTE: AiRepresentationLabel is not the subject of this test; a null stub
// prevents cascading dependency issues without affecting credit rendering.
jest.mock('../../visuals/AiRepresentationLabel.tsx', () => ({
  AiRepresentationLabel: () => null,
}));

// NOTE: intentionally exhaustive — ImageSourceBadge imports an accuracy-pipeline
// service chain with Supabase internals not safe under jest-expo; the badge
// never renders in these tests because fixture places have no imageSourceType.
jest.mock('../../visuals/ImageSourceBadge.tsx', () => ({
  ImageSourceBadge: () => null,
}));

// NOTE: fallbackUriFor calls require() on bundled assets unavailable under
// jest; returning null means no category_fallback candidate is injected, so
// resolveHeaderImage only works with the provider URL the hook returned.
jest.mock('../../../lib/visuals/fallbackAssets', () => ({
  fallbackUriFor: jest.fn().mockReturnValue(null),
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs suffice.

// ── Constants ─────────────────────────────────────────────────────────────────

const FSQ_PHOTO_URL   = 'https://fastly.4sqi.net/img/general/original/venue-photo.jpg';
const GOOGLE_PHOTO_URL = 'https://lh3.googleusercontent.com/places/google-test-photo.jpg';

// ── Fixture ───────────────────────────────────────────────────────────────────

/** Place with no pre-existing header image so the hook's return value is the
 *  only candidate for resolveHeaderImage. */
const BASE_PLACE: DiscoveryPlace = {
  id:                'place-fsq-credit-1',
  name:              'Shinjuku Izakaya',
  category:          'restaurant',
  type:              'izakaya',
  description:       null,
  distanceKm:        null,
  lat:               35.6938,
  lng:               139.7036,
  tags:              [],
  address:           '1-2-3 Kabukicho, Shinjuku',
  website:           null,
  phone:             null,
  openingHours:      null,
  rating:            null,
  isOpenNow:         null,
  headerImageUrl:    null,
  headerImageSource: null,
};

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountCard(overrides: Partial<DiscoveryPlace> = {}) {
  return render(
    <PlaceCard
      place={{ ...BASE_PLACE, ...overrides }}
      onPress={jest.fn()}
      onAddToPlan={jest.fn()}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceCard — "Powered by Foursquare" photo credit', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows "Powered by Foursquare" when the displayed photo is from the FSQ CDN', async () => {
    // useFsqPhoto resolved a real Foursquare CDN URL.
    mockUseFsqPhoto.mockReturnValue(FSQ_PHOTO_URL);

    const { getByTestId, getByText } = await mountCard();

    await waitFor(() => {
      expect(getByTestId('fsq-photo-credit')).toBeTruthy();
    });
    expect(getByText('Powered by Foursquare')).toBeTruthy();
  });

  it('does NOT show "Powered by Foursquare" when useFsqPhoto returns null (no photo)', async () => {
    // Neither FSQ nor the Google fallback found a photo.
    mockUseFsqPhoto.mockReturnValue(null);

    const { queryByTestId, queryByText } = await mountCard();

    // Allow async effects to settle before asserting absence.
    await waitFor(() => expect(queryByTestId('fsq-photo-credit')).toBeNull());
    expect(queryByText('Powered by Foursquare')).toBeNull();
  });

  it('does NOT show "Powered by Foursquare" when the displayed photo is from Google', async () => {
    // FSQ was empty; Google Places fallback resolved a real photo.
    mockUseFsqPhoto.mockReturnValue(GOOGLE_PHOTO_URL);

    const { queryByTestId, queryByText } = await mountCard();

    await waitFor(() => expect(queryByTestId('fsq-photo-credit')).toBeNull());
    expect(queryByText('Powered by Foursquare')).toBeNull();
  });

  it('shows "Powered by Foursquare" even when place already has a pre-existing FSQ photo URL', async () => {
    // The server already provided an FSQ CDN URL as headerImageUrl;
    // useFsqPhoto returns it as a passthrough — credit must still appear.
    mockUseFsqPhoto.mockReturnValue(FSQ_PHOTO_URL);

    const { getByTestId } = await mountCard({
      headerImageUrl:    FSQ_PHOTO_URL,
      headerImageSource: 'provider',
    });

    await waitFor(() => {
      expect(getByTestId('fsq-photo-credit')).toBeTruthy();
    });
  });

  it('does NOT show "Powered by Foursquare" when a non-FSQ header image is already set', async () => {
    // Provider image from a different CDN; useFsqPhoto returns it as a
    // passthrough — no new FSQ photo is fetched.
    const CDN_URL = 'https://images.unsplash.com/photo-xyz.jpg';
    mockUseFsqPhoto.mockReturnValue(CDN_URL);

    const { queryByTestId, queryByText } = await mountCard({
      headerImageUrl:    CDN_URL,
      headerImageSource: 'provider',
    });

    await waitFor(() => expect(queryByTestId('fsq-photo-credit')).toBeNull());
    expect(queryByText('Powered by Foursquare')).toBeNull();
  });
});
