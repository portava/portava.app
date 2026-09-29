/**
 * WP-08 / TEL-F07 — the edit-history sheet keeps "unavailable" and "never
 * edited" apart. The server answers 503 rather than `{ versions: [] }` when
 * it cannot read `message_edits`; this sheet must carry that to the screen
 * as an error with Try again, never as "no earlier version".
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

const mockHistory = jest.fn();
// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time; the sheet calls this one function.
jest.mock('../../../services/messaging.ts', () => ({
  getMessageEditHistory: (...a: unknown[]) => mockHistory(...a),
}));

import { EditHistorySheet } from '../messageActions/EditHistorySheet.tsx';

beforeEach(() => { jest.clearAllMocks(); });

it('shows the current text, then each earlier version, newest first', async () => {
  mockHistory.mockResolvedValueOnce({ ok: true, data: {
    messageId: 'm-1', threadId: 't-1', senderId: 'u-1', currentBody: 'meet at 9', editedAt: '2026-09-01T10:10:00Z',
    versions: [
      { version: 2, previousBody: 'meet at 8', editorId: 'u-1', editedAt: '2026-09-01T10:10:00Z' },
      { version: 1, previousBody: 'meet at 7', editorId: 'u-1', editedAt: '2026-09-01T10:05:00Z' },
    ],
  } });
  await render(<EditHistorySheet visible threadId="t-1" messageId="m-1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText('meet at 9')).toBeTruthy());
  expect(screen.getByTestId('telegraph-edit-history-v2')).toBeTruthy();
  expect(screen.getByText('meet at 7')).toBeTruthy();
  expect(mockHistory).toHaveBeenCalledWith('t-1', 'm-1');
});

it('a 503 is an ERROR with Try again — not "no earlier version"', async () => {
  mockHistory.mockResolvedValueOnce({ ok: false, data: null, code: 'degraded_unavailable' });
  await render(<EditHistorySheet visible threadId="t-1" messageId="m-1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('telegraph-edit-history-error')).toBeTruthy());
  expect(screen.queryByTestId('telegraph-edit-history-empty')).toBeNull();

  mockHistory.mockResolvedValueOnce({ ok: true, data: {
    messageId: 'm-1', threadId: 't-1', senderId: 'u-1', currentBody: 'x', editedAt: null, versions: [],
  } });
  await fireEvent.press(screen.getByTestId('telegraph-edit-history-retry'));
  await waitFor(() => expect(screen.getByTestId('telegraph-edit-history-empty')).toBeTruthy());
});

it('a refusal (removed from the thread) is not offered a retry', async () => {
  mockHistory.mockResolvedValueOnce({ ok: false, data: null, code: 'forbidden' });
  await render(<EditHistorySheet visible threadId="t-1" messageId="m-1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('telegraph-edit-history-error')).toBeTruthy());
  expect(screen.queryByTestId('telegraph-edit-history-retry')).toBeNull();
});
