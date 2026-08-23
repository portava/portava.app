/**
 * LocationAvailabilityScreen — Journey Privacy consent UI.
 *
 * The backend (journey_observation_v1, PATCH /api/me/location-preferences,
 * set_journey_observation_consent_v1) was already built and fully guarded
 * server-side; this covers the mobile-side wiring added in
 * src/services/map.ts (LocationPrivacy.journeyObservationEnabled + friends)
 * and the Journey Privacy toggle in this screen:
 *
 *   - starts off, gated on an eligible location mode + unpaused sharing
 *   - explicit opt-in sends the correct patch and reflects server-granted state
 *   - revoke (turning the toggle off) sends the correct patch
 *   - pausing sharing implicitly revokes consent server-side — the screen must
 *     re-read authoritative state rather than optimistically assume the
 *     toggle stays on
 *   - a failed save does not display false consent state (rolls back, alerts)
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { getMyLocationPrivacy, updateMyLocationPrivacy } from '../../../../src/services/map.ts';
import { getCircleSettings } from '../../../../src/services/circle.ts';
import LocationAvailabilityScreen from '../location.tsx';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here; signed out skips Find Your
// Circle entirely so this test only needs to mock the location-privacy calls.
jest.mock('../../../../src/context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'user-1', isAuthed: false, configured: true }),
}));

jest.mock('../../../../src/services/map.ts', () => ({
  ...jest.requireActual('../../../../src/services/map.ts'),
  getMyLocationPrivacy: jest.fn(),
  updateMyLocationPrivacy: jest.fn(),
}));

// NOTE: intentionally exhaustive: Find Your Circle is out of scope for this
// Journey Privacy test — useSession() is mocked signed-out so the screen
// never calls these, but they must exist to satisfy the module's exports.
jest.mock('../../../../src/services/circle.ts', () => ({
  getCircleSettings: jest.fn(),
  patchCircleSettings: jest.fn(),
  pauseAllCircleSharing: jest.fn(),
}));

const mockGetPrivacy = getMyLocationPrivacy as jest.Mock;
const mockUpdatePrivacy = updateMyLocationPrivacy as jest.Mock;
const mockGetCircle = getCircleSettings as jest.Mock;

function prefs(overrides: Record<string, unknown> = {}) {
  return {
    locationMode: 'city_only',
    sharingPaused: false,
    pulseVisibility: null,
    discoveryVisibility: null,
    safeReturnEnabled: true,
    trustedCircleShare: false,
    hotelBlurEnabled: true,
    journeyObservationEnabled: false,
    journeyConsentScope: null,
    journeyConsentVersion: null,
    journeyConsentGrantedAt: null,
    journeyConsentRevokedAt: null,
    ...overrides,
  };
}

describe('LocationAvailabilityScreen — Journey Privacy', () => {
  beforeEach(() => {
    mockGetCircle.mockResolvedValue({ ok: false, status: 401 });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('gates on eligibility, grants, reflects a pause-triggered revocation, and never shows false state on failure', async () => {
    // Not eligible yet: default mode is city_only.
    mockGetPrivacy.mockResolvedValueOnce(prefs());

    await render(<LocationAvailabilityScreen />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Journey observation' })).toBeTruthy());

    const journeySwitch = screen.getByRole('switch', { name: 'Journey observation' });
    expect(journeySwitch.props.disabled).toBe(true);
    expect(screen.getByText(/Requires Location Mode set to "Live during activity"/)).toBeTruthy();

    // Move to an eligible mode via the existing Location Mode picker — Journey
    // Privacy reuses this control rather than duplicating a mode selector.
    mockUpdatePrivacy.mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'City only' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('radio', { name: /Live during activity/ }));
    });
    await waitFor(() => expect(mockUpdatePrivacy).toHaveBeenCalledWith({ locationMode: 'live_during_activity' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Journey observation' }).props.disabled).not.toBe(true));

    // Explicit opt-in.
    const granted = prefs({
      locationMode: 'live_during_activity',
      journeyObservationEnabled: true,
      journeyConsentScope: 'journey_observation_v1',
      journeyConsentVersion: 1,
      journeyConsentGrantedAt: '2026-08-21T00:00:00.000Z',
    });
    mockUpdatePrivacy.mockResolvedValueOnce(true);
    mockGetPrivacy.mockResolvedValueOnce(granted);
    await act(async () => {
      fireEvent(screen.getByRole('switch', { name: 'Journey observation' }), 'valueChange', true);
    });
    await waitFor(() => expect(mockUpdatePrivacy).toHaveBeenCalledWith({ journeyObservationEnabled: true }));
    // The grant timestamp/scope are server-stamped — the screen must re-read
    // them (getMyLocationPrivacy called again) rather than guess locally.
    await waitFor(() => expect(mockGetPrivacy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/On — granted/)).toBeTruthy());

    // Explicit revoke — the user directly turns Journey observation off while
    // still eligible (distinct from the pause-triggered implicit revoke
    // below): the toggle itself must send journeyObservationEnabled:false.
    const revoked = prefs({
      locationMode: 'live_during_activity',
      journeyConsentScope: 'journey_observation_v1',
      journeyConsentVersion: 1,
      journeyConsentGrantedAt: '2026-08-21T00:00:00.000Z',
      journeyConsentRevokedAt: '2026-08-21T00:01:00.000Z',
    });
    mockUpdatePrivacy.mockResolvedValueOnce(true);
    mockGetPrivacy.mockResolvedValueOnce(revoked);
    await act(async () => {
      fireEvent(screen.getByRole('switch', { name: 'Journey observation' }), 'valueChange', false);
    });
    await waitFor(() => expect(mockUpdatePrivacy).toHaveBeenCalledWith({ journeyObservationEnabled: false }));
    await waitFor(() => expect(mockGetPrivacy).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Journey observation' }).props.value).toBe(false));
    expect(screen.queryByText(/On — granted/)).toBeNull();

    // Re-grant so the pause-cascade case below starts from an "on" state.
    mockUpdatePrivacy.mockResolvedValueOnce(true);
    mockGetPrivacy.mockResolvedValueOnce(granted);
    await act(async () => {
      fireEvent(screen.getByRole('switch', { name: 'Journey observation' }), 'valueChange', true);
    });
    await waitFor(() => expect(mockGetPrivacy).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getByText(/On — granted/)).toBeTruthy());

    // Pausing sharing is a documented consent-revoking action (see
    // revokesJourneyConsent) — the server turns Journey off as a side effect
    // even though the patch itself only set sharingPaused. The screen must
    // re-read authoritative state, not keep the optimistic "On".
    const pausedAndRevoked = prefs({
      locationMode: 'live_during_activity',
      sharingPaused: true,
      journeyObservationEnabled: false,
      journeyConsentGrantedAt: '2026-08-21T00:00:00.000Z',
      journeyConsentRevokedAt: '2026-08-21T00:05:00.000Z',
    });
    mockUpdatePrivacy.mockResolvedValueOnce(true);
    mockGetPrivacy.mockResolvedValueOnce(pausedAndRevoked);
    await act(async () => {
      fireEvent(screen.getByRole('switch', { name: 'Pause sharing' }), 'valueChange', true);
    });
    await waitFor(() => expect(mockUpdatePrivacy).toHaveBeenCalledWith({ sharingPaused: true }));
    await waitFor(() => expect(mockGetPrivacy).toHaveBeenCalledTimes(5));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Journey observation' }).props.value).toBe(false));

    // Unpause (never re-grants consent by itself, so no reconciliation read is
    // needed here — only revocation is a side effect of other patches), then
    // verify a failed save does not show false "on" success — it must roll
    // back and alert instead.
    mockUpdatePrivacy.mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent(screen.getByRole('switch', { name: 'Pause sharing' }), 'valueChange', false);
    });
    await waitFor(() => expect(mockUpdatePrivacy).toHaveBeenCalledWith({ sharingPaused: false }));

    mockUpdatePrivacy.mockResolvedValueOnce(false);
    await act(async () => {
      fireEvent(screen.getByRole('switch', { name: 'Journey observation' }), 'valueChange', true);
    });
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Save failed', expect.any(String)));
    // Rolled back — never displays a false "granted" state after a failure.
    expect(screen.getByRole('switch', { name: 'Journey observation' }).props.value).toBe(false);
    expect(screen.queryByText(/On — granted/)).toBeNull();
  });
});
