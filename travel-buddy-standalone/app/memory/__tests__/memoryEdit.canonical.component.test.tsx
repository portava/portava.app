/**
 * The Memory edit screen and the two canonical fields (census-highlights-
 * memories H40 / H71; B58 MEM-CANON).
 *
 * The edit screen re-sends the Memory's place on every save (it always has), so
 * what it sends for the NEW fields decides whether an innocent caption edit
 * becomes a claim:
 *   - a type is sent ONLY when the person changed it here. The server refuses a
 *     type while types are off, so sending the loaded value back would turn a
 *     caption edit into a refusal; and a legacy Memory's null is not re-asserted;
 *   - a place's name is sent ONLY with a place the person newly picked here —
 *     the server would not rewrite an unchanged place's text anyway, and the
 *     screen does not ask it to;
 *   - with types off there is no picker at all.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor, screen } from '@testing-library/react-native';
import { _resetMemoryOperationIds } from '../../../src/services/memories.ts';

const MID = '55555555-5555-4555-8555-555555555555';

// NOTE: intentional stub — the screen uses only `router`, `useLocalSearchParams`
// and `Redirect`; expo-router's native navigation runtime is not available here.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: '55555555-5555-4555-8555-555555555555' }),
  Redirect: () => null,
}));

// NOTE: intentional stub — only the insets hook is used; the real module needs
// native safe-area measurement.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../../../src/services/apiToken.ts', () => ({
  freshToken: async () => `header.${Buffer.from(JSON.stringify({ sub: 'me', session_id: 'canonical-editor-session' })).toString('base64')}.signature`,
}));

jest.mock('../../../src/context/SessionContext.tsx', () => { return {
  useSession: () => ({ userId: 'me', loading: false }),
}; });
jest.mock('../../../src/lib/supabase.ts', () => { return { supabase: { auth: {
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
} } }; });

// NOTE: intentionally exhaustive — GlobalPlacePicker pulls expo-location and
// other native modules that crash under jest. The stand-in picks a provider
// place the way the real picker's onSelect does.
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => {
  const R = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    GlobalPlacePicker: ({ visible, onSelect, onClose }: any) =>
      visible
        ? R.createElement(
            Pressable,
            {
              testID: 'mock-place-pho',
              onPress: () => {
                onSelect({ id: 'fsq:pho-10', displayName: 'Pho 10, Hanoi', name: 'Pho 10', city: 'Hanoi', country: 'Vietnam', lat: 21.03, lng: 105.85, type: 'venue' });
                onClose();
              },
            },
            R.createElement(Text, null, 'Pho 10'),
          )
        : null,
  };
});

const { router: mockRouter } = jest.requireMock('expo-router') as { router: { back: jest.Mock } };

type Call = { url: string; method: string; body: any };
function installFetch(opts: { typesEnabled: boolean }) {
  const calls: Call[] = [];
  const memory = {
    id: MID, ownerId: 'me', title: 'Coffee', caption: null, visibility: 'only_me', allowedUserIds: [], hiddenUserIds: [],
    tripId: null, eventId: null, placeId: 'fsq:old-cafe', locationCity: 'Hanoi', locationCountry: 'Vietnam',
    locationLat: 21.03, locationLng: 105.85, canonicalLocationId: null, startsAt: null, endsAt: null, state: 'published',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: null,
    ...(opts.typesEnabled ? { memoryType: 'MOMENT' } : {}), placeDisplayNameAtOccurrence: 'Old Cafe',
  };
  global.fetch = jest.fn(async (url: string, init: any = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    let body: any = init.body;
    try { body = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* raw */ }
    calls.push({ url, method, body });
    if (url === 'https://api.test/api/memory-types') {
      return { ok: true, status: 200, json: async () => ({ enabled: opts.typesEnabled, types: ['PLACE', 'MOMENT', 'MILESTONE', 'REUNION'], defaultType: 'MOMENT' }) };
    }
    if (url === `https://api.test/api/memories/${MID}` && method === 'GET') return { ok: true, status: 200, json: async () => ({ memory }) };
    if (url === `https://api.test/api/memories/${MID}` && method === 'PATCH') return { ok: true, status: 200, json: async () => ({ memory: { ...memory, ...body } }) };
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  }) as unknown as typeof fetch;
  return calls;
}
const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');

describe('edit screen — census H40 / H71', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; _resetMemoryOperationIds(); mockRouter.back.mockClear(); });
  afterEach(() => { global.fetch = realFetch; process.env.EXPO_PUBLIC_API_BASE_URL = realBase; });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Edit = () => { const S = require('../edit.tsx').default as React.ComponentType; return <S />; };

  it('the place row shows the name as it was recorded; an untouched save sends no type and no place name', async () => {
    const calls = installFetch({ typesEnabled: true });
    await render(<Edit />);
    expect(await screen.findByText('Old Cafe · Hanoi, Vietnam')).toBeTruthy();
    await screen.findByTestId('memory-type-picker');
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.body).not.toHaveProperty('memoryType');
    expect(patches(calls)[0]!.body).not.toHaveProperty('placeDisplayNameAtOccurrence');
    expect(patches(calls)[0]!.body.placeId).toBe('fsq:old-cafe');
  });

  it('a type the person chose is sent', async () => {
    const calls = installFetch({ typesEnabled: true });
    await render(<Edit />);
    await fireEvent.press(await screen.findByTestId('memory-type-MILESTONE'));
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.body.memoryType).toBe('MILESTONE');
  });

  it('a NEWLY picked place is sent with its name', async () => {
    const calls = installFetch({ typesEnabled: true });
    await render(<Edit />);
    await fireEvent.press(await screen.findByTestId('memory-edit-location-row'));
    await fireEvent.press(screen.getByTestId('mock-place-pho'));
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.body).toMatchObject({ placeId: 'fsq:pho-10', placeDisplayNameAtOccurrence: 'Pho 10' });
  });

  it('with types OFF there is no picker and no type is ever sent', async () => {
    const calls = installFetch({ typesEnabled: false });
    await render(<Edit />);
    await screen.findByText('Old Cafe · Hanoi, Vietnam');
    await waitFor(() => expect(calls.some((c) => c.url === 'https://api.test/api/memory-types')).toBe(true));
    expect(screen.queryByTestId('memory-type-picker')).toBeNull();
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]!.body).not.toHaveProperty('memoryType');
  });
});
