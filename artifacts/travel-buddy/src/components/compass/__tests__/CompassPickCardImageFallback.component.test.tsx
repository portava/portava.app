/**
 * CompassPickCard — image error fallback tests
 *
 * 1. Place-type item: onError → emoji/colour-strip fallback appears, Image gone.
 * 2. Non-place item (event type): onError → neither Image nor emoji fallback
 *    renders, confirming the blank-box case is at least not a crash — the card
 *    renders its text content without a hero area.
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await.
 */

import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';
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

// NOTE: intentionally exhaustive — useCompassFeed makes real API calls.
// `mockFeedItems` is mutated in beforeEach so each test can supply its own
// fixture without re-registering the mock.
let mockFeedItems: any[] = [];
jest.mock('../../../hooks/compass/useCompassFeed.ts', () => ({
  useCompassFeed: () => ({
    loading:        false,
    compassEnabled: true,
    data: {
      sections:       [{ items: mockFeedItems }],
      safeItems:      [],
      fallback:       false,
      compassEnabled: true,
    },
  }),
}));

// NOTE: intentionally exhaustive — resolveCompassImageUrl must return the
// broken URL so the Image element is initially rendered; only then can
// onError fire and flip the state.
jest.mock('../../../utils/compassFormat.ts', () => ({
  resolveCompassTitle:    (_item: any) => _item?.title ?? 'Card',
  formatCompassSubtitle:  () => null,
  formatCompassContext:   () => 'Because it matched your taste',
  resolveCompassCategory: () => '',
  resolveCompassImageUrl: (item: any) =>
    (item?.data?.imageUrl as string | undefined) ?? null,
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

describe('CompassPickCard — image error fallback', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows the emoji fallback and hides the Image after onError fires (place item)', async () => {
    mockFeedItems = [{
      id:       'place-img-1',
      type:     'place',
      category: 'food',
      title:    'Broken Image Bistro',
      data: {
        imageUrl:     'https://broken.example.com/no-such-image.jpg',
        neighborhood: 'Old Town',
        city:         'Testville',
      },
      recommendationToken: 'tok-img-1',
    }];

    const { getByTestId, queryByTestId } = await render(
      <CompassPicksSection city="Testville" enabled />,
    );

    // Image must be present before the error fires
    await waitFor(() => {
      expect(getByTestId('compass-pick-image-place-img-1')).toBeTruthy();
    });

    // Simulate a broken image URL
    fireEvent(getByTestId('compass-pick-image-place-img-1'), 'error');

    // After the error the Image must be gone and the emoji fallback must appear
    await waitFor(() => {
      expect(queryByTestId('compass-pick-image-place-img-1')).toBeNull();
      expect(getByTestId('compass-pick-emoji-place-img-1')).toBeTruthy();
    });
  });

  it('shows the generic icon fallback (not a blank gap) after onError fires on a non-place item (event type)', async () => {
    // An event item with a broken imageUrl. After onError the ternary should
    // now reach the new GenericHeroFallback branch — a type-keyed icon strip —
    // rather than null. The card must not crash and must still render its title.
    mockFeedItems = [{
      id:       'event-img-1',
      type:     'event',
      category: '',
      title:    'Broken Image Concert',
      data: {
        imageUrl: 'https://broken.example.com/no-such-event.jpg',
        city:     'Testville',
      },
      recommendationToken: 'tok-event-1',
    }];

    const { getByTestId, queryByTestId, getByText } = await render(
      <CompassPicksSection city="Testville" enabled />,
    );

    // Image must be present before the error fires (imageError starts as false)
    await waitFor(() => {
      expect(getByTestId('compass-pick-image-event-img-1')).toBeTruthy();
    });

    // Simulate the image load error
    fireEvent(getByTestId('compass-pick-image-event-img-1'), 'error');

    // After the error: Image gone, place emoji strip absent, but the generic
    // fallback hero (icon on tinted background) must be present — no blank gap.
    await waitFor(() => {
      expect(queryByTestId('compass-pick-image-event-img-1')).toBeNull();
      expect(queryByTestId('compass-pick-emoji-event-img-1')).toBeNull();
      expect(getByTestId('compass-pick-generic-fallback-event-img-1')).toBeTruthy();
      // The card body still renders — title must remain visible
      expect(getByText('Broken Image Concert')).toBeTruthy();
    });
  });
});
