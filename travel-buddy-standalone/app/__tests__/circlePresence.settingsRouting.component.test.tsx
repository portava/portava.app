/**
 * circle-presence.tsx — goToSettings routing tests.
 *
 * Confirms the state-aware routing fix:
 *   - sharing_off "Open settings" → /profile/edit/location   (global toggle is off)
 *   - contextPaused "Resume"      → /circle-context-settings (per-context override)
 *   - globalPaused  "Resume"      → /circle-context-settings (global pause override)
 *   - Settings icon (main screen) → /circle-context-settings NOT /profile/edit/location
 *
 * Each scenario gets its own fresh render; assertions are router.push mock-call
 * checks (not visual commits) so they survive the React 19 visual-commit wall.
 * No fake timers — per React 19 renderer budget rule.
 *
 * Run: pnpm --dir travel-buddy-standalone run test:component
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// ── expo-router ────────────────────────────────────────────────────────────────
// NOTE: intentional stub — only router.push, useLocalSearchParams, and
// useFocusEffect are used by circle-presence; exhaustive spread would pull in
// Link and other navigation components that are unused here.
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({
    contextType: 'trip',
    contextId:   'ctx-123',
    contextLabel: 'Bali Trip',
  }),
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
}));

// ── safe-area ──────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-location ──────────────────────────────────────────────────────────────
// NOTE: intentional stub — only permission status matters; no location API is
// exercised in these routing tests.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
}));

// ── circle services ───────────────────────────────────────────────────────────
const mockGetCircleSettings        = jest.fn();
const mockGetCircleContextSettings = jest.fn();
const mockGetCircleMembers         = jest.fn();
const mockGetMyPresence            = jest.fn();
const mockGetMeetingPoint          = jest.fn();

// NOTE: intentional stub — only the fields read in circle-presence.tsx are
// returned; exhaustive real service import is not needed for routing tests.
jest.mock('../../src/services/circle', () => ({
  getCircleSettings:        (...a: unknown[]) => mockGetCircleSettings(...a),
  getCircleContextSettings: (...a: unknown[]) => mockGetCircleContextSettings(...a),
  getCircleMembers:         (...a: unknown[]) => mockGetCircleMembers(...a),
  getMyPresence:            (...a: unknown[]) => mockGetMyPresence(...a),
  getMeetingPoint:          (...a: unknown[]) => mockGetMeetingPoint(...a),
}));

// ── SessionContext ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — userId is required to bootstrap; value is not
// relevant to settings routing.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'viewer-uid' }),
}));

// ── useBottomInset ─────────────────────────────────────────────────────────────
// NOTE: intentional stub — inset value does not affect routing logic.
jest.mock('../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 34,
}));

// ── UI component stubs ────────────────────────────────────────────────────────
// NOTE: intentional stub — these child components are irrelevant to the
// goToSettings routing assertion; nulling them avoids cascading mock chains.
jest.mock('../../src/components/ui/AppHeader', () => ({
  AppHeader: () => null,
}));
// NOTE: intentional stub — SafeReturn sheet is not opened in routing tests.
jest.mock('../../src/components/safeReturn/SafeReturnSetupSheet', () => ({
  SafeReturnSetupSheet: () => null,
}));
// NOTE: intentional stub — CircleMemberRow renders member details unrelated to routing.
jest.mock('../../src/components/circle/CircleMemberRow', () => ({
  CircleMemberRow: () => null,
}));
// NOTE: intentional stub — CheckInActions renders context-specific actions unrelated to routing.
jest.mock('../../src/components/circle/CheckInActions', () => ({
  CheckInActions: () => null,
}));
jest.mock('../../src/components/circle/MeetingPointCard', () => ({
  MeetingPointCard: () => null,
}));
// NOTE: intentional stub — CircleMapSection renders a map irrelevant to routing.
jest.mock('../../src/components/circle/CircleMapSection', () => ({
  CircleMapSection: () => null,
}));

import CirclePresenceScreen from '../circle-presence';

// ── Shared response helpers ────────────────────────────────────────────────────

/** Minimal members response that lets load() pass the 503/403/error guards. */
const MEMBERS_OK = { ok: true as const, data: { members: [] } };
/** Silence optional endpoints that aren't relevant to these tests. */
const NOT_OK     = { ok: false as const, status: 500, error: 'err' };

function mockMainScreen({ globalPaused = false, contextPaused = false } = {}) {
  mockGetCircleSettings.mockResolvedValue({
    ok: true, data: { globalEnabled: true, isPaused: globalPaused },
  });
  mockGetCircleContextSettings.mockResolvedValue({
    ok: true, data: { paused: contextPaused },
  });
  mockGetCircleMembers.mockResolvedValue(MEMBERS_OK);
  mockGetMyPresence.mockResolvedValue(NOT_OK);
  mockGetMeetingPoint.mockResolvedValue(NOT_OK);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('circle-presence goToSettings — state-aware routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sharing_off "Open settings" routes to /profile/edit/location', async () => {
    // Global toggle off → load() sets screenState = 'sharing_off'.
    mockGetCircleSettings.mockResolvedValue({
      ok: true, data: { globalEnabled: false, isPaused: false },
    });
    mockGetCircleContextSettings.mockResolvedValue(NOT_OK);
    mockGetCircleMembers.mockResolvedValue(MEMBERS_OK);
    mockGetMyPresence.mockResolvedValue(NOT_OK);
    mockGetMeetingPoint.mockResolvedValue(NOT_OK);

    await render(<CirclePresenceScreen />);

    // Wait for load() to complete and the sharing_off state to render.
    await waitFor(() => {
      expect(screen.getByText('Open settings')).toBeTruthy();
    });

    fireEvent.press(screen.getByText('Open settings'));

    // Must route to the GLOBAL location settings — only place the global
    // Find Your Circle toggle can be turned on.
    expect(mockRouterPush).toHaveBeenCalledWith('/profile/edit/location');
    expect(mockRouterPush).not.toHaveBeenCalledWith('/circle-context-settings');
  });

  it('contextPaused "Resume" routes to /circle-context-settings with required params', async () => {
    // Global sharing enabled; per-context paused → contextPaused banner shown.
    // circle-context-settings requires contextType + contextId + contextLabel as
    // route params to load the correct per-context settings; missing params cause
    // it to exit early without loading any data.
    mockMainScreen({ contextPaused: true });

    await render(<CirclePresenceScreen />);

    await waitFor(() => {
      expect(screen.getByText(/Sharing paused for this trip/i)).toBeTruthy();
    });

    fireEvent.press(screen.getByText('Resume'));

    // Must include the context params so circle-context-settings can load.
    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/circle-context-settings',
      params: { contextType: 'trip', contextId: 'ctx-123', contextLabel: 'Bali Trip' },
    });
    expect(mockRouterPush).not.toHaveBeenCalledWith('/profile/edit/location');
  });

  it('globalPaused "Resume" routes to /circle-context-settings with required params', async () => {
    // Global sharing enabled but globally paused → globalPaused banner shown.
    mockMainScreen({ globalPaused: true });

    await render(<CirclePresenceScreen />);

    await waitFor(() => {
      expect(screen.getByText(/Sharing paused\. Others can't see your status/i)).toBeTruthy();
    });

    fireEvent.press(screen.getByText('Resume'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/circle-context-settings',
      params: { contextType: 'trip', contextId: 'ctx-123', contextLabel: 'Bali Trip' },
    });
    expect(mockRouterPush).not.toHaveBeenCalledWith('/profile/edit/location');
  });

  it('settings icon on main screen routes to /circle-context-settings with required params', async () => {
    // Normal main screen (no pauses) — the "You aren't sharing yet." Settings
    // link calls goToSettings(); must pass context params for the destination
    // screen to load correctly.
    mockMainScreen();

    await render(<CirclePresenceScreen />);

    // The not-sharing row shows "Settings" when viewerPresence is null (NOT_OK).
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeTruthy();
    });

    fireEvent.press(screen.getByText('Settings'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/circle-context-settings',
      params: { contextType: 'trip', contextId: 'ctx-123', contextLabel: 'Bali Trip' },
    });
    expect(mockRouterPush).not.toHaveBeenCalledWith('/profile/edit/location');
  });
});
