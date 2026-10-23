/**
 * active.tsx — the emergency phrase's private prompt: each option is a full-height button.
 *
 * The options reused `modal.cancelBtn` — `flex: 1`, made to share a ROW's width with its neighbour. Stacked in the
 * content-sized sheet, `flex: 1` is a 0pt basis: Yoga (3.2.1, errata ALL, 440×956) drew each option 26pt tall (its
 * padding and border only) with the 22pt label overhanging into the next — sheet 190pt. Content-sized, each option is
 * 48pt and the sheet 256pt. The prompt is the traveller's private safety check, so its answers must be hittable.
 *
 * Jest computes no layout, so this pins the style that decides it, and that an option still answers the prompt.
 *
 * Run: pnpm --dir travel-buddy-standalone test:component
 */
import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { render, fireEvent, waitFor, screen } from '@testing-library/react-native';

// NOTE: intentional stub — only replace/push/back and the booking id param are read.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ bookingId: 'bk-1' }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('../../../src/hooks/useBottomInset', () => ({
  ...jest.requireActual('../../../src/hooks/useBottomInset'),
  useStickyBarInset: () => ({ inset: 100, onBarLayout: () => {} }),
}));

jest.mock('../../../src/services/safeReturn', () => ({
  ...jest.requireActual('../../../src/services/safeReturn'),
  getActiveSession: jest.fn().mockResolvedValue({ session: null }),
}));

const mockGet = jest.fn();
const mockPhrase = jest.fn();
const mockCheckIn = jest.fn();
jest.mock('../../../src/services/rentABuddy', () => ({
  ...jest.requireActual('../../../src/services/rentABuddy'),
  getBooking: (...a: unknown[]) => mockGet(...a),
  triggerEmergencyPhrase: (...a: unknown[]) => mockPhrase(...a),
  submitCheckIn: (...a: unknown[]) => mockCheckIn(...a),
}));

import RentABuddyActive from '../active';

const BOOKING = {
  id: 'bk-1', buddyId: 'bp', travelerId: 't', packageId: null, tripId: null, bookingDate: '2026-10-10',
  startTime: '10:00', durationH: 2, groupSize: 1, city: 'Lisbon', category: 'city', notes: null, totalUsd: 60,
  status: 'in_progress', cancelledAt: null, confirmedAt: null, completedAt: null, createdAt: '', updatedAt: '',
  routePlan: [], telegraphThreadId: null,
};

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  [mockGet, mockPhrase, mockCheckIn].forEach((m) => m.mockReset());
  mockGet.mockResolvedValue({ ok: true, data: { booking: BOOKING } });
});
afterEach(() => { jest.restoreAllMocks(); });

it('each phrase option sizes to its label (no flex: 1 in the stacked sheet) and still answers the prompt', async () => {
  mockPhrase.mockResolvedValue({ ok: true, data: {
    travelerOnly: true, prompt: 'Are you okay? Only you can see this message.',
    options: [{ id: 'ok', label: 'I am okay' }, { id: 'emergency', label: 'Use emergency button' }],
  } });
  mockCheckIn.mockResolvedValue({ ok: true, data: { checkin: { id: 'c1' } } });
  await render(<RentABuddyActive />);
  await fireEvent.press(await screen.findByTestId('active-emergency-phrase', {}, { timeout: 5000 }));
  await waitFor(() => expect(mockPhrase).toHaveBeenCalledWith('bk-1'));

  for (const id of ['ok', 'emergency']) {
    const style = StyleSheet.flatten(screen.getByTestId(`phrase-option-${id}`).props.style) ?? {};
    // `flex: 1` (or any positive flex / flexBasis 0) collapses a stacked option to its padding — 26pt.
    expect(style.flex).toBeUndefined();
    expect(style.flexBasis).toBeUndefined();
    expect(style.flexGrow ?? 0).toBe(0);
  }
  expect(screen.getByText('Use emergency button')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('phrase-option-ok'));
  await waitFor(() => expect(mockCheckIn).toHaveBeenCalledWith('bk-1', 'check_ok', 'Lisbon'));
});
