/**
 * Component-level tests for ReviewsSection — place entity type.
 *
 * Kept in a separate file from the trip-entity tests so each file gets its
 * own jest module registry; the trip tests leave the useFocusEffect mock in
 * a state that would interfere with a second describe block in the same file.
 *
 * Covers:
 *  • getPlaceReviews is called (not getTripReviews) for entity type = 'place'
 *  • No avgRating shown when no reviews exist
 *  • "Write a Review" CTA shown when canReview=true and user hasn't reviewed
 *  • "Edit your review" CTA shown when user already has a review on file
 *  • avgRating refreshes after returning from the review composer (0→1 edge case)
 *
 * Delete path tests live in ReviewsSection.delete.component.test.tsx to
 * prevent cross-test contamination from the un-unmounted second render in
 * the "refreshes avgRating" test above.
 *
 * Run with:  pnpm test:component
 *
 * useFocusEffect is mocked as a plain useEffect so the focus-callback fires on
 * mount and cleanup fires on unmount — identical semantics for this test suite.
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { ReviewsSection } from '../ReviewsSection.tsx';

// ── expo-router mock ──────────────────────────────────────────────────────────

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn() },
    useFocusEffect: jest.fn((cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, []);
    }),
  };
});

// ── Session context mock ──────────────────────────────────────────────────────

jest.mock('../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../context/SessionContext.tsx'),
  useSession: () => ({ isAuthed: true }),
}));

// ── Reviews service mock ──────────────────────────────────────────────────────

jest.mock('../../services/reviews.ts', () => ({
  ...jest.requireActual('../../services/reviews.ts'),
  getTripReviews:   jest.fn(),
  getPlaceReviews:  jest.fn(),
  getMyReview:      jest.fn(),
  getEventReviews:  jest.fn().mockResolvedValue({ reviews: [] }),
  deleteReview:     jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLACE_ID = 'place-gem-xyz';

const PLACE_EMPTY_RESPONSE = { reviews: [], total: 0, avgRating: null, page: 1 };

const PLACE_FIRST_REVIEW_RESPONSE = {
  reviews: [
    {
      id:        'rev-place-1',
      rating:    5,
      body:      'Hidden gem, worth the detour!',
      tags:      ['great_host'],
      anonymous: false,
      reviewer:  { id: 'u-2', handle: 'bob', displayName: 'Bob', avatarUrl: null },
      createdAt: '2026-03-15T10:00:00Z',
      state:     'published',
    },
  ],
  total:     1,
  avgRating: 5.0,
  page:      1,
};

// ── Helper ────────────────────────────────────────────────────────────────────

async function mountPlaceSection(
  overrides?: Partial<React.ComponentProps<typeof ReviewsSection>>,
) {
  return render(
    <ReviewsSection
      entityType="place"
      entityId={PLACE_ID}
      entityName="Secret Waterfall"
      canReview={true}
      {...overrides}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReviewsSection — place entity (gem detail screen)', () => {
  let getPlaceReviews: jest.Mock;
  let getMyReview: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const reviews = require('../../services/reviews.ts');
    getPlaceReviews = reviews.getPlaceReviews;
    getMyReview     = reviews.getMyReview;
    getMyReview.mockResolvedValue({ exists: false });
  });

  it('calls getPlaceReviews (not getTripReviews) for place entity type', async () => {
    const reviews = require('../../services/reviews.ts');
    getPlaceReviews.mockResolvedValue(PLACE_EMPTY_RESPONSE);

    const { findByText } = await mountPlaceSection();
    await findByText(/No reviews yet/);

    expect(getPlaceReviews).toHaveBeenCalledTimes(1);
    expect(getPlaceReviews).toHaveBeenCalledWith(PLACE_ID, 1, 5);
    expect(reviews.getTripReviews).not.toHaveBeenCalled();
  });

  it('shows no rating display when the place has no reviews on first load', async () => {
    getPlaceReviews.mockResolvedValue(PLACE_EMPTY_RESPONSE);

    const { queryByText, findByText } = await mountPlaceSection();
    await findByText(/No reviews yet/);

    expect(queryByText(/\d+\.\d+ \(\d+\)/)).toBeNull();
  });

  it('shows Write a Review CTA when canReview=true and user has not yet reviewed', async () => {
    getPlaceReviews.mockResolvedValue(PLACE_EMPTY_RESPONSE);

    const { findByText } = await mountPlaceSection();
    await findByText(/No reviews yet/);

    const cta = await findByText(/Write a Review/);
    expect(cta).toBeTruthy();
  });

  it('shows Edit your review CTA when the user already has a review on file', async () => {
    getPlaceReviews.mockResolvedValue(PLACE_FIRST_REVIEW_RESPONSE);
    getMyReview.mockResolvedValue({ exists: true, reviewId: 'rev-place-1', rating: 5 });

    const { findByText } = await mountPlaceSection();

    const editCta = await findByText(/Edit your review/);
    expect(editCta).toBeTruthy();
  });

  it('refreshes avgRating after returning from the review composer (0→1 edge case)', async () => {
    getPlaceReviews
      .mockResolvedValueOnce(PLACE_EMPTY_RESPONSE)
      .mockResolvedValueOnce(PLACE_FIRST_REVIEW_RESPONSE);

    // ── First visit: no reviews yet ──────────────────────────────────────────
    const { queryByText, findByText, unmount } = await mountPlaceSection();
    await findByText(/No reviews yet/);
    expect(queryByText(/\d+\.\d+ \(\d+\)/)).toBeNull();
    expect(getPlaceReviews).toHaveBeenCalledTimes(1);

    // User navigates to the review composer then comes back
    await act(async () => { unmount(); });

    // ── User returns — useFocusEffect fires again via re-mount ────────────────
    const { findByText: findByText2 } = await mountPlaceSection();

    const ratingText = await findByText2('5.0 (1)');
    expect(ratingText).toBeTruthy();
    expect(getPlaceReviews).toHaveBeenCalledTimes(2);
  });
});
