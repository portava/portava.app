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
import type { CompassUiPlace } from '../../../services/compass.ts';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router navigation internals are not
// safe under jest-expo.
jest.mock('expo-router', () => ({
  useRouter:      () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native
// font loader internals that crash under jest-expo.

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

/**
 * TYPED, so a field CompassUiPlace does not have has to be declared deliberately
 * rather than appearing by accident — and `headerImageUrl` is exactly such a
 * field.
 *
 * KNOWN GAP: the server's `UiPlace` (api-server compass/CompassUiBlocks.ts) has
 * NO image field, and nothing in the block builder ever sets one, so a real
 * compass chat place card has never had an image to break. This test still
 * earns its place — it covers the card's onError fallback, which is real client
 * behaviour — but the intersection type is here so the next reader knows the
 * fixture is ahead of the API rather than describing it. Wiring the image
 * end-to-end is a Compass change; see the notes in PR #321.
 */
const PLACE_WITH_IMAGE: CompassUiPlace & { headerImageUrl: string } = {
  id:             'place-broken-img',
  name:           'Broken Image Café',
  category:       'food',
  city:           'Testville',
  neighborhood:   'Old Quarter',
  rating:         4.2,
  blurb:          'Great vibes',
  verified:       false,
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
