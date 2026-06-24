/**
 * Hashtags routes tests
 *
 * Covers:
 *  - GET  /api/hashtags/suggestions
 *  - GET  /api/hashtags/trending
 *  - GET  /api/hashtags/:slug
 *  - POST /api/hashtags/:slug/follow
 *  - DELETE /api/hashtags/:slug/follow
 *  - GET  /api/me/hashtag-follows
 *  - POST /api/admin/hashtags/:slug/block
 *  - POST /api/admin/hashtags/:slug/unblock
 *  - GET  /api/admin/hashtags
 *
 * Uses node:test + fake-client pattern (no real DB, no vitest).
 * Run: node --import tsx/esm --test src/test/hashtags.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { _setTestClient } from '../lib/http.js';
import { _setTestServiceClient } from '../lib/supabase.js';
import hashtagsRouter from '../routes/hashtags.js';

// ── IDs ───────────────────────────────────────────────────────────────────────

const FAKE_TOKEN = 'fake.jwt.token';
const USER_ID    = '00000000-0000-0000-0000-000000000001';
const HT_ID      = '00000000-0000-0000-0000-000000000010';
const HT_ID2     = '00000000-0000-0000-0000-000000000011';

// ── HTTP helper ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function makeReq(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${FAKE_TOKEN}`,
      ...headers,
    };
    if (payload) reqHeaders['content-length'] = String(Buffer.byteLength(payload));
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers: reqHeaders },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client builder ───────────────────────────────────────────────────────

interface FakeDb {
  hashtags?: any[];
  hashtag_usage?: any[];
  user_hashtag_follows?: any[];
  profiles?: any[];
  posts?: any[];
}

function makeFakeClient(db: FakeDb, userRole?: string) {
  const store: Record<string, any[]> = {
    hashtags:             db.hashtags ?? [],
    hashtag_usage:        db.hashtag_usage ?? [],
    user_hashtag_follows: db.user_hashtag_follows ?? [],
    profiles:             db.profiles ?? [{ id: USER_ID, handle: 'testuser', role: userRole ?? 'user' }],
    posts:                db.posts ?? [],
  };

  function makeBuilder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _insert: any = null;
    let _upsert: any = null;
    let _update: any = null;
    let _doDelete = false;
    let _countExact = false;

    const builder: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count === 'exact') _countExact = true;
        return builder;
      },
      insert(row: any)            { _insert = row; return builder; },
      upsert(row: any, _opts?: any){ _upsert = row; return builder; },
      update(patch: any)          { _update = patch; return builder; },
      delete()                    { _doDelete = true; return builder; },
      eq(col: string, val: any)   { filters.push((r) => r[col] === val); return builder; },
      neq(col: string, val: any)  { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[]){ filters.push((r) => vals.includes(r[col])); return builder; },
      ilike(col: string, pat: string) {
        const prefix = pat.replace('%', '').toLowerCase();
        filters.push((r) => String(r[col] ?? '').toLowerCase().startsWith(prefix));
        return builder;
      },
      gte(col: string, val: any)  { filters.push((r) => r[col] >= val); return builder; },
      lt(col: string, val: any)   { filters.push((r) => r[col] < val); return builder; },
      order()  { return builder; },
      limit()  { return builder; },
      range()  { return builder; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() {
        if (_upsert) return Promise.resolve({ data: { ...(rows()[0] ?? {}), ..._upsert }, error: null });
        if (_update) return Promise.resolve({ data: { ...(rows()[0] ?? {}), ..._update }, error: null });
        if (_insert) return Promise.resolve({ data: { id: HT_ID, ..._insert }, error: null });
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        let result: any;
        if (_doDelete) {
          result = { data: null, error: null };
        } else if (_upsert || _update || _insert) {
          result = { data: _upsert ?? _update ?? _insert, error: null };
        } else if (_countExact) {
          const matched = rows();
          result = { data: matched, error: null, count: matched.length };
        } else {
          result = { data: rows(), error: null };
        }
        return Promise.resolve(result).then(onF, onR);
      },
    };

    function rows() {
      const src = store[table] ?? [];
      return src.filter((r) => filters.every((f) => f(r)));
    }

    return builder;
  }

  return {
    from: makeBuilder,
    auth: {
      getUser: async (token: string) => {
        if (token !== FAKE_TOKEN) return { data: { user: null }, error: { message: 'invalid' } };
        return { data: { user: { id: USER_ID } }, error: null };
      },
    },
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use(hashtagsRouter);

  server = http.createServer(app);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  _setTestClient(null, false);
  _setTestServiceClient(null);
  await new Promise<void>((res) => server.close(() => res()));
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /hashtags/suggestions', () => {
  it('returns 400 if q is missing', async () => {
    const client = makeFakeClient({});
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    const r = await makeReq('GET', '/hashtags/suggestions');
    assert.equal(r.status, 400);
  });

  it('returns matching hashtags by prefix', async () => {
    const hashtags = [
      { id: HT_ID,  slug: 'travel', name: 'travel', usage_count: 50, is_blocked: false },
      { id: HT_ID2, slug: 'traveler', name: 'traveler', usage_count: 20, is_blocked: false },
      { id: '00000000-0000-0000-0000-000000000012', slug: 'food', name: 'food', usage_count: 5, is_blocked: false },
    ];
    const client = makeFakeClient({ hashtags });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/hashtags/suggestions?q=travel');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.suggestions));
    const slugs = r.body.suggestions.map((s: any) => s.slug);
    assert.ok(slugs.includes('travel'));
    assert.ok(slugs.includes('traveler'));
    assert.ok(!slugs.includes('food'));
  });

  it('strips leading # from q', async () => {
    const hashtags = [{ id: HT_ID, slug: 'wanderlust', name: 'wanderlust', usage_count: 10, is_blocked: false }];
    const client = makeFakeClient({ hashtags });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/hashtags/suggestions?q=%23wander');
    assert.equal(r.status, 200);
    const slugs = r.body.suggestions.map((s: any) => s.slug);
    assert.ok(slugs.includes('wanderlust'));
  });
});

describe('GET /hashtags/trending', () => {
  it('returns trending list', async () => {
    const now = new Date().toISOString();
    const hashtags = [
      { id: HT_ID,  slug: 'travel', name: 'travel', usage_count: 100, is_blocked: false, is_hidden_from_trending: false },
    ];
    const hashtag_usage = [
      { hashtag_id: HT_ID, source_type: 'post', source_id: 'p1', author_id: USER_ID, created_at: now },
      { hashtag_id: HT_ID, source_type: 'post', source_id: 'p2', author_id: USER_ID, created_at: now },
    ];
    const client = makeFakeClient({ hashtags, hashtag_usage });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/hashtags/trending');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.trending));
    assert.ok(r.body.trending.length >= 1);
    assert.equal(r.body.trending[0].slug, 'travel');
  });
});

describe('GET /hashtags/:slug', () => {
  it('returns 404 for unknown slug', async () => {
    const client = makeFakeClient({ hashtags: [] });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/hashtags/doesnotexist');
    assert.equal(r.status, 404);
  });

  it('returns 404 for blocked hashtag', async () => {
    const hashtags = [{ id: HT_ID, slug: 'blocked', name: 'blocked', usage_count: 0, is_blocked: true }];
    const client = makeFakeClient({ hashtags });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/hashtags/blocked');
    assert.equal(r.status, 404);
  });

  it('returns hashtag metadata and follow status', async () => {
    const hashtags = [
      { id: HT_ID, slug: 'travel', name: 'travel', usage_count: 42, is_blocked: false, created_at: new Date().toISOString() },
    ];
    const client = makeFakeClient({ hashtags, user_hashtag_follows: [] });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/hashtags/travel');
    assert.equal(r.status, 200);
    assert.equal(r.body.slug, 'travel');
    assert.equal(r.body.usageCount, 42);
    assert.equal(r.body.isFollowing, false);
  });
});

describe('POST /hashtags/:slug/follow', () => {
  it('returns 404 for blocked hashtag', async () => {
    const hashtags = [{ id: HT_ID, slug: 'spam', name: 'spam', is_blocked: true }];
    const client = makeFakeClient({ hashtags });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('POST', '/hashtags/spam/follow');
    assert.equal(r.status, 404);
  });

  it('follows a valid hashtag', async () => {
    const hashtags = [{ id: HT_ID, slug: 'travel', name: 'travel', is_blocked: false }];
    const client = makeFakeClient({ hashtags });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('POST', '/hashtags/travel/follow');
    assert.equal(r.status, 200);
    assert.equal(r.body.following, true);
  });
});

describe('DELETE /hashtags/:slug/follow', () => {
  it('unfollows a hashtag', async () => {
    const hashtags = [{ id: HT_ID, slug: 'travel', name: 'travel' }];
    const follows = [{ user_id: USER_ID, hashtag_id: HT_ID }];
    const client = makeFakeClient({ hashtags, user_hashtag_follows: follows });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('DELETE', '/hashtags/travel/follow');
    assert.equal(r.status, 200);
    assert.equal(r.body.following, false);
  });
});

describe('GET /me/hashtag-follows', () => {
  it('returns list of followed hashtags', async () => {
    const hashtags = [{ id: HT_ID, slug: 'travel', name: 'travel', usage_count: 10 }];
    const follows = [{
      user_id: USER_ID,
      hashtag_id: HT_ID,
      created_at: new Date().toISOString(),
      hashtags: hashtags[0],
    }];
    const client = makeFakeClient({ hashtags, user_hashtag_follows: follows });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/me/hashtag-follows');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.follows));
  });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

describe('POST /admin/hashtags/:slug/block', () => {
  it('returns 403 for non-admin user', async () => {
    const client = makeFakeClient({}, 'user');
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('POST', '/admin/hashtags/travel/block', { reason: 'spam' });
    assert.equal(r.status, 403);
  });

  it('blocks a hashtag as admin', async () => {
    const hashtags = [{ id: HT_ID, slug: 'travel', name: 'travel', is_blocked: false }];
    const adminProfiles = [{ id: USER_ID, handle: 'admin', role: 'admin' }];
    const client = makeFakeClient({ hashtags, profiles: adminProfiles }, 'admin');
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('POST', '/admin/hashtags/travel/block', { reason: 'test block' });
    assert.equal(r.status, 200);
    assert.equal(r.body.blocked, true);
    assert.equal(r.body.slug, 'travel');
  });
});

describe('POST /admin/hashtags/:slug/unblock', () => {
  it('unblocks a hashtag as admin', async () => {
    const hashtags = [{ id: HT_ID, slug: 'travel', name: 'travel', is_blocked: true }];
    const adminProfiles = [{ id: USER_ID, handle: 'admin', role: 'admin' }];
    const client = makeFakeClient({ hashtags, profiles: adminProfiles }, 'admin');
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('POST', '/admin/hashtags/travel/unblock');
    assert.equal(r.status, 200);
    assert.equal(r.body.blocked, false);
  });
});

describe('GET /admin/hashtags', () => {
  it('returns paginated hashtag list for admin', async () => {
    const hashtags = [
      { id: HT_ID,  slug: 'travel',    name: 'travel',    usage_count: 50, is_blocked: false, is_hidden_from_trending: false, blocked_at: null, blocked_reason: null, created_at: new Date().toISOString() },
      { id: HT_ID2, slug: 'wanderlust', name: 'wanderlust', usage_count: 30, is_blocked: false, is_hidden_from_trending: false, blocked_at: null, blocked_reason: null, created_at: new Date().toISOString() },
    ];
    const adminProfiles = [{ id: USER_ID, handle: 'admin', role: 'admin' }];
    const client = makeFakeClient({ hashtags, profiles: adminProfiles }, 'admin');
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/admin/hashtags');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.hashtags));
    assert.ok(r.body.hashtags.length >= 1);
  });
});
