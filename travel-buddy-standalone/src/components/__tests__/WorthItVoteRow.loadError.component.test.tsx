/**
 * WorthItVoteRow — unreadable tallies are not "0 · 0".
 * TM-social, TRUST-F13 (DV-83).
 *
 * A failed GET /places/:id/votes was swallowed and the row rendered its
 * initial zero counts with no vote of mine — a reader saw a place nobody had
 * voted on, and a tap "voted" from a baseline that was never read. The row now
 * says it could not load, offers a retry, and offers no vote buttons until the
 * tallies are real.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { WorthItVoteRow } from '../WorthItVoteRow.tsx';

jest.mock('../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../context/SessionContext.tsx'),
  useSession: () => ({ isAuthed: true }),
}));

jest.mock('../../services/reviews.ts', () => ({
  ...jest.requireActual('../../services/reviews.ts'),
  getPlaceVotes:  jest.fn(),
  castPlaceVote:  jest.fn(),
}));

const reviews = require('../../services/reviews.ts');

jest.setTimeout(20000);

describe('WorthItVoteRow — a failed tally read is an error, not zero votes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('HEALTHY TWIN: readable tallies render as vote buttons with counts', async () => {
    reviews.getPlaceVotes.mockResolvedValue({ worthItCount: 3, skipItCount: 1, myVote: null });
    const { findByLabelText, queryByText } = await render(<WorthItVoteRow entityId="p1" />);
    await findByLabelText('Worth it, 3 votes');
    expect(queryByText(/Couldn't load votes/)).toBeNull();
  });

  it('an unreadable tally says so and offers no vote buttons', async () => {
    reviews.getPlaceVotes.mockRejectedValue(new Error('Failed to load votes'));
    const { findByText, queryByLabelText } = await render(<WorthItVoteRow entityId="p1" entityType="gem" />);
    await findByText(/Couldn't load votes/);
    expect(queryByLabelText(/Worth it, \d+ votes/)).toBeNull();
    expect(queryByLabelText(/Skip it, \d+ votes/)).toBeNull();
    expect(reviews.castPlaceVote).not.toHaveBeenCalled();
  });

  it('retry re-reads, and real tallies replace the error', async () => {
    reviews.getPlaceVotes
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ worthItCount: 2, skipItCount: 0, myVote: 'worth_it' });
    const { findByText, findByLabelText, getByTestId } = await render(<WorthItVoteRow entityId="p1" />);
    await findByText(/Couldn't load votes/);
    await fireEvent.press(getByTestId('votes-retry'));
    await findByLabelText('Worth it, 2 votes');
    expect(reviews.getPlaceVotes).toHaveBeenCalledTimes(2);
  });
});
