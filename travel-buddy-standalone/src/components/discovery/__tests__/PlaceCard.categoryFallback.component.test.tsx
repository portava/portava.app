/**
 * PlaceCard (discovery) — category fallback image test
 *
 * Confirms that the card renders the category fallback block whenever
 * `headerImageUrl` is absent (null, undefined, or not set), so no place
 * ever shows a gray blank box.
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { PlaceCard } from '../PlaceCard.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo; only the live-status function
// is needed and we control its return value entirely.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatusCached: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules
// that are not safe under jest-expo; only the stubs are needed here.
jest.mock('../../../services/collections', () => ({
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
  saveItem:   jest.fn().mockResolvedValue(true),
  unsaveItem: jest.fn().mockResolvedValue(true),
}));

// NOTE: intentionally exhaustive — discoveryBookmarks imports AsyncStorage
// (already globally mocked) and Supabase; the Set return is all that matters.
jest.mock('../../../services/discoveryBookmarks', () => ({
  getSavedListIds: jest.fn().mockResolvedValue(new Set()),
}));

// NOTE: intentionally exhaustive — the real PlanPickerController renders the
// full picker UI tree with Reanimated/portal internals; only isAdded is needed.
jest.mock('../../PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker pulls in its own service
// chain and Modal; stubbing to null prevents a secondary dependency cascade.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: expo-image pulls in native modules that crash under jest-expo.
// DisplayMediaImage is mocked to render its `fallback` prop when uri is null,
// which mirrors the real component's behaviour.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, children, testID }: any) => {
    const { View } = require('react-native');
    if (!uri && fallback) {
      return <View testID={testID ?? 'display-media-image'}>{fallback}</View>;
    }
    return <View testID={testID ?? 'display-media-image'}>{children ?? null}</View>;
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

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs suffice.

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PLACE: DiscoveryPlace = {
  id:           'place-fb-1',
  name:         'Sunset Beach Bar',
  category:     'food',
  type:         'bar',
  description:  null,
  distanceKm:   null,
  lat:          14.5,
  lng:          121.0,
  tags:         [],
  address:      '1 Beach Rd',
  website:      null,
  phone:        null,
  openingHours: null,
  rating:       null,
  isOpenNow:    null,
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

describe('PlaceCard (discovery) — category fallback image', () => {
  afterEach(() => jest.clearAllMocks());

  it('renders the category fallback when headerImageUrl is absent (undefined)', async () => {
    const place: DiscoveryPlace = { ...BASE_PLACE };
    // No headerImageUrl field — should show fallback block

    const { getByTestId } = await mountCard(place);

    await waitFor(() => {
      expect(getByTestId('media-fallback')).toBeTruthy();
    });
  });

  it('renders the category fallback when headerImageUrl is null', async () => {
    const place: DiscoveryPlace = { ...BASE_PLACE, headerImageUrl: null };

    const { getByTestId } = await mountCard(place);

    await waitFor(() => {
      expect(getByTestId('media-fallback')).toBeTruthy();
    });
  });

  it('renders the category-specific fallback label for the "food" category', async () => {
    const place: DiscoveryPlace = { ...BASE_PLACE, category: 'food' };

    const { getByTestId } = await mountCard(place);

    await waitFor(() => {
      expect(getByTestId('media-fallback-label')).toBeTruthy();
    });
  });

  it('shows the image container even when there is no headerImageUrl', async () => {
    const place: DiscoveryPlace = { ...BASE_PLACE };

    const { getByTestId } = await mountCard(place);

    await waitFor(() => {
      expect(getByTestId(`place-card-image-${place.id}`)).toBeTruthy();
    });
  });
});
