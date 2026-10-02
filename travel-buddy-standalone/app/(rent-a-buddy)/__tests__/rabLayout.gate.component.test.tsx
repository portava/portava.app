/**
 * (rent-a-buddy)/_layout — OFF is a named gate, UNREADABLE is an error
 * (testing mode, lane tm-rab).
 *
 * The layout showed the same COMING SOON screen when `rent_buddy_enabled` was
 * off and when the flags could not be read at all. Now:
 *   off      → the gate state names rent_buddy_enabled and says an admin turns
 *              it on in Admin → Feature flags;
 *   unknown  → an error with retry, and NO gate card (it is not "off");
 *   on       → the stack renders.
 *
 * Run: pnpm --dir travel-buddy-standalone test:component
 */
import React from 'react';
import { render } from '@testing-library/react-native';

// NOTE: intentional stub — only Stack (rendered when on) and router (Back) are read.
jest.mock('expo-router', () => ({
  Stack: () => { const { Text: T } = require('react-native'); return <T>STACK</T>; },
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let mockState: 'loading' | 'on' | 'off' | 'unknown' = 'on';
const mockRetry = jest.fn();
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  ...jest.requireActual('../../../src/hooks/useRentABuddyFlag'),
  useRentABuddyGate: () => ({ state: mockState, retry: mockRetry }),
}));

import RentABuddyLayout from '../_layout';

describe('(rent-a-buddy) layout gate', () => {
  it('off: names the gate and the unblock', async () => {
    mockState = 'off';
    const { getByTestId } = await render(<RentABuddyLayout />);
    expect(getByTestId('rab-layout-gate-gate').props.children).toBe('rent_buddy_enabled');
    expect(getByTestId('rab-layout-gate-unblock').props.children).toMatch(/Admin → Feature flags/);
  });

  it('unknown: an error with retry, not the off state', async () => {
    mockState = 'unknown';
    const { getByText, queryByTestId } = await render(<RentABuddyLayout />);
    expect(getByText("Couldn't check whether Rent a Buddy is on")).toBeTruthy();
    expect(getByText('Try again')).toBeTruthy();
    expect(queryByTestId('rab-layout-gate')).toBeNull();
  });

  it('on: the stack renders', async () => {
    mockState = 'on';
    const { getByText, queryByTestId } = await render(<RentABuddyLayout />);
    expect(getByText('STACK')).toBeTruthy();
    expect(queryByTestId('rab-layout-gate')).toBeNull();
  });
});

