/**
 * Circle Presence — goToSettings routing fix
 *
 * Confirms that the "Open settings" button in the "sharing is off" state
 * routes to `/profile/edit/location` (the global Find Your Circle toggle
 * screen) rather than `/circle-context-settings` (the per-context override
 * screen that cannot fix the global switch).
 *
 * Background:
 *   The empty state fires when `settingsRes.data.globalEnabled === false`.
 *   Before the fix, "Open settings" pushed to `/circle-context-settings`,
 *   which only controls per-context overrides on top of an already-enabled
 *   global switch — so the real blocker was never reachable and the screen
 *   appeared stuck after going back.
 *
 * Run with: pnpm --dir travel-buddy-standalone test:component
 */

import React from 'react';
import { render, act, fireEvent, waitFor } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: router.push is accessed as require('expo-router').router.push inside
// each test — the const-before-mock pattern puts the variable in the TDZ when
// the hoisted factory runs, making push undefined at call time.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({
    contextType:  'event',
    contextId:    'evt-circle-test-1',
    contextLabel: 'Sunset Party',
  }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// ── expo-location ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
}));

// ── Session ───────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'viewer-circle-test' }),
}));

// ── Bottom inset ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 34,
}));

// ── circle service — global sharing disabled scenario ─────────────────────────
// Key pre-condition: getCircleSettings returns globalEnabled=false, which
// triggers the 'sharing_off' screen state and shows the "Open settings" button.
// NOTE: partial stub. getCircleSettings is the one being tested; others return safe defaults.
jest.mock('../../src/services/circle', () => ({
  getCircleSettings: jest.fn().mockResolvedValue({
    ok: true,
    data: { globalEnabled: false, isPaused: false },
  }),
  getCircleContextSettings: jest.fn().mockResolvedValue({
    ok: true,
    data: { paused: false },
  }),
  getCircleMembers: jest.fn().mockResolvedValue({
    ok: true,
    data: { members: [] },
  }),
  getMyPresence: jest.fn().mockResolvedValue({ ok: false }),
  getMeetingPoint: jest.fn().mockResolvedValue({ ok: false }),
}));

// ── Sub-components — null stubs ───────────────────────────────────────────────
// NOTE: intentional stub — not under test here. AppHeader renders the title and
// back button but the actual behaviour under test is the "Open settings" press.
jest.mock('../../src/components/ui/AppHeader', () => ({
  AppHeader: ({ title }: any) => {
    const { Text } = require('react-native');
    return <Text>{title}</Text>;
  },
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../src/components/safeReturn/SafeReturnSetupSheet', () => ({
  SafeReturnSetupSheet: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../src/components/circle/CircleMemberRow', () => ({
  CircleMemberRow: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../src/components/circle/CheckInActions', () => ({
  CheckInActions: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../src/components/circle/MeetingPointCard', () => ({
  MeetingPointCard: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../src/components/circle/CircleMapSection', () => ({
  CircleMapSection: () => null,
}));

import CirclePresenceScreen from '../circle-presence.tsx';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Circle Presence — "Open settings" routes to global toggle screen', () => {
  beforeEach(() => {
    // Access push through require so we get the live mock fn, not a TDZ ref.
    require('expo-router').router.push.mockClear();
  });

  it('tapping "Open settings" pushes to /profile/edit/location — NOT circle-context-settings', async () => {
    const { getByText } = await render(<CirclePresenceScreen />);

    // Wait for the service calls to resolve and the sharing_off state to render.
    await act(async () => {});

    await waitFor(() => {
      expect(getByText('Open settings')).toBeTruthy();
    }, { timeout: 4000 });

    // Tap the button.
    fireEvent.press(getByText('Open settings'));

    // Access the live mock fn through require — avoids TDZ issues with const hoisting.
    const pushMock = require('expo-router').router.push;

    // The router must push to the global location settings screen.
    expect(pushMock).toHaveBeenCalledWith('/profile/edit/location');

    // The old (wrong) destination must never have been used.
    const wrongCalls = (pushMock.mock.calls as any[][]).filter(
      ([arg]) =>
        typeof arg === 'string'
          ? arg.includes('circle-context-settings')
          : arg?.pathname?.includes('circle-context-settings'),
    );
    expect(wrongCalls.length).toBe(0);
  });

  it('shows the "Find Your Circle is off." message in the sharing_off state', async () => {
    const { getByText } = await render(<CirclePresenceScreen />);
    await act(async () => {});

    await waitFor(() => {
      expect(getByText('Find Your Circle is off.')).toBeTruthy();
    }, { timeout: 4000 });
  });

  it('does NOT reach sharing_off when globalEnabled is true', async () => {
    const { getCircleSettings } = require('../../src/services/circle');
    getCircleSettings.mockResolvedValueOnce({
      ok: true,
      data: { globalEnabled: true, isPaused: false },
    });

    const { queryByText } = await render(<CirclePresenceScreen />);
    await act(async () => {});

    // Give components time to settle.
    await new Promise((r) => setTimeout(r, 200));

    // The "sharing is off" copy must be absent when global sharing is enabled.
    const offMsg = queryByText('Find Your Circle is off.');
    expect(offMsg).toBeNull();
  });
});
