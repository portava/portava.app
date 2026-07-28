/**
 * PlaceCard (detail) — phone field visibility
 *
 * Confirms that:
 *   1. When phone is null, the phone row is hidden entirely (no "N/A" text).
 *   2. When phone is set, the tappable phone row is rendered.
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
  it('hides the phone row entirely when phone is null', async () => {
    const place = makePlace({ phone: null });
    const { queryByTestId, queryByText } = await render(<PlaceCard place={place} />);

    await waitFor(() => {
      // Row should be completely absent — no testID, no fallback text
      expect(queryByTestId('place-card-phone')).toBeNull();
      expect(queryByText('Phone not available')).toBeNull();
    });
  });

  it('hides the phone row entirely when phone is undefined', async () => {
    const place = makePlace({ phone: undefined });
    const { queryByTestId, queryByText } = await render(<PlaceCard place={place} />);

    await waitFor(() => {
      expect(queryByTestId('place-card-phone')).toBeNull();
      expect(queryByText('Phone not available')).toBeNull();
    });
  });

  it('renders the tappable phone row when phone is set', async () => {
    const place = makePlace({ phone: '+63 2 8888 8888' });
    const { getByTestId, getByText } = await render(<PlaceCard place={place} />);

    await waitFor(() => {
      expect(getByTestId('place-card-phone')).toBeTruthy();
      expect(getByText('+63 2 8888 8888')).toBeTruthy();
    });
  });
});
