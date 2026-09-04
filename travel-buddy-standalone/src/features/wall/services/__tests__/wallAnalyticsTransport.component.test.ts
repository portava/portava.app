/**
 * Unit test: the Wall's real §32 analytics transport + the consented-only
 * real-world-outcome caller.
 *
 * Proves the sink actually reaches the pipeline (authenticated POST, ids/enums
 * only), fails soft, and that a real-world outcome is emitted only under valid
 * consent.
 */

import {
  createWallAnalyticsTransport,
} from '../wallAnalyticsTransport.ts';
import {
  recordRealWorldOutcome,
  setRealWorldOutcomeConsent,
  resetRealWorldOutcomeConsent,
  setWallAnalyticsSink,
  resetWallAnalyticsSink,
  type WallAnalyticsEvent,
} from '../wallAnalytics.ts';
import type { WallProjection } from '../../types/wallProjection.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));

const event: WallAnalyticsEvent = { type: 'wall_feed_open', mode: 'for_you' };

describe('createWallAnalyticsTransport (§32)', () => {
  it('POSTs the event to /api/wall/telemetry with a bearer token, ids/enums only', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const sink = createWallAnalyticsTransport({
      baseUrl: 'https://api.example.com',
      getToken: async () => 'tok-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    sink(event);
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/wall/telemetry');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-123');
    expect(JSON.parse(init.body)).toEqual({ events: [event] });
  });

  it('does not POST when the base URL is unset (unconfigured)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const sink = createWallAnalyticsTransport({
      baseUrl: '',
      getToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    sink(event);
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not POST when the viewer is signed out (no token)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const sink = createWallAnalyticsTransport({
      baseUrl: 'https://api.example.com',
      getToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    sink(event);
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows a transport error (fire-and-forget, never throws)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network down'));
    const sink = createWallAnalyticsTransport({
      baseUrl: 'https://api.example.com',
      getToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(() => sink(event)).not.toThrow();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('recordRealWorldOutcome consent gate (§32)', () => {
  const projection = {
    projectionId: 'p1',
    canonicalObjectId: 'c-p1',
    objectType: 'social_post',
    publishedAt: new Date().toISOString(),
    visibility: 'public',
    actions: [],
  } as unknown as WallProjection;

  let events: WallAnalyticsEvent[];
  beforeEach(() => {
    events = [];
    setWallAnalyticsSink((e) => events.push(e));
  });
  afterEach(() => {
    resetWallAnalyticsSink();
    resetRealWorldOutcomeConsent();
  });

  it('drops the outcome when consent is absent (fail-closed default)', () => {
    recordRealWorldOutcome(projection, 'see_place');
    expect(events.some((e) => e.type === 'wall_real_world_outcome')).toBe(false);
  });

  it('emits the outcome (ids + coarse enum) once consent is granted', () => {
    setRealWorldOutcomeConsent(true);
    recordRealWorldOutcome(projection, 'add_to_trip');
    const out = events.find(
      (e): e is Extract<WallAnalyticsEvent, { type: 'wall_real_world_outcome' }> =>
        e.type === 'wall_real_world_outcome',
    );
    expect(out).toBeDefined();
    expect(out?.objectId).toBe('c-p1');
    expect(out?.outcome).toBe('add_to_trip');
  });
});
