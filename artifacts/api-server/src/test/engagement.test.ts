/**
 * engagement.test.ts — backend tests for GET /api/engagement/likes.
 *
 * Covers:
 *   - 401 when no auth token
 *   - 400 for invalid targetType / targetId / empty reactionType
 *   - 403 when viewer cannot access the content (private post, private memory, etc.)
 *   - 200 success with users array, nextCursor, hasMore
 *   - Viewer excluded from their own results
 *   - Block filtering (both directions excluded)
 *   - Account-status filtering (deleted / banned / suspended excluded)
 *   - Pagination: hasMore=true when limit+1 rows; hasMore=false otherwise
 *   - comment_like: access follows parent post visibility
 *   - Follow state: isFollowing / followsYou flags
 *
 * Uses the same fake-client pattern as postSaves.test.ts:
 *   _setTestClient(client, true) wires BOTH requireUser() and getServiceClient()
 *   to the same in-memory fake so no real Supabase calls are made.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { _setTestClient } from '../lib/http.js';

// ── IDs — all hex chars only, satisfies /^[0-9a-f-]{36}$/i ───────────────────

const VIEWER_ID    = '00000000-0000-0000-0000-000000000001';
const AUTHOR_ID    = '00000000-0000-0000-0000-000000000002';
const LIKER1_ID    = '00000000-0000-0000-0000-000000000010';
const LIKER2_ID    = '00000000-0000-0000-0000-000000000011';
const BLOCKED_ID   = '00000000-0000-0000-0000-000000000012';
const DELETED_ID   = '00000000-0000-0000-0000-000000000013';
const BANNED_ID    = '00000000-0000-0000-0000-000000000014';
const SUSPENDED_ID = '00000000-0000-0000-0000-000000000015';
const FOLLOWER_ID  = '00000000-0000-0000-0000-000000000016';
const FOLLOWING_ID = '00000000-0000-0000-0000-000000000017';

const POST_ID         = '10000000-0000-0000-0000-000000000001';
const PRIVATE_POST_ID = '10000000-0000-0000-0000-000000000002';
const COMMENT_ID      = '20000000-0000-0000-0000-000000000001';

const TOKEN_VIEWER = 'tok-viewer';
const tokenMap: Record<string, string> = { [TOKEN_VIEWER]: VIEWER_ID };

// ── In-memory state ───────────────────────────────────────────────────────────

let posts: any[];
let postLikes: any[];
let postReactions: any[];
let commentLikes: any[];
let blocks: any[];
let profiles: any[];
let postsComments: any[];
let userFollows: any[];
// The stamp guard in stamps.ts runs for ALL requests (router.use without path prefix)
// because stampsRouter is mounted before engagementRouter in routes/index.ts.
// Include the flag row so the guard calls next() instead of returning 503.
const featureFlags = [{ flag: 'stamp_system_v2_enabled', key: 'stamp_system_v2_enabled', enabled: true }];

function resetDb() {
  posts = [
    { id: POST_ID,         author_id: AUTHOR_ID, visibility: 'public',  status: 'active', trip_id: null },
    { id: PRIVATE_POST_ID, author_id: AUTHOR_ID, visibility: 'private', status: 'active', trip_id: null },
  ];

  // LIKER1 liked the public post at T=2, VIEWER liked at T=1 (so viewer appears in raw list)
  postLikes = [
    { user_id: LIKER1_ID, post_id: POST_ID, created_at: '2025-01-02T00:00:00Z' },
    { user_id: VIEWER_ID, post_id: POST_ID, created_at: '2025-01-01T00:00:00Z' },
  ];

  postReactions = [
    { user_id: LIKER1_ID, post_id: POST_ID, emoji: '❤️', created_at: '2025-01-02T00:00:00Z' },
  ];

  commentLikes = [
    { user_id: LIKER1_ID, comment_id: COMMENT_ID, created_at: '2025-01-02T00:00:00Z' },
  ];

  blocks = [];

  profiles = [
    { id: VIEWER_ID,    username: 'viewer',    display_name: 'Viewer',    avatar_url: null, account_status: 'active'    },
    { id: AUTHOR_ID,    username: 'author',    display_name: 'Author',    avatar_url: null, account_status: 'active'    },
    { id: LIKER1_ID,    username: 'liker1',    display_name: 'Liker One', avatar_url: null, account_status: 'active'    },
    { id: LIKER2_ID,    username: 'liker2',    display_name: 'Liker Two', avatar_url: null, account_status: 'active'    },
    { id: BLOCKED_ID,   username: 'blocked',   display_name: 'Blocked',   avatar_url: null, account_status: 'active'    },
    { id: DELETED_ID,   username: 'deleted',   display_name: 'Deleted',   avatar_url: null, account_status: 'deleted'   },
    { id: BANNED_ID,    username: 'banned',    display_name: 'Banned',    avatar_url: null, account_status: 'banned'    },
    { id: SUSPENDED_ID, username: 'suspended', display_name: 'Suspended', avatar_url: null, account_status: 'suspended' },
    { id: FOLLOWER_ID,  username: 'follower',  display_name: 'Follower',  avatar_url: null, account_status: 'active'    },
    { id: FOLLOWING_ID, username: 'following', display_name: 'Following', avatar_url: null, account_status: 'active'    },
  ];

  postsComments = [
    { id: COMMENT_ID, post_id: POST_ID, deleted_at: null },
  ];

  userFollows = [];
}

// ── Fake Supabase builder ─────────────────────────────────────────────────────

function makeBuilder(table: string): any {
  let rows: any[];
  switch (table) {
    case 'posts':          rows = posts.map((r) => ({ ...r })); break;
    case 'posts_likes':    rows = postLikes.map((r) => ({ ...r })); break;
    case 'post_reactions': rows = postReactions.map((r) => ({ ...r })); break;
    case 'comment_likes':  rows = commentLikes.map((r) => ({ ...r })); break;
    case 'highlight_likes':rows = []; break;
    case 'memory_likes':   rows = []; break;
    case 'blocks':         rows = blocks.map((r) => ({ ...r })); break;
    case 'profiles':       rows = profiles.map((r) => ({ ...r })); break;
    case 'posts_comments': rows = postsComments.map((r) => ({ ...r })); break;
    case 'user_follows':   rows = userFollows.map((r) => ({ ...r })); break;
    case 'highlights':     rows = []; break;
    case 'memories':       rows = []; break;
    case 'trip_members':   rows = []; break;
    case 'feature_flags':  rows = featureFlags.map((r) => ({ ...r })); break;
    default:               rows = [];
  }

  let filtered = rows;
  const b: any = {
    select() { return b; },

    eq(col: string, val: any) {
      filtered = filtered.filter((r) => r[col] === val);
      return b;
    },

    in(col: string, vals: any[]) {
      filtered = filtered.filter((r) => vals.includes(r[col]));
      return b;
    },

    not(col: string, op: string, val: any) {
      if (op === 'eq') filtered = filtered.filter((r) => r[col] !== val);
      return b;
    },

    is(col: string, val: any) {
      filtered = filtered.filter((r) =>
        val === null ? r[col] == null : r[col] === val,
      );
      return b;
    },

    or(condition: string) {
      const parts = condition.split(',');
      const orFilters = parts.map((p) => {
        const fi = p.indexOf('.');
        const si = p.indexOf('.', fi + 1);
        const col = p.slice(0, fi);
        const op  = p.slice(fi + 1, si);
        const val = p.slice(si + 1);
        if (op === 'eq') return (r: any) => r[col] === val;
        return (_r: any) => true;
      });
      filtered = filtered.filter((r) => orFilters.some((f) => f(r)));
      return b;
    },

    lt(col: string, val: any) {
      filtered = filtered.filter((r) => r[col] < val);
      return b;
    },

    order() { return b; },
    limit(n: number) { filtered = filtered.slice(0, n); return b; },

    async maybeSingle() {
      return { data: filtered[0] ? { ...filtered[0] } : null, error: null };
    },

    then(resolve: any) {
      return resolve({ data: filtered.map((r) => ({ ...r })), error: null });
    },
  };
  return b;
}

function buildFakeClient() {
  return {
    auth: {
      async getUser(token: string) {
        const id = tokenMap[token];
        if (!id) return { data: { user: null }, error: new Error('invalid token') };
        return { data: { user: { id } }, error: null };
      },
    },
    from(table: string) { return makeBuilder(table); },
  };
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

beforeEach(() => {
  resetDb();
  _setTestClient(buildFakeClient() as any, true);
});

// ── Request helpers ───────────────────────────────────────────────────────────

async function get(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  let data: any;
  try { data = await res.json(); } catch { data = await res.text(); }
  return { status: res.status, data };
}

function url(params: Record<string, string>) {
  return `/api/engagement/likes?${new URLSearchParams(params).toString()}`;
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/engagement/likes — authentication', () => {
  it('returns 401 when no Authorization header is sent', async () => {
    const { status } = await get(url({ targetType: 'post_like', targetId: POST_ID }));
    assert.equal(status, 401);
  });

  it('returns 401 for an invalid token', async () => {
    const { status } = await get(url({ targetType: 'post_like', targetId: POST_ID }), 'bad-token');
    assert.equal(status, 401);
  });
});

describe('GET /api/engagement/likes — input validation', () => {
  it('returns 400 for an unknown targetType', async () => {
    const { status, data } = await get(
      url({ targetType: 'unknown_type', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 400, JSON.stringify(data));
    assert.match(data.error, /invalid_payload/);
  });

  it('returns 400 when targetType is missing', async () => {
    const { status } = await get(
      `/api/engagement/likes?targetId=${POST_ID}`,
      TOKEN_VIEWER,
    );
    assert.equal(status, 400);
  });

  it('returns 400 for a non-UUID targetId', async () => {
    const { status, data } = await get(
      url({ targetType: 'post_like', targetId: 'not-a-uuid' }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 400, JSON.stringify(data));
    assert.match(data.error, /invalid_payload/);
  });

  it('returns 400 when targetId is missing', async () => {
    const { status } = await get(
      `/api/engagement/likes?targetType=post_like`,
      TOKEN_VIEWER,
    );
    assert.equal(status, 400);
  });

  it('returns 400 for an empty reactionType on post_reaction', async () => {
    const { status, data } = await get(
      url({ targetType: 'post_reaction', targetId: POST_ID, reactionType: '' }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 400, JSON.stringify(data));
    assert.match(data.error, /invalid_payload/);
  });

  it('accepts a valid emoji reactionType for post_reaction', async () => {
    const { status } = await get(
      url({ targetType: 'post_reaction', targetId: POST_ID, reactionType: '❤️' }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 200);
  });
});

describe('GET /api/engagement/likes — access control', () => {
  it('returns 403 when post is private and viewer is not the author', async () => {
    const { status, data } = await get(
      url({ targetType: 'post_like', targetId: PRIVATE_POST_ID }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 403, JSON.stringify(data));
    assert.match(data.error, /forbidden/);
  });

  it('returns 200 for a public post', async () => {
    const { status } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 200);
  });

  it('author can access their own private post likers', async () => {
    // Add author to tokenMap temporarily
    const authorToken = 'tok-author';
    tokenMap[authorToken] = AUTHOR_ID;
    _setTestClient(buildFakeClient() as any, true);

    postLikes.push({ user_id: LIKER1_ID, post_id: PRIVATE_POST_ID, created_at: '2025-01-02T00:00:00Z' });

    const { status } = await get(
      url({ targetType: 'post_like', targetId: PRIVATE_POST_ID }),
      authorToken,
    );
    delete tokenMap[authorToken];
    assert.equal(status, 200);
  });

  it('comment_like returns 403 when parent post is private', async () => {
    // Attach the comment to the private post
    postsComments[0] = { id: COMMENT_ID, post_id: PRIVATE_POST_ID, deleted_at: null };
    _setTestClient(buildFakeClient() as any, true);

    const { status } = await get(
      url({ targetType: 'comment_like', targetId: COMMENT_ID }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 403);
  });

  it('comment_like returns 200 when parent post is public', async () => {
    const { status } = await get(
      url({ targetType: 'comment_like', targetId: COMMENT_ID }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 200);
  });
});

describe('GET /api/engagement/likes — successful response shape', () => {
  it('returns ok=true, users array, nextCursor, hasMore', async () => {
    const { status, data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.users), 'users must be an array');
    assert.ok('nextCursor' in data, 'response must include nextCursor');
    assert.ok('hasMore' in data, 'response must include hasMore');
    assert.equal(typeof data.hasMore, 'boolean');
  });

  it('each user row has required fields', async () => {
    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    assert.ok(data.users.length > 0, 'expected at least one user');
    const user = data.users[0];
    assert.ok('id' in user, 'missing id');
    assert.ok('handle' in user, 'missing handle');
    assert.ok('displayName' in user, 'missing displayName');
    assert.ok('isFollowing' in user, 'missing isFollowing');
    assert.ok('followsYou' in user, 'missing followsYou');
    assert.ok('likedAt' in user, 'missing likedAt');
  });

  it('total is intentionally absent from the response (privacy)', async () => {
    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    assert.ok(!('total' in data), 'total must not be in the response (privacy)');
  });

  it('returns empty users array when no likes exist', async () => {
    postLikes = [];
    _setTestClient(buildFakeClient() as any, true);

    const { status, data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 200, JSON.stringify(data));
    assert.deepEqual(data.users, []);
    assert.equal(data.hasMore, false);
    assert.equal(data.nextCursor, null);
  });
});

describe('GET /api/engagement/likes — viewer excluded from results', () => {
  it('viewer does not appear in their own likers list', async () => {
    // postLikes already includes VIEWER_ID (set in resetDb)
    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const ids = data.users.map((u: any) => u.id);
    assert.ok(!ids.includes(VIEWER_ID), 'viewer must be excluded from results');
  });
});

describe('GET /api/engagement/likes — block filtering', () => {
  it('excludes a user the viewer has blocked', async () => {
    postLikes.push({ user_id: BLOCKED_ID, post_id: POST_ID, created_at: '2025-01-03T00:00:00Z' });
    blocks.push({ blocker_id: VIEWER_ID, blocked_id: BLOCKED_ID });
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const ids = data.users.map((u: any) => u.id);
    assert.ok(!ids.includes(BLOCKED_ID), 'blocked user must be excluded');
    assert.ok(ids.includes(LIKER1_ID), 'non-blocked user must still appear');
  });

  it('excludes a user who has blocked the viewer (reverse block)', async () => {
    postLikes.push({ user_id: BLOCKED_ID, post_id: POST_ID, created_at: '2025-01-03T00:00:00Z' });
    blocks.push({ blocker_id: BLOCKED_ID, blocked_id: VIEWER_ID });
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const ids = data.users.map((u: any) => u.id);
    assert.ok(!ids.includes(BLOCKED_ID), 'user who blocked viewer must be excluded');
  });
});

describe('GET /api/engagement/likes — account status filtering', () => {
  function addLiker(userId: string, createdAt: string) {
    postLikes.push({ user_id: userId, post_id: POST_ID, created_at: createdAt });
  }

  it('excludes users with account_status=deleted', async () => {
    addLiker(DELETED_ID, '2025-01-04T00:00:00Z');
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const ids = data.users.map((u: any) => u.id);
    assert.ok(!ids.includes(DELETED_ID), 'deleted account must be excluded');
  });

  it('excludes users with account_status=banned', async () => {
    addLiker(BANNED_ID, '2025-01-04T00:00:00Z');
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const ids = data.users.map((u: any) => u.id);
    assert.ok(!ids.includes(BANNED_ID), 'banned account must be excluded');
  });

  it('excludes users with account_status=suspended', async () => {
    addLiker(SUSPENDED_ID, '2025-01-04T00:00:00Z');
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const ids = data.users.map((u: any) => u.id);
    assert.ok(!ids.includes(SUSPENDED_ID), 'suspended account must be excluded');
  });

  it('includes active accounts that liked the post', async () => {
    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const ids = data.users.map((u: any) => u.id);
    assert.ok(ids.includes(LIKER1_ID), 'active liker must appear');
  });
});

describe('GET /api/engagement/likes — pagination (hasMore)', () => {
  it('hasMore=true when there are more rows than the requested limit', async () => {
    // Add limit+1 likers (limit defaults to 20, so add 21 unique rows)
    for (let i = 0; i < 21; i++) {
      const uid = `0000000a-0000-0000-0000-${String(i).padStart(12, '0')}`;
      // Ensure the profile exists for this uid with active status
      profiles.push({ id: uid, username: `user${i}`, display_name: `User ${i}`, avatar_url: null, account_status: 'active' });
      postLikes.unshift({ user_id: uid, post_id: POST_ID, created_at: `2025-02-${String(i + 1).padStart(2, '0')}T00:00:00Z` });
    }
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID, limit: '20' }),
      TOKEN_VIEWER,
    );
    assert.equal(data.hasMore, true, 'hasMore must be true when more rows exist');
    assert.ok(data.nextCursor !== null, 'nextCursor must be set when hasMore=true');
    assert.ok(data.users.length <= 20, 'must return at most limit rows');
  });

  it('hasMore=false when total rows ≤ limit', async () => {
    // Default has 2 rows (LIKER1 + VIEWER); viewer is excluded → 1 visible
    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID, limit: '20' }),
      TOKEN_VIEWER,
    );
    assert.equal(data.hasMore, false, 'hasMore must be false when ≤ limit rows');
    assert.equal(data.nextCursor, null, 'nextCursor must be null when no more pages');
  });
});

describe('GET /api/engagement/likes — follow state enrichment', () => {
  it('isFollowing=true when viewer follows the liker', async () => {
    postLikes = [{ user_id: FOLLOWING_ID, post_id: POST_ID, created_at: '2025-01-02T00:00:00Z' }];
    userFollows = [{ follower_id: VIEWER_ID, following_id: FOLLOWING_ID }];
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const user = data.users.find((u: any) => u.id === FOLLOWING_ID);
    assert.ok(user, 'following user must appear');
    assert.equal(user.isFollowing, true, 'isFollowing must be true');
    assert.equal(user.followsYou, false, 'followsYou must be false');
  });

  it('followsYou=true when the liker follows the viewer', async () => {
    postLikes = [{ user_id: FOLLOWER_ID, post_id: POST_ID, created_at: '2025-01-02T00:00:00Z' }];
    userFollows = [{ follower_id: FOLLOWER_ID, following_id: VIEWER_ID }];
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const user = data.users.find((u: any) => u.id === FOLLOWER_ID);
    assert.ok(user, 'follower user must appear');
    assert.equal(user.isFollowing, false, 'isFollowing must be false');
    assert.equal(user.followsYou, true, 'followsYou must be true');
  });

  it('both isFollowing and followsYou true for mutual follows', async () => {
    postLikes = [{ user_id: FOLLOWER_ID, post_id: POST_ID, created_at: '2025-01-02T00:00:00Z' }];
    userFollows = [
      { follower_id: VIEWER_ID, following_id: FOLLOWER_ID },
      { follower_id: FOLLOWER_ID, following_id: VIEWER_ID },
    ];
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const user = data.users.find((u: any) => u.id === FOLLOWER_ID);
    assert.ok(user, 'mutual-follow user must appear');
    assert.equal(user.isFollowing, true);
    assert.equal(user.followsYou, true);
  });

  it('both flags false when no follow relationship exists', async () => {
    const { data } = await get(
      url({ targetType: 'post_like', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    const user = data.users.find((u: any) => u.id === LIKER1_ID);
    assert.ok(user, 'liker1 must appear');
    assert.equal(user.isFollowing, false);
    assert.equal(user.followsYou, false);
  });
});

describe('GET /api/engagement/likes — post_reaction targetType', () => {
  it('returns only users who reacted (no reactionType filter)', async () => {
    const { status, data } = await get(
      url({ targetType: 'post_reaction', targetId: POST_ID }),
      TOKEN_VIEWER,
    );
    assert.equal(status, 200, JSON.stringify(data));
    const ids = data.users.map((u: any) => u.id);
    assert.ok(ids.includes(LIKER1_ID), 'LIKER1 reacted — must appear');
  });

  it('filters by reactionType when provided', async () => {
    postReactions.push({ user_id: LIKER2_ID, post_id: POST_ID, emoji: '😂', created_at: '2025-01-03T00:00:00Z' });
    _setTestClient(buildFakeClient() as any, true);

    const { data } = await get(
      url({ targetType: 'post_reaction', targetId: POST_ID, reactionType: '❤️' }),
      TOKEN_VIEWER,
    );
    const ids = data.users.map((u: any) => u.id);
    assert.ok(ids.includes(LIKER1_ID), 'LIKER1 reacted with ❤️ — must appear');
    assert.ok(!ids.includes(LIKER2_ID), 'LIKER2 reacted with 😂 — must be excluded');
  });
});
