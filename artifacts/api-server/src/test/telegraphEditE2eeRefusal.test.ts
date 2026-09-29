/**
 * WP-08 / TEL-F07 (lane tm-telegraph) — the CANONICAL edit route refuses to
 * write plaintext into an end-to-end encrypted thread.
 *
 * `PATCH /api/threads/:threadId/messages/:messageId` became the one edit route
 * the client calls (it keeps version history; `PATCH /api/messages/:id` in
 * groupChat.ts does not). Every other write in routes/messaging.ts that could
 * put text on the server — the send (`isE2ee` → ciphertext only), the media
 * send, the translate retry — reads `message_threads.is_e2ee` first and refuses.
 * The edit did not: it would overwrite `messages.body` with the new text in the
 * clear AND copy the previous body into `message_edits`, on a thread whose
 * whole contract is that the server never holds its words.
 *
 * Three rules, each shown red on the unmodified route:
 *   1. An E2EE thread → 422 `e2ee_thread`; `body` unchanged; no version row.
 *   2. An UNREADABLE flag → 503 `degraded_unavailable`, the same posture as the
 *      send path: "we could not read the flag" is not "the flag is false".
 *   3. A plaintext thread still edits normally (the control), and the existing
 *      gates still run first: a non-member is refused before the flag is read.
 *
 * Run: node --import tsx/esm --test src/test/telegraphEditE2eeRefusal.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import messagingRouter from "../routes/messaging.js";
import groupChatRouter from "../routes/groupChat.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const MALLORY = "dddddddd-0000-4000-8000-000000000004";
const THREAD = "eeeeeeee-0000-4000-8000-00000000000e";
const MSG = "11110000-0000-4000-8000-00000000000a";

interface State {
  e2ee?: boolean;
  /** Every statement against this table fails. */
  failTable?: string;
}

function makeClient(state: State) {
  const db: Record<string, any[]> = {
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, last_read_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, last_read_at: null },
    ],
    messages: [
      { id: MSG, thread_id: THREAD, sender_id: ALICE, body: "original", deleted_at: null, edited_at: null, created_at: new Date(Date.now() - 3_600_000).toISOString() },
    ],
    message_edits: [],
    message_threads: [{ id: THREAD, is_e2ee: state.e2ee === true }],
    profiles: [{ id: ALICE, preferred_language: "en", preferred_message_language: "en" }],
    message_translations: [],
    feature_flags: [],
  };

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingUpdate: any = null;
    let pendingInsert: any = null;
    let pendingDelete = false;
    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const settle = () => {
      if (state.failTable === table) return { data: null, error: { message: `injected failure on ${table}`, code: "XX000" } };
      if (pendingInsert) {
        const rows = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        for (const r of rows) (db[table] ??= []).push({ ...r });
        return { data: rows, error: null };
      }
      if (pendingDelete) {
        const hit = rowsNow();
        db[table] = (db[table] ?? []).filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      if (pendingUpdate) {
        const hit = rowsNow();
        for (const r of hit) Object.assign(r, pendingUpdate);
        return { data: hit, error: null };
      }
      return { data: JSON.parse(JSON.stringify(rowsNow())), error: null };
    };
    const target: any = {
      select() { return proxy; },
      insert(p: any) { pendingInsert = p; return proxy; },
      update(p: any) { pendingUpdate = p; return proxy; },
      upsert(p: any) { pendingInsert = p; return proxy; },
      delete() { pendingDelete = true; return proxy; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return proxy; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return proxy; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return proxy; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return proxy; },
      order() { return proxy; },
      limit() { return proxy; },
      maybeSingle() { const s = settle(); return Promise.resolve({ data: s.error ? null : (s.data as any[])[0] ?? null, error: s.error }); },
      single() { const s = settle(); return Promise.resolve({ data: s.error ? null : (s.data as any[])[0] ?? null, error: s.error }); },
      then(res: (v: any) => void, rej?: (e: any) => void) { return Promise.resolve(settle()).then(res, rej); },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }
  return {
    _db: db,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let baseUrl = "";

function use(state: State) {
  const c = makeClient(state);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return c;
}

async function patch(asUser: string, body: unknown) {
  const r = await fetch(`${baseUrl}/api/threads/${THREAD}/messages/${MSG}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", messagingRouter);
  app.use("/api", groupChatRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

describe("TEL-F07 — the canonical edit route and end-to-end encryption", () => {
  it("refuses an edit on an E2EE thread, and writes NOTHING in the clear", async () => {
    const c = use({ e2ee: true });
    const r = await patch(ALICE, { body: "this must never be stored as plaintext" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "e2ee_thread");
    assert.equal((c as any)._db.messages[0].body, "original");
    assert.equal((c as any)._db.messages[0].edited_at, null);
    assert.equal((c as any)._db.message_edits.length, 0, "the previous body must not be copied out either");
  });

  it("an unreadable E2EE flag refuses (503), it is not read as 'plaintext'", async () => {
    const c = use({ failTable: "message_threads" });
    const r = await patch(ALICE, { body: "edited" });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal((c as any)._db.messages[0].body, "original");
    assert.equal((c as any)._db.message_edits.length, 0);
  });

  it("a plaintext thread still edits and keeps the version (control)", async () => {
    const c = use({ e2ee: false });
    const r = await patch(ALICE, { body: "fixed typo" });
    assert.equal(r.status, 200);
    assert.equal(r.body.versionHistory.recorded, true);
    assert.equal((c as any)._db.messages[0].body, "fixed typo");
    assert.equal((c as any)._db.message_edits[0].previous_body, "original");
  });

  it("the membership and ownership gates still refuse first", async () => {
    use({ e2ee: true });
    const outsider = await patch(MALLORY, { body: "x" });
    assert.equal(outsider.status, 403);
    assert.equal(outsider.body.error, "forbidden");
    const notSender = await patch(BOB, { body: "x" });
    assert.equal(notSender.status, 403);
    assert.equal(notSender.body.error, "forbidden");
  });
});

/* ── The LEGACY route (routes/groupChat.ts PATCH /messages/:messageId) ──────
 * The client no longer calls it, but any authenticated caller still can, and it
 * overwrote `messages.body` with no E2EE read at all. Same gate, same order:
 * membership first, then the flag. */
async function legacyPatch(asUser: string, body: unknown) {
  const r = await fetch(`${baseUrl}/api/messages/${MSG}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

describe("TEL-F07 — the legacy edit route is gated the same way", () => {
  it("refuses an edit on an E2EE thread and writes nothing", async () => {
    const c = use({ e2ee: true });
    const r = await legacyPatch(ALICE, { body: "plaintext through the side door" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "e2ee_thread");
    assert.equal((c as any)._db.messages[0].body, "original");
    assert.equal((c as any)._db.messages[0].edited_at, null);
  });

  it("an unreadable flag refuses (503), not 'plaintext'", async () => {
    const c = use({ failTable: "message_threads" });
    const r = await legacyPatch(ALICE, { body: "edited" });
    assert.equal(r.status, 503);
    assert.equal((c as any)._db.messages[0].body, "original");
  });

  it("a plaintext thread still edits (control), and an outsider is refused first", async () => {
    const c = use({ e2ee: false });
    const r = await legacyPatch(ALICE, { body: "fixed typo" });
    assert.equal(r.status, 200);
    assert.equal((c as any)._db.messages[0].body, "fixed typo");
    use({ e2ee: true });
    const notSender = await legacyPatch(BOB, { body: "x" });
    assert.equal(notSender.status, 403);
  });
});
