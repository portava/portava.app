/**
 * WP-08 / TEL-F09 — report ONE message through the Telegraph route.
 *
 * The sheet must call `reportMessage` (POST /api/messages/:id/report — the
 * route that snapshots the message as §22 evidence) with the server's reason
 * code, keep the choice when sending fails, and say "sent" only when the
 * server accepted.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6 (Modal replaced by a synchronous View).
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react');
        return ({ children, visible }: any) =>
          visible ? R.createElement(target.View, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

const mockReport = jest.fn();
// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time. The sheet reads the reason list and calls reportMessage.
jest.mock('../../../services/messaging.ts', () => ({
  reportMessage: (...a: unknown[]) => mockReport(...a),
  MESSAGE_REPORT_REASONS: [
    { code: 'harassment', label: 'Harassment or bullying' },
    { code: 'spam', label: 'Spam or scam' },
    { code: 'other', label: 'Something else' },
  ],
}));

import { MessageReportSheet } from '../messageActions/MessageReportSheet.tsx';

beforeEach(() => { jest.clearAllMocks(); });

it('sends the reason code and the reason text to the Telegraph route', async () => {
  mockReport.mockResolvedValueOnce({ ok: true, data: { ok: true } });
  await render(<MessageReportSheet visible messageId="m-7" onClose={() => {}} />);
  await fireEvent.press(screen.getByTestId('telegraph-message-report-reason-harassment'));
  await fireEvent.changeText(screen.getByTestId('telegraph-message-report-detail'), 'third time today');
  await fireEvent.press(screen.getByTestId('telegraph-message-report-submit'));
  await waitFor(() => expect(screen.getByTestId('telegraph-message-report-sent')).toBeTruthy());
  expect(mockReport).toHaveBeenCalledWith('m-7', 'Harassment or bullying: third time today', 'harassment');
});

it('nothing is sent until a reason is chosen', async () => {
  await render(<MessageReportSheet visible messageId="m-7" onClose={() => {}} />);
  await fireEvent.press(screen.getByTestId('telegraph-message-report-submit'));
  expect(mockReport).not.toHaveBeenCalled();
});

it('a failed send says so and keeps the choice, so it can be sent again', async () => {
  mockReport.mockResolvedValueOnce({ ok: false, data: null, errorKind: 'db_error', message: 'Could not file report' });
  await render(<MessageReportSheet visible messageId="m-7" onClose={() => {}} />);
  await fireEvent.press(screen.getByTestId('telegraph-message-report-reason-spam'));
  await fireEvent.press(screen.getByTestId('telegraph-message-report-submit'));
  await waitFor(() => expect(screen.getByTestId('telegraph-message-report-error')).toBeTruthy());
  expect(screen.queryByTestId('telegraph-message-report-sent')).toBeNull();

  mockReport.mockResolvedValueOnce({ ok: true, data: { ok: true } });
  await fireEvent.press(screen.getByTestId('telegraph-message-report-submit'));
  await waitFor(() => expect(screen.getByTestId('telegraph-message-report-sent')).toBeTruthy());
  expect(mockReport).toHaveBeenLastCalledWith('m-7', 'Spam or scam', 'spam');
});

it('offers Block after a report only where the caller supplies it', async () => {
  const onBlock = jest.fn();
  mockReport.mockResolvedValueOnce({ ok: true, data: { ok: true } });
  await render(<MessageReportSheet visible messageId="m-7" onClose={() => {}} blockLabel="Block this person" onBlock={onBlock} />);
  await fireEvent.press(screen.getByTestId('telegraph-message-report-reason-other'));
  await fireEvent.press(screen.getByTestId('telegraph-message-report-submit'));
  await waitFor(() => expect(screen.getByTestId('telegraph-message-report-block')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('telegraph-message-report-block'));
  expect(onBlock).toHaveBeenCalledTimes(1);
});
