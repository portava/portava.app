/**
 * passportNav — the single source of Passport routes (F6 + §2 viewer nav).
 *
 *   • openAvailabilityEditor pushes the ONE editor route (F6).
 *   • Viewer hrefs carry `?userId=` with the exact param name the route
 *     wrappers read, encode safely, and omit the param for the owner.
 *   • journeysHref can focus one trip (stamp → Journey, §13).
 *   • readViewerUserParam normalises the raw param (strips '@', rejects junk).
 *
 * Runs under jest so `expo-router` resolves to the manual mock; `router.push`
 * is re-mocked as a spy here.
 */
import { router } from 'expo-router';
import {
  PASSPORT_AVAILABILITY_ROUTE,
  VIEWER_USER_PARAM,
  journeysHref,
  myWorldHref,
  openAvailabilityEditor,
  readViewerUserParam,
  travelIdentityHref,
  trustHref,
} from '../passportNav.ts';

// NOTE: intentionally exhaustive — expo-router needs Expo native navigation
// modules unavailable in jest-expo; only `router.push` is exercised here.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
}));

const mockPush = router.push as jest.Mock;

describe('passportNav', () => {
  beforeEach(() => mockPush.mockClear());

  it('openAvailabilityEditor pushes the single availability editor (F6)', () => {
    openAvailabilityEditor();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/passport/availability');
    expect(PASSPORT_AVAILABILITY_ROUTE).toBe('/passport/availability');
  });

  it('viewer hrefs carry the userId param the route wrappers read; owner hrefs carry none', () => {
    expect(VIEWER_USER_PARAM).toBe('userId');
    expect(trustHref('u-1')).toBe('/passport/trust?userId=u-1');
    expect(journeysHref('u-1')).toBe('/passport/journeys?userId=u-1');
    expect(travelIdentityHref('u-1')).toBe('/passport/travel-identity?userId=u-1');

    expect(trustHref()).toBe('/passport/trust');
    expect(trustHref(null)).toBe('/passport/trust');
    expect(journeysHref(undefined)).toBe('/passport/journeys');
    expect(travelIdentityHref('')).toBe('/passport/travel-identity');
    expect(myWorldHref()).toBe('/passport/my-world');
  });

  it('encodes handles and ids safely', () => {
    expect(trustHref('@mai tran')).toBe('/passport/trust?userId=%40mai%20tran');
  });

  it('journeysHref can focus a trip, for the owner and for a viewer', () => {
    expect(journeysHref(null, 'trip-9')).toBe('/passport/journeys?tripId=trip-9');
    expect(journeysHref('u-1', 'trip-9')).toBe('/passport/journeys?userId=u-1&tripId=trip-9');
    expect(journeysHref('u-1', null)).toBe('/passport/journeys?userId=u-1');
  });

  it('readViewerUserParam strips a leading @ and rejects non-strings / blanks', () => {
    expect(readViewerUserParam('@mai')).toBe('mai');
    expect(readViewerUserParam('  u-1 ')).toBe('u-1');
    expect(readViewerUserParam('')).toBeNull();
    expect(readViewerUserParam('   ')).toBeNull();
    expect(readViewerUserParam(undefined)).toBeNull();
    expect(readViewerUserParam(['a'])).toBeNull();
    expect(readViewerUserParam(42)).toBeNull();
  });
});
