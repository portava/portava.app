/**
 * census-discovery DV-77, §56 — no unstripped original persists because a
 * completion handler never ran.
 *
 *   Phase 0.4 (discovery-v1-12-implementation-plan.md): "Redesign durable
 *   ingest so no raw unstripped original can persist merely because a
 *   completion handler never runs."
 *
 * The postcard transport is the one path where the server does not hold the
 * bytes at ingest: the client PUTs them straight to a signed Storage URL and
 * `/complete` strips them later. This suite drives that path with CONTROLLED
 * data — a real slot reserved through `POST /postcards/:id/media/upload-url`,
 * raw JPEG bytes carrying an EXIF segment PUT at the minted path, resumable
 * parts and a poster beside it, and NO `/complete` — and pins:
 *
 *   BOUND        the pass removes the object, its feed variant, its parts and
 *                its poster, then the row, once the slot is older than the
 *                cutoff, and not before.
 *   NEVER SERVED until then, the relay refuses the bytes to anyone but their
 *                owner (lib/mediaAccess branch 3a, a row that is not `ready`).
 *   FAIL CLOSED  flag off/absent: nothing runs; flag unreadable: nothing runs
 *                AND a failure is recorded; an unreadable `post_media` is a
 *                failure, never "swept 0".
 *   PARTIAL / RETRY a failed removal keeps the row; the next pass finishes; two
 *                passes converge.
 *   NO BLIND DELETE a row whose path never recorded has it derived; a row whose
 *                path cannot be derived is kept.
 *   NO LOST FILE a row that completed between the batch read and the removal is
 *                left alone.
 *   INGEST       `upload-url` no longer mints a URL for a slot whose path did
 *                not record.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/mediaPendingUploadSweep.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pino from "pino";
import { readFileSync } from "node:fs";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import postcardsRouter from "../routes/postcards.js";
import {
  sweepAbandonedPendingUploads,
  PENDING_UPLOAD_ORPHAN_CUTOFF_MS,
} from "../services/media/PendingUploadSweep.js";
import {
  runPendingUploadSweepPass,
  getPendingUploadSweepStatus,
  PENDING_UPLOAD_SWEEP_INTERVAL_MS,
} from "../lib/media/pendingUploadSweepScheduler.js";
import { authorizeMediaAccess } from "../lib/mediaAccess.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const OWNER = "a1000000-0000-4000-a000-00000000d077";
const STRANGER = "a1000000-0000-4000-a000-00000000d078";
const POST = "b1000000-0000-4000-a000-00000000d077";
const TOKEN = "dv77-owner-token";
const SECRET = "dv77-internal-secret";
const FLAG = "media_pending_upload_sweep_enabled";

/** A JPEG with an APP1 "Exif" segment — the controlled stand-in for a phone photo with GPS. */
const RAW_WITH_EXIF = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]),
  Buffer.from("Exif\0\0GPS-LAT-LNG", "latin1"),
  Buffer.from([0xff, 0xd9]),
]);

// ── an in-memory supabase: tables + storage, both observable ────────────────
type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
let objects = new Map<string, Buffer>();
let failures: Record<string, { message: string }> = {};
let removeFailsFor = new Set<string>();
let signedUrlsMinted: string[] = [];
let fakeNowMs = Date.parse("2026-09-27T10:00:00.000Z");
/** Called on every post_media SELECT with the running count — the "completed meanwhile" hook. */
let onPostMediaSelect: ((n: number) => void) | null = null;
let postMediaSelects = 0;

function client() {
  function from(table: string) {
    tables[table] ??= [];
    const store = tables[table];
    const preds: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    let selected = false;
    let countMode = false;
    let head = false;
    let limitN: number | null = null;
    let order: { col: string; asc: boolean } | null = null;
    const b: any = {
      select(_c?: string, o?: { count?: string; head?: boolean }) { selected = true; countMode = !!o?.count; head = !!o?.head; return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      lt(c: string, v: any) { preds.push((r) => r[c] < v); return b; },
      in(c: string, vs: any[]) { preds.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any) { preds.push((r) => (r[c] ?? null) === v); return b; },
      or() { return b; },
      overlaps(c: string, vs: any[]) { preds.push((r) => Array.isArray(r[c]) && vs.some((v) => r[c].includes(v))); return b; },
      order(c: string, o: any = {}) { order = { col: c, asc: o.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { return Promise.resolve(run("maybe")); },
      single() { return Promise.resolve(run("single")); },
      then(f: any, r: any) { return Promise.resolve(run("list")).then(f, r); },
    };
    function run(mode: "list" | "maybe" | "single"): any {
      const fail = failures[`${table}:${op}`];
      if (fail) return { data: null, error: fail, count: null };
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({
          id: p.id ?? `pm-${Math.random().toString(36).slice(2, 10)}`,
          created_at: p.created_at ?? new Date(fakeNowMs).toISOString(),
          ...p,
        }));
        store.push(...rows);
        return { data: selected ? (mode === "list" ? rows : rows[0]) : null, error: null };
      }
      const hit = store.filter((r) => preds.every((p) => p(r)));
      if (op === "update") { for (const r of hit) Object.assign(r, payload); return { data: null, error: null }; }
      if (op === "delete") { tables[table] = store.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
      let out = hit.map((r) => ({ ...r }));  // a snapshot: what this read returned, whatever happens after it
      if (order) { const { col, asc } = order; out = [...out].sort((a, c) => (a[col] < c[col] ? -1 : a[col] > c[col] ? 1 : 0) * (asc ? 1 : -1)); }
      if (limitN !== null) out = out.slice(0, limitN);
      // AFTER the read is settled: the hook models something that happens between two reads.
      if (table === "post_media") { postMediaSelects++; onPostMediaSelect?.(postMediaSelects); }
      if (countMode) return { data: head ? null : out, error: null, count: out.length };
      if (mode === "list") return { data: out, error: null };
      if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: out[0] ?? null, error: mode === "single" && !out[0] ? { code: "PGRST116", message: "no rows" } : null };
    }
    return b;
  }
  const storage = {
    from(bucket: string) {
      const key = (p: string) => `${bucket}/${p}`;
      return {
        async remove(paths: string[]) {
          for (const p of paths) if (removeFailsFor.has(key(p))) return { data: null, error: { message: `remove refused: ${p}` } };
          for (const p of paths) objects.delete(key(p));
          return { data: paths, error: null };
        },
        async list(folder: string) {
          const prefix = key(folder) + "/";
          const data = [...objects.keys()].filter((k) => k.startsWith(prefix))
            .map((k) => ({ name: k.slice(prefix.length), metadata: { size: objects.get(k)!.length } }));
          return { data, error: null };
        },
        async createSignedUploadUrl(p: string) {
          signedUrlsMinted.push(key(p));
          return { data: { signedUrl: `https://storage.example.test/upload/${p}?token=t`, path: p }, error: null };
        },
        async upload() { return { data: null, error: null }; },
        async download() { return { data: null, error: { message: "not modelled" } }; },
      };
    },
  };
  return {
    from,
    storage,
    auth: {
      getUser: async (t: string) =>
        t === TOKEN ? { data: { user: { id: OWNER } }, error: null } : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

const sc: any = client();

function baseTables(flagOn: boolean | null = true): Record<string, Row[]> {
  return {
    feature_flags: [
      { flag: "disable_media_uploads", enabled: false },
      ...(flagOn === null ? [] : [{ flag: FLAG, enabled: flagOn }]),
    ],
    profiles: [{ id: OWNER, account_status: "active" }],
    posts: [{ id: POST, author_id: OWNER, status: "active", visibility: "public", post_status: "published", trip_id: null }],
    post_media: [],
    blocks: [],
    media_assets: [],
    media_attachments: [],
  };
}

let server: http.Server;
let base = "";

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Reserve a real slot through the route, then do what an abandoning client does: PUT and vanish. */
async function abandonedUpload(): Promise<{ mediaId: string; path: string }> {
  const r = await call("POST", `/api/postcards/${POST}/media/upload-url`,
    { mimeType: "image/jpeg", fileSizeBytes: RAW_WITH_EXIF.length }, { authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200, `fixture: the slot must be reserved (${JSON.stringify(r.body)})`);
  const { mediaId, path } = r.body;
  objects.set(`post-media/${path}`, RAW_WITH_EXIF);                       // the PUT
  objects.set(`post-media/${path}.parts/00000`, RAW_WITH_EXIF);           // a resumable part
  objects.set(`post-media/${path}.poster.jpg`, Buffer.from("poster"));    // a poster
  objects.set(`post-media/${path}.feed.jpg`, Buffer.from("feed"));        // a feed variant
  return { mediaId, path };
}

const at = (ms: number) => ms;
const rowOf = (id: string) => (tables.post_media ?? []).find((r) => r.id === id);
const objectsUnder = (path: string) => [...objects.keys()].filter((k) => k.startsWith(`post-media/${path}`));

before(async () => {
  process.env.INTERNAL_API_SECRET = SECRET;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", postcardsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  _setTestClient(sc, true);
  _setTestServiceClient(sc);
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
});

beforeEach(() => {
  _resetRateLimit("media_upload");
  tables = baseTables();
  objects = new Map();
  failures = {};
  removeFailsFor = new Set();
  signedUrlsMinted = [];
  onPostMediaSelect = null;
  postMediaSelects = 0;
  fakeNowMs = Date.parse("2026-09-27T10:00:00.000Z");
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§56 DV-77 — an upload whose completion never ran is removed within the bound", () => {
  it("CONTROLLED: the raw EXIF-bearing original sits in post-media after the PUT", async () => {
    const { path } = await abandonedUpload();
    assert.ok(objects.get(`post-media/${path}`)!.includes(Buffer.from("Exif")), "fixture: the original must carry EXIF");
    assert.equal(rowOf(path.split("/")[2].split(".")[0])?.processing_status, "pending");
  });

  it("not before the cutoff: a slot younger than the cutoff is left alone", async () => {
    const { mediaId, path } = await abandonedUpload();
    const reserved = Date.parse(rowOf(mediaId)!.created_at);
    const out = await runPendingUploadSweepPass({ sc, nowMs: at(reserved + PENDING_UPLOAD_ORPHAN_CUTOFF_MS - 1_000) });
    assert.equal(out.ran, true);
    assert.ok(rowOf(mediaId), "a slot younger than the cutoff was swept");
    assert.equal(objectsUnder(path).length, 4);
  });

  it("by cutoff + one interval: object, feed variant, parts and poster gone, THEN the row", async () => {
    const { mediaId, path } = await abandonedUpload();
    const reserved = Date.parse(rowOf(mediaId)!.created_at);
    const out = await runPendingUploadSweepPass({ sc, nowMs: at(reserved + PENDING_UPLOAD_ORPHAN_CUTOFF_MS + PENDING_UPLOAD_SWEEP_INTERVAL_MS) });
    assert.equal(out.ran, true);
    assert.deepEqual(objectsUnder(path), [], "an unstripped original outlived the bound");
    assert.equal(rowOf(mediaId), undefined, "the row outlived its bytes");
    assert.ok(out.ran && out.result.ok && out.result.swept === 1 && out.result.errors === 0);
    assert.ok(getPendingUploadSweepStatus().lastSuccessAt, "a clean pass must be recorded as a success");
  });

  it("a READY upload (its /complete ran) is never touched", async () => {
    const { mediaId, path } = await abandonedUpload();
    rowOf(mediaId)!.processing_status = "ready";
    await runPendingUploadSweepPass({ sc, nowMs: fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS });
    assert.ok(rowOf(mediaId));
    assert.equal(objectsUnder(path).length, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§56 DV-77 — NEVER SERVED while it waits: the relay refuses a row that is not ready", () => {
  it("a stranger is refused the pending bytes of a PUBLIC post; the owner is not", async () => {
    const { path } = await abandonedUpload();
    assert.equal(await authorizeMediaAccess(sc, STRANGER, "post-media", path), false, "unstripped bytes were served to a stranger");
    assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", path), true, "the owner must still reach their own upload");
  });

  it("POSITIVE CONTROL: the same object is served once its row is ready", async () => {
    const { mediaId, path } = await abandonedUpload();
    rowOf(mediaId)!.processing_status = "ready";
    rowOf(mediaId)!.moderation_status = "approved";
    assert.equal(await authorizeMediaAccess(sc, STRANGER, "post-media", path), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§56 DV-77 — the gate, and failure never read as success", () => {
  it("flag OFF: nothing is read beyond the flag and nothing is removed", async () => {
    tables = baseTables(false);
    const { mediaId } = await abandonedUpload();
    postMediaSelects = 0;
    const out = await runPendingUploadSweepPass({ sc, nowMs: fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS });
    assert.deepEqual(out, { ran: false, why: "flag_off" });
    assert.equal(postMediaSelects, 0);
    assert.ok(rowOf(mediaId));
  });

  it("flag ABSENT (an unapplied 3400) reads exactly like OFF", async () => {
    tables = baseTables(null);
    const { mediaId } = await abandonedUpload();
    const out = await runPendingUploadSweepPass({ sc, nowMs: fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS });
    assert.deepEqual(out, { ran: false, why: "flag_absent" });
    assert.ok(rowOf(mediaId));
  });

  it("flag UNREADABLE: nothing runs, and the pass records a FAILURE, not an idle tick", async () => {
    const { mediaId } = await abandonedUpload();
    failures["feature_flags:select"] = { message: "feature_flags unavailable" };
    const out = await runPendingUploadSweepPass({ sc, nowMs: fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS });
    assert.deepEqual(out, { ran: false, why: "flag_unreadable", failed: true });
    assert.ok(rowOf(mediaId));
  });

  it("an unreadable post_media is a failure — never 'swept 0'", async () => {
    await abandonedUpload();
    failures["post_media:select"] = { message: "post_media unavailable" };
    const out = await runPendingUploadSweepPass({ sc, nowMs: fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS });
    assert.equal(out.ran, true);
    assert.ok(out.ran && out.failed && !out.result.ok, "an unreadable table was reported as a clean, empty pass");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§56 DV-77 — partial failure, retry, and the rows a blind sweep would lose", () => {
  it("a failed storage removal KEEPS the row; the next pass finishes the job", async () => {
    const { mediaId, path } = await abandonedUpload();
    const late = fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS;
    removeFailsFor = new Set([`post-media/${path}`]);
    const first = await sweepAbandonedPendingUploads(sc, { nowMs: late });
    assert.ok(first.ok && first.errors === 1 && first.swept === 0);
    assert.ok(rowOf(mediaId), "the row was deleted while its bytes were still there — the bytes are now unfindable");
    removeFailsFor = new Set();
    const second = await sweepAbandonedPendingUploads(sc, { nowMs: late });
    assert.ok(second.ok && second.swept === 1);
    assert.deepEqual(objectsUnder(path), []);
    assert.equal(rowOf(mediaId), undefined);
  });

  it("RETRY: two passes converge — the second finds nothing and removes nothing more", async () => {
    await abandonedUpload();
    const late = fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS;
    const one = await sweepAbandonedPendingUploads(sc, { nowMs: late });
    const two = await sweepAbandonedPendingUploads(sc, { nowMs: late });
    assert.ok(one.ok && one.swept === 1);
    assert.ok(two.ok && two.swept === 0 && two.errors === 0 && two.examined === 0);
  });

  it("a row whose path never recorded has its path DERIVED — the bytes go, not just the row", async () => {
    const { mediaId, path } = await abandonedUpload();
    rowOf(mediaId)!.storage_path = "";
    const out = await sweepAbandonedPendingUploads(sc, { nowMs: fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS });
    assert.ok(out.ok && out.swept === 1);
    assert.deepEqual(objectsUnder(path), [], "the row was deleted and its bytes stranded");
  });

  it("a row whose path cannot be derived is KEPT, never deleted blind", async () => {
    const { mediaId } = await abandonedUpload();
    Object.assign(rowOf(mediaId)!, { storage_path: "", mime_type: "application/x-unknown" });
    const out = await sweepAbandonedPendingUploads(sc, { nowMs: fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS });
    assert.ok(out.ok && out.errors === 1 && out.swept === 0);
    assert.ok(rowOf(mediaId));
  });

  it("a row that COMPLETED between the batch read and the removal keeps its file", async () => {
    const { mediaId, path } = await abandonedUpload();
    postMediaSelects = 0; // count only the pass's own reads: #1 is the batch, #2 the re-read
    onPostMediaSelect = (n) => { if (n === 1) rowOf(mediaId)!.processing_status = "ready"; };
    const out = await sweepAbandonedPendingUploads(sc, { nowMs: fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS });
    assert.ok(out.ok && out.completedMeanwhile === 1 && out.swept === 0);
    assert.equal(objectsUnder(path).length, 4, "a just-completed upload lost its file");
  });

  it("under a backlog larger than a batch, the OLDEST orphan goes first", async () => {
    const older = await abandonedUpload();
    fakeNowMs += 60_000;
    const newer = await abandonedUpload();
    const out = await sweepAbandonedPendingUploads(sc, { nowMs: fakeNowMs + 10 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS, limit: 1 });
    assert.ok(out.ok && out.swept === 1 && out.more === true);
    assert.equal(rowOf(older.mediaId), undefined, "the older raw original waited behind a newer one");
    assert.ok(rowOf(newer.mediaId));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§56 DV-77 — at ingest, and the two ways the pass is reached", () => {
  it("upload-url REFUSES to mint a URL for a slot whose path did not record", async () => {
    failures["post_media:update"] = { message: "update rejected" };
    const r = await call("POST", `/api/postcards/${POST}/media/upload-url`,
      { mimeType: "image/jpeg", fileSizeBytes: 1000 }, { authorization: `Bearer ${TOKEN}` });
    assert.notEqual(r.status, 200);
    assert.equal(r.body.uploadUrl, undefined);
    assert.deepEqual(signedUrlsMinted, [], "a signed URL was minted for bytes no row can locate");
  });

  it("POSITIVE CONTROL: a healthy upload-url records the path and mints exactly that URL", async () => {
    const r = await call("POST", `/api/postcards/${POST}/media/upload-url`,
      { mimeType: "image/jpeg", fileSizeBytes: 1000 }, { authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 200);
    assert.equal(rowOf(r.body.mediaId)?.storage_path, r.body.path);
    assert.deepEqual(signedUrlsMinted, [`post-media/${r.body.path}`]);
  });

  it("the manual trigger runs the same pass and keeps its response shape", async () => {
    const { mediaId } = await abandonedUpload();
    rowOf(mediaId)!.created_at = new Date(Date.now() - 2 * PENDING_UPLOAD_ORPHAN_CUTOFF_MS).toISOString();
    const r = await call("POST", "/api/postcards/sweep-orphans", {}, { "x-internal-secret": SECRET });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { swept: 1, errors: 0 });
    assert.equal(rowOf(mediaId), undefined);
  });

  it("the manual trigger answers 500 db_error on an unreadable post_media — never { swept: 0 }", async () => {
    failures["post_media:select"] = { message: "post_media unavailable" };
    const r = await call("POST", "/api/postcards/sweep-orphans", {}, { "x-internal-secret": SECRET });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
  });

  it("the scheduler is STARTED by the server — a sweep nobody runs bounds nothing", () => {
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(src, /^\s*[^/\n]*\bstartPendingUploadSweepScheduler\(\);/m, "src/index.ts does not start the pending-upload sweep");
  });
});
