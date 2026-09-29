/**
 * HostReviewsSummary — an unreadable host-review list is not "no reviews".
 * TM-social, TRUST-F13 (DV-83).
 *
 * The profile's host-reviews block swallowed a failed GET /users/:id/reviews
 * and rendered nothing — the same thing it renders for a host with no reviews
 * — so an outage read as "this host has never been reviewed". The failure now
 * shows a retry; a real zero still renders nothing (the healthy twin).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { HostReviewsSummary } from '../HostReviewsSummary.tsx';

jest.mock('../../../services/reviews.ts', () => ({
  ...jest.requireActual('../../../services/reviews.ts'),
  getUserReviews: jest.fn(),
}));

const reviews = require('../../../services/reviews.ts');

const TWO = {
  avgRating: 4.5, reviewCount: 2,
  reviews: [
    { id: 'r1', rating: 5, body: 'Great host', anonymous: false, reviewer: { id: 'a', handle: 'ann', displayName: null, avatarUrl: null }, createdAt: '2026-05-01T00:00:00Z' },
    { id: 'r2', rating: 4, body: 'Well organised', anonymous: false, reviewer: { id: 'b', handle: 'ben', displayName: null, avatarUrl: null }, createdAt: '2026-05-02T00:00:00Z' },
  ],
};

jest.setTimeout(20000);

describe('HostReviewsSummary — failure is not "no reviews"', () => {
  beforeEach(() => jest.clearAllMocks());

  it('HEALTHY TWIN: readable reviews render with the aggregate', async () => {
    reviews.getUserReviews.mockResolvedValue(TWO);
    const { findByText } = await render(<HostReviewsSummary userId="host-1" />);
    await findByText('Great host');
    await findByText('4.5 (2)');
  });

  it('HEALTHY TWIN: a host with zero reviews renders nothing', async () => {
    reviews.getUserReviews.mockResolvedValue({ avgRating: null, reviewCount: 0, reviews: [] });
    const { queryByText, toJSON } = await render(<HostReviewsSummary userId="host-1" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(queryByText(/Host Reviews/)).toBeNull();
    expect(toJSON()).toBeNull();
  });

  it('an unreadable list says so, with a retry that re-reads', async () => {
    reviews.getUserReviews.mockRejectedValueOnce(new Error('Failed to load user reviews')).mockResolvedValueOnce(TWO);
    const { findByText, getByTestId } = await render(<HostReviewsSummary userId="host-1" />);
    await findByText(/Couldn't load host reviews/);
    await fireEvent.press(getByTestId('host-reviews-retry'));
    await findByText('Great host');
    expect(reviews.getUserReviews).toHaveBeenCalledTimes(2);
  });
});
