// NOTE: intentionally exhaustive — the rank API is a separate transport.
jest.mock('../wallApi.ts', () => ({ sendAction: jest.fn(), sendImpression: jest.fn() }));
// NOTE: intentionally exhaustive — token identity is supplied by the test owner.
jest.mock('../../../../services/messagingOwnerRequest.ts', () => ({ captureMessagingOwnerRequest: jest.fn(), messagingOwnerToken: jest.fn() }));
import { messagingOwnerToken } from '../../../../services/messagingOwnerRequest.ts';
import { fetchOwnedApi } from '../../../../services/ownedApiRequest.ts';
import { createWallAnalyticsTransport } from '../wallAnalyticsTransport.ts';
import { recordRealWorldOutcome, setRealWorldOutcomeConsent, resetRealWorldOutcomeConsent,
  setWallAnalyticsSink, resetWallAnalyticsSink, type WallAnalyticsEvent } from '../wallAnalytics.ts';
import type { WallProjection } from '../../types/wallProjection.ts';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const owner = { ownerId: 'a', sessionId: 'session-a', isCurrent: () => true, invalidate: () => {} };
const event: WallAnalyticsEvent = { type: 'wall_feed_open', mode: 'for_you' };
const outcome: WallAnalyticsEvent = { type: 'wall_real_world_outcome', objectId: 'place-1', objectType: 'place', outcome: 'see_place' };
const grant = '2026-11-13T12:00:00.000Z';
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });
describe('Wall owner-bound transport', () => {
  it('posts only typed data and captures the owner synchronously', async () => {
    const send = jest.fn().mockResolvedValue({});
    const captureOwner = jest.fn(() => owner);
    const sink = createWallAnalyticsTransport({ baseUrl: 'https://example.test', captureOwner, send, outcomeConsentAt: () => grant });
    sink(outcome);
    expect(captureOwner).toHaveBeenCalledTimes(1);
    await flush();
    expect(send).toHaveBeenCalledWith('/api/wall/telemetry', expect.objectContaining({ owner, method: 'POST', body: { events: [outcome], meta: { outcomeConsentAt: grant } } }));
    sink.dispose();
  });
  it('drops missing configuration, signed-out sessions and absent outcome consent', async () => {
    const send = jest.fn();
    for (const [baseUrl, account] of [['', owner], ['https://example.test', null]] as const) {
      const sink = createWallAnalyticsTransport({ baseUrl, captureOwner: () => account, send, outcomeConsentAt: () => grant });
      sink(event); sink.dispose();
    }
    const sink = createWallAnalyticsTransport({ baseUrl: 'https://example.test', captureOwner: () => owner, send, outcomeConsentAt: () => null });
    sink(outcome); await flush(); expect(send).not.toHaveBeenCalled(); sink.dispose();
  });
  it('never sends after delayed token lookup crosses accounts', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://example.test';
    let resolveToken!: (token: string) => void;
    (messagingOwnerToken as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveToken = resolve; }));
    global.fetch = jest.fn() as any;
    let current = true;
    const captured = { ...owner, isCurrent: () => current };
    const sink = createWallAnalyticsTransport({ baseUrl: 'https://example.test', captureOwner: () => captured, send: fetchOwnedApi, outcomeConsentAt: () => grant });
    sink(outcome); await flush(); current = false; resolveToken('token-for-new-owner'); await flush();
    expect(global.fetch).not.toHaveBeenCalled(); sink.dispose();
  });
  it('withdrawal invalidates queued work and aborts a pending network request', async () => {
    const send = jest.fn(() => new Promise(() => {}));
    const sink = createWallAnalyticsTransport({ baseUrl: 'https://example.test', captureOwner: () => owner, send, outcomeConsentAt: () => grant });
    sink(outcome); sink.invalidate(); await flush(); expect(send).not.toHaveBeenCalled();
    sink(outcome); await flush(); const options = (send.mock.calls[0] as any[])[1];
    expect(options.isCurrent()).toBe(true); sink.invalidate();
    expect(options.signal.aborted).toBe(true); expect(options.isCurrent()).toBe(false); sink.dispose();
  });
  it('bounds pending work, drops a replaced grant and swallows delivery errors', async () => {
    let at: string | null = grant;
    const send = jest.fn().mockRejectedValue(new Error('offline'));
    const sink = createWallAnalyticsTransport({ baseUrl: 'https://example.test', captureOwner: () => owner, send, outcomeConsentAt: () => at });
    sink(outcome); at = '2026-11-13T13:00:00Z'; await flush(); expect(send).not.toHaveBeenCalled();
    for (let i = 0; i < 100; i++) sink(event);
    await flush(); expect(send).toHaveBeenCalledTimes(32); sink.dispose(); sink(event); await flush(); expect(send).toHaveBeenCalledTimes(32);
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
    setRealWorldOutcomeConsent(true, owner);
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
