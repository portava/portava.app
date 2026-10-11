/**
 * census-layover L275 — the end-of-layover sheet's FOURTH answer: make a postcard.
 *
 * Layover spec §25: "convert a COMPLETED session into an optional
 * stamp/postcard/memory". The postcard is not written by the sheet; a ticked
 * box asks the dashboard to open the ordinary postcard composer once the server
 * has recorded the layover completed. Same rules as the other elections: OFF
 * until ticked, independent of them, and never sent on the cancelled branch.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { LayoverEndSheet } from '../LayoverEndSheet.tsx';

// RNTL v14: render and fireEvent are ASYNC — every call is awaited.
async function mount() {
  const onEnd = jest.fn();
  await render(<LayoverEndSheet visible stampCity="Taipei" onEnd={onEnd} onCancel={jest.fn()} />);
  return { onEnd };
}

test('1. the postcard election is offered and starts OFF', async () => {
  await mount();
  expect(screen.getByTestId('layover-end-postcard-election').props.accessibilityState).toEqual({ checked: false });
  expect(screen.getByText(/Make a postcard of this layover/)).toBeTruthy();
});

test('2. untouched, "I made my flight" sends makePostcard: false', async () => {
  const { onEnd } = await mount();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'completed', passportStamp: false, keepMemory: false, makePostcard: false });
});

test('3. ticked, "I made my flight" sends makePostcard: true and nothing else changes', async () => {
  const { onEnd } = await mount();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-postcard-election')); });
  expect(screen.getByTestId('layover-end-postcard-election').props.accessibilityState).toEqual({ checked: true });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-completed')); });
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'completed', passportStamp: false, keepMemory: false, makePostcard: true });
});

test('4. ending early never asks for a postcard, even ticked', async () => {
  const { onEnd } = await mount();
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-postcard-election')); });
  await act(async () => { fireEvent.press(screen.getByTestId('layover-end-cancelled')); });
  expect(onEnd).toHaveBeenCalledWith({ outcome: 'cancelled', passportStamp: false, keepMemory: false, makePostcard: false });
});
