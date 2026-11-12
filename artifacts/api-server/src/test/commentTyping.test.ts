import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { _setTestClient } from '../lib/http.js';
import { CommentTypingStore, signCommentTyping, verifyCommentTyping, publishCommentTyping, commentTypingStore } from '../lib/commentTyping.js';
let POST = '11111111-1111-4111-8111-111111111111';
let requestNumber = 0;
const AUTHOR = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const TRIP = '55555555-5555-4555-8555-555555555555';
describe('ephemeral comment typing', () => {
  it('expires indicators, rejects reordered starts and bounds retained hints', () => {
    let now = 10000;
    const store = new CommentTypingStore(() => now, 1);
    store.accept({ postId: POST, userId: AUTHOR, typing: true, at: now });
    assert.deepEqual(store.actors(POST), [AUTHOR]);
    store.accept({ postId: POST, userId: AUTHOR, typing: false, at: now + 1 });
    assert.equal(store.accept({ postId: POST, userId: AUTHOR, typing: true, at: now }), false);
    assert.deepEqual(store.actors(POST), []);
    store.accept({ postId: POST, userId: OTHER, typing: true, at: now });
    now += 8000;
    assert.deepEqual(store.actors(POST), []);
  });
  it('authenticates every broadcast field and rejects malformed signatures', () => {
    const row = { postId: POST, userId: AUTHOR, typing: true, at: 10000 };
    const signature = signCommentTyping(row, 'test-secret');
    assert.equal(verifyCommentTyping(row, signature, 'test-secret'), true);
    for (const mutated of [{ ...row, postId: OTHER }, { ...row, userId: OTHER }, { ...row, typing: false }, { ...row, at: 10001 }]) assert.equal(verifyCommentTyping(mutated, signature, 'test-secret'), false);
    assert.equal(verifyCommentTyping(row, 'bad', 'test-secret'), false);
    assert.equal(verifyCommentTyping(row, signature, 'other-secret'), false);
  });
});

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { message: string } | null; count: number | null };
function fakeClient(options: { visibility?: string; blocked?: boolean; restricted?: boolean; online?: boolean; noPrivacyRow?: boolean; commentsSetting?: string; eligible?: boolean; beforeRead?: (table: string) => Promise<void>; failTable?: string } = {}) {
  const db: Record<string, Row[]> = {
    posts: [{ id: POST, author_id: AUTHOR, visibility: options.visibility ?? 'public', trip_id: options.commentsSetting === 'trip_crew' ? TRIP : null, status: 'active', post_status: 'published', deleted_at: null, comments_setting: options.commentsSetting ?? 'everyone' }],
    profiles: [AUTHOR, VIEWER, OTHER].map(id => ({ id, verified: options.eligible === true, is_private: false, account_status: 'active', user_account_states: [] })),
    user_privacy_settings: options.noPrivacyRow ? [] : [AUTHOR, VIEWER, OTHER].map(id => ({ user_id: id, show_online_status: options.online !== false })),
    friend_requests: options.eligible ? [{ id: 'friend', requester_id: OTHER, recipient_id: AUTHOR, status: 'accepted' }] : [],
    circle_memberships: options.eligible ? [{ user_id: AUTHOR, other_id: OTHER }] : [],
    trip_members: options.eligible ? [{ trip_id: TRIP, user_id: OTHER, role: 'member', status: 'accepted' }] : [],
    blocks: options.blocked ? [{ blocker_id: OTHER, blocked_id: VIEWER }] : [],
    user_restrictions: options.restricted ? [{ restrictor_id: OTHER, restricted_id: VIEWER }] : [],
  };
  function from(table: string) {
    let rows = [...(db[table] ?? [])];
    const result = (): Result => options.failTable === table ? { data: null, error: { message: 'private diagnostic' }, count: null } : { data: rows, error: null, count: rows.length };
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { rows = rows.filter(row => row[key] === value); return builder; },
      in: (key: string, values: readonly unknown[]) => { rows = rows.filter(row => values.includes(row[key])); return builder; },
      is: (key: string, value: unknown) => { rows = rows.filter(row => row[key] == value); return builder; },
      or: (expression: string) => { const ids = expression.match(/[a-f0-9]{8}-[a-f0-9-]{27}/g) ?? []; const [left, right] = table === 'friend_requests' ? ['requester_id', 'recipient_id'] : ['blocker_id', 'blocked_id']; rows = rows.filter(row => row[left] === ids[0] && row[right] === ids[1] || row[left] === ids[2] && row[right] === ids[3]); return builder; },
      order: () => builder, limit: () => builder,
      maybeSingle: async () => { await options.beforeRead?.(table); return { ...result(), data: result().data?.[0] ?? null }; },
      single: async () => ({ ...result(), data: result().data?.[0] ?? null }),
      then: <T,>(resolve: (value: Result) => T) => Promise.resolve(result()).then(resolve),
    };
    return builder;
  }
  return { from, auth: { getUser: async (token: string) => ({ data: { user: token === 'viewer' ? { id: VIEWER } : token === 'other' ? { id: OTHER } : null }, error: null }) } };
}
afterEach(() => { _setTestClient(null, false); publishCommentTyping(POST, OTHER, false); });
async function request(options: Parameters<typeof fakeClient>[0], run: (url: string) => Promise<void>) {
  POST = `11111111-1111-4111-8111-${String(++requestNumber).padStart(12, '0')}`;
  _setTestClient(fakeClient(options) as never, true);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/api/posts/${POST}/comments/typing`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function json(response: Response): Promise<Record<string, unknown>> { const body: unknown = await response.json(); assert.ok(body && typeof body === 'object'); return body as Record<string, unknown>; }
describe('comment typing HTTP audience', () => {
  it('accepts authenticated typing, exposes only count to another reader and excludes self', async () => request({}, async url => {
    const sent = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer other', 'Content-Type': 'application/json' }, body: JSON.stringify({ typing: true, userId: AUTHOR, draft: 'never sent by app' }) });
    assert.equal(sent.status, 200);
    const read = await fetch(url, { headers: { Authorization: 'Bearer viewer' } });
    assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await json(read), { ok: true, typingCount: 1 });
    assert.deepEqual(await json(await fetch(url, { headers: { Authorization: 'Bearer other' } })), { ok: true, typingCount: 0 });
  }));
  it('requires a boolean and authentication before announcing anything', async () => request({}, async url => {
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ typing: 'true' }) };
    assert.equal((await fetch(url, options)).status, 401);
    assert.equal((await fetch(url, { ...options, headers: { ...options.headers, Authorization: 'Bearer other' } })).status, 400);
    assert.deepEqual(commentTypingStore.actors(POST), []);
  }));
  it('does not retain typing from an account that turned off online presence', async () => request({ online: false }, async url => {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer other', 'Content-Type': 'application/json' }, body: JSON.stringify({ typing: true }) });
    assert.equal(response.status, 200);
    assert.deepEqual(commentTypingStore.actors(POST), []);
  }));
  it('uses the existing schema default when no privacy settings row exists', async () => request({ noPrivacyRow: true }, async url => {
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer other', 'Content-Type': 'application/json' }, body: JSON.stringify({ typing: true }) })).status, 200);
    assert.deepEqual(commentTypingStore.actors(POST), [OTHER]);
    assert.deepEqual(await json(await fetch(url, { headers: { Authorization: 'Bearer viewer' } })), { ok: true, typingCount: 1 });
  }));
  for (const options of [{ blocked: true }, { restricted: true }, { online: false }]) it(`withholds current privacy exclusion ${JSON.stringify(options)}`, async () => request(options, async url => {
    publishCommentTyping(POST, OTHER, true);
    const response = await fetch(url, { headers: { Authorization: 'Bearer viewer' } });
    assert.equal(response.status, 200); assert.equal((await json(response)).typingCount, 0);
  }));
  it('fails closed when privacy cannot be read and never returns the database message', async () => request({ failTable: 'user_privacy_settings' }, async url => {
    publishCommentTyping(POST, OTHER, true);
    const response = await fetch(url, { headers: { Authorization: 'Bearer viewer' } });
    assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(await json(response)), /private diagnostic/);
  }));
  for (const commentsSetting of ['friends', 'circle', 'trip_crew', 'verified', 'disabled']) it(`withholds typing from a reader outside ${commentsSetting} commenters`, async () => request({ commentsSetting }, async url => {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer other', 'Content-Type': 'application/json' }, body: JSON.stringify({ typing: true }) });
    assert.equal(response.status, 403);
    assert.deepEqual(commentTypingStore.actors(POST), []);
    publishCommentTyping(POST, OTHER, true, Date.now() + 1);
    assert.deepEqual(await json(await fetch(url, { headers: { Authorization: 'Bearer viewer' } })), { ok: true, typingCount: 0 });
  }));
  for (const commentsSetting of ['friends', 'circle', 'trip_crew', 'verified']) it(`accepts an eligible ${commentsSetting} commenter`, async () => request({ commentsSetting, eligible: true }, async url => {
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer other', 'Content-Type': 'application/json' }, body: JSON.stringify({ typing: true }) })).status, 200);
    assert.deepEqual(await json(await fetch(url, { headers: { Authorization: 'Bearer viewer' } })), { ok: true, typingCount: 1 });
  }));
  it('does not revive a start whose authorization finishes after a newer stop', async () => {
    let release!: () => void; let began!: () => void; let privacyReads = 0;
    const waiting = new Promise<void>(resolve => { began = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    await request({ beforeRead: async table => { if (table === 'user_privacy_settings' && ++privacyReads === 1) { began(); await hold; } } }, async url => {
      const send = (typing: boolean) => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer other', 'Content-Type': 'application/json' }, body: JSON.stringify({ typing }) });
      const start = send(true); await waiting;
      try { assert.equal((await send(false)).status, 200); } finally { release(); }
      assert.equal((await start).status, 200);
      assert.deepEqual(await json(await fetch(url, { headers: { Authorization: 'Bearer viewer' } })), { ok: true, typingCount: 0 });
    });
  });
  it('refuses private post audiences and anonymous readers', async () => request({ visibility: 'private' }, async url => {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer viewer' } })).status, 404);
  }));
});
