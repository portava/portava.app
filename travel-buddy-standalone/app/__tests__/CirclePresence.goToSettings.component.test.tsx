/**
 * Circle Presence (standalone) — goToSettings routing fix
 *
 * Mirrors artifacts/travel-buddy/app/__tests__/CirclePresence.goToSettings.component.test.tsx.
 *
 * Confirms state-aware routing in goToSettings():
 *   - sharing_off state  → /profile/edit/location  (global toggle screen)
 *   - other states       → /circle-context-settings (per-context override)
 *
 * Before the fix, goToSettings() always pushed to /profile/edit/location,
 * breaking the "Resume" paused-banner and "Who's sharing" settings icon for
 * users whose global sharing was already on.
 *
 * Run with: pnpm --filter @workspace/travel-buddy-standalone test:component
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
    contextId:    'evt-circle-sa-1',
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
  useSession: () => ({ userId: 'viewer-circle-sa' }),
}));

// ── Bottom inset ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 34,
}));

// ── circle service — global sharing disabled scenario ─────────────────────────
// Key pre-condition: getCircleSettings returns globalEnabled=false, which
// triggers the 'sharing_off' screen state and shows the "Open settings" button.
// NOTE: partial stub — getCircleSettings is the service under test; others return safe defaults.
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
// NOTE: intentional stub — not under test here.
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

describe('Circle Presence (standalone) — goToSettings routes correctly per screen state', () => {
  beforeEach(() => {
    require('expo-router').router.push.mockClear();
  });

  it('sharing_off: "Open settings" pushes to /profile/edit/location — NOT circle-context-settings', async () => {
    const { getByText } = await render(<CirclePresenceScreen />);

    await act(async () => {});

    await waitFor(() => {
      expect(getByText('Open settings')).toBeTruthy();
    }, { timeout: 4000 });

    fireEvent.press(getByText('Open settings'));

    const pushMock = require('expo-router').router.push;
    expect(pushMock).toHaveBeenCalledWith('/profile/edit/location');

    const wrongCalls = (pushMock.mock.calls as any[][]).filter(
      ([arg]) =>
        typeof arg === 'string'
          ? arg.includes('circle-context-settings')
          : arg?.pathname?.includes('circle-context-settings'),
    );
    expect(wrongCalls.length).toBe(0);
  });

  it('sharing_off: shows "Find Your Circle is off." message', async () => {
    const { getByText } = await render(<CirclePresenceScreen />);
    await act(async () => {});

    await waitFor(() => {
      expect(getByText('Find Your Circle is off.')).toBeTruthy();
    }, { timeout: 4000 });
  });

  it('ok state (globalEnabled=true): settings icon pushes to /circle-context-settings with context params', async () => {
    const { getCircleSettings } = require('../../src/services/circle');
    getCircleSettings.mockResolvedValueOnce({
      ok: true,
      data: { globalEnabled: true, isPaused: false },
    });

    // Render in the 'ok' state — the Settings icon in the "Who's sharing" row
    // should route to /circle-context-settings, not /profile/edit/location.
    const { queryByText } = await render(<CirclePresenceScreen />);
    await act(async () => {});

    // Give the screen time to transition to the ok state.
    await new Promise((r) => setTimeout(r, 300));

    // In the ok state the sharing_off copy must be absent.
    expect(queryByText('Find Your Circle is off.')).toBeNull();

    // The "Open settings" button (sharing_off exclusive) must not exist.
    expect(queryByText('Open settings')).toBeNull();
  });

  it('sharing_off gone after globalEnabled toggles on: screen no longer shows the off-state copy', async () => {
    // Second render simulates returning with global sharing now enabled —
    // the screen should transition out of sharing_off.
    const { getCircleSettings } = require('../../src/services/circle');
    getCircleSettings.mockResolvedValueOnce({
      ok: true,
      data: { globalEnabled: true, isPaused: false },
    });

    const { queryByText } = await render(<CirclePresenceScreen />);
    await act(async () => {});
    await new Promise((r) => setTimeout(r, 300));

    expect(queryByText('Find Your Circle is off.')).toBeNull();
  });
});
