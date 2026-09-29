/**
 * WP-08 / TEL-F16 — "Ask this conversation".
 *
 * Pins the four outcomes the sheet keeps apart: an answer (structured before
 * prose, §21), a complete empty, a DEGRADED empty (a floor, never "nothing
 * matched"), and a failure with Try again.
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

const mockAsk = jest.fn();
// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time; the sheet calls askConversation only.
jest.mock('../services/telegraphSearch.ts', () => ({
  askConversation: (...a: unknown[]) => mockAsk(...a),
}));

import { AskConversationSheet } from '../ask/AskConversationSheet.tsx';

const HIT = (id: string, snippet: string, objectTitle: string | null = null) => ({
  messageId: id, conversationId: 't-1', bucket: 'MESSAGES', senderId: 'u-2', createdAt: '2026-09-01T10:00:00Z',
  snippet, objectTitle, subtype: null, msgType: 'text', hasMedia: false,
});

beforeEach(() => { jest.clearAllMocks(); });

async function ask(q: string) {
  await fireEvent.changeText(screen.getByTestId('telegraph-ask-input'), q);
  await fireEvent.press(screen.getByTestId('telegraph-ask-submit'));
}

it('answers structured plans first, then messages, from THIS thread', async () => {
  mockAsk.mockResolvedValueOnce({ ok: true, structured: [HIT('m-plan', 'Dinner Fri 8pm', 'Plan')], prose: [HIT('m-2', 'see you at 8')], degraded: false });
  await render(<AskConversationSheet visible threadId="t-1" onClose={() => {}} />);
  await ask('when do we meet');
  await waitFor(() => expect(screen.getByTestId('telegraph-ask-structured')).toBeTruthy());
  expect(screen.getByTestId('telegraph-ask-prose')).toBeTruthy();
  expect(mockAsk).toHaveBeenCalledWith('t-1', 'when do we meet');
});

it('a complete search with no answer says so plainly', async () => {
  mockAsk.mockResolvedValueOnce({ ok: true, structured: [], prose: [], degraded: false });
  await render(<AskConversationSheet visible threadId="t-1" onClose={() => {}} />);
  await ask('flight number');
  await waitFor(() => expect(screen.getByTestId('telegraph-ask-empty')).toBeTruthy());
});

it('a DEGRADED empty is a floor, never "nothing answers that"', async () => {
  mockAsk.mockResolvedValueOnce({ ok: true, structured: [], prose: [], degraded: true });
  await render(<AskConversationSheet visible threadId="t-1" onClose={() => {}} />);
  await ask('flight number');
  await waitFor(() => expect(screen.getByTestId('telegraph-ask-empty-degraded')).toBeTruthy());
  expect(screen.getByTestId('telegraph-ask-degraded')).toBeTruthy();
  expect(screen.queryByTestId('telegraph-ask-empty')).toBeNull();
});

it('a failure is an error with Try again', async () => {
  mockAsk.mockResolvedValueOnce({ ok: false, structured: [], prose: [], degraded: false, error: 'network_unreachable' });
  await render(<AskConversationSheet visible threadId="t-1" onClose={() => {}} />);
  await ask('flight number');
  await waitFor(() => expect(screen.getByTestId('telegraph-ask-error')).toBeTruthy());
  mockAsk.mockResolvedValueOnce({ ok: true, structured: [], prose: [HIT('m-3', 'TP 1234')], degraded: false });
  await fireEvent.press(screen.getByTestId('telegraph-ask-retry'));
  await waitFor(() => expect(screen.getByText('TP 1234')).toBeTruthy());
});
