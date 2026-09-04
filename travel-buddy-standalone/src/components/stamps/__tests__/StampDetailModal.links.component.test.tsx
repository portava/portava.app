/**
 * StampDetailModal — §13 "Stamp detail can link to Journey and My World".
 *
 *   1. Every viewer gets a "View Journey" link; it routes to the journeys
 *      surface focused on the stamp's trip. For a VIEWER (not owner) it carries
 *      the stamp owner's @handle so the endpoint resolves the right traveler;
 *      the owner opens their own (no id).
 *   2. My World is the OWNER's personal geographic history (§26, no viewer
 *      variant), so it is offered only to the owner.
 *   3. Following a link closes the sheet first, then navigates.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));

// Heavy children reach media capture / the API — stub to inert nodes; the link
// wiring under test does not depend on them.
jest.mock('../StampAdmireBlock.tsx', () => ({ StampAdmireBlock: () => null }));
jest.mock('../../StampArtwork.tsx', () => ({ StampArtwork: () => null }));
jest.mock('../../StampShareCard.tsx', () => ({ StampShareCard: () => null }));
jest.mock('../../../hooks/useStampShare.ts', () => ({
  useStampShare: () => ({ cardRef: { current: null }, share: jest.fn(), sharing: false, error: null, onArtworkSettled: jest.fn() }),
}));

import { StampDetailModal } from '../StampDetailModal.tsx';
import type { PassportStampNew } from '../../../services/passportStamps.ts';

function stamp(over: Partial<PassportStampNew> = {}): PassportStampNew {
  return {
    id: 'us-1', stampDefinitionId: null, definition: null, stampType: 'city',
    country: 'Vietnam', city: 'Da Nang', neighborhood: null, titleOverride: 'Da Nang',
    placeId: null, planId: null, tripId: 'trip-7', sourceType: 'trip',
    verificationLevel: 'verified', visibility: 'private', displayOnPassport: true,
    isRevoked: false, earnedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
    catalogId: null, activeArtworkUrl: null, thumbnailUrl: null,
    ...over,
  } as PassportStampNew;
}

beforeEach(() => mockPush.mockClear());
afterEach(() => cleanup());

it('viewer: View Journey carries the owner handle; My World is not offered', async () => {
  await render(<StampDetailModal stamp={stamp()} isOwner={false} visible onClose={jest.fn()} username="mai" />);

  fireEvent.press(await screen.findByTestId('stamp-open-journey'));
  expect(mockPush).toHaveBeenCalledWith('/passport/journeys?userId=mai&tripId=trip-7');
  expect(screen.queryByTestId('stamp-open-my-world')).toBeNull();
});

it('a stamp with no trip still links to Journeys (no tripId param)', async () => {
  await render(<StampDetailModal stamp={stamp({ tripId: null })} isOwner visible onClose={jest.fn()} username="me" />);
  fireEvent.press(await screen.findByTestId('stamp-open-journey'));
  expect(mockPush).toHaveBeenCalledWith('/passport/journeys');
});

// Owner render mounts the owner-only visibility Switch; kept LAST because that
// subtree leaves a passive effect that corrupts a following render in the
// jest-expo/React-19 worker (same class as the fake-timer ordering rule).
it('owner: View Journey opens own journeys focused on the trip; My World is offered', async () => {
  const onClose = jest.fn();
  await render(<StampDetailModal stamp={stamp()} isOwner visible onClose={onClose} username="me" />);

  fireEvent.press(await screen.findByTestId('stamp-open-journey'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/passport/journeys?tripId=trip-7');

  expect(screen.getByTestId('stamp-open-my-world')).toBeTruthy();
  fireEvent.press(screen.getByTestId('stamp-open-my-world'));
  expect(mockPush).toHaveBeenLastCalledWith('/passport/my-world');
});
