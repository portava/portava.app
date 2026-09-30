/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-130): the Time Machine's PAST arm never draws a
 * failed history read as an empty observed past, and never shows the honest-empty strip while a read is in flight.
 * Through the real hook and the notice the map screen passes (`temporalNotice`, app/map/index.tsx).
 *
 * The round-15 verifier's probes, adapted to the map's notice function (V15-TH2, TH3, TH4), and this lane's:
 *   TH3b the server's `history_unreadable` refusal → failed, and the notice says so
 *   TH5  a historical target answered with no history report (an older server) → failed, never an empty past
 *   TH6  an in-flight PAST read → the loading notice, not the empty strip; the answer then replaces it
 *   TH2c CONTROL: the flag-off envelope (`enabled: false`) is not a failed past; a healthy past with rows → no notice
 */
import { renderHook, waitFor } from '@testing-library/react-native';

const mockAnswers: Array<() => Promise<any>> = [];
// NOTE: exhaustive on purpose — the hook imports only fetchMapTemporal from here, and the real module pulls in the app's auth client.
jest.mock('../../services/mapTemporal.ts', () => ({
  fetchMapTemporal: jest.fn(() => (mockAnswers.shift() ?? (() => Promise.resolve({ ok: false, error: 'none' })))()),
}));
// NOTE: exhaustive on purpose — the hook imports only bboxFromCenter from here (the round-15 verifier's probe, adapted).
jest.mock('../../services/mapProjection.ts', () => ({
  bboxFromCenter: () => ({ west: 0, south: 0, east: 1, north: 1 }),
}));

import { useTemporalEntities } from '../useTemporalEntities.ts';
import * as time from '../../features/map/time/forecastUnread.ts';

const envelope = (over: Record<string, unknown>) => ({ enabled: true, objects: [], viewport: null, target: { at: '2026-09-30T09:00:00.000Z', mode: 'historical' }, total: 0, nextCursor: null, sources: [], aggregation: null, protection: null, forecast: null, history: null, generatedAt: '2026-09-30T12:00:00.000Z', ...over });
const PAST = { kind: 'relative', minutes: -180 } as const; const SOON = { kind: 'relative', minutes: 90 } as const;
const notice = (t: any) => (time as any).temporalNotice(t);
const OBS = { id: 'historical:place:A', kind: 'place', geometry: { type: 'Point', coordinates: [-9.14, 38.72] }, title: 'A', confidence: 'established', privacyClass: 'public', renderingPriority: 50, freshness: 'historical' };

describe('§113: the Time Machine past arm over a failed or in-flight history read (D-W11X2-130)', () => {
  beforeEach(() => { mockAnswers.length = 0; });

  it('V15-TH2 CONTROL: a healthy empty past → no notice', async () => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ sources: ['history'], history: { available: true, covering: 0 } }) }));
    const { result } = await renderHook(() => useTemporalEntities({ lat: 38.72, lng: -9.14, offset: PAST, active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(false);
    expect(notice(result.current)).toBeNull();
  });

  it('V15-TH3 the history read FAILED (sources [], history.available false) → the Time Machine says so', async () => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ sources: [], history: { available: false, covering: 0 } }) }));
    const { result } = await renderHook(() => useTemporalEntities({ lat: 38.72, lng: -9.14, offset: PAST, active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(true);
    expect(notice(result.current)).toBe("Couldn't load the map for this time");
  });

  it("TH3b the server's history_unreadable refusal → failed, and the notice says so", async () => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ sources: [], history: { available: false, covering: 0 }, refusal: 'history_unreadable', failedSources: ['places'] }) }));
    const { result } = await renderHook(() => useTemporalEntities({ lat: 38.72, lng: -9.14, offset: PAST, active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(true);
    expect(notice(result.current)).toBe("Couldn't load the map for this time");
  });

  it('TH5 a historical target answered with no history report → failed, never an empty past', async () => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ sources: [], history: null }) }));
    const { result } = await renderHook(() => useTemporalEntities({ lat: 38.72, lng: -9.14, offset: PAST, active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(true);
  });

  it('V15-TH4 an IN-FLIGHT forecast read → the map has a state to say (the loading notice)', async () => {
    mockAnswers.push(() => new Promise(() => {}));
    const { result } = await renderHook(() => useTemporalEntities({ lat: 38.72, lng: -9.14, offset: SOON, active: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.loading).toBe(true);
    expect(notice(result.current)).toBe('Loading the map for this time…');
  });

  it('TH6 an in-flight PAST read → the loading notice; the answer then replaces it', async () => {
    let answer: (v: any) => void = () => {};
    mockAnswers.push(() => new Promise((r) => { answer = r; }));
    const { result } = await renderHook(() => useTemporalEntities({ lat: 38.72, lng: -9.14, offset: PAST, active: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(notice(result.current)).toBe('Loading the map for this time…');
    answer({ ok: true, data: envelope({ objects: [OBS], total: 1, sources: ['history'], history: { available: true, covering: 1 } }) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(notice(result.current)).toBeNull();
    expect(result.current.objects.length).toBe(1);
  });

  it('TH2c CONTROL: the flag-off envelope is not a failed past; a healthy past with rows → no notice', async () => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ enabled: false, target: null }) }));
    const { result } = await renderHook(() => useTemporalEntities({ lat: 38.72, lng: -9.14, offset: PAST, active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(false);
  });
});
