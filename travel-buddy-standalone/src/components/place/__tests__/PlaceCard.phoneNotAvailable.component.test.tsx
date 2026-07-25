/**
 * PlaceCard (detail) — "Phone not available" fallback
 *
 * Confirms that:
 *   1. When phone is null, renders "Phone not available" text (not blank).
 *   2. When phone is set, renders the tappable phone number.
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { PlaceCard } from '../PlaceCard.tsx';
import type { CanonicalPlace } from '../../../types/canonicalPlace.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

// NOTE: expo-image crashes under jest-expo — mock DisplayMediaImage entirely.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({
  DisplayMediaImage: ({ fallback, children }: any) => {
    const { View } = require('react-native');
    return <View testID="display-media-image">{fallback ?? children ?? null}</View>;
  },
  MediaFallback: ({ label }: any) => {
    const { Text, View } = require('react-native');
    return <View testID="media-fallback">{label ? <Text>{label}</Text> : null}</View>;
  },
}));

// NOTE: Linking is available natively but we stub it to avoid opening real URLs.
jest.mock('react-native/Libraries/Linking/Linking', () => ({
  openURL: jest.fn().mockResolvedValue(undefined),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlace(overrides: Partial<CanonicalPlace> = {}): CanonicalPlace {
  return {
    id:           'place-phone-test',
    name:         'Test Café',
    category:     'food',
    coordinates:  { lat: 14.5, lng: 121.0 },
    address:      '123 Main St',
    city:         'Manila',
    neighborhood: 'Makati',
    countryCode:  'PH',
    status:       'active',
    detailRoute:  '/place/place-phone-test',
    attribution:  [],
    sources:      [],
    fieldFreshness: {},
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceCard (detail) — phone field', () => {
  it('renders "Phone not available" when phone is null', async () => {
    const place = makePlace({ phone: null });
    const { getByText } = await render(<PlaceCard place={place} />);

    await waitFor(() => {
      expect(getByText('Phone not available')).toBeTruthy();
    });
  });

  it('renders "Phone not available" when phone is undefined', async () => {
    const place = makePlace({ phone: undefined });
    const { getByText } = await render(<PlaceCard place={place} />);

    await waitFor(() => {
      expect(getByText('Phone not available')).toBeTruthy();
    });
  });

  it('renders the phone number when phone is set', async () => {
    const place = makePlace({ phone: '+63 2 8888 8888' });
    const { getByText, queryByText } = await render(<PlaceCard place={place} />);

    await waitFor(() => {
      expect(getByText('+63 2 8888 8888')).toBeTruthy();
      expect(queryByText('Phone not available')).toBeNull();
    });
  });

  it('renders the phone row element regardless of phone value', async () => {
    const place = makePlace({ phone: null });
    const { getByTestId } = await render(<PlaceCard place={place} />);

    await waitFor(() => {
      expect(getByTestId('place-card-phone')).toBeTruthy();
    });
  });
});
