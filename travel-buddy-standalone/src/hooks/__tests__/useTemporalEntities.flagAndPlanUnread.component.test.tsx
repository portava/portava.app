/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B9 and B10): the Time Machine over an
 * unread gateway flag and over a plan layer whose flag or consent read failed — the bodies the fixed temporal gateway
 * sends (`mapGatewayFlagUnread` GF2, `mapTemporalPlanUnread` TPU1, TPU2), through the real hook and `temporalNotice`.
 *
 *   TF1  the gateway flag could not be read (`enabled: false`, `refusal: "flag_unreadable"`) → failed, and said
 *   TF0  CONTROL: the flag-off body (no refusal) is off → not failed, nothing said
 *   TP1  the crowd-flow flag could not be read (`plan.refusal: "flag_unreadable"`) → "Predicted crowds couldn't be checked"
 *   TP2  the consent read failed (`plan.refusal: "read_failed"`, `accepted_plan` not named) → said the same
 *   TP0  CONTROL: the crowd-flow flag read and off (`flag_off`) → the layer is off, nothing said
 */
import { renderHook, waitFor } from '@testing-library/react-native';

const mockAnswers: Array<() => Promise<any>> = [];
// NOTE: exhaustive on purpose — the hook imports only fetchMapTemporal from here, and the real module pulls in the app's auth client.
jest.mock('../../services/mapTemporal.ts', () => ({
  fetchMapTemporal: jest.fn(() => (mockAnswers.shift() ?? (() => Promise.resolve({ ok: false, error: 'none' })))()),
}));
// NOTE: exhaustive on purpose — the hook imports only bboxFromCenter from here.
jest.mock('../../services/mapProjection.ts', () => ({
  bboxFromCenter: () => ({ west: 0, south: 0, east: 1, north: 1 }),
}));

import { useTemporalEntities } from '../useTemporalEntities.ts';
import { temporalNotice } from '../../features/map/time/forecastUnread.ts';

const OFFSET = { kind: 'relative', minutes: 60 } as const;
const FLAG_OFF = { enabled: false, objects: [], viewport: null, target: null, total: 0, nextCursor: null, sources: [], aggregation: null, protection: null, forecast: null, history: null, generatedAt: '2026-10-01T19:00:00.000Z' };
const plan = (refusal: string | null) => ({ events: 0, itinerary: 0, plan: { published: 0, withheld: 0, refusal, refusals: {} } });
const forecast = (sources: string[], refusal: string | null) => ({ enabled: true, objects: [], viewport: null, target: { at: '2026-10-01T20:00:00.000Z', mode: 'forecast' }, total: 0, nextCursor: null, sources, aggregation: null, protection: null, forecast: plan(refusal), history: null, generatedAt: '2026-10-01T19:00:00.000Z' });

async function answer(data: any) {
  mockAnswers.push(() => Promise.resolve({ ok: true, data }));
  const { result } = await renderHook(() => useTemporalEntities({ lat: 16.05, lng: 108.2, offset: OFFSET, active: true }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  return { r: result.current, notice: temporalNotice(result.current) };
}

describe('census-discovery §115 (B9, B10): the Time Machine over an unread flag and a failed plan read', () => {
  beforeEach(() => { mockAnswers.length = 0; });

  it('TF1 the gateway flag could not be read (refusal flag_unreadable) → failed, and said', async () => {
    const { r, notice } = await answer({ ...FLAG_OFF, refusal: 'flag_unreadable' });
    expect(r.failed).toBe(true);
    expect(notice).toBe("Couldn't load the map for this time");
  });

  it('TF0 CONTROL: the flag-off body (no refusal) is off → not failed, nothing said', async () => {
    const { r, notice } = await answer(FLAG_OFF);
    expect(r.failed).toBe(false);
    expect(notice).toBeNull();
  });

  it("TP1 the crowd-flow flag could not be read (plan refusal flag_unreadable) → \"Predicted crowds couldn't be checked\"", async () => {
    const { r, notice } = await answer(forecast(['events', 'itinerary'], 'flag_unreadable'));
    expect(r.unreadForecastLayers).toEqual(['accepted_plan']);
    expect(notice).toBe("Predicted crowds couldn't be checked for this time");
  });

  it('TP2 the consent read failed (plan refusal read_failed, not named) → said', async () => {
    const { r, notice } = await answer(forecast(['events', 'itinerary'], 'read_failed'));
    expect(r.unreadForecastLayers).toEqual(['accepted_plan']);
    expect(notice).toBe("Predicted crowds couldn't be checked for this time");
  });

  it('TP0 CONTROL: the crowd-flow flag read and off (flag_off) → off, nothing said', async () => {
    const { r, notice } = await answer(forecast(['events', 'itinerary'], 'flag_off'));
    expect(r.unreadForecastLayers).toEqual([]);
    expect(notice).toBeNull();
  });
});
