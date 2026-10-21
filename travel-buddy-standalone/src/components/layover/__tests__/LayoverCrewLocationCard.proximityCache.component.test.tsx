/**
 * census-layover L154 — §16 "Crew: cache meeting point; optional peer proximity if enabled" (LAYOVER 165, lane B2-CREW).
 *
 * With crew location sharing ON, the crew card caches each live share's LABEL, proximity BUCKET and server-cut END
 * (never a coordinate). Offline, the card draws the cached buckets with their "as of" instant — and a share whose end
 * has passed is NOT drawn: an expired grant vanishes offline too. A server answer of "no crew" / "feature off" clears
 * the cache. Only `fetch` and the two auth modules beneath the real service are replaced; AsyncStorage is jest-expo's.
 */
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverCrewLocationCard, LayoverCrewProximityOffline } from '../LayoverCrewLocationCard.tsx';
import { cacheCrewProximity, cachedCrewProximityKey, readCachedCrewProximity } from '../../../lib/layoverPlanCache.ts';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

const NOW = Date.now();
const inMin = (m: number) => new Date(NOW + m * 60_000).toISOString();
function json(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
const LIVE_READ = {
  available: true, inCrew: true, crewId: 'crew-1', maxShareMinutes: 240, shareEndsBy: null, preciseControl: { enabled: false },
  mine: null, crewmatesWithheld: null,
  crewmates: [
    { userId: 'u-ben', handle: 'ben', name: 'Ben', label: 'Night market north gate', precision: 'exact', sharedAt: inMin(-5), endsAt: inMin(30), position: { lat: 1.3, lng: 103.8 }, ring: null, proximity: 'close' },
    { userId: 'u-cy', handle: 'cy', name: null, label: 'Hawker centre', precision: 'area', sharedAt: inMin(-50), endsAt: inMin(90), position: null, ring: null, proximity: 'far' },
  ],
};

beforeEach(async () => { await AsyncStorage.clear(); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe('L154 crew proximity cached for offline, with crew-location expiry honoured', () => {
  it('1. a live read caches label + bucket + end per share — and NO coordinate', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, LIVE_READ));
    await render(<LayoverCrewLocationCard sessionId="s1" timezone="UTC" />);
    await waitFor(async () => expect(await AsyncStorage.getItem(cachedCrewProximityKey('s1'))).not.toBeNull());
    const raw = (await AsyncStorage.getItem(cachedCrewProximityKey('s1')))!;
    expect(raw).not.toMatch(/103\.8|"lat"|"lng"|"position"|"ring"/);
    const c = await readCachedCrewProximity('s1', NOW);
    expect(c?.crewmates.map((x) => [x.userId, x.proximity])).toEqual([['u-ben', 'close'], ['u-cy', 'far']]);
  });

  it('2. OFFLINE the card draws the cached buckets with their "as of" — instead of nothing', async () => {
    await cacheCrewProximity('s1', { ok: true, ...LIVE_READ } as never, NOW);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    await render(<LayoverCrewLocationCard sessionId="s1" timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-proximity-offline')).toBeTruthy());
    expect(screen.getByTestId('layover-crew-proximity-offline-u-ben')).toBeTruthy();
    expect(screen.getByText(/Ben: Night market north gate · close by/)).toBeTruthy();
    expect(screen.getByText(/Offline — as of/)).toBeTruthy();
  });

  it('3. EXPIRY OFFLINE: a share whose end has passed is not drawn, the one still running is', async () => {
    await cacheCrewProximity('s1', { ok: true, ...LIVE_READ } as never, NOW);
    await render(<LayoverCrewProximityOffline sessionId="s1" timezone="UTC" now={() => NOW + 45 * 60_000} />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-proximity-offline')).toBeTruthy());
    expect(screen.queryByTestId('layover-crew-proximity-offline-u-ben')).toBeNull();
    expect(screen.getByTestId('layover-crew-proximity-offline-u-cy')).toBeTruthy();
  });

  it('4. EXPIRY OFFLINE: once every share has ended nothing is drawn as live', async () => {
    await cacheCrewProximity('s1', { ok: true, ...LIVE_READ } as never, NOW);
    await render(<LayoverCrewProximityOffline sessionId="s1" timezone="UTC" now={() => NOW + 91 * 60_000} />);
    await waitFor(() => expect(screen.getByTestId('layover-crew-proximity-offline-none')).toBeTruthy());
    expect(screen.queryByTestId('layover-crew-proximity-offline-u-cy')).toBeNull();
  });

  it('5. the server saying "no crew" (or feature off) CLEARS the cache; a failed read clears nothing', async () => {
    await cacheCrewProximity('s1', { ok: true, ...LIVE_READ } as never, NOW);
    expect(await cacheCrewProximity('s1', { ok: false, reason: 'unreachable', message: 'x' }, NOW)).toBe(false);
    expect(await readCachedCrewProximity('s1', NOW)).not.toBeNull();
    await cacheCrewProximity('s1', { ok: true, available: true, inCrew: false }, NOW);
    expect(await readCachedCrewProximity('s1', NOW)).toBeNull();
    await cacheCrewProximity('s1', { ok: true, ...LIVE_READ } as never, NOW);
    await cacheCrewProximity('s1', { ok: true, available: false }, NOW);
    expect(await readCachedCrewProximity('s1', NOW)).toBeNull();
  });

  it('6. another session\'s cache is never read for this one', async () => {
    await cacheCrewProximity('s1', { ok: true, ...LIVE_READ } as never, NOW);
    expect(await readCachedCrewProximity('s2', NOW)).toBeNull();
  });
});

it('7. shares disappear at their exact expiry while the offline card remains mounted', async () => {
  jest.useFakeTimers(); jest.setSystemTime(NOW);
  await cacheCrewProximity('s1', { ok: true, ...LIVE_READ } as never, NOW);
  await render(<LayoverCrewProximityOffline sessionId="s1" timezone="UTC" />);
  await waitFor(() => expect(screen.getByTestId('layover-crew-proximity-offline-u-ben')).toBeTruthy());
  await act(async () => { jest.advanceTimersByTime(30 * 60_000); });
  expect(screen.queryByTestId('layover-crew-proximity-offline-u-ben')).toBeNull();
  expect(screen.getByTestId('layover-crew-proximity-offline-u-cy')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(60 * 60_000); });
  expect(screen.queryByTestId('layover-crew-proximity-offline-u-cy')).toBeNull();
  expect(screen.getByTestId('layover-crew-proximity-offline-none')).toBeTruthy();
});
