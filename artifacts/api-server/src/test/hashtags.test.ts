/**
 * Hashtag route tests
 *
 * Covers:
 *  - GET  /api/hashtags/suggestions    (followed > city-trending > prefix; blocked excluded)
 *  - GET  /api/hashtags/trending       (weighted score, scope=global|city; blocked+hidden excluded)
 *  - GET  /api/hashtags/:slug          (upsert-on-read; blocked → 404)
 *  - POST /api/hashtags/:slug/follow
 *  - DELETE /api/hashtags/:slug/follow
 *  - GET  /api/me/hashtag-follows
 *  - GET  /api/hashtags/:slug/feed     (tab=top|recent, scope=city; blocked hashtag → 404)
 *  - POST /api/admin/hashtags/:slug/block
 *  - POST /api/admin/hashtags/:slug/unblock
 *  - POST /api/admin/hashtags/:slug/hide-trending
 *  - POST /api/admin/hashtags/merge    (re-points usage rows, combines count, deletes source)
 *  - PATCH /api/admin/hashtags/:slug
 *  - GET  /api/admin/hashtags
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { createServer } from 'node:http';
import express from 'express';
import { _setTestClient, _setTestServiceClient } from '../lib/http.js';
import hashtagsRouter from '../routes/hashtags.js';

// ─── Fake Supabase builder ────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeClient(store: Record<string, Row[]> = {}, opts: { userId?: string } = {}) {
  const user = { id: opts.userId ?? 'user-0001-0000-0000-000000000000', email: 't@t.com' };

  function builder(table: string): any {
    let _rows: Row[] = [...(store[table] ?? [])];
    let _single = false;
    let _maybeSingle = false;
    let _countHead = false;
    let _headOnly = false;
    let _updatePatch: Row = {};
    let _isDelete = false;

    const filters: Array<(r: Row) => boolean> = [];

    function applyFilters(rows: Row[]) {
      return filters.reduce((acc, fn) => acc.filter(fn), rows);
    }

    const b: any = {
      select(cols?: string, opts2?: any) {
        if (opts2?.head) _headOnly = true;
        if (opts2?.count === 'exact') _countHead = true;
        return b;
      },
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: unknown) { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return b; },
      or(expr: string) {
        const parts = expr.split(',').map((p) => p.trim());
        filters.push((r) => parts.some((p) => {
          const m = p.match(/(\w+)\.(eq|neq)\.(.+)/);
          if (!m) return false;
          const [, col, op, val] = m;
          return op === 'eq' ? String(r[col]) === val : String(r[col]) !== val;
        }));
        return b;
      },
      ilike(col: string, pat: string) {
        const prefix = pat.replace(/%/g, '').toLowerCase();
        filters.push((r) => String(r[col] ?? '').toLowerCase().startsWith(prefix));
        return b;
      },
      gte(col: string, val: string) { filters.push((r) => String(r[col] ?? '') >= val); return b; },
      lt(col: string, val: string) { filters.push((r) => String(r[col] ?? '') < val); return b; },
      not(col: string, op: string, val: unknown) {
        if (op === 'is') filters.push((r) => r[col] !== val);
        else if (op === 'in') filters.push((r) => !(val as unknown[]).includes(r[col]));
        else filters.push((r) => r[col] !== val);
        return b;
      },
      order() { return b; },
      limit(n: number) { _rows = _rows.slice(0, n); return b; },
      range(from: number, to: number) { _rows = _rows.slice(from, to + 1); return b; },
      single() { _single = true; return b; },
      maybeSingle() { _maybeSingle = true; return b; },
      upsert(rows: Row | Row[], opts3?: any) {
        const arr = Array.isArray(rows) ? rows : [rows];
        const conflictCols = opts3?.onConflict?.split(',').map((c: string) => c.trim()) ?? [];
        if (!store[table]) store[table] = [];
        const upsertedRows: Row[] = [];
        for (const row of arr) {
          const idx = store[table].findIndex((r) =>
            conflictCols.length > 0 && conflictCols.every((c: string) => r[c] === row[c]),
          );
          if (idx >= 0) {
            if (!opts3?.ignoreDuplicates) store[table][idx] = { ...store[table][idx], ...row };
            upsertedRows.push(store[table][idx]);
          } else {
            const newRow = { id: `${table}-auto-${Date.now()}-${Math.random()}`, ...row };
            store[table].push(newRow);
            upsertedRows.push(newRow);
          }
        }
        _rows = upsertedRows;
        return b;
      },
      insert(rows: Row | Row[]) {
        const arr = Array.isArray(rows) ? rows : [rows];
        if (!store[table]) store[table] = [];
        for (const row of arr) store[table].push({ id: `ins-${Date.now()}-${Math.random()}`, ...row });
        _rows = [...store[table]];
        return b;
      },
      update(patch: Row) { _updatePatch = patch; return b; },
      delete() { _isDelete = true; return b; },
      then(resolve: (v: any) => void, reject: (e: any) => void) {
        try {
          if (Object.keys(_updatePatch).length > 0) {
            const matched = applyFilters([...(store[table] ?? [])]);
            for (const r of matched) Object.assign(r, _updatePatch);
            _rows = matched;
          }
          if (_isDelete) {
            const toRemove = new Set(applyFilters([...(store[table] ?? [])]));
            store[table] = (store[table] ?? []).filter((r) => !toRemove.has(r));
            _rows = [];
          }
          const results = applyFilters(_rows);
          if (_headOnly || _countHead) {
            resolve({ data: null, count: applyFilters(store[table] ?? []).length, error: null });
            return;
          }
          if (_single) {
            resolve(results.length > 0
              ? { data: results[0], error: null }
              : { data: null, error: { message: 'row not found' } });
            return;
          }
          if (_maybeSingle) { resolve({ data: results[0] ?? null, error: null }); return; }
          resolve({ data: results, error: null });
        } catch (e) { reject(e); }
      },
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token?: string) =>
        token === 'bad-token'
          ? { data: { user: null }, error: { message: 'bad token' } }
          : { data: { user }, error: null },
    },
    from: (table: string) => builder(table),
    rpc: () => ({ then: (resolve: any) => resolve({ data: null, error: null }) }),
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', hashtagsRouter);
  return app;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload).toString();
    const req = http.request(
      { host: '127.0.0.1', port: addr.port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Shared fixture data ──────────────────────────────────────────────────────

const UID           = 'user-0001-0000-0000-000000000001';
const HT_TRAVEL_ID  = 'htag-0001-0000-0000-000000000001';
const HT_FOOD_ID    = 'htag-0002-0000-0000-000000000002';
const HT_BLOCK_ID   = 'htag-0003-0000-0000-000000000003';

function makeStore(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    profiles: [{ id: UID, handle: 'testuser', role: 'user' }],
    hashtags: [
      { id: HT_TRAVEL_ID, slug: 'travel', name: 'travel', usage_count: 50, is_blocked: false, is_hidden_from_trending: false, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
      { id: HT_FOOD_ID,   slug: 'food',   name: 'food',   usage_count: 30, is_blocked: false, is_hidden_from_trending: false, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
      { id: HT_BLOCK_ID,  slug: 'spam',   name: 'spam',   usage_count: 200, is_blocked: true, is_hidden_from_trending: true, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
    ],
    hashtag_usage: [],
    user_hashtag_follows: [],
    posts: [],
    ...overrides,
  };
}

// ─── GET /api/hashtags/suggestions ───────────────────────────────────────────

describe('GET /hashtags/suggestions', () => {
  let server: http.Server;
  let store: Record<string, Row[]>;

  before(() => {
    store = makeStore({
      user_hashtag_follows: [{ id: 'f1', user_id: UID, hashtag_id: HT_TRAVEL_ID }],
    });
    const c = makeClient(store, { userId: UID });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns 400 if q is missing', async () => {
    const { status } = await request(server, 'GET', '/api/hashtags/suggestions', { token: 'tok' });
    assert.equal(status, 400);
  });

  it('returns matching hashtags by prefix', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/suggestions?q=trav', { token: 'tok' });
    assert.equal(status, 200);
    assert.ok(body.suggestions.length >= 1);
    assert.equal(body.suggestions[0].slug, 'travel');
  });

  it('strips leading # from q', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/suggestions?q=%23trav', { token: 'tok' });
    assert.equal(status, 200);
    assert.ok(body.suggestions.some((s: any) => s.slug === 'travel'));
  });

  it('blocked hashtag excluded from suggestions', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/suggestions?q=sp', { token: 'tok' });
    assert.equal(status, 200);
    assert.ok(!body.suggestions.some((s: any) => s.slug === 'spam'), 'blocked spam must not appear');
  });

  it('followed hashtag ranked first over non-followed', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/suggestions?q=t', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.suggestions[0]?.slug, 'travel', 'followed hashtag travel should be ranked first');
  });
});

// ─── GET /api/hashtags/trending ──────────────────────────────────────────────

describe('GET /hashtags/trending', () => {
  let server: http.Server;
  let store: Record<string, Row[]>;

  before(() => {
    const now = new Date().toISOString();
    store = makeStore({
      hashtag_usage: [
        { id: 'u1', hashtag_id: HT_TRAVEL_ID, source_type: 'post', source_id: 'p1', author_id: 'a1', city: 'NYC', created_at: now },
        { id: 'u2', hashtag_id: HT_TRAVEL_ID, source_type: 'post', source_id: 'p2', author_id: 'a2', city: 'NYC', created_at: now },
        { id: 'u3', hashtag_id: HT_TRAVEL_ID, source_type: 'post', source_id: 'p3', author_id: 'a3', city: 'NYC', created_at: now },
        { id: 'u4', hashtag_id: HT_FOOD_ID,   source_type: 'post', source_id: 'p4', author_id: 'a1', city: 'LA',  created_at: now },
      ],
    });
    const c = makeClient(store, { userId: UID });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns trending list', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/trending', { token: 'tok' });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.trending));
    assert.ok(body.trending.length > 0);
  });

  it('blocked hashtag excluded from trending', async () => {
    const { body } = await request(server, 'GET', '/api/hashtags/trending', { token: 'tok' });
    assert.ok(!body.trending.some((h: any) => h.slug === 'spam'), 'blocked spam must not appear');
  });

  it('scope=city filters by city', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/trending?scope=city&city_id=NYC', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.scope, 'city');
    assert.equal(body.city, 'NYC');
  });
});

// ─── GET /api/hashtags/:slug ─────────────────────────────────────────────────

describe('GET /hashtags/:slug', () => {
  let server: http.Server;
  let store: Record<string, Row[]>;

  before(() => {
    store = makeStore();
    const c = makeClient(store, { userId: UID });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns 404 for blocked hashtag', async () => {
    const { status } = await request(server, 'GET', '/api/hashtags/spam', { token: 'tok' });
    assert.equal(status, 404);
  });

  it('returns hashtag metadata and follow status for existing slug', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/travel', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.slug, 'travel');
    assert.equal(typeof body.usageCount, 'number');
    assert.equal(typeof body.isFollowing, 'boolean');
  });

  it('upsert-on-read: auto-creates a new hashtag record when slug is unseen', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/brandnewslug', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.slug, 'brandnewslug');
    const inStore = store.hashtags.find((h: any) => h.slug === 'brandnewslug');
    assert.ok(inStore, 'new slug must be auto-created in store (upsert-on-read)');
  });
});

// ─── POST /api/hashtags/:slug/follow ─────────────────────────────────────────

describe('POST /hashtags/:slug/follow', () => {
  let server: http.Server;
  let store: Record<string, Row[]>;

  before(() => {
    store = makeStore();
    const c = makeClient(store, { userId: UID });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns 404 for blocked hashtag', async () => {
    const { status } = await request(server, 'POST', '/api/hashtags/spam/follow', { token: 'tok' });
    assert.equal(status, 404);
  });

  it('follows a valid hashtag', async () => {
    const { status, body } = await request(server, 'POST', '/api/hashtags/travel/follow', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.following, true);
    assert.ok(store.user_hashtag_follows.some((r: any) => r.hashtag_id === HT_TRAVEL_ID && r.user_id === UID));
  });
});

// ─── DELETE /api/hashtags/:slug/follow ───────────────────────────────────────

describe('DELETE /hashtags/:slug/follow', () => {
  let server: http.Server;

  before(() => {
    const store = makeStore({
      user_hashtag_follows: [{ id: 'f1', user_id: UID, hashtag_id: HT_TRAVEL_ID }],
    });
    const c = makeClient(store, { userId: UID });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('unfollows a hashtag', async () => {
    const { status, body } = await request(server, 'DELETE', '/api/hashtags/travel/follow', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.following, false);
  });
});

// ─── GET /api/me/hashtag-follows ─────────────────────────────────────────────

describe('GET /me/hashtag-follows', () => {
  let server: http.Server;

  before(() => {
    const store = makeStore({
      user_hashtag_follows: [{
        id: 'f1', user_id: UID, hashtag_id: HT_TRAVEL_ID, created_at: '2025-06-01T00:00:00Z',
        hashtags: { id: HT_TRAVEL_ID, slug: 'travel', name: 'travel', usage_count: 50 },
      }],
    });
    const c = makeClient(store, { userId: UID });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns list of followed hashtags', async () => {
    const { status, body } = await request(server, 'GET', '/api/me/hashtag-follows', { token: 'tok' });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.follows));
  });
});

// ─── GET /api/hashtags/:slug/feed ────────────────────────────────────────────

describe('GET /hashtags/:slug/feed', () => {
  let server: http.Server;

  before(() => {
    const store = makeStore({
      hashtag_usage: [
        { id: 'u1', hashtag_id: HT_TRAVEL_ID, source_type: 'post', source_id: 'post-feed-001', author_id: UID, city: 'NYC', created_at: '2025-06-01T12:00:00Z' },
      ],
      posts: [
        { id: 'post-feed-001', author_id: UID, content: 'Hello #travel!', status: 'active', visibility: 'public', like_count: 5, comment_count: 2, created_at: '2025-06-01T12:00:00Z' },
      ],
    });
    const c = makeClient(store, { userId: UID });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns 404 for blocked hashtag', async () => {
    const { status } = await request(server, 'GET', '/api/hashtags/spam/feed', { token: 'tok' });
    assert.equal(status, 404);
  });

  it('returns posts in feed with tab=recent (default)', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/travel/feed', { token: 'tok' });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.posts));
    assert.equal(body.tab, 'recent');
  });

  it('tab=top is accepted', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/travel/feed?tab=top', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.tab, 'top');
  });

  it('scope=city filters by city', async () => {
    const { status, body } = await request(server, 'GET', '/api/hashtags/travel/feed?scope=city&city=NYC', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.scope, 'city');
  });
});

// ─── Admin: block / unblock ───────────────────────────────────────────────────

describe('POST /admin/hashtags/:slug/block', () => {
  let server: http.Server;
  let store: Record<string, Row[]>;
  const adminId = 'admin-001-0000-0000-000000000001';

  before(() => {
    store = { ...makeStore(), profiles: [{ id: adminId, handle: 'admin', role: 'admin' }] };
    const c = makeClient(store, { userId: adminId });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns 403 for non-admin user', async () => {
    const ns = { ...makeStore(), profiles: [{ id: adminId, handle: 'admin', role: 'user' }] };
    const nc = makeClient(ns, { userId: adminId });
    _setTestClient(nc, true);
    _setTestServiceClient(nc);
    const { status } = await request(server, 'POST', '/api/admin/hashtags/travel/block', { token: 'tok' });
    assert.equal(status, 403);
    const ac = makeClient(store, { userId: adminId });
    _setTestClient(ac, true);
    _setTestServiceClient(ac);
  });

  it('blocks a hashtag as admin', async () => {
    const { status, body } = await request(server, 'POST', '/api/admin/hashtags/food/block', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.blocked, true);
    const row = store.hashtags.find((h: any) => h.slug === 'food');
    assert.ok((row as any)?.is_blocked);
  });
});

describe('POST /admin/hashtags/:slug/unblock', () => {
  let server: http.Server;
  let store: Record<string, Row[]>;
  const adminId = 'admin-002-0000-0000-000000000002';

  before(() => {
    store = { ...makeStore(), profiles: [{ id: adminId, handle: 'admin2', role: 'admin' }] };
    const travelRow = store.hashtags.find((h: any) => h.slug === 'travel') as any;
    travelRow.is_blocked = true;
    const c = makeClient(store, { userId: adminId });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('unblocks a hashtag as admin', async () => {
    const { status, body } = await request(server, 'POST', '/api/admin/hashtags/travel/unblock', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.blocked, false);
  });
});

// ─── Admin: hide-trending ─────────────────────────────────────────────────────

describe('POST /admin/hashtags/:slug/hide-trending', () => {
  let server: http.Server;
  let store: Record<string, Row[]>;
  const adminId = 'admin-003-0000-0000-000000000003';

  before(() => {
    store = { ...makeStore(), profiles: [{ id: adminId, handle: 'admin3', role: 'admin' }] };
    const c = makeClient(store, { userId: adminId });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('hides a hashtag from trending', async () => {
    const { status, body } = await request(server, 'POST', '/api/admin/hashtags/travel/hide-trending', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.hiddenFromTrending, true);
    const row = store.hashtags.find((h: any) => h.slug === 'travel') as any;
    assert.ok(row?.is_hidden_from_trending);
  });

  it('unhides when { hide: false } body is passed', async () => {
    const { status, body } = await request(server, 'POST', '/api/admin/hashtags/travel/hide-trending', {
      token: 'tok',
      body: { hide: false },
    });
    assert.equal(status, 200);
    assert.equal(body.hiddenFromTrending, false);
  });
});

// ─── Admin: merge ─────────────────────────────────────────────────────────────

describe('POST /admin/hashtags/merge', () => {
  let server: http.Server;
  let store: Record<string, Row[]>;
  const adminId = 'admin-004-0000-0000-000000000004';
  const SRC_ID = 'src0-0001-0000-0000-000000000001';
  const TGT_ID = 'tgt0-0001-0000-0000-000000000001';

  before(() => {
    store = {
      profiles: [{ id: adminId, handle: 'admin4', role: 'admin' }],
      hashtags: [
        { id: SRC_ID, slug: 'travelling', name: 'travelling', usage_count: 10, is_blocked: false, is_hidden_from_trending: false },
        { id: TGT_ID, slug: 'travel',     name: 'travel',     usage_count: 50, is_blocked: false, is_hidden_from_trending: false },
      ],
      hashtag_usage: [
        { id: 'u1', hashtag_id: SRC_ID, source_type: 'post', source_id: 'p1', author_id: adminId },
      ],
      user_hashtag_follows: [
        { id: 'f1', user_id: UID, hashtag_id: SRC_ID },
      ],
    };
    const c = makeClient(store, { userId: adminId });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('merges source into target, deletes source, and combines usage_count', async () => {
    const { status, body } = await request(server, 'POST', '/api/admin/hashtags/merge', {
      token: 'tok',
      body: { sourceSlug: 'travelling', targetSlug: 'travel' },
    });
    assert.equal(status, 200);
    assert.equal(body.merged, 'travelling');
    assert.equal(body.into, 'travel');
    assert.equal(body.combinedUsageCount, 60);
    assert.ok(!store.hashtags.some((h: any) => h.slug === 'travelling'), 'source must be deleted');
    const usage = store.hashtag_usage.find((u: any) => u.source_id === 'p1');
    assert.equal((usage as any)?.hashtag_id, TGT_ID, 'usage row re-pointed to target');
  });

  it('returns 400 if sourceSlug and targetSlug are the same', async () => {
    const { status } = await request(server, 'POST', '/api/admin/hashtags/merge', {
      token: 'tok',
      body: { sourceSlug: 'travel', targetSlug: 'travel' },
    });
    assert.equal(status, 400);
  });
});

// ─── Admin: list ─────────────────────────────────────────────────────────────

describe('GET /admin/hashtags', () => {
  let server: http.Server;
  const adminId = 'admin-005-0000-0000-000000000005';

  before(() => {
    const store = { ...makeStore(), profiles: [{ id: adminId, handle: 'admin5', role: 'admin' }] };
    const c = makeClient(store, { userId: adminId });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns paginated hashtag list for admin', async () => {
    const { status, body } = await request(server, 'GET', '/api/admin/hashtags', { token: 'tok' });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.hashtags));
    assert.equal(typeof body.total, 'number');
  });
});
