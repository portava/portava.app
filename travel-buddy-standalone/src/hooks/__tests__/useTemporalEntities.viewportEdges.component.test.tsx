/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; sweep SW14): the Time Machine says a time it could only read for
 * part of the area — near the antimeridian or a pole, where `bboxFromCenter` clamps the viewport box the gateway gets.
 *
 *   TE1  the centre ~5 km from the antimeridian, a whole answer → `pageCut` (the time is not whole)
 *   TE2  the centre at 85°N → the same
 *   TE0  CONTROL: Manila, a whole answer → not cut
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
void OFF_B; const PRED = { id: 'prediction:event:A', kind: 'prediction', geometry: { type: 'Point', coordinates: [120.9, 14.5] }, title: 'Busier at A', confidence: 'provisional', privacyClass: 'aggregate_only', renderingPriority: 50 };

describe('census-discovery §116 (SW14): the Time Machine near the antimeridian or a pole', () => {
  beforeEach(() => { mockAnswers.length = 0; });
  const at = async (lat: number, lng: number) => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ sources: ['events', 'itinerary', 'accepted_plan'], forecast: report(0) }) }));
    const { result } = await renderHook(() => useTemporalEntities({ lat, lng, offset: OFF_A, active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    return result.current;
  };
  it('TE0 CONTROL: Manila, a whole answer → not cut', async () => { expect((await at(14.5, 120.9)).pageCut).toBe(false); });
  it('TE1 the centre ~5 km from the antimeridian → cut', async () => { expect((await at(-16.82, 179.95)).pageCut).toBe(true); });
  it('TE2 the centre at 85°N → cut', async () => { expect((await at(85, 15)).pageCut).toBe(true); });
});
void PRED;
