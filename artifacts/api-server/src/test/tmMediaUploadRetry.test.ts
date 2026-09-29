/**
 * Testing-mode WP-17 (lane tm-followups), flow MED-F25 — an owner can find a
 * failed upload and retry it from the client, and a database failure on the
 * way is never reported as "not found".
 *
 * THE GAP. POST /api/media/:id/retry takes a `media_assets.id`, and nothing
 * handed the client one: My World's "Processing" bucket is built from posts,
 * so a failed canonical asset had no id on any client surface. And the retry
 * itself answered 404 `not_found` when its asset read or its re-queue write
 * FAILED — an outage told the owner their upload did not exist.
 *
 * THE FIX.
 *   - GET /api/media/me/failed-uploads lists the caller's own failed,
 *     un-purged assets (owner-scoped in the query), with `retryAvailable` —
 *     whether the processing worker a retry queues for is on — so the client
 *     never offers a Retry that can only be refused. A failed read is db_error.
 *   - retryMediaProcessing carries `dbError`; the route answers db_error.
 *
 * Run: node --import tsx/esm --test src/test/tmMediaUploadRetry.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import mediaActionsRouter from "../routes/mediaActions.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const A3 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003";
const A4 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000004";

interface Opts { workerOn?: boolean; failRead?: boolean; failUpdate?: boolean }

function makeClient(opts: Opts = {}) {
  const assets: any[] = [
    { id: A1, owner_user_id: OWNER, media_type: "image", processing_status: "failed", processing_terminal: true, purge_status: "none", thumbnail_url: null, created_at: "2026-09-28T10:00:00Z" },
    { id: A2, owner_user_id: OWNER, media_type: "video", processing_status: "ready", processing_terminal: false, purge_status: "none", thumbnail_url: null, created_at: "2026-09-28T11:00:00Z" },
    { id: A3, owner_user_id: OTHER, media_type: "image", processing_status: "failed", processing_terminal: true, purge_status: "none", thumbnail_url: null, created_at: "2026-09-28T12:00:00Z" },
    { id: A4, owner_user_id: OWNER, media_type: "image", processing_status: "failed", processing_terminal: true, purge_status: "completed", thumbnail_url: null, created_at: "2026-09-28T13:00:00Z" },
  ];
  const from = (table: string) => {
    const preds: Array<(r: any) => boolean> = [];
    let op: "select" | "update" = "select";
    let patch: any = null;
    const rowsFor = () => (table === "media_assets" ? assets : table === "feature_flags" ? [{ flag: "media_processing_worker_enabled", enabled: Boolean(opts.workerOn) }] : []);
    const run = () => {
      if (table === "media_assets" && op === "select" && opts.failRead) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      if (table === "media_assets" && op === "update" && opts.failUpdate) return { data: null, error: { code: "40001", message: "could not serialize access" } };
      const rows = rowsFor().filter((r) => preds.every((p) => p(r)));
      if (op === "update") rows.forEach((r) => Object.assign(r, patch));
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const q: any = {
      select: () => q, order: () => q, limit: () => q,
      update: (p: any) => { op = "update"; patch = p; return q; },
      eq: (c: string, v: any) => { preds.push((r) => r[c] === v); return q; },
      neq: (c: string, v: any) => { preds.push((r) => r[c] !== v); return q; },
      maybeSingle: async () => { const r = run(); return r.error ? r : { data: (r.data as any[])[0] ?? null, error: null }; },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
    };
    return q;
  };
  return {
    assets,
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (t: string) => ({ data: { user: t ? { id: t } : null }, error: t ? null : { message: "no" } }) },
  } as any;
}

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", mediaActionsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _setTestClient(null, false); _setTestServiceClient(null); });

async function call(client: any, method: string, path: string, token = OWNER) {
  _setTestClient(client, true);
  _setTestServiceClient(client);
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

describe("GET /media/me/failed-uploads", () => {
  it("lists only the caller's own failed, un-purged assets, with retryAvailable from the worker flag", async () => {
    const r = await call(makeClient({ workerOn: true }), "GET", "/media/me/failed-uploads");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.items.map((i: any) => i.id), [A1]);
    assert.equal(r.body.items[0].mediaType, "image");
    assert.equal(r.body.retryAvailable, true);
  });

  it("with the worker off, the list still answers and says a retry is not available", async () => {
    const r = await call(makeClient({ workerOn: false }), "GET", "/media/me/failed-uploads");
    assert.equal(r.status, 200);
    assert.equal(r.body.retryAvailable, false);
    assert.equal(r.body.items.length, 1);
  });

  it("an unreadable media_assets is db_error, never an empty list", async () => {
    const r = await call(makeClient({ failRead: true }), "GET", "/media/me/failed-uploads");
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });
});

describe("POST /media/:id/retry — a database failure is not 'not found'", () => {
  it("an unreadable asset read is db_error", async () => {
    const r = await call(makeClient({ workerOn: true, failRead: true }), "POST", `/media/${A1}/retry`);
    assert.notEqual(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });

  it("a refused re-queue write is db_error", async () => {
    const r = await call(makeClient({ workerOn: true, failUpdate: true }), "POST", `/media/${A1}/retry`);
    assert.notEqual(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });

  it("control: a failed asset of the owner with the worker on is queued (202); a stranger still gets 404", async () => {
    const client = makeClient({ workerOn: true });
    const ok = await call(client, "POST", `/media/${A1}/retry`);
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.equal(client.assets[0].processing_status, "queued");
    const stranger = await call(makeClient({ workerOn: true }), "POST", `/media/${A1}/retry`, OTHER);
    assert.equal(stranger.status, 404);
  });
});
