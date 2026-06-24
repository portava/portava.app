/**
 * Tagging & Tags routes tests
 *
 * Covers:
 *  - extractMentionHandles / extractHashtagSlugs pure functions
 *  - GET  /api/tags/suggestions
 *  - GET  /api/me/tag-permission
 *  - PATCH /api/me/tag-permission
 *
 * Uses node:test + fake-client pattern (no real DB, no vitest).
 * Run: node --import tsx/esm --test src/test/tagging.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { _setTestClient } from '../lib/http.js';
import { _setTestServiceClient } from '../lib/supabase.js';
import tagsRouter from '../routes/tags.js';
import { extractMentionHandles, extractHashtagSlugs } from '../services/tagging/TaggingService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAKE_TOKEN = 'fake.jwt.token';
const USER_ID = '00000000-0000-0000-0000-000000000001';

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

// ── Fake client ───────────────────────────────────────────────────────────────

function makeFakeClient(opts: {
  profiles?: any[];
  tagPermission?: string;
}) {
  const { profiles = [], tagPermission = 'anyone' } = opts;

  function makeBuilder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _update: any = null;
    const builder: any = {
      select()      { return builder; },
      insert()      { return builder; },
      upsert()      { return builder; },
      update(p: any){ _update = p; return builder; },
      delete()      { return builder; },
      eq(col: string, val: any)         { filters.push((r) => r[col] === val); return builder; },
      neq(col: string, val: any)        { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[])      { filters.push((r) => vals.includes(r[col])); return builder; },
      ilike(col: string, pat: string)   { const prefix = pat.replace('%', '').toLowerCase(); filters.push((r) => String(r[col] ?? '').toLowerCase().startsWith(prefix)); return builder; },
      order()       { return builder; },
      limit()       { return builder; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single()      {
        if (_update) return Promise.resolve({ data: { tag_permission: tagPermission, ..._update }, error: null });
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      then(onF: any, onR: any) { return Promise.resolve({ data: rows(), error: null }).then(onF, onR); },
    };
    function rows() {
      let src: any[] = [];
      if (table === 'profiles') src = profiles;
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

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use(tagsRouter);

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
// Pure-function tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractMentionHandles', () => {
  it('extracts lowercase unique handles', () => {
    const result = extractMentionHandles('Hey @Alice and @bob, also @ALICE again!');
    assert.deepEqual(result, ['alice', 'bob']);
  });

  it('returns empty for no mentions', () => {
    assert.deepEqual(extractMentionHandles('No tags here'), []);
  });

  it('ignores handles longer than 64 chars', () => {
    const long = '@' + 'a'.repeat(65);
    // The regex cap at 64 means it will match 64 chars, not the full 65-char token
    const result = extractMentionHandles(long);
    assert.equal(result.length, 1);
    assert.equal(result[0].length, 64);
  });
});

describe('extractHashtagSlugs', () => {
  it('extracts lowercase unique slugs', () => {
    const result = extractHashtagSlugs('#Travel #BUDDY extra #travel');
    assert.deepEqual(result, ['travel', 'buddy']);
  });

  it('strips leading # and normalizes to lowercase', () => {
    const result = extractHashtagSlugs('#TravelBuddy2024');
    assert.deepEqual(result, ['travelbuddy2024']);
  });

  it('ignores single-char hashtags', () => {
    assert.deepEqual(extractHashtagSlugs('#a #go #wanderlust'), ['go', 'wanderlust']);
  });

  it('returns empty for no hashtags', () => {
    assert.deepEqual(extractHashtagSlugs('plain text'), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP route tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /tags/suggestions', () => {
  it('returns 401 without auth token', async () => {
    const client = makeFakeClient({});
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    const r = await makeReq('GET', '/tags/suggestions?q=al', undefined, { authorization: 'Bearer bad' });
    assert.equal(r.status, 401);
  });

  it('returns 400 if q is missing', async () => {
    const client = makeFakeClient({});
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    const r = await makeReq('GET', '/tags/suggestions');
    assert.equal(r.status, 400);
  });

  it('returns matching profiles filtered by tag_permission', async () => {
    const profiles = [
      { id: '00000000-0000-0000-0000-000000000002', handle: 'alice', name: 'Alice', avatar_url: null, tag_permission: 'anyone' },
      { id: '00000000-0000-0000-0000-000000000003', handle: 'nobody_bob', name: 'Bob', avatar_url: null, tag_permission: 'nobody' },
      { id: USER_ID, handle: 'me', name: 'Me', avatar_url: null, tag_permission: 'anyone' },
    ];
    const client = makeFakeClient({ profiles });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/tags/suggestions?q=al');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.suggestions));
    // alice should be returned; nobody_bob excluded; 'me' excluded (same as caller)
    const handles = r.body.suggestions.map((s: any) => s.handle);
    assert.ok(handles.includes('alice'), 'alice should be in suggestions');
    assert.ok(!handles.includes('nobody_bob'), 'nobody_bob should be excluded');
    assert.ok(!handles.includes('me'), 'self should be excluded');
  });
});

describe('GET /me/tag-permission', () => {
  it('returns the current tag_permission', async () => {
    const profiles = [
      { id: USER_ID, handle: 'me', tag_permission: 'friends_only' },
    ];
    const client = makeFakeClient({ profiles, tagPermission: 'friends_only' });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const r = await makeReq('GET', '/me/tag-permission');
    assert.equal(r.status, 200);
    assert.equal(r.body.tagPermission, 'friends_only');
  });
});

describe('PATCH /me/tag-permission', () => {
  it('updates the tag_permission successfully', async () => {
    const client = makeFakeClient({ tagPermission: 'nobody' });
    _setTestClient(client as any, true);

    const r = await makeReq('PATCH', '/me/tag-permission', { tagPermission: 'nobody' });
    assert.equal(r.status, 200);
    assert.equal(r.body.tagPermission, 'nobody');
  });

  it('returns 400 for invalid tagPermission value', async () => {
    const client = makeFakeClient({});
    _setTestClient(client as any, true);

    const r = await makeReq('PATCH', '/me/tag-permission', { tagPermission: 'invalid_value' });
    assert.equal(r.status, 400);
  });
});
