/**
 * census-media MD269 (a), lead ruling D-82: the same hold on the two other
 * writers of a post's media. Only `POST /posts` and `PATCH /posts/:id` were gated
 * at first (mediaPostMediaHoldD82.test.ts):
 *
 *   A. POST /events/:id/posts (`event_posts.media_urls`);
 *   B. POST and PATCH /admin/portava/posts (the official account's posts).
 *
 * In each: with the moderation stage on, held media ⇒ 409 and nothing written;
 * an unreadable media state ⇒ 503 and nothing written; cleared media is written;
 * with the stage off nothing is read and the write goes through as before.
 *
 * Run: node --import tsx/esm --test src/test/mediaPostMediaHoldD82Surfaces.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { MEDIA_MODERATION_STAGE_FLAG } from "../lib/media/vendors/mediaVendorStages.js";
import { _setTestClient } from "../lib/http.js";
import eventsRouter from "../routes/events.js";
import adminPortavaPostsRouter from "../routes/adminPortavaPosts.js";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9"; // appStorageUrlInfo reads it at call time (the package test line sets the same value)
const SUPABASE = process.env.SUPABASE_URL;
const HOST = "a0000000-0000-4000-8000-0000000000a1";
const ADMIN = "a0000000-0000-4000-8000-0000000000ad";
const PORTAVA = "a0000000-0000-4000-8000-0000000000f0";
const EVENT = "e0000000-0000-4000-8000-0000000000e1";
const POST = "b0000000-0000-4000-8000-0000000000b1";
const HELD_PATH = "author/held.jpg";
const CLEAR_PATH = "author/clear.jpg";
const url = (path: string) => `${SUPABASE}/storage/v1/object/public/post-media/${path}`;

type Row = Record<string, any>;

/** A small in-memory client: staged tables, recorded writes, a failing media_assets read on request. */
function fakeClient(opts: { stageOn: boolean; assetsFail?: boolean }) {
  const tables: Record<string, Row[]> = {
    feature_flags: opts.stageOn ? [{ flag: MEDIA_MODERATION_STAGE_FLAG, enabled: true }] : [],
    media_assets: [
      { storage_bucket: "post-media", storage_path: HELD_PATH, moderation_status: "limited" },
      { storage_bucket: "post-media", storage_path: CLEAR_PATH, moderation_status: "active" },
    ],
    events: [{ id: EVENT, host_id: HOST, state: "open", attendee_comments_enabled: true }],
    event_roles: [],
    event_rsvps: [],
    profiles: [
      { id: ADMIN, role: "admin" },
      { id: PORTAVA, handle: "portava", is_official: true },
    ],
    posts: [{ id: POST, author_id: PORTAVA, post_status: "pending_delay", status: "active" }],
    event_posts: [],
    user_account_states: [],
  };
  const writes: Array<{ table: string; op: string; row: Row }> = [];
  const reads: string[] = [];
  const tokens: Record<string, string> = { "tok-host": HOST, "tok-admin": ADMIN };
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "read" | "insert" | "update" = "read";
    let payload: Row | null = null;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const result = (single: boolean) => {
      if (op === "read") {
        reads.push(table);
        if (table === "media_assets" && opts.assetsFail) return { data: null, error: { code: "57014", message: "statement timeout" } };
        const rs = rows();
        return { data: single ? rs[0] ?? null : rs, error: null };
      }
      if (op === "insert") {
        const row = { id: `${table}-new`, created_at: new Date().toISOString(), ...payload };
        writes.push({ table, op, row }); (tables[table] ??= []).push(row);
        return { data: single ? row : [row], error: null };
      }
      const hit = rows();
      for (const r of hit) Object.assign(r, payload);
      writes.push({ table, op, row: payload ?? {} });
      return { data: single ? hit[0] ?? null : hit, error: null };
    };
    const b: any = {
      select() { return b; },
      insert(r: Row) { op = "insert"; payload = r; return b; },
      update(p: Row) { op = "update"; payload = p; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is() { return b; }, not() { return b; }, or() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; },
      gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      maybeSingle() { return Promise.resolve(result(true)); },
      single() { return Promise.resolve(result(true)); },
      then(onF: any, onR: any) { return Promise.resolve(result(false)).then(onF, onR); },
    };
    return b;
  }
  const client: any = {
    from,
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: async (t: string) => (tokens[t] ? { data: { user: { id: tokens[t] } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) },
    writes, reads,
  };
  return client;
}

async function serve(router: any, client: any) {
  _setTestClient(client, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error() {}, info() {}, warn() {} }; next(); });
  app.use("/api", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function send(base: string, method: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, connection: "close" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const wrote = (c: any, table: string) => c.writes.filter((w: any) => w.table === table).length;

describe("A. POST /events/:id/posts", () => {
  const post = (c: any, mediaUrls: string[]) => serve(eventsRouter, c).then(async (s) => {
    try { return await send(s.base, "POST", `/api/events/${EVENT}/posts`, "tok-host", { body: "see you there", mediaUrls }); } finally { s.close(); }
  });

  it("stage ON + held media ⇒ 409 and no event_posts row", async () => {
    const c = fakeClient({ stageOn: true });
    const r = await post(c, [url(CLEAR_PATH), url(HELD_PATH)]);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "conflict");
    assert.equal(wrote(c, "event_posts"), 0);
  });

  it("stage ON + an unreadable media state ⇒ 503 and no row", async () => {
    const c = fakeClient({ stageOn: true, assetsFail: true });
    const r = await post(c, [url(CLEAR_PATH)]);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(wrote(c, "event_posts"), 0);
  });

  it("stage ON + cleared media ⇒ 201, written", async () => {
    const c = fakeClient({ stageOn: true });
    const r = await post(c, [url(CLEAR_PATH)]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(wrote(c, "event_posts"), 1);
  });

  it("stage OFF ⇒ the held file is written exactly as before, and no media state is read", async () => {
    const c = fakeClient({ stageOn: false });
    const r = await post(c, [url(HELD_PATH)]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(wrote(c, "event_posts"), 1);
    assert.ok(!c.reads.includes("media_assets"));
  });
});

describe("B. /admin/portava/posts", () => {
  const create = (c: any, mediaUrls: string[]) => serve(adminPortavaPostsRouter, c).then(async (s) => {
    try { return await send(s.base, "POST", "/api/admin/portava/posts", "tok-admin", { content: "official", mediaUrls }); } finally { s.close(); }
  });
  const edit = (c: any, mediaUrls: string[]) => serve(adminPortavaPostsRouter, c).then(async (s) => {
    try { return await send(s.base, "PATCH", `/api/admin/portava/posts/${POST}`, "tok-admin", { mediaUrls }); } finally { s.close(); }
  });

  it("POST: stage ON + held ⇒ 409 and no posts row; unreadable ⇒ 503 and no row; cleared ⇒ 201", async () => {
    let c = fakeClient({ stageOn: true });
    let r = await create(c, [url(HELD_PATH)]);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(wrote(c, "posts"), 0);
    c = fakeClient({ stageOn: true, assetsFail: true });
    r = await create(c, [url(CLEAR_PATH)]);
    assert.equal(r.status, 503);
    assert.equal(wrote(c, "posts"), 0);
    c = fakeClient({ stageOn: true });
    r = await create(c, [url(CLEAR_PATH)]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(wrote(c, "posts"), 1);
  });

  it("POST: stage OFF ⇒ written as before", async () => {
    const c = fakeClient({ stageOn: false });
    const r = await create(c, [url(HELD_PATH)]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(!c.reads.includes("media_assets"));
  });

  it("PATCH: an edit that adds held media ⇒ 409 and no update; a cleared edit is applied", async () => {
    let c = fakeClient({ stageOn: true });
    let r = await edit(c, [url(HELD_PATH)]);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(wrote(c, "posts"), 0);
    c = fakeClient({ stageOn: true });
    r = await edit(c, [url(CLEAR_PATH)]);
    assert.notEqual(r.status, 409);
    assert.notEqual(r.status, 503);
    assert.equal(c.writes.some((w: any) => w.table === "posts" && Array.isArray(w.row.media_urls)), true, "the cleared media was written");
  });
});
