/**
 * census-trips TR256 on the client — reading the private-anchor layer the
 * server now scopes, and the owner's grant / revoke calls.
 *
 * SHOWN RED FIRST: on `2e46835263` the module does not exist (the file does not
 * load). Mutants, each applied alone and restored:
 *   • a point with no `meta.relation` drawn as the viewer's own        → A2.
 *   • `toggleAllowed` letting a grant through while sharing is off     → B1.
 *   • `toggleAllowed` refusing a revoke while sharing is off           → B1.
 *   • `sharesAfter` trusting a 'done' whose body is unreadable         → C3.
 *
 * Run: node --import tsx/esm --test src/features/trips/anchors/__tests__/privateAnchors.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../privateAnchors.ts');
let mod: Mod;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: (url: string, init?: RequestInit) => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond(String(url), init)); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

// A projection carrying only the layer this module reads; the rest are irrelevant here.
const projection = (privateAnchors: unknown) => ({ privateAnchors } as never);
const point = (id: string, relation?: string) => ({
  id, kind: 'private_anchor', lat: 1, lng: 1, label: id === 'h1' ? 'Hotel Lisboa' : null, privateAnchor: true,
  meta: relation ? { relation } : {},
});

before(async () => {
  mod = await import('../privateAnchors.ts');
  const { _setTestToken } = await import('../../shared/auth.ts');
  _setTestToken(async () => 'tok');
});
beforeEach(() => { calls = []; });

describe('A. the layer, as the server scoped it', () => {
  it('A1. own and shared-with-me are split; a label-less place is called "Private place"', () => {
    const v = mod.privatePlacesOf(projection({ status: 'ok', items: [point('h1', 'own'), point('h2', 'shared_with_me')] }));
    assert.equal(v.state, 'ok');
    if (v.state !== 'ok') return;
    assert.deepEqual(v.own.map((p) => p.id), ['h1']);
    assert.deepEqual(v.sharedWithMe.map((p) => p.id), ['h2']);
    assert.equal(mod.placeLabel(v.own[0]!), 'Hotel Lisboa');
    assert.equal(mod.placeLabel(v.sharedWithMe[0]!), 'Private place');
  });

  it('A2. THE POINT: a point with no relation (an older, unscoped server) is never drawn', () => {
    const v = mod.privatePlacesOf(projection({ status: 'ok', items: [point('h9'), point('h8', 'someone_elses')] }));
    assert.deepEqual(v, { state: 'ok', own: [], sharedWithMe: [] });
  });

  it('A3. an unread layer is unread — never "no private places"', () => {
    assert.deepEqual(mod.privatePlacesOf(projection({ status: 'unread', reason: 'shares down' })), { state: 'unread', reason: 'shares down' });
    assert.deepEqual(mod.privatePlacesOf(projection({ status: 'no_source', reason: 'x' })), { state: 'no_source' });
  });
});

describe('B. what a switch may do', () => {
  it('B1. granting needs sharing ON; taking a grant back never does', () => {
    assert.equal(mod.toggleAllowed({ sharingEnabled: true, memberIds: [] }, 'u1'), 'grant');
    assert.equal(mod.toggleAllowed({ sharingEnabled: false, memberIds: [] }, 'u1'), 'unavailable');
    assert.equal(mod.toggleAllowed({ sharingEnabled: false, memberIds: ['u1'] }, 'u1'), 'revoke');
    assert.equal(mod.toggleAllowed({ sharingEnabled: true, memberIds: ['u1'] }, 'u1'), 'revoke');
  });
});

describe('C. the grant routes', () => {
  it('C1. list: the owner\'s grant list, or unavailable — never an empty list from a failed read', async () => {
    respond = () => json({ ok: true, sharingEnabled: true, memberIds: ['u1'] });
    const r = await mod.fetchAnchorShares('t1', 'h1');
    assert.deepEqual(r, { state: 'ok', data: { ok: true, sharingEnabled: true, memberIds: ['u1'] } });
    assert.equal(calls[0]!.url, 'http://api.test/api/trips/t1/anchors/h1/shares');
    respond = () => json({ error: 'degraded_unavailable', message: 'down' }, 503);
    const bad = await mod.fetchAnchorShares('t1', 'h1');
    assert.equal(bad.state, 'unavailable');
  });

  it('C2. grant POSTs the member; revoke DELETEs the member\'s path', async () => {
    respond = () => json({ ok: true, sharingEnabled: true, memberIds: ['u1'] }, 201);
    const g = await mod.grantAnchorShare('t1', 'h1', 'u1');
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.body, JSON.stringify({ memberId: 'u1' }));
    assert.deepEqual(mod.sharesAfter(g), { sharingEnabled: true, memberIds: ['u1'] });
    respond = () => json({ ok: true, sharingEnabled: false, memberIds: [] });
    const rv = await mod.revokeAnchorShare('t1', 'h1', 'u1');
    assert.equal(calls[1]!.init?.method, 'DELETE');
    assert.equal(calls[1]!.url, 'http://api.test/api/trips/t1/anchors/h1/shares/u1');
    assert.deepEqual(mod.sharesAfter(rv), { sharingEnabled: false, memberIds: [] });
  });

  it('C3. a write the server refused, or answered unreadably, yields NO grant list — the client never assumes', async () => {
    respond = () => json({ error: 'forbidden', message: 'Only the person who added a private place can share it' }, 403);
    const refused = await mod.grantAnchorShare('t1', 'h1', 'u1');
    assert.equal(refused.state, 'refused');
    assert.equal(mod.sharesAfter(refused), null);
    respond = () => json({ ok: true }, 201);
    const unreadable = await mod.grantAnchorShare('t1', 'h1', 'u1');
    assert.equal(unreadable.state, 'done');
    assert.equal(mod.sharesAfter(unreadable), null);
  });
});
