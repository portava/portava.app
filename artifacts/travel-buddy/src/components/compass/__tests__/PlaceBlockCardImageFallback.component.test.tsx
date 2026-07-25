/**
 * PlaceBlockCard — image error fallback test
 *
 * Confirms that when the hero Image fires onError (e.g. broken URL), the
 * card switches to the accent-strip fallback and no Image element remains
 * visible.
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await.
 */

import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
import { CompassChatBlocks } from '../CompassChatBlocks.tsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router navigation internals are not
// safe under jest-expo.
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native
// font loader internals that crash under jest-expo.
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
    success:     '#16A34A',
  },
  space:  { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  type:   { heading: {}, bodyStrong: {}, body: {}, small: {}, stamp: {} },
  shadow: { card: {}, float: {} },
}));

// NOTE: intentionally exhaustive — compass analytics service makes real
// network calls; none of the analytics events are asserted here.
jest.mock('../../../services/compass.ts', () => ({
  postCompassAnalyticsEvent: jest.fn(),
  reportCompassViewed:       jest.fn(),
  COMPASS_ENGINE_VERSION:    'test',
}));

// NOTE: intentionally exhaustive — CompassWhySheet uses native modal
// internals not safe under jest-expo.
jest.mock('../CompassWhySheet.tsx', () => ({
  CompassWhySheet: () => null,
}));

// NOTE: intentionally exhaustive — CompassMiniMap imports MapLibre which is
// native-only and crashes under jest-expo.
jest.mock('../CompassMiniMap', () => ({
  CompassMiniMap: () => null,
}));

// NOTE: intentionally exhaustive — compassFormat pulls in date-fns and other
// helpers; only the image-error behaviour is asserted here.
jest.mock('../../../utils/compassFormat.ts', () => ({
  formatCompassEventChip: () => 'Aug 1',
}));

// ── Fixture ───────────────────────────────────────────────────────────────────

const PLACE_WITH_IMAGE = {
  id:             'place-broken-img',
  name:           'Broken Image Café',
  category:       'food',
  city:           'Testville',
  neighborhood:   'Old Quarter',
  rating:         4.2,
  blurb:          'Great vibes',
  headerImageUrl: 'https://broken.example.com/no-such-image.jpg',
  lat:            10.3,
  lng:            123.9,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PlaceBlockCard — image error fallback', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows the accent strip and hides the Image after onError fires', async () => {
    const { getByTestId, queryByTestId } = await render(
      <CompassChatBlocks
        blocks={[{ type: 'place_cards', places: [PLACE_WITH_IMAGE] }]}
      />,
    );

    // Image must be present before the error fires
    await waitFor(() => {
      expect(getByTestId(`compass-block-place-image-${PLACE_WITH_IMAGE.id}`)).toBeTruthy();
    });

    // Simulate a broken image URL
    fireEvent(getByTestId(`compass-block-place-image-${PLACE_WITH_IMAGE.id}`), 'error');

    // After the error the Image must be gone and the accent strip must appear
    await waitFor(() => {
      expect(queryByTestId(`compass-block-place-image-${PLACE_WITH_IMAGE.id}`)).toBeNull();
      expect(getByTestId(`compass-block-place-strip-${PLACE_WITH_IMAGE.id}`)).toBeTruthy();
    });
  });
});
