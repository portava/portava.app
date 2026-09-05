/**
 * Upload-hardening routes — kill-switch coverage, content sniffing, size caps,
 * EXIF strip on /media/upload, storage-origin validation on events/messaging
 * media, and story-expiry file deletion.
 * Run: node --import tsx/esm --test src/test/mediaUploadHardening.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import sharp from "sharp";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import postsRouter from "../routes/posts.js";
import eventsRouter from "../routes/events.js";
import postcardsRouter from "../routes/postcards.js";
import { sweepExpiredStories } from "../routes/stories.js";
import { FEED_DIM } from "../lib/mediaProcessing.js";
import { FIXTURE_ISO6709, mp4WithLocation } from "./videoFixtures.js";

let server: http.Server;
let base: string;
const TOKEN = "media-hardening-token";
const USER_ID = "d0000000-0000-4000-a000-000000000001";
const EVENT_ID = "d0000000-0000-4000-a000-0000000000e1";

const OLD_SUPABASE_URL = process.env.SUPABASE_URL;
const SB = "http://sb.example.test";

function rawReq(method: string, path: string, body: Buffer | null, contentType: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "content-type": contentType };
    if (body) headers["content-length"] = String(body.length);
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const jsonReq = (method: string, path: string, obj: any) =>
  rawReq(method, path, Buffer.from(JSON.stringify(obj)), "application/json");

interface FakeState {
  flags?: Record<string, boolean>;
  events?: any[];
  eventRoles?: any[];
  rsvps?: any[];
}

function makeClient(state: FakeState = {}) {
  const uploads: Array<{ bucket: string; path: string; buf: Buffer; contentType: string }> = [];
  const removed: Array<{ bucket: string; paths: string[] }> = [];
  const inserted: Array<{ table: string; row: any }> = [];

  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pending: any = null;
    const rows = () => {
      const src =
        table === "feature_flags" ? Object.entries(state.flags ?? {}).map(([flag, enabled]) => ({ flag, enabled })) :
        table === "events" ? state.events ?? [] :
        table === "event_roles" ? state.eventRoles ?? [] :
        table === "event_rsvps" ? state.rsvps ?? [] : [];
      return src.filter((r: any) => filters.every((f) => f(r)));
    };
    const b: any = {
      select() { return b; },
      insert(row: any) { pending = row; inserted.push({ table, row }); return b; },
      update() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is() { return b; }, not() { return b; }, or() { return b; },
      gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() {
        if (pending) return Promise.resolve({ data: { id: "new-row-id", ...pending }, error: null });
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      then(onF: any, onR: any) { return Promise.resolve({ data: rows(), error: null }).then(onF, onR); },
    };
    return b;
  }

  const client: any = {
    from: builder,
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, buf: Buffer, opts: any) {
            uploads.push({ bucket, path, buf, contentType: opts?.contentType });
            return { data: { path }, error: null };
          },
          getPublicUrl(path: string) {
            return { data: { publicUrl: `${SB}/storage/v1/object/public/${bucket}/${path}` } };
          },
          async remove(paths: string[]) { removed.push({ bucket, paths }); return { data: paths, error: null }; },
          async download() { return { data: null, error: { message: "not implemented" } }; },
        };
      },
    },
    auth: {
      getUser: async (t: string) => t === TOKEN
        ? { data: { user: { id: USER_ID } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } },
    },
    _uploads: uploads,
    _removed: removed,
    _inserted: inserted,
  };
  return client;
}

function setClients(c: any) { _setTestClient(c, true); _setTestServiceClient(c); }

/** 64-byte MP4 head — 4-byte size box then "ftypisom", zero-padded. */
function mp4Head(): Buffer {
  const buf = Buffer.alloc(64);
  buf.writeUInt32BE(32, 0);
  buf.write("ftypisom", 4, "ascii");
  return buf;
}

const realFetch = globalThis.fetch;

before(() => {
  process.env.SUPABASE_URL = SB;
  // Serve the Range read that postcards /complete performs against the signed
  // video URL. Scoped to storage.test so unrelated requests still hit the real
  // fetch rather than being silently swallowed.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    if (!url.startsWith("https://storage.test/")) return realFetch(input, init);
    const head = mp4Head();
    return new Response(new Uint8Array(head), {
      status: 206,
      headers: { "content-range": `bytes 0-${head.length - 1}/1024` },
    });
  }) as typeof globalThis.fetch;
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", postsRouter);
  app.use("/api", eventsRouter);
  app.use("/api", postcardsRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});

after(() => {
  process.env.SUPABASE_URL = OLD_SUPABASE_URL;
  globalThis.fetch = realFetch;
  return new Promise<void>((r) => server.close(() => r()));
});

describe("POST /api/media/upload — hardening", () => {
  it("kill switch: disable_media_uploads now blocks this path (audit gap)", async () => {
    setClients(makeClient({ flags: { disable_media_uploads: true } }));
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#111" } }).jpeg().toBuffer();
    const r = await rawReq("POST", "/api/media/upload", jpeg, "image/jpeg");
    assert.equal(r.body.error, "feature_disabled");
  });

  it("rejects bytes that are not real media even with a valid header", async () => {
    setClients(makeClient());
    const junk = Buffer.from("this is definitely not an image, whatever the header says");
    const r = await rawReq("POST", "/api/media/upload", junk, "image/jpeg");
    assert.equal(r.body.error, "invalid_payload");
    assert.match(String(r.body.message ?? r.body.detail ?? JSON.stringify(r.body)), /Unrecognized|corrupt/i);
  });

  it("uploads a valid jpeg: EXIF stripped, thumbnail created, additive response fields", async () => {
    const client = makeClient();
    setClients(client);
    const withExif = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#3a5" } })
      .jpeg()
      .withExif({ IFD0: { Copyright: "x" }, GPS: { GPSLatitudeRef: "N" } } as any)
      .toBuffer();
    const r = await rawReq("POST", "/api/media/upload", withExif, "image/jpeg");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.url.includes("post-media/"), `url was: ${r.body.url}`);
    assert.equal(r.body.processed, true);
    assert.equal(r.body.width, 900);
    assert.ok(r.body.thumbnailUrl, "server thumbnail URL expected");
    assert.ok(r.body.feedUrl, "server feed-variant URL expected (0208)");
    // three storage writes: main + .thumb.jpg + .feed.jpg
    assert.equal(client._uploads.length, 3);
    const main = client._uploads.find((u: any) => !u.path.includes(".thumb.") && !u.path.includes(".feed."));
    const meta = await sharp(main.buf).metadata();
    assert.equal(meta.exif, undefined, "stored bytes must carry NO EXIF/GPS");
    const thumb = client._uploads.find((u: any) => u.path.includes(".thumb."));
    const tMeta = await sharp(thumb.buf).metadata();
    assert.ok(Math.max(tMeta.width!, tMeta.height!) <= 400);
    // The feed variant is a SECOND stored copy of the user's photo, so it needs
    // the same privacy guarantee as the original — assert it, do not assume it
    // from the fact that it was derived from the processed buffer.
    const feed = client._uploads.find((u: any) => u.path.includes(".feed."));
    const fMeta = await sharp(feed.buf).metadata();
    assert.equal(fMeta.exif, undefined, "feed variant must carry NO EXIF/GPS either");
    assert.ok(Math.max(fMeta.width!, fMeta.height!) <= FEED_DIM);
  });

  it("rejects an oversized video without uploading", async () => {
    const client = makeClient();
    setClients(client);
    const bigVideo = Buffer.concat([
      Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"),
      Buffer.alloc(101 * 1024 * 1024, 1),
    ]);
    const r = await rawReq("POST", "/api/media/upload", bigVideo, "video/mp4");
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(client._uploads.length, 0);
  });

  // Dimension guard — same path as postcards (task 3598 / migration 2088).
  //
  // The /media/upload route does NOT write post_media rows directly: it uploads
  // to storage and returns metadata for the client to use when writing its own
  // post_media row.  For IMAGES the server always measures dimensions
  // (processImage() — reject on failure), so width/height are never null when
  // this route succeeds.  For VIDEOS there is no server-side transcode tier, so
  // the route returns width=null, height=null — the client must obtain
  // dimensions itself before writing a 'ready' row.
  //
  // The authoritative enforcement is the DB-level CHECK constraint added by
  // migration 2088 (post_media_ready_has_dimensions): ANY post_media INSERT or
  // UPDATE that sets processing_status='ready' with null width/height is
  // rejected at the database, covering both the postcards completion path and
  // any future path that might use this route's storage URL directly.  This
  // test confirms the route's null-dimension contract so the constraint stays
  // as the only guard needed.
  it("video upload: route returns null width/height — dimensions not server-measured (DB constraint is the backstop)", async () => {
    const client = makeClient();
    setClients(client);
    // Minimal valid ftyp box recognised by sniffMedia() as video/mp4.
    // Bytes 4-8 = "ftyp"; brand bytes 8-12 = "isom" (not "hei*"/"mif*"/"qt*").
    const mp4Stub = Buffer.concat([
      Buffer.from([0, 0, 0, 16]), // box size = 16 bytes
      Buffer.from("ftyp"),        // box type
      Buffer.from("isom"),        // major brand → video/mp4
      Buffer.from([0, 0, 0, 0]),  // minor version
    ]);
    const r = await rawReq("POST", "/api/media/upload", mp4Stub, "video/mp4");
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.processed, false, "videos must not report processed=true");
    assert.equal(r.body.width,  null, "video width must be null — no server-side measurement");
    assert.equal(r.body.height, null, "video height must be null — no server-side measurement");
    // One storage upload (the video bytes); no thumbnail or feed variant for videos.
    assert.equal(client._uploads.length, 1, "only the raw video should be stored");
  });

  // HEIC is FAIL-CLOSED — it used not to be, and that was a live GPS leak.
  //
  // This branch previously special-cased image/heic: when processImage() threw,
  // the raw bytes were stored as-is ("fail-soft", so older mobile clients would
  // not lose an upload). The trade was described as a documented gap on a path
  // nothing took. It was neither.
  //
  //   • sniffMedia() classifies the `heic`/`mif1` brands as image/heic and
  //     ALLOWED_MEDIA_MIME accepts image/heic, so these uploads are reachable.
  //   • The bundled libvips (8.18.3) links libheif with the AOM/AV1 codec only
  //     — there is no HEVC decoder plugin in the build. A real iPhone HEIC
  //     therefore fails with "Support for this compression format has not been
  //     built in" EVERY time, taking this branch on every such upload.
  //
  // So the one image format the pipeline could not strip metadata from was the
  // one format it stored untouched: EXIF and GPS intact, written by the code
  // whose entire purpose is to remove them. The sibling transport (postcards
  // /complete) already rejects any image it cannot process, with no HEIC
  // exception; rejecting here makes the two agree.
  it("an undecodable image is REJECTED, never stored raw — HEIC gets no fail-open exemption", async () => {
    const client = makeClient();
    setClients(client);
    // Minimal ftyp box that sniffMedia() classifies as image/heic (brand bytes
    // "heic" → starts with "hei"). Not real HEIC payload, so processImage()
    // throws — the exact branch a genuine iPhone HEIC takes in this build.
    const heicStub = Buffer.concat([
      Buffer.from([0, 0, 0, 16]), // box size = 16 bytes
      Buffer.from("ftyp"),        // box type
      Buffer.from("heic"),        // major brand → image/heic
      Buffer.from([0, 0, 0, 0]),  // minor version
    ]);
    const r = await rawReq("POST", "/api/media/upload", heicStub, "image/heic");
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(
      client._uploads.length, 0,
      "an image whose metadata cannot be stripped must not reach storage at all",
    );
  });

  // The video counterpart of the EXIF strip above: a phone video carries its
  // capture coordinates in the CONTAINER (moov/udta/©xyz), and this transport
  // stored video byte-for-byte. Detailed coverage — length preservation, the
  // Apple location key, the webm refusal — lives in
  // src/test/videoLocationMetadata.test.ts; this asserts the property here, on
  // the certified upload path, so it cannot regress unnoticed.
  it("video upload: container location metadata is stripped before storage", async () => {
    const client = makeClient();
    setClients(client);
    const geotagged = mp4WithLocation();
    assert.ok(
      geotagged.includes(Buffer.from(FIXTURE_ISO6709, "latin1")),
      "fixture must actually be geotagged",
    );
    const r = await rawReq("POST", "/api/media/upload", geotagged, "video/mp4");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(client._uploads.length, 1, "only the raw video should be stored");
    const stored = client._uploads[0].buf as Buffer;
    assert.equal(
      stored.includes(Buffer.from(FIXTURE_ISO6709, "latin1")), false,
      "stored video must NOT carry the capture coordinates",
    );
    assert.equal(stored.length, geotagged.length, "the scrub must not resize the file");
  });
});

describe("POST /api/events/:id/media — storage-origin validation", () => {
  const hostState: FakeState = {
    flags: {},
    events: [{ id: EVENT_ID, state: "published", host_id: USER_ID }],
    eventRoles: [{ event_id: EVENT_ID, user_id: USER_ID, role: "host" }],
    rsvps: [{ event_id: EVENT_ID, user_id: USER_ID, status: "going" }],
  };

  it("rejects an external URL (previous injection hole)", async () => {
    setClients(makeClient(hostState));
    const r = await jsonReq("POST", `/api/events/${EVENT_ID}/media`, {
      mediaUrl: "https://evil.example.com/tracker.jpg", mediaType: "image",
    });
    assert.equal(r.body.error, "invalid_payload");
    assert.match(String(JSON.stringify(r.body)), /app media URL/i);
  });

  it("accepts an app-storage URL", async () => {
    const client = makeClient(hostState);
    setClients(client);
    const r = await jsonReq("POST", `/api/events/${EVENT_ID}/media`, {
      mediaUrl: `${SB}/storage/v1/object/public/post-media/${USER_ID}/123.jpg`, mediaType: "image",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(client._inserted.some((i: any) => i.table === "event_media"));
  });

  it("kill switch blocks event media too", async () => {
    setClients(makeClient({ ...hostState, flags: { disable_media_uploads: true } }));
    const r = await jsonReq("POST", `/api/events/${EVENT_ID}/media`, {
      mediaUrl: `${SB}/storage/v1/object/public/post-media/${USER_ID}/123.jpg`,
    });
    assert.equal(r.body.error, "feature_disabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dimension guard — the null-dim response is the upstream signal; the
// postcards /complete endpoint is the downstream enforcement point.
//
// Full chain:
//   1. /media/upload returns { processed: false, width: null, height: null }
//      for VIDEO, which has no server-side measurement (test above). Images no
//      longer reach this state at all — one that cannot be processed is now
//      rejected outright rather than stored unmeasured.
//   2. The client must NOT write processing_status='ready' with those null dims.
//   3. If it tries, the app-level guard in POST /postcards/:id/media/:id/complete
//      rejects before hitting the DB.  The DB CHECK constraint (migration 2088,
//      post_media_ready_has_dimensions) is the final backstop for any code path
//      that bypasses the app guard.
//
// This test exercises step 3 directly: a completion request that omits
// width+height is rejected with "invalid_payload" — the recognisable error code
// a client (or API consumer) can act on.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/postcards/:id/media/:mediaId/complete — null-dim guard rejects 'ready' writes with recognisable error", () => {
  const POST_ID  = "d0000000-0000-4000-a000-000000000020";
  const MEDIA_ID = "d0000000-0000-4000-a000-000000000021";

  function makePostcardsClient() {
    // A minimal fake that satisfies the postcards /complete endpoint:
    //  - post_media lookup returns a video row owned by USER_ID in pending status.
    //  - Any update call returns success (we expect the app-level guard to
    //    fire BEFORE the update, so this path must never be reached in the
    //    null-dim case).
    let updateAttempted = false;
    const client: any = {
      from(table: string) {
        const b: any = {
          select() { return b; },
          update(payload: any) {
            updateAttempted = true;
            b._updatePayload = payload;
            return b;
          },
          insert() { return b; },
          eq() { return b; },
          neq() { return b; },
          is() { return b; }, not() { return b; },
          order() { return b; }, limit() { return b; },
          maybeSingle() {
            if (table === "post_media") {
              return Promise.resolve({
                data: {
                  id:                MEDIA_ID,
                  post_id:           POST_ID,
                  user_id:           USER_ID,
                  media_type:        "video",
                  processing_status: "pending",
                  storage_path:      `${USER_ID}/video-test.mp4`,
                  storage_bucket:    "post-media",
                },
                error: null,
              });
            }
            // feature_flags — no kill switch active
            if (table === "feature_flags") {
              return Promise.resolve({ data: null, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then(onF: any, onR: any) {
            // For queries that resolve without .maybeSingle / .single
            return Promise.resolve({ data: [], error: null }).then(onF, onR);
          },
        };
        return b;
      },
      storage: {
        from() {
          return {
            async upload() { return { data: null, error: null }; },
            getPublicUrl() { return { data: { publicUrl: "" } }; },
            async download() { return { data: null, error: { message: "not implemented" } }; },
            // /complete range-reads the uploaded video's first 64 bytes to
            // verify them, since the client wrote straight to Storage and the
            // declared fileSizeBytes proves nothing. The video here is VALID —
            // this test is about the missing dimensions that follow, so
            // verification must succeed and hand off to the dim guard.
            async createSignedUrl(path: string) {
              return { data: { signedUrl: `https://storage.test/signed/${path}` }, error: null };
            },
          };
        },
      },
      auth: {
        getUser: async (t: string) => t === TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
      },
      _wasUpdateAttempted: () => updateAttempted,
    };
    return client;
  }

  it("completing a video upload without width+height is rejected with invalid_payload — DB constraint never reached", async () => {
    // Simulate the exact scenario that follows a video upload whose
    // /media/upload response carried processed=false + null dims:
    // the client calls /complete but omits the dimensions it did not receive.
    const client = makePostcardsClient();
    setClients(client);

    const r = await jsonReq(
      "POST",
      `/api/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      {
        // Exactly what the client passes after receiving { width: null,
        // height: null } from /media/upload (an unprocessed video).
        // Sending null explicitly — not just omitting the fields —
        // ensures we exercise the app-level dimension guard rather than Zod's
        // "Expected number, received null" fallback.
        mimeType:      "video/mp4",
        fileSizeBytes: 1024,
        width:         null,
        height:        null,
      },
    );

    // The recognisable error code: invalid_payload.
    // Message must clearly identify the missing dimension requirement so a
    // client can display a meaningful "re-upload required" rather than a
    // generic failure.
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_payload",
      "error code must be 'invalid_payload' so clients can branch on it");
    assert.match(
      String(r.body.message ?? r.body.detail ?? JSON.stringify(r.body)),
      /width.*height|height.*width/i,
      "message must mention width and height so the client can surface a useful prompt",
    );

    // The DB UPDATE must never have been attempted — the app-level guard must
    // catch null dims before they can reach the database.  This ensures the
    // DB constraint (migration 2088) is never relied upon as the *first* line
    // of defence; it remains the backstop for any future code path that forgets
    // to validate.
    assert.equal(client._wasUpdateAttempted(), false,
      "DB update must not be attempted when width/height are null — app guard fires first");
  });

  it("rejects dimensionless video WITHOUT any storage round-trip — cheap check runs first", async () => {
    // ORDERING REGRESSION TEST. The case above cannot see ordering: it mocks
    // createSignedUrl to succeed, so the dimension guard is reached whether the
    // storage verification runs before it or after it. That is precisely how
    // the ordering defect survived — the verification was added ahead of the
    // guard, and on a dimensionless payload the request paid a signed URL and a
    // range read only to fail in the catch with the generic
    // "Video could not be verified. Please re-upload.", losing the specific
    // message the assertion above was deliberately written for.
    //
    // Here storage is armed to EXPLODE if touched. A dimensionless video must
    // be rejected before anything reaches the store, with the specific message.
    // If someone moves the verification back ahead of the guard, this fails on
    // the storageTouched assertion; if someone deletes the pre-check, it fails
    // on the message. Fail-closed on storage is not weakened by any of this —
    // a payload WITH dimensions still goes through full byte verification, and
    // the case above still covers that path.
    let storageTouched = false;
    const client: any = makePostcardsClient();
    const realStorageFrom = client.storage.from.bind(client.storage);
    client.storage.from = (...args: unknown[]) => {
      const handle = realStorageFrom(...(args as []));
      return {
        ...handle,
        async createSignedUrl() {
          storageTouched = true;
          throw new Error("storage must not be touched for a locally-rejectable payload");
        },
        async download() {
          storageTouched = true;
          throw new Error("storage must not be touched for a locally-rejectable payload");
        },
      };
    };
    setClients(client);

    const r = await jsonReq(
      "POST",
      `/api/postcards/${POST_ID}/media/${MEDIA_ID}/complete`,
      { mimeType: "video/mp4", fileSizeBytes: 1024, width: null, height: null },
    );

    assert.equal(storageTouched, false,
      "a payload rejectable from the request body alone must not reach storage");
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_payload");
    assert.match(
      String(r.body.message ?? r.body.detail ?? JSON.stringify(r.body)),
      /width.*height|height.*width/i,
      "the specific dimension message must survive — not the generic verification failure",
    );
    assert.equal(client._wasUpdateAttempted(), false);
  });
});

describe("sweepExpiredStories — expired files are actually deleted", () => {
  it("removes the storage objects of expired (non-highlighted) stories", async () => {
    const removed: Array<{ bucket: string; paths: string[] }> = [];
    const fake: any = {
      from() {
        const b: any = {
          update() { return b; }, eq() { return b; }, lt() { return b; }, is() { return b; },
          select() {
            return Promise.resolve({
              data: [
                { id: "s1", media_url: `${SB}/storage/v1/object/public/post-media/stories/u1/a.jpg` },
                { id: "s2", media_url: "https://elsewhere.example.com/x.jpg" }, // foreign → skipped
              ],
              error: null,
            });
          },
        };
        return b;
      },
      storage: { from: (bucket: string) => ({ remove: async (paths: string[]) => { removed.push({ bucket, paths }); return { data: paths, error: null }; } }) },
    };
    const n = await sweepExpiredStories(fake);
    assert.equal(n, 2);
    assert.equal(removed.length, 1);
    assert.deepEqual(removed[0], { bucket: "post-media", paths: ["stories/u1/a.jpg"] });
  });
});
