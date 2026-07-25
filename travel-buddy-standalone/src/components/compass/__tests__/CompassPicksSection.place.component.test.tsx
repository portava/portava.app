/**
 * CompassPicksSection — place card standard test
 *
 * Confirms that Compass pick cards for place-type items show address /
 * neighborhood metadata (not just the place name).
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
// returning a stable fixture isolates the rendering assertion.
jest.mock('../../../hooks/compass/useCompassFeed.ts', () => ({
  useCompassFeed: () => ({
    loading:         false,
    compassEnabled:  true,
    data: {
      sections: [{
        items: [{
          id:       'place-pick-1',
          type:     'place',
          category: 'food',
          title:    'Le Petit Bistro',
          data: {
            neighborhood: 'Le Marais',
            address:      '12 Rue de Rivoli, Paris',
            city:         'Paris',
          },
          recommendationToken: 'tok-1',
        }],
      }],
      safeItems:      [],
      fallback:       false,
      compassEnabled: true,
    },
  }),
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

describe('CompassPicksSection — place card standard', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows the neighborhood address line for a place pick — not just the name', async () => {
    const { getByTestId } = await render(
      <CompassPicksSection city="Paris" enabled />,
    );

    await waitFor(() => {
      const addressEl = getByTestId('compass-pick-address');
      // Should show the neighborhood, not be empty
      expect(addressEl.props.children).toBe('Le Marais');
    });
  });
});
