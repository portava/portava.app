/**
 * Adding a photo to a Memory from the app — the reference the upload answers
 * must be one `POST /memories/:id/items` accepts (lane MEM-MEDIA-ADD, found by
 * lane MEM-SEGMENTS).
 *
 * ## The defect, stated before the fix
 *
 * The app adds a photo in two calls (travel-buddy-standalone/src/services/
 * memories.ts `addMemoryItem`): it uploads the bytes to `POST /api/media/upload`
 * and then sends that answer's `url` VERBATIM as `mediaUrl` to
 * `POST /api/memories/:id/items`. Since 2026-07-26 the upload answers a BARE
 * storage key, `post-media/<uid>/<ms>.<ext>` (routes/posts.ts `mediaRelayUrl`),
 * because the bucket is private and a public URL of a private object loads for
 * nobody. The items route validated `mediaUrl` with `z.string().url()`, which a
 * bare key is not, so EVERY photo the app tried to add to a Memory since
 * 2026-08-11 (when the app moved to the server upload) was answered 400 and
 * nothing was written. The app's own suites fake `fetch`, and the server's
 * suites post `https://` fixtures, so the two halves were never put together.
 *
 * This file puts them together: the REAL upload route answers, and the REAL
 * items route receives exactly the body the app builds from that answer.
 *
 * ## What the server now accepts, and what it still refuses
 *
 * The bare key is accepted ONLY in the canonical form the upload itself
 * answers — `post-media/<lowercase uid>/<one file name>` — and only when the uid
 * is the CALLER's (memoryMediaOrigin.classifyMemoryMediaUrl refuses another
 * user's object as `foreign_storage`, for every spelling). Another bucket,
 * another user's prefix, a nested path, `.`/`..`, percent-encoding, a query, a
 * fragment, a backslash, whitespace, a leading or doubled slash and an
 * upper-cased uid are refused before anything is written. Every absolute URL
 * keeps exactly main's rule (https anywhere, http only on the configured storage
 * origin, nothing else).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import sharp from "sharp";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import postsRouter from "../routes/posts.js";
import * as mediaOrigin from "../services/memory/memoryMediaOrigin.js";
import { FOREIGN_MEDIA_REFUSAL, MEMORY_MEDIA_URL_REFUSAL, storageRefOf } from "../services/memory/memoryMediaOrigin.js";
import { appStorageUrlInfo, configuredStorageOrigin } from "../lib/mediaUrl.js";

const MEM = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-0000-4000-a000-000000000001";
const VICTIM = "aaaaaaaa-0000-4000-a000-000000000002";
const TOKEN = "me-tok";

// ── A fake service client both routes can run on ─────────────────────────────

interface FakeState { [t: string]: any[] }

function baseState(): FakeState {
  return {
    memories: [{
      id: MEM, owner_id: ME, title: "Ferry", caption: null, visibility: "only_me",
      allowed_user_ids: [], hidden_user_ids: [], trip_id: null, event_id: null, place_id: null,
      canonical_location_id: null, location_city: null, location_country: null,
      location_lat: null, location_lng: null, starts_at: null, ends_at: null, state: "published",
      created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
    }],
    memory_items: [], memory_tags: [], memory_likes: [], memory_saves: [],
    user_follows: [], circle_memberships: [], trips: [], trip_members: [],
    profiles: [], blocks: [], feature_flags: [], media_assets: [],
  };
}

function makeClient(state: FakeState, uploaded: string[]) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    const insertRow = () => {
      const row = { id: `${table}-${(state[table] ??= []).length + 1}`, created_at: "2026-10-14T00:00:00.000Z", ...pendingInsert };
      state[table].push(row);
      return row;
    };
    const builder: any = {
      select() { return builder; },
      insert(r: any) { pendingInsert = r; return builder; },
      update() { return builder; }, upsert() { return builder; }, delete() { return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      is() { return builder; }, in() { return builder; }, gt() { return builder; }, lt() { return builder; },
      gte() { return builder; }, lte() { return builder; }, or() { return builder; }, range() { return builder; },
      not() { return builder; }, order() { return builder; }, limit() { return builder; },
      maybeSingle: async () => (pendingInsert ? { data: insertRow(), error: null } : { data: rows()[0] ?? null, error: null }),
      single: async () => (pendingInsert ? { data: insertRow(), error: null } : { data: rows()[0] ?? null, error: null }),
      then(onF: any, onR: any) {
        if (pendingInsert) return Promise.resolve({ data: [insertRow()], error: null, count: 1 }).then(onF, onR);
        return Promise.resolve({ data: rows(), error: null, count: rows().length }).then(onF, onR);
      },
    };
    function rows() { return (state[table] ?? []).filter((r) => filters.every((f) => f(r))); }
    return builder;
  }
  return {
    from,
    rpc: async () => ({ data: null, error: { code: "PGRST202", message: "function not found" } }),
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string) { uploaded.push(`${bucket}/${path}`); return { data: { path }, error: null }; },
          async remove(paths: string[]) { return { data: paths, error: null }; },
          getPublicUrl(path: string) { return { data: { publicUrl: `${bucket}/${path}` } }; },
        };
      },
    },
    auth: {
      getUser: async (tok: string) =>
        tok === TOKEN ? { data: { user: { id: ME } }, error: null } : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

// ── The app's two calls, as the app makes them ──────────────────────────────

let server: http.Server;
let base = "";
let state: FakeState = baseState();
let uploaded: string[] = [];

function reset(): void {
  state = baseState();
  uploaded = [];
  _setTestClient(makeClient(state, uploaded) as any, true);
}

/** POST /api/media/upload with raw bytes — `uploadMemoryMedia`'s first call. */
function upload(body: Buffer, contentType: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}/api/media/upload`);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": contentType, "content-length": String(body.length), connection: "close" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: any = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * POST /api/memories/:id/items with the body `addMemoryItemFromUrl` builds
 * (travel-buddy-standalone/src/services/memories.ts: `{ mediaUrl, mediaType,
 * caption: caption ?? null, position: position ?? 0 }`, JSON, with the §19
 * `Idempotency-Key` header).
 */
async function addItem(mediaUrl: string, position = 0, idempotencyKey = `op-${Math.random().toString(36).slice(2)}`) {
  const res = await fetch(`${base}/api/memories/${MEM}/items`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, connection: "close" },
    body: JSON.stringify({ mediaUrl, mediaType: "image/jpeg", caption: null, position }),
  });
  const b: any = await res.json().catch(() => null);
  return { status: res.status, body: b };
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
}

before(async () => {
  reset();
  const app = express();
  app.use((req: any, _r: any, next: any) => { req.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  // posts.ts reads the raw body itself for /media/upload; express.json() only
  // consumes application/json, which the upload never is.
  app.use(express.json());
  app.use("/api", postsRouter);
  app.use("/api", memoriesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
  server.unref();
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("adding a photo to a Memory from the app: upload, then attach the upload's answer", () => {
  it("the upload answers a bare post-media key under the caller's uid, and the items route ACCEPTS it verbatim (red on main: 400)", async () => {
    reset();
    const up = await upload(await jpeg(), "image/jpeg");
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const ref = up.body?.url as string;
    // The upload's own answer is the canonical reference: bucket-qualified, no
    // scheme, the caller's uid first — and it is the object that was stored.
    assert.match(ref, new RegExp(`^post-media/${ME}/\\d+\\.jpg$`));
    assert.ok(uploaded.includes(ref), `the stored object is the one answered: ${uploaded.join(", ")}`);

    const added = await addItem(ref);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body?.item?.mediaUrl, ref, "the item carries the reference unchanged");
    assert.equal(state.memory_items.length, 1);
    assert.equal(state.memory_items[0].memory_id, MEM);
    assert.equal(state.memory_items[0].media_url, ref, "stored as the bare key, never rewritten to a public URL of a private object");
  });

  it("a second photo on the same Memory lands too, at its own position", async () => {
    reset();
    const a = (await upload(await jpeg(), "image/jpeg")).body?.url as string;
    // Date.now() names the object: wait out the millisecond so the second key differs.
    await new Promise((r) => setTimeout(r, 3));
    const b = (await upload(await jpeg(), "image/jpeg")).body?.url as string;
    assert.notEqual(a, b);
    assert.equal((await addItem(a, 0)).status, 201);
    assert.equal((await addItem(b, 1)).status, 201);
    assert.deepEqual(state.memory_items.map((r) => [r.media_url, r.position]), [[a, 0], [b, 1]]);
  });
});

describe("the bare key is accepted only as the upload's own form, under the CALLER's uid", () => {
  const file = "1785019420319.jpg";

  it("another user's key is refused for OWNERSHIP, and nothing is written", async () => {
    reset();
    const { status, body } = await addItem(`post-media/${VICTIM}/${file}`);
    assert.equal(status, 400);
    assert.equal(body?.error, "invalid_payload");
    assert.equal(body?.message, FOREIGN_MEDIA_REFUSAL);
    assert.equal(state.memory_items.length, 0);
  });

  // Every one of these is refused before the command runs (400, the fixed
  // refusal, nothing written). Each names what it would otherwise reach.
  const REFUSED: Array<[string, string]> = [
    [`post-media/${ME}/../${VICTIM}/${file}`, "dot-dot traversal into another user's prefix"],
    [`post-media/${ME}/..`, "dot-dot as the file"],
    [`post-media/${ME}/.`, "dot as the file"],
    [`post-media/${ME}/.hidden.jpg`, "a leading dot"],
    [`post-media/${ME}/a..b.jpg`, "a dot-dot inside the name"],
    [`post-media/${ME}/..%2F${VICTIM}%2F${file}`, "percent-encoded slashes"],
    [`post-media/${ME}%2F..%2F${VICTIM}/${file}`, "percent-encoded traversal in the uid segment"],
    [`post-media/${ME}/%2e%2e`, "percent-encoded dots"],
    [`post-media/${ME}/x%00.jpg`, "an encoded NUL"],
    [`post-media/${ME}\\..\\${VICTIM}\\${file}`, "backslashes"],
    [`post-media/${ME}/sub/${file}`, "a nested path under the uid"],
    [`post-media/${ME}/${file}/`, "a trailing slash"],
    [`post-media//${ME}/${file}`, "a doubled slash after the bucket"],
    [`post-media/${ME}//${file}`, "a doubled slash after the uid"],
    [`/post-media/${ME}/${file}`, "a leading slash"],
    [`post-media/${ME}/${file}?token=abc`, "a query string"],
    [`post-media/${ME}/${file}#frag`, "a fragment"],
    [` post-media/${ME}/${file}`, "leading whitespace"],
    [`post-media/${ME}/${file} `, "trailing whitespace"],
    [`post-media/${ME}/${file}\n`, "a trailing newline"],
    [`post-media/${ME.toUpperCase()}/${file}`, "an upper-cased uid (a different object key)"],
    [`post-media/${ME}`, "no file"],
    [`post-media/${ME}/`, "an empty file"],
    [`post-media/`, "no uid"],
    [`post-media/memories/${ME}/${file}`, "the retired direct-upload prefix, not the upload's answer"],
    [`post-media/stories/${ME}/${file}`, "another feature's prefix"],
    [`post-media/not-a-uid/${file}`, "no uid segment"],
    [`profile-media/${ME}/${file}`, "another bucket"],
    [`profile-media/avatars/${ME}/${file}`, "another bucket, avatar convention"],
    [`post-media-x/${ME}/${file}`, "a lookalike bucket"],
    [`Post-Media/${ME}/${file}`, "a case-folded bucket"],
    [`private/${ME}/${file}`, "an unknown bucket"],
    [`post-media/${ME}/${"a".repeat(240)}.jpg`, "an over-long name"],
    [`post-media/${ME}/phöto.jpg`, "a non-ASCII name"],
    [`${ME}/${file}`, "a path with no bucket"],
    ["not-a-url", "neither a URL nor a key (main answered zod's \"Invalid url\"; the refusal is now the route's fixed one)"],
  ];

  it("traversal, encoding, other buckets, other shapes: 400 with the fixed refusal, nothing written", async () => {
    reset();
    for (const [mediaUrl, why] of REFUSED) {
      const { status, body } = await addItem(mediaUrl);
      assert.equal(status, 400, `${why}: ${JSON.stringify(mediaUrl)} → ${JSON.stringify(body)}`);
      assert.equal(body?.error, "invalid_payload", why);
      assert.equal(body?.message, MEMORY_MEDIA_URL_REFUSAL, `${why}: refused for its SHAPE, before ownership`);
    }
    assert.equal(state.memory_items.length, 0, "no refused reference was written");
  });

  it("controls: the upload's own derivatives under the caller's uid are the same convention, and are accepted", async () => {
    reset();
    for (const name of [file, "1785019420319.thumb.jpg", "1785019420319.feed.jpg", "1785019420319.mp4", "1785019420319.poster.jpg", "a_b-c.webp"]) {
      const { status, body } = await addItem(`post-media/${ME}/${name}`);
      assert.equal(status, 201, `${name}: ${JSON.stringify(body)}`);
    }
    assert.equal(state.memory_items.length, 6);
  });
});

describe("absolute URLs keep main's rule exactly", () => {
  it("https anywhere is accepted (unchanged; the open product question in memoryMediaOrigin.ts)", async () => {
    reset();
    assert.equal((await addItem("https://images.example.com/a.jpg")).status, 201);
  });

  it("our own absolute object is accepted for its owner and refused for anyone else (unchanged)", async () => {
    reset();
    const sb = "https://sb.example.test/storage/v1/object/public/post-media";
    assert.equal((await addItem(`${sb}/${ME}/1.jpg`)).status, 201);
    const foreign = await addItem(`${sb}/${VICTIM}/1.jpg`);
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body?.message, FOREIGN_MEDIA_REFUSAL);
  });

  it("data:, javascript:, file:, ftp: and off-origin http: are still 400 with the fixed refusal", async () => {
    reset();
    for (const mediaUrl of ["data:image/png;base64,iVBORw0KGgo=", "javascript:alert(1)", "file:///etc/passwd", "ftp://example.com/x.jpg", "http://evil.example/x.jpg"]) {
      const { status, body } = await addItem(mediaUrl);
      assert.equal(status, 400, mediaUrl);
      assert.equal(body?.message, MEMORY_MEDIA_URL_REFUSAL, mediaUrl);
    }
    assert.equal(state.memory_items.length, 0);
  });

  it("http on the configured storage origin is accepted when one is configured (unchanged)", async () => {
    reset();
    const origin = configuredStorageOrigin();
    const { status } = await addItem(`${origin ?? "http://127.0.0.1:9"}/storage/v1/object/public/post-media/${ME}/1.jpg`);
    assert.equal(status, origin && origin.startsWith("http:") ? 201 : 400);
  });
});

describe("uploadKeyOwner — the pure rule", () => {
  const uploadKeyOwner = (mediaOrigin as any).uploadKeyOwner as ((ref: unknown) => string | null) | undefined;

  it("exists", () => {
    assert.equal(typeof uploadKeyOwner, "function", "memoryMediaOrigin.uploadKeyOwner is the rule the route applies");
  });

  it("names the uid of exactly `post-media/<uid>/<file>`, and nothing else", () => {
    assert.equal(uploadKeyOwner!(`post-media/${ME}/1785019420319.jpg`), ME);
    assert.equal(uploadKeyOwner!(`post-media/${VICTIM}/1785019420319.jpg`), VICTIM, "the rule names the owner; ownership is decided by the caller's id");
    for (const bad of [
      "", `post-media/${ME}/../x.jpg`, `post-media/${ME}/sub/x.jpg`, `post-media/${ME}/x.jpg?x=1`, `post-media/${ME.toUpperCase()}/x.jpg`,
      `profile-media/${ME}/x.jpg`, `https://sb.example.test/storage/v1/object/public/post-media/${ME}/x.jpg`, `post-media/${ME}/%2e%2e`,
    ]) {
      assert.equal(uploadKeyOwner!(bad), null, JSON.stringify(bad));
    }
    for (const notAString of [null, undefined, 42, {}, ["post-media", ME, "x.jpg"]]) {
      assert.equal(uploadKeyOwner!(notAString), null, String(notAString));
    }
  });

  it("allows a name of exactly the ceiling and refuses one over it", () => {
    const max = (mediaOrigin as any).UPLOAD_KEY_FILE_MAX as number;
    assert.equal(typeof max, "number");
    assert.equal(uploadKeyOwner!(`post-media/${ME}/${"a".repeat(max)}`), ME);
    assert.equal(uploadKeyOwner!(`post-media/${ME}/${"a".repeat(max + 1)}`), null);
  });
});

describe("every reader of memory_items.media_url resolves the accepted key to the object the upload stored", () => {
  it("POST /api/media/sign's parser (lib/mediaUrl.appStorageUrlInfo) — how the owner's app hydrates it", async () => {
    reset();
    const up = await upload(await jpeg(), "image/jpeg");
    assert.deepEqual(appStorageUrlInfo(up.body.url), { bucket: "post-media", path: up.body.path });
  });

  it("memoryMediaOrigin.storageRefOf — the renditions and segments readers' parser", async () => {
    reset();
    const up = await upload(await jpeg(), "image/jpeg");
    assert.deepEqual(storageRefOf(up.body.url), { bucket: "post-media", path: up.body.path });
  });
});
