/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; the round-16 verifier's B6): the Time Machine's forecast says a
 * refused accepted-plan layer, an unread itinerary and a page of several — through the real hook
 * (useTemporalEntities) and the map's real notice function (temporalNotice, app/map/index.tsx).
 *
 * The temporal gateway refuses the accepted-plan forecast over a failed or cut read (`read_failed`, `zone_read_failed`,
 * `zone_model_capped`, `plans_capped`, `stops_capped`) and does not name `accepted_plan`; it sends `itinerary: null`
 * and does not name `itinerary` over a failed or cut itinerary read (D-W11X2-136). The client read `events` only, and
 * asked for `limit: 200` and dropped `nextCursor`, so each was drawn as a whole forecast.
 *
 *   V16-FP0 CONTROL: every forecast layer read → no notice (the honest empty)
 *   V16-FP1 accepted plans cut at the cap (plans_capped; not named) → "Predicted crowds couldn't be checked…"
 *   V16-FP2 the itinerary read cut (itinerary null; not named) → "Your plans couldn't be loaded…"
 *   V16-FP3 the answer is page one of several (nextCursor "200") → "Only part of this time could be loaded"
 *   FP4  every failure refusal of the plan read (read_failed, zone_read_failed, zone_model_capped, stops_capped) is unread
 *   FP5  the itinerary named as read but reported null, or reported but not named → unread either way
 *   FP6  several unread layers are each said, the cut first
 *   FP7  a past answer that is page one of several → "Only part of this time could be loaded"
 *   FP8  a cut answer's mark is dropped at NOW and while the next offset's read is in flight
 *   FP4c CONTROL: the plan layer's genuine off-states (flag_off, no_group_key_secret, no_zone_model) are not unread
 */
import { renderHook, waitFor } from '@testing-library/react-native';

const mockAnswers: Array<() => Promise<any>> = [];
// NOTE: exhaustive by design — the hook reads only `fetchMapTemporal` from this module, and the real one pulls in the
// app's auth client.
jest.mock('../../services/mapTemporal.ts', () => ({
  fetchMapTemporal: jest.fn(() => (mockAnswers.shift() ?? (() => Promise.resolve({ ok: false, error: 'none' })))()),
}));
// NOTE: exhaustive by design — the hook reads only `bboxFromCenter` from this module.
jest.mock('../../services/mapProjection.ts', () => ({
  bboxFromCenter: () => ({ west: 0, south: 0, east: 1, north: 1 }),
}));

import { useTemporalEntities } from '../useTemporalEntities.ts';
import { temporalNotice } from '../../features/map/time/forecastUnread.ts';

const SOON = { kind: 'relative', minutes: 90 } as const;
const EARLIER = { kind: 'relative', minutes: -90 } as const;
const plan = (refusal: string | null) => ({ published: 0, withheld: 0, refusal, refusals: {} });
const envelope = (over: Record<string, unknown>) => ({ enabled: true, objects: [], viewport: null, target: { at: '2026-09-30T13:30:00.000Z', mode: 'forecast' }, total: 0, nextCursor: null, sources: ['events', 'itinerary', 'accepted_plan'], aggregation: null, protection: null, forecast: { events: 0, itinerary: 0, plan: plan(null) }, history: null, generatedAt: '2026-09-30T12:00:00.000Z', ...over });

async function settle(data: any, offset: any = SOON) {
  mockAnswers.push(() => Promise.resolve({ ok: true, data }));
  const { result } = await renderHook(() => useTemporalEntities({ lat: 38.72, lng: -9.14, offset, active: true }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  return result.current;
}

const CROWDS = "Predicted crowds couldn't be checked for this time";
const PLANS = "Your plans couldn't be loaded for this time";
const PART = 'Only part of this time could be loaded';

describe('§114 B6: the Time Machine forecast says a refused plan layer, an unread itinerary and a page of several', () => {
  beforeEach(() => { mockAnswers.length = 0; });

  it('V16-FP0 CONTROL: every forecast layer read, nothing forecast → no notice', async () => {
    const t = await settle(envelope({}));
    expect(temporalNotice(t)).toBeNull();
  });

  it('V16-FP1 accepted plans cut at the cap (plans_capped, accepted_plan not named) → the predicted crowds are said unread', async () => {
    const t = await settle(envelope({ sources: ['events', 'itinerary'], forecast: { events: 0, itinerary: 0, plan: plan('plans_capped') } }));
    expect(t.unreadForecastLayers).toEqual(['accepted_plan']);
    expect(temporalNotice(t)).toBe(CROWDS);
  });

  it('V16-FP2 the itinerary read cut (itinerary null, not named) → the viewer\'s plans are said unread', async () => {
    const t = await settle(envelope({ sources: ['events', 'accepted_plan'], forecast: { events: 0, itinerary: null, plan: plan(null) } }));
    expect(t.unreadForecastLayers).toEqual(['itinerary']);
    expect(temporalNotice(t)).toBe(PLANS);
  });

  it('V16-FP3 the answer is page one of several (nextCursor "200", every layer named) → the time is said to be part-loaded', async () => {
    const objs = Array.from({ length: 200 }, (_, i) => ({ id: `prediction:p${i}`, kind: 'event', geometry: { type: 'Point', coordinates: [-9.14 + i / 1000, 38.72] }, title: `P${i}`, subtitle: null, privacyClass: 'public', renderingPriority: 50, interaction: { actions: ['view'], opensSheet: true }, forecastConfidence: 'moderate' }));
    const t = await settle(envelope({ objects: objs, total: 260, nextCursor: '200' }));
    expect(t.objects.length).toBe(200);
    expect(temporalNotice(t)).toBe(PART);
  });

  it('FP4 every failure refusal of the plan read is unread', async () => {
    for (const refusal of ['read_failed', 'zone_read_failed', 'zone_model_capped', 'stops_capped']) {
      const t = await settle(envelope({ sources: ['events', 'itinerary'], forecast: { events: 0, itinerary: 0, plan: plan(refusal) } }));
      expect([refusal, t.unreadForecastLayers]).toEqual([refusal, ['accepted_plan']]);
    }
  });

  it('FP5 the itinerary named but reported null, or reported but not named → unread either way', async () => {
    const a = await settle(envelope({ forecast: { events: 0, itinerary: null, plan: plan(null) } }));
    expect(a.unreadForecastLayers).toEqual(['itinerary']);
    const b = await settle(envelope({ sources: ['events', 'accepted_plan'], forecast: { events: 0, itinerary: 2, plan: plan(null) } }));
    expect(b.unreadForecastLayers).toEqual(['itinerary']);
  });

  it('FP6 several unread layers are each said, the cut first', async () => {
    const t = await settle(envelope({ nextCursor: '200', sources: [], forecast: { events: null, itinerary: null, plan: plan('read_failed') } }));
    expect(temporalNotice(t)).toBe([PART, "Events couldn't be checked for this forecast", CROWDS, PLANS].join(' · '));
  });

  it('FP7 a past answer that is page one of several → "Only part of this time could be loaded"', async () => {
    const t = await settle(envelope({ target: { at: '2026-09-30T10:30:00.000Z', mode: 'historical' }, sources: ['history'], forecast: null, history: { available: true, covering: 200 }, nextCursor: '200' }), EARLIER);
    expect(t.failed).toBe(false);
    expect(temporalNotice(t)).toBe(PART);
  });

  it("FP4c CONTROL: the plan layer's off-states (flag_off, no_group_key_secret, no_zone_model) are not unread", async () => {
    for (const refusal of ['flag_off', 'no_group_key_secret', 'no_zone_model']) {
      const t = await settle(envelope({ sources: ['events', 'itinerary'], forecast: { events: 0, itinerary: 0, plan: plan(refusal) } }));
      expect([refusal, t.unreadForecastLayers, temporalNotice(t)]).toEqual([refusal, [], null]);
    }
  });

  it('FP8 after a cut answer, the Time Machine back at NOW, or a new offset in flight, holds no stale cut', async () => {
    mockAnswers.push(() => Promise.resolve({ ok: true, data: envelope({ nextCursor: '200' }) }));
    const hook = await renderHook((p: { offset: any }) => useTemporalEntities({ lat: 38.72, lng: -9.14, offset: p.offset, active: true }), { initialProps: { offset: SOON } });
    await waitFor(() => expect(hook.result.current.pageCut).toBe(true));
    let release: (v: unknown) => void = () => {};
    mockAnswers.push(() => new Promise((res) => { release = res; }));
    await hook.rerender({ offset: { kind: 'relative', minutes: 120 } });
    await waitFor(() => expect(hook.result.current.loading).toBe(true));
    expect(hook.result.current.pageCut).toBe(false);
    release({ ok: true, data: envelope({ nextCursor: '200' }) });
    await waitFor(() => expect(hook.result.current.pageCut).toBe(true));
    await hook.rerender({ offset: { kind: 'now' } });
    await waitFor(() => expect(hook.result.current.pageCut).toBe(false));
    expect(temporalNotice(hook.result.current)).toBeNull();
  });
});
