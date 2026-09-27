/**
 * useDiscoveryDwell — the dwell emitter mounted on a Discovery place surface
 * (census-discovery DV-41, §55). Real hook, real classifier and sender; the
 * device's clock, AppState and flags are driven by the test.
 *
 *   H1  flag OFF ⇒ nothing measured, nothing sent
 *   H2  a view is sent once, when it closes, classified from the real signals
 *   H3  BACKGROUNDING MID-DWELL sends the foreground part at once; the idle part
 *       follows with the next emission, under a different client_event_id
 *   H3b iOS 'inactive' is not foreground either
 *   H4  signed out ⇒ nothing sent
 *   H5  a surface that did not serve the place, or a place with no (or a
 *       malformed) exposure id ⇒ nothing measured
 *   H6  the flag turned off mid-view ⇒ the closing emission is not sent
 *
 * Run with: pnpm test:component
 */
import { renderHook, act } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

const mockFlags: Record<string, boolean> = {};
// NOTE: intentionally exhaustive — the real context fetches /api/feature-flags;
// these tests set the flags directly.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags[k] === true, isLivePlacesEnabled: () => false, loading: false }),
}));
const mockToken = { value: 'test-token' as string | null };
// NOTE: intentionally exhaustive — apiToken imports the Supabase client.
jest.mock('../../services/apiToken.ts', () => ({ freshToken: async () => mockToken.value }));

import { useDiscoveryDwell } from '../useDiscoveryDwell.ts';
import { DISCOVERY_DWELL_FLAG, DWELL_INTERACTION_WINDOW_MS as W } from '../../services/discoveryDwell.ts';

const RID = 'Ab3_-x9QzW7kLmN2pR4tUv';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let clock = 0;
let appStateListener: ((s: AppStateStatus) => void) | null = null;
const fetchMock = jest.fn((_url: string, _init?: RequestInit) => Promise.resolve({ ok: true, status: 200 } as Response));
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_BASE = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  clock = 0;
  jest.spyOn(globalThis.performance, 'now').mockImplementation(() => clock);
  appStateListener = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (s: AppStateStatus) => void) => {
    appStateListener = fn;
    return { remove: () => { appStateListener = null; } };
  }) as unknown as typeof AppState.addEventListener);
  Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => 'active' });
  for (const k of Object.keys(mockFlags)) delete mockFlags[k];
  mockFlags[DISCOVERY_DWELL_FLAG] = true;
  mockToken.value = 'test-token';
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve({ ok: true, status: 200 } as Response));
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE;
});

async function settle() {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}
const sent = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));

type Props = { surface: string | null; itemId: string | null; recommendationId: string | null; visible: boolean };
const open: Props = { surface: 'discovery', itemId: 'db/p1', recommendationId: RID, visible: true };

async function mount(p: Props) {
  return renderHook((q: Props) => useDiscoveryDwell(q), { initialProps: p });
}
async function at(ms: number, fn: () => void) {
  clock = ms;
  await act(async () => { fn(); });
}

describe('useDiscoveryDwell', () => {
  it('H1. flag OFF: nothing measured, nothing sent', async () => {
    mockFlags[DISCOVERY_DWELL_FLAG] = false;
    const h = await mount(open);
    expect(AppState.addEventListener).not.toHaveBeenCalled();   // nothing is even timed
    await at(5_000, () => h.result.current.noteInteraction());
    clock = 60_000; await h.rerender({ ...open, visible: false });
    await act(async () => { h.unmount(); });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(appStateListener).toBeNull();
  });

  it('H2. one emission when the view closes, classified from touch and foreground', async () => {
    const h = await mount(open);
    await at(1_000, () => h.result.current.noteInteraction());
    clock = 30_000; await h.rerender({ ...open, visible: false });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.test/api/rank-events/dwell');
    const [body] = sent();
    expect(body).toMatchObject({ item_id: 'db/p1', surface: 'discovery', recommendation_id: RID });
    expect(body.client_event_id).toMatch(UUID);
    expect(body.dwell).toEqual([
      { kind: 'active', ms: 1_000 + W },
      { kind: 'passive_foreground', ms: 30_000 - (1_000 + W) },
    ]);
  });

  it('H3. backgrounding mid-dwell sends the foreground part at once; the idle part follows, separately', async () => {
    const h = await mount(open);
    expect(appStateListener).not.toBeNull();
    await at(5_000, () => appStateListener!('background'));
    await settle();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].dwell).toEqual([{ kind: 'active', ms: 5_000 }]);
    await at(65_000, () => appStateListener!('active'));
    clock = 70_000; await h.rerender({ ...open, visible: false });
    await settle();
    expect(sent()).toHaveLength(2);
    expect(sent()[1].dwell).toEqual([{ kind: 'passive_foreground', ms: 5_000 }, { kind: 'idle', ms: 60_000 }]);
    expect(sent()[0].client_event_id).not.toBe(sent()[1].client_event_id);
  });

  it("H3b. iOS 'inactive' (screen locking, the shade) is not foreground either", async () => {
    const h = await mount(open);
    await at(2_000, () => appStateListener!('inactive'));
    await at(9_000, () => appStateListener!('background'));   // still away: no second emission
    clock = 20_000; await h.rerender({ ...open, visible: false });
    await settle();
    expect(sent().map((b) => b.dwell)).toEqual([[{ kind: 'active', ms: 2_000 }], [{ kind: 'idle', ms: 18_000 }]]);
  });

  it('H4. signed out: nothing sent', async () => {
    mockToken.value = null;
    const h = await mount(open);
    clock = 20_000; await h.rerender({ ...open, visible: false });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('H5. a surface that did not serve it, or no / a malformed exposure id: nothing measured', async () => {
    for (const p of [
      { ...open, surface: null }, { ...open, surface: 'pulse' },
      { ...open, recommendationId: null }, { ...open, recommendationId: 'short' }, { ...open, itemId: null },
    ]) {
      const h = await mount(p);
      clock += 10_000; await h.rerender({ ...p, visible: false });
      await act(async () => { h.unmount(); });
    }
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(appStateListener).toBeNull();
  });

  it('H6. the flag turned OFF mid-view: the closing emission is not sent', async () => {
    const h = await mount(open);
    clock = 8_000;
    mockFlags[DISCOVERY_DWELL_FLAG] = false;
    await h.rerender({ ...open });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
