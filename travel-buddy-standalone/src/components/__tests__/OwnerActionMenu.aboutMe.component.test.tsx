/**
 * OwnerActionMenu (PassportOwnerMenuSheet) — "Edit Bio" navigates to /profile/edit/about
 *
 * Previously the sheet had an "About Me" item — now the equivalent is
 * "Edit Bio" in the Profile section, which still routes to /profile/edit/about.
 * This test pins that the correct route is used and not a stale dead route.
 *
 * ## Mock strategy
 * OwnerActionMenu renders PassportOwnerMenuSheet which uses react-native Modal.
 * The Modal Proxy mock is required to avoid overlapping act() scopes — see
 * .agents/memory/modal-proxy-mock.md.
 */

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  // NOTE: Modal Proxy mock — avoids overlapping act() from Modal animation lifecycle
  const MockModal = ({
    children,
    visible,
  }: {
    children: React.ReactNode;
    visible: boolean;
  }) => visible
    ? R.createElement(actual.View, null, children)
    : null;
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

describe('OwnerActionMenu — Edit Bio button', () => {
  beforeEach(() => {
    mockPush.mockClear();
    defaultProps.onClose.mockClear();
    defaultProps.onEditProfile.mockClear();
    defaultProps.onSettings.mockClear();
  });

  it('navigates to /profile/edit/about when Edit Bio is tapped', async () => {
    await render(<OwnerActionMenu {...defaultProps} />);

    fireEvent.press(screen.getByRole('button', { name: 'Edit Bio' }));

    // BUG CC fix: navigation is deferred until after the sheet's close
    // animation finishes (see closeThenNavigate in PassportOwnerMenuSheet),
    // so it no longer fires synchronously with the press.
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/profile/edit/about'));
  });

  it('does NOT navigate to the old dead route /profile/about', async () => {
    await render(<OwnerActionMenu {...defaultProps} />);

    fireEvent.press(screen.getByRole('button', { name: 'Edit Bio' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    const calledWith = mockPush.mock.calls.map((c) => c[0]);
    expect(calledWith).not.toContain('/profile/about');
  });
});

describe('OwnerActionMenu — Settings button', () => {
  beforeEach(() => {
    mockPush.mockClear();
    defaultProps.onClose.mockClear();
    defaultProps.onEditProfile.mockClear();
    defaultProps.onSettings.mockClear();
  });

  it('closes the sheet and invokes the parent profile-settings navigation callback', async () => {
    await render(<OwnerActionMenu {...defaultProps} />);

    fireEvent.press(screen.getByRole('button', { name: 'Settings' }));

    // BUG: this used to wait for the core <Modal>'s onDismiss, which is
    // iOS-only in React Native and never fires on Android — a dead tap there.
    // It now defers via closeThenRun (setTimeout-based, cross-platform), same
    // as closeThenNavigate above, so no Modal dismissal event is involved.
    expect(defaultProps.onSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(defaultProps.onSettings).toHaveBeenCalledTimes(1));
    expect(defaultProps.onEditProfile).not.toHaveBeenCalled();
  });
});
