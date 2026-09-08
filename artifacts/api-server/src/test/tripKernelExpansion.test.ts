/**
 * Trip Kernel, third pass — the gated writers in routes/trips-expansion.ts and
 * routes/requests.ts (Trips spec §4, §6.1, §24 Phase 1; lib/tripKernel.ts;
 * migrations 2420 / 2450 / 2500).
 *
 * WHAT IS PROVEN HERE
 * ===================
 *  1. Flag OFF (its seeded value): every one of the ten endpoints performs the
 *     SAME direct write it performed before this pass — pinned as the exact
 *     sequence of (table, verb, payload, filters) the fake client observed —
 *     the kernel function is never called, trips.version stays 0, no event is
 *     written, and the HTTP answer is the legacy answer. That is the
 *     "gated-off byte-identity" claim, measured rather than asserted.
 *  2. Flag ON: each endpoint issues the command it maps to, with the actor the
 *     route authorized, and the legacy write does NOT run.
 *  3. The join-request approve reads the row first and issues ADD_PARTICIPANT
 *     or SET_PARTICIPANT_ROLE accordingly; the kernel refuses to touch the
 *     owner's row, which the legacy upsert would silently downgrade; and a
 *     co-host approver needs the `host` capability (2500) — against a 2450
 *     database the kernel answers TRIP_AUTH_NOT_OWNER.
 *  4. The invite-link join issues JOIN_VIA_LINK with the JOINER as actor; the
 *     kernel's ALREADY_EXISTS / CAPACITY_REACHED rejections drive the SAME
 *     compensation branches as the legacy 23505 / trip_full errors; a
 *     malformed envelope is refused BEFORE a slot is claimed; a 2450 database
 *     (TRIP_COMMAND_UNKNOWN_TYPE) releases the slot and clears the attempt.
 *
 * WHAT THE FAKE IS AND IS NOT
 * ===========================
 * The rpc fake models public.trip_kernel_execute as amended by 2500 for the
 * ten command types these routes issue. It is a MODEL of the SQL; the SQL's
 * own semantics were rehearsed on portava-ci in a rolled-back transaction and
 * recorded in the lane report.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/tripKernelExpansion.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import tripsExpansionRouter from "../routes/trips-expansion.js";
import requestsRouter from "../routes/requests.js";
import { _resetTripCommandRejectedTotal, readTripCommandRejectedTotal } from "../lib/tripKernel.js";

// ── IDs ───────────────────────────────────────────────────────────────────────
const ALICE = "aaaaaaaa-0000-0000-0000-000000000001"; // owner (trip_members role owner)
const BOB   = "bbbbbbbb-0000-0000-0000-000000000002"; // accepted member
const CAROL = "cccccccc-0000-0000-0000-000000000003"; // stranger / requester / joiner
const DAVE  = "dddddddd-0000-0000-0000-000000000004"; // pending invitee (role 'invited')
const ERIN  = "eeeeeeee-0000-0000-0000-000000000005"; // co_host
const TRIP  = "33333333-0000-0000-0000-000000000001";
const REQ   = "44444444-0000-0000-0000-000000000001";
const LINK  = "55555555-0000-0000-0000-000000000001";
const TOKEN = "tok-abc";

const CANONICAL = new Set(["trips", "trip_members", "trip_plan_items"]);

interface Write { table: string; verb: "insert" | "update" | "upsert" | "delete"; payload: any; filters: Array<[string, any]> }
interface State {
  users: Record<string, { id: string }>;
  tables: Record<string, any[]>;
  writes: Write[];
  rpcCalls: Array<{ name: string; args: any }>;
  /** 'v2500' models 2450+2500; 'v2450' models 2450 alone (no JOIN_VIA_LINK, ADD/SET need owner). */
  kernel: "v2500" | "v2450";
  claimAnswer: "claimed" | "already_attempted" | "limit_reached" | "trip_full";
}

function baseState(kernelOn: boolean): State {
  return {
    users: { "alice-tok": { id: ALICE }, "bob-tok": { id: BOB }, "carol-tok": { id: CAROL }, "dave-tok": { id: DAVE }, "erin-tok": { id: ERIN } },
    tables: {
      trips: [{ id: TRIP, owner_id: ALICE, version: 0, title: "Lisbon", destination_city: "Lisbon", destination_country: "PT",
        start_date: "2026-10-01", end_date: "2026-10-05", status: "upcoming", visibility: "private", timezone: "Europe/Lisbon",
        trip_type: "leisure", open_to_meet: false, cover_url: null, trip_notes: null, show_in_discovery: false, max_members: null,
        show_header_publicly: false, internal_notes: "NEVER", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
      trip_members: [
        { trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" },
        { trip_id: TRIP, user_id: BOB, role: "member", status: "accepted" },
        { trip_id: TRIP, user_id: DAVE, role: "invited", status: "accepted" },
        { trip_id: TRIP, user_id: ERIN, role: "co_host", status: "accepted" },
      ],
      trip_join_requests: [{ id: REQ, trip_id: TRIP, user_id: CAROL, status: "pending", created_at: "2026-01-01T00:00:00.000Z" }],
      trip_invite_links: [{ id: LINK, trip_id: TRIP, token: TOKEN, created_by: ALICE, revoked_at: null, expires_at: null, max_uses: null, use_count: 0 }],
      trip_invite_link_attempts: [],
      feature_flags: kernelOn ? [{ flag: "trip_kernel_enabled", enabled: true }] : [],
      profiles: [{ id: ALICE, account_status: "active" }, { id: BOB, account_status: "active" }, { id: CAROL, account_status: "active" },
        { id: DAVE, account_status: "active" }, { id: ERIN, account_status: "active" }],
      trip_events: [], trip_outbox: [], trip_command_receipts: [],
    },
    writes: [], rpcCalls: [], kernel: "v2500", claimAnswer: "claimed",
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────
function makeFakeClient(state: State) {
  const T = state.tables;
  const src = (t: string) => (T[t] ??= []);

  function from(table: string) {
    const filters: Array<[string, any]> = [];
    const preds: Array<(r: any) => boolean> = [];
    let verb: Write["verb"] | "select" = "select";
    let payload: any = null;
    let single = false;
    // The real PostgrestBuilder returns the AFFECTED ROWS when a write carries
    // `.select()`, and `data: null` when it does not — that difference is the
    // only way a route can tell "updated 1 row" from "matched nothing", so the
    // fake has to model it rather than answer null for both. (It answered null
    // for both until routes/trips-expansion.ts started asking.)
    let selected = false;
    const b: any = {
      select() { selected = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      update(p: any) { verb = "update"; payload = p; return b; },
      upsert(p: any, opts?: any) { verb = "upsert"; payload = { row: p, opts }; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { filters.push([c, v]); preds.push((r) => r[c] === v); return b; },
      in(c: string, vs: any[]) { filters.push([c, vs]); preds.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      or() { return b; }, not() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; },
      gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; }, neq() { return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };
    const match = () => src(table).filter((r) => preds.every((p) => p(r)));
    async function run(): Promise<{ data: any; error: any }> {
      if (verb === "select") { const m = match(); return { data: single ? (m[0] ?? null) : m, error: null }; }
      state.writes.push({ table, verb, payload, filters });
      if (verb === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ id: `${table}-${src(table).length + 1}`, created_at: "2026-01-02T00:00:00.000Z", ...r }));
        if (table === "trip_members" && rows.some((r: any) => src(table).some((e) => e.trip_id === r.trip_id && e.user_id === r.user_id))) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        src(table).push(...rows);
        return { data: single ? rows[0] : rows, error: null };
      }
      if (verb === "update") {
        let last: any = null;
        const touched: any[] = [];
        for (const r of src(table)) if (preds.every((p) => p(r))) { Object.assign(r, payload); last = r; touched.push(r); }
        if (single) return { data: last, error: null };
        return { data: selected ? touched : null, error: null };
      }
      if (verb === "upsert") {
        const row = payload.row;
        const ex = src(table).find((e) => e.trip_id === row.trip_id && e.user_id === row.user_id);
        if (ex) Object.assign(ex, row); else src(table).push({ ...row });
        return { data: null, error: null };
      }
      T[table] = src(table).filter((r) => !preds.every((p) => p(r)));
      return { data: null, error: null };
    }
    return b;
  }

  // In-memory model of trip_kernel_execute (2450 + 2500) for the commands these routes issue.
  async function rpc(name: string, args: any) {
    state.rpcCalls.push({ name, args });
    if (name === "claim_invite_link_slot_for_user") {
      if (state.claimAnswer === "claimed") T.trip_invite_link_attempts.push({ link_id: args.p_link_id, user_id: args.p_user_id });
      return { data: state.claimAnswer, error: null };
    }
    if (name === "release_invite_link_slot") return { data: null, error: null };
    if (name !== "trip_kernel_execute") return { data: null, error: { message: `unknown rpc ${name}` } };
    const c = args.p_command;
    const p = c.payload ?? {};
    const reject = (reason: string, extra: Record<string, unknown> = {}) => ({ data: { ok: false, reason, ...extra, contract_version: 2 }, error: null });
    const REQUIRED: Record<string, string> = state.kernel === "v2500"
      ? { UPDATE_TRIP: "owner", CANCEL_TRIP: "owner", COMPLETE_TRIP: "owner", ARCHIVE_TRIP: "owner", ADD_PARTICIPANT: "host",
          SET_PARTICIPANT_ROLE: "host", REMOVE_PARTICIPANT: "owner", ACCEPT_INVITE: "invited", DECLINE_INVITE: "invited", JOIN_VIA_LINK: "link_holder" }
      : { UPDATE_TRIP: "owner", CANCEL_TRIP: "owner", COMPLETE_TRIP: "owner", ARCHIVE_TRIP: "owner", ADD_PARTICIPANT: "owner",
          SET_PARTICIPANT_ROLE: "owner", REMOVE_PARTICIPANT: "owner", ACCEPT_INVITE: "invited", DECLINE_INVITE: "invited" };
    const required = REQUIRED[c.type];
    if (required === undefined) return reject("TRIP_COMMAND_UNKNOWN_TYPE", { type: c.type });
    const trip = T.trips.find((t) => t.id === c.trip_id);
    if (!trip) return reject("TRIP_NOT_FOUND");
    const rowOf = (u: string) => T.trip_members.find((m) => m.trip_id === c.trip_id && m.user_id === u);
    const isOwner = trip.owner_id === c.actor_user_id || rowOf(c.actor_user_id)?.role === "owner";
    const isHost = isOwner || (rowOf(c.actor_user_id)?.role === "co_host" && (rowOf(c.actor_user_id)?.status ?? "accepted") === "accepted");
    let linkId: string | null = null;
    if (required === "owner" && !isOwner) return reject("TRIP_AUTH_NOT_OWNER");
    if (required === "host" && !isHost) return reject("TRIP_AUTH_NOT_HOST");
    if (required === "invited" && rowOf(c.actor_user_id)?.role !== "invited") return reject("TRIP_AUTH_NOT_INVITED", { current_role: rowOf(c.actor_user_id)?.role ?? null });
    if (required === "link_holder") {
      if (!p.invite_link_id) return reject("TRIP_COMMAND_MALFORMED", { detail: "invite_link_id required" });
      const link = T.trip_invite_links.find((l) => l.id === p.invite_link_id && l.trip_id === c.trip_id && !l.revoked_at);
      const attempt = T.trip_invite_link_attempts.find((a) => a.link_id === p.invite_link_id && a.user_id === c.actor_user_id);
      if (!link || !attempt) return reject("TRIP_AUTH_NOT_LINK_HOLDER");
      linkId = link.id;
    }
    if (c.expected_trip_version != null && c.expected_trip_version !== trip.version) return reject("TRIP_VERSION_CONFLICT", { current_version: trip.version, expected_version: c.expected_trip_version });

    let eventType: string; let result: any;
    switch (c.type) {
      case "UPDATE_TRIP": {
        const from = trip.status, to = p.patch?.status ?? from;
        if (to !== from && ["cancelled", "archived"].includes(from)) return reject("TRIP_LIFECYCLE_INVALID_TRANSITION", { from, to });
        Object.assign(trip, p.patch, { updated_at: p.updated_at });
        eventType = "trip.updated"; result = { ...trip }; break;
      }
      case "CANCEL_TRIP": case "COMPLETE_TRIP": case "ARCHIVE_TRIP": {
        const to = c.type === "CANCEL_TRIP" ? "cancelled" : c.type === "COMPLETE_TRIP" ? "completed" : "archived";
        const from = trip.status;
        if (from === to || from === "archived" || (c.type === "COMPLETE_TRIP" && from === "cancelled")) return reject("TRIP_LIFECYCLE_INVALID_TRANSITION", { from, to });
        trip.status = to; trip.updated_at = p.updated_at;
        eventType = `trip.trip_${to}`; result = { ...trip }; break;
      }
      case "ADD_PARTICIPANT": {
        if (!p.user_id) return reject("TRIP_COMMAND_MALFORMED");
        if (rowOf(p.user_id)) return reject("TRIP_PARTICIPANT_ALREADY_EXISTS", { current_role: rowOf(p.user_id).role });
        const row = { trip_id: c.trip_id, user_id: p.user_id, role: p.role ?? "member", status: p.status ?? "accepted", joined_at: p.joined_at ?? null, invite_link_id: p.invite_link_id ?? null };
        T.trip_members.push(row);
        eventType = "trip.participant_added"; result = row; break;
      }
      case "SET_PARTICIPANT_ROLE": {
        const row = rowOf(p.user_id);
        if (!row) return reject("TRIP_PARTICIPANT_NOT_FOUND");
        if (row.role === "owner" || p.user_id === trip.owner_id) return reject("TRIP_PARTICIPANT_IS_OWNER");
        row.role = p.role;
        eventType = "trip.participant_role_set"; result = { ...row }; break;
      }
      case "REMOVE_PARTICIPANT": {
        const row = rowOf(p.user_id);
        if (!row) return reject("TRIP_PARTICIPANT_NOT_FOUND");
        if (row.role === "owner") return reject("TRIP_PARTICIPANT_IS_OWNER");
        T.trip_members = T.trip_members.filter((m) => m !== row);
        eventType = "trip.participant_removed"; result = { role_at_removal: row.role }; break;
      }
      case "ACCEPT_INVITE": { const row = rowOf(c.actor_user_id); row.role = "member"; eventType = "trip.participant_joined"; result = { ...row }; break; }
      case "DECLINE_INVITE": { T.trip_members = T.trip_members.filter((m) => !(m.trip_id === c.trip_id && m.user_id === c.actor_user_id)); eventType = "trip.participant_declined"; result = {}; break; }
      case "JOIN_VIA_LINK": {
        if (rowOf(c.actor_user_id)) return reject("TRIP_PARTICIPANT_ALREADY_EXISTS", { current_role: rowOf(c.actor_user_id).role });
        if (trip.max_members != null && T.trip_members.filter((m) => m.trip_id === c.trip_id && m.status === "accepted").length >= trip.max_members) return reject("TRIP_PARTICIPANT_CAPACITY_REACHED");
        const row = { trip_id: c.trip_id, user_id: c.actor_user_id, role: "member", status: "accepted", joined_at: p.joined_at, invite_link_id: linkId };
        T.trip_members.push(row);
        eventType = "trip.participant_joined"; result = { ...row }; break;
      }
      default: return reject("TRIP_COMMAND_UNKNOWN_TYPE", { type: c.type });
    }
    trip.version += 1;
    const event_id = `evt-${T.trip_events.length + 1}`;
    T.trip_events.push({ event_id, trip_id: c.trip_id, aggregate_version: trip.version, type: eventType, actor_user_id: c.actor_user_id, payload_json: { command_type: c.type, payload: p, via: p.via ?? (c.type === "JOIN_VIA_LINK" ? "invite_link" : undefined) } });
    T.trip_outbox.push({ event_id, type: eventType });
    T.trip_command_receipts.push({ trip_id: c.trip_id, idempotency_key: c.idempotency_key, command_type: c.type, actor_user_id: c.actor_user_id });
    return { data: { ok: true, duplicate: false, version: trip.version, event_id, sequence: T.trip_events.length, result, contract_version: 2 }, error: null };
  }

  return {
    from, rpc,
    auth: { getUser: async (token: string) => state.users[token] ? { data: { user: state.users[token] }, error: null } : { data: { user: null }, error: { message: "invalid token" } } },
  };
}

// ── Server helpers ─────────────────────────────────────────────────────────────
interface TestServer { port: number; state: State; close: () => Promise<void> }
async function startServer(state: State): Promise<TestServer> {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", tripsExpansionRouter);
  app.use("/api", requestsRouter);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({ port, state, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
    srv.on("error", reject);
  });
}

async function call(port: number, method: string, path: string, token: string, body?: any, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, version: res.headers.get("x-trip-version") };
}

const canonicalWrites = (s: State) => s.writes.filter((w) => CANONICAL.has(w.table)).map((w) => ({ table: w.table, verb: w.verb, payload: w.payload, filters: w.filters }));
const kernelCalls = (s: State) => s.rpcCalls.filter((c) => c.name === "trip_kernel_execute");
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ═════════════════════════════════════════════════════════════════════════════
describe("trip_kernel_enabled = false: the ten writes are the legacy direct writes, byte for byte", () => {
  // Each case: (request) => the exact canonical write(s) the legacy statement performs.
  const cases: Array<{ name: string; run: (port: number, s: State) => Promise<any>; expect: (s: State, r: any) => void }> = [
    { name: "PATCH /trips/:id/settings", run: (p) => call(p, "PATCH", `/api/trips/${TRIP}/settings`, "alice-tok", { title: "Lisboa", showInDiscovery: true }),
      expect: (s, r) => {
        assert.equal(r.status, 200); assert.equal(r.body.title, "Lisboa"); assert.equal(r.body.showInDiscovery, true);
        const w = canonicalWrites(s); assert.equal(w.length, 1);
        assert.equal(w[0].table, "trips"); assert.equal(w[0].verb, "update"); assert.deepEqual(w[0].filters, [["id", TRIP]]);
        const { updated_at, ...rest } = w[0].payload; assert.match(updated_at, ISO);
        assert.deepEqual(rest, { title: "Lisboa", show_in_discovery: true, status: "upcoming" });
      } },
    { name: "POST /trips/:id/cancel", run: (p) => call(p, "POST", `/api/trips/${TRIP}/cancel`, "alice-tok"),
      expect: (s, r) => { assert.deepEqual(r.body, { status: "cancelled", tripId: TRIP }); const w = canonicalWrites(s); assert.equal(w.length, 1);
        assert.deepEqual([w[0].table, w[0].verb, w[0].filters, w[0].payload.status], ["trips", "update", [["id", TRIP]], "cancelled"]); assert.match(w[0].payload.updated_at, ISO); } },
    { name: "POST /trips/:id/complete", run: (p) => call(p, "POST", `/api/trips/${TRIP}/complete`, "alice-tok"),
      expect: (s, r) => { assert.deepEqual(r.body, { status: "completed", tripId: TRIP }); const w = canonicalWrites(s); assert.equal(w.length, 1);
        assert.deepEqual([w[0].table, w[0].verb, w[0].filters, w[0].payload.status], ["trips", "update", [["id", TRIP]], "completed"]); } },
    { name: "POST /trips/:id/archive", run: (p) => call(p, "POST", `/api/trips/${TRIP}/archive`, "alice-tok"),
      expect: (s, r) => { assert.deepEqual(r.body, { status: "archived", tripId: TRIP }); const w = canonicalWrites(s); assert.equal(w.length, 1);
        assert.deepEqual([w[0].table, w[0].verb, w[0].filters, w[0].payload.status], ["trips", "update", [["id", TRIP]], "archived"]); } },
    { name: "DELETE /trips/:id (even when already archived: legacy re-writes)", run: async (p, s) => { s.tables.trips[0].status = "archived"; return call(p, "DELETE", `/api/trips/${TRIP}`, "alice-tok"); },
      expect: (s, r) => { assert.equal(r.status, 204); const w = canonicalWrites(s); assert.equal(w.length, 1, "legacy writes archived again, unconditionally");
        assert.deepEqual([w[0].table, w[0].verb, w[0].payload.status], ["trips", "update", "archived"]); } },
    { name: "POST /trips/:id/join-requests/:rid/approve (upsert, no read-first)", run: (p) => call(p, "POST", `/api/trips/${TRIP}/join-requests/${REQ}/approve`, "alice-tok"),
      expect: (s, r) => { assert.equal(r.status, 200); const w = canonicalWrites(s); assert.equal(w.length, 1);
        assert.equal(w[0].verb, "upsert"); assert.deepEqual(w[0].payload.opts, { onConflict: "trip_id,user_id" });
        const { joined_at, ...rest } = w[0].payload.row; assert.match(joined_at, ISO);
        assert.deepEqual(rest, { trip_id: TRIP, user_id: CAROL, role: "member", status: "accepted" }); } },
    { name: "POST /trips/invite-link/:token/accept (insert)", run: (p) => call(p, "POST", `/api/trips/invite-link/${TOKEN}/accept`, "carol-tok"),
      expect: (s, r) => { assert.equal(r.status, 201); assert.deepEqual(r.body, { status: "joined", tripId: TRIP, role: "member" });
        const w = canonicalWrites(s); assert.equal(w.length, 1); assert.equal(w[0].verb, "insert");
        const { joined_at, ...rest } = w[0].payload; assert.match(joined_at, ISO);
        assert.deepEqual(rest, { trip_id: TRIP, user_id: CAROL, role: "member", status: "accepted", invite_link_id: LINK });
        assert.equal(s.tables.trip_invite_link_attempts.length, 0, "attempt row cleared on success"); } },
    { name: "POST /me/requests/trip_invite/:id/accept", run: (p) => call(p, "POST", `/api/me/requests/trip_invite/${TRIP}/accept`, "dave-tok"),
      expect: (s, r) => { assert.deepEqual(r.body, { status: "member", tripId: TRIP }); const w = canonicalWrites(s);
        assert.deepEqual(w, [{ table: "trip_members", verb: "update", payload: { role: "member" }, filters: [["trip_id", TRIP], ["user_id", DAVE]] }]); } },
    { name: "POST /me/requests/trip_invite/:id/decline", run: (p) => call(p, "POST", `/api/me/requests/trip_invite/${TRIP}/decline`, "dave-tok"),
      expect: (s, r) => { assert.deepEqual(r.body, { status: "declined", tripId: TRIP }); const w = canonicalWrites(s);
        assert.deepEqual(w, [{ table: "trip_members", verb: "delete", payload: null, filters: [["trip_id", TRIP], ["user_id", DAVE]] }]); } },
    { name: "POST /me/requests/trip_invite/:id/cancel", run: (p) => call(p, "POST", `/api/me/requests/trip_invite/${TRIP}/cancel`, "alice-tok", { inviteeId: DAVE }),
      expect: (s, r) => { assert.deepEqual(r.body, { status: "cancelled", tripId: TRIP, inviteeId: DAVE }); const w = canonicalWrites(s);
        assert.deepEqual(w, [{ table: "trip_members", verb: "delete", payload: null, filters: [["trip_id", TRIP], ["user_id", DAVE]] }]); } },
  ];

  for (const c of cases) {
    it(`${c.name}: legacy write only, kernel never called, version 0, no event, no X-Trip-Version`, async () => {
      const srv = await startServer(baseState(false));
      const r = await c.run(srv.port, srv.state);
      c.expect(srv.state, r);
      assert.equal(kernelCalls(srv.state).length, 0, "trip_kernel_execute must not be called with the flag off");
      assert.equal(srv.state.tables.trips[0].version, 0);
      assert.equal(srv.state.tables.trip_events.length, 0);
      assert.equal(r.version, null);
      await srv.close();
    });
  }

  it("flag read is fail-closed: an absent feature_flags row is OFF (the seeded value is false; production has no row at all)", async () => {
    const srv = await startServer(baseState(false));
    srv.state.tables.feature_flags = [];
    const r = await call(srv.port, "POST", `/api/trips/${TRIP}/cancel`, "alice-tok");
    assert.equal(r.status, 200);
    assert.equal(kernelCalls(srv.state).length, 0);
    await srv.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("trip_kernel_enabled = true: each write is a command, the legacy twin does not run", () => {
  it("settings -> UPDATE_TRIP with the column patch (updated_at split out), owner actor; the kernel row is what the client sees", async () => {
    const srv = await startServer(baseState(true));
    const r = await call(srv.port, "PATCH", `/api/trips/${TRIP}/settings`, "alice-tok", { title: "Lisboa", showInDiscovery: true }, { "idempotency-key": "k-1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.version, "1");
    assert.equal(r.body.title, "Lisboa");
    assert.equal("internal_notes" in r.body, false);
    assert.deepEqual(canonicalWrites(srv.state), [], "no direct write to a canonical table");
    const cmd = kernelCalls(srv.state)[0].args.p_command;
    assert.equal(cmd.type, "UPDATE_TRIP");
    assert.equal(cmd.actor_user_id, ALICE);
    assert.equal(cmd.idempotency_key, "k-1");
    assert.deepEqual(cmd.payload.patch, { title: "Lisboa", show_in_discovery: true, status: "upcoming" });
    assert.match(cmd.payload.updated_at, ISO);
    assert.equal(srv.state.tables.trip_events.at(-1)!.type, "trip.updated");
    const bob = await call(srv.port, "PATCH", `/api/trips/${TRIP}/settings`, "bob-tok", { title: "x" });
    assert.equal(bob.status, 403, "route authorization first; no command for a non-owner");
    assert.equal(kernelCalls(srv.state).length, 1);
    await srv.close();
  });

  it("cancel / complete / archive -> CANCEL_TRIP / COMPLETE_TRIP / ARCHIVE_TRIP; the route's idempotent and terminal answers come BEFORE any command; If-Match conflicts are 409", async () => {
    const srv = await startServer(baseState(true));
    const { port, state } = srv;
    const stale = await call(port, "POST", `/api/trips/${TRIP}/complete`, "alice-tok", undefined, { "if-match": '"7"' });
    assert.equal(stale.status, 409); assert.equal(stale.body.reason, "TRIP_VERSION_CONFLICT");
    assert.equal(state.tables.trips[0].status, "upcoming");

    const done = await call(port, "POST", `/api/trips/${TRIP}/complete`, "alice-tok", undefined, { "if-match": "0" });
    assert.deepEqual(done.body, { status: "completed", tripId: TRIP }); assert.equal(done.version, "1");
    assert.equal(state.tables.trip_events.at(-1)!.type, "trip.trip_completed");

    const again = await call(port, "POST", `/api/trips/${TRIP}/complete`, "alice-tok");
    assert.deepEqual(again.body, { status: "completed", idempotent: true }); assert.equal(again.version, null, "idempotent answer is the route's, no command");

    const cancel = await call(port, "POST", `/api/trips/${TRIP}/cancel`, "alice-tok");
    assert.equal(cancel.version, "2"); assert.equal(state.tables.trips[0].status, "cancelled");
    const completeCancelled = await call(port, "POST", `/api/trips/${TRIP}/complete`, "alice-tok");
    assert.equal(completeCancelled.status, 409, "route refuses completing a cancelled trip (invalid_state_transition) before any command");

    const archive = await call(port, "POST", `/api/trips/${TRIP}/archive`, "alice-tok");
    assert.equal(archive.version, "3"); assert.equal(state.tables.trip_events.at(-1)!.type, "trip.trip_archived");
    const cancelArchived = await call(port, "POST", `/api/trips/${TRIP}/cancel`, "alice-tok");
    assert.equal(cancelArchived.status, 409, "invalid_state_transition, from the route");
    assert.deepEqual(canonicalWrites(state), []);
    assert.equal(kernelCalls(state).length, 4, "stale + complete + cancel + archive");
    await srv.close();
  });

  it("DELETE -> ARCHIVE_TRIP; an already-archived trip is 204 with NO command and NO write (legacy would re-write it)", async () => {
    const srv = await startServer(baseState(true));
    const { port, state } = srv;
    const d = await call(port, "DELETE", `/api/trips/${TRIP}`, "alice-tok");
    assert.equal(d.status, 204); assert.equal(d.version, "1");
    assert.equal(kernelCalls(state)[0].args.p_command.type, "ARCHIVE_TRIP");
    assert.equal(kernelCalls(state)[0].args.p_command.payload.soft_delete, true);
    const d2 = await call(port, "DELETE", `/api/trips/${TRIP}`, "alice-tok");
    assert.equal(d2.status, 204); assert.equal(d2.version, null);
    assert.equal(kernelCalls(state).length, 1, "no second command for archived -> archived");
    assert.deepEqual(canonicalWrites(state), []);
    await srv.close();
  });

  it("join-request approve reads the row first: no row -> ADD_PARTICIPANT (member/accepted/joined_at); an 'invited' row -> SET_PARTICIPANT_ROLE; the owner's row is refused where the upsert would have downgraded it", async () => {
    const srv = await startServer(baseState(true));
    const { port, state } = srv;
    const add = await call(port, "POST", `/api/trips/${TRIP}/join-requests/${REQ}/approve`, "alice-tok");
    assert.equal(add.status, 200, JSON.stringify(add.body)); assert.equal(add.version, "1");
    const c1 = kernelCalls(state)[0].args.p_command;
    assert.equal(c1.type, "ADD_PARTICIPANT"); assert.equal(c1.actor_user_id, ALICE);
    assert.equal(c1.payload.user_id, CAROL); assert.equal(c1.payload.role, "member"); assert.equal(c1.payload.status, "accepted"); assert.match(c1.payload.joined_at, ISO);
    assert.equal(state.tables.trip_members.find((m) => m.user_id === CAROL)!.role, "member");
    assert.equal(state.tables.trip_join_requests[0].status, "approved");

    state.tables.trip_join_requests.push({ id: REQ.replace("1", "2"), trip_id: TRIP, user_id: DAVE, status: "pending" });
    const role = await call(port, "POST", `/api/trips/${TRIP}/join-requests/${REQ.replace("1", "2")}/approve`, "alice-tok");
    assert.equal(role.status, 200); assert.equal(role.version, "2");
    assert.equal(kernelCalls(state)[1].args.p_command.type, "SET_PARTICIPANT_ROLE");
    assert.deepEqual(kernelCalls(state)[1].args.p_command.payload, { user_id: DAVE, role: "member" });
    assert.equal(state.tables.trip_members.find((m) => m.user_id === DAVE)!.role, "member");

    state.tables.trip_join_requests.push({ id: REQ.replace("1", "3"), trip_id: TRIP, user_id: ALICE, status: "pending" });
    const owner = await call(port, "POST", `/api/trips/${TRIP}/join-requests/${REQ.replace("1", "3")}/approve`, "alice-tok");
    assert.equal(owner.status, 400); assert.equal(owner.body.reason, "TRIP_PARTICIPANT_IS_OWNER");
    assert.equal(state.tables.trip_members.find((m) => m.user_id === ALICE)!.role, "owner", "the owner's row is untouched");
    assert.equal(state.tables.trip_join_requests.at(-1)!.status, "pending", "a refused command approves nothing");
    assert.deepEqual(canonicalWrites(state), []);
    await srv.close();
  });

  it("a co-host approver is admitted by the `host` capability (2500) and refused TRIP_AUTH_NOT_OWNER by a 2450-only database — the reported gap", async () => {
    const srv = await startServer(baseState(true));
    const ok = await call(srv.port, "POST", `/api/trips/${TRIP}/join-requests/${REQ}/approve`, "erin-tok");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(kernelCalls(srv.state)[0].args.p_command.actor_user_id, ERIN);
    await srv.close();

    const old = await startServer(baseState(true));
    old.state.kernel = "v2450";
    const refused = await call(old.port, "POST", `/api/trips/${TRIP}/join-requests/${REQ}/approve`, "erin-tok");
    assert.equal(refused.status, 403); assert.equal(refused.body.reason, "TRIP_AUTH_NOT_OWNER");
    assert.equal(old.state.tables.trip_members.some((m) => m.user_id === CAROL), false);
    await old.close();
  });

  it("invite-link join -> JOIN_VIA_LINK: the JOINER is the actor, the claimed slot is the capability, the attempt row is cleared, 201 joined", async () => {
    _resetTripCommandRejectedTotal();
    const srv = await startServer(baseState(true));
    const { port, state } = srv;
    const r = await call(port, "POST", `/api/trips/invite-link/${TOKEN}/accept`, "carol-tok", undefined, { "idempotency-key": "join-1" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body, { status: "joined", tripId: TRIP, role: "member" });
    assert.equal(r.version, "1");
    const names = state.rpcCalls.map((c) => c.name);
    assert.deepEqual(names, ["claim_invite_link_slot_for_user", "trip_kernel_execute"], "claim first, then the command");
    const cmd = kernelCalls(state)[0].args.p_command;
    assert.equal(cmd.type, "JOIN_VIA_LINK"); assert.equal(cmd.actor_user_id, CAROL); assert.equal(cmd.idempotency_key, "join-1");
    assert.equal(cmd.payload.invite_link_id, LINK); assert.match(cmd.payload.joined_at, ISO);
    const row = state.tables.trip_members.find((m) => m.user_id === CAROL)!;
    assert.deepEqual({ role: row.role, status: row.status, link: row.invite_link_id }, { role: "member", status: "accepted", link: LINK });
    assert.equal(state.tables.trip_events.at(-1)!.type, "trip.participant_joined");
    assert.equal(state.tables.trip_invite_link_attempts.length, 0, "attempt row cleared on success");
    assert.deepEqual(canonicalWrites(state), []);
    await srv.close();
  });

  it("invite-link join: ALREADY_EXISTS drives the legacy 23505 branch (already_member, slot released), CAPACITY drives the trip_full branch (410, slot released)", async () => {
    const srv = await startServer(baseState(true));
    const { port, state } = srv;
    // Race model: no membership at the route's check, a row by the time the command runs.
    const origRpc = (state as any)._rpc;
    void origRpc;
    state.tables.trip_members.push({ trip_id: TRIP, user_id: CAROL, role: "member", status: "accepted" });
    // The route's own already-member check would answer first; bypass it by making the row appear only for the kernel.
    const fake = makeFakeClient(state);
    const realFrom = fake.from;
    let hideForRoute = true;
    fake.from = (table: string) => {
      if (table === "trip_members" && hideForRoute) {
        const b = realFrom(table);
        const origMaybe = b.maybeSingle; const origThen = b.then;
        b.maybeSingle = () => origMaybe.call(b).then((x: any) => (x.data?.user_id === CAROL ? { data: null, error: null } : x));
        b.then = (f: any, r: any) => origThen.call(b, (x: any) => f(Array.isArray(x.data) ? { ...x, data: x.data.filter((m: any) => m.user_id !== CAROL) } : x), r);
        return b;
      }
      return realFrom(table);
    };
    _setTestClient(fake, true);
    const dup = await call(port, "POST", `/api/trips/invite-link/${TOKEN}/accept`, "carol-tok");
    assert.deepEqual(dup.body, { status: "already_member", tripId: TRIP, idempotent: true });
    assert.deepEqual(state.rpcCalls.map((c) => c.name), ["claim_invite_link_slot_for_user", "trip_kernel_execute", "release_invite_link_slot"], "freshly claimed slot is released after ALREADY_EXISTS");
    assert.equal(state.tables.trip_invite_link_attempts.length, 0);
    hideForRoute = false;

    state.rpcCalls.length = 0;
    state.tables.trip_members = state.tables.trip_members.filter((m) => m.user_id !== CAROL);
    state.tables.trips[0].max_members = 4; // alice, bob, dave(invited-but-status-accepted), erin => full
    const full = await call(port, "POST", `/api/trips/invite-link/${TOKEN}/accept`, "carol-tok");
    assert.equal(full.status, 410);
    assert.equal(full.body.reason, "trip_full", "the route's pre-flight count answers first — no slot consumed");
    assert.equal(state.rpcCalls.length, 0, "no rpc at all: the route answered before the claim");
    state.tables.trips[0].max_members = null;
    await srv.close();
  });

  it("invite-link join: a malformed If-Match is refused BEFORE a slot is claimed; a 2450 database (UNKNOWN_TYPE) is a 400 with the slot released and the attempt cleared, counted", async () => {
    _resetTripCommandRejectedTotal();
    const srv = await startServer(baseState(true));
    const { port, state } = srv;
    const bad = await call(port, "POST", `/api/trips/invite-link/${TOKEN}/accept`, "carol-tok", undefined, { "if-match": "not-a-version" });
    assert.equal(bad.status, 400);
    assert.equal(state.rpcCalls.length, 0, "no claim, no command");
    assert.equal(state.tables.trip_invite_link_attempts.length, 0);

    state.kernel = "v2450";
    const behind = await call(port, "POST", `/api/trips/invite-link/${TOKEN}/accept`, "carol-tok");
    assert.equal(behind.status, 400); assert.equal(behind.body.reason, "TRIP_COMMAND_UNKNOWN_TYPE");
    assert.deepEqual(state.rpcCalls.map((c) => c.name), ["claim_invite_link_slot_for_user", "trip_kernel_execute", "release_invite_link_slot"]);
    assert.equal(state.tables.trip_invite_link_attempts.length, 0, "attempt cleared so a retry can claim again");
    assert.equal(state.tables.trip_members.some((m) => m.user_id === CAROL), false, "no direct write ran either");
    assert.equal(readTripCommandRejectedTotal().TRIP_COMMAND_UNKNOWN_TYPE, 1);
    assert.deepEqual(canonicalWrites(state), []);
    await srv.close();
  });

  it("requests: accept -> ACCEPT_INVITE (invitee actor), decline -> DECLINE_INVITE, cancel -> REMOVE_PARTICIPANT (owner actor, subject the invitee); no legacy write", async () => {
    const srv = await startServer(baseState(true));
    const { port, state } = srv;
    const acc = await call(port, "POST", `/api/me/requests/trip_invite/${TRIP}/accept`, "dave-tok");
    assert.deepEqual(acc.body, { status: "member", tripId: TRIP }); assert.equal(acc.version, "1");
    assert.equal(kernelCalls(state)[0].args.p_command.type, "ACCEPT_INVITE");
    assert.equal(kernelCalls(state)[0].args.p_command.actor_user_id, DAVE);
    assert.equal(state.tables.trip_members.find((m) => m.user_id === DAVE)!.role, "member");

    state.tables.trip_members.push({ trip_id: TRIP, user_id: CAROL, role: "invited", status: "accepted" });
    const dec = await call(port, "POST", `/api/me/requests/trip_invite/${TRIP}/decline`, "carol-tok");
    assert.deepEqual(dec.body, { status: "declined", tripId: TRIP }); assert.equal(dec.version, "2");
    assert.equal(kernelCalls(state)[1].args.p_command.type, "DECLINE_INVITE");
    assert.equal(state.tables.trip_members.some((m) => m.user_id === CAROL), false);
    assert.ok(state.writes.some((w) => w.table === "user_interaction_cooldowns"), "the anti-retaliation cooldown side-effect still runs");

    state.tables.trip_members.push({ trip_id: TRIP, user_id: CAROL, role: "invited", status: "accepted" });
    const can = await call(port, "POST", `/api/me/requests/trip_invite/${TRIP}/cancel`, "alice-tok", { inviteeId: CAROL });
    assert.deepEqual(can.body, { status: "cancelled", tripId: TRIP, inviteeId: CAROL }); assert.equal(can.version, "3");
    assert.equal(kernelCalls(state)[2].args.p_command.type, "REMOVE_PARTICIPANT");
    assert.deepEqual(kernelCalls(state)[2].args.p_command.payload, { user_id: CAROL });
    assert.equal(kernelCalls(state)[2].args.p_command.actor_user_id, ALICE);
    assert.equal(state.tables.trip_events.at(-1)!.type, "trip.participant_removed");

    const notOwner = await call(port, "POST", `/api/me/requests/trip_invite/${TRIP}/cancel`, "bob-tok", { inviteeId: DAVE });
    assert.equal(notOwner.status, 403, "route authorization first");
    assert.equal(kernelCalls(state).length, 3);
    assert.deepEqual(canonicalWrites(state), []);
    await srv.close();
  });
});
