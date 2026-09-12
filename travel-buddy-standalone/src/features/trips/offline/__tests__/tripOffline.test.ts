/**
 * §18 on the client — the bundle kept as issued, its staleness judged by the
 * server's rule, the queue replayed with the server's decisions applied.
 * census-trips TR334, TR343, TR349, TR421, TR432.
 *
 * Run: node --import tsx/esm --test src/features/trips/offline/__tests__/tripOffline.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripOffline.ts');
let mod: Mod;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: (url: string, init?: RequestInit) => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond(String(url), init)); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-09-13T12:00:00Z');
const signed = (over: Record<string, unknown> = {}) => ({
  bundle: {
    bundleSchemaVersion: 1, tripId: TRIP, sourceTripVersion: 7, generatedAt: '2026-09-13T10:00:00.000Z', expiresAt: '2026-09-14T10:00:00.000Z',
    contents: {
      nextCommitments: [{ id: 'c1', type: 'event', title: 'Dinner', startsAt: '2026-09-13T18:00:00Z', requiredArrivalAt: null, placeName: 'Chez Nous' }],
      activePlan: null,
      plans: [{ id: 'p1', title: 'Louvre', status: 'confirmed', dayDate: '2026-09-13', startsAt: null, endsAt: null, locationName: 'Louvre' }],
      meetingPoints: [], criticalAddresses: [{ kind: 'reservation', id: 'r1', title: 'Hotel', address: '1 rue X', at: null }],
      certifiedContext: { sourceTripVersion: 7, certifiedAt: '2026-09-13T10:00:00.000Z', reading: 'x' },
    },
    notCarried: { selectedRoute: 'none', meetingPoints: 'none', mapTiles: 'none' },
    ...over,
  },
  signature: 'a'.repeat(64), algorithm: 'hmac-sha256', readings: { commitments: 'x', staleness: 'the bundle is current' },
});

describe('the bundle: kept as issued, judged by the server\'s rule', () => {
  before(async () => { mod = await import('../tripOffline.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { calls = []; mod._setStore(mod.memoryStore()); });

  it('fetches the signed bundle and stores it byte-for-byte, signature included', async () => {
    respond = () => new Response(JSON.stringify(signed()), { status: 200 });
    const r = await mod.fetchOfflineBundle(TRIP);
    assert.equal(r.state, 'ok'); if (r.state !== 'ok') return;
    assert.equal(calls[0]!.url, `http://api.test/api/trips/${TRIP}/offline-bundle`);
    const rec = await mod.storeBundle(TRIP, r.signed, NOW);
    const back = await mod.loadStoredBundle(TRIP);
    assert.deepEqual(back?.signed, r.signed, 'stored as issued, never edited');
    assert.equal(back?.signed.signature, 'a'.repeat(64));
    assert.equal(rec.storedAt, new Date(NOW).toISOString());
  });
  it('staleness mirrors the server: current, expired, or behind the trip\'s version — and a stale copy is still there', () => {
    const b = signed().bundle;
    assert.equal(mod.bundleStaleness(b, NOW, 7).stale, false);
    assert.equal(mod.bundleStaleness(b, NOW, null).stale, false, 'no current version known: not stale by version');
    const behind = mod.bundleStaleness(b, NOW, 9);
    assert.deepEqual([behind.stale, behind.because], [true, 'version_behind']); assert.match(behind.detail, /read at trip version 7 and the trip is at 9/);
    const expired = mod.bundleStaleness(b, Date.parse('2026-09-15T00:00:00Z'), 7);
    assert.deepEqual([expired.stale, expired.because], [true, 'expired']);
  });
  it('an unsigned or malformed body is unavailable; feature_disabled is off; a failed read leaves the stored copy untouched', async () => {
    respond = () => new Response(JSON.stringify({ bundle: { tripId: TRIP } }), { status: 200 });
    assert.equal((await mod.fetchOfflineBundle(TRIP)).state, 'unavailable');
    respond = () => new Response(JSON.stringify({ error: 'feature_disabled' }), { status: 404 });
    assert.equal((await mod.fetchOfflineBundle(TRIP)).state, 'off');
    await mod.storeBundle(TRIP, signed() as any, NOW);
    respond = () => new Response(JSON.stringify({ error: 'server_not_configured', message: 'no secret' }), { status: 503 });
    const u = await mod.fetchOfflineBundle(TRIP);
    assert.equal(u.state, 'unavailable'); if (u.state === 'unavailable') assert.equal(u.detail, 'no secret');
    assert.equal((await mod.loadStoredBundle(TRIP))?.signed.bundle.sourceTripVersion, 7);
  });
});

describe('the queue: §18.3\'s contract, the server\'s decisions applied', () => {
  before(async () => { mod = await import('../tripOffline.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { calls = []; mod._setStore(mod.memoryStore()); });

  it('an operation is queued with its own idempotency key, the stored bundle\'s version as expectedTripVersion, and a bounded queue', async () => {
    await mod.storeBundle(TRIP, signed() as any, NOW);
    const q = await mod.enqueueOperation(TRIP, { type: 'JOIN_PLAN', payload: { item_id: 'p1' }, now: NOW, operationId: '11111111-1111-4111-8111-111111111111' });
    assert.ok(q.ok); if (!q.ok) return;
    assert.equal(q.entry.op.expectedTripVersion, 7);
    assert.equal(q.entry.op.clientOccurredAt, new Date(NOW).toISOString());
    assert.equal(q.entry.op.idempotencyKey, `offline:${TRIP}:11111111-1111-4111-8111-111111111111`);
    assert.equal(q.entry.state, 'pending');
    assert.equal((await mod.loadQueue(TRIP)).length, 1);
    for (let i = 0; i < mod.QUEUE_MAX_OPERATIONS - 1; i += 1) assert.ok((await mod.enqueueOperation(TRIP, { type: 'SET_PRESENCE', now: NOW })).ok);
    const full = await mod.enqueueOperation(TRIP, { type: 'SET_PRESENCE', now: NOW });
    assert.equal(full.ok, false); if (!full.ok) assert.equal(full.reason, 'QUEUE_FULL');
  });
  it('applyReplayResults: replayed and duplicate leave as done, rejected leaves with the reason, a conflict is settled as a conflict (never overwritten), revalidate stays marked, a kernel-off refusal stays held, an unanswered one stays pending', () => {
    const op = (id: string, type = 'JOIN_PLAN') => ({ op: { operationId: id, tripId: TRIP, expectedTripVersion: 7, type, payload: {}, clientOccurredAt: new Date(NOW).toISOString(), idempotencyKey: `k-${id}` }, state: 'pending' as const, note: null });
    const queue = [op('a'), op('b'), op('c'), op('d'), op('e'), op('f'), op('g')];
    const { remaining, settled } = mod.applyReplayResults(queue, [
      { operationId: 'a', type: 'JOIN_PLAN', decision: 'replay', ok: true, duplicate: false },
      { operationId: 'b', type: 'JOIN_PLAN', decision: 'replay', ok: true, duplicate: true, detail: 'already applied' },
      { operationId: 'c', type: 'JOIN_PLAN', decision: 'reject', ok: false, reasonCode: 'TRIP_OFFLINE_QUEUE_REJECTED', detail: 'too old' },
      { operationId: 'd', type: 'JOIN_PLAN', decision: 'replay', ok: false, reasonCode: 'TRIP_VERSION_CONFLICT', detail: 'the trip moved on' },
      { operationId: 'e', type: 'CANCEL_PLAN', decision: 'revalidate', ok: false, reasonCode: 'TRIP_OFFLINE_REVALIDATION_REQUIRED', detail: 'confirm against version 9' },
      { operationId: 'f', type: 'JOIN_PLAN', decision: 'replay', ok: false, reasonCode: 'TRIP_KERNEL_UNAVAILABLE', detail: 'kernel off' },
    ]);
    assert.deepEqual(settled.map((s) => [s.op.operationId, s.outcome]), [['a', 'replayed'], ['b', 'duplicate'], ['c', 'rejected'], ['d', 'conflict']]);
    assert.deepEqual(remaining.map((r) => [r.op.operationId, r.state]), [['e', 'revalidate'], ['f', 'held'], ['g', 'pending']]);
    assert.equal(remaining[0]!.note, 'confirm against version 9');
  });
  it('replayQueue posts the queue with the stored bundle, keeps what the server said to keep, and a confirmed operation goes back to pending at the current version', async () => {
    await mod.storeBundle(TRIP, signed() as any, NOW);
    await mod.enqueueOperation(TRIP, { type: 'JOIN_PLAN', now: NOW, operationId: '11111111-1111-4111-8111-111111111111' });
    await mod.enqueueOperation(TRIP, { type: 'CANCEL_PLAN', now: NOW, operationId: '22222222-2222-4222-8222-222222222222' });
    respond = () => new Response(JSON.stringify({
      tripId: TRIP, currentVersion: 9,
      counts: { replayed: 1, setOperations: 0, duplicates: 0, conflicted: 0, revalidate: 1, rejected: 0, refused: 0 },
      results: [
        { operationId: '11111111-1111-4111-8111-111111111111', type: 'JOIN_PLAN', decision: 'replay', ok: true, duplicate: false, version: 9 },
        { operationId: '22222222-2222-4222-8222-222222222222', type: 'CANCEL_PLAN', decision: 'revalidate', ok: false, reasonCode: 'TRIP_OFFLINE_REVALIDATION_REQUIRED', detail: 'a cancellation waits for you to look at version 9' },
      ],
      reading: '§18.3',
    }), { status: 200 });
    const r = await mod.replayQueue(TRIP);
    assert.equal(r.state, 'replayed'); if (r.state !== 'replayed') return;
    const sent = JSON.parse(String(calls[0]!.init?.body));
    assert.equal(calls[0]!.url, `http://api.test/api/trips/${TRIP}/operations`);
    assert.equal(sent.operations.length, 2); assert.equal(sent.bundle.signature, 'a'.repeat(64)); assert.equal(sent.bundle.bundle.sourceTripVersion, 7);
    assert.equal(r.currentVersion, 9);
    assert.deepEqual(r.settled.map((s) => s.outcome), ['replayed']);
    assert.deepEqual(r.remaining.map((e) => [e.op.type, e.state]), [['CANCEL_PLAN', 'revalidate']]);
    assert.deepEqual((await mod.loadQueue(TRIP)).map((e) => e.state), ['revalidate'], 'the queue on disk is what the server left');
    // Revalidate-marked operations are not re-sent on their own; nothing to replay means nothing_queued.
    assert.equal((await mod.replayQueue(TRIP)).state, 'nothing_queued');
    assert.equal(await mod.revalidateOperation(TRIP, '22222222-2222-4222-8222-222222222222', 9), true);
    const q = await mod.loadQueue(TRIP);
    assert.deepEqual([q[0]!.state, q[0]!.op.expectedTripVersion], ['pending', 9]);
  });
  it('a failed replay drops nothing; off keeps the queue', async () => {
    await mod.enqueueOperation(TRIP, { type: 'JOIN_PLAN', now: NOW });
    respond = () => { throw new Error('offline'); };
    const r = await mod.replayQueue(TRIP);
    assert.equal(r.state, 'unavailable');
    assert.equal((await mod.loadQueue(TRIP)).length, 1);
    respond = () => new Response(JSON.stringify({ error: 'feature_disabled' }), { status: 404 });
    assert.equal((await mod.replayQueue(TRIP)).state, 'off');
    assert.equal((await mod.loadQueue(TRIP)).length, 1);
  });
});
