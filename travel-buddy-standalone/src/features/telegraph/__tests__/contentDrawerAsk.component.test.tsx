/**
 * WP-08 / TEL-F16 — the way into "Ask this conversation".
 *
 * The content drawer (the thread header's "Shared content and search") offers
 * the ask entry only when its caller supplies `onAsk`, and hands off rather
 * than stacking a second Modal on top of itself.
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

// NOTE: intentional stub — kindsApi reaches lib/supabase at import time.
jest.mock('../kinds/kindsApi.ts', () => {
  const actual = jest.requireActual('../kinds/kindsApi.ts');
  return { ...actual, fetchDrawer: jest.fn(), searchThread: jest.fn() };
});

import { ContentDrawerSheet } from '../drawer/ContentDrawerSheet.tsx';
import { fetchDrawer } from '../kinds/kindsApi.ts';

const mockedFetchDrawer = fetchDrawer as jest.MockedFunction<typeof fetchDrawer>;

beforeEach(() => {
  mockedFetchDrawer.mockReset();
  mockedFetchDrawer.mockResolvedValue({ ok: false, error: 'db_error' } as never);
});

it('offers Ask and hands off to the caller', async () => {
  const onAsk = jest.fn();
  await render(<ContentDrawerSheet visible threadId="t1" onClose={() => {}} onAsk={onAsk} />);
  await waitFor(() => expect(screen.getByTestId('telegraph-drawer-ask')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('telegraph-drawer-ask'));
  expect(onAsk).toHaveBeenCalledTimes(1);
});

it('no onAsk, no entry (the drawer renders exactly as before)', async () => {
  await render(<ContentDrawerSheet visible threadId="t1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('telegraph-drawer-failed')).toBeTruthy());
  expect(screen.queryByTestId('telegraph-drawer-ask')).toBeNull();
});
