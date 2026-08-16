/**
 * PlaceDetailSheet — Wikidata enrichment tests
 *
 * Confirms that:
 *   1. When wikidataId is set, the Wikidata link row (testID="place-sheet-wikidata") is present.
 *   2. Pressing the Wikidata link calls Linking.openURL with the correct wikidata.org URL.
 *   3. When wikidataId is null/absent, the Wikidata link row is not rendered.
 *   4. When getWikidataEnrichment returns a wikipediaUrl, a Wikipedia link appears.
 *   5. Both links are present at the same time when enrichment has a Wikipedia URL.
 *   6. No Wikipedia link is shown when enrichment has no wikipediaUrl.
 *   7. Wikidata description fills the About section when place.description is null.
 *   8. Place's own description takes precedence over the Wikidata description.
 *
 * ## Modal strategy
 * PlaceDetailSheet IS a Modal. The Modal Proxy replaces react-native's Modal
 * with a synchronous View so act() scopes don't overlap.
 * Must be declared before any imports that touch react-native.
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports.
// Avoids overlapping act() from Modal animation lifecycle — see
// .agents/memory/modal-proxy-mock.md.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import React from 'react';
import { Linking } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { PlaceDetailSheet } from '../PlaceDetailSheet.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';
import { getWikidataEnrichment } from '../../../services/discovery.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals; only getPlaceLiveStatus and getWikidataEnrichment are
// needed here.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatus: jest.fn().mockResolvedValue(null),
  getWikidataEnrichment: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules
// that are not safe under jest-expo; only the stubs are needed.
jest.mock('../../../services/collections', () => ({
  checkSaved:  jest.fn().mockResolvedValue({ saved: false }),
  toggleSave:  jest.fn().mockResolvedValue(false),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker has its own Modal chain;
// stubbing to null prevents a secondary act() scope.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — useBottomInset reads safe-area native
// modules that crash under jest-expo; a constant inset of 0 is sufficient.
jest.mock('../../../hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 0,
}));

// NOTE: intentionally exhaustive — expo-image pulls in native modules that
// crash under jest-expo; the fallback branch is all we need.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ uri, fallback, children, testID }: any) => {
    const { View } = require('react-native');
    if (!uri && fallback) return <View testID={testID ?? 'sheet-img'}>{fallback}</View>;
    return <View testID={testID ?? 'sheet-img'}>{children ?? null}</View>;
  },
  MediaFallback: () => {
    const { View } = require('react-native');
    return <View testID="sheet-media-fallback" />;
  },
}));

// NOTE: intentionally exhaustive — LocationContext reads session + GPS state
// from multiple native hooks; we only need a stub resolvedLocation here.
jest.mock('../../../context/LocationContext', () => ({
  useLocationContext: () => ({
    resolvedLocation: { coords: null, source: 'none', freshness: 'unavailable', place: null },
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PLACE: DiscoveryPlace = {
  id:           'place-wiki-1',
  name:         'Eiffel Tower',
  category:     'places',
  type:         'landmark',
  description:  'A wrought-iron lattice tower',
  distanceKm:   null,
  lat:          48.8584,
  lng:          2.2945,
  tags:         [],
  address:      'Champ de Mars, Paris',
  website:      null,
  phone:        null,
  openingHours: null,
  rating:       null,
  isOpenNow:    null,
};

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountSheet(place: DiscoveryPlace) {
  return render(
    <PlaceDetailSheet
      place={place}
      visible
      onClose={jest.fn()}
      onAddToPlan={jest.fn()}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const mockGetWikidataEnrichment = getWikidataEnrichment as jest.MockedFunction<typeof getWikidataEnrichment>;

describe('PlaceDetailSheet — Wikidata link', () => {
  let openURLSpy: jest.SpyInstance;

  beforeEach(() => {
    openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  });

  afterEach(() => jest.clearAllMocks());

  it('shows the wikidata link row when wikidataId is set', async () => {
    const place: DiscoveryPlace = { ...BASE_PLACE, wikidataId: 'Q243' };

    const { getByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(getByTestId('place-sheet-wikidata')).toBeTruthy();
    });
  });

  it('calls Linking.openURL with the correct wikidata.org URL when pressed', async () => {
    const WIKIDATA_ID = 'Q243';
    const place: DiscoveryPlace = { ...BASE_PLACE, wikidataId: WIKIDATA_ID };

    const { getByTestId } = await mountSheet(place);

    await waitFor(() => getByTestId('place-sheet-wikidata'));

    fireEvent.press(getByTestId('place-sheet-wikidata'));

    expect(openURLSpy).toHaveBeenCalledWith(
      `https://www.wikidata.org/wiki/${WIKIDATA_ID}`,
    );
  });

  it('does not show the wikidata link row when wikidataId is null', async () => {
    const place: DiscoveryPlace = { ...BASE_PLACE, wikidataId: null };

    const { queryByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(queryByTestId('place-sheet-wikidata')).toBeNull();
    });
  });

  it('does not show the wikidata link row when wikidataId is absent', async () => {
    // wikidataId not set at all (field is optional on DiscoveryPlace)
    const place: DiscoveryPlace = { ...BASE_PLACE };

    const { queryByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(queryByTestId('place-sheet-wikidata')).toBeNull();
    });
  });
});

describe('PlaceDetailSheet — Wikidata enrichment (Wikipedia link)', () => {
  let openURLSpy: jest.SpyInstance;

  beforeEach(() => {
    openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  });

  afterEach(() => jest.clearAllMocks());

  it('shows a Wikipedia link when enrichment provides a wikipediaUrl', async () => {
    mockGetWikidataEnrichment.mockResolvedValueOnce({
      description: 'Iron lattice tower in Paris',
      wikipediaUrl: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
      commonsImageUrl: null,
    });
    const place: DiscoveryPlace = { ...BASE_PLACE, wikidataId: 'Q243' };

    const { getByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(getByTestId('place-sheet-wikipedia')).toBeTruthy();
    });
  });

  it('shows both Wikidata and Wikipedia links when enrichment has a Wikipedia URL', async () => {
    mockGetWikidataEnrichment.mockResolvedValueOnce({
      description: 'Iron lattice tower in Paris',
      wikipediaUrl: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
      commonsImageUrl: null,
    });
    const place: DiscoveryPlace = { ...BASE_PLACE, wikidataId: 'Q243' };

    const { getByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(getByTestId('place-sheet-wikipedia')).toBeTruthy();
      expect(getByTestId('place-sheet-wikidata')).toBeTruthy();
    });
  });

  it('calls Linking.openURL with the Wikipedia URL when the Wikipedia link is pressed', async () => {
    const WIKIPEDIA_URL = 'https://en.wikipedia.org/wiki/Eiffel_Tower';
    mockGetWikidataEnrichment.mockResolvedValueOnce({
      description: null,
      wikipediaUrl: WIKIPEDIA_URL,
      commonsImageUrl: null,
    });
    const place: DiscoveryPlace = { ...BASE_PLACE, wikidataId: 'Q243' };

    const { getByTestId } = await mountSheet(place);

    await waitFor(() => getByTestId('place-sheet-wikipedia'));
    fireEvent.press(getByTestId('place-sheet-wikipedia'));

    expect(openURLSpy).toHaveBeenCalledWith(WIKIPEDIA_URL);
  });

  it('does not show a Wikipedia link when enrichment returns no wikipediaUrl', async () => {
    mockGetWikidataEnrichment.mockResolvedValueOnce({
      description: 'Iron lattice tower in Paris',
      wikipediaUrl: null,
      commonsImageUrl: null,
    });
    const place: DiscoveryPlace = { ...BASE_PLACE, wikidataId: 'Q243' };

    const { queryByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(queryByTestId('place-sheet-wikipedia')).toBeNull();
    });
  });

  it('does not show a Wikipedia link when enrichment fetch returns null', async () => {
    // Default mock already returns null — no override needed.
    const place: DiscoveryPlace = { ...BASE_PLACE, wikidataId: 'Q243' };

    const { queryByTestId } = await mountSheet(place);

    await waitFor(() => {
      expect(queryByTestId('place-sheet-wikipedia')).toBeNull();
    });
  });
});

describe('PlaceDetailSheet — Wikidata enrichment (description fallback)', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows Wikidata description in About when place.description is null', async () => {
    const WIKIDATA_DESC = 'Iron lattice tower on the Champ de Mars, Paris';
    mockGetWikidataEnrichment.mockResolvedValueOnce({
      description: WIKIDATA_DESC,
      wikipediaUrl: null,
      commonsImageUrl: null,
    });
    const place: DiscoveryPlace = { ...BASE_PLACE, description: null, wikidataId: 'Q243' };

    const { getByText } = await mountSheet(place);

    await waitFor(() => {
      expect(getByText(WIKIDATA_DESC)).toBeTruthy();
    });
  });

  it("shows the place's own description when both place.description and Wikidata description are available", async () => {
    const PLACE_DESC  = 'A wrought-iron lattice tower';
    const WIKIDATA_DESC = 'Iron lattice tower on the Champ de Mars, Paris';
    mockGetWikidataEnrichment.mockResolvedValueOnce({
      description: WIKIDATA_DESC,
      wikipediaUrl: null,
      commonsImageUrl: null,
    });
    const place: DiscoveryPlace = { ...BASE_PLACE, description: PLACE_DESC, wikidataId: 'Q243' };

    const { getByText, queryByText } = await mountSheet(place);

    await waitFor(() => {
      expect(getByText(PLACE_DESC)).toBeTruthy();
      expect(queryByText(WIKIDATA_DESC)).toBeNull();
    });
  });

  it('shows no About section when neither place description nor Wikidata description is available', async () => {
    // Default mock returns null enrichment.
    const place: DiscoveryPlace = { ...BASE_PLACE, description: null, wikidataId: 'Q243' };

    const { queryByText } = await mountSheet(place);

    await waitFor(() => {
      expect(queryByText('About')).toBeNull();
    });
  });
});
