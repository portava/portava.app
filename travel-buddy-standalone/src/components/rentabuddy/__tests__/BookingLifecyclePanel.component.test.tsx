/**
 * BookingLifecyclePanel — the booking can now actually move (testing mode,
 * lane tm-rab, WP-01; PLAT-F43, PLAT-F45).
 *
 *   L1  a buddy on an accepted booking gets Start, which calls startBooking and
 *       reloads only after the server says yes;
 *   L2  a refusal by a gate is its OWN state naming the gate and the unblock —
 *       not the generic "didn't go through" Alert;
 *   L3  the traveller confirms a buddy-completed session (travelerConfirmComplete);
 *   L4  the traveller sees the buddy's "suggest another time" in plain words and
 *       can accept it (respondToChangeRequest);
 *   L5  a failed read of the suggestions is an error with retry, never
 *       "No pending suggestions";
 *   L6  check-in posts the server's check-in type.
 *
 * Run: pnpm --dir travel-buddy-standalone test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentional stub — the panel never navigates except through the gate
// state's optional action; router is stubbed so nothing real mounts.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockStart = jest.fn();
const mockComplete = jest.fn();
const mockConfirm = jest.fn();
const mockCheckIn = jest.fn();
const mockSuggest = jest.fn();
const mockGetChanges = jest.fn();
const mockRespond = jest.fn();
jest.mock('../../../services/rentABuddy', () => ({
  ...jest.requireActual('../../../services/rentABuddy'),
  startBooking: (...a: unknown[]) => mockStart(...a),
  completeBooking: (...a: unknown[]) => mockComplete(...a),
  travelerConfirmComplete: (...a: unknown[]) => mockConfirm(...a),
  submitCheckIn: (...a: unknown[]) => mockCheckIn(...a),
  suggestChanges: (...a: unknown[]) => mockSuggest(...a),
  getBookingChangeRequests: (...a: unknown[]) => mockGetChanges(...a),
  respondToChangeRequest: (...a: unknown[]) => mockRespond(...a),
}));

import { BookingLifecyclePanel } from '../BookingLifecyclePanel.tsx';
import type { BuddyBooking } from '../../../services/rentABuddy.ts';

function booking(status: string): BuddyBooking {
  return {
    id: 'bk-1', buddyId: 'bp-1', travelerId: 'trav-1', packageId: null, tripId: null,
    bookingDate: '2026-10-10', startTime: '10:00', durationH: 2, groupSize: 1,
    city: 'Lisbon', category: 'city', notes: null, totalUsd: 60, status: status as BuddyBooking['status'],
    cancelledAt: null, confirmedAt: null, completedAt: null, createdAt: '', updatedAt: '',
    routePlan: [], telegraphThreadId: null,
  };
}

/** Press the Alert button with this text, as a person would. */
function pressAlertButton(text: string) {
  const call = (Alert.alert as jest.Mock).mock.calls.at(-1);
  const buttons = (call?.[2] ?? []) as Array<{ text: string; onPress?: () => void }>;
  const b = buttons.find((x) => x.text === text);
  if (!b) throw new Error(`no alert button "${text}" in ${JSON.stringify(call)}`);
  b.onPress?.();
}

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  [mockStart, mockComplete, mockConfirm, mockCheckIn, mockSuggest, mockGetChanges, mockRespond].forEach((m) => m.mockReset());
  mockGetChanges.mockResolvedValue({ ok: true, data: { bookingStatus: 'scheduled', changeRequests: [] } });
});

afterEach(() => { jest.restoreAllMocks(); });

describe('BookingLifecyclePanel', () => {
  it('L1 buddy starts an accepted booking; reload follows the server yes', async () => {
    mockStart.mockResolvedValue({ ok: true, data: { ok: true } });
    const onChanged = jest.fn();
    const { getByTestId } = await render(<BookingLifecyclePanel booking={booking('scheduled')} party="buddy" onChanged={onChanged} />);
    await fireEvent.press(getByTestId('lifecycle-start'));
    await act(async () => { pressAlertButton('Start session'); });
    await waitFor(() => expect(mockStart).toHaveBeenCalledWith('bk-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('L1 a traveller is never offered Start', async () => {
    const { queryByTestId } = await render(<BookingLifecyclePanel booking={booking('scheduled')} party="traveler" onChanged={jest.fn()} />);
    expect(queryByTestId('lifecycle-start')).toBeNull();
  });

  it('L2 a gate refusal is its own state naming the gate', async () => {
    mockStart.mockResolvedValue({ ok: false, error: 'feature_disabled', gate: 'rent_buddy_enabled' });
    const onChanged = jest.fn();
    const { getByTestId, findByTestId } = await render(<BookingLifecyclePanel booking={booking('scheduled')} party="buddy" onChanged={onChanged} />);
    await fireEvent.press(getByTestId('lifecycle-start'));
    await act(async () => { pressAlertButton('Start session'); });
    const gate = await findByTestId('lifecycle-gate-gate');
    expect(gate.props.children).toBe('rent_buddy_enabled');
    expect(getByTestId('lifecycle-gate-unblock').props.children).toMatch(/Admin → Feature flags/);
    expect(onChanged).not.toHaveBeenCalled();
    const titles = (Alert.alert as jest.Mock).mock.calls.map((c) => c[0]);
    expect(titles).not.toContain("That didn't go through");
  });

  it('L3 traveller confirms a buddy-completed session', async () => {
    mockConfirm.mockResolvedValue({ ok: true, data: { ok: true } });
    const onChanged = jest.fn();
    const { getByTestId } = await render(
      <BookingLifecyclePanel booking={booking('completed_pending_traveler_confirmation')} party="traveler" onChanged={onChanged} />,
    );
    await fireEvent.press(getByTestId('lifecycle-confirm'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledWith('bk-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('L3 the buddy sees they are waiting, and cannot confirm', async () => {
    const { getByTestId, queryByTestId } = await render(
      <BookingLifecyclePanel booking={booking('completed_pending_traveler_confirmation')} party="buddy" onChanged={jest.fn()} />,
    );
    expect(getByTestId('lifecycle-awaiting-traveler')).toBeTruthy();
    expect(queryByTestId('lifecycle-confirm')).toBeNull();
  });

  it('L4 traveller sees the suggestion in plain words and accepts it', async () => {
    mockGetChanges.mockResolvedValue({
      ok: true,
      data: {
        bookingStatus: 'requested',
        changeRequests: [{
          id: 'cr-1', changeField: 'start_time', currentValue: { start_time: '10:00' },
          proposedValue: { start_time: '14:00' }, reason: 'Morning is booked', status: 'pending',
          requestedByMe: false, responseNote: null, respondedAt: null, createdAt: '',
        }],
      },
    });
    mockRespond.mockResolvedValue({ ok: true, data: { ok: true, decision: 'accept', changeRequestId: 'cr-1' } });
    const { findByText, getByTestId } = await render(<BookingLifecyclePanel booking={booking('requested')} party="traveler" onChanged={jest.fn()} />);
    expect(await findByText('Start time: 10:00 → 14:00')).toBeTruthy();
    await fireEvent.press(getByTestId('change-accept-cr-1'));
    await waitFor(() => expect(mockRespond).toHaveBeenCalledWith('bk-1', 'cr-1', 'accept'));
  });

  it('L4 the side that suggested only waits', async () => {
    mockGetChanges.mockResolvedValue({
      ok: true,
      data: { bookingStatus: 'requested', changeRequests: [{
        id: 'cr-2', changeField: 'date', currentValue: { date: '2026-10-10' }, proposedValue: { date: '2026-10-11' },
        reason: null, status: 'pending', requestedByMe: true, responseNote: null, respondedAt: null, createdAt: '',
      }] },
    });
    const { findByText, queryByTestId } = await render(<BookingLifecyclePanel booking={booking('requested')} party="buddy" onChanged={jest.fn()} />);
    expect(await findByText(/waiting for the other side/)).toBeTruthy();
    expect(queryByTestId('change-accept-cr-2')).toBeNull();
  });

  it('L5 a failed suggestions read is an error with retry, never an empty list', async () => {
    mockGetChanges.mockResolvedValue({ ok: false, error: 'db_error' });
    const { findByTestId, queryByTestId } = await render(<BookingLifecyclePanel booking={booking('requested')} party="traveler" onChanged={jest.fn()} />);
    expect(await findByTestId('lifecycle-changes-error')).toBeTruthy();
    expect(queryByTestId('lifecycle-changes-empty')).toBeNull();
  });

  it('L6 check-in posts the server check-in type', async () => {
    mockCheckIn.mockResolvedValue({ ok: true, data: { checkin: { id: 'c1' } } });
    const { getByTestId } = await render(<BookingLifecyclePanel booking={booking('in_progress')} party="traveler" onChanged={jest.fn()} />);
    await fireEvent.press(getByTestId('lifecycle-checkin-arrival'));
    await waitFor(() => expect(mockCheckIn).toHaveBeenCalledWith('bk-1', 'arrival', 'Lisbon'));
  });
});
