/**
 * locationRequestDoor — census-layover L164, §70. The one way a surface the
 * layover screen reaches may ask the phone for a location fix.
 *
 * The guard in src/lib/__tests__/layoverSensingCadence.test.ts proves WHO may
 * call the door (an enumerated press handler, nothing else on the graph). This
 * file proves what the door itself does with what it is given:
 *   1. a request naming a press and a known purpose is passed to the GPS
 *      function exactly once, and its result comes back unchanged;
 *   2. anything else — no argument, a non-press trigger, an unknown purpose, a
 *      bare string — is refused WITHOUT asking the OS anything, with the same
 *      result shape a denied permission gets;
 *   3. a refusal is a fresh object: a caller that mutates it cannot turn the
 *      next refusal into a grant.
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - door: drop the `isUserLocationRequest` refusal → 2 red (the GPS function
 *     is called for every bad request).
 *   - door: `trigger === 'user_press'` check removed → 2 red ('auto' accepted).
 *   - door: purpose check removed → 2 red ('background' accepted).
 *   - door: return NO_USER_ACTION_RESULT itself, not a copy → 3 red.
 *   - door: refuse everything (return the refusal first) → 1 red.
 */
// NOTE: intentionally exhaustive — the real module loads expo-location, whose
// native module is unavailable under jest; the door reaches only getCurrentGps.
jest.mock('../../../services/location.ts', () => ({
  getCurrentGps: jest.fn(),
}));

import { getCurrentGps } from '../../../services/location.ts';
import type { GpsResult } from '../../../services/location.ts';
import {
  LOCATION_REQUEST_PURPOSES,
  NO_USER_ACTION_RESULT,
  USER_PRESS_MAP_CONTEXT,
  isUserLocationRequest,
  requestLocationForUserAction,
} from '../locationRequestDoor.ts';

const gps = getCurrentGps as jest.MockedFunction<typeof getCurrentGps>;
const FIX: GpsResult = { granted: true, lat: 16.05, lng: 108.2, accuracyMeters: 12, cached: false };

beforeEach(() => {
  gps.mockReset();
  gps.mockResolvedValue(FIX);
});

describe('locationRequestDoor', () => {
  it('1. a press for map context asks once and returns the fix unchanged', async () => {
    const result = await requestLocationForUserAction(USER_PRESS_MAP_CONTEXT);
    expect(gps).toHaveBeenCalledTimes(1);
    expect(result).toBe(FIX);
    expect(USER_PRESS_MAP_CONTEXT).toEqual({ trigger: 'user_press', purpose: 'map_context' });
    expect(LOCATION_REQUEST_PURPOSES).toEqual(['map_context', 'live_return_assistance']);
  });

  it('1a. a press turning on live return assistance (L157) asks once and returns the fix unchanged', async () => {
    const request = { trigger: 'user_press', purpose: 'live_return_assistance' } as const;
    expect(isUserLocationRequest(request)).toBe(true);
    await expect(requestLocationForUserAction(request)).resolves.toBe(FIX);
    expect(gps).toHaveBeenCalledTimes(1);
  });

  it('1b. a denied permission from the OS comes back as the OS said it', async () => {
    const denied: GpsResult = { granted: false, lat: null, lng: null, accuracyMeters: null, error: 'permission_denied' };
    gps.mockResolvedValue(denied);
    await expect(requestLocationForUserAction({ trigger: 'user_press', purpose: 'map_context' })).resolves.toBe(denied);
  });

  it.each([
    ['no argument', undefined],
    ['null', null],
    ['a bare string', 'user_press'],
    ['an empty object', {}],
    ['an automatic trigger', { trigger: 'auto', purpose: 'map_context' }],
    ['a mount trigger', { trigger: 'mount', purpose: 'map_context' }],
    ['an unknown purpose', { trigger: 'user_press', purpose: 'background_tracking' }],
    ['live return assistance without a press', { trigger: 'auto', purpose: 'live_return_assistance' }],
    ['a purpose with no trigger', { purpose: 'map_context' }],
  ])('2. %s is refused without asking the OS', async (_label, request) => {
    const result = await requestLocationForUserAction(request as never);
    expect(gps).not.toHaveBeenCalled();
    expect(result).toEqual({ granted: false, lat: null, lng: null, accuracyMeters: null, error: 'no_user_action' });
    expect(isUserLocationRequest(request)).toBe(false);
  });

  it('3. a refusal is a fresh object — mutating one does not change the next', async () => {
    const first = await requestLocationForUserAction(undefined as never);
    expect(first).not.toBe(NO_USER_ACTION_RESULT);
    (first as { granted: boolean }).granted = true;
    const second = await requestLocationForUserAction(undefined as never);
    expect(second.granted).toBe(false);
    expect(NO_USER_ACTION_RESULT.granted).toBe(false);
    expect(gps).not.toHaveBeenCalled();
  });
});
