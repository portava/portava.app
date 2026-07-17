/**
 * Component-level tests for ReviewsSection — optimistic delete path.
 *
 * Kept in a separate file from the read/write tests to prevent cross-test
 * contamination (see ReviewsSection.place.component.test.tsx for context).
 *
 * Covers:
 *  • Tapping "Remove" fires deleteReview with the correct review ID
 *  • The review card disappears immediately (optimistic removal)
 *  • avgRating is cleared when the last review is deleted
 *  • "Write a Review" CTA re-appears after deletion
 *  • avgRating is recomputed from the remaining reviews (not the last review)
 *
 * Run with:  pnpm test:component
 *
 * useFocusEffect is mocked as a plain useEffect so the focus-callback fires on
 * mount and cleanup fires on unmount — identical semantics for this test suite.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
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

const PLACE_ID = 'place-delete-test';

// One review owned by the current user.
const ONE_REVIEW = {
  reviews: [
    {
      id:        'rev-1',
      rating:    5,
      body:      'Hidden gem, worth the detour!',
      tags:      ['great_host'],
      anonymous: false,
      reviewer:  { id: 'u-1', handle: 'alice', displayName: 'Alice', avatarUrl: null },
      createdAt: '2026-03-15T10:00:00Z',
      state:     'published',
    },
  ],
  total:     1,
  avgRating: 5.0,
  page:      1,
};

// Two reviews: user's (rev-1, rating 5) + another traveler's (rev-2, rating 3) → avg 4.0.
// After deleting rev-1: remaining = [rev-2, rating 3] → avg 3.0.
const TWO_REVIEWS = {
  reviews: [
    {
      id:        'rev-1',
      rating:    5,
      body:      'Hidden gem, worth the detour!',
      tags:      ['great_host'],
      anonymous: false,
      reviewer:  { id: 'u-1', handle: 'alice', displayName: 'Alice', avatarUrl: null },
      createdAt: '2026-03-15T10:00:00Z',
      state:     'published',
    },
    {
      id:        'rev-2',
      rating:    3,
      body:      'Decent but crowded.',
      tags:      [],
      anonymous: false,
      reviewer:  { id: 'u-2', handle: 'bob', displayName: 'Bob', avatarUrl: null },
      createdAt: '2026-03-16T11:00:00Z',
      state:     'published',
    },
  ],
  total:     2,
  avgRating: 4.0,
  page:      1,
};

// ── Helper ────────────────────────────────────────────────────────────────────

async function mountSection(
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

// Spy on Alert.alert and immediately invoke the "Delete" button's callback.
function interceptAlertDelete() {
  jest.spyOn(Alert, 'alert').mockImplementationOnce((_title, _msg, buttons) => {
    const btn = (buttons as Array<{ text: string; onPress?: () => void }>)
      .find((b) => b.text === 'Delete');
    btn?.onPress?.();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReviewsSection — optimistic delete', () => {
  let getPlaceReviews: jest.Mock;
  let getMyReview: jest.Mock;
  let deleteReview: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const reviews = require('../../services/reviews.ts');
    getPlaceReviews = reviews.getPlaceReviews;
    getMyReview     = reviews.getMyReview;
    deleteReview    = reviews.deleteReview;
  });

  it('fires deleteReview, removes the review card, clears avgRating, and re-shows Write a Review CTA', async () => {
    // One review in the list (the user's own); after deletion there are none left.
    getPlaceReviews.mockResolvedValue(ONE_REVIEW);
    getMyReview.mockResolvedValue({ exists: true, reviewId: 'rev-1', rating: 5 });
    deleteReview.mockResolvedValue(undefined);
    interceptAlertDelete();

    const { findByText, getByText, queryByText } = await mountSection();

    // Wait for both async effects to settle: useFocusEffect (reviews load) and
    // the getMyReview useEffect (alreadyReviewed). "Edit your review" only
    // appears once both have resolved, so it is the correct settled-state sentinel.
    await findByText(/Edit your review/);

    // Review card body is visible synchronously at this point.
    expect(getByText('Hidden gem, worth the detour!')).toBeTruthy();

    await fireEvent.press(getByText('Remove'));

    // deleteReview was called with the correct review ID.
    await waitFor(() => {
      expect(deleteReview).toHaveBeenCalledTimes(1);
      expect(deleteReview).toHaveBeenCalledWith('rev-1');
    });

    // Review card body is gone (optimistic removal).
    expect(queryByText('Hidden gem, worth the detour!')).toBeNull();

    // avgRating display is gone — no reviews remain so avg becomes null.
    expect(queryByText(/\d+\.\d+ \(\d+\)/)).toBeNull();

    // Write a Review CTA is visible again (alreadyReviewed → false).
    await findByText(/Write a Review/);
  });

  it('recomputes avgRating from remaining reviews when the deleted review is not the last one', async () => {
    // Two reviews → avg 4.0. After deleting the 5-star review, remaining = [3-star] → avg 3.0.
    getPlaceReviews.mockResolvedValue(TWO_REVIEWS);
    getMyReview.mockResolvedValue({ exists: true, reviewId: 'rev-1', rating: 5 });
    deleteReview.mockResolvedValue(undefined);
    interceptAlertDelete();

    const { findByText, getByText } = await mountSection();

    // Wait for settled state (both effects resolved).
    await findByText(/Edit your review/);

    // Initial aggregate: 4.0 (2 reviews).
    expect(getByText('4.0 (2)')).toBeTruthy();

    await fireEvent.press(getByText('Remove'));

    await waitFor(() => {
      expect(deleteReview).toHaveBeenCalledWith('rev-1');
    });

    // Aggregate recomputed from the remaining review: 3.0 (1).
    await findByText('3.0 (1)');
  });
});
