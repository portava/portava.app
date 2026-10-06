/**
 * OD-INPUT-3 / census G25 — opt-in, inspect, revoke, driven on the REAL row
 * with the server's answers injected through its `read` / `write` props.
 *
 * MUTATION LOG (each applied, watched go red, reverted):
 *   - MemoryContextSetting.tsx: grant straight from the switch (skip the
 *     explanation) → test 2 goes red.
 *   - MemoryContextSetting.tsx: render factsUnavailable as the empty list →
 *     test 3 goes red.
 *   - MemoryContextSetting.tsx: show the inspect list while the opt-in is off →
 *     test 2 goes red.
 */
import React from 'react';
import { cleanup, fireEvent, render, waitFor, act } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — the transport imports the Supabase-backed
// token helper at load (no native module under jest); these two are its whole
// export surface, and the row's own read/write props carry every answer here.
jest.mock('../../services/memoryContextTransport.ts', () => ({
  readMemoryContext: jest.fn(),
  writeMemoryContextConsent: jest.fn(),
}));

import { MemoryContextSetting } from '../MemoryContextSetting.tsx';
import { MEMORY_CONTEXT_BODY, MEMORY_CONTEXT_DISCLOSURE_VERSION, type MemoryContextView } from '../../services/memoryContext.ts';

const OFF: MemoryContextView = { available: true, enabled: false, currentDisclosureVersion: MEMORY_CONTEXT_DISCLOSURE_VERSION, facts: null, factsUnavailable: false };
const ON: MemoryContextView = { ...OFF, enabled: true, facts: [{ city: 'Hội An', country: 'Vietnam', occurredAt: null }, { city: 'Tokyo', country: 'Japan', occurredAt: null }] };

afterEach(async () => { await cleanup(); });

test('unreadable is shown as unreadable with a retry — never as a switch that is off', async () => {
  const read = jest.fn().mockResolvedValueOnce({ status: 'unreadable' }).mockResolvedValueOnce({ status: 'ok', view: OFF });
  const r = await render(<MemoryContextSetting read={read} write={jest.fn()} />);
  await waitFor(() => expect(r.getByTestId('memory-context-unreadable')).toBeTruthy(), { timeout: 8000 });
  expect(r.queryByTestId('memory-context-switch')).toBeNull();
  await act(async () => { fireEvent.press(r.getByTestId('memory-context-retry')); });
  await waitFor(() => expect(r.getByTestId('memory-context-switch').props.value).toBe(false));
});

test('off: no inspect list; switching on shows the explanation and only Allow grants; then the list is the server\'s', async () => {
  const read = jest.fn().mockResolvedValueOnce({ status: 'ok', view: OFF }).mockResolvedValueOnce({ status: 'ok', view: ON });
  const write = jest.fn().mockResolvedValue({ status: 'ok' });
  const r = await render(<MemoryContextSetting read={read} write={write} />);
  await waitFor(() => expect(r.getByTestId('memory-context-switch')).toBeTruthy());
  expect(r.queryByTestId('memory-context-inspect')).toBeNull();

  await act(async () => { fireEvent(r.getByTestId('memory-context-switch'), 'valueChange', true); });
  expect(r.getByText(MEMORY_CONTEXT_BODY)).toBeTruthy();
  expect(write).not.toHaveBeenCalled();
  expect(r.queryByTestId('memory-context-inspect')).toBeNull();

  await act(async () => { fireEvent.press(r.getByTestId('memory-context-allow')); });
  expect(write).toHaveBeenCalledWith(true);
  await waitFor(() => expect(r.getAllByTestId('memory-context-fact')).toHaveLength(2));
  expect(r.getByText('Hội An, Vietnam')).toBeTruthy();
});

test('on: a failed memory read is SAID, not shown as empty; revoke is one tap and re-reads', async () => {
  const read = jest.fn()
    .mockResolvedValueOnce({ status: 'ok', view: { ...ON, facts: null, factsUnavailable: true } })
    .mockResolvedValueOnce({ status: 'ok', view: OFF });
  const write = jest.fn().mockResolvedValue({ status: 'ok' });
  const r = await render(<MemoryContextSetting read={read} write={write} />);
  await waitFor(() => expect(r.getByTestId('memory-context-facts-unavailable')).toBeTruthy(), { timeout: 8000 });
  expect(r.queryByTestId('memory-context-facts-empty')).toBeNull();

  await act(async () => { fireEvent(r.getByTestId('memory-context-switch'), 'valueChange', false); });
  expect(write).toHaveBeenCalledWith(false);
  await waitFor(() => expect(r.getByTestId('memory-context-switch').props.value).toBe(false));
  expect(r.queryByTestId('memory-context-inspect')).toBeNull();
  expect(r.getByTestId('memory-context-note').props.children).toMatch(/no longer uses your memories/);
});
