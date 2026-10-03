/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, sweep, D-W11X2-118): the Circle screen never says
 * "Find Your Circle disabled." over a read that failed.
 *
 * `circle-presence.tsx` treated ANY 503 from the members read as the feature being off. The circle routes
 * answer 503 `degraded_unavailable` when a membership or consent read fails (routes/circle.ts,
 * CircleReadUnavailableError) and — since §111 — when `find_your_circle_enabled` itself could not be read, so
 * an outage was stated as "This feature isn't available yet". Only the route's `feature_disabled` answer is
 * that; a 503 is the retryable "Couldn't load Circle.".
 *
 *   CP1  the members read answers 503 degraded_unavailable → "Couldn't load Circle." with Retry, never "disabled"
 *   CP2  the members read answers 503 degraded_unavailable / flag_unreadable → the same
 *   CPc  CONTROL: the members read answers 404 feature_disabled → "Find Your Circle disabled."
 *
 * Harness copied from circlePresence.settingsRouting.component.test.tsx.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

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

const NOT_OK = { ok: false as const, status: 500, error: 'err' };
function mockWith(members: unknown) {
  mockGetCircleSettings.mockResolvedValue({ ok: true, data: { globalEnabled: true, isPaused: false } });
  mockGetCircleContextSettings.mockResolvedValue(NOT_OK);
  mockGetCircleMembers.mockResolvedValue(members);
  mockGetMyPresence.mockResolvedValue(NOT_OK);
  mockGetMeetingPoint.mockResolvedValue(NOT_OK);
}

describe('circle-presence over a read that failed (§111, D-W11X2-118)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('CP1 a 503 degraded_unavailable members read → "Couldn\'t load Circle." with Retry, never "disabled"', async () => {
    mockWith({ ok: false, status: 503, error: 'degraded_unavailable' });
    await render(<CirclePresenceScreen />);
    await waitFor(() => { expect(screen.getByText("Couldn't load Circle.")).toBeTruthy(); });
    expect(screen.queryByText('Find Your Circle disabled.')).toBeNull();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('CP2 a 503 flag_unreadable members read → the same', async () => {
    mockWith({ ok: false, status: 503, error: 'degraded_unavailable', reason: 'flag_unreadable' });
    await render(<CirclePresenceScreen />);
    await waitFor(() => { expect(screen.getByText("Couldn't load Circle.")).toBeTruthy(); });
    expect(screen.queryByText('Find Your Circle disabled.')).toBeNull();
  });

  it('CPc CONTROL: a 404 feature_disabled members read → "Find Your Circle disabled."', async () => {
    mockWith({ ok: false, status: 404, error: 'feature_disabled' });
    await render(<CirclePresenceScreen />);
    await waitFor(() => { expect(screen.getByText('Find Your Circle disabled.')).toBeTruthy(); });
  });
});
