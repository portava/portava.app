/**
 * A postcard upload that could not be CHECKED must not be reported as a
 * postcard that FAILED the check.
 *
 * WHAT WAS WRONG
 * --------------
 * POST /api/postcards/:id/media/:mediaId/complete runs three different kinds of
 * check over the stored object, and one `try` used to wrap all of them:
 *
 *   sign the object  →  range-read 64 bytes  →  verify magic bytes  →  size ceiling
 *   \______________  our storage  __________/     \_ their file _/     \_ our rule _/
 *
 * A single `catch` answered every one of them with
 *
 *     400 invalid_payload  "Video could not be verified. Please re-upload."
 *
 * So a Storage outage — no signed URL, a 5xx on the range read, a socket that
 * never opened — told the uploader their VIDEO was broken, and offered the one
 * remedy that cannot work: the re-upload fails in the same place, because the
 * file was never the problem. An oversized video got the same sentence and was
 * never told the limit. The image branch and the location-scrub branch had the
 * identical shape ("Image could not be processed", "Video could not be
 * processed").
 *
 * WHAT THIS SUITE PINS
 * --------------------
 *   infrastructure → 503 degraded_unavailable, retryable, and the body must NOT
 *                    tell the user their file is bad
 *   content        → 400 invalid_payload, "please re-upload" (the true advice)
 *   policy         → 400 invalid_payload naming the actual size limit
 *
 * EVERY FAILURE CASE IS PAIRED WITH A HEALTHY ONE. A test where storage is down
 * and a test where the file is bad both end in "not 200", so a suite made only
 * of failures passes for the wrong reason; each block below therefore also
 * proves the same fixture completes with 200 when nothing is wrong.
 *
 * MUTATION-PROVEN: restoring the single `catch (err) { sendError(res,
 * 'invalid_payload', 'Video could not be verified…') }` flips every
 * infrastructure and policy assertion here.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/postcardsFailureClassification.test.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { _setTestClient } from '../lib/http.js';
import sharp from 'sharp';
import { mp4WithLocation } from './videoFixtures.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const POST_ID  = '22222222-2222-4222-8222-222222222222';
const IMG_ID   = '33333333-3333-4333-8333-333333333333';
const VID_ID   = '44444444-4444-4444-8444-444444444444';
const TOKEN    = 'tok-owner';

const __realFetch = globalThis.fetch;

// ── Fixtures ─────────────────────────────────────────────────────────────────

let __jpeg: Buffer;
/** 64-byte MP4 head: size box then "ftypisom". */
function mp4Head(): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(32, 0);
  b.write('ftypisom', 4, 'ascii');
  return b;
}

// ── Injectable storage / network conditions ──────────────────────────────────
//
// Each knob models ONE failure, so a test that expects 503 for a signing outage
// cannot be satisfied by an unrelated breakage somewhere else in the handler.
let signFails = false;          // createSignedUrl resolves with an error
let downloadFails = false;      // storage.download resolves with an error
let uploadFails = false;        // storage.upload resolves with an error
let probeStatus = 206;          // HTTP status the Range read answers with
let probeThrows = false;        // fetch rejects (socket/DNS)
let headBytes: Buffer;          // bytes the Range read serves
let totalBytes = 500_000;       // Content-Range total (the stored object size)
let imageBytes: Buffer;         // bytes storage.download returns for a .jpg
let videoBytes: Buffer;         // bytes storage.download returns for a .mp4

// ── In-memory rows ───────────────────────────────────────────────────────────

let posts: Record<string, any>;
let media: any[];
let postcards: any[];

function reset() {
  posts = {
    [POST_ID]: {
      id: POST_ID, author_id: OWNER_ID, status: 'active', visibility: 'public',
      content: 'c', add_to_passport: false,
      location_name: null, location_city: 'Tokyo', location_country: 'Japan',
      media_count: 0, has_video: false, primary_media_type: 'none',
    },
  };
  media = [
    { id: IMG_ID, user_id: OWNER_ID, post_id: POST_ID, media_type: 'image',
      storage_bucket: 'post-media', storage_path: `${OWNER_ID}/${POST_ID}/${IMG_ID}.jpg`,
      processing_status: 'uploading' },
    { id: VID_ID, user_id: OWNER_ID, post_id: POST_ID, media_type: 'video',
      storage_bucket: 'post-media', storage_path: `${OWNER_ID}/${POST_ID}/${VID_ID}.mp4`,
      processing_status: 'uploading' },
  ];
  postcards = [];
  signFails = false; downloadFails = false; uploadFails = false;
  probeStatus = 206; probeThrows = false;
  headBytes = mp4Head(); totalBytes = 500_000;
  imageBytes = __jpeg; videoBytes = mp4WithLocation();
}

// ── Fake supabase client ─────────────────────────────────────────────────────

function fakeClient() {
  function builder(table: string, rows: any[]): any {
    let filtered = [...rows];
    let ins: any[] | null = null;
    let upd: any = null;
    let del = false;
    let countMode = false;
    const b: any = {
      select(_c?: string, o?: any) { if (o?.count === 'exact' && o?.head) countMode = true; return b; },
      eq(c: string, v: any) { filtered = filtered.filter((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filtered = filtered.filter((r) => r[c] !== v); return b; },
      is(c: string, v: any) { filtered = filtered.filter((r) => r[c] === v); return b; },
      in(c: string, v: any[]) { filtered = filtered.filter((r) => v.includes(r[c])); return b; },
      or() { return b; }, order() { return b; }, ilike() { return b; },
      limit(n: number) { filtered = filtered.slice(0, n); return b; },
      insert(d: any) { ins = Array.isArray(d) ? d : [d]; return b; },
      update(d: any) { upd = d; return b; },
      delete() { del = true; return b; },
      async single() {
        if (ins) { const row = { ...ins[0], id: ins[0].id ?? globalThis.crypto.randomUUID() }; store(table, row); return { data: row, error: null }; }
        const base = filtered[0] ? { ...filtered[0] } : null;
        if (upd && base) Object.assign(base, upd);
        return { data: base, error: null };
      },
      async maybeSingle() { return b.single(); },
      then(resolve: any) {
        const cb = typeof resolve === 'function' ? resolve : (v: any) => v;
        if (ins) {
          const out = ins.map((r) => { const row = { ...r, id: r.id ?? globalThis.crypto.randomUUID() }; store(table, row); return row; });
          return cb({ data: out, error: null });
        }
        if (del) { if (table === 'post_media') { const ids = new Set(filtered.map((r) => r.id)); media = media.filter((r) => !ids.has(r.id)); } return cb({ data: null, error: null }); }
        if (upd) {
          for (const r of filtered) {
            if (table === 'posts' && posts[r.id]) Object.assign(posts[r.id], upd);
            else if (table === 'post_media') { const m = media.find((x) => x.id === r.id); if (m) Object.assign(m, upd); }
            else if (table === 'passport_postcards') { const pc = postcards.find((x) => x.id === r.id); if (pc) Object.assign(pc, upd); }
          }
          return cb({ data: filtered.map((r) => ({ ...r, ...upd })), error: null });
        }
        if (countMode) return cb({ count: filtered.length, error: null });
        return cb({ data: [...filtered], error: null });
      },
    };
    return b;
  }
  function store(table: string, row: any) {
    if (table === 'posts') posts[row.id] = row;
    else if (table === 'post_media') media.push(row);
    else if (table === 'passport_postcards') postcards.push(row);
  }
  return {
    auth: {
      async getUser(token: string) {
        if (token !== TOKEN) return { data: { user: null }, error: new Error('bad token') };
        return { data: { user: { id: OWNER_ID } }, error: null };
      },
    },
    from(table: string) {
      if (table === 'posts') return builder(table, Object.values(posts).map((r) => ({ ...r })));
      if (table === 'post_media') return builder(table, media.map((r) => ({ ...r })));
      if (table === 'passport_postcards') return builder(table, postcards.map((r) => ({ ...r })));
      if (table === 'profiles') return builder(table, [{ id: OWNER_ID, role: 'user', handle: 'owner', username: 'owner', account_status: 'active', is_private: false }]);
      return builder(table, []);
    },
    storage: {
      from(_bucket: string) {
        return {
          createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/u/${path}`, token: 't', path }, error: null }),
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
          remove: async () => ({ data: null, error: null }),
          createSignedUrl: async (path: string) =>
            signFails
              ? { data: null, error: { message: 'storage: signing key unavailable' } }
              : { data: { signedUrl: `https://storage.test/signed/${path}` }, error: null },
          download: async (path: string) =>
            downloadFails
              ? { data: null, error: { message: 'storage: object store unreachable' } }
              : { data: new Blob([new Uint8Array(path.endsWith('.mp4') ? videoBytes : imageBytes)]), error: null },
          upload: async () =>
            uploadFails
              ? { data: null, error: { message: 'storage: write rejected' } }
              : { data: { path: 'p' }, error: null },
        };
      },
    },
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

let server: http.Server;
let port: number;

function apiReq(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({
      hostname: '127.0.0.1', port, path: `/api${path}`, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
      },
    }, (res) => {
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

const completeVideo = () =>
  apiReq('POST', `/postcards/${POST_ID}/media/${VID_ID}/complete`,
    { mimeType: 'video/mp4', fileSizeBytes: 500_000, width: 1080, height: 1920, durationSeconds: 5 });

const completeImage = () =>
  apiReq('POST', `/postcards/${POST_ID}/media/${IMG_ID}/complete`,
    { mimeType: 'image/jpeg', fileSizeBytes: 40_000, width: 32, height: 24 });

const statusOf = (id: string) => media.find((m) => m.id === id)?.processing_status;

before(async () => {
  __jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#357' } }).jpeg().toBuffer();
  server = http.createServer(app);
  // NOT awaited through the listening callback: resolve AFTER listen reports,
  // so `port` is real before any test runs.
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as any).port;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (!url.startsWith('https://storage.test/')) return __realFetch(input, init);
    if (probeThrows) throw new TypeError('fetch failed');
    const headers: Record<string, string> = { 'content-range': `bytes 0-${headBytes.length - 1}/${totalBytes}` };
    return new Response(new Uint8Array(headBytes), { status: probeStatus, headers });
  }) as typeof globalThis.fetch;
});

after(async () => {
  globalThis.fetch = __realFetch;
  _setTestClient(null as any, true);
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  reset();
  _setTestClient(fakeClient() as any, true);
});

// ── VIDEO ────────────────────────────────────────────────────────────────────

describe('postcards /complete (video): the check that could not run is not the check that failed', () => {
  it('PAIRED CONTROL — healthy storage, real mp4, within the ceiling: 200 and ready', async () => {
    const r = await completeVideo();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(statusOf(VID_ID), 'ready');
  });

  it('signing outage → 503 degraded_unavailable, retryable, and never blames the file', async () => {
    signFails = true;
    const r = await completeVideo();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'degraded_unavailable');
    assert.equal(r.body?.retryable, true);
    assert.ok(!/re-upload/i.test(String(r.body?.message)),
      `an outage must not tell the uploader to re-upload; got ${JSON.stringify(r.body?.message)}`);
    assert.ok(!/could not be verified/i.test(String(r.body?.message)));
    assert.notEqual(statusOf(VID_ID), 'ready', 'an unverified object must not be marked ready');
  });

  it('range read answers 5xx → 503 degraded_unavailable, not 400', async () => {
    probeStatus = 503;
    const r = await completeVideo();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'degraded_unavailable');
    assert.notEqual(statusOf(VID_ID), 'ready');
  });

  it('range read never connects (fetch rejects) → 503 degraded_unavailable', async () => {
    probeThrows = true;
    const r = await completeVideo();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'degraded_unavailable');
    assert.notEqual(statusOf(VID_ID), 'ready');
  });

  it('CONTENT: the stored bytes are not a video → 400 invalid_payload, "please re-upload"', async () => {
    headBytes = Buffer.concat([__jpeg.subarray(0, 64), Buffer.alloc(64)]).subarray(0, 64);
    const r = await completeVideo();
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'invalid_payload');
    assert.match(String(r.body?.message), /re-upload/i);
    assert.notEqual(statusOf(VID_ID), 'ready');
  });

  it('POLICY: an oversized stored object → 400 that names the limit, not "could not be verified"', async () => {
    totalBytes = 900 * 1024 * 1024;
    const r = await completeVideo();
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'invalid_payload');
    assert.match(String(r.body?.message), /\d+MB/,
      'a size refusal must state the size and the limit');
    assert.ok(!/could not be verified/i.test(String(r.body?.message)),
      'a file that is too big is not a file we failed to verify');
    assert.notEqual(statusOf(VID_ID), 'ready');
  });

  it('location-scrub download outage → 503 degraded_unavailable, not "could not be processed"', async () => {
    // Verification (a Range read over fetch) still succeeds; only the full
    // download that the scrub needs is broken, so this isolates the second
    // try-block from the first.
    downloadFails = true;
    const r = await completeVideo();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'degraded_unavailable');
    assert.ok(!/re-upload/i.test(String(r.body?.message)));
    assert.notEqual(statusOf(VID_ID), 'ready');
  });

  it('scrub re-upload outage → 503 degraded_unavailable (the object is geotagged, so a write happens)', async () => {
    uploadFails = true;
    const r = await completeVideo();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'degraded_unavailable');
    assert.notEqual(statusOf(VID_ID), 'ready');
  });
});

// ── IMAGE ────────────────────────────────────────────────────────────────────

describe('postcards /complete (image): same three kinds, same three answers', () => {
  it('PAIRED CONTROL — healthy storage and a real jpeg: 200 and ready', async () => {
    const r = await completeImage();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(statusOf(IMG_ID), 'ready');
  });

  it('download outage → 503 degraded_unavailable, not "Image could not be processed"', async () => {
    downloadFails = true;
    const r = await completeImage();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'degraded_unavailable');
    assert.equal(r.body?.retryable, true);
    assert.ok(!/re-upload/i.test(String(r.body?.message)));
    assert.notEqual(statusOf(IMG_ID), 'ready');
  });

  it('re-upload outage → 503 degraded_unavailable (the EXIF strip could not be stored)', async () => {
    uploadFails = true;
    const r = await completeImage();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'degraded_unavailable');
    assert.notEqual(statusOf(IMG_ID), 'ready',
      'a row whose GPS strip was never stored must not be ready');
  });

  it('CONTENT: the stored bytes are not an image → 400 invalid_payload, "please re-upload"', async () => {
    imageBytes = Buffer.from('this is not an image at all, not even close', 'utf8');
    const r = await completeImage();
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body?.error, 'invalid_payload');
    assert.match(String(r.body?.message), /re-upload/i);
    assert.notEqual(statusOf(IMG_ID), 'ready');
  });
});
