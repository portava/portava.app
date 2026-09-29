/**
 * TRIP-F06 on the client — the owner's review list, approve / decline, and the
 * requester's own request (send, recover its id, cancel).
 * Run: node --import tsx/esm --test src/features/trips/joinRequests/__tests__/tripJoinRequests.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripJoinRequests.ts');
let mod: Mod;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: (url: string, init?: RequestInit) => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond(String(url), init)); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const header = (i: number, name: string) => ((calls[i]!.init?.headers ?? {}) as Record<string, string>)[name];

describe('join requests — owner review', () => {
  before(async () => { mod = await import('../tripJoinRequests.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { calls = []; });

  it('reads the pending requests across the owner\'s trips and groups them by trip, newest first', async () => {
    respond = () => json({ requests: [
      { id: 'r1', tripId: 't1', status: 'pending', message: 'hi', createdAt: '2026-09-01T00:00:00Z', user: { id: 'u1', handle: 'ana', name: 'Ana', avatarUrl: null } },
      { id: 'r2', tripId: 't2', status: 'pending', message: null, createdAt: '2026-09-03T00:00:00Z', user: null },
      { id: 'r3', tripId: 't1', status: 'pending', message: null, createdAt: '2026-09-02T00:00:00Z', user: null },
    ] });
    const r = await mod.fetchJoinRequests();
    assert.equal(r.state, 'ok');
    if (r.state !== 'ok') return;
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/join-requests');
    assert.deepEqual(mod.requestsForTrip(r.data, 't1').map((x) => x.id), ['r3', 'r1']);
    assert.equal(mod.requesterLabel(r.data[0]!), 'Ana (@ana)');
    // A requester whose profile could not be read is still a request, named as unknown — never dropped.
    assert.equal(mod.requesterLabel(r.data[1]!), 'Someone (profile unavailable)');
  });

  it('a failed read is unavailable — never an empty queue — and a body without the list is not an empty list', async () => {
    respond = () => json({ error: 'db_error', message: 'boom' }, 500);
    const u = await mod.fetchJoinRequests();
    assert.equal(u.state, 'unavailable');
    respond = () => json({ nope: true });
    const v = await mod.fetchJoinRequests();
    assert.equal(v.state, 'unavailable');
  });

  it('approve sends the intent\'s Idempotency-Key (the route runs ADD_PARTICIPANT through the kernel), and a refusal keeps its reason', async () => {
    respond = () => json({ status: 'approved', requestId: 'r1', userId: 'u1' });
    const a = await mod.approveJoinRequest('t1', 'r1', 'join-approve:k1');
    assert.equal(a.state, 'done');
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/t1/join-requests/r1/approve');
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(header(0, 'Idempotency-Key'), 'join-approve:k1');
    respond = () => json({ error: 'invalid_state_transition', message: 'Request is already declined' }, 409);
    const b = await mod.approveJoinRequest('t1', 'r1', 'join-approve:k2');
    assert.deepEqual(b, { state: 'refused', status: 409, reason: 'invalid_state_transition', detail: 'Request is already declined' });
    respond = () => json({ error: 'degraded_unavailable', reason: 'TRIP_KERNEL_UNAVAILABLE' }, 503);
    assert.equal((await mod.approveJoinRequest('t1', 'r1', 'k3')).state, 'unavailable');
  });

  it('decline posts to its own route', async () => {
    respond = () => json({ status: 'declined', requestId: 'r1' });
    const d = await mod.declineJoinRequest('t1', 'r1');
    assert.equal(d.state, 'done');
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/t1/join-requests/r1/decline');
  });
});

describe('join requests — the requester', () => {
  beforeEach(() => { calls = []; });

  it('sending a request returns its id; asking again while pending recovers the SAME id without filing a second one', async () => {
    respond = () => json({ status: 'pending', requestId: 'r9', createdAt: 'x' }, 201);
    const s = await mod.sendJoinRequest('t1', 'please');
    assert.deepEqual(s, { state: 'pending', requestId: 'r9' });
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { message: 'please' });
    respond = () => json({ status: 'already_requested', requestId: 'r9', idempotent: true });
    assert.deepEqual(await mod.sendJoinRequest('t1'), { state: 'pending', requestId: 'r9' });
    respond = () => json({ status: 'already_member', idempotent: true });
    assert.deepEqual(await mod.sendJoinRequest('t1'), { state: 'member' });
    respond = () => json({ error: 'forbidden', message: 'This trip does not accept join requests' }, 403);
    const f = await mod.sendJoinRequest('t1');
    assert.equal(f.state, 'refused');
  });

  it('cancel withdraws the viewer\'s own pending request', async () => {
    respond = () => json({ status: 'cancelled', requestId: 'r9' });
    const c = await mod.cancelJoinRequest('t1', 'r9');
    assert.equal(c.state, 'done');
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/t1/join-requests/r9/cancel');
    assert.equal(calls[0]!.init?.method, 'POST');
  });
});
