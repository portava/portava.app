/**
 * circle-presence — goToSettings routing branches.
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 *  1. When screenState is 'sharing_off' (global Find Your Circle toggle is
 *     off), tapping "Open settings" routes to /profile/edit/location so the
 *     user can enable the global switch — NOT to /circle-context-settings,
 *     which can only override an already-enabled global switch.
 *
 *  2. When the user is in the main screen ('ok') with contextPaused=true,
 *     tapping "Resume" routes to /circle-context-settings with the correct
 *     contextType / contextId / contextLabel params so the per-context
 *     override can be cleared.
 *
 * ## FlatList strategy
 *
 * The main-screen body (lists, pause banners) lives inside a FlatList's
 * ListHeaderComponent.  FlatList under Jest has a 0-height window and never
 * paints off-screen rows.  We replace it with a function component that
 * renders only its ListHeaderComponent prop so the pause banner and settings
 * icon are reachable with fireEvent.
 *
 * ## React 19 / RNTL
 * renderHook/render are async — always await.  One press per test body.
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import CirclePresenceScreen from '../circle-presence.tsx';

// NOTE: intentionally exhaustive — expo-router is bound to a running Router
// context unavailable under Jest; stub only the three exports the screen uses.
// jest.fn() lives inside the factory (not as a const) so the hoisted call has
// access to it — external const refs are undefined when hoisting runs.
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: jest.fn(),
  useFocusEffect: jest.fn(),
}));

// NOTE: intentionally exhaustive — the circle service imports the Supabase
// client and makes real HTTP calls; only the five functions the screen calls
// are needed here.
jest.mock('../../src/services/circle', () => ({
  getCircleSettings:        jest.fn(),
  getCircleContextSettings: jest.fn(),
  getCircleMembers:         jest.fn(),
  getMyPresence:            jest.fn(),
  getMeetingPoint:          jest.fn(),
}));

// NOTE: intentionally exhaustive — SessionContext pulls in Supabase, AppState,
// and async service calls at module load; only userId is needed here.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: jest.fn(() => ({ userId: 'user-abc' })),
}));

// ── expo-location ─────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — expo-location uses native modules that
// are unavailable under Jest; return 'granted' so the location-perm banner
// stays hidden and doesn't complicate the rendered tree.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
}));

// ── Heavy UI components ───────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — these components import native modules
// (maps, camera, safe-area) that crash under jest-expo; simple View stubs are
// sufficient for the routing assertions we need to make.
jest.mock('../../src/components/ui/AppHeader', () => ({
  AppHeader: () => null,
}));

// NOTE: intentionally exhaustive — CircleMapSection imports react-native-maps
// which has native bridge requirements; a null stub prevents the crash.
jest.mock('../../src/components/circle/CircleMapSection', () => ({
  CircleMapSection: () => null,
}));

// NOTE: intentionally exhaustive — CircleMemberRow imports expo-image and
// native font loaders; null stub prevents cascade failures.
jest.mock('../../src/components/circle/CircleMemberRow', () => ({
  CircleMemberRow: () => null,
}));

// NOTE: intentionally exhaustive — CheckInActions imports expo-location and
// other native modules; null stub keeps the rendered tree minimal.
jest.mock('../../src/components/circle/CheckInActions', () => ({
  CheckInActions: () => null,
}));

// NOTE: intentionally exhaustive — MeetingPointCard imports native map and
// location modules; null stub avoids native bridge calls.
jest.mock('../../src/components/circle/MeetingPointCard', () => ({
  MeetingPointCard: () => null,
}));

// NOTE: intentionally exhaustive — SafeReturnSetupSheet imports react-native-
// maps and native camera; null stub keeps the tree render-safe.
jest.mock('../../src/components/safeReturn/SafeReturnSetupSheet', () => ({
  SafeReturnSetupSheet: () => null,
}));

// NOTE: intentionally exhaustive — useBottomInset reads safe-area context
// internals; return a stable 0 so layout constants don't crash.
jest.mock('../../src/hooks/useBottomInset', () => ({
  usePlainBottomInset: () => 0,
}));

// ── Mock references (obtained after jest.mock hoisting) ───────────────────────

import {
  router,
  useLocalSearchParams,
  useFocusEffect,
} from 'expo-router';
import {
  getCircleSettings,
  getCircleContextSettings,
  getCircleMembers,
  getMyPresence,
  getMeetingPoint,
} from '../../src/services/circle';

const mockRouterPush            = jest.mocked(router.push);
const mockGetCircleSettings     = jest.mocked(getCircleSettings);
const mockGetCtxSettings        = jest.mocked(getCircleContextSettings);
const mockGetCircleMembers      = jest.mocked(getCircleMembers);
const mockGetMyPresence         = jest.mocked(getMyPresence);
const mockGetMeetingPoint       = jest.mocked(getMeetingPoint);

// ── helpers ───────────────────────────────────────────────────────────────────

const BASE_PARAMS = {
  contextType:  'trip',
  contextId:    'trip-uuid-1',
  contextLabel: 'Cebu Road Trip',
};

function setupParams(overrides: Record<string, string> = {}) {
  jest.mocked(useLocalSearchParams).mockReturnValue({ ...BASE_PARAMS, ...overrides });
  jest.mocked(useFocusEffect).mockImplementation(() => {});
}

/** Render the screen and wait for all async effects to settle. */
async function mountScreen() {
  const result = await render(<CirclePresenceScreen />);
  await act(async () => {});
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CirclePresenceScreen — goToSettings routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: successful members fetch so the screen doesn't error
    (mockGetCircleMembers as jest.Mock).mockResolvedValue({ ok: true, data: { members: [] } });
    (mockGetMyPresence as jest.Mock).mockResolvedValue({ ok: false });
    (mockGetMeetingPoint as jest.Mock).mockResolvedValue({ ok: false });
    (mockGetCtxSettings as jest.Mock).mockResolvedValue({ ok: true, data: { paused: false } });
  });

  it("routes to /profile/edit/location when screenState is 'sharing_off'", async () => {
    setupParams();
    // Global toggle disabled → sharing_off state
    (mockGetCircleSettings as jest.Mock).mockResolvedValue({
      ok: true,
      data: { globalEnabled: false, isPaused: false },
    });

    const { getByText } = await mountScreen();

    await waitFor(() => expect(getByText('Open settings')).toBeTruthy(), { timeout: 2000 });

    fireEvent.press(getByText('Open settings'));

    expect(mockRouterPush).toHaveBeenCalledWith('/profile/edit/location');
    expect(mockRouterPush).not.toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/circle-context-settings' }),
    );
  });

  it("routes to /circle-context-settings with params when contextPaused and not sharing_off", async () => {
    setupParams();
    // Global toggle enabled, context paused → ok state + contextPaused=true
    (mockGetCircleSettings as jest.Mock).mockResolvedValue({
      ok: true,
      data: { globalEnabled: true, isPaused: false },
    });
    (mockGetCtxSettings as jest.Mock).mockResolvedValue({
      ok: true,
      data: { paused: true },
    });

    const { getByText } = await mountScreen();

    // The pause banner ("Sharing paused for this trip. Resume") is in the
    // FlatList ListHeaderComponent; RNTL renders it regardless of scroll.
    await waitFor(() => expect(getByText('Resume')).toBeTruthy(), { timeout: 2000 });

    fireEvent.press(getByText('Resume'));

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/circle-context-settings',
      params: {
        contextType:  'trip',
        contextId:    'trip-uuid-1',
        contextLabel: 'Cebu Road Trip',
      },
    });
    expect(mockRouterPush).not.toHaveBeenCalledWith('/profile/edit/location');
  });
});
