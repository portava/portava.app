/**
 * useRankOutcome — the served `recommendationId` is echoed on every outcome
 * (DV-46, the client leg), and a successful dismissal invalidates the Discovery
 * device caches. census-discovery §50.
 *
 * THE CONTRACT, QUOTED
 * ====================
 * `artifacts/api-server/src/lib/discoveryRecommendationRecord.ts`,
 * RECOMMENDATION_PROPAGATION_RULES, hop 3:
 *   "the client echoes the item's `recommendationId` as `recommendation_id` in
 *    POST /rank-events/outcome"
 * and hop 4: the server binds it by (signed-in caller, recommendation_id) only;
 * another viewer's id credits nothing and an id naming a different item or
 * surface is refused.
 *
 * WHAT WAS WRONG
 * ==============
 * The outcome body was { item_id, surface, outcome, session_id? } — never the
 * id. `GET /discovery` stamps each item with the exposure id minted for THIS
 * viewer's serve, and the client dropped it on the floor, so the server could
 * only join an outcome back to its exposure by guessing (most recent
 * impression for the item).
 *
 * WHAT IS PINNED
 * ==============
 *   • present and well-formed ⇒ sent, verbatim, as `recommendation_id`;
 *   • absent ⇒ the KEY is absent (not null, not "");
 *   • malformed (not 2891's 22-char base64url shape) ⇒ omitted, never sent to be
 *     refused;
 *   • every outcome path carries it: fire-and-forget, the hook's tap/save/join/
 *     rsvp/trip_add, and the awaited dismissal;
 *   • a dismissal the server ACCEPTED clears the Discovery device caches (the
 *     server stops serving the place on the very next request); one it refused
 *     does not.
 *
 * Run with: pnpm test:component
 */

import { renderHook, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — apiToken imports the Supabase client; only
// freshToken is needed and a fixed token is all these tests require.
jest.mock('../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

import { useRankOutcome, fireRankOutcome, servedRecommendationId } from '../useRankOutcome.ts';
import {
  onDiscoveryScopeChange,
  currentDiscoveryScope,
  _resetDiscoveryViewerScopeForTests,
} from '../../services/discoveryViewerScope.ts';

/** A well-formed exposure id: 22 base64url characters, the shape 2891 checks. */
const RID = 'Ab3_-x9QzW7kLmN2pR4tUv';
const fetchMock = jest.fn((_url: string, _init?: RequestInit) => Promise.resolve({ ok: true } as Response));

const ORIGINAL_FETCH = global.fetch;
/** §63 (DV-37): every outcome now names its action with a fresh v4 `client_event_id`. */
const KEY = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const ORIGINAL_BASE  = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve({ ok: true } as Response));
  _resetDiscoveryViewerScopeForTests();
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE;
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function postedBody(callIndex = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe('DV-46 — the served recommendationId reaches POST /rank-events/outcome', () => {
  it('the fixture id is the column\'s shape, so every positive case below is a real one', () => {
    expect(servedRecommendationId(RID)).toBe(RID);
  });

  it('fire-and-forget: a well-formed id is sent verbatim as recommendation_id', async () => {
    fireRankOutcome('node/1', 'discovery', 'tap', null, RID);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/rank-events/outcome');
    expect(postedBody()).toEqual({ item_id: 'node/1', surface: 'discovery', outcome: 'tap', recommendation_id: RID, client_event_id: KEY });
  });

  it('absent ⇒ the KEY is absent — an anonymous serve carries no id and none is invented', async () => {
    fireRankOutcome('node/1', 'discovery', 'tap');
    fireRankOutcome('node/2', 'discovery', 'tap', null, null);
    fireRankOutcome('node/3', 'discovery', 'tap', null, undefined);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) expect(postedBody(i)).not.toHaveProperty('recommendation_id');
  });

  it.each([
    ['empty', ''],
    ['too short', RID.slice(1)],
    ['too long', `${RID}A`],
    ['not base64url', `${RID.slice(0, 21)}+`],
    ['not a string', 12345],
  ])('malformed (%s) ⇒ omitted, not sent to be refused', async (_label, bad) => {
    expect(servedRecommendationId(bad)).toBeNull();
    fireRankOutcome('node/1', 'discovery', 'save', null, bad as string);
    await settle();
    expect(postedBody()).not.toHaveProperty('recommendation_id');
  });

  it('the hook: tap, save, join, rsvp and trip_add all carry the id beside the item id', async () => {
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery', sessionId: '11111111-2222-3333-4444-555555555555' }));
    await act(async () => {
      result.current.reportTap('node/1', RID);
      result.current.reportSave('node/1', RID);
      result.current.reportJoin('node/1', RID);
      result.current.reportRsvp('node/1', RID);
      result.current.reportTripAdd('node/1', RID);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const outcomes = fetchMock.mock.calls.map((_c, i) => postedBody(i));
    expect(outcomes.map((b) => b.outcome)).toEqual(['tap', 'save', 'join', 'rsvp', 'trip_add']);
    for (const b of outcomes) {
      expect(b.recommendation_id).toBe(RID);
      expect(b.item_id).toBe('node/1');
      expect(b.session_id).toBe('11111111-2222-3333-4444-555555555555');
    }
  });

  it('the hook without an id: the body is exactly the old one', async () => {
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    await act(async () => { result.current.reportTap('node/1'); });
    await settle();
    expect(postedBody()).toEqual({ item_id: 'node/1', surface: 'discovery', outcome: 'tap', client_event_id: KEY });
  });

  it('the awaited dismissal carries the id too', async () => {
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    let ok = false;
    await act(async () => { ok = await result.current.reportDismiss('node/1', RID); });
    expect(ok).toBe(true);
    expect(postedBody()).toEqual({ item_id: 'node/1', surface: 'discovery', outcome: 'dismiss', recommendation_id: RID, client_event_id: KEY });
  });
});

describe('a dismissal the server accepted invalidates the Discovery device caches', () => {
  it('accepted ⇒ every registered cache is cleared and the scope moves', async () => {
    const cleared = jest.fn();
    const off = onDiscoveryScopeChange(cleared);
    const before = currentDiscoveryScope().epoch;
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    await act(async () => { await result.current.reportDismiss('node/1', RID); });
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(currentDiscoveryScope().epoch).toBe(before + 1);
    off();
  });

  it.each([
    ['refused (404: no impression to dismiss)', () => Promise.resolve({ ok: false, status: 404 } as Response)],
    ['a transport failure', () => Promise.reject(new Error('offline'))],
  ])('CONTROL: %s ⇒ nothing is cleared — the server serves exactly what it did', async (_label, impl) => {
    fetchMock.mockImplementation(impl as () => Promise<Response>);
    const cleared = jest.fn();
    const off = onDiscoveryScopeChange(cleared);
    const { result } = await renderHook(() => useRankOutcome({ surface: 'discovery' }));
    let ok = true;
    await act(async () => { ok = await result.current.reportDismiss('node/1', RID); });
    expect(ok).toBe(false);
    expect(cleared).not.toHaveBeenCalled();
    off();
  });
});
