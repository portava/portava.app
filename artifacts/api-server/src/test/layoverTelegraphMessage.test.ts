/**
 * layoverTelegraphMessage — census-layover L271, "the message is discarded".
 *
 * The row's evidence was that `POST /airport/sessions/:id/telegraph` classified
 * the intent, resolved the trip's thread id, emitted a `telegraph_suggestion_sent`
 * event NAMING that thread, returned `ok: true` — and never wrote the message.
 * The client then pushed the traveller into that chat, where their own text was
 * not.
 *
 * Block A pins the writer (`lib/threadMessage.ts`), including the two refusals
 * that make it safe to call from a second route. Block B pins the wiring, because
 * a writer nothing calls closes nothing.
 *
 * Runtime: node:test + node:assert. No DB, no network.
 * Run: node --import tsx/esm --test src/test/layoverTelegraphMessage.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import express from "express";
import { postPlainThreadMessage } from "../lib/threadMessage.js";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

type Row = Record<string, unknown>;

interface FakeOpts {
  /** Tables whose SELECT resolves with an error instead of rows. */
  failSelect?: Set<string>;
  /** Tables whose INSERT resolves with an error. */
  failInsert?: Set<string>;
  /** Tables whose UPDATE resolves with an error. */
  failUpdate?: Set<string>;
}

function makeFake(store: Record<string, Row[]>, opts: FakeOpts = {}) {
  const inserted: Array<{ table: string; row: Row }> = [];
  const updated: Array<{ table: string; patch: Row }> = [];

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;

    const settle = () => {
      if (mode === "insert") {
        if (opts.failInsert?.has(table)) return { data: null, error: { message: `${table} insert refused` } };
        const row = { id: `${table}-${(store[table] ?? []).length + 1}`, ...(payload ?? {}) };
        store[table] = [...(store[table] ?? []), row];
        inserted.push({ table, row });
        return { data: row, error: null };
      }
      if (mode === "update") {
        if (opts.failUpdate?.has(table)) return { data: null, error: { message: `${table} update refused` } };
        updated.push({ table, patch: payload ?? {} });
        return { data: null, error: null };
      }
      if (opts.failSelect?.has(table)) return { data: null, error: { message: `${table} unreadable` } };
      const rows = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: rows, error: null };
    };

    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => {
            const r = settle();
            return resolve(Array.isArray(r.data) ? r : r);
          };
        }
        if (prop === "insert") return (row: Row) => { mode = "insert"; payload = row; return b; };
        if (prop === "update") return (patch: Row) => { mode = "update"; payload = patch; return b; };
        if (prop === "eq") return (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; };
        if (prop === "is") return (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return b; };
        if (prop === "maybeSingle" || prop === "single") {
          return () => {
            const r = settle();
            if (r.error) return Promise.resolve({ data: null, error: r.error });
            const rows = Array.isArray(r.data) ? r.data : [r.data];
            return Promise.resolve({ data: rows[0] ?? null, error: null });
          };
        }
        return (..._a: unknown[]) => b;
      },
    });
    return b;
  }

  return { client: { from: (name: string) => builder(name) } as any, inserted, updated };
}

const PLAIN_THREAD = { id: "t1", is_e2ee: false };
const SEND = { threadId: "t1", senderId: "u1", body: "On a layover in Cebu with about 6h to spare — any quick tips?", subtype: "layover_suggestion" };

/* ── A. the writer ───────────────────────────────────────────────────────── */

describe("A. postPlainThreadMessage — the message reaches the thread, or the caller is told why not", () => {
  it("A1 — the message is INSERTED, and last_message_at moves with it", async () => {
    const store: Record<string, Row[]> = { message_threads: [{ ...PLAIN_THREAD }], messages: [], message_thread_members: [{ thread_id: "t1", user_id: "u1" }, { thread_id: "t1", user_id: "u2" }] };
    const { client, inserted, updated } = makeFake(store);

    const r = await postPlainThreadMessage(client, SEND);

    assert.equal(r.ok, true, "a plain thread accepts a plain message");
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]!.table, "messages");
    assert.equal(inserted[0]!.row.thread_id, "t1");
    assert.equal(inserted[0]!.row.sender_id, "u1");
    assert.equal(inserted[0]!.row.body, SEND.body, "THE BODY IS THE TRAVELLER'S TEXT — the defect was that this row did not exist at all");
    assert.equal(inserted[0]!.row.msg_type, "text");
    assert.equal(inserted[0]!.row.subtype, "layover_suggestion");
    assert.ok(updated.some((u) => u.table === "message_threads" && typeof u.patch.last_message_at === "string"),
      "a thread whose newest message does not move last_message_at sorts to the bottom of the list it just changed");
  });

  it("A2 — AN E2EE THREAD IS REFUSED, and nothing is written", async () => {
    // The whole claim of the flag is that the server cannot read the
    // conversation. A second write path that stored plaintext anyway would be
    // the one place that quietly can.
    const store: Record<string, Row[]> = { message_threads: [{ id: "t1", is_e2ee: true }], messages: [], message_thread_members: [] };
    const { client, inserted } = makeFake(store);

    const r = await postPlainThreadMessage(client, SEND);

    assert.deepEqual(r, { ok: false, reason: "e2ee" });
    assert.equal(inserted.length, 0);
    assert.equal(store.messages!.length, 0);
  });

  it("A3 — SEEN GOING RED: an UNREADABLE is_e2ee read refuses too, and says something different from 'e2ee'", async () => {
    // Written this way because the obvious implementation is wrong in a way no
    // happy-path test can see: supabase-js RESOLVES on a database error, so an
    // unchecked read yields `data: null`, which reads as `is_e2ee: false`, which
    // admits plaintext to an E2EE thread during exactly the minute the database
    // is unhappy. Drop the `metaErr` binding in lib/threadMessage.ts and this
    // case inserts.
    //
    // `unverifiable` is a SEPARATE answer from `e2ee` because the caller tells
    // the user different things: one is "this conversation does not take this
    // kind of message", the other is "try again".
    const store: Record<string, Row[]> = { message_threads: [{ ...PLAIN_THREAD }], messages: [], message_thread_members: [] };
    const { client, inserted } = makeFake(store, { failSelect: new Set(["message_threads"]) });

    const r = await postPlainThreadMessage(client, SEND);

    assert.deepEqual(r, { ok: false, reason: "unverifiable" });
    assert.equal(inserted.length, 0);
  });

  it("A4 — a thread that is not there is `no_thread`, not a silent success", async () => {
    const store: Record<string, Row[]> = { message_threads: [], messages: [], message_thread_members: [] };
    const { client, inserted } = makeFake(store);

    const r = await postPlainThreadMessage(client, SEND);

    assert.deepEqual(r, { ok: false, reason: "no_thread" });
    assert.equal(inserted.length, 0);
  });

  it("A5 — a REJECTED insert is reported, not swallowed", async () => {
    const store: Record<string, Row[]> = { message_threads: [{ ...PLAIN_THREAD }], messages: [], message_thread_members: [] };
    const { client } = makeFake(store, { failInsert: new Set(["messages"]) });

    const r = await postPlainThreadMessage(client, SEND);

    assert.deepEqual(r, { ok: false, reason: "insert_failed" });
    assert.equal(store.messages!.length, 0);
  });

  it("A6 — a failed last_message_at bump does NOT un-send the message", async () => {
    // The message IS in the thread once the insert lands. Reporting failure
    // after that would make the caller tell the traveller their text was lost
    // while it sits in the conversation, and a retry would double-post it.
    const store: Record<string, Row[]> = { message_threads: [{ ...PLAIN_THREAD }], messages: [], message_thread_members: [{ thread_id: "t1", user_id: "u2" }] };
    const { client } = makeFake(store, { failUpdate: new Set(["message_threads"]) });

    const r = await postPlainThreadMessage(client, SEND);

    assert.equal(r.ok, true);
    assert.equal(store.messages!.length, 1);
  });

  it("A7 — an unreadable MEMBER table (so no realtime audience) does not un-send it either", async () => {
    const store: Record<string, Row[]> = { message_threads: [{ ...PLAIN_THREAD }], messages: [], message_thread_members: [{ thread_id: "t1", user_id: "u2" }] };
    const { client } = makeFake(store, { failSelect: new Set(["message_thread_members"]) });

    const r = await postPlainThreadMessage(client, SEND);

    assert.equal(r.ok, true, "realtime is a delivery optimisation; the durable row is the message");
    assert.equal(store.messages!.length, 1);
  });
});

/* ── B. reachability — a writer nothing calls closes nothing ─────────────── */

describe("B. the layover Telegraph route WRITES, and the screen believes the answer", () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("B1 — the route posts the traveller's own message into the resolved thread", () => {
    const src = read("../routes/airport.ts");
    const route = src.slice(src.indexOf('router.post("/airport/sessions/:id/telegraph"'));
    const end = route.indexOf("\n});");
    const body = route.slice(0, end);

    assert.match(body, /postPlainThreadMessage\(sc, \{/, "the route does not write the message at all — L271's original defect");
    assert.match(body, /body: parsed\.data\.message/, "it must post THE TRAVELLER'S text, not a summary of it");
    assert.ok(body.indexOf("postPlainThreadMessage") < body.indexOf("emitLayoverEvent"),
      "the event claims a send; it must be emitted AFTER the send it reports on, or `posted` is a guess");
    assert.match(body, /posted,/, "`posted` must travel on the response — the client's navigation depends on it");
  });

  it("B2 — the write is gated on a resolved thread, which is only set for an ACCEPTED member", () => {
    const src = read("../routes/airport.ts");
    const route = src.slice(src.indexOf('router.post("/airport/sessions/:id/telegraph"'));
    const body = route.slice(0, route.indexOf("\n});"));
    assert.match(body, /if \(threadId\) \{[\s\S]*?postPlainThreadMessage/,
      "an unguarded call would post to whatever threadId happened to be");
    assert.ok(body.indexOf("isAcceptedTripMember") < body.indexOf("postPlainThreadMessage"),
      "membership is proved before the write, not after it");
  });

  it("B3 — the screen navigates to the chat only when the message is IN it", () => {
    const screen = readFileSync(
      new URL("../../../../travel-buddy-standalone/app/layover/[id].tsx", import.meta.url), "utf8");
    const handler = screen.slice(screen.indexOf("const handleTelegraph = useCallback"));
    const body = handler.slice(0, handler.indexOf("}, [id, overview, city, router, showToast]);"));

    assert.match(body, /res\.posted && overview\.session\.tripId/,
      "navigating on tripId alone is what put a traveller in a chat their message never reached");
    assert.match(body, /res\.threadId && !res\.posted/,
      "a chat that exists and did not receive the message needs its own branch — silently falling through to Compass hides a failure");
    assert.match(body, /postFailure === 'e2ee'/,
      "an E2EE refusal is not a transient error and must not be shown as one");
  });
});

/* ── C. the route, over HTTP, against a database double ──────────────────── */

/**
 * BLOCK B READS SOURCE TEXT, AND SOURCE TEXT IS NOT BEHAVIOUR. The mutation
 * that proved it: leave the call site written but make it unreachable
 * (`await Promise.resolve({ ok: true }) ?? await postPlainThreadMessage(...)`).
 * Block B stayed green on that — every string it greps for is still in the
 * file — while the traveller's message went nowhere, which is L271 exactly.
 * So the route is exercised here for real: express, a database double, and an
 * assertion on the `messages` table rather than on the handler's prose.
 */
const TOKEN = "layover-telegraph-token";
const USER = "layover-user-1";
const TRIP = "trip-telegraph-1";

let server: http.Server;
let base = "";

function postTelegraph(sessionId: string, message: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ message });
    const url = new URL(`/api/airport/sessions/${sessionId}/telegraph`, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end(payload);
  });
}

/** A layover linked to a trip the traveller is an ACCEPTED member of. */
function stage(opts: { e2ee?: boolean; member?: boolean; thread?: boolean } = {}) {
  const { e2ee = false, member = true, thread = true } = opts;
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER, trip_id: TRIP })],
    layover_events: [],
    trips: [{ id: TRIP, owner_id: "someone-else" }],
    trip_members: member ? [{ trip_id: TRIP, user_id: USER, role: "member", status: "accepted" }] : [],
    message_threads: thread ? [{ id: "thread-1", thread_type: "trip", trip_id: TRIP, is_e2ee: e2ee }] : [],
    message_thread_members: [{ thread_id: "thread-1", user_id: USER }, { thread_id: "thread-1", user_id: "u2" }],
    messages: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER } }) as any, true);
  return tables;
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});

after(() => { server?.close(); _setTestClient(null as any, false); });

describe("C. POST /airport/sessions/:id/telegraph — the row in `messages` is the verdict", () => {
  it("C1 — THE MESSAGE IS IN THE THREAD, and the response says so", async () => {
    const tables = stage();
    const text = "On a layover in Cebu with about 6h to spare — any quick tips?";

    const r = await postTelegraph("session-1", text);

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.threadId, "thread-1");
    assert.equal(r.body.posted, true, "`posted` is what the screen navigates on");
    assert.equal(tables.messages!.length, 1, "THE DEFECT: this table stayed empty while the route answered ok:true");
    assert.equal(tables.messages![0]!.thread_id, "thread-1");
    assert.equal(tables.messages![0]!.sender_id, USER);
    assert.equal(tables.messages![0]!.body, text, "the traveller's own words, not a paraphrase");
  });

  it("C2 — the emitted event records that it was posted, so the audit trail is not a guess", async () => {
    const tables = stage();
    await postTelegraph("session-1", "hello");
    const ev = (tables.layover_events ?? []).find((e: any) =>
      e.event_type === "telegraph_suggestion_sent" || e.type === "telegraph_suggestion_sent");
    assert.ok(ev, `the suggestion event is still emitted; saw ${JSON.stringify(tables.layover_events)}`);
    const payload = (ev as any).payload ?? (ev as any).data ?? (ev as any).metadata ?? ev;
    assert.equal(payload.posted, true,
      "an event that names a thread but not whether the message reached it is the record that let L271 hide");
  });

  it("C3 — a NON-MEMBER gets no thread, nothing is written, and posted is false", async () => {
    const tables = stage({ member: false });
    const r = await postTelegraph("session-1", "hello");
    assert.equal(r.status, 200);
    assert.equal(r.body.threadId, null);
    assert.equal(r.body.posted, false);
    assert.equal(tables.messages!.length, 0, "membership is the gate; a write here would post into a stranger's trip chat");
  });

  it("C4 — an E2EE trip thread is REFUSED: no plaintext row, posted false, reason on the wire", async () => {
    const tables = stage({ e2ee: true });
    const r = await postTelegraph("session-1", "hello");
    assert.equal(r.status, 200);
    assert.equal(r.body.threadId, "thread-1", "the chat exists — the client may still offer to open it");
    assert.equal(r.body.posted, false);
    assert.equal(r.body.postFailure, "e2ee");
    assert.equal(tables.messages!.length, 0,
      "the server storing plaintext in an end-to-end encrypted thread is the one thing the flag promises cannot happen");
  });

  it("C5 — a trip with no chat thread yet: posted false, nothing written, and no crash", async () => {
    const tables = stage({ thread: false });
    const r = await postTelegraph("session-1", "hello");
    assert.equal(r.status, 200);
    assert.equal(r.body.threadId, null);
    assert.equal(r.body.posted, false);
    assert.equal(tables.messages!.length, 0);
  });
});
