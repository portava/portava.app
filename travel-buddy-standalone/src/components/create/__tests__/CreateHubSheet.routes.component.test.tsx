/**
 * CreateHubSheet.routes.component.test.tsx
 *
 * Covers task #2842: tapping a live entry in the Create Hub sheet closes the
 * sheet and navigates to its route (no dead-end). Since 2026-11-04 the hub has
 * no "Soon" rows: Plan and Add Place were removed and Review Place opens place
 * search.
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
  it('navigates each entry to its route after closing, and shows no "Soon" rows', async () => {
    jest.useFakeTimers();
    try {
      const liveEntries: Array<[string, string]> = [
        ['Post', '/create'],
        ['Memory', '/memory/new'],
        ['Add a Gem', '/gems/submit'],
        ['Event', '/events/create'],
        ['Trip', '/trip/new'],
        ['Recommend Hidden Gem', '/gems/submit'],
        // Testing mode WP-06 (PLAT-F32/F33): Story is live — /stories mounts the
        // viewer and composer that nothing reached before. Restated from "Soon".
        ['Story', '/stories'],
        // 2026-11-04: Review Place opens place search; a place's page holds
        // its reviews and the Write a review button.
        ['Review Place', '/search?type=places'],
      ];

      // Single mount; exercise every row in the same tree to avoid
      // render/unmount interaction contamination across cases.
      const onClose = jest.fn();
      await render(<CreateHubSheet visible onClose={onClose} />);

      // The dead rows are gone, and nothing is left showing "Soon".
      for (const label of ['Plan', 'Add Place']) expect(screen.queryByLabelText(label)).toBeNull();
      expect(screen.queryByText('Soon')).toBeNull();

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
