/**
 * Event chat lazy-creation tests
 *
 * Confirms the two fixes that prevent "Event Chat" from being a silent dead end:
 *
 *   1. POST /events/:id/rsvp (status=going) — lazily creates a chat thread
 *      when the event has no chat_thread_id yet, so the button becomes live
 *      immediately after RSVPing even for events the host never manually
 *      configured.
 *
 *   2. POST /events/:id/chat/join — lazily creates a chat thread when
 *      chat_thread_id is null, returns { threadId } immediately rather than
 *      404'ing.
 *
 * Both tests confirm: a row appears in message_threads, and the events row's
 * chat_thread_id is updated to match.
 *
 * Run: node --import tsx/esm --test src/test/eventChatLazyCreate.test.ts
 *
 * NOTE: All suites inside one outer describe to prevent parallel execution
 * races on the shared _setTestClient global.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import eventsRouter from "../routes/events.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ATTENDER_TOKEN = "event-chat-attender-token";
const HOST_TOKEN     = "event-chat-host-token";
const ATTENDER_ID    = "aaaaaaaa-ec10-4000-a000-000000000001";
const HOST_ID        = "bbbbbbbb-ec10-4000-a000-000000000002";
const EVENT_ID       = "cccccccc-ec10-4000-a000-000000000003";

// A published open event with chat enabled and NO chat_thread_id yet.
const BASE_EVENT_ROW = {
  id:                EVENT_ID,
  host_id:           HOST_ID,
  title:             "Open Mic Night",
  description:       null,
  location_name:     "The Stage",
  location_lat:      null,
  location_lng:      null,
  starts_at:         "2026-10-01T20:00:00Z",
  ends_at:           null,
  cover_url:         null,
  cover_media_type:  null,
  max_attendees:     null,
  age_min:           null,
  age_max:           null,
  trust_score_min:   null,
  verified_only:     false,
  visibility:        "public",
  state:             "open",
  chat_enabled:      true,
  chat_thread_id:    null,   // ← the key pre-condition: no thread yet
  waitlist_enabled:  false,
  waitlist_count:    0,
  going_count:       3,
  rsvp_options:      ["going", "maybe", "interested", "cant_go"],
  rsvp_closed:       false,
  price_type:        "free",
  price_url:         null,
  safety_notes:      null,
  tags:              [],
  category:          "nightlife",
  city:              "Manila",
  country:           "Philippines",
  show_exact_location: false,
  show_header_publicly: true,
  created_at:        "2026-09-01T10:00:00Z",
  updated_at:        "2026-09-01T10:00:00Z",
};

// ── Fake client factory ───────────────────────────────────────────────────────

interface FakeState {
  events?:                Record<string, any>[];
  event_rsvps?:           Record<string, any>[];
  event_roles?:           Record<string, any>[];
  blocks?:                Record<string, any>[];
  feature_flags?:         Record<string, any>[];
  message_threads?:       Record<string, any>[];
  message_thread_members?: Record<string, any>[];
  event_attendees?:       Record<string, any>[];
  event_waitlist?:        Record<string, any>[];
  trust_profiles?:        Record<string, any>[];
  profiles?:              Record<string, any>[];
  event_join_requests?:   Record<string, any>[];
  circle_memberships?:    Record<string, any>[];
  trip_members?:          Record<string, any>[];
}

/**
 * `fail` makes the named operation on the named table answer
 * `{ data: null, error }` — the RESOLVED failure supabase-js really produces,
 * never a throw. Without it this double modelled only success, so every error
 * branch in createEventChatThread was unreachable from these tests.
 */
interface FailSpec { table: string; op: "insert" | "update" | "select" }

function makeFakeClient(
  initialState: FakeState,
  callerToken: string,
  callerId: string,
  fail: readonly FailSpec[] = [],
) {
  const fails = (table: string, op: FailSpec["op"]): boolean =>
    fail.some((f) => f.table === table && f.op === op);
  const dbError = (table: string, op: string) => ({ message: `${table} ${op} failed`, code: "57014" });
  // Mutable state — updates persist within the request so createEventChatThread's
  // conditional-update + re-read pattern resolves correctly.
  const state: Required<FakeState> = {
    events:                 [...(initialState.events ?? [])],
    event_rsvps:            [...(initialState.event_rsvps ?? [])],
    event_roles:            [...(initialState.event_roles ?? [])],
    blocks:                 [...(initialState.blocks ?? [])],
    feature_flags:          initialState.feature_flags ?? [
      { flag: "events_enabled",              enabled: true },
      { flag: "events_chat_enabled",         enabled: true },
      { flag: "events_trust_gates_enabled",  enabled: false },
      { flag: "events_waitlist_enabled",     enabled: true },
    ],
    message_threads:        [...(initialState.message_threads ?? [])],
    message_thread_members: [...(initialState.message_thread_members ?? [])],
    event_attendees:        [...(initialState.event_attendees ?? [])],
    event_waitlist:         [...(initialState.event_waitlist ?? [])],
    trust_profiles:         [...(initialState.trust_profiles ?? [])],
    profiles:               [...(initialState.profiles ?? [
      { id: HOST_ID,     handle: "host",     expo_push_token: null },
      { id: ATTENDER_ID, handle: "attender", expo_push_token: null },
    ])],
    event_join_requests:    [...(initialState.event_join_requests ?? [])],
    circle_memberships:     [...(initialState.circle_memberships ?? [])],
    trip_members:           [...(initialState.trip_members ?? [])],
  };

  function getRows(table: string): any[] {
    return (state as any)[table] ?? [];
  }

  function builder(table: string) {
    let rows = getRows(table);
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any  = null;
    let pendingUpdate: any  = null;
    let pendingUpsert: any  = null;
    let pendingDelete        = false;
    let _single              = false;
    let _maybe               = false;
    let isSelectAfterUpdate  = false;

    const b: any = {
      select(_cols?: string) {
        if (pendingUpdate !== null) isSelectAfterUpdate = true;
        return b;
      },
      insert(row: any) {
        pendingInsert = row;
        // A failing INSERT must not leave the row behind: a double that both
        // reports an error and writes the row makes the rollback under test
        // unobservable.
        if (fails(table, "insert")) return b;
        const rows_to_add = Array.isArray(row) ? row : [row];
        const tbl: any[] = (state as any)[table] ?? [];
        for (const r of rows_to_add) {
          const newRow = { id: `gen-${table}-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...r };
          tbl.push(newRow);
          pendingInsert = newRow; // capture last for single()
        }
        (state as any)[table] = tbl;
        return b;
      },
      update(patch: any) {
        pendingUpdate = patch;
        return b;
      },
      upsert(row: any, _opts?: any) {
        pendingUpsert = row;
        const rows_to_add = Array.isArray(row) ? row : [row];
        const tbl: any[] = (state as any)[table] ?? [];
        (state as any)[table] = tbl;
        for (const r of rows_to_add) {
          const exists = tbl.find((existing: any) =>
            Object.keys(r).every((k) => existing[k] === r[k] || !["id", "event_id", "user_id", "thread_id"].includes(k))
          );
          if (!exists) {
            tbl.push({ id: `gen-${table}-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...r });
          } else {
            Object.assign(exists, r);
          }
        }
        return b;
      },
      delete() {
        pendingDelete = true;
        return b;
      },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
      not(col: string, op: string, val: any) {
        if (op === "is") filters.push((r) => r[col] !== val);
        return b;
      },
      is(col: string, val: any) {
        filters.push((r) => val === null ? (r[col] == null) : r[col] === val);
        return b;
      },
      ilike(col: string, pattern: string) {
        const escaped = pattern.replace(/%/g, "").toLowerCase();
        filters.push((r) => String(r[col] ?? "").toLowerCase().includes(escaped));
        return b;
      },
      gt(col: string, val: any)    { filters.push((r) => r[col] > val); return b; },
      gte(col: string, val: any)   { filters.push((r) => r[col] >= val); return b; },
      lte(col: string, val: any)   { filters.push((r) => r[col] <= val); return b; },
      or(_expr: string)            { return b; },
      order()                      { return b; },
      limit(_n: number)            { return b; },
      range()                      { return b; },
      maybeSingle() { _maybe = true; return resolve(); },
      single()      { _single = true; return resolve(); },
      then(onF: any, onR?: any)    { return resolveList().then(onF, onR); },
    };

    async function resolve(): Promise<{ data: any; error: any }> {
      if (pendingInsert !== null && fails(table, "insert")) return { data: null, error: dbError(table, "insert") };
      if (pendingUpdate !== null && fails(table, "update")) return { data: null, error: dbError(table, "update") };
      if (pendingInsert === null && pendingUpdate === null && pendingUpsert === null
          && !pendingDelete && fails(table, "select")) {
        return { data: null, error: dbError(table, "select") };
      }
      if (pendingDelete) {
        const tbl: any[] = (state as any)[table] ?? [];
        (state as any)[table] = tbl.filter((r) => !filters.every((f) => f(r)));
        return { data: null, error: null };
      }
      if (pendingInsert !== null) {
        return { data: pendingInsert, error: null };
      }
      if (pendingUpdate !== null) {
        // Conditional update: apply patch to matched rows, return first updated row.
        const tbl: any[] = (state as any)[table] ?? [];
        const matched = tbl.filter((r) => filters.every((f) => f(r)));
        if (matched.length === 0) return { data: null, error: null };
        Object.assign(matched[0], pendingUpdate);
        return { data: { ...matched[0] }, error: null };
      }
      rows = getRows(table);
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: _maybe ? (matched[0] ?? null) : (matched[0] ?? null), error: null };
    }

    async function resolveList(): Promise<{ data: any; error: any; count: number }> {
      if (pendingInsert !== null && fails(table, "insert")) return { data: null, error: dbError(table, "insert"), count: 0 };
      if (pendingUpdate !== null && fails(table, "update")) return { data: null, error: dbError(table, "update"), count: 0 };
      if (pendingInsert === null && pendingUpdate === null && pendingUpsert === null
          && !pendingDelete && fails(table, "select")) {
        return { data: null, error: dbError(table, "select"), count: 0 };
      }
      if (pendingDelete) {
        const tbl: any[] = (state as any)[table] ?? [];
        (state as any)[table] = tbl.filter((r) => !filters.every((f) => f(r)));
        return { data: [], error: null, count: 0 };
      }
      if (pendingInsert !== null) {
        const row = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        return { data: row, error: null, count: row.length };
      }
      if (pendingUpsert !== null) {
        const row = Array.isArray(pendingUpsert) ? pendingUpsert : [pendingUpsert];
        return { data: row, error: null, count: row.length };
      }
      if (pendingUpdate !== null) {
        // update().select() returning an array (e.g. conditional claim in createEventChatThread)
        const tbl: any[] = (state as any)[table] ?? [];
        const matched = tbl.filter((r) => filters.every((f) => f(r)));
        for (const r of matched) Object.assign(r, pendingUpdate);
        return { data: matched.map((r) => ({ ...r })), error: null, count: matched.length };
      }
      rows = getRows(table);
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: matched, error: null, count: matched.length };
    }

    return b;
  }

  const client: any = {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (token: string) => {
        if (token === callerToken) return { data: { user: { id: callerId } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    // Expose state so tests can assert side-effects.
    __state: state,
  };
  return client;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function apiReq(
  method: string,
  path: string,
  body: unknown | undefined,
  port: number,
  token: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
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

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Event Chat — lazy thread creation", () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    const app = express();
    app.use(express.json());
    // Shimming req.log so the route doesn't crash without pino.
    app.use((_req: any, _res, next) => {
      (_req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      next();
    });
    app.use("/api", eventsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as any).port as number;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  afterEach(() => { _setTestClient(null as any, false); });

  // ── Test 1: /chat/join lazily creates a thread ────────────────────────────

  describe("POST /events/:id/chat/join", () => {
    it("returns threadId and creates a message_threads row when event has no chat_thread_id", async () => {
      const client = makeFakeClient(
        {
          events: [{ ...BASE_EVENT_ROW }],
          event_rsvps: [
            // Attender has a Going RSVP already
            { event_id: EVENT_ID, user_id: ATTENDER_ID, status: "going" },
          ],
          event_roles: [],
          blocks: [],
        },
        ATTENDER_TOKEN,
        ATTENDER_ID,
      );
      _setTestClient(client, true);

      const res = await apiReq(
        "POST",
        `/api/events/${EVENT_ID}/chat/join`,
        undefined,
        port,
        ATTENDER_TOKEN,
      );

      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.threadId, "response must include threadId");
      assert.match(
        res.body.threadId,
        /^[0-9a-f-]{36}$/i,
        "threadId must be a UUID",
      );

      // Side-effect: a message_threads row was created.
      const threads: any[] = client.__state.message_threads ?? [];
      assert.ok(
        threads.length > 0,
        "a message_threads row must have been inserted",
      );

      // The event's chat_thread_id must now match the returned threadId.
      const evRow: any = client.__state.events?.find((e: any) => e.id === EVENT_ID);
      assert.equal(
        evRow?.chat_thread_id,
        res.body.threadId,
        "events.chat_thread_id must be updated to the newly created threadId",
      );
    });

    it("the CREATOR is a member of the thread — proven on the path where NOTHING ELSE adds them", async () => {
      // Deliberately driven through POST /events/:id/publish, not /chat/join.
      // The join route calls addUserToChatThread(sc, threadId, user.id) right
      // after createEventChatThread, so a membership assertion made there is
      // satisfied by that second call and says nothing about the insert inside
      // createEventChatThread — hand-reverting that insert left the join-path
      // version of this case GREEN. The publish path has no such second writer:
      // the only thing that can produce a member row is the insert under test.
      //
      // The insert's result was DISCARDED, so a live thread whose own creator
      // could not see it was indistinguishable from a healthy one.
      //
      // REPORTED, not fixed here: createEventChatThread's fourth parameter is
      // named `hostId` but receives `user.id`. On the JOIN path that is the
      // attendee, so an event whose chat is first opened by an attendee has a
      // thread the host is not a member of. Changing that is a chat-membership
      // decision and touches addUserToChatThread, which is not this lane's file.
      const client = makeFakeClient(
        {
          events: [{ ...BASE_EVENT_ROW, state: "draft" }],
          event_roles: [{ event_id: EVENT_ID, user_id: HOST_ID, role: "host" }],
        },
        HOST_TOKEN,
        HOST_ID,
      );
      _setTestClient(client, true);

      const res = await apiReq("POST", `/api/events/${EVENT_ID}/publish`, undefined, port, HOST_TOKEN);
      assert.equal(res.status, 200, `publish must succeed for this case to mean anything: ${JSON.stringify(res.body)}`);

      const threads: any[] = client.__state.message_threads ?? [];
      assert.equal(threads.length, 1, "publish with chat_enabled must create exactly one thread");
      const threadId = threads[0]!.id;

      const members: any[] = client.__state.message_thread_members ?? [];
      // Non-zero AND the right row: a count assertion alone passes on a fake
      // that inserts anything at all.
      assert.equal(members.length, 1, `expected exactly one member row, got ${JSON.stringify(members)}`);
      assert.equal(members[0]!.thread_id, threadId);
      assert.equal(members[0]!.user_id, HOST_ID,
        "the host who published the event is not a member of its chat thread");
    });

    it("ROLLS BACK the claim when the message_threads insert fails — no permanent dead end", async () => {
      // The claim (`UPDATE events SET chat_thread_id = <new> WHERE chat_thread_id IS NULL`)
      // can only ever be won once. If the thread insert then fails and the claim
      // is not released, events.chat_thread_id points at a message_threads row
      // that does not exist and NO later call can repair it — the "silent dead
      // end" this whole file exists to prevent, arrived at from the other side.
      const client = makeFakeClient(
        {
          events: [{ ...BASE_EVENT_ROW }],
          event_rsvps: [{ event_id: EVENT_ID, user_id: ATTENDER_ID, status: "going" }],
        },
        ATTENDER_TOKEN,
        ATTENDER_ID,
        [{ table: "message_threads", op: "insert" }],
      );
      _setTestClient(client, true);

      const res = await apiReq("POST", `/api/events/${EVENT_ID}/chat/join`, undefined, port, ATTENDER_TOKEN);

      assert.notEqual(res.status, 200, `a thread that was not created must not be reported: ${JSON.stringify(res.body)}`);
      assert.ok(!res.body?.threadId, "no threadId may be handed back for a thread that does not exist");
      const evRow: any = client.__state.events?.find((e: any) => e.id === EVENT_ID);
      assert.equal(evRow?.chat_thread_id, null,
        "the claim must be released so a retry can win it — otherwise the event's chat is dead forever");
      assert.equal((client.__state.message_threads ?? []).length, 0, "no orphan thread row");
    });

    it("a RETRY after a rolled-back failure succeeds — the healthy twin", async () => {
      // Without this, "always roll back" or "never claim" would pass the case
      // above and make chat un-creatable.
      const state = {
        events: [{ ...BASE_EVENT_ROW }],
        event_rsvps: [{ event_id: EVENT_ID, user_id: ATTENDER_ID, status: "going" }],
      };
      const failing = makeFakeClient(state, ATTENDER_TOKEN, ATTENDER_ID,
        [{ table: "message_threads", op: "insert" }]);
      _setTestClient(failing, true);
      await apiReq("POST", `/api/events/${EVENT_ID}/chat/join`, undefined, port, ATTENDER_TOKEN);

      // Same event row, carried over with whatever the failed attempt left on it.
      const healthy = makeFakeClient(
        { events: failing.__state.events, event_rsvps: failing.__state.event_rsvps },
        ATTENDER_TOKEN,
        ATTENDER_ID,
      );
      _setTestClient(healthy, true);
      const res = await apiReq("POST", `/api/events/${EVENT_ID}/chat/join`, undefined, port, ATTENDER_TOKEN);

      assert.equal(res.status, 200, `the retry must succeed: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.threadId);
      assert.equal((healthy.__state.message_threads ?? []).length, 1);
    });

    it("returns 403 when the user does not have a Going RSVP", async () => {
      const client = makeFakeClient(
        {
          events: [{ ...BASE_EVENT_ROW }],
          event_rsvps: [],  // no RSVP
          event_roles: [],
          blocks: [],
        },
        ATTENDER_TOKEN,
        ATTENDER_ID,
      );
      _setTestClient(client, true);

      const res = await apiReq(
        "POST",
        `/api/events/${EVENT_ID}/chat/join`,
        undefined,
        port,
        ATTENDER_TOKEN,
      );

      assert.equal(res.status, 403, `expected 403, got ${res.status}`);

      // No thread should have been created.
      const threads: any[] = client.__state.message_threads ?? [];
      assert.equal(threads.length, 0, "no thread must be created for an unauthorised join");
    });

    it("returns existing threadId without creating a second thread when one already exists", async () => {
      const EXISTING_THREAD_ID = "dddddddd-ec10-4000-a000-000000000004";
      const client = makeFakeClient(
        {
          events: [{ ...BASE_EVENT_ROW, chat_thread_id: EXISTING_THREAD_ID }],
          event_rsvps: [
            { event_id: EVENT_ID, user_id: ATTENDER_ID, status: "going" },
          ],
          event_roles: [],
          blocks: [],
          message_threads: [
            { id: EXISTING_THREAD_ID, title: "Open Mic Night" },
          ],
        },
        ATTENDER_TOKEN,
        ATTENDER_ID,
      );
      _setTestClient(client, true);

      const res = await apiReq(
        "POST",
        `/api/events/${EVENT_ID}/chat/join`,
        undefined,
        port,
        ATTENDER_TOKEN,
      );

      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      assert.equal(
        res.body.threadId,
        EXISTING_THREAD_ID,
        "must return the existing threadId, not a new one",
      );

      // No new thread should have been inserted.
      const threads: any[] = client.__state.message_threads ?? [];
      assert.equal(threads.length, 1, "must not create a second message_threads row");
    });
  });

  // ── Test 2: /rsvp (status=going) lazily creates a thread ─────────────────

  describe("POST /events/:id/rsvp", () => {
    it("creates a message_threads row when user RSVPs going to an event with no thread", async () => {
      const client = makeFakeClient(
        {
          events: [{ ...BASE_EVENT_ROW }],
          event_rsvps: [],
          event_roles: [],
          blocks: [],
        },
        ATTENDER_TOKEN,
        ATTENDER_ID,
      );
      _setTestClient(client, true);

      const res = await apiReq(
        "POST",
        `/api/events/${EVENT_ID}/rsvp`,
        { status: "going" },
        port,
        ATTENDER_TOKEN,
      );

      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

      // Side-effect: message_threads row must have been created.
      const threads: any[] = client.__state.message_threads ?? [];
      assert.ok(
        threads.length > 0,
        "a message_threads row must have been inserted after a Going RSVP",
      );

      // events.chat_thread_id must be updated.
      const evRow: any = client.__state.events?.find((e: any) => e.id === EVENT_ID);
      assert.ok(
        evRow?.chat_thread_id != null,
        "events.chat_thread_id must be set after lazy creation via RSVP",
      );
    });

    it("does not create a thread when RSVP status is maybe (not going)", async () => {
      const client = makeFakeClient(
        {
          events: [{ ...BASE_EVENT_ROW }],
          event_rsvps: [],
          event_roles: [],
          blocks: [],
        },
        ATTENDER_TOKEN,
        ATTENDER_ID,
      );
      _setTestClient(client, true);

      const res = await apiReq(
        "POST",
        `/api/events/${EVENT_ID}/rsvp`,
        { status: "maybe" },
        port,
        ATTENDER_TOKEN,
      );

      assert.equal(res.status, 200, `expected 200, got ${res.status}`);

      // No thread should be created for non-going RSVPs.
      const threads: any[] = client.__state.message_threads ?? [];
      assert.equal(
        threads.length,
        0,
        "no message_threads row should be created for a maybe RSVP",
      );
    });
  });
});
