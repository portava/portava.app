/**
 * Component tests for PassportQuickLinks — the passport-tab entry points into
 * the standalone Passport detail surfaces (spec §3/§28).
 *
 * Covers the load-bearing contract:
 *   1. Every entry renders (My World, Trust, Travel Identity, Journeys, Plans,
 *      Availability, Share).
 *   2. Each navigation entry pushes its REGISTERED route on press.
 *   3. The Share entry delegates to the `onShare` callback (it opens the QR
 *      sheet, whose data lives with the owner's passport hook — not a route
 *      push from this component).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { PassportQuickLinks } from '../PassportQuickLinks.tsx';
import { router } from 'expo-router';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — expo-router needs Expo native navigation
// modules unavailable in jest-expo; this stubs only the `router.push` this
// component uses so route pushes can be asserted.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

const mockPush = router.push as jest.Mock;

describe('PassportQuickLinks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders every passport detail-surface entry', async () => {
    await render(<PassportQuickLinks onShare={jest.fn()} />);

    expect(screen.getByText('My World')).toBeTruthy();
    expect(screen.getByText('Trust & Credentials')).toBeTruthy();
    expect(screen.getByText('Travel Identity')).toBeTruthy();
    expect(screen.getByText('Journeys')).toBeTruthy();
    expect(screen.getByText('Yearbook')).toBeTruthy();
    expect(screen.getByText('Plans')).toBeTruthy();
    expect(screen.getByText('Set availability')).toBeTruthy();
    expect(screen.getByText('Share passport')).toBeTruthy();
  });

  it.each([
    ['quicklink-my-world', '/passport/my-world'],
    ['quicklink-trust', '/passport/trust'],
    ['quicklink-travel-identity', '/passport/travel-identity'],
    ['quicklink-journeys', '/passport/journeys'],
    ['quicklink-yearbook', '/passport/yearbook'],
    ['quicklink-plans', '/passport/plans'],
    ['quicklink-availability', '/passport/availability'],
  ])('routes %s → %s', async (testID, route) => {
    await render(<PassportQuickLinks onShare={jest.fn()} />);

    fireEvent.press(screen.getByTestId(testID));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(route);
  });

  it('delegates Share to onShare (no route push)', async () => {
    const onShare = jest.fn();
    await render(<PassportQuickLinks onShare={onShare} />);

    fireEvent.press(screen.getByTestId('quicklink-share'));

    expect(onShare).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
