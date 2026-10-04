/**
 * PassportHighlightsStrip — the owner's own Highlights, when the read failed.
 *
 * WHAT WAS WRONG (lane highlights, 2026-10-03). `useHighlightRingState`
 * reports a failed read as `unreadable` precisely so no surface claims "no
 * Highlights" from it. The owner's Passport ignored that: it passed `[]` to
 * this strip, which drew its empty-state invitation — "Share travel moments as
 * highlights" — over Highlights the owner may well have posted a minute ago.
 * A tester who has just posted one, on a flaky connection, is told it is not
 * there.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — DisplayMediaImage hydrates private-bucket
// media over the network.
jest.mock('../../ui/DisplayMediaImage.tsx', () => ({ DisplayMediaImage: () => null }));

import { PassportHighlightsStrip } from '../PassportHighlightsStrip.tsx';

const EMPTY_HINT = /Share travel moments as highlights/;

it('an unreadable read is said, with a retry — not the empty invitation', async () => {
  const onRetry = jest.fn();
  await render(
    <PassportHighlightsStrip highlights={[]} hasActive={false} allViewed={false} isOwner unreadable onRetry={onRetry} />,
  );
  expect(screen.getByTestId('passport-highlights-unreadable')).toBeTruthy();
  expect(screen.queryByText(EMPTY_HINT)).toBeNull();
  fireEvent.press(screen.getByTestId('passport-highlights-retry'));
  expect(onRetry).toHaveBeenCalledTimes(1);
  // The owner can still post: the add bubble stays.
  expect(screen.getByLabelText('Add highlight')).toBeTruthy();
});

it('a real empty list still invites the owner to post one', async () => {
  await render(<PassportHighlightsStrip highlights={[]} hasActive={false} allViewed={false} isOwner />);
  expect(screen.getByText(EMPTY_HINT)).toBeTruthy();
  expect(screen.queryByTestId('passport-highlights-unreadable')).toBeNull();
});
