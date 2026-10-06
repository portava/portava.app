/**
 * census-layover L275 — the end-of-layover sheet's third answer.
 *
 * Layover spec §25: "convert a COMPLETED session into an optional
 * stamp/postcard/memory". The sheet now asks, independently of the Passport
 * stamp, whether to keep a private Memory of the layover. Same rules as the
 * stamp (census L19/L162): OFF until ticked, and only ever sent on the
 * completed branch — an abandoned layover never elects one.
 *
 * Asserted on what the sheet SENDS (`onEnd`'s argument), because a box that
 * renders and posts a constant is the defect in a nicer coat.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { LayoverEndSheet } from '../LayoverEndSheet.tsx';

// RNTL v14: render and fireEvent are ASYNC. An unawaited render commits
// nothing and every later query in the file passes or fails vacuously.
async function mount(stampCity: string | null = 'Taipei') {
  const onEnd = jest.fn();
  const onCancel = jest.fn();
  await render(<LayoverEndSheet visible stampCity={stampCity} onEnd={onEnd} onCancel={onCancel} />);
  return { onEnd, onCancel };
}

test('1. the Memory election is offered and starts OFF', async () => {
  await mount();
  const box = screen.getByTestId('layover-end-memory-election');
  expect(box.props.accessibilityState).toEqual({ checked: false });
  expect(screen.getByText(/Keep a private Memory of this layover/)).toBeTruthy();
});

test('2. untouched, "I made my flight" sends keepMemory: false', async () => {
  const { onEnd } = await mount();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'completed', passportStamp: false, keepMemory: false });
});

test('3. ticked, "I made my flight" sends keepMemory: true — and the stamp stays independent', async () => {
  const { onEnd } = await mount();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-memory-election')); });
  expect(screen.getByTestId('layover-end-memory-election').props.accessibilityState).toEqual({ checked: true });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'completed', passportStamp: false, keepMemory: true });
});

test('4. both ticked send both', async () => {
  const { onEnd } = await mount();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-stamp-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-memory-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'completed', passportStamp: true, keepMemory: true });
});

test('5. ending early never elects a Memory, even ticked', async () => {
  const { onEnd } = await mount();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-memory-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-cancelled')); });
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'cancelled', passportStamp: false, keepMemory: false });
});

test('6. the Memory is offered even when there is no city to stamp', async () => {
  const { onEnd } = await mount(null);
  expect(screen.queryByTestId('layover-end-stamp-election')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-memory-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'completed', passportStamp: false, keepMemory: true });
});
