/**
 * census-trips TR116 — §6.3's privacy scope, read from and written to the plan
 * routes by the app. The read has three answers (a scope, not read, unknown);
 * the write is the plan route's PATCH and its refusals arrive by name.
 * Run: node --import tsx/esm --test src/features/trips/planning/__tests__/tripPlanPrivacy.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

type Mod = typeof import('../tripPlanPrivacy.ts');
let mod: Mod;

type Call = { url: string; method: string; body: unknown; auth: string | null };
let calls: Call[] = [];
let respond: (url: string, method: string) => Response = () => new Response('{}', { status: 200 });

const realFetch = globalThis.fetch;
const env = { ...process.env };
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..', '..');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('plan privacy scope on the client (TR116)', () => {
  before(async () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get('Authorization') });
      return respond(url, method);
    }) as typeof fetch;
    mod = await import('../tripPlanPrivacy.ts');
    const { _setTestToken } = await import('../../shared/auth.ts');
    _setTestToken(async () => 'tok');
  });
  after(async () => {
    globalThis.fetch = realFetch;
    process.env = env;
    const { _setTestToken } = await import('../../shared/auth.ts');
    _setTestToken(null);
  });
  beforeEach(() => { calls = []; });

  it('the six scopes are the server\'s, character for character', () => {
    const server = readFileSync(join(REPO, 'artifacts', 'api-server', 'src', 'domain', 'trips', 'policies', 'tripPlanPrivacy.ts'), 'utf8');
    const block = server.slice(server.indexOf('export const TRIP_PLAN_PRIVACY_SCOPES'), server.indexOf('] as const;'));
    assert.deepEqual([...mod.TRIP_PLAN_PRIVACY_SCOPES], [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    for (const s of mod.OFFERED_PRIVACY_SCOPES) assert.ok((mod.TRIP_PLAN_PRIVACY_SCOPES as readonly string[]).includes(s));
    assert.ok(!(mod.OFFERED_PRIVACY_SCOPES as readonly string[]).includes('selected_participants'), 'the server refuses it until 3727');
  });

  it('a scope is read as served; null, absent and unknown values are NOT READ, never a default', () => {
    assert.equal(mod.readPrivacyScope({ privacyScope: 'private' }), 'private');
    assert.equal(mod.readPrivacyScope({ privacyScope: 'friends_nearby' }), 'friends_nearby');
    assert.equal(mod.readPrivacyScope({ privacyScope: null }), null);
    assert.equal(mod.readPrivacyScope({ visibility: 'members' }), null, 'visibility is never turned into a scope');
    assert.equal(mod.readPrivacyScope({ privacyScope: 'CREW' }), null);
    assert.equal(mod.readPrivacyScope(undefined), null);
  });

  it('the viewer\'s own plans are read from GET /trips/:id/plan with their scope; others\' are not listed', async () => {
    respond = () => json(200, { canEdit: true, items: [
      { id: 'p1', creatorId: 'me', title: 'Dinner', privacyScope: 'crew', visibility: 'members' },
      { id: 'p2', creatorId: 'someone', title: 'Their hike', privacyScope: 'crew' },
      { id: 'p3', creatorId: 'me', title: 'Spa', privacyScope: null },
    ] });
    const r = await mod.readOwnPlanScopes('trip-1', 'me');
    assert.deepEqual(r, { state: 'ok', data: [
      { id: 'p1', title: 'Dinner', scope: 'crew' },
      { id: 'p3', title: 'Spa', scope: null },
    ] });
    assert.equal(calls[0]!.url, 'https://api.test/api/trips/trip-1/plan');
    assert.equal(calls[0]!.auth, 'Bearer tok');
  });

  it('a plan read that failed, or came back without its list, is unavailable — never an empty plan', async () => {
    respond = () => json(500, { error: 'db_error', message: 'boom' });
    assert.equal((await mod.readOwnPlanScopes('trip-1', 'me')).state, 'unavailable');
    respond = () => json(200, { canEdit: true });
    assert.deepEqual(await mod.readOwnPlanScopes('trip-1', 'me'), { state: 'unavailable', detail: 'unreadable response' });
  });

  it('setting a scope is PATCH /trips/:id/plan/items/:itemId { privacyScope }, and "saved" carries the SERVER\'s answer', async () => {
    respond = () => json(200, { id: 'p1', privacyScope: 'private', visibility: 'members' });
    assert.deepEqual(await mod.setPlanItemPrivacyScope('trip-1', 'p1', 'private'), { state: 'saved', scope: 'private' });
    assert.deepEqual(calls, [{ url: 'https://api.test/api/trips/trip-1/plan/items/p1', method: 'PATCH', body: { privacyScope: 'private' }, auth: 'Bearer tok' }]);
    respond = () => json(200, { id: 'p1', privacyScope: 'crew' });
    assert.deepEqual(await mod.setPlanItemPrivacyScope('trip-1', 'p1', 'public'), { state: 'saved', scope: 'crew' }, 'the tap is not what is drawn; the answer is');
  });

  it('a refusal arrives by name with the server\'s message; a 503 is unavailable; an unknown scope is never sent', async () => {
    respond = () => json(422, { error: 'privacy_scope_not_supported', reason: 'TRIP_PRIVACY_SCOPE_NOT_ENFORCED', message: 'Sharing a plan with selected people is not available yet.' });
    assert.deepEqual(await mod.setPlanItemPrivacyScope('trip-1', 'p1', 'selected_participants'), {
      state: 'refused', status: 422, reason: 'TRIP_PRIVACY_SCOPE_NOT_ENFORCED', detail: 'Sharing a plan with selected people is not available yet.',
    });
    // tripPlanPrivacy.ts planScopeChangeRefusal's body, as decidePlanPatchScope sends it.
    respond = () => json(403, { error: 'forbidden', reason: 'TRIP_PLAN_SCOPE_WIDENING_REFUSED', message: 'Only the person who added this plan can make it visible to more people. You can make it more private.' });
    assert.deepEqual(await mod.setPlanItemPrivacyScope('trip-1', 'p1', 'public'), {
      state: 'refused', status: 403, reason: 'TRIP_PLAN_SCOPE_WIDENING_REFUSED', detail: 'Only the person who added this plan can make it visible to more people. You can make it more private.',
    });
    respond = () => json(503, { error: 'degraded_unavailable', message: '2770_trip_plans_spec_columns.sql is not applied' });
    assert.deepEqual(await mod.setPlanItemPrivacyScope('trip-1', 'p1', 'private'), { state: 'unavailable', detail: '2770_trip_plans_spec_columns.sql is not applied' });
    calls = [];
    assert.equal((await mod.setPlanItemPrivacyScope('trip-1', 'p1', 'everyone')).state, 'refused');
    assert.deepEqual(calls, [], 'an unknown scope reached the server');
  });
});
