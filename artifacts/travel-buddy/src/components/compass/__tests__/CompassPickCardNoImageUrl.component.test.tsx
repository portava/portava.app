/**
 * CompassPickCard — no imageUrl initial-render fallback test
 *
 * Confirms that when resolveCompassImageUrl returns null (no imageUrl in the
 * item data at all), the emoji/colour-strip fallback is visible immediately
 * on first render — no Image element, no onError step needed.
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { CompassPicksSection } from '../CompassPicksSection.tsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — expo-router navigation internals are not
// safe under jest-expo.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
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

// NOTE: intentionally exhaustive — useCompassFeed makes real API calls;
// returning a stable fixture with no imageUrl isolates the initial-render
// fallback assertion (no image data anywhere in the item).
jest.mock('../../../hooks/compass/useCompassFeed.ts', () => ({
  useCompassFeed: () => ({
    loading:         false,
    compassEnabled:  true,
    data: {
      sections: [{
        items: [{
          id:       'place-no-img-1',
          type:     'place',
          category: 'food',
          title:    'No Image Café',
          data: {
            // Deliberately omit imageUrl, headerImageUrl, and image_url
            neighborhood: 'Riverside',
            city:         'Testville',
          },
          recommendationToken: 'tok-no-img-1',
        }],
      }],
      safeItems:      [],
      fallback:       false,
      compassEnabled: true,
    },
  }),
}));

// NOTE: intentionally exhaustive — resolveCompassImageUrl must return null
// so that no Image element is rendered; the emoji fallback must appear on
// the very first render without any onError trigger.
jest.mock('../../../utils/compassFormat.ts', () => ({
  resolveCompassTitle:    (_item: any) => 'No Image Café',
  formatCompassSubtitle:  () => null,
  formatCompassContext:   () => 'Because you like cafés',
  resolveCompassCategory: () => 'Food',
  resolveCompassImageUrl: () => null,
}));

// NOTE: intentionally exhaustive — CompassWhySheet uses native modal internals
// not safe under jest-expo.
jest.mock('../CompassWhySheet.tsx', () => ({
  CompassWhySheet: () => null,
}));

// NOTE: intentionally exhaustive — CompassFeedbackMenu imports analytics
// services; only the rendered UI elements matter here.
jest.mock('../CompassFeedbackMenu.tsx', () => ({
  CompassFeedbackMenu: () => null,
}));

// NOTE: intentionally exhaustive — compass analytics service makes real
// network calls; none of the analytics events are asserted here.
jest.mock('../../../services/compass.ts', () => ({
  postCompassAnalyticsEvent: jest.fn(),
  reportCompassViewed:       jest.fn(),
  COMPASS_ENGINE_VERSION:    'test',
}));

// NOTE: intentionally exhaustive — SessionContext uses Supabase auth
// internals not safe under jest-expo.
jest.mock('../../../context/SessionContext.tsx', () => ({
  useSession: () => ({ isAuthed: true, userId: 'user-1' }),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CompassPickCard — no imageUrl initial-render fallback', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows the emoji fallback immediately when resolveCompassImageUrl returns null — no Image rendered, no error step needed', async () => {
    const { getByTestId, queryByTestId } = await render(
      <CompassPicksSection city="Testville" enabled />,
    );

    await waitFor(() => {
      // Emoji fallback must be present from the very first render
      expect(getByTestId('compass-pick-emoji-place-no-img-1')).toBeTruthy();
      // No hero Image should exist — imageUrl was null from the start
      expect(queryByTestId('compass-pick-image-place-no-img-1')).toBeNull();
    });
  });
});
