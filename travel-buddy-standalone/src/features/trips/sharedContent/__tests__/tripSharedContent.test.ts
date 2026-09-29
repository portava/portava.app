/**
 * TRIP-F24 on the client — documents, notes, checklists, trip reminders and the
 * activity feed, each read with its three states and written through its route.
 * Run: node --import tsx/esm --test src/features/trips/sharedContent/__tests__/tripSharedContent.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripSharedContent.ts');
let mod: Mod;
let calls: { url: string; init?: RequestInit }[] = [];
let respond: (url: string, init?: RequestInit) => Response = () => new Response('{}', { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return Promise.resolve(respond(String(url), init)); }) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const sent = (i: number) => JSON.parse(String(calls[i]!.init?.body));

let scheduled: { at: string; title: string }[] = [];
let cancelled: string[] = [];
const store = new Map<string, string>();

describe('trip shared contents', () => {
  before(async () => {
    mod = await import('../tripSharedContent.ts');
    const { _setTestToken } = await import('../../shared/auth.ts');
    _setTestToken(async () => 'tok');
    mod._setTestAlerts({
      scheduleAt: async (d, c) => { scheduled.push({ at: d.toISOString(), title: c.title }); return `n-${scheduled.length}`; },
      cancel: async (id) => { if (id) cancelled.push(id); },
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => { store.set(k, v); },
    });
  });
  beforeEach(() => { calls = []; scheduled = []; cancelled = []; });

  it('notes: listed with their privacy, and a new note is POSTed as { title, content, isPrivate }', async () => {
    respond = () => json({ notes: [{ id: 'n1', title: null, content: 'Bring adapters', is_private: false, author_id: 'u1', created_at: '2026-09-01T00:00:00Z', updated_at: null }] });
    const r = await mod.fetchNotes('t1');
    assert.equal(r.state, 'ok');
    if (r.state === 'ok') assert.equal(r.data[0]!.content, 'Bring adapters');
    respond = () => json({ id: 'n2', title: 'Hotel', content: 'Late check-in', is_private: true, author_id: 'u1', created_at: 'x' }, 201);
    const c = await mod.createNote('t1', { title: 'Hotel', content: 'Late check-in', isPrivate: true });
    assert.equal(c.state, 'done');
    assert.equal(calls[1]!.url, 'http://api.test/api/trips/t1/notes');
    assert.deepEqual(sent(1), { title: 'Hotel', content: 'Late check-in', isPrivate: true });
  });

  it('a list read that fails is unavailable, and a body without its list is not an empty list', async () => {
    respond = () => json({ error: 'not_member', message: 'Not a trip member' }, 403);
    const r = await mod.fetchDocuments('t1');
    assert.equal(r.state, 'unavailable');
    respond = () => json({ something: [] });
    assert.equal((await mod.fetchChecklists('t1')).state, 'unavailable');
  });

  it('documents: the list is lean and the body is read by id', async () => {
    respond = (url) => url.endsWith('/documents')
      ? json({ documents: [{ id: 'd1', title: 'Flight', document_type: 'itinerary', is_private: false, creator_id: 'u1', created_at: 'x', updated_at: null }] })
      : json({ id: 'd1', title: 'Flight', content: 'TP 123 at 09:40', document_type: 'itinerary', is_private: false, creator_id: 'u1', created_at: 'x', updated_at: null });
    const list = await mod.fetchDocuments('t1');
    assert.equal(list.state, 'ok');
    const one = await mod.fetchDocument('t1', 'd1');
    assert.equal(one.state, 'ok');
    if (one.state === 'ok') assert.equal(one.data.content, 'TP 123 at 09:40');
    respond = () => json({ id: 'd2' }, 201);
    await mod.createDocument('t1', { title: 'Visa', content: 'e-visa ref 42', documentType: 'visa', isPrivate: true });
    assert.deepEqual(sent(2), { title: 'Visa', content: 'e-visa ref 42', documentType: 'visa', isPrivate: true });
  });

  it('checklists: create a list, add an item, tick it — each on its own route', async () => {
    respond = () => json({ checklists: [{ id: 'c1', title: 'Packing', createdBy: 'u1', createdAt: 'x', items: [{ id: 'i1', checklist_id: 'c1', label: 'Passport', is_done: false, assigned_to: null, due_date: null, sort_order: 0 }] }] });
    const r = await mod.fetchChecklists('t1');
    assert.equal(r.state, 'ok');
    if (r.state === 'ok') assert.equal(mod.checklistProgress(r.data[0]!), '0 of 1 done');
    respond = () => json({ id: 'c2', title: 'Food', items: [] }, 201);
    await mod.createChecklist('t1', 'Food');
    respond = () => json({ id: 'i2' }, 201);
    await mod.addChecklistItem('t1', 'c1', 'Charger', 1);
    respond = () => json({ id: 'i1', is_done: true });
    await mod.setChecklistItemDone('t1', 'c1', 'i1', true);
    assert.deepEqual(calls.slice(1).map((c) => [c.init?.method, c.url.replace('http://api.test', ''), sent(calls.indexOf(c))]), [
      ['POST', '/api/trips/t1/checklists', { title: 'Food' }],
      ['POST', '/api/trips/t1/checklists/c1/items', { label: 'Charger', sortOrder: 1 }],
      ['PATCH', '/api/trips/t1/checklists/c1/items/i1', { isDone: true }],
    ]);
  });

  it('trip reminders: kept on the account, and the device that sets one schedules its alert and cancels it on delete', async () => {
    respond = () => json({ id: 'r1', title: 'Check in online', remind_at: '2030-01-01T08:00:00.000Z', is_sent: false, created_at: 'x' }, 201);
    const c = await mod.createTripReminder('t1', 'Check in online', '2030-01-01T08:00:00.000Z');
    assert.equal(c.state, 'done');
    assert.deepEqual(sent(0), { title: 'Check in online', remindAt: '2030-01-01T08:00:00.000Z' });
    assert.deepEqual(scheduled, [{ at: '2030-01-01T08:00:00.000Z', title: 'Check in online' }]);
    respond = () => new Response(null, { status: 204 });
    const d = await mod.deleteTripReminder('t1', 'r1');
    assert.equal(d.state, 'done');
    assert.deepEqual(cancelled, ['n-1']);
    // Deleting one set on another device has no local alert to cancel, and is still done.
    const e = await mod.deleteTripReminder('t1', 'r-other');
    assert.equal(e.state, 'done');
    assert.deepEqual(cancelled, ['n-1']);
  });

  it('a reminder the server refused schedules nothing', async () => {
    respond = () => json({ error: 'invalid_payload', message: 'remindAt required' }, 400);
    const c = await mod.createTripReminder('t1', 'x', 'nope');
    assert.equal(c.state, 'refused');
    assert.deepEqual(scheduled, []);
  });

  it('activity: host-only; a 403 is a named refusal the card can say, not an empty feed', async () => {
    respond = () => json({ activity: [{ id: 'a1', actor_id: 'u1', event_type: 'join_request_approved', metadata: {}, created_at: '2026-09-02T00:00:00Z' }] });
    const r = await mod.fetchActivity('t1');
    assert.equal(r.state, 'ok');
    if (r.state === 'ok') assert.equal(mod.activityText(r.data[0]!), 'A join request was approved');
    assert.equal(mod.activityText({ id: 'a2', actor_id: null, event_type: 'something_new', metadata: {}, created_at: 'x' }), 'something new');
    respond = () => json({ error: 'forbidden', message: 'Only the owner or co-host can view the activity log', reason: 'TRIP_AUTH_NOT_HOST' }, 403);
    const f = await mod.fetchActivity('t1');
    assert.equal(f.state, 'unavailable');
    if (f.state === 'unavailable') assert.equal(f.status, 403);
  });
});
