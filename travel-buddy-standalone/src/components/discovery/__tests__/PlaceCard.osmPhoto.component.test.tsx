/**
 * PlaceCard — real photo for OSM-only destinations
 *
 * Confirms that place cards for OSM-only destinations (no DB-backed
 * headerImageUrl) show a real photo thumbnail instead of the category emoji
 * fallback when the deferred FSQ/Google photo lookup succeeds.
 *
 * This is the end-to-end rendering path introduced by the #3662 fix:
 *   useFsqPhoto resolves a URL → PlaceCard builds a provider candidate →
 *   resolveHeaderImage picks it → DisplayMediaImage receives a non-null uri →
 *   category fallback is NOT rendered.
 *
 * Three scenarios are covered:
 *   1. FSQ CDN photo resolves          → real photo shown, FSQ credit visible
 *   2. Google photo resolves (fallback) → real photo shown, no FSQ credit
 *   3. Neither FSQ nor Google resolves  → category emoji fallback shown
 *
 * Two OSM-only destination/category combinations are tested (Tokyo/Events and
 * Paris/Activities) to satisfy the task's "at least one other" requirement.
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

const mockUseFsqPhoto = jest.fn<
  string | null,
  [string, number | null | undefined, number | null | undefined, string | undefined | null]
>();
// NOTE: useFsqPhoto is the subject under test — controlled per-test via
// mockReturnValue so we can simulate FSQ-resolved, Google-resolved, and null
// scenarios without firing real network requests.
jest.mock('../../../hooks/useFsqPhoto', () => ({
  useFsqPhoto: (
    ...args: [string, number | null | undefined, number | null | undefined, string | undefined | null]
  ) => mockUseFsqPhoto(...args),
}));

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo; only live-status is used.
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

// NOTE: expo-image pulls in native modules that crash under jest-expo; the mock
// renders the fallback only when uri is falsy (mirrors real behaviour) and
// exposes uri via accessibilityLabel so assertions can verify the passed URL.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, testID }: any) => {
    const { View } = require('react-native');
    if (!uri && fallback) {
      return <View testID={testID ?? 'display-media-image'}>{fallback}</View>;
    }
    // Render a stable placeholder — testID lets callers confirm the image was
    // mounted. accessibilityLabel carries the uri so assertions can verify it.
    return (
      <View
        testID={testID ?? 'display-media-image'}
        accessibilityLabel={uri ?? ''}
      />
    );
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
// prevents cascading dependency issues without affecting photo rendering.
jest.mock('../../visuals/AiRepresentationLabel.tsx', () => ({
  AiRepresentationLabel: () => null,
}));

// NOTE: ImageSourceBadge imports an accuracy-pipeline service chain with
// Supabase internals not safe under jest-expo; the badge never renders in these
// tests because fixture places have no imageSourceType.
jest.mock('../../visuals/ImageSourceBadge.tsx', () => ({
  ImageSourceBadge: () => null,
}));

// NOTE: fallbackUriFor calls require() on bundled assets unavailable under
// jest; returning null means no category_fallback candidate is injected, so
// resolveHeaderImage only considers the provider URL the hook returned.
jest.mock('../../../lib/visuals/fallbackAssets', () => ({
  fallbackUriFor: jest.fn().mockReturnValue(null),
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const FSQ_PHOTO_URL =
  'https://fastly.4sqi.net/img/general/original/venue-tokyo-event.jpg';
const GOOGLE_PHOTO_URL =
  'https://places.googleapis.com/v1/places/abc/photos/0/media?maxWidthPx=800&key=REDACTED';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Tokyo/Events — representative OSM-only destination: no headerImageUrl from
 * the DB, real coordinates, category = 'events'.
 */
const TOKYO_EVENTS_PLACE: DiscoveryPlace = {
  id:                'osm-tokyo-events-1',
  name:              'Shinjuku Omoide Yokocho Night Market',
  category:          'events',
  type:              'street food event',
  description:       'Nightly street food alley near Shinjuku station',
  distanceKm:        0.4,
  lat:               35.6938,
  lng:               139.7036,
  tags:              ['osm:node/12345', 'street-food', 'nightlife'],
  address:           '1-chome Nishishinjuku, Tokyo',
  neighborhood:      'Shinjuku',
  website:           null,
  phone:             null,
  openingHours:      null,
  rating:            null,
  isOpenNow:         null,
  headerImageUrl:    null,   // ← OSM-only: no DB-backed image
  headerImageSource: null,
  attribution:       null,
  imageSourceType:   null,
  accuracyStatus:    null,
  disclaimerRequired: null,
};

/**
 * Paris/Activities — second OSM-only destination for the "at least one other"
 * requirement.
 */
const PARIS_ACTIVITIES_PLACE: DiscoveryPlace = {
  id:                'osm-paris-activities-1',
  name:              'Vélo Île-de-France Cycling Route',
  category:          'activities',
  type:              'cycling route',
  description:       'Scenic cycling path along the Seine',
  distanceKm:        2.1,
  lat:               48.8566,
  lng:               2.3522,
  tags:              ['osm:way/67890', 'cycling', 'outdoor'],
  address:           'Berges de Seine, Paris',
  neighborhood:      '7th Arrondissement',
  website:           null,
  phone:             null,
  openingHours:      null,
  rating:            null,
  isOpenNow:         null,
  headerImageUrl:    null,   // ← OSM-only: no DB-backed image
  headerImageSource: null,
  attribution:       null,
  imageSourceType:   null,
  accuracyStatus:    null,
  disclaimerRequired: null,
};

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountCard(place: DiscoveryPlace) {
  return render(
    <PlaceCard
      place={place}
      onPress={jest.fn()}
      onAddToPlan={jest.fn()}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceCard — real photos for OSM-only destinations', () => {
  afterEach(() => jest.clearAllMocks());

  // ── Tokyo / Events ──────────────────────────────────────────────────────────

  describe('Tokyo / Events (OSM-only, no DB-backed headerImageUrl)', () => {
    it('shows a real photo and "Powered by Foursquare" when FSQ lookup resolves a CDN URL', async () => {
      mockUseFsqPhoto.mockReturnValue(FSQ_PHOTO_URL);

      const { queryByTestId, getByText } = await mountCard(TOKYO_EVENTS_PLACE);

      // Category fallback must NOT be visible — a real photo was found.
      await waitFor(() => {
        expect(queryByTestId('media-fallback')).toBeNull();
      });

      // FSQ API terms require the "Powered by Foursquare" credit when an FSQ
      // CDN URL is displayed.
      expect(getByText('Powered by Foursquare')).toBeTruthy();
    });

    it('shows a real photo without FSQ credit when the Google fallback URL resolves', async () => {
      // FSQ came up empty; useFsqPhoto fell through to Google Places.
      mockUseFsqPhoto.mockReturnValue(GOOGLE_PHOTO_URL);

      const { queryByTestId, queryByText } = await mountCard(TOKYO_EVENTS_PLACE);

      // Category fallback must NOT be visible — Google provided a real photo.
      await waitFor(() => {
        expect(queryByTestId('media-fallback')).toBeNull();
      });

      // "Powered by Foursquare" must NOT appear — the photo is from Google.
      expect(queryByText('Powered by Foursquare')).toBeNull();
    });

    it('shows the category emoji fallback when neither FSQ nor Google finds a photo', async () => {
      // Both legs of the deferred chain came up empty.
      mockUseFsqPhoto.mockReturnValue(null);

      const { getByTestId } = await mountCard(TOKYO_EVENTS_PLACE);

      // Category fallback MUST be visible — no photo is available.
      await waitFor(() => {
        expect(getByTestId('media-fallback')).toBeTruthy();
      });
    });

    it('passes the FSQ photo URI directly to DisplayMediaImage — not the DB image slot', async () => {
      mockUseFsqPhoto.mockReturnValue(FSQ_PHOTO_URL);

      const { getByTestId } = await mountCard(TOKYO_EVENTS_PLACE);

      await waitFor(() => {
        const imgEl = getByTestId(`place-card-img-${TOKYO_EVENTS_PLACE.id}`);
        // accessibilityLabel is set to the uri by the mock (see mock definition)
        expect(imgEl.props.accessibilityLabel).toBe(FSQ_PHOTO_URL);
      });
    });
  });

  // ── Paris / Activities ──────────────────────────────────────────────────────

  describe('Paris / Activities (OSM-only — second destination/category check)', () => {
    it('shows a real FSQ photo for Paris/Activities — not the category emoji fallback', async () => {
      const FSQ_PARIS_URL =
        'https://fastly.4sqi.net/img/general/original/venue-paris-cycling.jpg';
      mockUseFsqPhoto.mockReturnValue(FSQ_PARIS_URL);

      const { queryByTestId, getByText } = await mountCard(PARIS_ACTIVITIES_PLACE);

      // Category fallback must NOT be visible.
      await waitFor(() => {
        expect(queryByTestId('media-fallback')).toBeNull();
      });

      // FSQ credit must appear.
      expect(getByText('Powered by Foursquare')).toBeTruthy();
    });

    it('shows the category emoji fallback for Paris/Activities when no photo is found', async () => {
      mockUseFsqPhoto.mockReturnValue(null);

      const { getByTestId } = await mountCard(PARIS_ACTIVITIES_PLACE);

      await waitFor(() => {
        expect(getByTestId('media-fallback')).toBeTruthy();
      });
    });
  });

  // ── useFsqPhoto called with correct args for OSM-only places ────────────────

  it('calls useFsqPhoto with the place name and coordinates (passthrough is undefined for OSM-only)', async () => {
    mockUseFsqPhoto.mockReturnValue(null);

    await mountCard(TOKYO_EVENTS_PLACE);

    // useFsqPhoto must be called with name + coords.
    // For a non-AI place with no headerImageUrl, fsqPassthrough is undefined
    // (the hook is expected to fire the FSQ proxy lookup unconditionally).
    expect(mockUseFsqPhoto).toHaveBeenCalledWith(
      TOKYO_EVENTS_PLACE.name,
      TOKYO_EVENTS_PLACE.lat,
      TOKYO_EVENTS_PLACE.lng,
      undefined,
    );
  });
});
