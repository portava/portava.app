/**
 * Component-level test for ReviewsSection — confirms the focus-refetch
 * behaviour: when the user navigates back to a trip detail screen after
 * writing their first review in the composer, useFocusEffect fires again and
 * the component re-fetches, displaying the updated avgRating.
 *
 * Run with:  pnpm test:component
 *
 * Re-focus is simulated by unmounting then re-mounting the component, which
 * mirrors the real navigation lifecycle: mount = focus, unmount = blur,
 * re-mount = focus again.
 *
 * RNTL v14: render() wraps in act() internally and returns a Promise-like
 * value — always await the async mount helper.
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { ReviewsSection } from '../ReviewsSection.tsx';

// ── expo-router mock ──────────────────────────────────────────────────────────
// Replace useFocusEffect with a plain useEffect so the callback fires on mount
// and cleans up on unmount — identical semantics for testing navigation.
// Using React.useEffect inside the mock respects React's commit-phase timing
// and avoids overlapping act() calls.

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
  useSession: () => ({ isAuthed: true }),
}));

// ── Reviews service mock ──────────────────────────────────────────────────────

jest.mock('../../services/reviews.ts', () => ({
  getTripReviews:  jest.fn(),
  getMyReview:     jest.fn(),
  getEventReviews: jest.fn().mockResolvedValue({ reviews: [] }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRIP_ID = 'trip-test-abc';

const EMPTY_RESPONSE = { reviews: [], total: 0, avgRating: null, page: 1 };

const FIRST_REVIEW_RESPONSE = {
  reviews: [
    {
      id:        'rev-1',
      rating:    4,
      body:      'Great trip',
      tags:      [],
      anonymous: false,
      reviewer:  { id: 'u-1', handle: 'alice', displayName: 'Alice', avatarUrl: null },
      createdAt: '2026-01-01T00:00:00Z',
      state:     'published',
    },
  ],
  total:     1,
  avgRating: 4.0,
  page:      1,
};

// ── Helper ────────────────────────────────────────────────────────────────────

// Async so the return value of render() (which RNTL v14 wraps in act())
// is properly unwrapped before callers destructure the query helpers.
async function mountSection(
  overrides?: Partial<React.ComponentProps<typeof ReviewsSection>>,
) {
  return render(
    <ReviewsSection
      entityType="trip"
      entityId={TRIP_ID}
      entityName="Test Trip"
      canReview={true}
      {...overrides}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReviewsSection — avgRating focus-refetch lifecycle', () => {
  let getTripReviews: jest.Mock;
  let getMyReview: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const reviews = require('../../services/reviews.ts');
    getTripReviews = reviews.getTripReviews;
    getMyReview    = reviews.getMyReview;
    // Default: user has not yet reviewed
    getMyReview.mockResolvedValue({ exists: false });
  });

  it('shows no rating display when the trip has no reviews on first load', async () => {
    getTripReviews.mockResolvedValue(EMPTY_RESPONSE);

    const { queryByText, findByText } = await mountSection();

    // Wait for the async load to finish — empty state shows this text
    await findByText(/No reviews yet/);

    expect(queryByText(/\d+\.\d+ \(\d+\)/)).toBeNull();
    expect(getTripReviews).toHaveBeenCalledTimes(1);
    expect(getTripReviews).toHaveBeenCalledWith(TRIP_ID, 1, 5);
  });

  it('displays updated avgRating after returning from review composer (0→1 edge case)', async () => {
    // First focus (mount): no reviews exist yet
    getTripReviews.mockResolvedValueOnce(EMPTY_RESPONSE);
    // Second focus (re-mount): user submitted their first review in the composer
    getTripReviews.mockResolvedValueOnce(FIRST_REVIEW_RESPONSE);

    // ── First screen visit ────────────────────────────────────────────────────
    const { queryByText, findByText, unmount } = await mountSection();
    await findByText(/No reviews yet/);

    expect(queryByText(/\d+\.\d+ \(\d+\)/)).toBeNull();
    expect(getTripReviews).toHaveBeenCalledTimes(1);

    // Simulate user navigating away to write a review
    unmount();

    // ── User returns (re-mount → useFocusEffect fires again) ─────────────────
    const { findByText: findByText2 } = await mountSection();

    // Component should now show the freshly fetched avgRating
    const ratingText = await findByText2('4.0 (1)');
    expect(ratingText).toBeTruthy();
    expect(getTripReviews).toHaveBeenCalledTimes(2);
  });
});
