/**
 * TRIP-F22 on the client — memory candidates and the passport preview.
 * Run: node --import tsx/esm --test src/features/trips/closeout/__tests__/tripPostTrip.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripPostTrip.ts');
let mod: Mod;
let calls: string[] = [];
let respond: (url: string) => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string) => { calls.push(String(url)); return Promise.resolve(respond(String(url))); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const memory = {
  projectionSchemaVersion: 1, generatedAt: 'x', sourceTripVersion: 4, freshness: 'live',
  projectionId: 'TripMemoryProjection', tripId: 't1', viewerId: 'u1',
  candidates: [
    { id: 'plan:p1', kind: 'place_visited', title: 'Hoi An old town', occurredAt: '2026-09-02T10:00:00Z', evidence: { source: 'outcome', ids: ['o1'] }, memoryDraft: { tripId: 't1', title: 'Hoi An old town', placeId: null, startsAt: '2026-09-02T10:00:00Z', endsAt: null, locationCity: 'Hoi An', locationCountry: 'Vietnam' }, realized: null },
    { id: 'people', kind: 'people', title: 'Who you travelled with', occurredAt: null, evidence: { source: 'crew', ids: ['u2'] }, memoryDraft: null, realized: null, peopleUserIds: ['u2'] },
    { id: 'plan:p2', kind: 'activity_completed', title: 'Cooking class', occurredAt: null, evidence: { source: 'plan_status', ids: ['p2'] }, memoryDraft: null, realized: { memoryId: 'm1', mediaCount: 3 } },
  ],
  realizedCount: 1, media: { memories: 1, items: 3 }, unrecordedDonePlanIds: [], unread: ['trip_outcomes'], reading: 'r',
};

describe('post-trip projections', () => {
  before(async () => { mod = await import('../tripPostTrip.ts'); const { _setTestToken } = await import('../../shared/auth.ts'); _setTestToken(async () => 'tok'); });
  beforeEach(() => { calls = []; });

  it('reads the memory candidates and says which are kept, which can be kept, and what was not read', async () => {
    respond = () => json(memory);
    const r = await mod.fetchMemoryCandidates('t1');
    assert.equal(calls[0], 'http://api.test/api/trips/t1/memory-candidates');
    assert.equal(r.state, 'ok');
    if (r.state !== 'ok') return;
    assert.deepEqual(r.data.candidates.map((c) => mod.candidateStatus(c)), ['keepable', 'tag', 'kept']);
    assert.equal(mod.unreadLine(r.data.unread), '1 input could not be read, so some candidates may be missing');
    assert.equal(mod.unreadLine([]), null);
  });

  it('turns a draft into the createMemory input without changing what the projection said', () => {
    const c = memory.candidates[0]!;
    assert.deepEqual(mod.draftToMemoryInput(c as any), {
      title: 'Hoi An old town', tripId: 't1', placeId: null, startsAt: '2026-09-02T10:00:00Z', endsAt: null,
      locationCity: 'Hoi An', locationCountry: 'Vietnam', visibility: 'friends_only', state: 'draft', operationId: 'trip-memory:t1:plan:p1',
    });
    assert.equal(mod.draftToMemoryInput(memory.candidates[1] as any), null);
  });

  it('reads the passport preview; a null stamp list is "not read", never "no stamps"', async () => {
    respond = () => json({ projectionId: 'TripPassportProjection', tripId: 't1', viewerId: 'u1', completed: true, countries: ['Vietnam'], cities: ['Hoi An', 'Hue'], stamps: null, unread: ['user_stamps'], reading: 'r' });
    const r = await mod.fetchPassportPreview('t1');
    assert.equal(calls[0], 'http://api.test/api/trips/t1/passport-projection');
    assert.equal(r.state, 'ok');
    if (r.state === 'ok') assert.equal(mod.passportLine(r.data), 'Adds 1 country and 2 cities · stamps could not be read');
    assert.equal(mod.passportLine({ completed: false, countries: [], cities: [], stamps: [] } as any), 'Nothing is added to your Passport until the trip is completed');
    assert.equal(mod.passportLine({ completed: true, countries: ['PT'], cities: ['Lisboa'], stamps: [{ id: 's', slug: null, name: 'Lisbon', earnedAt: null }] } as any), 'Adds 1 country and 1 city · 1 stamp');
  });

  it('a failed read is unavailable, and a body without candidates is not "no candidates"', async () => {
    respond = () => json({ error: 'not_member', reason: 'TRIP_AUTH_NOT_CREW', message: 'You must be an accepted trip member' }, 403);
    assert.equal((await mod.fetchMemoryCandidates('t1')).state, 'unavailable');
    respond = () => json({ projectionId: 'TripMemoryProjection' });
    assert.equal((await mod.fetchMemoryCandidates('t1')).state, 'unavailable');
  });
});
