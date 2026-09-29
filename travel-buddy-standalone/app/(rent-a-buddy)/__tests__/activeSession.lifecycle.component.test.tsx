/**
 * active.tsx — the traveller's live session (testing mode, lane tm-rab, PLAT-F45).
 *
 *   E1  "End session" COMPLETES the booking (completeBooking) and only then
 *       goes to the review — it used to navigate without any server write, so
 *       the booking stayed in_progress and the review route refused;
 *   E2  a gate refusal leaves the traveller on the session with the gate card
 *       (which gate, what unblocks it), and does not navigate;
 *   E3  the emergency phrase opens its private prompt, and "I am okay"
 *       records a check_ok check-in;
 *   E4  "I've arrived" posts an arrival check-in.
 *
 * Run: pnpm --dir travel-buddy-standalone test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — only replace/push/back and the booking id param are read.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ bookingId: 'bk-1' }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
const mockComplete = jest.fn();
const mockPhrase = jest.fn();
const mockCheckIn = jest.fn();
jest.mock('../../../src/services/rentABuddy', () => ({
  ...jest.requireActual('../../../src/services/rentABuddy'),
  getBooking: (...a: unknown[]) => mockGet(...a),
  completeBooking: (...a: unknown[]) => mockComplete(...a),
  triggerEmergencyPhrase: (...a: unknown[]) => mockPhrase(...a),
  submitCheckIn: (...a: unknown[]) => mockCheckIn(...a),
}));

import { router } from 'expo-router';
import RentABuddyActive from '../active';

const BOOKING = {
  id: 'bk-1', buddyId: 'bp', travelerId: 't', packageId: null, tripId: null, bookingDate: '2026-10-10',
  startTime: '10:00', durationH: 2, groupSize: 1, city: 'Lisbon', category: 'city', notes: null, totalUsd: 60,
  status: 'in_progress', cancelledAt: null, confirmedAt: null, completedAt: null, createdAt: '', updatedAt: '',
  routePlan: [], telegraphThreadId: null,
};

async function pressEnd(getAllByText: (t: string) => unknown[]) {
  const first = getAllByText('End session');
  await fireEvent.press(first[first.length - 1] as never);
  await waitFor(() => expect(getAllByText('End session').length).toBeGreaterThan(1));
  const all = getAllByText('End session');
  await fireEvent.press(all[all.length - 1] as never);
}

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  [mockGet, mockComplete, mockPhrase, mockCheckIn].forEach((m) => m.mockReset());
  (router.replace as jest.Mock).mockClear();
  mockGet.mockResolvedValue({ ok: true, data: { booking: BOOKING } });
});
afterEach(() => { jest.restoreAllMocks(); });

describe('active session', () => {
  it('E1 End session completes the booking, then opens the review', async () => {
    mockComplete.mockResolvedValue({ ok: true, data: { ok: true } });
    const { findAllByText, getAllByText } = await render(<RentABuddyActive />);
    await findAllByText('End session', {}, { timeout: 5000 });
    await pressEnd(getAllByText);
    await waitFor(() => expect(mockComplete).toHaveBeenCalledWith('bk-1'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(
      expect.objectContaining({ params: { bookingId: 'bk-1' } }),
    ));
  });

  it('E2 a gate refusal shows the gate card and does not navigate', async () => {
    mockComplete.mockResolvedValue({ ok: false, error: 'feature_disabled', gate: 'rent_buddy_enabled' });
    const { findAllByText, getAllByText, findByTestId } = await render(<RentABuddyActive />);
    await findAllByText('End session', {}, { timeout: 5000 });
    await pressEnd(getAllByText);
    expect((await findByTestId('active-gate-gate', {}, { timeout: 5000 })).props.children).toBe('rent_buddy_enabled');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('E3 the emergency phrase opens its private prompt; "I am okay" records check_ok', async () => {
    mockPhrase.mockResolvedValue({ ok: true, data: {
      travelerOnly: true, prompt: 'Are you okay? Only you can see this message.',
      options: [{ id: 'ok', label: 'I am okay' }, { id: 'emergency', label: 'Use emergency button' }],
    } });
    mockCheckIn.mockResolvedValue({ ok: true, data: { checkin: { id: 'c1' } } });
    const { findByTestId, getByText } = await render(<RentABuddyActive />);
    await fireEvent.press(await findByTestId('active-emergency-phrase', {}, { timeout: 5000 }));
    await waitFor(() => expect(mockPhrase).toHaveBeenCalledWith('bk-1'));
    expect(getByText('Are you okay? Only you can see this message.')).toBeTruthy();
    await fireEvent.press(await findByTestId('phrase-option-ok'));
    await waitFor(() => expect(mockCheckIn).toHaveBeenCalledWith('bk-1', 'check_ok', 'Lisbon'));
  });

  it("E4 I've arrived posts an arrival check-in", async () => {
    mockCheckIn.mockResolvedValue({ ok: true, data: { checkin: { id: 'c1' } } });
    const { findByTestId } = await render(<RentABuddyActive />);
    await fireEvent.press(await findByTestId('active-checkin-arrival', {}, { timeout: 5000 }));
    await waitFor(() => expect(mockCheckIn).toHaveBeenCalledWith('bk-1', 'arrival', 'Lisbon'));
  });
});
