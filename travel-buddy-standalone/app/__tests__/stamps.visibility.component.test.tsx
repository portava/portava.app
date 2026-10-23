/**
 * Stamps page — the detail sheet's visibility control reaches the route that
 * owns these stamps, offers only what that route accepts, says when a save is
 * refused, and its "Visibility" heading is actually on screen.
 *
 * THE DEFECTS (all on the sheet a traveller opens by tapping a stamp):
 *   1. The ids on this page come from GET /stamps/me (`user_stamps`), but the
 *      save PATCHed /me/passport/stamps/:id — the legacy `passport_stamps`
 *      route — which matched no row and answered 404.
 *   2. The failure was ignored: the tap did nothing, with no word as to why.
 *   3. "Circle" (`circle_only`) was offered; PATCH /stamps/:id/visibility
 *      accepts public | friends_only | private and refuses anything else.
 *   4. The "Visibility" heading used `rowKey`, whose `flex: 1` is meant for the
 *      label/value ROWS. In the sheet's content-sized COLUMN it is a zero
 *      flex-basis, and the heading collapsed to 0pt.
 *
 * The REAL `updateStampVisibility` runs (only `fetch` is faked), so the URL
 * and body asserted below are the ones the app sends.
 *
 * RED on the tree before this change: 2 failed / 0 passed.
 *
 * Two renders only (RNTL v14 + React 19 render-count limit).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { PassportStampNew } from '../../src/services/passportStamps.ts';

// NOTE: intentional stub — Modal's native animation lifecycle corrupts
// actScopeDepth under jest-expo; the Proxy replaces only 'Modal', every other
// react-native export falls through untouched.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react') as typeof import('react');
        return ({ children, visible }: { children: React.ReactNode; visible?: boolean }) =>
          visible ? R.createElement(target.View as React.ComponentType, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockGetMyPassportStamps = jest.fn();
jest.mock('../../src/services/passportStamps', () => ({
  ...jest.requireActual('../../src/services/passportStamps'),
  getMyPassportStamps: (...args: unknown[]) => mockGetMyPassportStamps(...args),
}));

// NOTE: intentionally exhaustive — the real hook accesses native scroll state.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller:           () => null,
}));

// NOTE: intentionally exhaustive — the real AppHeader uses reanimated.
jest.mock('../../src/components/ui/AppHeader', () => ({
  AppHeader: () => null,
}));

// NOTE: intentionally exhaustive — the real PulseFilterRail uses reanimated.
jest.mock('../../src/components/PulseFilterRail', () => ({
  PulseFilterRail: () => null,
}));

// NOTE: intentionally exhaustive — the real StampArtwork uses reanimated + SVG;
// a Pressable with the stamp's label is all the sheet needs to open.
jest.mock('../../src/components/StampArtwork', () => ({
  StampArtwork: ({ stamp, onPress }: { stamp: { label: string }; onPress?: () => void }) => {
    const R = require('react');
    const { Pressable } = require('react-native');
    return R.createElement(Pressable, { testID: `stamp-${stamp.label}`, onPress });
  },
}));

const STAMP = {
  id: 'us-1', stampDefinitionId: null, definition: null, stampType: 'city', country: 'JP', city: 'Tokyo',
  neighborhood: null, titleOverride: null, placeId: null, planId: null, tripId: null, sourceType: 'trip',
  verificationLevel: 'gps', visibility: 'public', displayOnPassport: true, isRevoked: false,
  earnedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', catalogId: null, activeArtworkUrl: null,
} as unknown as PassportStampNew;

const fetchMock = jest.fn();

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  jest.requireActual('../../src/services/passportStamps')._setTestAuthToken('tok');
});
beforeEach(() => {
  mockGetMyPassportStamps.mockResolvedValue({ ok: true, data: [STAMP], total: 1 });
  fetchMock.mockReset();
  (globalThis as any).fetch = fetchMock;
});
afterEach(async () => { await act(async () => {}); });

async function openSheet() {
  const StampsPage = require('../stamps.tsx').default;
  await render(<StampsPage />);
  await act(async () => { fireEvent.press(await screen.findByTestId('stamp-Tokyo')); });
  await waitFor(() => expect(screen.getByText('Visibility')).toBeTruthy());
}

describe('Stamps page — the visibility control', () => {
  it('heads the choices with a label that has height, offers only the server enum, and saves through /stamps/:id/visibility', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'us-1', visibility: 'friends_only' }) });
    await openSheet();

    // 4. A positive `flex` in this content-sized column is a zero flex-basis: 0pt tall.
    const label = StyleSheet.flatten(screen.getByText('Visibility').props.style) ?? {};
    expect(typeof label.flex === 'number' && label.flex > 0).toBe(false);

    // 3. Exactly the server's three, and no "Circle".
    expect(screen.getByText('Public')).toBeTruthy();
    expect(screen.getByText('Friends')).toBeTruthy();
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.queryByText('Circle')).toBeNull();

    // 1. The real service sends the save to the route that owns user_stamps.
    await act(async () => { fireEvent.press(screen.getByText('Friends')); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/stamps/us-1/visibility');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ visibility: 'friends_only' });
    expect(screen.queryByText(/Not saved/)).toBeNull();
  });

  it('a refused save is said in the sheet, not swallowed', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'not_found', message: 'Stamp not found or not yours' }) });
    await openSheet();
    await act(async () => { fireEvent.press(screen.getByText('Private')); });
    await waitFor(() => expect(screen.getByText('Not saved — this stamp keeps its current visibility. Please try again.')).toBeTruthy());
  });
});
