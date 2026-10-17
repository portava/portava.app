import { act, renderHook, waitFor } from '@testing-library/react-native';

const mockFetchMapTemporal = jest.fn();
const mockBboxFromCenter = jest.fn((lat: number, lng: number, radius: number) => ({ lat, lng, radius }));

jest.mock('../../services/mapTemporal.ts', () => ({
  ...jest.requireActual('../../services/mapTemporal.ts'),
  fetchMapTemporal: (...args: unknown[]) => mockFetchMapTemporal(...args),
}));
jest.mock('../../services/mapProjection.ts', () => ({
  ...jest.requireActual('../../services/mapProjection.ts'),
  bboxFromCenter: (lat: number, lng: number, radius: number) => mockBboxFromCenter(lat, lng, radius),
}));

import { useTemporalProducerProbe, type UseTemporalProducerProbeArgs } from '../useTemporalProducerProbe.ts';

function pendingResult() {
  let resolve!: (value: { ok: boolean; data?: { enabled?: boolean } }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ ok: boolean; data?: { enabled?: boolean } }>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

const initial: UseTemporalProducerProbeArgs = { lat: 10, lng: 20, tz: 'UTC', enabled: true };

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchMapTemporal.mockReset();
});

describe('temporal producer probe lifecycle', () => {
  it('accepts the one pending capability response despite coordinate and timezone changes', async () => {
    const pending = pendingResult();
    mockFetchMapTemporal.mockReturnValueOnce(pending.promise);
    const hook = await renderHook((args: UseTemporalProducerProbeArgs) => useTemporalProducerProbe(args), { initialProps: initial });
    const signal = mockFetchMapTemporal.mock.calls[0][0].signal as AbortSignal;
    await hook.rerender({ ...initial, lat: 11, lng: 21, tz: 'Europe/Paris' });
    await hook.rerender({ ...initial, lat: 12, lng: 22 });
    expect(mockFetchMapTemporal).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await act(async () => { pending.resolve({ ok: true, data: { enabled: true } }); });
    expect(hook.result.current).toEqual({ ok: true, data: { enabled: true } });
    await hook.rerender({ ...initial, lat: 13, lng: 23 });
    expect(mockFetchMapTemporal).toHaveBeenCalledTimes(1);
  });

  it('waits for position and does not probe while disabled', async () => {
    mockFetchMapTemporal.mockResolvedValue({ ok: true, data: { enabled: true } });
    const hook = await renderHook((args: UseTemporalProducerProbeArgs) => useTemporalProducerProbe(args), {
      initialProps: { ...initial, lat: null, lng: null, enabled: false },
    });
    await hook.rerender({ ...initial, enabled: false });
    expect(mockFetchMapTemporal).not.toHaveBeenCalled();
    await hook.rerender({ ...initial, lat: null });
    expect(mockFetchMapTemporal).not.toHaveBeenCalled();
    await hook.rerender(initial);
    await waitFor(() => expect(hook.result.current?.data?.enabled).toBe(true));
    expect(mockFetchMapTemporal).toHaveBeenCalledTimes(1);
  });

  it('aborts disabled work and ignores its late response after a fresh enable', async () => {
    const oldPending = pendingResult();
    const newPending = pendingResult();
    mockFetchMapTemporal.mockReturnValueOnce(oldPending.promise).mockReturnValueOnce(newPending.promise);
    const hook = await renderHook((args: UseTemporalProducerProbeArgs) => useTemporalProducerProbe(args), { initialProps: initial });
    const oldSignal = mockFetchMapTemporal.mock.calls[0][0].signal as AbortSignal;
    await hook.rerender({ ...initial, enabled: false });
    expect(oldSignal.aborted).toBe(true);
    expect(hook.result.current).toBeNull();
    await hook.rerender({ ...initial, lat: 44, lng: 55 });
    expect(mockFetchMapTemporal).toHaveBeenCalledTimes(2);
    expect(mockFetchMapTemporal.mock.calls[1][0].bbox).toEqual({ lat: 44, lng: 55, radius: 0.5 });
    await act(async () => { newPending.resolve({ ok: true, data: { enabled: false } }); });
    await act(async () => { oldPending.resolve({ ok: true, data: { enabled: true } }); });
    expect(hook.result.current).toEqual({ ok: true, data: { enabled: false } });
  });

  it('withholds a completed positive answer while disabled and rechecks on enable', async () => {
    mockFetchMapTemporal.mockResolvedValueOnce({ ok: true, data: { enabled: true } });
    const hook = await renderHook((args: UseTemporalProducerProbeArgs) => useTemporalProducerProbe(args), { initialProps: initial });
    await waitFor(() => expect(hook.result.current?.data?.enabled).toBe(true));
    await hook.rerender({ ...initial, enabled: false });
    expect(hook.result.current).toBeNull();
    const pending = pendingResult();
    mockFetchMapTemporal.mockReturnValueOnce(pending.promise);
    await hook.rerender(initial);
    expect(hook.result.current).toBeNull();
    expect(mockFetchMapTemporal).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve({ ok: false }); });
    expect(hook.result.current).toEqual({ ok: false });
  });

  it('aborts on unmount and does not let an old completion affect a new mount', async () => {
    const oldPending = pendingResult();
    mockFetchMapTemporal.mockReturnValueOnce(oldPending.promise);
    const oldHook = await renderHook(() => useTemporalProducerProbe(initial));
    const signal = mockFetchMapTemporal.mock.calls[0][0].signal as AbortSignal;
    await oldHook.unmount();
    expect(signal.aborted).toBe(true);
    mockFetchMapTemporal.mockResolvedValueOnce({ ok: true, data: { enabled: false } });
    const newHook = await renderHook(() => useTemporalProducerProbe(initial));
    await waitFor(() => expect(newHook.result.current?.data?.enabled).toBe(false));
    await act(async () => { oldPending.resolve({ ok: true, data: { enabled: true } }); });
    expect(newHook.result.current?.data?.enabled).toBe(false);
  });

  it.each([{ ok: false }, { ok: true, data: { enabled: false } }])('preserves the producer refusal %j without retrying on movement', async (answer) => {
    mockFetchMapTemporal.mockResolvedValueOnce(answer);
    const hook = await renderHook((args: UseTemporalProducerProbeArgs) => useTemporalProducerProbe(args), { initialProps: initial });
    await waitFor(() => expect(hook.result.current).toEqual(answer));
    await hook.rerender({ ...initial, lat: 30 });
    expect(mockFetchMapTemporal).toHaveBeenCalledTimes(1);
  });

  it('refuses a rejected request without an unhandled error or movement retry', async () => {
    mockFetchMapTemporal.mockRejectedValueOnce(new Error('offline'));
    const hook = await renderHook((args: UseTemporalProducerProbeArgs) => useTemporalProducerProbe(args), { initialProps: initial });
    await waitFor(() => expect(hook.result.current).toEqual({ ok: false }));
    await hook.rerender({ ...initial, lng: 45 });
    expect(mockFetchMapTemporal).toHaveBeenCalledTimes(1);
  });

  it('ignores an old rejection after the new enabled interval has answered', async () => {
    const oldPending = pendingResult();
    mockFetchMapTemporal.mockReturnValueOnce(oldPending.promise).mockResolvedValueOnce({ ok: true, data: { enabled: true } });
    const hook = await renderHook((args: UseTemporalProducerProbeArgs) => useTemporalProducerProbe(args), { initialProps: initial });
    await hook.rerender({ ...initial, enabled: false });
    await hook.rerender(initial);
    await waitFor(() => expect(hook.result.current?.data?.enabled).toBe(true));
    await act(async () => { oldPending.reject(new Error('old request aborted')); });
    expect(hook.result.current).toEqual({ ok: true, data: { enabled: true } });
  });

});
