/**
 * WP-08 / TEL-F03 — the sender withdraws a pending message request.
 *
 * The button asks first, calls POST /api/message-requests/:id/cancel, and on
 * every outcome other than a plain failure asks the caller to RE-READ the
 * request status — the banner goes away because the server says nothing is
 * pending, not because this button assumed it.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockCancel = jest.fn();
// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time; the button calls cancelMessageRequest only.
jest.mock('../../../services/messaging.ts', () => ({
  cancelMessageRequest: (...a: unknown[]) => mockCancel(...a),
}));

import { CancelRequestButton } from '../requests/CancelRequestButton.tsx';

type Btn = { text?: string; onPress?: () => void };
let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { alertSpy.mockRestore(); });

async function confirm() {
  await fireEvent.press(screen.getByTestId('telegraph-cancel-request'));
  const buttons = alertSpy.mock.calls[0][2] as Btn[];
  // TESTING.md Rule 2: call the Alert button's onPress directly, not inside act().
  buttons.find((b) => b.text === 'Cancel request')!.onPress!();
}

it('asks first; cancelling nothing until confirmed', async () => {
  await render(<CancelRequestButton requestId="req-7" onCancelled={jest.fn()} />);
  await fireEvent.press(screen.getByTestId('telegraph-cancel-request'));
  expect(mockCancel).not.toHaveBeenCalled();
});

it('a cancelled request asks the caller to re-read', async () => {
  const onCancelled = jest.fn();
  mockCancel.mockResolvedValueOnce({ ok: true, data: { status: 'cancelled', requestId: 'req-7' } });
  await render(<CancelRequestButton requestId="req-7" onCancelled={onCancelled} />);
  await confirm();
  await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
  expect(mockCancel).toHaveBeenCalledWith('req-7');
  await waitFor(() => expect(screen.getByText('Cancel')).toBeTruthy());
});

it('answered first (no longer pending) is said, and the caller re-reads', async () => {
  const onCancelled = jest.fn();
  mockCancel.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'invalid_payload', message: 'Request is no longer pending' });
  await render(<CancelRequestButton requestId="req-7" onCancelled={onCancelled} />);
  await confirm();
  await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
  expect(alertSpy.mock.calls.some((c) => c[0] === 'Already answered')).toBe(true);
  await waitFor(() => expect(screen.getByText('Cancel')).toBeTruthy());
});

it('a failure leaves the request pending and says so', async () => {
  const onCancelled = jest.fn();
  mockCancel.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'network_unreachable' });
  await render(<CancelRequestButton requestId="req-7" onCancelled={onCancelled} />);
  await confirm();
  await waitFor(() => expect(alertSpy.mock.calls.some((c) => c[0] === 'Not cancelled')).toBe(true));
  expect(onCancelled).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText('Cancel')).toBeTruthy());
});
