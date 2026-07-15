/**
 * postInteractions.test.ts — backend tests for the post & comment interaction layer.
 *
 * Covers: emoji reactions, post settings, archive, share, comment likes,
 *         owner-can-delete-any-comment, comments_setting enforcement.
 *
 * Pattern from admin-route-test-pattern:
 *   - Use _setTestClient(client, true) — the ready=true flag is required
 *   - requireUser is satisfied by the fake client's getUser() returning a user row
 *   - Use http.createServer(app) to get a real Express server; run requests via fetch
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { _setTestClient } from '../lib/http.js';

// ── Fake auth user ─────────────────────────────────────────────────────────────

const AUTHOR_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_ID  = '00000000-0000-0000-0000-000000000002';
const POST_ID   = '10000000-0000-0000-0000-000000000001';
const COMMENT_ID = '20000000-0000-0000-0000-000000000001';
const TOKEN_AUTHOR = 'fake-token-author';
const TOKEN_OTHER  = 'fake-token-other';

// ── In-memory DB ───────────────────────────────────────────────────────────────

let posts: Record<string, any> = {};
let comments: Record<string, any> = {};
let postReactions: Array<{ post_id: string; user_id: string; emoji: string }> = [];
let commentLikes: Array<{ comment_id: string; user_id: string }> = [];
let postShares: Array<any> = [];

function resetDb() {
  posts = {
    [POST_ID]: {
      id: POST_ID,
      author_id: AUTHOR_ID,
      status: 'active',
      visibility: 'public',
      trip_id: null,
      comments_setting: 'everyone',
      sharing_disabled: false,
      likes_hidden: false,
      reposting_disabled: false,
    },
  };
  comments = {
    [COMMENT_ID]: {
      id: COMMENT_ID,
      post_id: POST_ID,
      user_id: OTHER_ID,
      body: 'Test comment',
      created_at: new Date().toISOString(),
      updated_at: null,
      deleted_at: null,
    },
  };
  postReactions = [];
  commentLikes = [];
  postShares = [];
}

// ── Fake Supabase client factory ───────────────────────────────────────────────

function buildFakeClient(callerId: string) {
  // Builder pattern — chains return themselves, .maybeSingle()/.single() resolves
  function builder(table: string, rows: any[], op = 'select'): any {
    let filtered = [...rows];
    let singleRow: any = null;
    let insertData: any = null;
    let updateData: any = null;
    let deleteMode = false;
    let countMode = false;

    const b: any = {
      select(cols?: string, opts?: any) {
        if (opts?.count === 'exact' && opts?.head === true) countMode = true;
        return b;
      },
      eq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      is(col: string, val: any) {
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
      or(_filter: string) { return b; },
      order() { return b; },
      limit(n: number) { filtered = filtered.slice(0, n); return b; },
      insert(data: any) { insertData = data; return b; },
      upsert(data: any) { insertData = data; return b; },
      update(data: any) { updateData = data; return b; },
      delete() { deleteMode = true; return b; },
      async single() { return { data: filtered[0] ?? null, error: null }; },
      async maybeSingle() { return { data: filtered[0] ?? null, error: null }; },
      get data() { return filtered; },
      then(resolve: any) {
        // Handle insert/upsert
        if (insertData !== null) {
          const arr = Array.isArray(insertData) ? insertData : [insertData];
          if (table === 'post_reactions') {
            for (const row of arr) {
              const idx = postReactions.findIndex(
                (r) => r.post_id === row.post_id && r.user_id === row.user_id,
              );
              if (idx >= 0) postReactions[idx] = { ...postReactions[idx], ...row };
              else postReactions.push(row);
            }
          } else if (table === 'comment_likes') {
            for (const row of arr) {
              const idx = commentLikes.findIndex(
                (r) => r.comment_id === row.comment_id && r.user_id === row.user_id,
              );
              if (idx < 0) commentLikes.push(row);
            }
          } else if (table === 'post_shares') {
            postShares.push(...arr);
          }
          return resolve({ data: arr, error: null });
        }
        // Handle delete
        if (deleteMode) {
          if (table === 'post_reactions') {
            const before2 = postReactions.length;
            postReactions = postReactions.filter(
              (r) => !filtered.some((f) => f.post_id === r.post_id && f.user_id === r.user_id),
            );
            // Simpler: just filter by the eq conditions applied above
            postReactions = postReactions.filter(
              (r) => !filtered.includes(r),
            );
          } else if (table === 'comment_likes') {
            commentLikes = commentLikes.filter(
              (r) => !filtered.includes(r),
            );
          }
          return resolve({ data: filtered, error: null });
        }
        // Handle update
        if (updateData !== null) {
          for (const row of filtered) {
            Object.assign(row, updateData);
            if (table === 'posts') Object.assign(posts[row.id] ?? {}, updateData);
          }
          return resolve({ data: filtered, error: null });
        }
        if (countMode) {
          return resolve({ count: filtered.length, error: null });
        }
        return resolve({ data: filtered, error: null });
      },
    };
    return b;
  }

  return {
    auth: {
      async getUser(token: string) {
        const id = token === TOKEN_AUTHOR ? AUTHOR_ID : token === TOKEN_OTHER ? OTHER_ID : null;
        if (!id) return { data: { user: null }, error: new Error('invalid token') };
        return { data: { user: { id } }, error: null };
      },
    },
    from(table: string) {
      let rows: any[] = [];
      if (table === 'posts') rows = Object.values(posts);
      else if (table === 'posts_comments') rows = Object.values(comments);
      else if (table === 'post_reactions') rows = [...postReactions];
      else if (table === 'comment_likes') rows = [...commentLikes];
      else if (table === 'post_shares') rows = [...postShares];
      else if (table === 'profiles') rows = [
        { id: AUTHOR_ID, handle: 'authoruser', name: 'Author', avatar_url: null },
        { id: OTHER_ID, handle: 'otheruser', name: 'Other', avatar_url: null },
      ];
      return builder(table, rows);
    },
    storage: {
      from() { return { upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: '' } }) }; },
    },
  };
}

// ── Server setup ───────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  _setTestClient(buildFakeClient(AUTHOR_ID) as any, true);
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

beforeEach(() => {
  resetDb();
  _setTestClient(buildFakeClient(AUTHOR_ID) as any, true);
});

function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function json(
  method: string,
  path: string,
  token: string,
  body?: object,
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: authHeaders(token),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/posts/:id/reactions', () => {
  it('rejects invalid emoji', async () => {
    const { status, data } = await json('POST', `/api/posts/${POST_ID}/reactions`, TOKEN_AUTHOR, {
      emoji: '🤡',
    });
    assert.equal(status, 400);
    assert.match(data.error, /invalid_payload/i);
  });

  it('upserts a valid emoji reaction', async () => {
    const { status, data } = await json('POST', `/api/posts/${POST_ID}/reactions`, TOKEN_AUTHOR, {
      emoji: '❤️',
    });
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.equal(data.myReaction, '❤️');
    assert.ok(Array.isArray(data.reactions));
    assert.equal(postReactions.length, 1);
    assert.equal(postReactions[0].emoji, '❤️');
  });

  it('changes existing reaction to new emoji', async () => {
    postReactions.push({ post_id: POST_ID, user_id: AUTHOR_ID, emoji: '😂' });
    const { status, data } = await json('POST', `/api/posts/${POST_ID}/reactions`, TOKEN_AUTHOR, {
      emoji: '👍',
    });
    assert.equal(status, 200);
    assert.equal(data.myReaction, '👍');
  });
});

describe('GET /api/posts/:id/reactions', () => {
  it('returns empty reactions for post with none', async () => {
    const { status, data } = await json('GET', `/api/posts/${POST_ID}/reactions`, TOKEN_AUTHOR);
    assert.equal(status, 200);
    assert.deepEqual(data.reactions, []);
    assert.equal(data.myReaction, null);
    assert.equal(data.total, 0);
  });

  it('returns grouped reaction counts', async () => {
    postReactions.push(
      { post_id: POST_ID, user_id: AUTHOR_ID, emoji: '❤️' },
      { post_id: POST_ID, user_id: OTHER_ID, emoji: '❤️' },
    );
    _setTestClient(buildFakeClient(OTHER_ID) as any, true);
    const { status, data } = await json('GET', `/api/posts/${POST_ID}/reactions`, TOKEN_OTHER);
    assert.equal(status, 200);
    const heart = data.reactions.find((r: any) => r.emoji === '❤️');
    assert.ok(heart);
    assert.equal(heart.count, 2);
    assert.equal(data.myReaction, '❤️');
    assert.equal(data.total, 2);
  });
});

describe('DELETE /api/posts/:id/reactions', () => {
  it('removes caller reaction and returns updated counts', async () => {
    postReactions.push({ post_id: POST_ID, user_id: AUTHOR_ID, emoji: '🔥' });
    const { status, data } = await json('DELETE', `/api/posts/${POST_ID}/reactions`, TOKEN_AUTHOR);
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.equal(data.myReaction, null);
  });
});

describe('PATCH /api/posts/:id/settings', () => {
  it('rejects request from non-owner', async () => {
    _setTestClient(buildFakeClient(OTHER_ID) as any, true);
    const { status, data } = await json('PATCH', `/api/posts/${POST_ID}/settings`, TOKEN_OTHER, {
      commentsSetting: 'disabled',
    });
    assert.equal(status, 403);
    assert.match(data.error, /forbidden/i);
  });

  it('updates commentsSetting for owner', async () => {
    const { status, data } = await json('PATCH', `/api/posts/${POST_ID}/settings`, TOKEN_AUTHOR, {
      commentsSetting: 'disabled',
    });
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.equal(posts[POST_ID].comments_setting, 'disabled');
  });

  it('rejects invalid commentsSetting value', async () => {
    const { status } = await json('PATCH', `/api/posts/${POST_ID}/settings`, TOKEN_AUTHOR, {
      commentsSetting: 'nobody',
    });
    assert.equal(status, 400);
  });

  it('hides likes when likesHidden=true', async () => {
    const { status, data } = await json('PATCH', `/api/posts/${POST_ID}/settings`, TOKEN_AUTHOR, {
      likesHidden: true,
    });
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.equal(posts[POST_ID].likes_hidden, true);
  });
});

describe('POST /api/posts/:id/archive', () => {
  it('rejects archive from non-owner', async () => {
    _setTestClient(buildFakeClient(OTHER_ID) as any, true);
    const { status } = await json('POST', `/api/posts/${POST_ID}/archive`, TOKEN_OTHER);
    assert.equal(status, 403);
  });

  it('archives post for owner', async () => {
    const { status, data } = await json('POST', `/api/posts/${POST_ID}/archive`, TOKEN_AUTHOR);
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.ok(data.archived);
    assert.equal(posts[POST_ID].status, 'hidden');
  });
});

describe('POST /api/posts/:id/share', () => {
  it('rejects invalid share target', async () => {
    const { status } = await json('POST', `/api/posts/${POST_ID}/share`, TOKEN_AUTHOR, {
      target: 'invalid_target',
    });
    assert.equal(status, 400);
  });

  it('records a valid share', async () => {
    const { status, data } = await json('POST', `/api/posts/${POST_ID}/share`, TOKEN_AUTHOR, {
      target: 'external',
    });
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.equal(data.target, 'external');
  });

  it('blocks share when sharing_disabled=true for non-owner', async () => {
    posts[POST_ID].sharing_disabled = true;
    _setTestClient(buildFakeClient(OTHER_ID) as any, true);
    const { status, data } = await json('POST', `/api/posts/${POST_ID}/share`, TOKEN_OTHER, {
      target: 'external',
    });
    assert.equal(status, 403);
    assert.match(data.error, /sharing_disabled/i);
  });

  it('allows owner to share even when sharing_disabled=true', async () => {
    posts[POST_ID].sharing_disabled = true;
    const { status, data } = await json('POST', `/api/posts/${POST_ID}/share`, TOKEN_AUTHOR, {
      target: 'external',
    });
    assert.equal(status, 200);
    assert.ok(data.ok);
  });
});

describe('POST /api/posts/:id/comments/:commentId/like', () => {
  it('likes a comment', async () => {
    const { status, data } = await json(
      'POST',
      `/api/posts/${POST_ID}/comments/${COMMENT_ID}/like`,
      TOKEN_AUTHOR,
    );
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.equal(data.likedByMe, true);
    assert.equal(commentLikes.length, 1);
  });

  it('is idempotent (liking twice is safe)', async () => {
    commentLikes.push({ comment_id: COMMENT_ID, user_id: AUTHOR_ID });
    const { status, data } = await json(
      'POST',
      `/api/posts/${POST_ID}/comments/${COMMENT_ID}/like`,
      TOKEN_AUTHOR,
    );
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.equal(commentLikes.length, 1);
  });
});

describe('DELETE /api/posts/:id/comments/:commentId/like', () => {
  it('unlikes a comment', async () => {
    commentLikes.push({ comment_id: COMMENT_ID, user_id: AUTHOR_ID });
    const { status, data } = await json(
      'DELETE',
      `/api/posts/${POST_ID}/comments/${COMMENT_ID}/like`,
      TOKEN_AUTHOR,
    );
    assert.equal(status, 200);
    assert.ok(data.ok);
    assert.equal(data.likedByMe, false);
  });
});

describe('DELETE /api/posts/:id/comments/:commentId (owner deletes other comment)', () => {
  it('allows post author to delete any comment on their post', async () => {
    const { status, data } = await json(
      'DELETE',
      `/api/posts/${POST_ID}/comments/${COMMENT_ID}`,
      TOKEN_AUTHOR,
    );
    assert.equal(status, 200);
    assert.ok(data.ok);
  });

  it('blocks non-owner non-author from deleting', async () => {
    const THIRD_ID = '00000000-0000-0000-0000-000000000099';
    const THIRD_TOKEN = 'fake-token-third';

    function buildThirdClient() {
      const base = buildFakeClient(AUTHOR_ID);
      const origGetUser = base.auth.getUser.bind(base.auth);
      base.auth.getUser = async (token: string) => {
        if (token === THIRD_TOKEN) return { data: { user: { id: THIRD_ID } }, error: null };
        return origGetUser(token);
      };
      return base;
    }
    _setTestClient(buildThirdClient() as any, true);

    const { status } = await json(
      'DELETE',
      `/api/posts/${POST_ID}/comments/${COMMENT_ID}`,
      THIRD_TOKEN,
    );
    assert.equal(status, 403);
  });
});

describe('POST /api/posts/:id/comments — comments_setting enforcement', () => {
  it('rejects comment when comments_setting=disabled', async () => {
    posts[POST_ID].comments_setting = 'disabled';
    _setTestClient(buildFakeClient(OTHER_ID) as any, true);
    const { status, data } = await json(
      'POST',
      `/api/posts/${POST_ID}/comments`,
      TOKEN_OTHER,
      { body: 'Hello!' },
    );
    assert.equal(status, 403);
    assert.match(data.error, /comments_disabled/i);
  });

  it('allows comment when comments_setting=everyone', async () => {
    posts[POST_ID].comments_setting = 'everyone';
    const { status } = await json(
      'POST',
      `/api/posts/${POST_ID}/comments`,
      TOKEN_AUTHOR,
      { body: 'Hello!' },
    );
    assert.notEqual(status, 400);
  });

  it('rejects non-friend comment when comments_setting=friends', async () => {
    posts[POST_ID].comments_setting = 'friends';
    _setTestClient(buildFakeClient(OTHER_ID) as any, true);
    const { status, data } = await json(
      'POST',
      `/api/posts/${POST_ID}/comments`,
      TOKEN_OTHER,
      { body: 'Hello!' },
    );
    assert.equal(status, 403);
    assert.match(data.error, /comments_limited/i);
  });

  it('allows post owner to comment on their own post regardless of comments_setting', async () => {
    posts[POST_ID].comments_setting = 'disabled';
    const { status } = await json(
      'POST',
      `/api/posts/${POST_ID}/comments`,
      TOKEN_AUTHOR,
      { body: 'My own post, I can still comment.' },
    );
    assert.equal(status, 201);
  });
});

describe('GET /api/posts/:id/reactions — access control', () => {
  it('returns 404 when post does not exist', async () => {
    const { status } = await json('GET', `/api/posts/99999999-0000-0000-0000-000000000001/reactions`, TOKEN_AUTHOR);
    assert.equal(status, 404);
  });

  it('returns reactions for a valid accessible post', async () => {
    const { status, data } = await json('GET', `/api/posts/${POST_ID}/reactions`, TOKEN_AUTHOR);
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.reactions));
  });
});

describe('POST/DELETE /api/posts/:id/comments/:commentId/like — cross-post binding', () => {
  const OTHER_POST_ID = '10000000-0000-0000-0000-000000000002';

  it('rejects like when commentId belongs to a different post', async () => {
    posts[OTHER_POST_ID] = { ...posts[POST_ID], id: OTHER_POST_ID };
    const { status } = await json(
      'POST',
      `/api/posts/${OTHER_POST_ID}/comments/${COMMENT_ID}/like`,
      TOKEN_AUTHOR,
    );
    assert.equal(status, 404);
  });

  it('rejects unlike when commentId belongs to a different post', async () => {
    posts[OTHER_POST_ID] = { ...posts[POST_ID], id: OTHER_POST_ID };
    const { status } = await json(
      'DELETE',
      `/api/posts/${OTHER_POST_ID}/comments/${COMMENT_ID}/like`,
      TOKEN_AUTHOR,
    );
    assert.equal(status, 404);
  });
});
