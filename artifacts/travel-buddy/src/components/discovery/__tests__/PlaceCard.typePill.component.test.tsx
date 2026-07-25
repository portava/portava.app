/**
 * PlaceCard (discovery) — type pill label test
 *
 * Confirms that the meta-row pill shows the specific place type (e.g. "Cafe")
 * when `place.type` is set, and falls back to the broad category (e.g. "Food")
 * when `place.type` is null — so a refactor cannot silently revert to the
 * generic category without failing CI.
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
jest.mock('../../../theme/tokens', () => ({
  color: {
    deep:        '#2A7F8F',
    ink:         '#1A1A2E',
    signal:      '#FF6B6B',
    mute:        '#9B9B9B',
    faint:       '#CCCCCC',
    paper:       '#FFFFFF',
    paperRaised: '#F9F9F9',
    haze:        '#E8E8E8',
    onInk:       '#FFFFFF',
  },
  space:  { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  type:   { heading: {}, bodyStrong: {}, body: {}, small: {}, stamp: {} },
  shadow: { card: {}, float: {} },
  layout: { pressedOpacity: 0.7 },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PLACE: DiscoveryPlace = {
  id:           'place-type-1',
  name:         'Corner Espresso',
  category:     'food',
  type:         'cafe',
  description:  null,
  distanceKm:   null,
  lat:          1.3,
  lng:          103.8,
  tags:         [],
  address:      '10 Main St',
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

describe('PlaceCard (discovery) — type pill label', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows the specific type label when place.type is set', async () => {
    // place.type = "cafe", place.category = "food"
    // The pill must display "Cafe", not the broad "Food" category.
    const place: DiscoveryPlace = { ...BASE_PLACE, type: 'cafe', category: 'food' };

    const { getByText, queryByText } = await mountCard(place);

    await waitFor(() => {
      expect(getByText('Cafe')).toBeTruthy();
      expect(queryByText('Food')).toBeNull();
    });
  });

  it('falls back to the category label when place.type is null', async () => {
    // With no specific type, the pill must display the broad category "Food".
    const place: DiscoveryPlace = { ...BASE_PLACE, type: null, category: 'food' };

    const { getByText } = await mountCard(place);

    await waitFor(() => {
      expect(getByText('Food')).toBeTruthy();
    });
  });
});
