/**
 * postSaves.test.ts — backend tests for the post save/unsave API.
 *
 * Covers:
 *   - POST /api/posts/:id/save  — save succeeds; duplicate is idempotent
 *   - DELETE /api/posts/:id/save — unsave succeeds; unsaving a non-saved post is graceful
 *   - savedByMe is correct per user; save_count is correct
 *   - Invalid post ID → 400; post not found → 404; DB error → 500
 *
 * Uses the same fake-client pattern as postInteractions.test.ts:
 *   _setTestClient(client, true) sets BOTH the user-request slot and the
 *   service-client slot so both requireUser() and getServiceClient() resolve
 *   to the same in-memory fake.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { _setTestClient } from '../lib/http.js';

// ── Fake IDs ─────────────────────────────────────────────────────────────────

const AUTHOR_ID = '00000000-0000-0000-0000-000000000a01';
const OTHER_ID  = '00000000-0000-0000-0000-000000000a02';
const POST_ID   = '10000000-0000-0000-0000-000000000a01';
const TRIP_POST_ID = '10000000-0000-0000-0000-000000000a02';
const PRIVATE_POST_ID = '10000000-0000-0000-0000-000000000a03';
const TRIP_ID   = '20000000-0000-0000-0000-000000000a01';
const TOKEN_AUTHOR = 'fake-save-author';
const TOKEN_OTHER  = 'fake-save-other';

// ── In-memory DB ─────────────────────────────────────────────────────────────

let posts: Record<string, any> = {};
let postSaves: Array<{ post_id: string; user_id: string; created_at: string }> = [];
let tripMembers: Array<{ trip_id: string; user_id: string; status: string; role: string }> = [];

function resetDb() {
  posts = {
    [POST_ID]: {
      id: POST_ID, author_id: AUTHOR_ID, status: 'active',
      visibility: 'public', trip_id: null, save_count: 0,
      content: 'Test post', category: null,
    },
    [TRIP_POST_ID]: {
      id: TRIP_POST_ID, author_id: AUTHOR_ID, status: 'active',
      visibility: 'trip_only', trip_id: TRIP_ID, save_count: 0,
      content: 'Trip post', category: null,
    },
    [PRIVATE_POST_ID]: {
      id: PRIVATE_POST_ID, author_id: AUTHOR_ID, status: 'active',
      visibility: 'private', trip_id: null, save_count: 0,
      content: 'Private post', category: null,
    },
  };
  postSaves = [];
  tripMembers = [
    { trip_id: TRIP_ID, user_id: AUTHOR_ID, status: 'accepted', role: 'owner' },
  ];
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function buildFakeClient(tokenToId: Record<string, string>, dbError?: { table: string; op: string }) {
  function builder(table: string, rows: any[]): any {
    let filtered = [...rows];
    let insertData: any = null;
    let updateData: any = null;
    let deleteMode = false;
    let countMode = false;
    let _ignoreDuplicates = false;

    const b: any = {
      select(cols?: string, opts?: any) {
        if (opts?.count === 'exact' && opts?.head === true) countMode = true;
        return b;
      },
      eq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      neq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] !== val);
        return b;
      },
      in(col: string, vals: any[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return b;
      },
      order() { return b; },
      limit(n: number) { filtered = filtered.slice(0, n); return b; },
      insert(data: any) { insertData = data; return b; },
      upsert(data: any, opts?: any) {
        insertData = data;
        _ignoreDuplicates = opts?.ignoreDuplicates ?? false;
        return b;
      },
      update(data: any) { updateData = data; return b; },
      delete() { deleteMode = true; return b; },
      async single() {
        const base = filtered[0] ? { ...filtered[0] } : null;
        if (updateData !== null && base) {
          Object.assign(base, updateData);
          if (table === 'posts' && posts[base.id]) Object.assign(posts[base.id], updateData);
        }
        return { data: base, error: null };
      },
      async maybeSingle() {
        const base = filtered[0] ? { ...filtered[0] } : null;
        if (updateData !== null && base) {
          Object.assign(base, updateData);
          if (table === 'posts' && posts[base.id]) Object.assign(posts[base.id], updateData);
        }
        return { data: base, error: null };
      },
      then(resolve: any) {
        if (dbError?.table === table) {
          if (
            (dbError.op === 'upsert' && insertData !== null) ||
            (dbError.op === 'delete' && deleteMode)
          ) {
            return resolve({ data: null, error: { message: 'simulated db error' } });
          }
        }

        if (insertData !== null) {
          const arr = Array.isArray(insertData) ? insertData : [insertData];
          if (table === 'post_saves') {
            for (const row of arr) {
              const exists = postSaves.some(
                (s) => s.post_id === row.post_id && s.user_id === row.user_id,
              );
              if (!exists || !_ignoreDuplicates) {
                if (!exists) {
                  postSaves.push({ post_id: row.post_id, user_id: row.user_id, created_at: new Date().toISOString() });
                }
              }
            }
          } else if (table === 'posts') {
            // INSERT into posts — not exercised by save routes
          }
          return resolve({ data: arr, error: null });
        }

        if (deleteMode) {
          if (table === 'post_saves') {
            postSaves = postSaves.filter(
              (s) => !filtered.some((f) => f.post_id === s.post_id && f.user_id === s.user_id),
            );
          }
          return resolve({ data: filtered, error: null });
        }

        if (updateData !== null) {
          for (const row of filtered) {
            Object.assign(row, updateData);
            if (table === 'posts' && posts[row.id]) Object.assign(posts[row.id], updateData);
          }
          return resolve({ data: filtered, error: null });
        }

        if (countMode) {
          return resolve({ count: filtered.length, error: null });
        }

        return resolve({ data: [...filtered], error: null });
      },
    };
    return b;
  }

  return {
    auth: {
      async getUser(token: string) {
        const id = tokenToId[token];
        if (!id) return { data: { user: null }, error: new Error('invalid token') };
        return { data: { user: { id } }, error: null };
      },
    },
    from(table: string) {
      let rows: any[] = [];
      if (table === 'posts') rows = Object.values(posts).map((r) => ({ ...r }));
      else if (table === 'post_saves') rows = postSaves.map((r) => ({ ...r }));
      else if (table === 'trip_members') rows = tripMembers.map((r) => ({ ...r }));
      else if (table === 'profiles') rows = [
        { id: AUTHOR_ID, handle: 'authoruser', name: 'Author', avatar_url: null },
        { id: OTHER_ID,  handle: 'otheruser',  name: 'Other',  avatar_url: null },
      ];
      return builder(table, rows);
    },
    storage: {
      from() {
        return { upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: '' } }) };
      },
    },
  };
}

// ── Server setup ─────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

const tokenMap = { [TOKEN_AUTHOR]: AUTHOR_ID, [TOKEN_OTHER]: OTHER_ID };

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  _setTestClient(buildFakeClient(tokenMap) as any, true);
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

beforeEach(() => {
  resetDb();
  _setTestClient(buildFakeClient(tokenMap) as any, true);
});

function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function req(method: string, path: string, token: string, body?: object) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: authHeaders(token),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/posts/:id/save', () => {
  it('saves a public post and returns savedByMe=true, saveCount=1', async () => {
    const { status, data } = await req('POST', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.savedByMe, true);
    assert.equal(data.saveCount, 1);
  });

  it('duplicate save is idempotent — second call returns saveCount=1 not 2', async () => {
    await req('POST', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    const { status, data } = await req('POST', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.savedByMe, true);
    assert.equal(data.saveCount, 1, 'second save must not add a duplicate row');
  });

  it('two different users each save — saveCount=2', async () => {
    _setTestClient(buildFakeClient(tokenMap) as any, true);
    await req('POST', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    _setTestClient(buildFakeClient(tokenMap) as any, true);
    await req('POST', `/api/posts/${POST_ID}/save`, TOKEN_OTHER);
    assert.equal(postSaves.length, 2);
  });

  it('returns 400 for an invalid post ID', async () => {
    const { status } = await req('POST', '/api/posts/not-a-uuid/save', TOKEN_AUTHOR);
    assert.equal(status, 400);
  });

  it('returns 404 when the post does not exist', async () => {
    const { status } = await req('POST', `/api/posts/${'00000000-0000-0000-0000-000000000099'}/save`, TOKEN_AUTHOR);
    assert.equal(status, 404);
  });

  it('returns 403 for a private post', async () => {
    const { status } = await req('POST', `/api/posts/${PRIVATE_POST_ID}/save`, TOKEN_AUTHOR);
    assert.equal(status, 403);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await fetch(`${baseUrl}/api/posts/${POST_ID}/save`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('returns db_error when upsert fails', async () => {
    _setTestClient(buildFakeClient(tokenMap, { table: 'post_saves', op: 'upsert' }) as any, true);
    const { status, data } = await req('POST', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    assert.equal(status, 500, JSON.stringify(data));
    assert.match(data.error, /db_error/);
  });
});

describe('DELETE /api/posts/:id/save', () => {
  it('unsaves a saved post and returns savedByMe=false, saveCount=0', async () => {
    await req('POST', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    const { status, data } = await req('DELETE', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.savedByMe, false);
    assert.equal(data.saveCount, 0);
  });

  it('unsaving a post that was never saved is graceful — returns saveCount=0', async () => {
    const { status, data } = await req('DELETE', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.savedByMe, false);
    assert.equal(data.saveCount, 0);
  });

  it('unsave only removes the requesting user\'s row — other saves remain', async () => {
    _setTestClient(buildFakeClient(tokenMap) as any, true);
    await req('POST', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    _setTestClient(buildFakeClient(tokenMap) as any, true);
    await req('POST', `/api/posts/${POST_ID}/save`, TOKEN_OTHER);
    assert.equal(postSaves.length, 2);

    _setTestClient(buildFakeClient(tokenMap) as any, true);
    const { data } = await req('DELETE', `/api/posts/${POST_ID}/save`, TOKEN_AUTHOR);
    assert.equal(data.saveCount, 1, 'other user\'s save must remain');
    assert.equal(postSaves.length, 1);
    assert.equal(postSaves[0].user_id, OTHER_ID);
  });

  it('returns 400 for an invalid post ID', async () => {
    const { status } = await req('DELETE', '/api/posts/not-a-uuid/save', TOKEN_AUTHOR);
    assert.equal(status, 400);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await fetch(`${baseUrl}/api/posts/${POST_ID}/save`, { method: 'DELETE' });
    assert.equal(res.status, 401);
  });
});

describe('PATCH /api/posts/:id — category field', () => {
  it('sets category on an existing post and returns it in the response', async () => {
    const { status, data } = await req('PATCH', `/api/posts/${POST_ID}`, TOKEN_AUTHOR, {
      category: 'food',
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.category, 'food');
    assert.equal(posts[POST_ID].category, 'food', 'in-memory DB must be updated');
  });

  it('clears category when null is sent', async () => {
    posts[POST_ID].category = 'beach';
    const { status, data } = await req('PATCH', `/api/posts/${POST_ID}`, TOKEN_AUTHOR, {
      category: null,
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.category, null);
    assert.equal(posts[POST_ID].category, null, 'category must be cleared in DB');
  });

  it('ignores category when the field is omitted — category stays unchanged', async () => {
    posts[POST_ID].category = 'nightlife';
    const { status, data } = await req('PATCH', `/api/posts/${POST_ID}`, TOKEN_AUTHOR, {
      content: 'Updated content',
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(posts[POST_ID].category, 'nightlife', 'category must not be touched when omitted');
  });

  it('returns 403 when a non-author tries to update the category', async () => {
    const { status } = await req('PATCH', `/api/posts/${POST_ID}`, TOKEN_OTHER, {
      category: 'food',
    });
    assert.equal(status, 403);
  });
});
