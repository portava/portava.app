import { act, renderHook } from '@testing-library/react-native';
import { usePulseFeed } from '../usePulseFeed.ts';
import { useMyTrips } from '../useBackend.ts';
import { getPulseData } from '../../services/pulse.ts';
import { listMyTrips } from '../../services/trips.ts';

const mockBlockedIds = new Set<string>();
// NOTE: this hook consumes only the block set; native provider work is unrelated.
jest.mock('../../context/BlockedIdsContext.tsx', () => ({ useBlockedIds: () => ({ blockedIds: mockBlockedIds }) }));
// NOTE: no native auth client is needed for these network scheduling tests.
jest.mock('../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
jest.mock('../../services/pulse.ts', () => ({ ...jest.requireActual('../../services/pulse.ts'), getPulseData: jest.fn() }));
jest.mock('../../services/trips.ts', () => ({ ...jest.requireActual('../../services/trips.ts'), listMyTrips: jest.fn() }));

beforeEach(() => { jest.clearAllMocks(); });

it('records the first feed request and aborts it when the city changes or the screen unmounts', async () => {
  jest.mocked(getPulseData).mockImplementation(() => new Promise(() => {}));
  const view = await renderHook(({ city }: { city: string }) => usePulseFeed({ city }), { initialProps: { city: 'Cebu' } });
  expect(view.result.current.lastRequestedAt.current).toBeGreaterThan(0);
  expect(getPulseData).toHaveBeenCalledTimes(1);
  const firstSignal = jest.mocked(getPulseData).mock.calls[0][0].signal!;
  await view.rerender({ city: 'Da Nang' });
  expect(firstSignal.aborted).toBe(true);
  expect(getPulseData).toHaveBeenCalledTimes(2);
  const secondSignal = jest.mocked(getPulseData).mock.calls[1][0].signal!;
  await view.unmount();
  expect(secondSignal.aborted).toBe(true);
});

it('allows a failed initial feed load to retry on the next focus', async () => {
  jest.mocked(getPulseData).mockResolvedValue({ ok: false, error: 'Offline', errorKind: 'network' });
  const view = await renderHook(() => usePulseFeed({ city: 'Cebu' }));
  expect(view.result.current.lastRequestedAt.current).toBe(0);
  expect(view.result.current.error).toBe('Offline');
});

it('loads trips once when authentication becomes ready', async () => {
  let finish!: (value: Awaited<ReturnType<typeof listMyTrips>>) => void;
  jest.mocked(listMyTrips).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = await renderHook(({ enabled }: { enabled: boolean }) => useMyTrips({ enabled }), { initialProps: { enabled: false } });
  expect(listMyTrips).not.toHaveBeenCalled();
  expect(view.result.current.loading).toBe(true);
  await view.rerender({ enabled: true });
  expect(listMyTrips).toHaveBeenCalledTimes(1);
  expect(view.result.current.loading).toBe(true);
  await act(async () => { finish([]); });
  expect(view.result.current.loading).toBe(false);
  jest.mocked(listMyTrips).mockResolvedValue([]);
  await act(async () => { await view.result.current.reload(); });
  expect(listMyTrips).toHaveBeenCalledTimes(2);
});
