/**
 * Tagging tests
 *
 * Covers:
 *  - extractMentionHandles / extractHashtagSlugs pure functions
 *  - duplicate-casing → single canonical slug
 *  - GET /api/tags/suggestions (block-list exclusion, nobody exclusion, ranking)
 *  - GET /api/me/tag-permission / PATCH /api/me/tag-permission
 *  - DELETE /api/admin/tags/:id
 *  - processTagging enforcement:
 *      • tag row written on post create
 *      • tag_permission=nobody → skipped, no notification
 *      • friends_only → blocks when not mutual, allows when mutual
 *      • per-item cap (MAX_MENTIONS = 5)
 *      • per-hour rate-limit blocks excess
 *      • dedup: upsert produces exactly one row per (source, tagged_user)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { createServer } from 'node:http';
import express from 'express';
import { _setTestClient, _setTestServiceClient } from '../lib/http.js';
import tagsRouter from '../routes/tags.js';

// ─── Fake Supabase builder ────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeClient(store: Record<string, Row[]> = {}, opts: { userId?: string } = {}) {
  const user = { id: opts.userId ?? 'user-aaaa-0001-0000-000000000000', email: 'test@example.com' };

  function builder(table: string): any {
    let _rows: Row[] = [...(store[table] ?? [])];
    let _single = false;
    let _maybeSingle = false;
    let _countHead = false;
    let _headOnly = false;
    let _updatePatch: Row = {};
    let _isDelete = false;

    const filters: Array<(r: Row) => boolean> = [];

    function applyFilters(rows: Row[]): Row[] {
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
          // handle ilike with wildcards: col.ilike.pat%  or  col.ilike.%pat%
          const ilikeM = p.match(/^(\w+)\.ilike\.(.+)$/);
          if (ilikeM) {
            const [, col, pat] = ilikeM;
            const val = String(r[col] ?? '').toLowerCase();
            const norm = pat.toLowerCase();
            if (norm.startsWith('%') && norm.endsWith('%')) return val.includes(norm.slice(1, -1));
            if (norm.startsWith('%')) return val.endsWith(norm.slice(1));
            if (norm.endsWith('%')) return val.startsWith(norm.slice(0, -1));
            return val === norm;
          }
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
      is(col: string, val: unknown) { filters.push((r) => (r[col] ?? null) === val); return b; },
      gte(col: string, val: string) { filters.push((r) => String(r[col] ?? '') >= val); return b; },
      lt(col: string, val: string) { filters.push((r) => String(r[col] ?? '') < val); return b; },
      order() { return b; },
      limit(n: number) { _rows = _rows.slice(0, n); return b; },
      range() { return b; },
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
  app.use('/api', tagsRouter);
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

// ─── Pure function tests ──────────────────────────────────────────────────────

import { extractMentionHandles, extractHashtagSlugs } from '../services/tagging/TaggingService.js';

describe('extractMentionHandles', () => {
  it('extracts lowercase unique handles', () => {
    const result = extractMentionHandles('Hello @Alice and @BOB and @alice again');
    assert.deepEqual(result, ['alice', 'bob']);
  });

  it('returns empty for no mentions', () => {
    assert.deepEqual(extractMentionHandles('no mentions here'), []);
  });

  it('ignores handles longer than 64 chars', () => {
    const long = 'a'.repeat(65);
    assert.deepEqual(extractMentionHandles(`@${long}`), []);
  });
});

describe('extractHashtagSlugs', () => {
  it('extracts lowercase unique slugs', () => {
    const result = extractHashtagSlugs('Check out #Travel and #TRAVEL and #food');
    assert.deepEqual(result, ['travel', 'food']);
  });

  it('strips leading # and normalizes to lowercase', () => {
    assert.deepEqual(extractHashtagSlugs('#Summer2025'), ['summer2025']);
  });

  it('ignores single-char hashtags (min length 2)', () => {
    assert.deepEqual(extractHashtagSlugs('#a #go #hi'), ['go', 'hi']);
  });

  it('returns empty for no hashtags', () => {
    assert.deepEqual(extractHashtagSlugs('no hashtags here'), []);
  });

  it('duplicate-casing maps to one canonical slug', () => {
    const result = extractHashtagSlugs('#Travel #TRAVEL #travel');
    assert.equal(result.length, 1);
    assert.equal(result[0], 'travel');
  });
});

// ─── GET /api/tags/suggestions ───────────────────────────────────────────────

describe('GET /tags/suggestions', () => {
  let server: http.Server;
  let userId: string;
  let store: Record<string, Row[]>;

  before(() => {
    userId = 'aaaa0001-0000-0000-0000-000000000001';
    store = {
      profiles: [
        { id: 'bbbb0001-0000-0000-0000-000000000001', handle: 'alice', name: 'Alice', tag_permission: 'anyone', role: 'user' },
        { id: 'bbbb0002-0000-0000-0000-000000000002', handle: 'bob', name: 'Bob', tag_permission: 'anyone', role: 'user' },
        { id: 'bbbb0003-0000-0000-0000-000000000003', handle: 'carol', name: 'Carol', tag_permission: 'nobody', role: 'user' },
        { id: userId, handle: 'me', name: 'Me', tag_permission: 'anyone', role: 'user' },
      ],
      blocks: [],
      user_follows: [],
    };
    const client = makeClient(store, { userId });
    _setTestClient(client, true);
    _setTestServiceClient(client);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns 401 without auth token', async () => {
    const { status } = await request(server, 'GET', '/api/tags/suggestions?q=ali');
    assert.equal(status, 401);
  });

  it('returns 400 if q is missing', async () => {
    const { status } = await request(server, 'GET', '/api/tags/suggestions', { token: 'tok' });
    assert.equal(status, 400);
  });

  it('excludes profiles with tag_permission=nobody (private profile)', async () => {
    const { status, body } = await request(server, 'GET', '/api/tags/suggestions?q=car', { token: 'tok' });
    assert.equal(status, 200);
    const handles = body.suggestions.map((s: any) => s.handle);
    assert.ok(!handles.includes('carol'), 'carol (nobody) must be excluded');
  });

  it('excludes blocked users from suggestions', async () => {
    store.blocks.push({ id: 'blk-001', blocker_id: userId, blocked_id: 'bbbb0001-0000-0000-0000-000000000001' });
    const { status, body } = await request(server, 'GET', '/api/tags/suggestions?q=ali', { token: 'tok' });
    assert.equal(status, 200);
    assert.ok(!body.suggestions.map((s: any) => s.handle).includes('alice'), 'blocked alice must be excluded');
    store.blocks = [];
  });

  it('returns matching profiles filtered by tag_permission', async () => {
    const { status, body } = await request(server, 'GET', '/api/tags/suggestions?q=bo', { token: 'tok' });
    assert.equal(status, 200);
    assert.ok(body.suggestions.length >= 1);
    assert.equal(body.suggestions[0].handle, 'bob');
  });
});

// ─── GET /me/tag-permission ───────────────────────────────────────────────────

describe('GET /me/tag-permission', () => {
  let server: http.Server;

  before(() => {
    const uid = 'aaaa0001-0000-0000-0000-000000000002';
    const client = makeClient(
      { profiles: [{ id: uid, handle: 'testuser', tag_permission: 'friends_only', role: 'user' }] },
      { userId: uid },
    );
    _setTestClient(client, true);
    _setTestServiceClient(client);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns the current tag_permission', async () => {
    const { status, body } = await request(server, 'GET', '/api/me/tag-permission', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.tagPermission, 'friends_only');
  });
});

// ─── PATCH /me/tag-permission ─────────────────────────────────────────────────

describe('PATCH /me/tag-permission', () => {
  let server: http.Server;
  let store: Record<string, Row[]>;

  before(() => {
    const uid = 'aaaa0001-0000-0000-0000-000000000003';
    store = { profiles: [{ id: uid, handle: 'testuser2', tag_permission: 'anyone', role: 'user' }] };
    const client = makeClient(store, { userId: uid });
    _setTestClient(client, true);
    _setTestServiceClient(client);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('updates the tag_permission successfully', async () => {
    const { status, body } = await request(server, 'PATCH', '/api/me/tag-permission', {
      token: 'tok',
      body: { tagPermission: 'nobody' },
    });
    assert.equal(status, 200);
    assert.equal(body.tagPermission, 'nobody');
  });

  it('returns 400 for invalid tagPermission value', async () => {
    const { status } = await request(server, 'PATCH', '/api/me/tag-permission', {
      token: 'tok',
      body: { tagPermission: 'invalid_value' },
    });
    assert.equal(status, 400);
  });
});

// ─── DELETE /admin/tags/:id ───────────────────────────────────────────────────

describe('DELETE /admin/tags/:id', () => {
  let server: http.Server;
  let adminId: string;
  let store: Record<string, Row[]>;

  before(() => {
    adminId = 'aaaa0001-0000-0000-0000-000000000004';
    store = {
      profiles: [{ id: adminId, handle: 'admin1', tag_permission: 'anyone', role: 'admin' }],
      tags: [
        {
          id: 'aa000001-0001-0000-0000-000000000001',
          source_type: 'post',
          source_id: 'post-001',
          tagger_id: adminId,
          tagged_user_id: 'bbbb0001-0000-0000-0000-000000000001',
        },
      ],
    };
    const client = makeClient(store, { userId: adminId });
    _setTestClient(client, true);
    _setTestServiceClient(client);
    server = createServer(makeApp());
    return new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });

  after(() => new Promise<void>((r) => server.close(() => r())));

  it('returns 403 for non-admin user', async () => {
    const ns = { profiles: [{ id: adminId, handle: 'admin1', tag_permission: 'anyone', role: 'user' }], tags: [] };
    const nc = makeClient(ns, { userId: adminId });
    _setTestClient(nc, true);
    _setTestServiceClient(nc);
    const { status } = await request(server, 'DELETE', '/api/admin/tags/aa000001-0001-0000-0000-000000000001', { token: 'tok' });
    assert.equal(status, 403);
    const ac = makeClient(store, { userId: adminId });
    _setTestClient(ac, true);
    _setTestServiceClient(ac);
  });

  it('deletes a tag row as admin', async () => {
    const { status, body } = await request(server, 'DELETE', '/api/admin/tags/aa000001-0001-0000-0000-000000000001', { token: 'tok' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(store.tags.length, 0);
  });

  it('returns 404 for non-existent tag id', async () => {
    const { status } = await request(server, 'DELETE', '/api/admin/tags/ffff0000-0000-0000-0000-000000000999', { token: 'tok' });
    assert.equal(status, 404);
  });
});

// ─── processTagging enforcement ───────────────────────────────────────────────

describe('processTagging enforcement', () => {
  let store: Record<string, Row[]>;
  const authorId = 'aaaa0001-0000-0000-0000-000000000005';
  const aliceId  = 'bbbb0001-0000-0000-0000-000000000011';
  const bobId    = 'bbbb0002-0000-0000-0000-000000000012'; // tag_permission=nobody
  const carolId  = 'bbbb0003-0000-0000-0000-000000000013'; // tag_permission=friends_only
  const daveId   = 'bbbb0004-0000-0000-0000-000000000014';
  const eveId    = 'bbbb0005-0000-0000-0000-000000000015';
  const frankId  = 'bbbb0006-0000-0000-0000-000000000016';

  before(() => {
    store = {
      profiles: [
        { id: authorId, handle: 'author', tag_permission: 'anyone', role: 'user' },
        { id: aliceId,  handle: 'alice',  tag_permission: 'anyone',       role: 'user' },
        { id: bobId,    handle: 'bob',    tag_permission: 'nobody',       role: 'user' },
        { id: carolId,  handle: 'carol',  tag_permission: 'friends_only', role: 'user' },
        { id: daveId,   handle: 'dave',   tag_permission: 'anyone',       role: 'user' },
        { id: eveId,    handle: 'eve',    tag_permission: 'anyone',       role: 'user' },
        { id: frankId,  handle: 'frank',  tag_permission: 'anyone',       role: 'user' },
      ],
      tags: [],
      hashtags: [],
      hashtag_usage: [],
      blocks: [],
      user_follows: [],
      message_thread_members: [],
      // posts table: provides visibility for filterByContentVisibility checks
      posts: [
        { id: 'post-test-0001-0000000001', author_id: authorId, visibility: 'public', status: 'active' },
        { id: 'post-test-0002-0000000002', author_id: authorId, visibility: 'public', status: 'active' },
        { id: 'post-test-0003-0000000003', author_id: authorId, visibility: 'public', status: 'active' },
        { id: 'post-test-0004-0000000004', author_id: authorId, visibility: 'public', status: 'active' },
        { id: 'post-test-cap-000000005',   author_id: authorId, visibility: 'public', status: 'active' },
        { id: 'post-test-ratelimit-06',    author_id: authorId, visibility: 'public', status: 'active' },
        { id: 'post-dedup-007',            author_id: authorId, visibility: 'public', status: 'active' },
        { id: 'post-notif-dedup-09',       author_id: authorId, visibility: 'public', status: 'active' },
        { id: 'post-private-visibility-10', author_id: authorId, visibility: 'private', status: 'active' },
      ],
    };
  });

  it('tag row is written to the store when post contains a valid @mention', async () => {
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const sc = makeClient(store, { userId: authorId });
    const taggedIds = await processTagging({
      db: sc as any,
      authorId,
      sourceType: 'post',
      sourceId: 'post-test-0001-0000000001',
      content: 'Hello @alice!',
    });
    assert.ok(taggedIds.includes(aliceId), 'alice should be tagged');
    const row = store.tags.find((t: any) => t.source_id === 'post-test-0001-0000000001' && t.tagged_user_id === aliceId);
    assert.ok(row, 'tag row should be in store');
    store.tags = [];
  });

  it('tag_permission=nobody → tag is skipped and no row written', async () => {
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const sc = makeClient(store, { userId: authorId });
    const taggedIds = await processTagging({
      db: sc as any,
      authorId,
      sourceType: 'post',
      sourceId: 'post-test-0002-0000000002',
      content: 'Hey @bob',
    });
    assert.ok(!taggedIds.includes(bobId), 'bob (nobody) must be skipped');
    assert.equal(store.tags.length, 0);
  });

  it('friends_only → tag blocked when not a mutual follow', async () => {
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const sc = makeClient(store, { userId: authorId });
    const taggedIds = await processTagging({
      db: sc as any,
      authorId,
      sourceType: 'post',
      sourceId: 'post-test-0003-0000000003',
      content: 'Hey @carol',
    });
    assert.ok(!taggedIds.includes(carolId), 'carol (friends_only, no mutual) must be skipped');
    store.tags = [];
  });

  it('friends_only → tag allowed when mutual follow exists', async () => {
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    store.user_follows = [
      { id: 'f1', follower_id: authorId, following_id: carolId },
      { id: 'f2', follower_id: carolId,  following_id: authorId },
    ];
    const sc = makeClient(store, { userId: authorId });
    const taggedIds = await processTagging({
      db: sc as any,
      authorId,
      sourceType: 'post',
      sourceId: 'post-test-0004-0000000004',
      content: 'Hey @carol',
    });
    assert.ok(taggedIds.includes(carolId), 'carol (friends_only + mutual) must be tagged');
    store.tags = [];
    store.user_follows = [];
  });

  it('per-item cap: 6th unique @mention is dropped (cap = 5)', async () => {
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const sc = makeClient(store, { userId: authorId });
    await processTagging({
      db: sc as any,
      authorId,
      sourceType: 'post',
      sourceId: 'post-test-cap-000000005',
      content: '@alice @bob @carol @dave @eve @frank',
    });
    const taggedFrank = store.tags.find((t: any) => t.tagged_user_id === frankId);
    assert.ok(!taggedFrank, 'frank (6th) must be excluded by the per-item cap');
    store.tags = [];
  });

  it('per-hour rate-limit: MAX_TAGS_PER_HOUR reached → new tags blocked', async () => {
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const now = new Date();
    store.tags = Array.from({ length: 20 }, (_, i) => ({
      id: `rate-${String(i).padStart(4, '0')}`,
      source_type: 'post',
      source_id: `post-rate-${i}`,
      tagger_id: authorId,
      tagged_user_id: aliceId,
      created_at: new Date(now.getTime() - 1_000 * i).toISOString(),
    }));
    const sc = makeClient(store, { userId: authorId });
    const taggedIds = await processTagging({
      db: sc as any,
      authorId,
      sourceType: 'post',
      sourceId: 'post-test-ratelimit-06',
      content: '@alice',
    });
    assert.deepEqual(taggedIds, [], 'rate limit must prevent further tagging');
    store.tags = [];
  });

  it('dedup: calling processTagging twice with same source yields one tag row', async () => {
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const sc1 = makeClient(store, { userId: authorId });
    await processTagging({ db: sc1 as any, authorId, sourceType: 'post', sourceId: 'post-dedup-007', content: '@alice' });
    const sc2 = makeClient(store, { userId: authorId });
    await processTagging({ db: sc2 as any, authorId, sourceType: 'post', sourceId: 'post-dedup-007', content: '@alice' });

    const aliceTagRows = store.tags.filter(
      (t: any) => t.source_id === 'post-dedup-007' && t.tagged_user_id === aliceId,
    );
    assert.equal(aliceTagRows.length, 1, 'duplicate upsert must produce exactly one row');
    store.tags = [];
  });

  it('visibility suppression: private post → processTagging returns [] (no notification dispatched)', async () => {
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const sc = makeClient(store, { userId: authorId });
    const taggedIds = await processTagging({
      db: sc as any, authorId,
      sourceType: 'post', sourceId: 'post-private-visibility-10',
      content: '@alice',
    });
    assert.deepEqual(taggedIds, [], 'private post must suppress all tag notifications');
    store.tags = [];
  });

  it('notification dedup: second processTagging call returns [] taggedIds (at-most-once notification guaranteed)', async () => {
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const sc1 = makeClient(store, { userId: authorId });
    const firstIds = await processTagging({
      db: sc1 as any, authorId,
      sourceType: 'post', sourceId: 'post-notif-dedup-09',
      content: '@alice',
    });
    assert.ok(firstIds.includes(aliceId), 'first call must return tagged id so caller dispatches notification');

    const sc2 = makeClient(store, { userId: authorId });
    const secondIds = await processTagging({
      db: sc2 as any, authorId,
      sourceType: 'post', sourceId: 'post-notif-dedup-09',
      content: '@alice',
    });
    assert.deepEqual(secondIds, [], 'second call must return [] — tag already exists, no duplicate notification dispatched');
    store.tags = [];
  });
});

// A router-only app that also provides the `req.log` pino stub the error paths
// use. makeApp() above predates those paths; without this a route that logs an
// error 500s on `req.log` being undefined and hides the status under test.
function makeAppWithLog() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use('/api', tagsRouter);
  return app;
}

// ─── Phase 0 #1 — POST /api/tags authorization ────────────────────────────────
//
// The route validates that source_id is a UUID and nothing else: it never
// establishes that the source exists or that the caller is the one who wrote
// it. TaggingService only ever tags content its own author is composing, so
// "the tagger authored the source" is the policy the inline path enforces
// structurally. This asserts the REST path enforces it too.

describe('POST /api/tags — source authorization', () => {
  const caller   = 'aaaaaaaa-0001-4000-8000-000000000001';
  const stranger = 'cccccccc-0003-4000-8000-000000000003';
  const target   = 'bbbbbbbb-0002-4000-8000-000000000002';
  const othersPost = '11111111-2222-4333-8444-555555555555';

  it("refuses to tag anyone onto a post the caller did not author", async () => {
    const store: Record<string, Row[]> = {
      profiles: [
        { id: caller,   handle: 'caller',   tag_permission: 'anyone' },
        { id: stranger, handle: 'stranger', tag_permission: 'anyone' },
        { id: target,   handle: 'target',   tag_permission: 'anyone' },
      ],
      // Authored by `stranger`. The caller has no relationship to it at all.
      posts: [{ id: othersPost, author_id: stranger, visibility: 'public' }],
      tags: [],
      blocks: [],
      feature_flags: [],
    };
    const sc = makeClient(store, { userId: caller });
    _setTestClient(sc as any, true);
    _setTestServiceClient(sc as any);
    const server = createServer(makeAppWithLog()).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    try {
      const res = await request(server, 'POST', '/api/tags', {
        token: 'good',
        body: { source_type: 'post', source_id: othersPost, tagged_user_id: target },
      });
      assert.equal(res.status, 403,
        `tagging a stranger's post must be forbidden, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.deepEqual(store.tags, [],
        'no tag row may be written for a source the caller does not own');
    } finally {
      server.close();
    }
  });
});

// ─── Phase 0 #4 — PostgREST filter injection in /api/tags/suggestions ─────────
//
// `q` is interpolated raw into .or(`handle.ilike.${q}%,name.ilike.%${q}%`).
// A comma closes the first predicate and opens an attacker-chosen one, so the
// filter stops being "handles starting with q" and becomes whatever the caller
// writes. Here the injected predicate selects a profile by exact handle that
// the real prefix search could never return.

describe('GET /api/tags/suggestions — filter injection', () => {
  const caller = 'aaaaaaaa-0001-4000-8000-000000000001';
  const secret = 'dddddddd-0004-4000-8000-000000000004';

  it('a comma in q must not inject an extra predicate against profiles', async () => {
    const store: Record<string, Row[]> = {
      profiles: [
        { id: caller, handle: 'caller', name: 'Caller', tag_permission: 'anyone' },
        // Handle shares no prefix with the query. Only an injected predicate reaches it.
        { id: secret, handle: 'zzsecret', name: 'Zed', tag_permission: 'anyone' },
      ],
      // show_real_name=true so the hidden-name filter cannot mask the leak and
      // make this test pass for a reason unrelated to the injection.
      profile_privacy_settings: [{ user_id: secret, show_real_name: true }],
      blocks: [],
      user_follows: [],
    };
    const sc = makeClient(store, { userId: caller });
    _setTestClient(sc as any, true);
    _setTestServiceClient(sc as any);
    const server = createServer(makeApp()).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    try {
      // `handle.ilike.` + the '%' the route appends === match-everything, so a
      // prefix search for "aa" returns the entire profiles table.
      const q = encodeURIComponent('aa,handle.ilike.');
      const res = await request(server, 'GET', `/api/tags/suggestions?q=${q}`, { token: 'good' });
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      const handles = (res.body.suggestions ?? []).map((s: any) => s.handle);
      assert.ok(!handles.includes('zzsecret'),
        `injected predicate reached a profile the prefix search could not: ${JSON.stringify(handles)}`);
    } finally {
      server.close();
    }
  });
});

// ═══ Phase 0 #2 — pending tags must not render ════════════════════════════════
//
// 0064 added tags.status with 'pending' for approval_required. enrichSpans
// filtered only `suppressed`, so a tag awaiting the tagged user's approval
// rendered to every viewer immediately and the 202 the write path returns was
// theatre.

describe('enrichSpans — tag status', () => {
  const post = 'eeee1111-0000-4000-8000-000000000001';
  const alice = 'aaaa1111-0000-4000-8000-000000000011';

  function scFor(status: string) {
    return makeClient({
      tags: [{ id: 'tagrow-1', source_type: 'post', source_id: post,
               tagged_user_id: alice, suppressed: false, status }],
      profiles: [{ id: alice, handle: 'alice' }],
      hashtag_usage: [],
      hashtags: [],
      blocks: [],
    });
  }

  it('does NOT render a pending tag', async () => {
    const { enrichSpans } = await import('../lib/enrichSpans.js');
    const out = await enrichSpans(scFor('pending'), 'post', [{ id: post, content: 'hey @alice' }]);
    assert.deepEqual(out[post].tags, [],
      'a tag awaiting approval must not be rendered to viewers');
  });

  it('still renders an approved tag (guards against over-filtering)', async () => {
    const { enrichSpans } = await import('../lib/enrichSpans.js');
    const out = await enrichSpans(scFor('approved'), 'post', [{ id: post, content: 'hey @alice' }]);
    assert.equal(out[post].tags.length, 1, 'approved tags must still render');
    assert.equal(out[post].tags[0].matchToken, 'alice');
  });
});

// ═══ Phase 0 #8 — filterByContentVisibility ═══════════════════════════════════

describe('processTagging — content-visibility failure modes', () => {
  const author = 'bbbb2222-0000-4000-8000-000000000021';
  const alice  = 'aaaa2222-0000-4000-8000-000000000022';

  it('(8a) suppresses notifications when the post row cannot be found', async () => {
    // No `posts` row for this id at all. Visibility is therefore unknown, and an
    // unknown visibility is not a permission.
    const store: Record<string, Row[]> = {
      profiles: [{ id: alice, handle: 'alice', tag_permission: 'anyone' }],
      posts: [],
      tags: [],
      blocks: [],
      user_follows: [],
    };
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const ids = await processTagging({
      db: makeClient(store, { userId: author }) as any,
      authorId: author, sourceType: 'post', sourceId: 'ffff3333-0000-4000-8000-000000000099',
      content: '@alice',
    });
    assert.deepEqual(ids, [],
      'post not found → visibility unknown → must fail CLOSED, not notify everyone');
  });

  it('(8b) friends-only post does not notify a one-way follower', async () => {
    // alice follows author. They are NOT friends (no user_friendships row).
    const store: Record<string, Row[]> = {
      profiles: [{ id: alice, handle: 'alice', tag_permission: 'anyone' }],
      posts: [{ id: 'ffff4444-0000-4000-8000-000000000044', visibility: 'friends', author_id: author, trip_id: null }],
      user_follows: [{ follower_id: alice, following_id: author }],
      user_friendships: [],
      tags: [],
      blocks: [],
    };
    const { processTagging } = await import('../services/tagging/TaggingService.js');
    const ids = await processTagging({
      db: makeClient(store, { userId: author }) as any,
      authorId: author, sourceType: 'post', sourceId: 'ffff4444-0000-4000-8000-000000000044',
      content: '@alice',
    });
    assert.deepEqual(ids, [],
      'friends-only visibility must require a mutual friendship, not a one-way follow');
  });
});

// ═══ Phase 0 #3 — disable_tagging must fail to the STOPPED state ══════════════

describe('POST /api/tags — disable_tagging is an emergency stop', () => {
  const caller = 'aaaa5555-0000-4000-8000-000000000055';
  const target = 'bbbb5555-0000-4000-8000-000000000056';
  const own    = 'cccc5555-0000-4000-8000-000000000057';

  it('refuses when the feature_flags lookup ERRORS (unknown ≠ permission to proceed)', async () => {
    const store: Record<string, Row[]> = {
      profiles: [
        { id: caller, handle: 'caller', tag_permission: 'anyone' },
        { id: target, handle: 'target', tag_permission: 'anyone' },
      ],
      posts: [{ id: own, author_id: caller, visibility: 'public' }],
      tags: [], blocks: [], feature_flags: [],
    };
    const sc: any = makeClient(store, { userId: caller });
    const realFrom = sc.from.bind(sc);
    // Only feature_flags is unhealthy — everything else works, so a refusal can
    // only come from the kill-switch read.
    sc.from = (table: string) => {
      if (table !== 'feature_flags') return realFrom(table);
      const b: any = new Proxy({}, {
        get: (_t, prop) => (prop === 'then'
          ? (resolve: any) => resolve({ data: null, error: { message: 'connection reset' } })
          : () => b),
      });
      return b;
    };
    _setTestClient(sc, true);
    _setTestServiceClient(sc);
    const server = createServer(makeAppWithLog()).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    try {
      const res = await request(server, 'POST', '/api/tags', {
        token: 'good',
        body: { source_type: 'post', source_id: own, tagged_user_id: target },
      });
      // 404 = feature_disabled, the same code a deliberate stop returns. The
      // property under test is that the request is REFUSED and nothing is
      // written, not which code expresses it.
      assert.equal(res.status, 404,
        `an emergency stop must engage when its own state cannot be read, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.deepEqual(store.tags, [], 'no tag row may be written while the stop is engaged');
    } finally {
      server.close();
    }
  });
});
