/**
 * Component tests for PlaceCard — FSQ attribution label visibility.
 *
 * Covers:
 *   1. Attribution text renders when place.attribution is set (FSQ CC BY 4.0)
 *   2. No attribution text appears when place.attribution is null
 *   3. No attribution text appears when place.attribution is undefined
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

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo; only the live-status function is
// needed and we control its return value entirely in these attribution tests.
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
// chain and Modal; stubbing to null prevents a secondary dependency cascade that
// is orthogonal to attribution rendering.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
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
  radius: { sm: 4, md: 8, pill: 999 },
  type:   { heading: {}, bodyStrong: {}, small: {}, stamp: {} },
  shadow: { card: {}, float: {} },
  layout: { pressedOpacity: 0.7 },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PLACE: DiscoveryPlace = {
  id:           'place-fsq-1',
  name:         'Café du Marché',
  category:     'food',
  type:         'café',
  description:  null,
  distanceKm:   null,
  lat:          48.8566,
  lng:          2.3522,
  tags:         [],
  address:      '12 Rue de Rivoli, Paris',
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

describe('PlaceCard — FSQ attribution label', () => {
  afterEach(() => jest.clearAllMocks());

  it('renders the attribution text when place.attribution is set', async () => {
    const place: DiscoveryPlace = {
      ...BASE_PLACE,
      attribution: 'Foursquare CC BY 4.0',
    };

    const { getByText } = await mountCard(place);

    await waitFor(() => {
      expect(getByText('Foursquare CC BY 4.0')).toBeTruthy();
    });
  });

  it('does not render any attribution text when place.attribution is null', async () => {
    const place: DiscoveryPlace = {
      ...BASE_PLACE,
      attribution: null,
    };

    const { queryByText } = await mountCard(place);

    // Allow async effects (live-status, saved-count) to settle before asserting.
    await waitFor(() => expect(queryByText('Foursquare CC BY 4.0')).toBeNull());
  });

  it('does not render any attribution text when place.attribution is undefined', async () => {
    const place: DiscoveryPlace = {
      ...BASE_PLACE,
      // attribution omitted — field is optional in DiscoveryPlace
    };

    const { queryByText } = await mountCard(place);

    await waitFor(() => expect(queryByText('Foursquare CC BY 4.0')).toBeNull());
  });
});
