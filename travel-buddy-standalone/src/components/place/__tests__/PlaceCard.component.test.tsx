/**
 * PlaceCard — component tests
 *
 * Covers:
 *  1. Attribution strings are always rendered when provided (one per entry).
 *  2. Status badge appears for each non-active status (closed / temporarily_closed / moved).
 *  3. Null place prop → renders nothing.
 *
 * ## Act strategy
 * All renders are awaited. No fireEvent needed — pure display component.
 * waitFor used only when checking async text after render.
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { PlaceCard } from '../PlaceCard.tsx';
import type { CanonicalPlace } from '../../../types/canonicalPlace.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-image pulls in native modules that
// can't load under jest-expo.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ children, fallback }: any) => {
    const { View } = require('react-native');
    return <View testID="display-media-image">{fallback ?? children ?? null}</View>;
  },
  MediaFallback: ({ label }: any) => {
    const { Text, View } = require('react-native');
    return <View testID="media-fallback">{label ? <Text>{label}</Text> : null}</View>;
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlace(overrides: Partial<CanonicalPlace> = {}): CanonicalPlace {
  return {
    id:           'place-1',
    name:         'Test Café',
    category:     'food',
    coordinates:  { lat: 14.5, lng: 121.0 },
    address:      '123 Main St',
    city:         'Manila',
    neighborhood: 'Makati',
    countryCode:  'PH',
    status:       'active',
    detailRoute:  '/place/place-1',
    attribution:  [],
    sources:      [],
    fieldFreshness: {},
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceCard — null prop', () => {
  it('renders nothing when place is null', async () => {
    const { toJSON } = await render(<PlaceCard place={null} />);
    expect(toJSON()).toBeNull();
  });
});

describe('PlaceCard — attribution strings', () => {
  it('renders all attribution strings when provided', async () => {
    const place = makePlace({
      attribution: ['© OpenStreetMap contributors', '© Foursquare'],
    });
    const { getByTestId, getByText } = await render(<PlaceCard place={place} />);
    expect(getByTestId('place-attribution-footer')).toBeTruthy();
    expect(getByText('© OpenStreetMap contributors')).toBeTruthy();
    expect(getByText('© Foursquare')).toBeTruthy();
  });

  it('renders each attribution string as a separate element', async () => {
    const attrs = ['Source A', 'Source B', 'Source C'];
    const place = makePlace({ attribution: attrs });
    const { getByTestId } = await render(<PlaceCard place={place} />);
    for (let i = 0; i < attrs.length; i++) {
      expect(getByTestId(`place-attribution-${i}`)).toBeTruthy();
    }
  });

  it('does not render the attribution footer when the array is empty', async () => {
    const place = makePlace({ attribution: [] });
    const { queryByTestId } = await render(<PlaceCard place={place} />);
    expect(queryByTestId('place-attribution-footer')).toBeNull();
  });
});

describe('PlaceCard — status badge', () => {
  it('shows "Closed" badge when status is closed', async () => {
    const place = makePlace({ status: 'closed' });
    const { getByText } = await render(<PlaceCard place={place} />);
    expect(getByText('Closed')).toBeTruthy();
  });

  it('shows "Temporarily closed" badge when status is temporarily_closed', async () => {
    const place = makePlace({ status: 'temporarily_closed' });
    const { getByText } = await render(<PlaceCard place={place} />);
    expect(getByText('Temporarily closed')).toBeTruthy();
  });

  it('shows "Moved" badge when status is moved', async () => {
    const place = makePlace({ status: 'moved' });
    const { getByText } = await render(<PlaceCard place={place} />);
    expect(getByText('Moved')).toBeTruthy();
  });

  it('does not show a status badge when status is active', async () => {
    const place = makePlace({ status: 'active' });
    const { queryByText } = await render(<PlaceCard place={place} />);
    expect(queryByText('Closed')).toBeNull();
    expect(queryByText('Temporarily closed')).toBeNull();
    expect(queryByText('Moved')).toBeNull();
  });
});

describe('PlaceCard — separate rating rows', () => {
  it('renders provider rating and traveler score as separate rows when both present', async () => {
    const place = makePlace({
      rating:        4.2,
      ratingProvider: 'Foursquare',
      travelerScore: 4.8,
    });
    const { getByText } = await render(<PlaceCard place={place} />);
    // Both labels must be present separately — never merged
    expect(getByText(/Foursquare rating:/)).toBeTruthy();
    expect(getByText(/Traveler score:/)).toBeTruthy();
  });
});
