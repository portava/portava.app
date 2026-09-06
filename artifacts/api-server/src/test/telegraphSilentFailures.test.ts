/**
 * Telegraph (messaging) — silent-failure regression tests.
 *
 * Two defect classes, both of which made a failure look like a normal, empty,
 * successful result:
 *
 *   A. telegraphChat.ts discarded the result of every suggestion write and of
 *      the suggestion read. A failed generate/read rendered as
 *      `{ suggestions: [] }` with HTTP 200 — indistinguishable from "nothing to
 *      suggest". A failed membership lookup rendered as a 403 telling an actual
 *      member they were not in the thread. Dismissing a suggestion that does
 *      not exist answered `{ ok: true }`.
 *
 *   B. Unsend did not unsend media. `DELETE /api/messages/:messageId` wrote
 *      only `deleted_at` + `body: ''`, and `GET /api/threads/:threadId/messages`
 *      emitted `mediaUrl` / `mediaThumbnailUrl` unconditionally — so unsending
 *      a photo removed the caption and kept handing every thread member a
 *      working URL for the picture.
 *
 * Run: node --import tsx/esm --test src/test/telegraphSilentFailures.test.ts
 * (binds a loopback HTTP server — run with the sandbox disabled)
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import telegraphChatRouter from "../routes/telegraphChat.js";
import messagingRouter from "../routes/messaging.js";
import groupChatRouter from "../routes/groupChat.js";

// ── IDs ──────────────────────────────────────────────────────────────────────
const THREAD_ID = "11111111-1111-1111-1111-111111111111";
const SUGG_ID = "55555555-5555-5555-5555-555555555555";
const MSG_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const TRIP_ID = "22222222-2222-2222-2222-222222222222";
const ALICE = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", email: "a@test.com" };
const BOB = { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", email: "b@test.com" };
const TOK_A = "tok_a";
const TOK_B = "tok_b";

const MEDIA_URL = "https://cdn.example.test/msg/secret-photo.jpg";
const THUMB_URL = "https://cdn.example.test/msg/secret-photo-thumb.jpg";

// ── Fake Supabase client with per-(table, op) error injection ────────────────

type Op = "select" | "insert" | "update";
interface Fail {
  table: string;
  op: Op;
  message: string;
}

interface Captured {
  inserted: Array<{ table: string; rows: any[] }>;
  updated: Array<{ table: string; payload: any }>;
}

function makeClient(
  tables: Record<string, any[]>,
  opts: {
    users?: Record<string, { id: string; email: string }>;
    fail?: Fail[];
    captured?: Captured;
  } = {},
) {
  const fails = opts.fail ?? [];
  const captured: Captured = opts.captured ?? { inserted: [], updated: [] };

  const failFor = (table: string, op: Op) =>
    fails.find((f) => f.table === table && f.op === op) ?? null;

  function makeQuery(table: string) {
    let rows = [...(tables[table] ?? [])];
    let isSingle = false;
    let isMaybe = false;
    let isCount = false;
    let op: Op = "select";
    let insertRows: any[] = [];
    let updatePayload: any = null;

    const q: any = new Proxy(
      {
        select(_fields?: string, o?: { count?: string; head?: boolean }) {
          if (o?.count) isCount = true;
          return q;
        },
        eq(col: string, val: any) {
          rows = rows.filter((r) => r[col] === val);
          return q;
        },
        in(col: string, vals: any[]) {
          rows = rows.filter((r) => vals.includes(r[col]));
          return q;
        },
        is(col: string, val: any) {
          if (val === null) rows = rows.filter((r) => r[col] == null);
          return q;
        },
        gt(col: string, val: any) {
          rows = rows.filter((r) => r[col] > val);
          return q;
        },
        gte(col: string, val: any) {
          rows = rows.filter((r) => r[col] >= val);
          return q;
        },
        lt(col: string, val: any) {
          rows = rows.filter((r) => r[col] < val);
          return q;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return q;
        },
        maybeSingle() {
          isMaybe = true;
          return q;
        },
        single() {
          isSingle = true;
          return q;
        },
        insert(data: any) {
          op = "insert";
          insertRows = Array.isArray(data) ? data : [data];
          return q;
        },
        update(data: any) {
          op = "update";
          updatePayload = data;
          return q;
        },
        then(resolve: (v: any) => void) {
          const f = failFor(table, op);
          if (f) {
            return resolve({ data: null, error: { message: f.message, code: "TESTFAIL" } });
          }
          if (op === "insert") {
            captured.inserted.push({ table, rows: insertRows });
            if (isSingle || isMaybe) {
              return resolve({ data: { id: `${table}_row`, ...insertRows[0] }, error: null });
            }
            return resolve({ data: null, error: null });
          }
          if (op === "update") {
            captured.updated.push({ table, payload: updatePayload });
            return resolve({ data: null, error: null });
          }
          if (isCount) return resolve({ count: rows.length, error: null });
          if (isSingle) {
            if (rows.length === 0) return resolve({ data: null, error: { message: "not found" } });
            return resolve({ data: rows[0], error: null });
          }
          if (isMaybe) return resolve({ data: rows[0] ?? null, error: null });
          return resolve({ data: rows, error: null });
        },
      },
      {
        // Any query-builder method this fake does not model (order, filter,
        // or, not, overlaps, …) is a no-op that keeps the chain going.
        get(target: any, prop: string) {
          if (prop in target) return target[prop];
          return () => q;
        },
      },
    );
    return q;
  }

  return {
    auth: {
      async getUser(token: string) {
        const u = (opts.users ?? { [TOK_A]: ALICE, [TOK_B]: BOB })[token];
        if (!u) return { data: { user: null }, error: { message: "bad token" } };
        return { data: { user: u }, error: null };
      },
    },
    from: (table: string) => makeQuery(table),
    _captured: captured,
  } as any;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

function req(
  server: http.Server,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function member(userId: string) {
  return { thread_id: THREAD_ID, user_id: userId, left_at: null, role: "member" };
}

function shownSuggestion() {
  return {
    id: SUGG_ID,
    user_id: ALICE.id,
    thread_id: THREAD_ID,
    intent_type: "food",
    title: "Find great food",
    reason: "Detected food planning",
    category: "food",
    action_type: "view_place",
    location_context: null,
    time_context: null,
    status: "shown",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

/** A direct thread where Telegraph suggestions are allowed for Alice. */
function telegraphTables(extra: Record<string, any[]> = {}) {
  return {
    message_thread_members: [member(ALICE.id), member(BOB.id)],
    message_threads: [
      { id: THREAD_ID, thread_type: "direct", trip_id: null, circle_owner_id: null, is_e2ee: false },
    ],
    profiles: [
      {
        id: ALICE.id,
        handle: "alice",
        name: "Alice",
        show_telegraph_dm: true,
        show_telegraph_trip: true,
        show_telegraph_circle: true,
        account_status: "active",
      },
      { id: BOB.id, handle: "bob", name: "Bob", account_status: "active" },
    ],
    telegraph_chat_suggestions: [],
    trip_members: [{ trip_id: TRIP_ID, user_id: ALICE.id, role: "member" }],
    ...extra,
  } as Record<string, any[]>;
}

let server: http.Server;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", telegraphChatRouter);
  app.use("/api", messagingRouter);
  app.use("/api", groupChatRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

after(async () => {
  _clearTestClient();
  _setTestServiceClient(null as any);
  await new Promise<void>((r) => server.close(() => r()));
});

// ─────────────────────────────────────────────────────────────────────────────
// A. telegraphChat.ts — failures must not render as an empty success
// ─────────────────────────────────────────────────────────────────────────────

describe("A. Telegraph suggestions — swallowed DB results", () => {
  it("surfaces a failed suggestion INSERT instead of answering 200 with an empty list", async () => {
    const client = makeClient(telegraphTables(), {
      fail: [{ table: "telegraph_chat_suggestions", op: "insert", message: "insert exploded" }],
    });
    _setTestClient(client, true);

    const r = await req(
      server,
      "GET",
      `/api/threads/${THREAD_ID}/telegraph/suggestions?message=${encodeURIComponent("where should we eat tonight?")}`,
      TOK_A,
    );

    assert.notEqual(
      r.status,
      200,
      "a failed suggestion insert must not be reported as a successful empty list",
    );
    assert.equal(r.status, 500);
    assert.equal(r.body?.error, "db_error");
  });

  it("surfaces a failed suggestion READ instead of answering 200 with an empty list", async () => {
    const client = makeClient(telegraphTables({ telegraph_chat_suggestions: [shownSuggestion()] }), {
      fail: [{ table: "telegraph_chat_suggestions", op: "select", message: "read exploded" }],
    });
    _setTestClient(client, true);

    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/telegraph/suggestions`, TOK_A);

    assert.notEqual(r.status, 200, "a failed read must not be reported as 'no suggestions'");
    assert.equal(r.status, 500);
    assert.equal(r.body?.error, "db_error");
  });

  it("returns db_error, not a false 403, when the membership lookup itself fails", async () => {
    const client = makeClient(telegraphTables(), {
      fail: [{ table: "message_thread_members", op: "select", message: "membership lookup down" }],
    });
    _setTestClient(client, true);

    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/telegraph/suggestions`, TOK_A);

    assert.notEqual(
      r.status,
      403,
      "a DB failure must not tell an actual thread member they are not in the thread",
    );
    assert.equal(r.status, 500);
    assert.equal(r.body?.error, "db_error");
  });

  it("still 403s a genuine non-member (the honest-error fix must not open access)", async () => {
    const client = makeClient(telegraphTables({ message_thread_members: [member(ALICE.id)] }));
    _setTestClient(client, true);

    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/telegraph/suggestions`, TOK_B);

    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "forbidden");
  });

  it("404s a dismiss of a suggestion that does not exist, instead of answering ok:true", async () => {
    const client = makeClient(telegraphTables()); // no suggestion rows at all
    _setTestClient(client, true);

    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/dismiss`,
      TOK_A,
    );

    assert.notEqual(r.status, 200, "dismissing nothing must not be reported as a dismissal");
    assert.equal(r.status, 404);
    assert.equal(r.body?.ok, undefined);
  });

  it("dismisses a real suggestion normally (the 404 fix must not break the happy path)", async () => {
    const client = makeClient(telegraphTables({ telegraph_chat_suggestions: [shownSuggestion()] }));
    _setTestClient(client, true);

    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/dismiss`,
      TOK_A,
    );

    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const upd = (client._captured as Captured).updated.find(
      (u) => u.table === "telegraph_chat_suggestions",
    );
    assert.equal(upd?.payload?.status, "dismissed");
  });

  it("reports suggestionRetired:false when the acted-status write fails after a poll was posted", async () => {
    const client = makeClient(
      telegraphTables({ telegraph_chat_suggestions: [shownSuggestion()] }),
      { fail: [{ table: "telegraph_chat_suggestions", op: "update", message: "retire failed" }] },
    );
    _setTestClient(client, true);

    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/start-poll`,
      TOK_A,
      { options: ["Morning", "Evening"] },
    );

    // The poll message was committed, so this must stay a 200 (a 500 would make
    // the client retry and post a second poll) — but it must say so.
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(
      r.body.suggestionRetired,
      false,
      "a failed acted-status write must be reported, not swallowed",
    );
  });

  it("reports suggestionRetired:true when the acted-status write succeeds", async () => {
    const client = makeClient(telegraphTables({ telegraph_chat_suggestions: [shownSuggestion()] }));
    _setTestClient(client, true);

    const r = await req(
      server,
      "POST",
      `/api/threads/${THREAD_ID}/telegraph/suggestions/${SUGG_ID}/start-poll`,
      TOK_A,
      { options: ["Morning", "Evening"] },
    );

    assert.equal(r.status, 200);
    assert.equal(r.body.suggestionRetired, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Unsend must actually unsend media
// ─────────────────────────────────────────────────────────────────────────────

function mediaMessage(over: Record<string, any> = {}) {
  return {
    id: MSG_ID,
    thread_id: THREAD_ID,
    sender_id: ALICE.id,
    body: "look at this",
    deleted_at: null,
    created_at: "2026-01-01T01:00:00Z",
    edited_at: null,
    original_language: null,
    msg_type: "text",
    subtype: null,
    media_url: MEDIA_URL,
    media_type: "image",
    media_thumbnail_url: THUMB_URL,
    media_duration_seconds: null,
    reply_to_id: null,
    profile: { id: ALICE.id, handle: "alice", name: "Alice", avatar_url: null },
    ...over,
  };
}

describe("B. Unsend — deleted messages must not keep serving their media", () => {
  it("DELETE /api/messages/:id nulls the media columns, not just body + deleted_at", async () => {
    const client = makeClient({
      messages: [mediaMessage()],
      message_thread_members: [member(ALICE.id), member(BOB.id)],
      profiles: [{ id: ALICE.id, handle: "alice", name: "Alice", account_status: "active" }],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req(server, "DELETE", `/api/messages/${MSG_ID}`, TOK_A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted, true);

    const upd = (client._captured as Captured).updated.find((u) => u.table === "messages");
    assert.ok(upd, "expected an update on messages");
    assert.ok(upd!.payload.deleted_at, "deleted_at must be stamped");
    assert.equal(
      upd!.payload.media_url,
      null,
      "unsend must clear media_url — otherwise the picture survives the deletion",
    );
    assert.equal(upd!.payload.media_thumbnail_url, null, "unsend must clear media_thumbnail_url");
    assert.equal(upd!.payload.media_type, null, "unsend must clear media_type");
    assert.equal(
      upd!.payload.media_duration_seconds,
      null,
      "unsend must clear media_duration_seconds",
    );
  });

  it("GET /api/threads/:id/messages does not project media for a tombstoned message", async () => {
    // A row tombstoned before the write-side fix: deleted_at set, media_url
    // still populated. The reader must refuse to hand it out.
    const client = makeClient({
      messages: [mediaMessage({ deleted_at: "2026-01-02T00:00:00Z", body: "" })],
      message_thread_members: [member(ALICE.id), member(BOB.id)],
      profiles: [{ id: BOB.id, handle: "bob", name: "Bob", account_status: "active" }],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/messages`, TOK_B);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const m = r.body.messages.find((x: any) => x.id === MSG_ID);
    assert.ok(m, "expected the deleted message in the listing");
    assert.equal(m.deleted, true);
    assert.equal(m.body, null);
    assert.equal(
      m.mediaUrl,
      null,
      "an unsent message must not still serve its media_url to thread members",
    );
    assert.equal(m.mediaThumbnailUrl, null, "an unsent message must not still serve its thumbnail");
    assert.equal(m.mediaType, null);
    assert.equal(m.mediaDurationSeconds, null);
  });

  it("GET /api/threads/:id/messages still projects media for a live message", async () => {
    const client = makeClient({
      messages: [mediaMessage()],
      message_thread_members: [member(ALICE.id), member(BOB.id)],
      profiles: [{ id: BOB.id, handle: "bob", name: "Bob", account_status: "active" }],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await req(server, "GET", `/api/threads/${THREAD_ID}/messages`, TOK_B);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const m = r.body.messages.find((x: any) => x.id === MSG_ID);
    assert.ok(m);
    assert.equal(m.deleted, false);
    assert.equal(m.mediaUrl, MEDIA_URL, "the redaction must be scoped to deleted messages only");
    assert.equal(m.mediaThumbnailUrl, THUMB_URL);
    assert.equal(m.mediaType, "image");
  });
});
