/**
 * OwnerActionMenu — "About Me" navigates to /profile/edit/about
 *
 * Pins that tapping the "About Me" action calls router.push with
 * '/profile/edit/about', not the old dead route '/profile/about'.
 *
 * ## Mock strategy
 * OwnerActionMenu uses react-native Modal.  The Modal Proxy mock is required
 * to avoid overlapping act() scopes — see .agents/memory/modal-proxy-mock.md.
 * Share is stubbed to avoid native Share.share calls.
 */

import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  // NOTE: Modal Proxy mock — avoids overlapping act() from Modal animation lifecycle
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      if (prop === 'Share') return { share: jest.fn().mockResolvedValue({}) };
      return Reflect.get(target, prop, receiver);
    },
  });
});

import { render } from '@testing-library/react-native';
import { OwnerActionMenu } from '../OwnerActionMenu.tsx';

const mockPush = router.push as jest.Mock;

const defaultProps = {
  visible: true,
  onClose: jest.fn(),
  username: 'testuser',
  onEditProfile: jest.fn(),
  onSettings: jest.fn(),
  onViewAsPublic: jest.fn(),
};

describe('OwnerActionMenu — About Me button', () => {
  beforeEach(() => {
    mockPush.mockClear();
    defaultProps.onClose.mockClear();
  });

  it('navigates to /profile/edit/about when About Me is tapped', async () => {
    await render(<OwnerActionMenu {...defaultProps} />);

    fireEvent.press(screen.getByRole('button', { name: 'About Me' }));

    expect(mockPush).toHaveBeenCalledWith('/profile/edit/about');
  });

  it('does NOT navigate to the old dead route /profile/about', async () => {
    await render(<OwnerActionMenu {...defaultProps} />);

    fireEvent.press(screen.getByRole('button', { name: 'About Me' }));

    const calledWith = mockPush.mock.calls.map((c) => c[0]);
    expect(calledWith).not.toContain('/profile/about');
  });
});
