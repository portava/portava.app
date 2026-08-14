/**
 * CreateHubSheet.routes.component.test.tsx
 *
 * Covers task #2842: tapping a live entry in the Create Hub sheet closes the
 * sheet and navigates to its route (no dead-end); "Soon" entries are
 * disabled and never navigate.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { screen, render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { CreateHubSheet } from '../CreateHubSheet.tsx';

// NOTE: intentional stub — only `router.push` is exercised by this component;
// spreading requireActual pulls in expo-router's native navigation runtime,
// which isn't available under Jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

const { router: mockRouter } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
const pushMock = mockRouter.push;

// NOTE: intentional stub — only the insets hook is used by this component;
// spreading requireActual pulls in native safe-area measurement that isn't
// available under Jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('CreateHubSheet — route navigation', () => {
  it('navigates each live entry to its route after closing, and never navigates for "Soon" entries', async () => {
    jest.useFakeTimers();
    try {
      const liveEntries: Array<[string, string]> = [
        ['Post', '/create'],
        ['Memory', '/memory/edit'],
        ['Add a Gem', '/gems/submit'],
        ['Event', '/events/create'],
        ['Trip', '/trip/new'],
        ['Recommend Hidden Gem', '/gems/submit'],
      ];
      const soonEntries = ['Story', 'Plan', 'Add Place', 'Review Place'];

      // Single mount; exercise every row in the same tree to avoid
      // render/unmount interaction contamination across cases.
      const onClose = jest.fn();
      await render(<CreateHubSheet visible onClose={onClose} />);

      // "Soon" entries: disabled, tapping them does nothing.
      for (const label of soonEntries) {
        const row = screen.getByLabelText(label);
        expect(row.props.accessibilityState?.disabled).toBe(true);
        fireEvent.press(row);
      }
      await act(async () => {
        jest.advanceTimersByTime(320);
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();

      // Live entries: each tap closes the sheet, then (after the deferred
      // navigation window) pushes its route.
      for (const [label, expectedRoute] of liveEntries) {
        onClose.mockClear();
        pushMock.mockClear();

        fireEvent.press(screen.getByLabelText(label));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(pushMock).not.toHaveBeenCalled(); // deferred, not synchronous

        await act(async () => {
          jest.advanceTimersByTime(320);
        });

        await waitFor(() => expect(pushMock).toHaveBeenCalledWith(expectedRoute));
      }
    } finally {
      jest.useRealTimers();
    }
  });
});
