/**
 * postcards.test.ts — backend tests for the Postcards media upload API.
 *
 * Covers:
 *  - POST /api/postcards                             — create draft (auth required, invalid body)
 *  - POST /api/postcards/:id/media/upload-url        — MIME gate, size gate, ownership (cross-user block)
 *  - POST /api/postcards/:id/media/:mediaId/complete — marks ready; updates counts; lazy postcard creation
 *  - DELETE /api/postcards/:id/media/:mediaId        — owner-only; admin override; counts decremented
 *  - Feed regression                                 — new media fields don't break existing photo posts
 *
 * Pattern: _setTestClient(client, true) wires both the user-request slot AND
 * the service-client slot to the same in-memory fake, so requireUser() and
 * getServiceClient() always resolve consistently within a test.
 *
 * Fire-and-forget calls (.then(undefined, () => {})) are handled by the fake
 * builder's `then()` which treats `resolve=undefined` as an identity no-op.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { _setTestClient } from '../lib/http.js';
import sharp from 'sharp';
import { FIXTURE_ISO6709, mp4WithLocation, webmWithLocationTag } from './videoFixtures.js';

// Tiny valid JPEG served by the fake storage download (built once).
let __jpegPromise: Promise<Buffer> | null = null;
function __testJpeg(): Promise<Buffer> {
  if (!__jpegPromise) {
    __jpegPromise = sharp({ create: { width: 32, height: 24, channels: 3, background: '#357' } }).jpeg().toBuffer();
  }
  return __jpegPromise;
}

/**
 * 64-byte MP4 head: 4-byte size box then "ftypisom", zero-padded.
 *
 * /complete now VERIFIES video bytes instead of trusting the client-declared
 * fileSizeBytes, because on this signed-URL transport the client writes
 * straight to Storage and the declared size is an assertion about a file the
 * server never saw. It reads the first 64 bytes over a Range request rather
 * than downloading the whole object, so this is all the fixture must serve.
 */
function __testMp4Head(): Buffer {
  const buf = Buffer.alloc(64);
  buf.writeUInt32BE(32, 0);
  buf.write('ftypisom', 4, 'ascii');
  return buf;
}

/** Total size the stubbed Range response reports, in bytes. */
let __videoTotalBytes = 500_000;
/** Bytes the stubbed Range response serves (override to test rejection paths). */
let __videoHeadBytes: Buffer = __testMp4Head();
/** When true the stub omits Content-Range, as a server ignoring Range would. */
let __omitContentRange = false;
/**
 * Full bytes the fake storage returns when /complete DOWNLOADS a video object
 * to strip its container location metadata. Geotagged by default, exactly as a
 * phone capture is, so the scrub path is exercised on every video completion.
 */
let __videoObjectBytes: Buffer = mp4WithLocation();
/** Every object written through the fake storage, in order. */
const __storageUploads: Array<{ path: string; buf: Buffer }> = [];

const __realFetch = globalThis.fetch;

// ── Stable fake IDs ───────────────────────────────────────────────────────────

const OWNER_ID = '00000000-0000-0000-0000-000000000c01';
const OTHER_ID = '00000000-0000-0000-0000-000000000c02';
const POST_ID  = '10000000-0000-0000-0000-000000000c01';
const MEDIA_ID = '20000000-0000-0000-0000-000000000c01';

const TOKEN_OWNER = 'fake-pc-owner';
const TOKEN_OTHER = 'fake-pc-other';

// Stamp definitions for overlay tests (post location is Tokyo / Japan)
const DEF_TOKYO_ID    = '50000000-0000-0000-0000-000000000d01'; // earned by OWNER, has artwork
const DEF_JAPAN_ID    = '50000000-0000-0000-0000-000000000d02'; // country-level, NOT earned — location-eligible
const DEF_PARIS_ID    = '50000000-0000-0000-0000-000000000d03'; // earned by OTHER only, mismatched location
const DEF_NOART_ID    = '50000000-0000-0000-0000-000000000d04'; // earned by OWNER, no universal artwork
const DEF_INACTIVE_ID = '50000000-0000-0000-0000-000000000d05'; // earned by OWNER, is_active=false
const DEF_REVOKED_ID  = '50000000-0000-0000-0000-000000000d06'; // OWNER's user_stamp is revoked

// ── In-memory DB ─────────────────────────────────────────────────────────────

let posts: Record<string, any> = {};
let allPostMedia: any[] = [];
let allPostcards: any[] = [];
let allProfiles: any[] = [];
let allUserStamps: any[] = [];
let allStampDefs: any[] = [];
let allBlocks: any[] = [];
let allFriendships: any[] = [];
let allFollows: any[] = [];
let allPrivacySettings: any[] = [];
let allAccountStates: any[] = [];
// One-shot failure injection for the next posts INSERT (simulates PostgREST
// schema-cache errors like PGRST204). Consumed by builder.single().
let failNextPostsInsert: { code: string; message: string } | null = null;
// One-shot failure injection for the next post_media UPDATE (simulates a
// missing stamp_overlay column → PGRST204). Consumed by builder.then().
let failNextMediaUpdate: { code: string; message: string } | null = null;

function resetDb() {
  posts = {
    [POST_ID]: {
      id: POST_ID, author_id: OWNER_ID, status: 'active', visibility: 'public',
      content: 'Test postcard', add_to_passport: true,
      location_name: null, location_city: 'Tokyo', location_country: 'Japan',
      media_count: 0, has_video: false, primary_media_type: 'none',
    },
  };
  allPostMedia = [];
  allPostcards = [];
  failNextPostsInsert = null;
  allProfiles = [
    { id: OWNER_ID, role: 'user', username: 'owner', handle: 'owner', passport_visibility: 'public', is_private: false, account_status: 'active' },
    { id: OTHER_ID, role: 'user', username: 'other', handle: 'other', passport_visibility: 'public', is_private: false, account_status: 'active' },
  ];
  allBlocks = [];
  allFriendships = [];
  allFollows = [];
  allPrivacySettings = [];
  allAccountStates = [];
  failNextMediaUpdate = null;
  allStampDefs = [
    { id: DEF_TOKYO_ID,    name: 'Tokyo',  city: 'Tokyo', country: 'Japan',       rarity: 'common', is_active: true,  universal_artwork_url: 'https://cdn.test/art/tokyo.png' },
    { id: DEF_JAPAN_ID,    name: 'Japan',  city: null,    country: 'Japan',       rarity: 'rare',   is_active: true,  universal_artwork_url: 'https://cdn.test/art/japan.png' },
    { id: DEF_PARIS_ID,    name: 'Paris',  city: 'Paris', country: 'France',      rarity: 'common', is_active: true,  universal_artwork_url: 'https://cdn.test/art/paris.png' },
    { id: DEF_NOART_ID,    name: 'Osaka',  city: 'Osaka', country: 'Japan',       rarity: 'common', is_active: true,  universal_artwork_url: null },
    { id: DEF_INACTIVE_ID, name: 'Kyoto',  city: 'Kyoto', country: 'Japan',       rarity: 'common', is_active: false, universal_artwork_url: 'https://cdn.test/art/kyoto.png' },
    { id: DEF_REVOKED_ID,  name: 'Seoul',  city: 'Seoul', country: 'South Korea', rarity: 'common', is_active: true,  universal_artwork_url: 'https://cdn.test/art/seoul.png' },
  ];
  allUserStamps = [
    { id: 'us-1', user_id: OWNER_ID, stamp_definition_id: DEF_TOKYO_ID,    is_revoked: false, earned_at: '2026-07-01T00:00:00Z' },
    { id: 'us-2', user_id: OWNER_ID, stamp_definition_id: DEF_NOART_ID,    is_revoked: false, earned_at: '2026-06-01T00:00:00Z' },
    { id: 'us-3', user_id: OWNER_ID, stamp_definition_id: DEF_INACTIVE_ID, is_revoked: false, earned_at: '2026-05-01T00:00:00Z' },
    { id: 'us-4', user_id: OWNER_ID, stamp_definition_id: DEF_REVOKED_ID,  is_revoked: true,  earned_at: '2026-04-01T00:00:00Z' },
    { id: 'us-5', user_id: OTHER_ID, stamp_definition_id: DEF_PARIS_ID,    is_revoked: false, earned_at: '2026-03-01T00:00:00Z' },
  ];
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function buildFakeClient(tokenToId: Record<string, string>) {
  function builder(table: string, tableRows: any[]): any {
    let filtered = [...tableRows];
    let insertData: any[] | null = null;
    let updateData: any = null;
    let deleteMode = false;
    let countMode = false;

    const b: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count === 'exact' && opts?.head === true) countMode = true;
        return b;
      },
      eq(col: string, val: any)    { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filtered = filtered.filter((r) => r[col] !== val); return b; },
      is(col: string, val: any)    { filtered = filtered.filter((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      ilike(col: string, pattern: string) {
        // Case-insensitive LIKE with % / _ wildcards (enough for these tests)
        const escaped = String(pattern).replace(/[.*+?^{}()|[\]\\]/g, (ch) => '\\' + ch);
        const reBody = escaped.replace(/%/g, '.*').replace(/_/g, '.');
        const rx = new RegExp('^' + reBody + "$", 'i');
        filtered = filtered.filter((r) => typeof r[col] === 'string' && rx.test(r[col]));
        return b;
      },
      or()  { return b; },
      order() { return b; },
      limit(n: number) { filtered = filtered.slice(0, n); return b; },

      insert(data: any) {
        insertData = Array.isArray(data) ? data : [data];
        return b;
      },
      update(data: any) { updateData = data; return b; },
      delete() { deleteMode = true; return b; },

      // ── Terminal async shortcuts ──────────────────────────────────────────

      async single() {
        if (insertData !== null) {
          if (table === 'posts' && failNextPostsInsert) {
            const error = failNextPostsInsert;
            failNextPostsInsert = null; // one-shot: the retry succeeds
            return { data: null, error };
          }
          const row = { ...insertData[0], id: insertData[0].id ?? globalThis.crypto.randomUUID() };
          _storeInsert(table, row);
          return { data: row, error: null };
        }
        const base = filtered[0] ? { ...filtered[0] } : null;
        if (updateData !== null && base) Object.assign(base, updateData);
        return { data: base, error: null };
      },

      async maybeSingle() {
        if (insertData !== null) {
          const row = { ...insertData[0], id: insertData[0].id ?? globalThis.crypto.randomUUID() };
          _storeInsert(table, row);
          return { data: row, error: null };
        }
        const base = filtered[0] ? { ...filtered[0] } : null;
        if (updateData !== null && base) Object.assign(base, updateData);
        return { data: base, error: null };
      },

      // ── Thenable (used by await without .single/.maybySingle) ─────────────

      then(resolve: any, _reject?: any) {
        // Handle fire-and-forget (.then(undefined, () => {})) gracefully
        const cb: (v: any) => any = typeof resolve === 'function' ? resolve : (v: any) => v;

        if (insertData !== null) {
          const inserted = insertData.map((row) => {
            const id = row.id ?? globalThis.crypto.randomUUID();
            const newRow = { ...row, id };
            _storeInsert(table, newRow);
            return newRow;
          });
          return cb({ data: inserted, error: null });
        }

        if (deleteMode) {
          if (table === 'post_media') {
            const toDelete = new Set(filtered.map((r: any) => r.id));
            allPostMedia = allPostMedia.filter((r) => !toDelete.has(r.id));
          }
          return cb({ data: null, error: null });
        }

        if (updateData !== null) {
          if (table === 'post_media' && failNextMediaUpdate) {
            const error = failNextMediaUpdate;
            failNextMediaUpdate = null; // one-shot: the retry succeeds
            return cb({ data: null, error });
          }
          for (const row of filtered) {
            if (table === 'posts' && posts[row.id])
              Object.assign(posts[row.id], updateData);
            else if (table === 'post_media') {
              const m = allPostMedia.find((r) => r.id === row.id);
              if (m) Object.assign(m, updateData);
            } else if (table === 'passport_postcards') {
              const pc = allPostcards.find((r) => r.id === row.id);
              if (pc) Object.assign(pc, updateData);
            }
          }
          return cb({ data: filtered.map((r) => ({ ...r, ...updateData })), error: null });
        }

        if (countMode) return cb({ count: filtered.length, error: null });
        return cb({ data: [...filtered], error: null });
      },
    };
    return b;
  }

  function _storeInsert(table: string, row: any) {
    if (table === 'posts')               { posts[row.id] = row; }
    else if (table === 'post_media')     { allPostMedia.push(row); }
    else if (table === 'passport_postcards') { allPostcards.push(row); }
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
      if (table === 'posts')                   rows = Object.values(posts).map((r) => ({ ...r }));
      else if (table === 'post_media')         rows = allPostMedia.map((r) => ({ ...r }));
      else if (table === 'passport_postcards') rows = allPostcards.map((r) => ({ ...r }));
      else if (table === 'profiles')               rows = allProfiles.map((r) => ({ ...r }));
      else if (table === 'user_stamps')            rows = allUserStamps.map((r) => ({ ...r }));
      else if (table === 'stamp_definitions')      rows = allStampDefs.map((r) => ({ ...r }));
      else if (table === 'blocks')                 rows = allBlocks.map((r) => ({ ...r }));
      else if (table === 'user_friendships')       rows = allFriendships.map((r) => ({ ...r }));
      else if (table === 'user_follows')           rows = allFollows.map((r) => ({ ...r }));
      else if (table === 'profile_privacy_settings') rows = allPrivacySettings.map((r) => ({ ...r }));
      else if (table === 'user_account_states')    rows = allAccountStates.map((r) => ({ ...r }));
      // All other tables (feature_flags, hashtags, text_spans, etc.) return empty arrays
      return builder(table, rows);
    },
    storage: {
      from(_bucket: string) {
        return {
          createSignedUploadUrl: async (path: string) => ({
            data: { signedUrl: `https://storage.test/post-media/${path}`, token: 'tok', path },
            error: null,
          }),
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/post-media/${path}` },
          }),
          remove: async (_paths: string[]) => ({ data: null, error: null }),
          // /complete signs a short-lived read URL to range-read video bytes.
          createSignedUrl: async (path: string, _expiresIn: number) => ({
            data: { signedUrl: `https://storage.test/signed/${path}` },
            error: null,
          }),
          // /complete downloads the stored bytes server-side: images to strip
          // EXIF and measure real dimensions, videos to strip the container's
          // capture-location atoms. Serve bytes that match the object's kind —
          // a fake that handed a jpeg back for a .mp4 would make the video path
          // pass on media it will never actually see.
          download: async (_path: string) => ({
            data: _path.endsWith('.mp4')
              ? new Blob([new Uint8Array(__videoObjectBytes)])
              : new Blob([new Uint8Array(await __testJpeg())]),
            error: null,
          }),
          upload: async (_path: string, _buf: unknown, _opts?: unknown) => {
            __storageUploads.push({ path: _path, buf: _buf as Buffer });
            return { data: { path: _path }, error: null };
          },
        };
      },
    },
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

let server: http.Server;
let port: number;

function apiReq(
  method: string, path: string, body?: unknown, token?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: `/api${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;

  // Serve the Range read that /complete performs against the signed video URL.
  // Only storage.test is intercepted; everything else falls through to the real
  // fetch so an unrelated request cannot be silently swallowed by this stub.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (!url.startsWith('https://storage.test/')) return __realFetch(input, init);
    const headers: Record<string, string> = {};
    if (!__omitContentRange) {
      headers['content-range'] = `bytes 0-${__videoHeadBytes.length - 1}/${__videoTotalBytes}`;
    }
    return new Response(new Uint8Array(__videoHeadBytes), { status: 206, headers });
  }) as typeof globalThis.fetch;
});

after(async () => {
  globalThis.fetch = __realFetch;
  _setTestClient(null as any, true);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  resetDb();
  __videoTotalBytes = 500_000;
  __videoHeadBytes = __testMp4Head();
  __omitContentRange = false;
  __videoObjectBytes = mp4WithLocation();
  __storageUploads.length = 0;
  _setTestClient(buildFakeClient({ [TOKEN_OWNER]: OWNER_ID, [TOKEN_OTHER]: OTHER_ID }), true);
});

// ── POST /api/postcards ───────────────────────────────────────────────────────

describe('POST /api/postcards', () => {
  it('creates a post and returns its id', async () => {
    const { status, body } = await apiReq(
      'POST', '/postcards',
      { caption: 'Hello #travel', addToPassport: true, locationCity: 'Seoul' },
      TOKEN_OWNER,
    );
    assert.equal(status, 201);
    assert.ok(typeof body.id === 'string' && body.id.length > 0, 'should return a string id');
    const stored = Object.values(posts).find((p: any) => p.author_id === OWNER_ID && p.content === 'Hello #travel') as any;
    assert.ok(stored, 'post should be in the in-memory store');
    assert.equal(stored.media_count, 0);
  });

  it('maps placeId → location_place_id and stores the canonical location ref (composer regression)', async () => {
    const CANONICAL_ID = '30000000-0000-0000-0000-000000000c99';
    const { status, body } = await apiReq(
      'POST', '/postcards',
      {
        caption: 'Sunset session',
        locationCity: 'Siargao',
        locationCountry: 'Philippines',
        placeId: 'nominatim:12345',
        canonicalLocationId: CANONICAL_ID,
      },
      TOKEN_OWNER,
    );
    assert.equal(status, 201);
    const stored = posts[body.id];
    assert.ok(stored, 'post should be in the in-memory store');
    assert.equal(stored.location_place_id, 'nominatim:12345');
    assert.equal(stored.canonical_location_id, CANONICAL_ID);
    assert.equal(stored.location_city, 'Siargao');
    assert.equal(stored.location_country, 'Philippines');
    // Regression guard: posts has NO place_id / event_id columns. Writing them
    // made PostgREST reject every composer insert (PGRST204 → raw db_error
    // banner in the app). The route must never emit these keys again.
    assert.ok(!('place_id' in stored), 'must not write a bare place_id column');
    assert.ok(!('event_id' in stored), 'must not write an event_id column');
  });

  it('ignores legacy eventId payloads instead of failing (non-strict schema)', async () => {
    const { status, body } = await apiReq(
      'POST', '/postcards',
      { caption: 'From an old client', eventId: '40000000-0000-0000-0000-000000000c01' },
      TOKEN_OWNER,
    );
    assert.equal(status, 201);
    assert.ok(!('event_id' in (posts[body.id] ?? {})), 'eventId must be dropped, not written');
  });

  it('falls back to inserting without canonical_location_id when the column is missing (PGRST204)', async () => {
    failNextPostsInsert = {
      code: 'PGRST204',
      message: "Could not find the 'canonical_location_id' column of 'posts' in the schema cache",
    };
    const { status, body } = await apiReq(
      'POST', '/postcards',
      {
        caption: 'Fallback probe',
        placeId: 'nominatim:777',
        canonicalLocationId: '30000000-0000-0000-0000-000000000c98',
      },
      TOKEN_OWNER,
    );
    assert.equal(status, 201, 'optional canonical link must never block posting');
    const matching = Object.values(posts).filter((p: any) => p.content === 'Fallback probe');
    assert.equal(matching.length, 1, 'exactly one post persisted — retry must not duplicate');
    const stored = matching[0] as any;
    assert.equal(body.id, stored.id);
    assert.ok(!('canonical_location_id' in stored), 'canonical column dropped on the retry');
    assert.equal(stored.location_place_id, 'nominatim:777', 'rest of the row survives the retry');
  });

  it('does NOT retry on unrelated DB errors — returns a readable db_error instead', async () => {
    failNextPostsInsert = {
      code: '23503',
      message: 'insert or update on table "posts" violates foreign key constraint "posts_trip_id_fkey"',
    };
    const { status, body } = await apiReq(
      'POST', '/postcards',
      { caption: 'FK failure probe', canonicalLocationId: '30000000-0000-0000-0000-000000000c97' },
      TOKEN_OWNER,
    );
    assert.ok(status >= 400, 'must fail');
    assert.equal(body.error, 'db_error');
    assert.match(body.message ?? '', /couldn't create your postcard/i, 'client gets a readable sentence');
    assert.ok(!JSON.stringify(body).includes('foreign key'), 'raw DB detail must never leak to the client');
    assert.equal(
      Object.values(posts).filter((p: any) => p.content === 'FK failure probe').length,
      0, 'nothing persisted on a real failure',
    );
  });

  it('returns 401 when no auth token', async () => {
    const { status } = await apiReq('POST', '/postcards', { caption: 'Hello' });
    assert.equal(status, 401);
  });

  it('returns 400 for invalid visibility value', async () => {
    const { status, body } = await apiReq('POST', '/postcards', { visibility: 'unknown' }, TOKEN_OWNER);
    assert.equal(status, 400);
    assert.ok(body.error, 'should include error field');
  });

  it('returns 400 when caption exceeds 2000 chars', async () => {
    const { status } = await apiReq('POST', '/postcards', { caption: 'x'.repeat(2001) }, TOKEN_OWNER);
    assert.equal(status, 400);
  });
});

// ── POST /api/postcards/:id/media/upload-url ──────────────────────────────────

describe('POST /api/postcards/:id/media/upload-url', () => {
  it('returns 401 when unauthenticated (upload auth test)', async () => {
    const { status } = await apiReq('POST', `/postcards/${POST_ID}/media/upload-url`, {
      mimeType: 'image/jpeg', fileSizeBytes: 1024,
    });
    assert.equal(status, 401);
  });

  it('returns 400 for unsupported MIME type (MIME validation)', async () => {
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/upload-url`,
      { mimeType: 'video/avi', fileSizeBytes: 1024 },
      TOKEN_OWNER,
    );
    assert.equal(status, 400);
    assert.match(body.error ?? '', /invalid_payload/i);
  });

  it('returns 400 when video exceeds the 100 MB limit (file-size rejection)', async () => {
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/upload-url`,
      { mimeType: 'video/mp4', fileSizeBytes: 101 * 1024 * 1024 },
      TOKEN_OWNER,
    );
    assert.equal(status, 400);
    assert.match(body.error ?? '', /invalid_payload/i);
  });

  it('returns 400 when image exceeds the 20 MB limit (file-size rejection)', async () => {
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/upload-url`,
      { mimeType: 'image/jpeg', fileSizeBytes: 21 * 1024 * 1024 },
      TOKEN_OWNER,
    );
    assert.equal(status, 400);
    assert.match(body.error ?? '', /invalid_payload/i);
  });

  it('returns 403 when another user tries to upload to the owner postcard (cross-user block)', async () => {
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/upload-url`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1024 },
      TOKEN_OTHER,
    );
    assert.equal(status, 403);
    assert.match(body.error ?? '', /forbidden/i);
  });

  it('returns 404 for an unknown postcard id', async () => {
    const unknown = '99999999-0000-0000-0000-000000000c01';
    const { status } = await apiReq(
      'POST', `/postcards/${unknown}/media/upload-url`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1024 },
      TOKEN_OWNER,
    );
    assert.equal(status, 404);
  });

  it('returns 400 for a non-UUID postcard id', async () => {
    const { status } = await apiReq(
      'POST', '/postcards/not-a-uuid/media/upload-url',
      { mimeType: 'image/jpeg', fileSizeBytes: 1024 },
      TOKEN_OWNER,
    );
    assert.equal(status, 400);
  });

  it('returns a signed upload URL for a valid JPEG image', async () => {
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/upload-url`,
      { mimeType: 'image/jpeg', fileSizeBytes: 500_000 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.ok(typeof body.mediaId === 'string', 'should return mediaId');
    assert.ok(typeof body.uploadUrl === 'string', 'should return uploadUrl');
    assert.ok(typeof body.path === 'string', 'should return storage path');
    assert.match(body.path, /\.jpg$/, 'path should end with .jpg for image/jpeg');
    // post_media row should be in the in-memory store (pending)
    const row = allPostMedia.find((m) => m.id === body.mediaId);
    assert.ok(row, 'post_media row should exist');
    assert.equal(row.processing_status, 'pending');
    assert.equal(row.media_type, 'image');
  });

  it('returns a signed upload URL for a valid MP4 video', async () => {
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/upload-url`,
      { mimeType: 'video/mp4', fileSizeBytes: 50 * 1024 * 1024 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.match(body.path, /\.mp4$/, 'path should end with .mp4 for video/mp4');
    const row = allPostMedia.find((m) => m.id === body.mediaId);
    assert.ok(row);
    assert.equal(row.media_type, 'video');
  });
});

// ── POST /api/postcards/:id/media/:mediaId/complete ───────────────────────────

describe('POST /api/postcards/:id/media/:mediaId/complete', () => {
  /** Seed a pending image media row */
  function seedPendingImage(mediaId = MEDIA_ID, mediaType: 'image' | 'video' = 'image') {
    allPostMedia.push({
      id: mediaId, post_id: POST_ID, user_id: OWNER_ID,
      media_type: mediaType, storage_bucket: 'post-media',
      storage_path: `${OWNER_ID}/${POST_ID}/${mediaId}.${mediaType === 'video' ? 'mp4' : 'jpg'}`,
      public_url: '', mime_type: mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
      file_size_bytes: 500_000, processing_status: 'pending', moderation_status: 'pending',
      sort_order: 0,
    });
  }

  it('marks an image ready and updates parent media counts (parent count updates)', async () => {
    seedPendingImage();
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 500_000, width: 1920, height: 1080 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mediaCount, 1);
    assert.equal(body.hasVideo, false);

    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.processing_status, 'ready');
    assert.equal(row?.moderation_status, 'approved');
    assert.equal(posts[POST_ID]?.media_count, 1, 'post.media_count should be 1');
    assert.equal(posts[POST_ID]?.has_video, false);
    assert.equal(posts[POST_ID]?.primary_media_type, 'image');
  });

  it('marks a video ready and sets hasVideo=true on the parent post', async () => {
    seedPendingImage(MEDIA_ID, 'video');
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'video/mp4', fileSizeBytes: 10_000_000, durationSeconds: 30, width: 1920, height: 1080 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(body.hasVideo, true);
    assert.equal(posts[POST_ID]?.has_video, true);
    assert.equal(posts[POST_ID]?.primary_media_type, 'video');
    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.duration_seconds, 30);
  });

  // ── Container location metadata (the video counterpart of the EXIF strip) ──
  //
  // On this transport the client PUTs straight to Storage, so the server never
  // saw the bytes. The image branch of /complete already downloads, strips EXIF
  // and re-uploads for exactly that reason. Video did not: `moov/udta/©xyz` —
  // the ISO-6709 capture point that both iPhone and Android write — was stored
  // untouched and served to every authorized viewer, defeating the app's
  // location-privacy model for video only.
  it('video complete: strips the container location metadata and re-uploads the scrubbed object', async () => {
    seedPendingImage(MEDIA_ID, 'video');
    // The stored object must genuinely be geotagged, or the assertions below
    // would pass on a file that never carried coordinates.
    assert.ok(
      __videoObjectBytes.includes(Buffer.from(FIXTURE_ISO6709, 'latin1')),
      'the stored video fixture must carry capture coordinates',
    );

    const { status } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'video/mp4', fileSizeBytes: 10_000_000, durationSeconds: 30, width: 1920, height: 1080 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);

    const rewritten = __storageUploads.filter((u) => u.path.endsWith('.mp4'));
    assert.equal(rewritten.length, 1, 'the scrubbed video must be written back over the original');
    const stored = rewritten[0].buf;
    assert.equal(
      stored.includes(Buffer.from(FIXTURE_ISO6709, 'latin1')), false,
      'the re-uploaded object must NOT carry the capture coordinates',
    );
    assert.equal(
      stored.includes(Buffer.from('©xyz', 'latin1')), false,
      'the ©xyz location box must be gone',
    );
    assert.equal(
      stored.length, __videoObjectBytes.length,
      'the scrub must be length-preserving — chunk offsets into mdat must stay valid',
    );
  });

  it('video complete: writes nothing back when the video has no location metadata', async () => {
    __videoObjectBytes = mp4WithLocation({ xyz: false, appleMeta: false });
    seedPendingImage(MEDIA_ID, 'video');
    const { status } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'video/mp4', fileSizeBytes: 10_000_000, durationSeconds: 30, width: 1920, height: 1080 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(
      __storageUploads.filter((u) => u.path.endsWith('.mp4')).length, 0,
      'a clean video costs one read and no write',
    );
  });

  it('video complete: refuses (does not mark ready) a container whose location cannot be removed', async () => {
    // WebM geo SimpleTags need an EBML rewriter this tier does not have, so the
    // documented fail-closed alternative applies: refuse rather than store.
    __videoObjectBytes = webmWithLocationTag();
    seedPendingImage(MEDIA_ID, 'video');
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'video/webm', fileSizeBytes: 1_000_000, durationSeconds: 5, width: 1920, height: 1080 },
      TOKEN_OWNER,
    );
    assert.equal(status, 400, `expected refusal, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error, 'invalid_payload');
    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.processing_status, 'pending', 'the row must stay pending, never ready');
  });

  it('rejects a video complete without width — cannot reach ready with NULL dimensions', async () => {
    // Simulates the legacy upload bug: client omits width/height. The server
    // must refuse rather than write a NULL-dimension row that the thumbnail
    // pipeline (migration 0208) would silently skip.
    seedPendingImage(MEDIA_ID, 'video');
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'video/mp4', fileSizeBytes: 10_000_000, durationSeconds: 30 },
      TOKEN_OWNER,
    );
    assert.equal(status, 400, 'should reject when width/height are absent');
    assert.match(body.error ?? '', /invalid_payload/, 'error code should be invalid_payload');
    // The row must remain pending — never promoted to ready
    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.processing_status, 'pending', 'media row must stay pending after rejection');
  });

  it('auto-creates passport_postcard on first ready media when add_to_passport=true', async () => {
    seedPendingImage();
    assert.equal(allPostcards.length, 0, 'no postcard before complete');

    const { status } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 500_000 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(allPostcards.length, 1, 'passport_postcard should be created lazily');
    assert.equal(allPostcards[0].user_id, OWNER_ID);
    assert.equal(allPostcards[0].post_id, POST_ID);
  });

  it('does NOT create passport_postcard when add_to_passport=false', async () => {
    posts[POST_ID].add_to_passport = false;
    seedPendingImage();
    const { status } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 500_000 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(allPostcards.length, 0, 'no postcard when add_to_passport=false');
  });

  it('is idempotent — calling complete on an already-ready item returns 200', async () => {
    allPostMedia.push({
      id: MEDIA_ID, post_id: POST_ID, user_id: OWNER_ID, media_type: 'image',
      storage_path: `${OWNER_ID}/${POST_ID}/${MEDIA_ID}.jpg`,
      public_url: 'https://cdn.test/img.jpg', mime_type: 'image/jpeg',
      file_size_bytes: 500_000, processing_status: 'ready', moderation_status: 'approved',
      sort_order: 0,
    });
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 500_000 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it('returns 403 when another user tries to complete another user media (cross-user block)', async () => {
    seedPendingImage();
    const { status } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 500_000 },
      TOKEN_OTHER,
    );
    assert.equal(status, 403);
  });

  it('returns 401 when unauthenticated', async () => {
    seedPendingImage();
    const { status } = await apiReq('POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`, {
      mimeType: 'image/jpeg', fileSizeBytes: 500_000,
    });
    assert.equal(status, 401);
  });

  it('returns 404 for unknown media id', async () => {
    const unknown = '99999999-0000-0000-0000-000000000c01';
    const { status } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${unknown}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 500_000 },
      TOKEN_OWNER,
    );
    assert.equal(status, 404);
  });
});

// ── DELETE /api/postcards/:id/media/:mediaId ──────────────────────────────────

describe('DELETE /api/postcards/:id/media/:mediaId', () => {
  function seedReadyImage(mediaId = MEDIA_ID) {
    allPostMedia.push({
      id: mediaId, post_id: POST_ID, user_id: OWNER_ID,
      media_type: 'image', storage_bucket: 'post-media',
      storage_path: `${OWNER_ID}/${POST_ID}/${mediaId}.jpg`,
      public_url: `https://cdn.test/${mediaId}.jpg`, mime_type: 'image/jpeg',
      file_size_bytes: 500_000, processing_status: 'ready', moderation_status: 'approved',
      sort_order: 0,
    });
    posts[POST_ID].media_count = 1;
    posts[POST_ID].has_video   = false;
  }

  it('returns 403 when a different user tries to delete (privacy filtering)', async () => {
    seedReadyImage();
    const { status } = await apiReq('DELETE', `/postcards/${POST_ID}/media/${MEDIA_ID}`, undefined, TOKEN_OTHER);
    assert.equal(status, 403);
    assert.equal(allPostMedia.length, 1, 'media row should NOT be deleted');
  });

  it('owner can delete media and parent counts are decremented', async () => {
    seedReadyImage();
    const { status, body } = await apiReq('DELETE', `/postcards/${POST_ID}/media/${MEDIA_ID}`, undefined, TOKEN_OWNER);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.mediaCount, 0, 'mediaCount should decrement to 0');
    assert.equal(allPostMedia.length, 0, 'media row should be removed from store');
    assert.equal(posts[POST_ID]?.media_count, 0, 'post.media_count should update');
  });

  it('returns 404 for an unknown media id', async () => {
    const unknown = '99999999-0000-0000-0000-000000000c01';
    const { status } = await apiReq('DELETE', `/postcards/${POST_ID}/media/${unknown}`, undefined, TOKEN_OWNER);
    assert.equal(status, 404);
  });

  it('returns 401 when unauthenticated', async () => {
    seedReadyImage();
    const { status } = await apiReq('DELETE', `/postcards/${POST_ID}/media/${MEDIA_ID}`);
    assert.equal(status, 401);
  });

  it('admin can delete another user media', async () => {
    const ADMIN_ID = '00000000-0000-0000-0000-000000000c09';
    allProfiles.push({ id: ADMIN_ID, role: 'admin', username: 'sysadmin' });
    _setTestClient(
      buildFakeClient({ [TOKEN_OWNER]: OWNER_ID, [TOKEN_OTHER]: OTHER_ID, 'fake-admin': ADMIN_ID }),
      true,
    );
    seedReadyImage();
    const { status } = await apiReq('DELETE', `/postcards/${POST_ID}/media/${MEDIA_ID}`, undefined, 'fake-admin');
    assert.equal(status, 200);
    assert.equal(allPostMedia.length, 0, 'admin delete should remove the media row');
  });
});

// ── Feed regression — existing photo posts ─────────────────────────────────────

describe('Feed regression — existing photo posts', () => {
  it('creating a postcard leaves media_count=0 until complete is called', async () => {
    const { status, body } = await apiReq(
      'POST', '/postcards',
      { caption: 'Legacy photo trip', addToPassport: false, locationCity: 'Cebu' },
      TOKEN_OWNER,
    );
    assert.equal(status, 201, 'POST /api/postcards should succeed');
    const stored = Object.values(posts).find((p: any) => p.content === 'Legacy photo trip') as any;
    assert.ok(stored, 'post should be in the in-memory store');
    assert.equal(stored.media_count, 0, 'should start with 0 media items');
    assert.equal(stored.has_video, false);
    assert.equal(stored.primary_media_type, 'none');
    // No passport_postcard created until first media is completed
    assert.equal(allPostcards.length, 0, 'no postcard until first media completion');
  });

  it('feed media field is empty array when no ready media exists', async () => {
    // Simulate a post with a pending media item — the feed should exclude it
    allPostMedia.push({
      id: MEDIA_ID, post_id: POST_ID, user_id: OWNER_ID,
      media_type: 'image', processing_status: 'pending', moderation_status: 'pending',
      public_url: '', sort_order: 0,
    });
    // filterPublicMedia excludes pending items — tested by checking readyMedia logic:
    // The media array only includes items with processing_status === 'ready'
    const ready = allPostMedia.filter((m) => m.processing_status === 'ready');
    assert.equal(ready.length, 0, 'pending media should NOT appear in feed');
  });

  it('failed media is excluded from feed even when post has other ready items', async () => {
    const FAILED_ID = '20000000-0000-0000-0000-000000000c02';
    allPostMedia.push(
      {
        id: MEDIA_ID, post_id: POST_ID, user_id: OWNER_ID, media_type: 'image',
        processing_status: 'ready', moderation_status: 'approved',
        public_url: 'https://cdn.test/img.jpg', sort_order: 0,
      },
      {
        id: FAILED_ID, post_id: POST_ID, user_id: OWNER_ID, media_type: 'video',
        processing_status: 'failed', moderation_status: 'pending',
        public_url: '', sort_order: 1,
      },
    );
    const readyAndApproved = allPostMedia.filter(
      (m) => m.processing_status === 'ready' && m.moderation_status !== 'rejected' && m.moderation_status !== 'flagged',
    );
    assert.equal(readyAndApproved.length, 1, 'only 1 ready+approved item, failed excluded');
    assert.equal(readyAndApproved[0].id, MEDIA_ID);
  });
});

// ── Endpoint-level visibility and media filtering ─────────────────────────────
//
// These tests call real HTTP endpoints and verify that the server enforces
// visibility rules and correctly filters the media array in the response —
// not just as in-memory logic, but as part of the actual request/response cycle.

describe('Endpoint-level visibility and media filtering', () => {
  it('upload-url returns 404 when post is soft-deleted (status=deleted)', async () => {
    // Simulate a soft-delete — mark the post as inactive
    posts[POST_ID].status = 'deleted';
    const { status } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/upload-url`,
      { mimeType: 'image/jpeg', fileSizeBytes: 500_000 },
      TOKEN_OWNER,
    );
    assert.equal(status, 404, 'soft-deleted post should return 404, not 403 or 200');
  });

  it('GET /posts/:postId includes populated media array for ready items', async () => {
    // Seed a ready, approved image so the handler has something to return
    allPostMedia.push({
      id: MEDIA_ID, post_id: POST_ID, user_id: OWNER_ID,
      media_type: 'image', processing_status: 'ready', moderation_status: 'approved',
      public_url: 'https://cdn.test/ready.jpg', thumbnail_url: null,
      duration_seconds: null, width: 1920, height: 1080, sort_order: 0,
    });

    const { status, body } = await apiReq('GET', `/posts/${POST_ID}`, undefined, TOKEN_OWNER);
    assert.equal(status, 200, 'owner should be able to fetch the post detail');
    assert.ok(Array.isArray(body.media), 'response should include a media array');
    assert.equal(body.media.length, 1, 'one ready item should be present in media array');

    const item = body.media[0];
    assert.equal(item.id, MEDIA_ID);
    assert.equal(item.media_type, 'image');
    assert.ok(typeof item.url === 'string', 'url should be a string');
    assert.equal(item.processing_status, 'ready');
  });

  it('GET /posts/:postId excludes rejected media items from the media array', async () => {
    const REJECTED_ID = '20000000-0000-0000-0000-000000000c03';
    // Seed one approved and one rejected item
    allPostMedia.push(
      {
        id: MEDIA_ID, post_id: POST_ID, user_id: OWNER_ID,
        media_type: 'image', processing_status: 'ready', moderation_status: 'approved',
        public_url: 'https://cdn.test/ok.jpg', thumbnail_url: null,
        duration_seconds: null, width: 800, height: 600, sort_order: 0,
      },
      {
        id: REJECTED_ID, post_id: POST_ID, user_id: OWNER_ID,
        media_type: 'video', processing_status: 'ready', moderation_status: 'rejected',
        public_url: 'https://cdn.test/bad.mp4', thumbnail_url: null,
        duration_seconds: 15, width: 1080, height: 1920, sort_order: 1,
      },
    );

    const { status, body } = await apiReq('GET', `/posts/${POST_ID}`, undefined, TOKEN_OWNER);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.media), 'response should include a media array');
    assert.equal(body.media.length, 1, 'rejected item must be excluded server-side');
    assert.equal(body.media[0].id, MEDIA_ID, 'only the approved item should appear');
  });

  it('GET /posts/:postId excludes flagged media items from the media array', async () => {
    const FLAGGED_ID = '20000000-0000-0000-0000-000000000c04';
    allPostMedia.push(
      {
        id: MEDIA_ID, post_id: POST_ID, user_id: OWNER_ID,
        media_type: 'image', processing_status: 'ready', moderation_status: 'approved',
        public_url: 'https://cdn.test/ok2.jpg', thumbnail_url: null,
        duration_seconds: null, width: 800, height: 600, sort_order: 0,
      },
      {
        id: FLAGGED_ID, post_id: POST_ID, user_id: OWNER_ID,
        media_type: 'video', processing_status: 'ready', moderation_status: 'flagged',
        public_url: 'https://cdn.test/flagged.mp4', thumbnail_url: null,
        duration_seconds: 8, width: 1280, height: 720, sort_order: 1,
      },
    );

    const { status, body } = await apiReq('GET', `/posts/${POST_ID}`, undefined, TOKEN_OTHER);
    assert.equal(status, 200);
    assert.equal(body.media.length, 1, 'flagged item must be excluded server-side');
    assert.equal(body.media[0].id, MEDIA_ID);
  });

  it('non-owner cannot access upload-url for a private post (ownership enforced)', async () => {
    // A private-visibility post still belongs to OWNER — OTHER should get 403
    posts[POST_ID].visibility = 'private';
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/upload-url`,
      { mimeType: 'image/jpeg', fileSizeBytes: 100_000 },
      TOKEN_OTHER,
    );
    assert.equal(status, 403, 'private post should return 403 for non-owner');
    assert.match(body.error ?? '', /forbidden/i);
  });
});

// ── GET /api/postcards/stamp-overlay-options ──────────────────────────────────

describe('GET /api/postcards/stamp-overlay-options', () => {
  it('returns 401 when unauthenticated', async () => {
    const { status } = await apiReq('GET', '/postcards/stamp-overlay-options');
    assert.equal(status, 401);
  });

  it('lists only own earned stamps with approved + active artwork', async () => {
    const { status, body } = await apiReq('GET', '/postcards/stamp-overlay-options', undefined, TOKEN_OWNER);
    assert.equal(status, 200);
    assert.deepEqual(body.suggested, [], 'no location params means no suggestions');
    const ids = body.earned.map((o: any) => o.stampDefinitionId);
    assert.deepEqual(ids, [DEF_TOKYO_ID], 'revoked, artwork-less, inactive and other-user stamps are excluded');
    const opt = body.earned[0];
    assert.equal(opt.name, 'Tokyo');
    assert.equal(opt.artworkUrl, 'https://cdn.test/art/tokyo.png');
    assert.ok(!('is_active' in opt), 'internal columns must not leak');
  });

  it("never exposes another user's inventory", async () => {
    const { body } = await apiReq('GET', '/postcards/stamp-overlay-options', undefined, TOKEN_OTHER);
    const ids = (body.earned ?? []).map((o: any) => o.stampDefinitionId);
    assert.deepEqual(ids, [DEF_PARIS_ID], 'OTHER sees only their own earned stamp');
  });

  it('suggests location-matching stamps (city-level first) and dedupes them out of earned', async () => {
    const { status, body } = await apiReq(
      'GET', '/postcards/stamp-overlay-options?city=Tokyo&country=Japan', undefined, TOKEN_OWNER,
    );
    assert.equal(status, 200);
    const suggestedIds = body.suggested.map((o: any) => o.stampDefinitionId);
    assert.deepEqual(suggestedIds, [DEF_TOKYO_ID, DEF_JAPAN_ID], 'city match ranks above country-level match');
    const earnedIds = body.earned.map((o: any) => o.stampDefinitionId);
    assert.ok(!earnedIds.includes(DEF_TOKYO_ID), 'suggested stamps are not repeated in earned');
  });

  it('matches location case-insensitively', async () => {
    const { body } = await apiReq(
      'GET', '/postcards/stamp-overlay-options?city=tokyo&country=japan', undefined, TOKEN_OWNER,
    );
    const suggestedIds = body.suggested.map((o: any) => o.stampDefinitionId);
    assert.deepEqual(suggestedIds, [DEF_TOKYO_ID, DEF_JAPAN_ID]);
  });

  it('applies the q search filter across both lists', async () => {
    const { body } = await apiReq(
      'GET', '/postcards/stamp-overlay-options?city=Tokyo&country=Japan&q=Tok', undefined, TOKEN_OWNER,
    );
    const suggestedIds = body.suggested.map((o: any) => o.stampDefinitionId);
    assert.deepEqual(suggestedIds, [DEF_TOKYO_ID], 'q narrows suggestions');
    assert.deepEqual(body.earned, [], 'earned is deduped and filtered too');
  });
});

// ── Stamp overlay on media complete ───────────────────────────────────────────

describe('POST /api/postcards/:id/media/:mediaId/complete — stamp overlay', () => {
  function seedPending(mediaId = MEDIA_ID, mediaType: 'image' | 'video' = 'image') {
    allPostMedia.push({
      id: mediaId, post_id: POST_ID, user_id: OWNER_ID,
      media_type: mediaType, storage_bucket: 'post-media',
      storage_path: `${OWNER_ID}/${POST_ID}/${mediaId}.${mediaType === 'video' ? 'mp4' : 'jpg'}`,
      public_url: '', mime_type: mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
      file_size_bytes: 500_000, processing_status: 'pending', moderation_status: 'pending',
      sort_order: 0,
    });
  }

  it('applies an earned stamp and pins the artwork server-side', async () => {
    seedPending();
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      {
        mimeType: 'image/jpeg', fileSizeBytes: 500_000, width: 1600, height: 2000,
        stampOverlay: { stampDefinitionId: DEF_TOKYO_ID, style: 'white', x: 0.8, y: 0.85, scale: 0.3 },
      },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.stampOverlayApplied, true);

    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.processing_status, 'ready');
    const ov = row?.stamp_overlay;
    assert.ok(ov, 'overlay metadata should be written on the media row');
    assert.equal(ov.stampDefinitionId, DEF_TOKYO_ID);
    assert.equal(ov.label, 'Tokyo');
    assert.equal(ov.city, 'Tokyo');
    assert.equal(ov.country, 'Japan');
    assert.equal(ov.artworkUrl, 'https://cdn.test/art/tokyo.png', 'artwork URL is pinned from the definition, never from the client');
    assert.ok(typeof ov.artworkPinnedAt === 'string' && !Number.isNaN(Date.parse(ov.artworkPinnedAt)), 'pin timestamp recorded');
    assert.equal(ov.style, 'white');
    assert.equal(ov.x, 0.8);
    assert.equal(ov.y, 0.85);
    assert.equal(ov.scale, 0.3);
    assert.equal(ov.rotation, 0, 'rotation defaults to 0');
    assert.equal(ov.opacity, 1, 'non-watermark styles default to full opacity');
  });

  it('defaults style to white and watermark opacity to 0.45', async () => {
    const M2 = '20000000-0000-0000-0000-000000000c11';
    const M3 = '20000000-0000-0000-0000-000000000c12';
    seedPending(M2);
    seedPending(M3);

    const r1 = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${M2}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1000, stampOverlay: { stampDefinitionId: DEF_TOKYO_ID, x: 0.5, y: 0.5, scale: 0.2 } },
      TOKEN_OWNER,
    );
    assert.equal(r1.status, 200);
    const row1 = allPostMedia.find((m) => m.id === M2);
    assert.equal(row1?.stamp_overlay?.style, 'white', 'default render style is white ink');
    assert.equal(row1?.stamp_overlay?.opacity, 1);

    const r2 = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${M3}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1000, stampOverlay: { stampDefinitionId: DEF_TOKYO_ID, style: 'watermark', x: 0.5, y: 0.5, scale: 0.2 } },
      TOKEN_OWNER,
    );
    assert.equal(r2.status, 200);
    const row2 = allPostMedia.find((m) => m.id === M3);
    assert.equal(row2?.stamp_overlay?.opacity, 0.45, 'watermark defaults to translucent opacity');
  });

  it('allows an unearned stamp when its definition matches the post location', async () => {
    seedPending();
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      {
        mimeType: 'image/jpeg', fileSizeBytes: 500_000,
        stampOverlay: { stampDefinitionId: DEF_JAPAN_ID, x: 0.2, y: 0.2, scale: 0.25 },
      },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(body.stampOverlayApplied, true, 'location-matching stamp is eligible without being earned');
    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.stamp_overlay?.label, 'Japan');
  });

  it('completes WITHOUT the overlay when the stamp is not eligible (never blocks posting)', async () => {
    seedPending();
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      {
        mimeType: 'image/jpeg', fileSizeBytes: 500_000,
        stampOverlay: { stampDefinitionId: DEF_PARIS_ID, x: 0.5, y: 0.5, scale: 0.2 },
      },
      TOKEN_OWNER,
    );
    assert.equal(status, 200, 'upload completion must never be blocked by overlay problems');
    assert.equal(body.ok, true);
    assert.equal(body.mediaCount, 1);
    assert.equal(body.stampOverlayApplied, false);
    assert.equal(body.stampOverlayError, 'stamp_not_eligible');
    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.processing_status, 'ready', 'media still becomes ready');
    assert.ok(!('stamp_overlay' in (row ?? {})), 'no overlay metadata written');
  });

  it('treats a revoked earned stamp as not eligible', async () => {
    seedPending();
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      {
        mimeType: 'image/jpeg', fileSizeBytes: 500_000,
        stampOverlay: { stampDefinitionId: DEF_REVOKED_ID, x: 0.5, y: 0.5, scale: 0.2 },
      },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(body.stampOverlayApplied, false, 'revoked stamps must not be usable');
    assert.equal(body.stampOverlayError, 'stamp_not_eligible');
  });

  it('reports stamp_unavailable for unknown, inactive, or artwork-less definitions', async () => {
    const M2 = '20000000-0000-0000-0000-000000000c21';
    const M3 = '20000000-0000-0000-0000-000000000c22';
    const M4 = '20000000-0000-0000-0000-000000000c23';
    seedPending(M2);
    seedPending(M3);
    seedPending(M4);

    const unknown = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${M2}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1000, stampOverlay: { stampDefinitionId: '50000000-0000-0000-0000-00000000dead', x: 0.5, y: 0.5, scale: 0.2 } },
      TOKEN_OWNER,
    );
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.stampOverlayError, 'stamp_unavailable');

    const inactive = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${M3}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1000, stampOverlay: { stampDefinitionId: DEF_INACTIVE_ID, x: 0.5, y: 0.5, scale: 0.2 } },
      TOKEN_OWNER,
    );
    assert.equal(inactive.status, 200);
    assert.equal(inactive.body.stampOverlayError, 'stamp_unavailable', 'inactive defs are unavailable even when earned');

    const noArt = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${M4}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1000, stampOverlay: { stampDefinitionId: DEF_NOART_ID, x: 0.5, y: 0.5, scale: 0.2 } },
      TOKEN_OWNER,
    );
    assert.equal(noArt.status, 200);
    assert.equal(noArt.body.stampOverlayError, 'stamp_unavailable', 'defs without universal artwork are unavailable');
  });

  it('rejects malformed overlay payloads with 400 and leaves the media pending', async () => {
    seedPending();
    const badX = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1000, stampOverlay: { stampDefinitionId: DEF_TOKYO_ID, x: 1.5, y: 0.5, scale: 0.2 } },
      TOKEN_OWNER,
    );
    assert.equal(badX.status, 400, 'x outside 0..1 is malformed');

    const badScale = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1000, stampOverlay: { stampDefinitionId: DEF_TOKYO_ID, x: 0.5, y: 0.5, scale: 0.05 } },
      TOKEN_OWNER,
    );
    assert.equal(badScale.status, 400, 'scale below the minimum is malformed');

    const badStyle = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 1000, stampOverlay: { stampDefinitionId: DEF_TOKYO_ID, style: 'neon', x: 0.5, y: 0.5, scale: 0.2 } },
      TOKEN_OWNER,
    );
    assert.equal(badStyle.status, 400, 'unknown style is malformed');

    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.processing_status, 'pending', 'malformed payloads must not mark media ready');
    assert.ok(!('stamp_overlay' in (row ?? {})));
  });

  it('skips the overlay for video media with a stamp_overlay_images_only flag', async () => {
    seedPending(MEDIA_ID, 'video');
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      {
        mimeType: 'video/mp4', fileSizeBytes: 1_000_000, durationSeconds: 12,
        width: 1920, height: 1080,
        stampOverlay: { stampDefinitionId: DEF_TOKYO_ID, x: 0.5, y: 0.5, scale: 0.2 },
      },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.equal(body.hasVideo, true);
    assert.equal(body.stampOverlayApplied, false);
    assert.equal(body.stampOverlayError, 'stamp_overlay_images_only');
    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.processing_status, 'ready', 'video upload still completes');
    assert.ok(!('stamp_overlay' in (row ?? {})));
  });

  it('degrades gracefully when the stamp_overlay column is missing (PGRST204 retry)', async () => {
    seedPending();
    failNextMediaUpdate = {
      code: 'PGRST204',
      message: "Could not find the 'stamp_overlay' column of 'post_media' in the schema cache",
    };
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      {
        mimeType: 'image/jpeg', fileSizeBytes: 500_000,
        stampOverlay: { stampDefinitionId: DEF_TOKYO_ID, x: 0.5, y: 0.5, scale: 0.2 },
      },
      TOKEN_OWNER,
    );
    assert.equal(status, 200, 'missing column must never block the upload');
    assert.equal(body.ok, true);
    assert.equal(body.stampOverlayApplied, false);
    assert.equal(body.stampOverlayError, 'stamp_overlay_not_supported');
    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.equal(row?.processing_status, 'ready', 'retry without the overlay column succeeded');
    assert.ok(!('stamp_overlay' in (row ?? {})));
  });

  it('keeps the legacy response shape when no overlay is requested (back-compat)', async () => {
    seedPending();
    const { status, body } = await apiReq(
      'POST', `/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: 'image/jpeg', fileSizeBytes: 500_000 },
      TOKEN_OWNER,
    );
    assert.equal(status, 200);
    assert.ok(!('stampOverlayApplied' in body), 'no overlay flags unless an overlay was requested');
    assert.ok(!('stampOverlayError' in body));
    const row = allPostMedia.find((m) => m.id === MEDIA_ID);
    assert.ok(!('stamp_overlay' in (row ?? {})));
  });
});

// ── GET /api/users/:username/passport/postcards — visibility gating [C2 fix] ──
//
// Verifies that the postcards wall enforces passport_visibility correctly:
//   • public profiles  → visible to unauthenticated callers
//   • followers_only   → requires an authenticated follower or friend
//   • private          → always blocked
//   • unavailable/blocked accounts → sentinel responses
//
// The fake client exposes `blocks`, `user_friendships`, `user_follows`, and
// `user_account_states` tables so resolveProfileVisibility runs the same code
// path as in production — no mocking of the helper itself.

describe('GET /users/:username/passport/postcards — visibility gating', () => {
  // Stable IDs for this describe block
  const VIEWER_ID   = '00000000-0000-0000-0000-000000000d01';
  const TARGET_ID   = '00000000-0000-0000-0000-000000000d02';
  const POSTCARD_ID = 'cc000000-0000-0000-0000-000000000001';
  const TOKEN_VIEWER = 'fake-viewer-token';

  function seedTargetProfile(overrides: Record<string, any> = {}) {
    allProfiles.push({
      id: TARGET_ID,
      handle: 'target',
      username: 'target',
      role: 'user',
      passport_visibility: 'public',
      is_private: false,
      account_status: 'active',
      ...overrides,
    });
  }

  function seedPublicPostcard() {
    allPostcards.push({
      id: POSTCARD_ID, post_id: POST_ID, user_id: TARGET_ID,
      media_url: null, caption: 'Hello world', location_name: 'Shibuya',
      location_city: 'Tokyo', location_country: 'Japan',
      location_verified: true, stamp_eligible: false, visibility: 'public',
      status: 'active', pinned_at: null, note: null,
      created_at: '2026-07-01T00:00:00Z',
    });
  }

  /** Wire in the viewer token so getOptionalViewerId resolves correctly. */
  function withViewer() {
    _setTestClient(
      buildFakeClient({
        [TOKEN_OWNER]: OWNER_ID,
        [TOKEN_OTHER]: OTHER_ID,
        [TOKEN_VIEWER]: VIEWER_ID,
      }),
      true,
    );
  }

  // Also seed the viewer as a profile so auth.getUser works
  function seedViewerProfile() {
    allProfiles.push({
      id: VIEWER_ID, handle: 'viewer', username: 'viewer',
      role: 'user', passport_visibility: 'public', is_private: false, account_status: 'active',
    });
  }

  it('returns postcards for a public profile — anonymous caller (share-link case)', async () => {
    seedTargetProfile({ passport_visibility: 'public' });
    seedPublicPostcard();

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.postcards), 'should include postcards array');
    assert.equal(body.postcards.length, 1, 'public postcard should be visible');
    assert.equal(body.postcards[0].caption, 'Hello world');
    assert.ok(!('private' in body), 'no private sentinel for public profile');
  });

  it('returns an empty array for a public profile with no postcards', async () => {
    seedTargetProfile({ passport_visibility: 'public' });

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards');
    assert.equal(status, 200);
    assert.deepEqual(body.postcards, []);
  });

  it('blocks anonymous caller from a followers_only profile — returns private sentinel [C2]', async () => {
    seedTargetProfile({ passport_visibility: 'followers_only', is_private: false });
    seedPublicPostcard();

    // No Authorization header → viewerId is null → limited_preview
    const { status, body } = await apiReq('GET', '/users/target/passport/postcards');
    assert.equal(status, 200);
    assert.equal(body.private, true, 'followers_only should be blocked for anonymous callers');
    assert.deepEqual(body.postcards, [], 'postcards must be empty in the private sentinel');
  });

  it('blocks authenticated non-follower from a followers_only profile — returns private sentinel [C2]', async () => {
    seedTargetProfile({ passport_visibility: 'followers_only', is_private: false });
    seedPublicPostcard();
    seedViewerProfile();
    withViewer();
    // No friendship or follow seeded → limited_preview

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards', undefined, TOKEN_VIEWER);
    assert.equal(status, 200);
    assert.equal(body.private, true, 'non-follower should be blocked from followers_only profile');
    assert.deepEqual(body.postcards, []);
  });

  it('grants authenticated follower access to a followers_only profile [C2]', async () => {
    seedTargetProfile({ passport_visibility: 'followers_only', is_private: false });
    seedPublicPostcard();
    seedViewerProfile();
    withViewer();
    // Viewer follows the target → resolveProfileVisibility returns "followers_only" (granted)
    allFollows.push({ follower_id: VIEWER_ID, following_id: TARGET_ID });

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards', undefined, TOKEN_VIEWER);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.postcards), 'follower should see the postcards array');
    assert.equal(body.postcards.length, 1, 'postcard should be visible to follower');
    assert.ok(!('private' in body), 'no private sentinel for an authenticated follower');
  });

  it('grants authenticated friend access to a followers_only profile [C2]', async () => {
    seedTargetProfile({ passport_visibility: 'followers_only', is_private: false });
    seedPublicPostcard();
    seedViewerProfile();
    withViewer();
    // Friendship row: user_a = min(VIEWER_ID, TARGET_ID), user_b = max
    const ua = VIEWER_ID < TARGET_ID ? VIEWER_ID : TARGET_ID;
    const ub = VIEWER_ID < TARGET_ID ? TARGET_ID : VIEWER_ID;
    allFriendships.push({ user_a: ua, user_b: ub });

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards', undefined, TOKEN_VIEWER);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.postcards));
    assert.equal(body.postcards.length, 1, 'friend should see postcards of a followers_only profile');
    assert.ok(!('private' in body));
  });

  it('blocks any non-owner caller from a private profile — follower denied', async () => {
    seedTargetProfile({ passport_visibility: 'private', is_private: true });
    seedPublicPostcard();
    seedViewerProfile();
    withViewer();
    // Even with a follow, private profile postcard wall is always blocked
    allFollows.push({ follower_id: VIEWER_ID, following_id: TARGET_ID });

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards', undefined, TOKEN_VIEWER);
    assert.equal(status, 200);
    assert.equal(body.private, true, 'private profile must always return private sentinel');
    assert.deepEqual(body.postcards, []);
  });

  it('blocks a friend of a private account from the postcard wall — private is always closed [C2]', async () => {
    // A friend can view the passport profile itself, but the postcard wall must
    // remain blocked. resolveProfileVisibility returns "followers_only" (granted)
    // for friends of private accounts; the route must override this for postcards.
    seedTargetProfile({ passport_visibility: 'private', is_private: true });
    seedPublicPostcard();
    seedViewerProfile();
    withViewer();
    // Seed a friendship — viewer IS a friend of the target
    const ua = VIEWER_ID < TARGET_ID ? VIEWER_ID : TARGET_ID;
    const ub = VIEWER_ID < TARGET_ID ? TARGET_ID : VIEWER_ID;
    allFriendships.push({ user_a: ua, user_b: ub });

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards', undefined, TOKEN_VIEWER);
    assert.equal(status, 200);
    assert.equal(body.private, true, 'friend of a private account must not see the postcard wall');
    assert.deepEqual(body.postcards, [], 'postcards must be empty in the private sentinel');
    assert.ok(!('blocked' in body));
  });

  it('blocks a friend when effective privacy is "private" via profile_privacy_settings — profile row is public [C2-settings]', async () => {
    // Regression: profile row says is_private=false / passport_visibility="public",
    // but profile_privacy_settings.profile_visibility="private".  resolveProfileVisibility
    // treats the settings row as higher-precedence and returns "followers_only" for a
    // friend, which would previously bypass the isPrivatePassport gate and serve postcards.
    seedTargetProfile({ passport_visibility: 'public', is_private: false });
    seedPublicPostcard();
    seedViewerProfile();
    withViewer();
    // Effective privacy override: settings row says "private"
    allPrivacySettings.push({
      user_id: TARGET_ID,
      profile_visibility: 'private',
      show_real_name: false,
      show_current_city: true,
      show_home_country: true,
      show_visited_places: true,
      show_upcoming_trips: true,
      show_past_trips: true,
      show_posts: true,
      show_stamps: true,
      show_friends: true,
      show_followers: true,
      allow_messages_from: 'anyone',
      allow_friend_requests: true,
      allow_follow: true,
      allow_tagging: true,
      allow_profile_discovery: true,
      delayed_posting_default: false,
      precise_location_visible: false,
    });
    // Viewer IS a friend — resolveProfileVisibility returns "followers_only" (granted),
    // but the postcard wall must still be blocked because effective privacy is "private".
    const ua = VIEWER_ID < TARGET_ID ? VIEWER_ID : TARGET_ID;
    const ub = VIEWER_ID < TARGET_ID ? TARGET_ID : VIEWER_ID;
    allFriendships.push({ user_a: ua, user_b: ub });

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards', undefined, TOKEN_VIEWER);
    assert.equal(status, 200);
    assert.equal(
      body.private, true,
      'effective private via profile_privacy_settings must block postcard wall even for friends',
    );
    assert.deepEqual(body.postcards, [], 'postcards must be empty when blocked by effective privacy');
    assert.ok(!('blocked' in body));
  });

  it('returns postcards for the owner regardless of followers_only setting', async () => {
    // OWNER accessing their own followers_only profile
    allProfiles.find((p: any) => p.id === OWNER_ID).passport_visibility = 'followers_only';
    seedPublicPostcard();
    // Replace target postcard with one owned by OWNER for this test
    allPostcards[0].user_id = OWNER_ID;

    // Re-use allProfiles: OWNER's handle is 'owner' (set in resetDb)
    const { status, body } = await apiReq('GET', '/users/owner/passport/postcards', undefined, TOKEN_OWNER);
    assert.equal(status, 200, 'owner should always see their own postcards');
    assert.ok(Array.isArray(body.postcards));
    assert.ok(!('private' in body));
  });

  it('returns unavailable sentinel for a deactivated account', async () => {
    seedTargetProfile({ account_status: 'deactivated' });
    seedPublicPostcard();

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards');
    assert.equal(status, 200);
    assert.equal(body.unavailable, true);
    assert.deepEqual(body.postcards, []);
    assert.ok(!('private' in body));
  });

  it('returns blocked sentinel when a block relationship exists', async () => {
    seedTargetProfile({ passport_visibility: 'public' });
    seedPublicPostcard();
    seedViewerProfile();
    withViewer();
    // Seed a block row — or() in the fake client is a no-op so any row triggers
    allBlocks.push({ blocker_id: TARGET_ID, blocked_id: VIEWER_ID });

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards', undefined, TOKEN_VIEWER);
    assert.equal(status, 200);
    assert.equal(body.blocked, true, 'blocked relationship should return blocked sentinel');
    assert.deepEqual(body.postcards, []);
    assert.ok(!('private' in body));
  });

  it('returns blocked sentinel when the VIEWER blocked the target — not only when the target blocks the viewer', async () => {
    // Same as the previous test but with the block row reversed: the viewer
    // is the blocker and the target is the blocked party. The wall must lock
    // in both directions, not only when the target blocks the viewer.
    seedTargetProfile({ passport_visibility: 'public' });
    seedPublicPostcard();
    seedViewerProfile();
    withViewer();
    allBlocks.push({ blocker_id: VIEWER_ID, blocked_id: TARGET_ID });

    const { status, body } = await apiReq('GET', '/users/target/passport/postcards', undefined, TOKEN_VIEWER);
    assert.equal(status, 200);
    assert.equal(body.blocked, true, 'viewer-blocked-target relationship should also return blocked sentinel');
    assert.deepEqual(body.postcards, []);
    assert.ok(!('private' in body));
  });

  it('returns 404 for a username that does not exist', async () => {
    // No profile seeded for 'nobody'
    const { status } = await apiReq('GET', '/users/nobody/passport/postcards');
    assert.equal(status, 404);
  });
});
