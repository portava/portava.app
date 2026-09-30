/**
 * census-discovery §112 (DV-83 round 15, lane W11-X2, D-W11X2-121, D-W11X2-122): the Time Machine never draws a
 * refused or failed temporal read as an empty forecast, and never draws the previous offset over a failed one.
 *
 * The round-14 verifier's probes, copied in unchanged (V14-TM0, TM1, TM2), and this lane's:
 *   TM3  a refused forecast (the server's `block_set_unreadable`, `forecast.events: null`) → events unread, failed
 *   TM4  a failed read (`!res.ok`) → `failed` is true and nothing is drawn; a rejection → the same
 *   TM5  a fetch that is still in flight shows nothing from the previous offset (the hook's "[] while loading")
 *   TMc  CONTROL: a healthy answer after a failed one clears `failed`; the flag-off envelope is not a failure
 */
import { renderHook, waitFor } from '@testing-library/react-native';

const mockAnswers: Array<() => Promise<any>> = [];
// NOTE: exhaustive on purpose — the hook imports only fetchMapTemporal from here, and the real module pulls in the app's auth client.
jest.mock('../../services/mapTemporal.ts', () => ({
  fetchMapTemporal: jest.fn(() => (mockAnswers.shift() ?? (() => Promise.resolve({ ok: false, error: 'none' })))()),
}));
// NOTE: exhaustive on purpose — the hook imports only bboxFromCenter from here (the round-14 verifier's probe, copied in).
jest.mock('../../services/mapProjection.ts', () => ({
  bboxFromCenter: () => ({ west: 0, south: 0, east: 1, north: 1 }),
}));

import { useTemporalEntities } from '../useTemporalEntities.ts';

const report = (events: number | null) => ({ events, itinerary: 0, plan: { published: 0, withheld: 0, refusal: null, refusals: {} } });
const envelope = (over: Record<string, unknown>) => ({ enabled: true, objects: [], viewport: null, target: { at: '2026-10-01T20:00:00.000Z', mode: 'forecast' }, total: 0, nextCursor: null, sources: [], aggregation: null, protection: null, forecast: null, history: null, generatedAt: '2026-10-01T19:00:00.000Z', ...over });
const OFF_A = { kind: 'relative', minutes: 60 } as const; const OFF_B = { kind: 'relative', minutes: 180 } as const;
const PRED = { id: 'prediction:event:A', kind: 'prediction', geometry: { type: 'Point', coordinates: [120.9, 14.5] }, title: 'Busier at A', confidence: 'provisional', privacyClass: 'aggregate_only', renderingPriority: 50 };

describe('v14: the Time Machine forecast over a failed read', () => {
  beforeEach(() => { mockAnswers.length = 0; });

  it('V14-TM0 CONTROL: a genuine empty forecast → nothing unread', async () => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ sources: ['events', 'itinerary', 'accepted_plan'], forecast: report(0) }) }));
    const { result } = await renderHook(() => useTemporalEntities({ lat: 14.5, lng: 120.9, offset: OFF_A, active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.forecast).not.toBeNull();
    expect(result.current.unreadForecastLayers).toEqual([]);
  });

  it('V14-TM1 the blocks read failed server-side (forecast: null, sources: []) at a forecast offset → the layers are reported unread', async () => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({}) }));
    const { result } = await renderHook(() => useTemporalEntities({ lat: 14.5, lng: 120.9, offset: OFF_A, active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    console.log('V14-TM1', JSON.stringify({ enabled: result.current.enabled, objects: result.current.objects.length, forecast: result.current.forecast, unread: result.current.unreadForecastLayers }));
    expect(result.current.unreadForecastLayers).toContain('events');
  });

  it("V14-TM2 offset A answers; offset B's read fails → A's prediction is not drawn at B", async () => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ objects: [PRED], total: 1, sources: ['events', 'itinerary', 'accepted_plan'], forecast: report(1) }) }));
    mockAnswers.push(() => Promise.resolve({ ok: false, error: 'Request failed (503)' }));
    const { result, rerender } = await renderHook((p: { off: any }) => useTemporalEntities({ lat: 14.5, lng: 120.9, offset: p.off, active: true }), { initialProps: { off: OFF_A as any } });
    await waitFor(() => expect(result.current.objects.map((o: any) => o.id)).toEqual(['prediction:event:A']));
    await rerender({ off: OFF_B as any });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await new Promise((r) => setTimeout(r, 20));
    console.log('V14-TM2 at B after a failed read', JSON.stringify({ objects: result.current.objects.map((o: any) => o.id), forecast: result.current.forecast }));
    expect(result.current.objects.map((o: any) => o.id)).not.toContain('prediction:event:A');
  });
});

describe('§112: the Time Machine over a refused or failed read (D-W11X2-121, D-W11X2-122)', () => {
  beforeEach(() => { mockAnswers.length = 0; });
  const run = async (answers: Array<() => Promise<any>>, off: any = OFF_A) => {
    mockAnswers.push(...answers);
    const r = await renderHook((p: { off: any }) => useTemporalEntities({ lat: 14.5, lng: 120.9, offset: p.off, active: true }), { initialProps: { off } });
    await waitFor(() => expect(r.result.current.loading).toBe(false));
    return r;
  };

  it("TM3 a refused forecast (block_set_unreadable, events: null) → events unread, and the read is failed", async () => {
    const { result } = await run([() => Promise.resolve({ ok: true, data: envelope({ refusal: 'block_set_unreadable', forecast: { events: null, itinerary: null, plan: null } }) })]);
    expect(result.current.unreadForecastLayers).toEqual(['events']);
    expect((result.current as any).failed).toBe(true);
    expect(result.current.objects).toEqual([]);
  });

  it('TM4 a failed read (!ok) → failed; a rejection → failed; nothing drawn', async () => {
    const a = await run([() => Promise.resolve({ ok: false, error: 'Request failed (503)' })]);
    expect((a.result.current as any).failed).toBe(true);
    expect(a.result.current.objects).toEqual([]);
    const b = await run([() => Promise.reject(new Error('network'))]);
    expect((b.result.current as any).failed).toBe(true);
    expect(b.result.current.forecast).toBeNull();
  });

  it("TM5 while offset B's read is in flight, offset A's prediction and forecast are not shown", async () => {
    let releaseB: (v: unknown) => void = () => {};
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ objects: [PRED], total: 1, sources: ['events', 'itinerary', 'accepted_plan'], forecast: report(1) }) }));
    mockAnswers.push(() => new Promise((r) => { releaseB = r; }));
    const { result, rerender } = await renderHook((p: { off: any }) => useTemporalEntities({ lat: 14.5, lng: 120.9, offset: p.off, active: true }), { initialProps: { off: OFF_A as any } });
    await waitFor(() => expect(result.current.objects.map((o: any) => o.id)).toEqual(['prediction:event:A']));
    await rerender({ off: OFF_B as any });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.objects).toEqual([]);
    expect(result.current.forecast).toBeNull();
    releaseB({ ok: true, data: envelope({ sources: ['events', 'itinerary', 'accepted_plan'], forecast: report(0) }) });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('TMc CONTROL: a healthy answer after a failed one clears failed; the flag-off envelope is not a failure', async () => {
    mockAnswers.push(() => Promise.resolve({ ok: false, error: 'Request failed (503)' }));
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ objects: [PRED], total: 1, sources: ['events', 'itinerary', 'accepted_plan'], forecast: report(1) }) }));
    const { result, rerender } = await renderHook((p: { off: any }) => useTemporalEntities({ lat: 14.5, lng: 120.9, offset: p.off, active: true }), { initialProps: { off: OFF_A as any } });
    await waitFor(() => expect((result.current as any).failed).toBe(true));
    await rerender({ off: OFF_B as any });
    await waitFor(() => expect(result.current.objects.map((o: any) => o.id)).toEqual(['prediction:event:A']));
    expect((result.current as any).failed).toBe(false);
    expect(result.current.unreadForecastLayers).toEqual([]);
    const off = await run([() => Promise.resolve({ ok: true, data: envelope({ enabled: false, target: null }) })]);
    expect((off.result.current as any).failed).toBe(false);
    expect(off.result.current.unreadForecastLayers).toEqual([]);
  });
});
