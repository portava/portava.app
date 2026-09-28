/**
 * §21 Archive is reachable from the owner's own passport.
 *
 * Highlights/Memories Development Architecture Spec v1 §21: an archived
 * Highlight is retained and removed from normal browsing "unless EXPLICITLY
 * REQUESTED". `/highlights/archived` is the explicit request; a screen nothing
 * navigates to is not a request anybody can make, and Archive would be a
 * one-way door.
 *
 * This asserts the LINK, not the screen — that is
 * `app/highlights/__tests__/archived.screen.component.test.tsx` — and it
 * asserts it against the shipped route string, so a rename that leaves this
 * item pointing nowhere fails here rather than in somebody's hands.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

const mockPush = jest.fn();

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator
// context this unit does not mount. `closeThenNavigate` uses router.push only.
jest.mock('expo-router', () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { PassportOwnerMenuSheet } from '../PassportOwnerMenuSheet.tsx';
import { PORTAVA_ROUTES } from '../../../navigation/portavaRoutes.ts';

describe('§21 archived highlights are explicitly requestable', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockPush.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('is registered as a real, owner-scoped route', () => {
    const entry = PORTAVA_ROUTES.find((r) => r.path === 'highlights/archived');
    expect(entry).toBeDefined();
    expect(entry?.requiresAuth).toBe(true);
    expect(entry?.ownerOnly).toBe(true);
  });

  it('the owner menu offers it and navigates there', async () => {
    const onClose = jest.fn();
    await render(
      <PassportOwnerMenuSheet visible onClose={onClose} username="me" onEditProfile={() => {}} />,
    );

    const item = await screen.findByTestId('owner-menu-archived-highlights');
    fireEvent.press(item);

    // The sheet closes first and the navigation is deferred past the close
    // animation (closeThenNavigate); without draining the timer nothing pushes.
    expect(onClose).toHaveBeenCalled();
    await act(async () => { jest.runOnlyPendingTimers(); });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/highlights/archived'));
  });
});
