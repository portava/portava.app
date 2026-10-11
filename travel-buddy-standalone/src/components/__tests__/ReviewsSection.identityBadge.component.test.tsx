/**
 * ReviewsSection — a reviewer's identity badge (census-trust TV-2c). Drawn from
 * the server's `reviewer.identityBadge` only, never from anything else on the row.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { ReviewsSection } from '../ReviewsSection.tsx';

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

jest.mock('../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../context/SessionContext.tsx'),
  useSession: () => ({ isAuthed: true }),
}));

jest.mock('../../services/reviews.ts', () => ({
  ...jest.requireActual('../../services/reviews.ts'),
  getTripReviews:   jest.fn(),
  getPlaceReviews:  jest.fn(),
  getMyReview:      jest.fn(),
  getEventReviews:  jest.fn().mockResolvedValue({ reviews: [] }),
  deleteReview:     jest.fn(),
}));

const review = (id: string, name: string, identityBadge: unknown) => ({
  id, rating: 5, body: `by ${name}`, tags: [], anonymous: false, createdAt: '2026-09-01T00:00:00Z', state: 'published',
  reviewer: { id: `u-${id}`, handle: name.toLowerCase(), displayName: name, avatarUrl: null, identityBadge },
});

describe('ReviewsSection — reviewer identity badge (TV-2c)', () => {
  it('RB1. a verified reviewer shows the badge; one without (or the flag off → null) shows none', async () => {
    // MUTATION: drop <VerifiedBadge> from ReviewCard → RED.
    const reviews = require('../../services/reviews.ts');
    reviews.getMyReview.mockResolvedValue({ exists: false });
    reviews.getPlaceReviews.mockResolvedValue({
      reviews: [review('r1', 'Ana', { tier: 'id_selfie' }), review('r2', 'Ben', null)],
      total: 2, avgRating: 5, page: 1,
    });
    const ui = await render(<ReviewsSection entityType="place" entityId="p-1" entityName="Spot" canReview={false} />);
    await ui.findByText('by Ana');
    expect(ui.getAllByTestId('verified-badge-id_selfie')).toHaveLength(1);
    expect(ui.queryByTestId('verified-badge-id')).toBeNull();
  });
});
