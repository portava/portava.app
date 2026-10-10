/**
 * Resumable MESSAGE-media upload (census-telegraph T223, migration 3656) and the
 * sweep for its abandoned raw parts.
 *
 * The fake Storage bucket MODELS what the claims stand on: a folder listing with
 * per-object sizes and timestamps, signed upload URLs that name the exact object
 * path, downloads, uploads that can be made to fail, and removes. Parts are
 * "PUT" by writing the bytes at the path a signed URL names — exactly what a
 * client PUT to that URL does.
 *
 * Run: node --import tsx/esm --test src/test/messageMediaTransport.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import sharp from "sharp";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import router from "../routes/messageMediaTransport.js";
import { RESUMABLE_CHUNK_BYTES } from "../lib/postcardMediaTransport.js";
import {
  runMessagePartsSweep, runMessagePartsSweepTick, getMessagePartsSweepStatus, _resetMessagePartsSweepStatus,
} from "../lib/messageMediaPartsSweep.js";
import { PENDING_UPLOAD_ORPHAN_CUTOFF_MS } from "../services/media/PendingUploadSweep.js";

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const GONE = "cccccccc-0000-4000-8000-000000000003";
const UP = "0f2c4e6a-1b3d-4f5a-8c9e-aa0011223344";

interface Obj { bytes: Buffer; at: string }
interface World {
  flags: Record<string, boolean>;
  objects: Map<string, Obj>;
  profiles: string[];
  uploadFails: boolean;
  listFails: boolean;
  profilesFail: boolean;
  removed: string[];
  signed: string[];
  clock: number;
}
let w: World;

function fresh(): World {
  return {
    flags: { message_media_resumable_upload_enabled: true },
    objects: new Map(), profiles: [ME, OTHER], uploadFails: false, listFails: false, profilesFail: false,
    removed: [], signed: [], clock: Date.parse("2026-10-10T12:00:00.000Z"),
  };
}

function bucketFake() {
  return {
    async list(prefix: string, opts?: { limit?: number }) {
      if (w.listFails) return { data: null, error: { message: "storage unavailable" } };
      const seen = new Map<string, any>();
      for (const [path, o] of w.objects) {
        if (!path.startsWith(prefix + "/")) continue;
        const rest = path.slice(prefix.length + 1).split("/");
        const name = rest[0]!;
        if (rest.length === 1) seen.set(name, { name, id: name, created_at: o.at, updated_at: o.at, metadata: { size: o.bytes.length } });
        else if (!seen.has(name)) seen.set(name, { name, id: null, created_at: null, updated_at: null, metadata: null });
      }
      return { data: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, opts?.limit ?? 100), error: null };
    },
    async createSignedUploadUrl(path: string) { w.signed.push(path); return { data: { signedUrl: `https://storage.test/upload/sign/${path}` }, error: null }; },
    async download(path: string) {
      const o = w.objects.get(path);
      if (!o) return { data: null, error: { message: "not found" } };
      return { data: { arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.length) }, error: null };
    },
    async upload(path: string, body: Buffer) {
      if (w.uploadFails) return { data: null, error: { message: "storage write failed" } };
      w.objects.set(path, { bytes: Buffer.from(body), at: new Date(w.clock).toISOString() });
      return { data: { path }, error: null };
    },
    async remove(paths: string[]) { for (const p of paths) { w.removed.push(p); w.objects.delete(p); } return { data: paths, error: null }; },
    getPublicUrl(path: string) { return { data: { publicUrl: `https://sb.test/storage/v1/object/public/post-media/${path}` } }; },
  };
}

function makeClient() {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false;
    const rows = (): any[] => {
      if (table === "feature_flags") return Object.entries(w.flags).map(([flag, enabled]) => ({ flag, enabled }));
      if (table === "profiles") return w.profiles.map((id) => ({ id }));
      return [];
    };
    const t: any = {
      select() { return p; }, insert() { return p; }, update() { return p; }, upsert() { return p; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return p; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return p; },
      maybeSingle() { single = true; return p; }, single() { single = true; return p; },
      then(res: any, rej: any) {
        if (table === "profiles" && w.profilesFail) return Promise.resolve({ data: null, error: { message: "x" } }).then(res, rej);
        const out = rows().filter((r) => filters.every((f) => f(r)));
        return Promise.resolve(single ? { data: out[0] ?? null, error: null } : { data: out, error: null }).then(res, rej);
      },
    };
    const p: any = new Proxy(t, { get(target, prop) { if (prop in target) return target[prop as string]; if (prop === "catch" || prop === "finally") return undefined; return () => p; } });
    return p;
  }
  const bucket = bucketFake();
  return {
    from, storage: { from: () => bucket },
    rpc: async () => ({ data: null, error: { message: "not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let db: ReturnType<typeof makeClient>;
let server: ReturnType<typeof createServer>;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {}, child() { return this; } }; next(); });
  app.use("/api", router);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); _setTestClient(null as any, false); });
beforeEach(() => { w = fresh(); db = makeClient(); _setTestClient(db as any, true); _resetRateLimit(); _resetMessagePartsSweepStatus(); });

async function call(method: "POST" | "DELETE", path: string, as: string, body: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

/** PUT a part to the path its signed URL names — what the client's PUT does. */
function putPart(uploadUrl: string, bytes: Buffer) {
  const path = uploadUrl.replace("https://storage.test/upload/sign/", "");
  w.objects.set(path, { bytes, at: new Date(w.clock).toISOString() });
}

let bigJpeg: Buffer;
let gpsJpeg: Buffer;
before(async () => {
  // Noise does not compress: a ~1500x1500 q100 JPEG is well past one 4 MiB part.
  const n = 1500 * 1500 * 3; const raw = Buffer.alloc(n); for (let i = 0; i < n; i++) raw[i] = (i * 2654435761) >>> 24;
  bigJpeg = await sharp(raw, { raw: { width: 1500, height: 1500, channels: 3 } }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
  gpsJpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 10, b: 10 } } })
    .jpeg().withExif({ IFD0: { Copyright: "PORTAVA-TEST-MARKER" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "16/1 3/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "108/1 13/1 0/1" } }).toBuffer();
});

const sessionBody = (bytes: Buffer, mimeType = "image/jpeg", uploadId = UP) => ({ uploadId, mimeType, totalBytes: bytes.length });

describe("T223 resumable message-media upload", () => {
  it("flag OFF: every door answers 404 and nothing touches Storage", async () => {
    w.flags = {};
    for (const [m, p] of [["POST", "/media/upload-session"], ["POST", "/media/upload-session/assemble"], ["DELETE", "/media/upload-session"]] as const) {
      const r = await call(m, p, ME, sessionBody(gpsJpeg));
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(r.body.error, "not_found");
    }
    assert.deepEqual(w.signed, []);
    assert.equal(w.objects.size, 0);
  });

  it("a dropped part RESUMES: the second session lists what landed and signs only what is missing; assemble stores ONE processed object", async () => {
    assert.ok(bigJpeg.length > RESUMABLE_CHUNK_BYTES, `fixture must span parts (${bigJpeg.length})`);
    const s1 = await call("POST", "/media/upload-session", ME, sessionBody(bigJpeg));
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.equal(s1.body.partCount, 2);
    assert.equal(s1.body.missingParts.length, 2);
    for (const mp of s1.body.missingParts) assert.match(mp.uploadUrl, new RegExp(`/message-upload-parts/${ME}/${UP}\\.parts/0000${mp.index}$`));
    // Part 0 lands; the connection drops before part 1.
    putPart(s1.body.missingParts[0].uploadUrl, bigJpeg.subarray(0, RESUMABLE_CHUNK_BYTES));
    const s2 = await call("POST", "/media/upload-session", ME, sessionBody(bigJpeg));
    assert.deepEqual(s2.body.receivedParts, [0]);
    assert.equal(s2.body.receivedBytes, RESUMABLE_CHUNK_BYTES);
    assert.deepEqual(s2.body.missingParts.map((m: any) => m.index), [1]);
    putPart(s2.body.missingParts[0].uploadUrl, bigJpeg.subarray(RESUMABLE_CHUNK_BYTES));
    const a = await call("POST", "/media/upload-session/assemble", ME, sessionBody(bigJpeg));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.match(a.body.url, new RegExp(`^post-media/${ME}/\\d+\\.`));
    assert.ok(a.body.thumbnailUrl, "the same derivatives /media/upload makes");
    const stored = [...w.objects.keys()].filter((k) => k.startsWith(`${ME}/`));
    assert.ok(stored.length >= 2, `object + derivatives under the caller's prefix: ${stored}`);
    assert.equal([...w.objects.keys()].some((k) => k.startsWith("message-upload-parts/")), false, "parts removed after assembly");
  });

  it("assembled bytes go through /media/upload's processing: EXIF and GPS are stripped", async () => {
    assert.ok(gpsJpeg.includes(Buffer.from("PORTAVA-TEST-MARKER")), "fixture carries EXIF");
    const s = await call("POST", "/media/upload-session", ME, sessionBody(gpsJpeg));
    putPart(s.body.missingParts[0].uploadUrl, gpsJpeg);
    const a = await call("POST", "/media/upload-session/assemble", ME, sessionBody(gpsJpeg));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const obj = w.objects.get(a.body.path)!;
    assert.ok(obj, "stored at the answered path");
    assert.equal(obj.bytes.includes(Buffer.from("PORTAVA-TEST-MARKER")), false, "metadata stripped");
    const meta = await sharp(obj.bytes).metadata();
    assert.equal(meta.exif, undefined);
  });

  it("another person's identical upload id addresses ONLY their own prefix: my parts are invisible to them", async () => {
    const s = await call("POST", "/media/upload-session", ME, sessionBody(gpsJpeg));
    putPart(s.body.missingParts[0].uploadUrl, gpsJpeg);
    const theirs = await call("POST", "/media/upload-session", OTHER, sessionBody(gpsJpeg));
    assert.deepEqual(theirs.body.receivedParts, []);
    assert.match(theirs.body.missingParts[0].uploadUrl, new RegExp(`/message-upload-parts/${OTHER}/`));
    const theirAssemble = await call("POST", "/media/upload-session/assemble", OTHER, sessionBody(gpsJpeg));
    assert.equal(theirAssemble.status, 409, "nothing of mine can be assembled under their id");
    assert.ok(w.objects.has(`message-upload-parts/${ME}/${UP}.parts/00000`));
  });

  it("an incomplete assemble is 409 and keeps the parts (the client resumes)", async () => {
    const s = await call("POST", "/media/upload-session", ME, sessionBody(bigJpeg));
    putPart(s.body.missingParts[0].uploadUrl, bigJpeg.subarray(0, RESUMABLE_CHUNK_BYTES));
    const a = await call("POST", "/media/upload-session/assemble", ME, sessionBody(bigJpeg));
    assert.equal(a.status, 409);
    assert.ok(w.objects.has(`message-upload-parts/${ME}/${UP}.parts/00000`));
  });

  it("bytes that are not the declared kind are refused 400 and the parts removed", async () => {
    const junk = Buffer.alloc(2048, 7);
    const s = await call("POST", "/media/upload-session", ME, sessionBody(junk));
    putPart(s.body.missingParts[0].uploadUrl, junk);
    const a = await call("POST", "/media/upload-session/assemble", ME, sessionBody(junk));
    assert.equal(a.status, 400, JSON.stringify(a.body));
    assert.equal([...w.objects.keys()].some((k) => k.startsWith("message-upload-parts/")), false);
    assert.equal([...w.objects.keys()].some((k) => k.startsWith(`${ME}/`)), false, "nothing stored");
  });

  it("a storage failure while storing keeps the parts so a retry re-assembles", async () => {
    const s = await call("POST", "/media/upload-session", ME, sessionBody(gpsJpeg));
    putPart(s.body.missingParts[0].uploadUrl, gpsJpeg);
    w.uploadFails = true;
    const a = await call("POST", "/media/upload-session/assemble", ME, sessionBody(gpsJpeg));
    assert.notEqual(a.status, 201);
    assert.ok(w.objects.has(`message-upload-parts/${ME}/${UP}.parts/00000`));
    w.uploadFails = false;
    const b = await call("POST", "/media/upload-session/assemble", ME, sessionBody(gpsJpeg));
    assert.equal(b.status, 201, JSON.stringify(b.body));
  });

  it("the emergency stop refuses every door (feature_disabled)", async () => {
    w.flags.disable_media_uploads = true;
    const r = await call("POST", "/media/upload-session", ME, sessionBody(gpsJpeg));
    assert.equal(r.body.error, "feature_disabled");
    assert.deepEqual(w.signed, []);
  });

  it("refuses a non-uuid id, a bad size, an over-limit size and an unsupported type", async () => {
    for (const body of [
      { uploadId: "../../etc", mimeType: "image/jpeg", totalBytes: 10 },
      { uploadId: UP, mimeType: "image/jpeg", totalBytes: 0 },
      { uploadId: UP, mimeType: "image/jpeg", totalBytes: 1e9 },
      { uploadId: UP, mimeType: "application/pdf", totalBytes: 10 },
    ]) {
      const r = await call("POST", "/media/upload-session", ME, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(w.signed, []);
  });

  it("abandon removes the parts", async () => {
    const s = await call("POST", "/media/upload-session", ME, sessionBody(gpsJpeg));
    putPart(s.body.missingParts[0].uploadUrl, gpsJpeg);
    const d = await call("DELETE", "/media/upload-session", ME, sessionBody(gpsJpeg));
    assert.equal(d.status, 200);
    assert.equal(w.objects.size, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
function seedParts(userId: string, uploadId: string, ageMs: number, n = 2, undatable = false) {
  for (let i = 0; i < n; i++) {
    const at = undatable ? "" : new Date(w.clock - ageMs).toISOString();
    w.objects.set(`message-upload-parts/${userId}/${uploadId}.parts/0000${i}`, { bytes: Buffer.alloc(10), at });
  }
}
const now = () => new Date(w.clock);

describe("T223 the abandoned-parts sweep", () => {
  const U1 = "11111111-0000-4000-8000-000000000001", U2 = "22222222-0000-4000-8000-000000000002", U3 = "33333333-0000-4000-8000-000000000003";

  it("removes an upload idle past the cutoff, keeps a live one", async () => {
    seedParts(ME, U1, PENDING_UPLOAD_ORPHAN_CUTOFF_MS + 60_000);
    seedParts(ME, U2, 10 * 60_000);
    const r = await runMessagePartsSweep({ client: db, now: now() });
    assert.equal(r.uploadsRemoved, 1);
    assert.equal(r.kept, 1);
    assert.equal([...w.objects.keys()].some((k) => k.includes(U1)), false);
    assert.equal([...w.objects.keys()].filter((k) => k.includes(U2)).length, 2);
  });

  it("an upload just inside the cutoff is kept (a signed URL may still land a part)", async () => {
    seedParts(ME, U1, PENDING_UPLOAD_ORPHAN_CUTOFF_MS - 60_000);
    const r = await runMessagePartsSweep({ client: db, now: now() });
    assert.equal(r.uploadsRemoved, 0);
  });

  it("a deleted account's parts go at once, however fresh", async () => {
    seedParts(GONE, U3, 60_000);
    const r = await runMessagePartsSweep({ client: db, now: now() });
    assert.equal(r.ownerGone, 1);
    assert.equal(w.objects.size, 0);
  });

  it("an unreadable profiles read never deletes a fresh upload as 'owner gone'; stale ones still go", async () => {
    w.profilesFail = true;
    seedParts(GONE, U3, 60_000);
    seedParts(ME, U1, PENDING_UPLOAD_ORPHAN_CUTOFF_MS + 60_000);
    const r = await runMessagePartsSweep({ client: db, now: now() });
    assert.equal(r.outcome, "failed");
    assert.ok([...w.objects.keys()].some((k) => k.includes(U3)), "fresh parts of an unknown owner kept");
    assert.equal([...w.objects.keys()].some((k) => k.includes(U1)), false);
  });

  it("a part that cannot be dated is never deleted for age", async () => {
    seedParts(ME, U1, 0, 2, true);
    const r = await runMessagePartsSweep({ client: db, now: now() });
    assert.equal(r.uploadsRemoved, 0);
  });

  it("an unreadable listing is a FAILED pass that deletes nothing", async () => {
    seedParts(ME, U1, PENDING_UPLOAD_ORPHAN_CUTOFF_MS + 60_000);
    w.listFails = true;
    const r = await runMessagePartsSweepTick({ client: db, now: now() });
    assert.equal(r.outcome, "failed");
    assert.equal(w.objects.size, 2);
    assert.equal(getMessagePartsSweepStatus().consecutiveFailures, 1);
    assert.equal(getMessagePartsSweepStatus().lastSuccessAt, null);
  });

  it("only touches the parts prefix: a caller's stored media is never swept", async () => {
    w.objects.set(`${ME}/1700000000000.jpg`, { bytes: Buffer.alloc(5), at: new Date(0).toISOString() });
    seedParts(ME, U1, PENDING_UPLOAD_ORPHAN_CUTOFF_MS + 60_000);
    await runMessagePartsSweep({ client: db, now: now() });
    assert.ok(w.objects.has(`${ME}/1700000000000.jpg`));
  });
});
