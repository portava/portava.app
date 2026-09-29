/**
 * TRIP-F23 on the client — cancel / complete / archive / delete, and the §3.1
 * lifecycle read. Run: node --import tsx/esm --test src/features/trips/lifecycle/__tests__/tripLifecycle.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripLifecycle.ts');
let mod: Mod;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: (url: string, init?: RequestInit) => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond(String(url), init)); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe('trip lifecycle actions', () => {
  before(async () => { mod = await import('../tripLifecycle.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { calls = []; });

  it('offers only the arrows the status registry draws, and nothing to a non-owner', () => {
    assert.deepEqual(mod.lifecycleActions('upcoming', true), ['cancel', 'complete', 'archive', 'delete']);
    assert.deepEqual(mod.lifecycleActions('active', true), ['cancel', 'complete', 'archive', 'delete']);
    assert.deepEqual(mod.lifecycleActions('completed', true), ['archive', 'delete']);
    assert.deepEqual(mod.lifecycleActions('cancelled', true), ['archive', 'delete']);
    assert.deepEqual(mod.lifecycleActions('archived', true), []);
    assert.deepEqual(mod.lifecycleActions('upcoming', false), []);
  });

  it('each action POSTs its own route with the intent\'s Idempotency-Key — the route issues CANCEL_TRIP / COMPLETE_TRIP / ARCHIVE_TRIP', async () => {
    for (const [action, path] of [['cancel', 'cancel'], ['complete', 'complete'], ['archive', 'archive']] as const) {
      calls = [];
      respond = () => json({ status: action === 'cancel' ? 'cancelled' : action === 'complete' ? 'completed' : 'archived', tripId: 't1' });
      const r = await mod.runLifecycleAction('t1', action, `life:${action}:k`);
      assert.equal(r.state, 'done', action);
      assert.equal(calls[0]!.url, `http://api.test/api/trips/t1/${path}`);
      assert.equal(calls[0]!.init?.method, 'POST');
      assert.equal((calls[0]!.init?.headers as Record<string, string>)['Idempotency-Key'], `life:${action}:k`);
    }
  });

  it('delete is DELETE /trips/:id and a 204 is done', async () => {
    respond = () => new Response(null, { status: 204 });
    const r = await mod.runLifecycleAction('t1', 'delete', 'life:delete:k');
    assert.equal(r.state, 'done');
    assert.equal(calls[0]!.init?.method, 'DELETE');
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/t1');
  });

  it('the kernel\'s refusal is carried by name; an unreachable server is unavailable, not refused', async () => {
    respond = () => json({ error: 'invalid_state_transition', message: 'A completed trip cannot become cancelled', reason: 'TRIP_LIFECYCLE_INVALID_TRANSITION' }, 409);
    const r = await mod.runLifecycleAction('t1', 'cancel', 'k');
    assert.deepEqual(r, { state: 'refused', status: 409, reason: 'TRIP_LIFECYCLE_INVALID_TRANSITION', detail: 'A completed trip cannot become cancelled' });
    respond = () => { throw new Error('offline'); };
    assert.equal((await mod.runLifecycleAction('t1', 'cancel', 'k')).state, 'unavailable');
  });

  it('reads the derived §3.1 lifecycle with what it could not read', async () => {
    respond = () => json({ tripId: 't1', lifecycle: 'PLANNING', reason: 'no bookings', unread: ['passport_memories'], evidence: {}, storedStatus: 'planning', states: [] });
    const r = await mod.fetchTripLifecycle('t1');
    assert.equal(r.state, 'ok');
    if (r.state === 'ok') {
      assert.equal(r.data.lifecycle, 'PLANNING');
      assert.equal(mod.lifecycleLabel(r.data), 'Planning — 1 fact could not be read');
    }
    respond = () => json({ tripId: 't1' });
    assert.equal((await mod.fetchTripLifecycle('t1')).state, 'unavailable');
  });
});
