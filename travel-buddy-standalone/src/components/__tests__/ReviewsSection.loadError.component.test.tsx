/**
 * ReviewsSection — a failed reviews read is not "No reviews yet".
 * TM-social, TRUST-F13 (DV-83).
 *
 * The load swallowed every error ("silent — don't block the parent screen")
 * and then rendered its empty branch, so a place/trip whose reviews could not
 * be read told the reader it had none, and invited them to be the first.
 * The failure now has its own state with a retry; the healthy twin still
 * renders the reviews.
 *
 * useFocusEffect is mocked as a useEffect keyed on the callback, so a retry
 * (which changes the callback) re-runs the load exactly as a refocus would.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { ReviewsSection } from '../ReviewsSection.tsx';

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    ...jest.requireActual('expo-router'),
    router: { push: jest.fn() },
    useFocusEffect: (cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, [cb]);
    },
  };
});

jest.mock('../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../context/SessionContext.tsx'),
  useSession: () => ({ isAuthed: true, userId: 'me' }),
}));

jest.mock('../../services/reviews.ts', () => ({
  ...jest.requireActual('../../services/reviews.ts'),
  getTripReviews:  jest.fn(),
  getPlaceReviews: jest.fn(),
  getMyReview:     jest.fn().mockResolvedValue({ exists: false }),
  getEventReviews: jest.fn(),
  deleteReview:    jest.fn(),
}));

const reviews = require('../../services/reviews.ts');

const ONE = {
  reviews: [{
    id: 'r1', rating: 4, body: 'Lovely little bar', tags: [], anonymous: false,
    reviewer: { id: 'u2', handle: 'bea', displayName: 'Bea', avatarUrl: null },
    createdAt: '2026-05-01T10:00:00Z', state: 'published',
  }],
  total: 1, avgRating: 4, page: 1,
};

jest.setTimeout(20000);

describe('ReviewsSection — a failed read is an error, not an empty list', () => {
  beforeEach(() => { jest.clearAllMocks(); reviews.getMyReview.mockResolvedValue({ exists: false }); });

  it('HEALTHY TWIN: a readable list renders its reviews', async () => {
    reviews.getPlaceReviews.mockResolvedValue(ONE);
    const { findByText, queryByText } = await render(<ReviewsSection entityType="place" entityId="p1" canReview />);
    await findByText('Lovely little bar');
    expect(queryByText(/Couldn't load reviews/)).toBeNull();
  });

  it('place: an unreadable list says so, never "No reviews yet"', async () => {
    reviews.getPlaceReviews.mockRejectedValue(new Error('Failed to load place reviews'));
    const { findByText, queryByText } = await render(<ReviewsSection entityType="place" entityId="p1" canReview />);
    await findByText(/Couldn't load reviews/);
    expect(queryByText(/No reviews yet/)).toBeNull();
    expect(queryByText(/Be the first/)).toBeNull();
  });

  it('trip: the same rule', async () => {
    reviews.getTripReviews.mockRejectedValue(new Error('Failed to load trip reviews'));
    const { findByText, queryByText } = await render(<ReviewsSection entityType="trip" entityId="t1" />);
    await findByText(/Couldn't load reviews/);
    expect(queryByText(/No reviews yet/)).toBeNull();
  });

  it('retry re-reads, and a now-readable list renders', async () => {
    reviews.getPlaceReviews.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(ONE);
    const { findByText, getByTestId } = await render(<ReviewsSection entityType="place" entityId="p1" />);
    await findByText(/Couldn't load reviews/);
    await fireEvent.press(getByTestId('reviews-retry'));
    await findByText('Lovely little bar');
    await waitFor(() => expect(reviews.getPlaceReviews).toHaveBeenCalledTimes(2));
  });
});
