/**
 * TripReservationsSection — "Paste a confirmation": the keyboard must not cover the Extract button.
 *
 * The sheet sits at the bottom of a transparent Modal. Focusing the multiline text box raised the iOS keyboard over the
 * bottom of the sheet, hiding "Extract reservations", and a multiline box has no return key that dismisses the keyboard,
 * so the traveller could paste a confirmation and then not submit it. The overlay is now a KeyboardAvoidingView
 * (padding on iOS, as TripBudgetSection's sheets do) and the paste body a shrinkable ScrollView whose taps land while
 * the keyboard is up.
 *
 * Jest computes no keyboard or layout, so this pins the structure and props that decide it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

// NOTE: intentional stub — TESTING.md Rule 6. `Modal` renders its children when visible; `KeyboardAvoidingView`
// renders a host View that keeps its `behavior` prop so the test can read it. Every other export falls through.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockKeyboardAvoidingView = ({ children, behavior, style }: { children: React.ReactNode; behavior?: string; style?: unknown }) =>
    R.createElement(actual.View, { testID: 'keyboard-avoiding', behavior, style }, children);
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'KeyboardAvoidingView') return MockKeyboardAvoidingView;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import { ImportSheet } from '../trip/TripReservationsSection.tsx';

function contains(ancestor: any, node: any): boolean {
  for (let n = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

function enclosingScrollView(node: any): any {
  for (let n = node; n; n = n.parent) if (n.type === 'RCTScrollView') return n;
  return null;
}

describe('ImportSheet — keyboard', () => {
  it('the whole sheet sits inside a KeyboardAvoidingView that pads on iOS', async () => {
    await render(<ImportSheet tripId="trip-1" visible onDismiss={() => {}} onImported={() => {}} />);
    const kav = screen.getByTestId('keyboard-avoiding') as any;
    expect(kav.props.behavior).toBe('padding');
    expect(StyleSheet.flatten(kav.props.style)).toMatchObject({ flex: 1, justifyContent: 'flex-end' });
    expect(contains(kav, screen.getByTestId('confirmation-text-input'))).toBe(true);
    expect(contains(kav, screen.getByTestId('extract-button'))).toBe(true);
  });

  it('the text box and the Extract button share one shrinkable ScrollView that takes taps with the keyboard up', async () => {
    await render(<ImportSheet tripId="trip-1" visible onDismiss={() => {}} onImported={() => {}} />);
    const scroll = enclosingScrollView(screen.getByTestId('confirmation-text-input'));
    expect(scroll).not.toBeNull();
    expect(enclosingScrollView(screen.getByTestId('extract-button'))).toBe(scroll);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    const style = StyleSheet.flatten(scroll.props.style) ?? {};
    // Content-sized (a basis-0 body collapsed this sheet to 0pt before), but allowed to shrink under the keyboard.
    expect(style.flex).toBeUndefined();
    expect(style.flexGrow ?? 0).toBe(0);
    expect(style.flexShrink).toBe(1);
  });
});
