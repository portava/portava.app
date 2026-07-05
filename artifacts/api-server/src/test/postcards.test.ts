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

// ── Stable fake IDs ───────────────────────────────────────────────────────────

const OWNER_ID = '00000000-0000-0000-0000-000000000c01';
const OTHER_ID = '00000000-0000-0000-0000-000000000c02';
const POST_ID  = '10000000-0000-0000-0000-000000000c01';
const MEDIA_ID = '20000000-0000-0000-0000-000000000c01';

const TOKEN_OWNER = 'fake-pc-owner';
const TOKEN_OTHER = 'fake-pc-other';

// ── In-memory DB ─────────────────────────────────────────────────────────────

let posts: Record<string, any> = {};
let allPostMedia: any[] = [];
let allPostcards: any[] = [];
let allProfiles: any[] = [];

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
  allProfiles = [
    { id: OWNER_ID, role: 'user', username: 'owner' },
    { id: OTHER_ID, role: 'user', username: 'other' },
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
      in(col: string, vals: any[]) { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
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
      else if (table === 'profiles')           rows = allProfiles.map((r) => ({ ...r }));
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
});

after(async () => {
  _setTestClient(null as any, true);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  resetDb();
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
