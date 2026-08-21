/**
 * PassportOwnerMenuSheet — Settings navigation waits for native dismissal.
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
  const MockModal = ({
    children,
    visible,
    onDismiss,
  }: {
    children: React.ReactNode;
    visible: boolean;
    onDismiss?: () => void;
  }) => {
    if (!visible) return null;
    return R.createElement(
      actual.View,
      null,
      children,
      R.createElement(
        actual.Pressable,
        {
          accessibilityRole: 'button',
          accessibilityLabel: 'Complete menu dismissal',
          onPress: onDismiss,
        },
      ),
    );
  };
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import { PassportOwnerMenuSheet } from '../passport/PassportOwnerMenuSheet.tsx';

describe('PassportOwnerMenuSheet — Settings', () => {
  it('closes first and invokes the parent settings callback exactly once only after dismissal', async () => {
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

    // The component owns the exit animation, so the parent is not asked to
    // unmount the core Modal until the sheet has actually left the screen.
    expect(onClose).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(onSettings).not.toHaveBeenCalled();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockPush).not.toHaveBeenCalled();
    expect(onSettings).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole('button', { name: 'Complete menu dismissal' }));
    fireEvent.press(screen.getByRole('button', { name: 'Complete menu dismissal' }));

    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});