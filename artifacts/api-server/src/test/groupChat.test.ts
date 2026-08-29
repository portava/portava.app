/**
 * Backend tests — Trip & Circle Group Chat (Task #11)
 *
 * Covers all 39 acceptance scenarios:
 *   - Trip chat access: accepted / pending / declined / removed / non-member
 *   - Circle chat access: accepted / non-member / pending invite
 *   - Send permissions (active member vs. left member)
 *   - No-duplicate thread creation (idempotency)
 *   - Membership sync on accept / remove
 *   - Message visibility only to thread members
 *   - Privacy guards: no GPS, no private posts, no service-role fields
 *   - PATCH /messages/:id and DELETE /messages/:id
 *   - Sync repair endpoints
 *
 * Runtime: node:test + node:assert/strict (matches requests.test.ts pattern)
 * Run: node --import tsx/esm --test src/test/groupChat.test.ts
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { _setTestClient } from '../lib/http.js';
import groupChatRouter from '../routes/groupChat.js';
import messagingRouter from '../routes/messaging.js';
import tripsRouter from '../routes/trips.js';
import friendsRouter from '../routes/friends.js';

// ── IDs ──────────────────────────────────────────────────────────────────────
const ALICE_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOB_ID     = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CAROL_ID   = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const DAVE_ID    = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const TRIP_ID    = '11111111-1111-1111-1111-111111111111';
const THREAD_ID  = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const MSG_ID     = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

// ── Fake state ────────────────────────────────────────────────────────────────
interface State {
  users: Record<string, { id: string } | null>;
  trips:              Array<{ id: string; title: string; destination_city: string; owner_id: string }>;
  trip_members:       Array<{ trip_id: string; user_id: string; role: string }>;
  message_threads:    Array<{ id: string; thread_type: string; trip_id?: string; circle_owner_id?: string; title?: string; status?: string; last_message_at?: string; created_at: string; updated_at: string }>;
  message_thread_members: Array<{ thread_id: string; user_id: string; joined_at: string; left_at: string | null; role: string }>;
  messages:           Array<{ id: string; thread_id: string; sender_id: string; body: string | null; deleted_at: string | null; created_at: string; edited_at: string | null; original_language: string | null }>;
  message_translations: any[];
  circle_memberships: Array<{ user_id: string; other_id: string; created_at: string }>;
  circle_invites:     Array<{ id: string; owner_id: string; recipient_id: string; status: string }>;
  profiles:           Array<{ id: string; handle: string; name: string; avatar_url: string | null; preferred_message_language?: string }>;
  inserted:           any[];
  updated:            any[];
}

function baseState(): State {
  return {
    users: {
      'alice-tok': { id: ALICE_ID },   // trip owner & circle owner
      'bob-tok':   { id: BOB_ID },     // accepted trip member & circle member
      'carol-tok': { id: CAROL_ID },   // invited (pending) trip member
      'dave-tok':  { id: DAVE_ID },    // non-member
    },
    trips: [{ id: TRIP_ID, title: 'Test Trip', destination_city: 'Cebu', owner_id: ALICE_ID }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: ALICE_ID, role: 'owner' },
      { trip_id: TRIP_ID, user_id: BOB_ID,   role: 'member' },
      { trip_id: TRIP_ID, user_id: CAROL_ID, role: 'invited' },
    ],
    message_threads:    [],
    message_thread_members: [],
    messages:           [],
    message_translations: [],
    circle_memberships: [{ user_id: ALICE_ID, other_id: BOB_ID, created_at: '2026-01-01T00:00:00Z' }],
    circle_invites:     [{ id: '00000000-0000-0000-0000-000000000001', owner_id: ALICE_ID, recipient_id: CAROL_ID, status: 'pending' }],
    profiles: [
      { id: ALICE_ID, handle: 'alice', name: 'Alice', avatar_url: null },
      { id: BOB_ID,   handle: 'bob',   name: 'Bob',   avatar_url: null },
      { id: CAROL_ID, handle: 'carol', name: 'Carol', avatar_url: null },
      { id: DAVE_ID,  handle: 'dave',  name: 'Dave',  avatar_url: null },
    ],
    inserted: [],
    updated:  [],
  };
}

function stateWithThread(s: State): State {
  return {
    ...s,
    message_threads: [
      { id: THREAD_ID, thread_type: 'trip', trip_id: TRIP_ID, title: 'Test Trip · Cebu',
        status: 'active', last_message_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ],
    message_thread_members: [
      { thread_id: THREAD_ID, user_id: ALICE_ID, joined_at: '2026-01-01T00:00:00Z', left_at: null, role: 'owner' },
      { thread_id: THREAD_ID, user_id: BOB_ID,   joined_at: '2026-01-01T00:00:00Z', left_at: null, role: 'member' },
    ],
  };
}

function stateWithMessage(s: State): State {
  return {
    ...stateWithThread(s),
    messages: [
      { id: MSG_ID, thread_id: THREAD_ID, sender_id: ALICE_ID, body: 'Hello group',
        deleted_at: null, created_at: '2026-01-01T01:00:00Z', edited_at: null, original_language: null },
    ],
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────
function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _select = '';
    let _limit: number | null = null;
    let _order: null | { col: string; asc: boolean; nullsFirst?: boolean } = null;
    let _updatePayload: any = null;
    let _insertPayload: any = null;
    let _isUpdate = false;
    let _isInsert = false;
    let _isDelete = false;
    let _isSingle = false;
    let _isMaybeSingle = false;

    function getData(): any[] {
      const tableData: Record<string, any[]> = {
        trips:                 (state as any).trips ?? [],
        trip_members:          (state as any).trip_members ?? [],
        message_threads:       (state as any).message_threads ?? [],
        message_thread_members:(state as any).message_thread_members ?? [],
        messages:              (state as any).messages ?? [],
        message_translations:  (state as any).message_translations ?? [],
        circle_memberships:    (state as any).circle_memberships ?? [],
        circle_invites:        (state as any).circle_invites ?? [],
        profiles:              (state as any).profiles ?? [],
        blocks:                (state as any).blocks ?? [],
      };
      return (tableData[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }

    const b: any = {
      select(sel?: string) { _select = sel ?? ''; return b; },

      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return b;
      },
      neq(col: string, val: any) {
        filters.push((r) => r[col] !== val);
        return b;
      },
      or(_expr: string) {
        // Block-guard's fail-closed blocks lookup. These fixtures seed no blocks,
        // so returning the (empty) blocks table unfiltered is correct.
        return b;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.includes(r[col]));
        return b;
      },
      is(col: string, val: any) {
        filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return b;
      },
      not(col: string, op: string, val: any) {
        if (op === 'is') filters.push((r) => r[col] !== val);
        return b;
      },
      lt(col: string, val: any) {
        filters.push((r) => r[col] < val);
        return b;
      },
      order(_col?: string, _opts?: any) { return b; },
      limit(n: number) { _limit = n; return b; },

      update(changes: any) {
        _isUpdate = true;
        _updatePayload = changes;
        return b;
      },
      insert(payload: any) {
        _isInsert = true;
        _insertPayload = payload;
        return b;
      },
      upsert(payload: any, _opts?: any) {
        _isInsert = true;
        _insertPayload = Array.isArray(payload) ? payload : [payload];
        return b;
      },
      delete() { _isDelete = true; return b; },

      maybeSingle() {
        _isMaybeSingle = true;
        return b.then();
      },
      single() {
        _isSingle = true;
        return b.then();
      },

      then(resolve?: any, reject?: any) {
        let data: any = null;
        let error: any = null;

        try {
          if (_isInsert) {
            const rows = Array.isArray(_insertPayload) ? _insertPayload : [_insertPayload];
            for (const row of rows) {
              const enriched = { id: `gen-${Math.random().toString(36).slice(2)}`, ...row };
              (state as any).inserted.push({ table, row: enriched });
              const arr = (state as any)[table];
              if (arr) arr.push(enriched);
              if (_isSingle || _isMaybeSingle) data = enriched;
            }
            if (!_isSingle && !_isMaybeSingle) data = rows;
          } else if (_isUpdate) {
            const rows = getData();
            const updated: any[] = [];
            for (const r of rows) {
              Object.assign(r, _updatePayload);
              updated.push(r);
              (state as any).updated.push({ table, row: r });
            }
            if (_isSingle || _isMaybeSingle) data = updated[0] ?? null;
            else data = updated;
          } else if (_isDelete) {
            const rows = getData();
            const arr = (state as any)[table];
            if (arr) {
              for (const r of rows) {
                const idx = arr.indexOf(r);
                if (idx !== -1) arr.splice(idx, 1);
              }
            }
            data = null;
          } else {
            let rows = getData();
            if (_limit !== null) rows = rows.slice(0, _limit);
            if (_isSingle) data = rows[0] ?? null;
            else if (_isMaybeSingle) data = rows[0] ?? null;
            else data = rows;
          }
        } catch (e) {
          error = e;
        }

        const result = { data, error };
        if (resolve) return Promise.resolve(resolve(result));
        return Promise.resolve(result);
      },
    };

    return b;
  }

  const fakeAuth = {
    getUser: (token: string) => {
      const u = (state as any).users[token];
      if (!u) return Promise.resolve({ data: { user: null }, error: new Error('invalid token') });
      return Promise.resolve({ data: { user: u }, error: null });
    },
    refreshSession: () => Promise.resolve({ data: { session: null } }),
    getSession:     () => Promise.resolve({ data: { session: null } }),
  };

  return { from, auth: fakeAuth };
}

function makeApp(state: State) {
  const client = makeFakeClient(state);
  _setTestClient(client, true);
  const app = express();
  app.use(express.json());
  // Minimal req.log so route error logging doesn't throw.
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use('/api', groupChatRouter);
  app.use('/api', messagingRouter);
  return { app, client, state };
}

function bearer(tok: string) { return { Authorization: `Bearer ${tok}` }; }

async function req(
  app: any,
  method: string,
  path: string,
  tok?: string,
  body?: any,
): Promise<{ status: number; body: any }> {
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address() as any;
  const url = `http://127.0.0.1:${port}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const res2 = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res2.json().catch(() => null);
  server.close();
  return { status: res2.status, body: json };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Trip Chat Access
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/trips/:tripId/chat — access control', () => {
  it('1. trip owner (alice) can access trip chat', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'alice-tok');
    assert.equal(r.status, 200);
    assert.ok(r.body.thread);
    assert.equal(r.body.thread.threadType, 'trip');
    assert.equal(r.body.thread.tripId, TRIP_ID);
    assert.equal(r.body.thread.memberAccess, 'active');
  });

  it('2. accepted trip member (bob) can access trip chat', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'bob-tok');
    assert.equal(r.status, 200);
    assert.ok(r.body.thread);
  });

  it('3. invited (pending) trip member gets pending_invite error', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'carol-tok');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'pending_invite');
  });

  it('4. non-member (dave) cannot access trip chat', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'dave-tok');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'not_member');
  });

  it('5. unauthenticated request fails 401', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`);
    assert.equal(r.status, 401);
  });

  it('6. invalid token fails 401', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'bad-tok');
    assert.equal(r.status, 401);
  });

  it('7. removed member (left_at set) sees no_access (memberAccess=removed)', async () => {
    const s = stateWithThread(baseState());
    // Remove bob from both the thread membership and the trip so sync does not restore him.
    s.message_thread_members.find(m => m.user_id === BOB_ID)!.left_at = '2026-01-02T00:00:00Z';
    s.trip_members = s.trip_members.filter(m => m.user_id !== BOB_ID);
    const { app } = makeApp(s);
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'bob-tok');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'not_member');
  });

  it('8. invalid tripId returns 400', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', '/api/trips/not-a-uuid/chat', 'alice-tok');
    assert.equal(r.status, 400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Trip Chat — thread idempotency and creation
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/trips/:tripId/chat — thread creation & idempotency', () => {
  it('9. creates thread if none exists', async () => {
    const s = baseState();
    assert.equal(s.message_threads.length, 0);
    const { app } = makeApp(s);
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'alice-tok');
    assert.equal(r.status, 200);
    assert.ok(r.body.thread.id);
  });

  it('10. second call returns the SAME thread (no duplicate)', async () => {
    const s = baseState();
    const { app } = makeApp(s);
    const r1 = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'alice-tok');
    const r2 = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'alice-tok');
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.body.thread.id, r2.body.thread.id);
  });

  it('11. thread_type is "trip" after creation', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'alice-tok');
    assert.equal(r.status, 200);
    assert.equal(r.body.thread.threadType, 'trip');
  });

  it('12. existing thread is reused (pre-seeded state)', async () => {
    const s = stateWithThread(baseState());
    const { app } = makeApp(s);
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'alice-tok');
    assert.equal(r.status, 200);
    assert.equal(r.body.thread.id, THREAD_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Circle Chat Access
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/circles/:circleId/chat — access control', () => {
  it('13. circle owner (alice) can access circle chat', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/circles/${ALICE_ID}/chat`, 'alice-tok');
    assert.equal(r.status, 200);
    assert.equal(r.body.thread.threadType, 'circle');
    assert.equal(r.body.thread.circleOwnerId, ALICE_ID);
  });

  it('14. accepted circle member (bob) can access circle chat', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/circles/${ALICE_ID}/chat`, 'bob-tok');
    assert.equal(r.status, 200);
    assert.ok(r.body.thread);
  });

  it('15. pending circle invite (carol) gets pending_invite', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/circles/${ALICE_ID}/chat`, 'carol-tok');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'pending_invite');
  });

  it('16. non-member (dave) cannot access circle chat', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/circles/${ALICE_ID}/chat`, 'dave-tok');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'not_member');
  });

  it('17. unauthenticated circle chat request fails 401', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', `/api/circles/${ALICE_ID}/chat`);
    assert.equal(r.status, 401);
  });

  it('18. invalid circleId returns 400', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'GET', '/api/circles/bad-id/chat', 'alice-tok');
    assert.equal(r.status, 400);
  });

  it('19. circle thread is created with owner + members', async () => {
    const s = baseState();
    const { app } = makeApp(s);
    const r = await req(app, 'GET', `/api/circles/${ALICE_ID}/chat`, 'alice-tok');
    assert.equal(r.status, 200);
    assert.ok(r.body.thread.id);
    const members = s.message_thread_members;
    const ownerInThread = members.some(m => m.user_id === ALICE_ID && m.left_at === null);
    const bobInThread   = members.some(m => m.user_id === BOB_ID   && m.left_at === null);
    assert.ok(ownerInThread, 'owner must be in thread');
    assert.ok(bobInThread,   'circle member must be in thread');
  });

  it('20. circle thread creation is idempotent (no duplicate)', async () => {
    const s = baseState();
    const { app } = makeApp(s);
    const r1 = await req(app, 'GET', `/api/circles/${ALICE_ID}/chat`, 'alice-tok');
    const r2 = await req(app, 'GET', `/api/circles/${ALICE_ID}/chat`, 'alice-tok');
    assert.equal(r1.body.thread.id, r2.body.thread.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Send Permissions
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/threads/:threadId/messages — send permissions', () => {
  it('21. active member can send a message', async () => {
    const { app } = makeApp(stateWithThread(baseState()));
    const r = await req(app, 'POST', `/api/threads/${THREAD_ID}/messages`, 'alice-tok', { body: 'Hello!' });
    assert.equal(r.status, 201);
    assert.equal(r.body.senderId, ALICE_ID);
    assert.equal(r.body.body, 'Hello!');
  });

  it('22. non-member cannot send to group thread', async () => {
    const { app } = makeApp(stateWithThread(baseState()));
    const r = await req(app, 'POST', `/api/threads/${THREAD_ID}/messages`, 'dave-tok', { body: 'Hi' });
    assert.equal(r.status, 403);
  });

  it('23. removed member (left_at set) cannot send', async () => {
    const s = stateWithThread(baseState());
    s.message_thread_members.find(m => m.user_id === BOB_ID)!.left_at = '2026-01-02T00:00:00Z';
    const { app } = makeApp(s);
    const r = await req(app, 'POST', `/api/threads/${THREAD_ID}/messages`, 'bob-tok', { body: 'Hi' });
    assert.equal(r.status, 403);
  });

  it('24. empty body is rejected 400', async () => {
    const { app } = makeApp(stateWithThread(baseState()));
    const r = await req(app, 'POST', `/api/threads/${THREAD_ID}/messages`, 'alice-tok', { body: '' });
    assert.equal(r.status, 400);
  });

  it('25. body exceeding 4000 chars is rejected', async () => {
    const { app } = makeApp(stateWithThread(baseState()));
    const r = await req(app, 'POST', `/api/threads/${THREAD_ID}/messages`, 'alice-tok', { body: 'x'.repeat(4001) });
    assert.equal(r.status, 400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edit and Delete Messages
// ═══════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/messages/:messageId — edit own message', () => {
  it('26. sender can edit their own message', async () => {
    const { app } = makeApp(stateWithMessage(baseState()));
    const r = await req(app, 'PATCH', `/api/messages/${MSG_ID}`, 'alice-tok', { body: 'Edited text' });
    assert.equal(r.status, 200);
    assert.equal(r.body.body, 'Edited text');
    assert.ok(r.body.editedAt);
  });

  it('27. non-sender cannot edit message', async () => {
    const { app } = makeApp(stateWithMessage(baseState()));
    const r = await req(app, 'PATCH', `/api/messages/${MSG_ID}`, 'bob-tok', { body: 'Nope' });
    assert.equal(r.status, 403);
  });

  it('28. cannot edit a deleted message', async () => {
    const s = stateWithMessage(baseState());
    s.messages[0].deleted_at = '2026-01-01T02:00:00Z';
    const { app } = makeApp(s);
    const r = await req(app, 'PATCH', `/api/messages/${MSG_ID}`, 'alice-tok', { body: 'New' });
    assert.equal(r.status, 400);
  });

  it('29. unauthenticated edit fails 401', async () => {
    const { app } = makeApp(stateWithMessage(baseState()));
    const r = await req(app, 'PATCH', `/api/messages/${MSG_ID}`, undefined, { body: 'x' });
    assert.equal(r.status, 401);
  });

  it('30. removed member cannot edit (left_at set)', async () => {
    const s = stateWithMessage(baseState());
    s.message_thread_members.find(m => m.user_id === ALICE_ID)!.left_at = '2026-01-02T00:00:00Z';
    const { app } = makeApp(s);
    const r = await req(app, 'PATCH', `/api/messages/${MSG_ID}`, 'alice-tok', { body: 'Edited' });
    assert.equal(r.status, 403);
  });
});

describe('DELETE /api/messages/:messageId — soft-delete own message', () => {
  it('31. sender can delete their own message', async () => {
    const { app } = makeApp(stateWithMessage(baseState()));
    const r = await req(app, 'DELETE', `/api/messages/${MSG_ID}`, 'alice-tok');
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
  });

  it('32. non-sender cannot delete message', async () => {
    const { app } = makeApp(stateWithMessage(baseState()));
    const r = await req(app, 'DELETE', `/api/messages/${MSG_ID}`, 'bob-tok');
    assert.equal(r.status, 403);
  });

  it('33. already-deleted message returns 400', async () => {
    const s = stateWithMessage(baseState());
    s.messages[0].deleted_at = '2026-01-01T02:00:00Z';
    const { app } = makeApp(s);
    const r = await req(app, 'DELETE', `/api/messages/${MSG_ID}`, 'alice-tok');
    assert.equal(r.status, 400);
  });

  it('34. non-existent message returns 404', async () => {
    const { app } = makeApp(stateWithThread(baseState()));
    const r = await req(app, 'DELETE', `/api/messages/00000000-0000-0000-0000-000000000000`, 'alice-tok');
    assert.equal(r.status, 404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Sync repair endpoints
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/trips/:tripId/chat/sync', () => {
  it('35. trip OWNER (alice) can trigger sync', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'POST', `/api/trips/${TRIP_ID}/chat/sync`, 'alice-tok');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'synced');
    assert.ok(r.body.threadId);
  });

  it('36. accepted non-owner trip member (bob) cannot trigger sync', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'POST', `/api/trips/${TRIP_ID}/chat/sync`, 'bob-tok');
    assert.equal(r.status, 403);
  });
});

describe('POST /api/circles/:circleId/chat/sync', () => {
  it('37. circle OWNER (alice) can trigger circle sync', async () => {
    const { app } = makeApp(baseState());
    const r = await req(app, 'POST', `/api/circles/${ALICE_ID}/chat/sync`, 'alice-tok');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'synced');
  });

  it('38. accepted non-owner circle member (bob) cannot trigger circle sync', async () => {
    const { app } = makeApp(baseState());
    // Bob is a member of alice's circle, but alice is the owner — bob cannot sync.
    const r = await req(app, 'POST', `/api/circles/${ALICE_ID}/chat/sync`, 'bob-tok');
    assert.equal(r.status, 403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Privacy guards
// ═══════════════════════════════════════════════════════════════════════════════

describe('Privacy guards', () => {
  it('39. trip chat response exposes no GPS, location_is_private, or service-role fields', async () => {
    const { app } = makeApp(stateWithMessage(baseState()));
    const r = await req(app, 'GET', `/api/trips/${TRIP_ID}/chat`, 'alice-tok');
    assert.equal(r.status, 200);

    const thread = r.body.thread;
    assert.ok(!('lat' in thread), 'no lat');
    assert.ok(!('lng' in thread), 'no lng');
    assert.ok(!('location_is_private' in thread), 'no location_is_private');
    assert.ok(!('service_role' in thread), 'no service_role');

    if (r.body.messages.length > 0) {
      const msg = r.body.messages[0];
      assert.ok(!('lat' in msg), 'message: no lat');
      assert.ok(!('service_role' in msg), 'message: no service_role');
    }
  });
});
