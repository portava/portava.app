/**
 * PassportOwnerMenuSheet — Settings navigates cross-platform.
 *
 * Regression test for the Android dead-tap bug: the Settings row used to wait
 * for the core <Modal>'s onDismiss before calling onSettings, but onDismiss is
 * iOS-only in React Native and never fires on Android — so the button did
 * nothing there. It now defers through closeThenRun (setTimeout-based), the
 * same cross-platform mechanism every other row already uses via
 * closeThenNavigate, so it no longer depends on any Modal dismissal event.
 *
 * ## Mock strategy
 * See .agents/memory/modal-proxy-mock.md — Modal renders as a synchronous
 * View with no onDismiss wiring, matching production (this component no
 * longer reads onDismiss at all).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  // NOTE: Modal Proxy mock — see .agents/memory/modal-proxy-mock.md
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import { PassportOwnerMenuSheet } from '../passport/PassportOwnerMenuSheet.tsx';

describe('PassportOwnerMenuSheet — Settings', () => {
  it('closes the sheet and invokes the parent settings callback exactly once, with no Modal dismissal event required', async () => {
    const onClose = jest.fn();
    const onSettings = jest.fn();
    const mockPush = router.push as jest.Mock;
    await render(
      <PassportOwnerMenuSheet
        visible
        onClose={onClose}
        username="traveler"
        onEditProfile={jest.fn()}
        onSettings={onSettings}
      />,
    );

    const settings = screen.getByRole('button', { name: 'Settings' });
    fireEvent.press(settings);
    fireEvent.press(settings);

    expect(onSettings).not.toHaveBeenCalled();

    await waitFor(() => expect(onSettings).toHaveBeenCalledTimes(1));
    expect(mockPush).not.toHaveBeenCalled();
  });
});
