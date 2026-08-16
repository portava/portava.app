/**
 * PlaceCard — OSM image fallback rendering test
 *
 * Confirms that when `headerImageUrl` is null and `useFsqPhoto` returns null,
 * PlaceCard uses `osmImageUrl` as the header image source — not silently
 * falling through to the category-icon fallback.
 *
 * Task 3684 added osmImageUrl as the lowest-priority header image candidate.
 * This test ensures the wiring is correct: the URL actually reaches
 * DisplayMediaImage rather than being dropped by the resolver.
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

// NOTE: useFsqPhoto is controlled per-test to simulate the scenario where
// neither Foursquare nor Google Places finds a photo, so osmImageUrl is the
// only real candidate.
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

// NOTE: Capture the `uri` prop passed to DisplayMediaImage so the test can
// assert the OSM URL actually reached the image component. The mock renders
// the fallback only when uri is falsy — matching real component behavior.
let capturedUri: string | null | undefined;
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, testID }: any) => {
    capturedUri = uri;
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

// NOTE: AiRepresentationLabel is not the subject of this test.
jest.mock('../../visuals/AiRepresentationLabel.tsx', () => ({
  AiRepresentationLabel: () => null,
}));

// NOTE: ImageSourceBadge imports an accuracy-pipeline service chain with
// Supabase internals not safe under jest-expo.
jest.mock('../../visuals/ImageSourceBadge.tsx', () => ({
  ImageSourceBadge: () => null,
}));

// NOTE: fallbackUriFor calls require() on bundled assets unavailable under
// jest; returning null means no category_fallback candidate is injected,
// isolating the test to the osmImageUrl path.
jest.mock('../../../lib/visuals/fallbackAssets', () => ({
  fallbackUriFor: jest.fn().mockReturnValue(null),
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const OSM_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/osm-test-image.jpg';

// ── Fixture ───────────────────────────────────────────────────────────────────

/** Place with no headerImageUrl so osmImageUrl is the only real candidate. */
const BASE_PLACE: DiscoveryPlace = {
  id:                'place-osm-1',
  name:              'Baguio City Park',
  category:          'places',
  type:              'park',
  description:       null,
  distanceKm:        null,
  lat:               16.4116,
  lng:               120.5960,
  tags:              [],
  address:           'Harrison Road, Baguio',
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

describe('PlaceCard — OSM image fallback', () => {
  beforeEach(() => {
    capturedUri = undefined;
  });

  afterEach(() => jest.clearAllMocks());

  it('passes osmImageUrl to DisplayMediaImage when headerImageUrl and FSQ are both null', async () => {
    // useFsqPhoto returns null — no Foursquare or Google photo available.
    mockUseFsqPhoto.mockReturnValue(null);

    const { getByTestId } = await mountCard({ osmImageUrl: OSM_IMAGE_URL });

    await waitFor(() => {
      expect(getByTestId(`place-card-img-${BASE_PLACE.id}`)).toBeTruthy();
    });

    // The OSM image URL must have reached the image component.
    expect(capturedUri).toBe(OSM_IMAGE_URL);
  });

  it('does NOT render the category-icon fallback when osmImageUrl is the only real candidate', async () => {
    mockUseFsqPhoto.mockReturnValue(null);

    const { queryByTestId } = await mountCard({ osmImageUrl: OSM_IMAGE_URL });

    await waitFor(() => {
      expect(queryByTestId(`place-card-img-${BASE_PLACE.id}`)).toBeTruthy();
    });

    // Category fallback must be absent — an OSM photo is available.
    expect(queryByTestId('media-fallback')).toBeNull();
  });

  it('DOES render the category-icon fallback when osmImageUrl is also null', async () => {
    // Baseline: confirm the fallback path works when no candidate at all exists.
    mockUseFsqPhoto.mockReturnValue(null);

    const { getByTestId } = await mountCard({ osmImageUrl: null });

    await waitFor(() => {
      expect(getByTestId('media-fallback')).toBeTruthy();
    });
  });

  it('prefers a FSQ photo over osmImageUrl when both are present', async () => {
    // useFsqPhoto resolved a real photo — it must win over osmImageUrl.
    const FSQ_URL = 'https://fastly.4sqi.net/img/general/original/venue-photo.jpg';
    mockUseFsqPhoto.mockReturnValue(FSQ_URL);

    await mountCard({ osmImageUrl: OSM_IMAGE_URL });

    await waitFor(() => {
      expect(capturedUri).toBe(FSQ_URL);
    });

    expect(capturedUri).not.toBe(OSM_IMAGE_URL);
  });

  it('prefers headerImageUrl over osmImageUrl when headerImageUrl is set', async () => {
    const HEADER_URL = 'https://images.example.com/official-photo.jpg';
    mockUseFsqPhoto.mockReturnValue(null);

    await mountCard({
      headerImageUrl:    HEADER_URL,
      headerImageSource: 'provider',
      osmImageUrl:       OSM_IMAGE_URL,
    });

    await waitFor(() => {
      expect(capturedUri).toBe(HEADER_URL);
    });

    expect(capturedUri).not.toBe(OSM_IMAGE_URL);
  });
});
