/**
 * Rent-a-Buddy admin payouts queue (payments PAY-T21).
 *
 *   P1  the screen says, before anything else, that no real money moves;
 *   P2  a failed read is an error with retry, never an empty queue;
 *   P3  "admin only" is its own state;
 *   P4  a hold cannot be sent without a reason: the confirm button is disabled
 *       until one is typed, and the reason typed is the reason sent;
 *   P5  a held payout offers Release, a released one offers nothing;
 *   P6  a refused or failed transition is reported and the list is re-read —
 *       it is never shown as done;
 *   P7  a state tab reads that state from the server.
 *
 * The server half — the transition and its audit row committing together or
 * not at all — is artifacts/api-server/src/test/rentBuddyMoneyAtomicity.test.ts
 * and src/test/db/rentBuddyLedgerPosting.db.test.ts (P1–P4 there).
 *
 * Run: pnpm --dir travel-buddy-standalone test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — navigation is not under test.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — the role redirect is covered by useRequireAdmin's own tests.
jest.mock('../../../src/hooks/useRequireAdmin', () => ({ useRequireAdmin: () => false }));

const mockList = jest.fn();
const mockHold = jest.fn();
const mockRelease = jest.fn();
jest.mock('../../../src/services/rentABuddyAdmin', () => ({
  ...jest.requireActual('../../../src/services/rentABuddyAdmin'),
  listAdminPayouts: (...a: unknown[]) => mockList(...a),
  holdPayout: (...a: unknown[]) => mockHold(...a),
  releasePayout: (...a: unknown[]) => mockRelease(...a),
}));

import AdminPayouts from '../admin/payouts';

const base = {
  booking_id: 'bk-11111111-aaaa', buddy_id: 'bp-22222222-bbbb', hold_reason: null, held_by: null, held_at: null,
  released_by: null, released_at: null, notes: null, created_at: '2026-10-01T10:00:00Z', updated_at: null,
};
const PENDING = { ...base, id: 'po-pending', amount_usd: 120, status: 'pending' };
const HELD = { ...base, id: 'po-held', amount_usd: '45.50', status: 'on_hold', hold_reason: 'chargeback risk', held_by: 'admin-1', held_at: '2026-10-02T10:00:00Z' };
const RELEASED = { ...base, id: 'po-released', amount_usd: 30, status: 'released', notes: 'cleared', released_by: 'admin-1', released_at: '2026-10-03T10:00:00Z' };

const ok = (payouts: unknown[]) => ({ ok: true, data: { payouts, total: payouts.length } });

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  [mockList, mockHold, mockRelease].forEach((m) => m.mockReset());
});
afterEach(() => { jest.restoreAllMocks(); });

describe('payouts queue', () => {
  it('P1 says that no real money moves, above the list', async () => {
    mockList.mockResolvedValue(ok([PENDING]));
    const { findByTestId, getByTestId, getByText } = await render(<AdminPayouts />);
    expect(await findByTestId('payout-po-pending', {}, { timeout: 5000 })).toBeTruthy();
    expect(getByTestId('payouts-no-money-notice')).toBeTruthy();
    expect(getByText(/no real money moves/i)).toBeTruthy();
    expect(getByText(/Nothing is paid to anyone/)).toBeTruthy();
  });

  it('P1 says it when the queue is empty too', async () => {
    mockList.mockResolvedValue(ok([]));
    const { findByText, getByText } = await render(<AdminPayouts />);
    expect(await findByText('No payouts yet', {}, { timeout: 5000 })).toBeTruthy();
    expect(getByText(/no real money moves/i)).toBeTruthy();
  });

  it('P2 a failed read is an error with retry, never the empty state', async () => {
    mockList.mockResolvedValue({ ok: false, error: 'boom' });
    const { findByText, queryByText } = await render(<AdminPayouts />);
    expect(await findByText("Couldn't load this list", {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByText('No payouts yet')).toBeNull();
    expect(queryByText('No payouts in this state')).toBeNull();

    mockList.mockResolvedValue(ok([PENDING]));
    await fireEvent.press(await findByText('Try again'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('P3 admin only is its own state', async () => {
    mockList.mockResolvedValue({ ok: false, error: 'forbidden' });
    const { findByText } = await render(<AdminPayouts />);
    expect(await findByText('Admin only', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('P4 a hold needs a reason: nothing is sent until one is typed, and the typed reason is what is sent', async () => {
    mockList.mockResolvedValue(ok([PENDING]));
    mockHold.mockResolvedValue({ ok: true });
    const { findByTestId, getByTestId } = await render(<AdminPayouts />);

    await fireEvent.press(await findByTestId('payout-hold-po-pending', {}, { timeout: 5000 }));
    const confirm = await findByTestId('payout-reason-confirm');
    expect(confirm.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(confirm);
    expect(mockHold).not.toHaveBeenCalled();

    // Whitespace is not a reason.
    await fireEvent.changeText(getByTestId('payout-reason-input'), '    ');
    expect(getByTestId('payout-reason-confirm').props.accessibilityState?.disabled).toBe(true);

    await fireEvent.changeText(getByTestId('payout-reason-input'), '  fraud signal on the booking  ');
    expect(getByTestId('payout-reason-confirm').props.accessibilityState?.disabled).toBe(false);
    await fireEvent.press(getByTestId('payout-reason-confirm'));

    await waitFor(() => expect(mockHold).toHaveBeenCalledWith('po-pending', 'fraud signal on the booking'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(alertSpy).toHaveBeenCalledWith('Payout held', expect.stringMatching(/No money moved/));
    expect(mockRelease).not.toHaveBeenCalled();
  });

  // paid → on_hold → released would "release" money that had already left. The
  // server refuses the hold (409); the screen does not offer it.
  it('P8 only a PENDING payout offers Hold: a paid, failed or cancelled one offers no action', async () => {
    const PAID = { ...base, id: 'po-paid', amount_usd: 80, status: 'paid' };
    const FAILED = { ...base, id: 'po-failed', amount_usd: 15, status: 'failed' };
    const CANCELLED = { ...base, id: 'po-cancelled', amount_usd: 9, status: 'cancelled' };
    mockList.mockResolvedValue(ok([PENDING, PAID, FAILED, CANCELLED]));
    const { findByTestId, getByTestId, queryByTestId } = await render(<AdminPayouts />);

    expect(await findByTestId('payout-hold-po-pending', {}, { timeout: 5000 })).toBeTruthy();
    for (const id of ['po-paid', 'po-failed', 'po-cancelled']) {
      expect(getByTestId(`payout-${id}`)).toBeTruthy();
      expect(queryByTestId(`payout-hold-${id}`)).toBeNull();
      expect(queryByTestId(`payout-release-${id}`)).toBeNull();
      expect(getByTestId(`payout-${id}-no-action`).props.children).toBe('No action here: only a pending payout can be held, and only a held one released.');
    }
    expect(mockHold).not.toHaveBeenCalled();
  });

  it('P5 a held payout offers Release (with its reason); a released one offers no action', async () => {
    mockList.mockResolvedValue(ok([HELD, RELEASED]));
    mockRelease.mockResolvedValue({ ok: true });
    const { findByTestId, getByTestId, queryByTestId, getByText } = await render(<AdminPayouts />);

    expect(await findByTestId('payout-release-po-held', {}, { timeout: 5000 })).toBeTruthy();
    expect(queryByTestId('payout-hold-po-held')).toBeNull();
    expect(queryByTestId('payout-hold-po-released')).toBeNull();
    expect(queryByTestId('payout-release-po-released')).toBeNull();
    expect(getByText(/a released payout cannot be held or released again/)).toBeTruthy();
    expect(getByText('$45.50')).toBeTruthy();
    expect(getByText(/chargeback risk/)).toBeTruthy();
    expect(getByText(/no money sent/)).toBeTruthy();

    await fireEvent.press(getByTestId('payout-release-po-held'));
    expect(getByText(/status change only — no money is sent to anyone/)).toBeTruthy();
    await fireEvent.changeText(await findByTestId('payout-reason-input'), 'identity re-checked');
    await fireEvent.press(getByTestId('payout-reason-confirm'));
    await waitFor(() => expect(mockRelease).toHaveBeenCalledWith('po-held', 'identity re-checked'));
    expect(mockHold).not.toHaveBeenCalled();
  });

  it('P6 a refused transition is reported, never shown as done — and the list is re-read', async () => {
    mockList.mockResolvedValue(ok([HELD]));
    mockRelease.mockResolvedValue({ ok: false, error: 'Payout is released; this transition requires on_hold.' });
    const { findByTestId, getByTestId } = await render(<AdminPayouts />);

    await fireEvent.press(await findByTestId('payout-release-po-held', {}, { timeout: 5000 }));
    await fireEvent.changeText(await findByTestId('payout-reason-input'), 'cleared');
    await fireEvent.press(getByTestId('payout-reason-confirm'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("The payout wasn't released", expect.any(String)));
    expect(alertSpy).not.toHaveBeenCalledWith('Payout marked released', expect.anything());
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('P6 cancelling the reason sheet sends nothing', async () => {
    mockList.mockResolvedValue(ok([PENDING]));
    const { findByTestId, getByTestId } = await render(<AdminPayouts />);
    await fireEvent.press(await findByTestId('payout-hold-po-pending', {}, { timeout: 5000 }));
    await fireEvent.changeText(await findByTestId('payout-reason-input'), 'changed my mind');
    await fireEvent.press(getByTestId('payout-reason-cancel'));
    expect(mockHold).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('P7 a state tab reads that state', async () => {
    mockList.mockResolvedValue(ok([PENDING, HELD, RELEASED]));
    const { findByTestId, findByText } = await render(<AdminPayouts />);
    await findByTestId('payout-po-pending', {}, { timeout: 5000 });
    expect(mockList).toHaveBeenLastCalledWith('all');

    mockList.mockResolvedValue(ok([]));
    await fireEvent.press(await findByTestId('tab-on_hold'));
    await waitFor(() => expect(mockList).toHaveBeenLastCalledWith('on_hold'));
    expect(await findByText('No payouts in this state', {}, { timeout: 5000 })).toBeTruthy();
  });
});
