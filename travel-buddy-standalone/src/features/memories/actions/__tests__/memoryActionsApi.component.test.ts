/**
 * memoryActionsApi — the client for §14 Executable Memories.
 *
 * Pins the one property the action bar's honesty rests on: a failed read is
 * NEVER returned as an empty menu or a plan. A 503 is `degraded_unavailable`,
 * a refusal carries the server's `reason`, a malformed 200 is an error, an
 * unreachable network is `network_unreachable` — and the trip a person picked
 * is the trip that is sent.
 *
 * A jest suite (not node:test) because the token helper reaches react-native,
 * which node:test cannot transform here (see scripts/run-node-tests.mjs KNOWN_BROKEN).
 *
 * Run with: pnpm test:component
 */
// NOTE: intentionally exhaustive — the real module constructs a Supabase client
// whose auto-refresh timer outlives the suite; this file needs only the token.
jest.mock('../../../../services/apiToken.ts', () => ({
  freshToken: () => Promise.resolve('tok'),
}));

import {
  getMemoryActions, compileDoAgain, compileAddToTrip, compileTakeMeBack, compileBringForward, directionsUrl,
} from '../memoryActionsApi.ts';

const MEM = '10000000-0000-4000-8000-000000000001';
const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function respond(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('getMemoryActions', () => {
  it('returns the menu on 200, authenticated, at the menu path', async () => {
    respond(200, { menu: { engineVersion: 'memory-actions@1', memoryId: MEM, isOwner: true, place: null, actions: [] } });
    const r = await getMemoryActions(MEM);
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe(`https://api.test/api/memories/${MEM}/actions`);
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('a 503 is degraded_unavailable — never an empty menu', async () => {
    respond(503, { error: 'degraded_unavailable', message: 'Could not read this Memory. Please try again.' });
    const r = await getMemoryActions(MEM);
    expect(r).toEqual({ ok: false, kind: 'degraded_unavailable', message: 'Could not read this Memory. Please try again.', reason: null });
  });

  it('a malformed 200 is an error, not a menu', async () => {
    respond(200, { menu: { actions: 'nope' } });
    const r = await getMemoryActions(MEM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('db_error');
  });

  it('an unreachable network is network_unreachable', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
    const r = await getMemoryActions(MEM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('network_unreachable');
  });
});

describe('compiles', () => {
  it("a refusal carries the server's reason", async () => {
    respond(409, { error: 'conflict', message: 'This place has closed.', reason: 'PLACE_CLOSED' });
    const r = await compileAddToTrip(MEM);
    expect(r).toEqual({ ok: false, kind: 'conflict', message: 'This place has closed.', reason: 'PLACE_CLOSED' });
  });

  it('DO_AGAIN sends the trip the person picked, and only then', async () => {
    const plan = { action: 'DO_AGAIN', addToTrip: { id: 'p' }, tripChoice: { state: 'no_trips', candidates: [] }, freedom: { consulted: false }, fusion: {} };
    respond(200, { compiled: plan });
    await compileDoAgain(MEM, 'trip-1');
    expect(calls[0]!.url).toBe(`https://api.test/api/memories/${MEM}/actions/DO_AGAIN?tripId=trip-1`);
    await compileDoAgain(MEM, null);
    expect(calls[1]!.url).toBe(`https://api.test/api/memories/${MEM}/actions/DO_AGAIN`);
  });

  it('a compile answered for a different action is not accepted as this one', async () => {
    // A DO_AGAIN plan also carries an addToTrip payload — the action name is
    // what makes it not an ADD_TO_TRIP answer.
    respond(200, { compiled: { action: 'DO_AGAIN', addToTrip: { id: 'p', name: 'X' }, navigation: { lat: 1, lng: 2 } } });
    const r = await compileAddToTrip(MEM);
    expect(r.ok).toBe(false);
  });

  it('TAKE_ME_BACK and BRING_FORWARD_SAVED return what the server compiled', async () => {
    respond(200, { compiled: { action: 'TAKE_ME_BACK', navigation: { kind: 'catalog_place', label: 'X', lat: 1, lng: 2 }, caution: 'MOVED' } });
    const t = await compileTakeMeBack(MEM);
    expect(t.ok && t.caution).toBe('MOVED');
    respond(200, { compiled: { action: 'BRING_FORWARD_SAVED', items: [], leftBehind: [{ placeName: 'Y', reason: 'PLACE_CLOSED' }] } });
    const b = await compileBringForward(MEM);
    expect(b.ok && b.leftBehind.length).toBe(1);
  });
});

describe('directionsUrl', () => {
  it('uses the coordinate when there is one, the label and address otherwise', () => {
    expect(directionsUrl({ kind: 'catalog_place', placeId: 'p', label: 'X', address: null, lat: 35.1, lng: 139.2, historical: false }))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=35.1,139.2');
    expect(directionsUrl({ kind: 'catalog_place', placeId: 'p', label: 'Cafe', address: '1 Main St', lat: null, lng: null, historical: false }))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=Cafe%2C%201%20Main%20St');
  });
});
