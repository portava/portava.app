/**
 * Trip Crew — membership STATUS gate and crew-map privacy fail-open
 *
 * Five defects, each measured here before it was fixed:
 *
 *   1. routes/tripCrewLocation.ts `getMemberRoleAny` filtered trip_members by
 *      ROLE ONLY. trip_members.status is `text NOT NULL DEFAULT 'accepted'
 *      CHECK (status IN ('invited','accepted','declined','removed','left'))`
 *      (migration 0078), so a row {role:'member', status:'removed'} passed the
 *      gate and GET /trips/:id/crew/map served the crew's area labels to a
 *      person REMOVED from the trip. The file's own header says removed members
 *      get 403.
 *
 *   2. routes/tripCrewLocation.ts `getAcceptedMemberIds` had the same hole, and
 *      it is the allow-list for live-share recipients. POST live-share/start
 *      accepted a removed member as a recipient while answering with the words
 *      "not accepted trip members" for anyone it did reject — and a live-share
 *      recipient is who getCrewMap hands EXACT COORDINATES to.
 *
 *   3. services/tripCrew/TripCrewLocationService.getCrewMap dropped the
 *      `.error` of the `location_preferences` read. supabase-js RESOLVES on a
 *      DB error, so an unreadable table is indistinguishable from an empty one:
 *      hotel_blur_enabled read as FALSE for everyone and exact coordinates were
 *      published for a member whose setting says never publish them.
 *
 *   4. Same function, `trip_crew_location_preferences`: an unreadable prefs
 *      table read as "no prefs row", which buildCrewCard treats as ghostMode
 *      false. A member with ghost mode ON and an active live share was drawn on
 *      the map with an area label.
 *
 *   5. services/tripCrew/TripCrewLiveShareService.startLiveShare stopped the
 *      caller's existing session with an UPDATE whose `.error` was never bound.
 *      A failed stop was followed by an unconditional INSERT, so the trip held
 *      TWO active sessions — the older one still naming the older, wider
 *      allowed_member_ids — and the route answered 201.
 *
 *   6. lib/tripMembership.ts applied the same role-only rule to the intel crew
 *      token: a removed member still counted as accepted crew.
 *
 * FAKE-CLIENT NOTE (false-green guard): the failure injector keys on the exact
 * PROJECTED COLUMNS, not on the table name. `getMemberRoleAny` and `getCrewMap`
 * both read trip_members; failing "trip_members" wholesale would fail both and
 * a 403 from the gate would masquerade as the privacy refusal under test.
 *
 * Run: node --import tsx/esm --test src/test/tripCrewStatusAndPrivacy.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripCrewLocationRouter from "../routes/tripCrewLocation.js";
import {
  isAcceptedTripMember,
  acceptedCrewSize,
  isSharedCrewMember,
} from "../lib/tripMembership.js";

// ── Identities ────────────────────────────────────────────────────────────────

const OWNER_TOKEN    = "tcsp-owner";
const ACCEPTED_TOKEN = "tcsp-accepted";
const REMOVED_TOKEN  = "tcsp-removed";
const INVITED_TOKEN  = "tcsp-invited";
const PENDING_TOKEN  = "tcsp-pending-status";
const STRANGER_TOKEN = "tcsp-stranger";

const OWNER_ID    = "00000000-0000-0000-0000-0000000000a1";
const ACCEPTED_ID = "00000000-0000-0000-0000-0000000000a2";
const REMOVED_ID  = "00000000-0000-0000-0000-0000000000a3";
const INVITED_ID  = "00000000-0000-0000-0000-0000000000a4";
const PENDING_ID  = "00000000-0000-0000-0000-0000000000a5";
const STRANGER_ID = "00000000-0000-0000-0000-0000000000a9";
const TRIP_ID     = "00000000-0000-0000-0000-0000000000b1";

const TOKENS: Record<string, string> = {
  [OWNER_TOKEN]: OWNER_ID,
  [ACCEPTED_TOKEN]: ACCEPTED_ID,
  [REMOVED_TOKEN]: REMOVED_ID,
  [INVITED_TOKEN]: INVITED_ID,
  [PENDING_TOKEN]: PENDING_ID,
  [STRANGER_TOKEN]: STRANGER_ID,
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = OWNER_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
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

// ── Fake supabase client ──────────────────────────────────────────────────────

interface FakeState {
  featureFlags?: Record<string, boolean>;
  trips?: any[];
  tripMembers?: any[];
  profiles?: any[];
  crewPrefs?: any[];
  locationState?: any[];
  locationPreferences?: any[];
  planCheckins?: any[];
  safeReturnSessions?: any[];
  crewSessions?: any[];
  blocks?: any[];
  /**
   * Fail a read/write by (table, projected-columns-or-op). Keyed on the exact
   * projection so a sibling branch reading the same table is untouched.
   */
  failOn?: (q: { table: string; columns: string | null; op: string }) => boolean;
}

interface Recorder {
  inserts: Array<{ table: string; rows: any }>;
  updates: Array<{ table: string; patch: any }>;
}

function makeFakeClient(state: FakeState, rec: Recorder) {
  function getRows(table: string): any[] {
    switch (table) {
      case "feature_flags":
        return Object.entries(state.featureFlags ?? {}).map(([key, enabled]) => ({ flag: key, key, enabled }));
      case "trips":                          return state.trips ?? [];
      case "trip_members":                   return state.tripMembers ?? [];
      case "profiles":                       return state.profiles ?? [];
      case "trip_crew_location_preferences": return state.crewPrefs ?? [];
      case "user_location_state":            return state.locationState ?? [];
      case "location_preferences":           return state.locationPreferences ?? [];
      case "plan_checkins":                  return state.planCheckins ?? [];
      case "safe_return_sessions":           return state.safeReturnSessions ?? [];
      case "trip_crew_location_sessions":    return state.crewSessions ?? [];
      case "blocks":                         return state.blocks ?? [];
      default:                               return [];
    }
  }

  function builder(table: string) {
    const rows = getRows(table);
    const filters: Array<(r: any) => boolean> = [];
    let columns: string | null = null;
    let op = "select";

    const dbError = (why: string) => ({
      data: null,
      error: { message: `injected failure: ${why}`, code: "57014", details: null, hint: null },
      status: 500,
      count: null,
    });

    function fails(): boolean {
      return Boolean(state.failOn?.({ table, columns, op }));
    }

    const b: any = {
      select(cols?: string) { if (op === "select") columns = cols ?? null; return b; },
      insert(rowsIn: any)   { op = "insert"; rec.inserts.push({ table, rows: rowsIn }); return b; },
      update(patch: any)    { op = "update"; rec.updates.push({ table, patch }); return b; },
      upsert(rowsIn: any)   { op = "upsert"; rec.inserts.push({ table, rows: rowsIn }); return b; },
      delete()              { op = "delete"; return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)    { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      lt(col: string, val: any)    { filters.push((r) => r[col] < val); return b; },
      gt(col: string, val: any)    { filters.push((r) => r[col] > val); return b; },
      or(expr: string) {
        const parts = expr.split(",").map((p) => {
          const m = p.trim().match(/^(\w+)\.(\w+)\.(.*)$/);
          return m ? { col: m[1], val: m[3] } : null;
        }).filter(Boolean) as { col: string; val: string }[];
        filters.push((r) => parts.some(({ col, val }) => String(r[col]) === val));
        return b;
      },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return fails() ? Promise.resolve(dbError(`${table}.maybeSingle`)) : Promise.resolve(one()); },
      single()      { return fails() ? Promise.resolve(dbError(`${table}.single`))      : Promise.resolve(one()); },
      then(onF: any, onR: any) {
        return (fails() ? Promise.resolve(dbError(`${table}.${op}`)) : Promise.resolve(list())).then(onF, onR);
      },
    };

    function matched() { return rows.filter((r) => filters.every((f) => f(r))); }
    function one() {
      if (op === "insert" || op === "upsert") return { data: { id: "new-session-id" }, error: null };
      return { data: matched()[0] ?? null, error: null };
    }
    function list() {
      if (op === "insert" || op === "upsert") return { data: [{ id: "new-session-id" }], error: null };
      if (op === "update" || op === "delete") return { data: matched(), error: null };
      return { data: matched(), error: null };
    }

    return b;
  }

  return {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (token: string) => {
        const id = TOKENS[token];
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  } as any;
}

function setClients(state: FakeState): Recorder {
  const rec: Recorder = { inserts: [], updates: [] };
  const c = makeFakeClient(state, rec);
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return rec;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FLAGS_ON = {
  trip_crew_map_enabled: true,
  trip_crew_live_share_enabled: true,
  trip_crew_ghost_mode_enabled: true,
};

const TRIPS = [{ id: TRIP_ID, owner_id: OWNER_ID }];

const M_OWNER    = { trip_id: TRIP_ID, user_id: OWNER_ID,    role: "owner",   status: "accepted" };
const M_ACCEPTED = { trip_id: TRIP_ID, user_id: ACCEPTED_ID, role: "member",  status: "accepted" };
/** The defect's subject: role still says 'member', status says they are gone. */
const M_REMOVED  = { trip_id: TRIP_ID, user_id: REMOVED_ID,  role: "member",  status: "removed" };
/** Legacy pending encoding. */
const M_INVITED  = { trip_id: TRIP_ID, user_id: INVITED_ID,  role: "invited", status: "invited" };
/** Newer pending encoding — production holds one of these. */
const M_PENDING  = { trip_id: TRIP_ID, user_id: PENDING_ID,  role: "member",  status: "invited" };

const ALL_MEMBERS = [M_OWNER, M_ACCEPTED, M_REMOVED, M_INVITED, M_PENDING];

const PROFILES = [OWNER_ID, ACCEPTED_ID, REMOVED_ID, INVITED_ID, PENDING_ID].map((id) => ({
  id, username: `u_${id.slice(-2)}`, full_name: `User ${id.slice(-2)}`, avatar_url: null,
}));

const FRESH = new Date(Date.now() - 60_000).toISOString();

function baseState(over: Partial<FakeState> = {}): FakeState {
  return {
    featureFlags: FLAGS_ON,
    trips: TRIPS,
    tripMembers: ALL_MEMBERS,
    profiles: PROFILES,
    crewPrefs: [],
    locationState: [],
    locationPreferences: [],
    planCheckins: [],
    safeReturnSessions: [],
    crewSessions: [],
    blocks: [],
    ...over,
  };
}

// ── Server ────────────────────────────────────────────────────────────────────

before(() => {
  const app = express();
  app.use(express.json());
  // req.log shim: without it a route that reaches req.log.error crashes with a
  // 500 that is easy to mistake for a deliberate refusal.
  app.use((r: any, _res: any, next: any) => {
    r.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", tripCrewLocationRouter);
  // Global handler mirroring lib/errorEnvelope: a thrown guard carries its own
  // status/code so a refusal is not flattened into a crash-500.
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    res.status(status).json({ error: err?.code ?? "server_error", message: String(err?.message ?? err) });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ═══════════════════════════════════════════════════════════════════════════════
// A. getMemberRoleAny — the status gate on GET /crew/map
// ═══════════════════════════════════════════════════════════════════════════════

describe("A. GET /trips/:tripId/crew/map — trip_members.status is part of membership", () => {
  it("A1. a REMOVED member (role=member, status=removed) is refused", async () => {
    setClients(baseState());
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, REMOVED_TOKEN);
    assert.equal(r.status, 403, `removed member got ${r.status} with body ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "not_member");
  });

  it("A2. a member who DECLINED is refused", async () => {
    setClients(baseState({
      tripMembers: [M_OWNER, { ...M_REMOVED, status: "declined" }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, REMOVED_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });

  it("A3. a member who LEFT is refused", async () => {
    setClients(baseState({
      tripMembers: [M_OWNER, { ...M_REMOVED, status: "left" }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, REMOVED_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });

  it("A4. CONTROL — an accepted member is still admitted", async () => {
    setClients(baseState());
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, ACCEPTED_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
  });

  it("A5. CONTROL — a pending invitee (role=invited) is still admitted, by design", async () => {
    setClients(baseState());
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, INVITED_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
  });

  it("A6. CONTROL — a pending invitee under the status encoding is still admitted", async () => {
    setClients(baseState());
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, PENDING_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.featureEnabled, true);
  });

  it("A7b. a REMOVED member is not listed on the crew map served to the crew", async () => {
    setClients(baseState());
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, OWNER_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.members.map((m: any) => m.userId);
    assert.ok(!ids.includes(REMOVED_ID), `removed member on the roster: ${JSON.stringify(ids)}`);
    // Anti-vacuity: the roster is not simply empty — the people who ARE on the
    // trip are all present.
    assert.deepEqual(
      [...ids].sort(),
      [ACCEPTED_ID, INVITED_ID, PENDING_ID].sort(),
    );
  });

  it("A7. CONTROL — a stranger is refused (the gate still gates)", async () => {
    setClients(baseState());
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, STRANGER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. getAcceptedMemberIds — live-share recipients
// ═══════════════════════════════════════════════════════════════════════════════

const liveShareBody = (ids: string[]) => ({ duration: "1h", allowedMemberIds: ids });

describe("B. POST /trips/:tripId/crew/live-share/start — recipient allow-list", () => {
  it("B1. a REMOVED member may not be named as a live-share recipient", async () => {
    const rec = setClients(baseState());
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, liveShareBody([REMOVED_ID]), OWNER_TOKEN);
    assert.equal(r.status, 400, `removed recipient accepted: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "invalid_payload");
    assert.match(String(r.body.message), new RegExp(REMOVED_ID));
    assert.equal(
      rec.inserts.filter((i) => i.table === "trip_crew_location_sessions").length,
      0,
      "no session may be created when a recipient is rejected",
    );
  });

  it("B2. CONTROL — an accepted member IS a valid recipient", async () => {
    const rec = setClients(baseState());
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, liveShareBody([ACCEPTED_ID]), OWNER_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(rec.inserts.filter((i) => i.table === "trip_crew_location_sessions").length, 1);
  });

  it("B3. CONTROL — a pending invitee is still not a valid recipient", async () => {
    setClients(baseState());
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, liveShareBody([INVITED_ID]), OWNER_TOKEN);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("B4. a removed member cannot START a live share either", async () => {
    setClients(baseState());
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, liveShareBody([OWNER_ID]), REMOVED_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. getCrewMap — unreadable privacy inputs must not read as "permissive"
// ═══════════════════════════════════════════════════════════════════════════════

/** ACCEPTED_ID live-shares to OWNER_ID, with fresh exact coordinates on file. */
function liveSharingState(over: Partial<FakeState> = {}): FakeState {
  return baseState({
    tripMembers: [M_OWNER, M_ACCEPTED],
    crewPrefs: [{
      trip_id: TRIP_ID, user_id: ACCEPTED_ID, default_visibility: "neighborhood",
      ghost_mode_enabled: false, share_arrival_status: true, share_safe_return_status: false,
    }],
    locationState: [{
      user_id: ACCEPTED_ID, city: "Cebu City", district: "IT Park", country: "PH",
      updated_at: FRESH, lat: 10.3273, lng: 123.9057,
    }],
    crewSessions: [{
      id: "sess-1", trip_id: TRIP_ID, user_id: ACCEPTED_ID, visibility_level: "nearby",
      status: "active", expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      started_at: FRESH, allowed_member_ids: [OWNER_ID],
    }],
    ...over,
  });
}

describe("C. GET /crew/map — an unreadable privacy table is not a permissive one", () => {
  it("C1. CONTROL — with hotel blur OFF and everything readable, exact coords ARE served", async () => {
    setClients(liveSharingState({
      locationPreferences: [{ user_id: ACCEPTED_ID, hotel_blur_enabled: false }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, OWNER_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const card = r.body.members.find((m: any) => m.userId === ACCEPTED_ID);
    assert.ok(card, "member card missing");
    assert.equal(card.statusLabel, "live_sharing_active");
    assert.deepEqual(card.exactCoords, { lat: 10.3273, lng: 123.9057 });
  });

  it("C2. CONTROL — with hotel blur ON, exact coords are withheld", async () => {
    setClients(liveSharingState({
      locationPreferences: [{ user_id: ACCEPTED_ID, hotel_blur_enabled: true }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, OWNER_TOKEN);
    assert.equal(r.status, 200);
    const card = r.body.members.find((m: any) => m.userId === ACCEPTED_ID);
    assert.equal(card.exactCoords, null);
  });

  it("C3. an UNREADABLE location_preferences must not publish exact coordinates", async () => {
    setClients(liveSharingState({
      locationPreferences: [{ user_id: ACCEPTED_ID, hotel_blur_enabled: true }],
      failOn: ({ table }) => table === "location_preferences",
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, OWNER_TOKEN);
    assert.equal(r.status, 200, `expected the map to still render, got ${r.status} ${JSON.stringify(r.body)}`);
    const card = r.body.members.find((m: any) => m.userId === ACCEPTED_ID);
    assert.ok(card, "member card missing — the map must still render, only the coords are withheld");
    assert.equal(
      card.exactCoords ?? null, null,
      "hotel_blur_enabled could not be read, so exact coordinates must be withheld",
    );
  });

  it("C4. CONTROL — ghost mode ON hides the member", async () => {
    setClients(liveSharingState({
      locationPreferences: [{ user_id: ACCEPTED_ID, hotel_blur_enabled: false }],
      crewPrefs: [{
        trip_id: TRIP_ID, user_id: ACCEPTED_ID, default_visibility: "neighborhood",
        ghost_mode_enabled: true, share_arrival_status: true, share_safe_return_status: false,
      }],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, OWNER_TOKEN);
    assert.equal(r.status, 200);
    const card = r.body.members.find((m: any) => m.userId === ACCEPTED_ID);
    assert.equal(card.ghostMode, true);
    assert.equal(card.statusLabel, "location_hidden");
    assert.equal(card.areaLabel, null);
    assert.equal(card.exactCoords, null);
  });

  it("C5. an UNREADABLE trip_crew_location_preferences refuses, it does not un-ghost", async () => {
    setClients(liveSharingState({
      locationPreferences: [{ user_id: ACCEPTED_ID, hotel_blur_enabled: false }],
      crewPrefs: [{
        trip_id: TRIP_ID, user_id: ACCEPTED_ID, default_visibility: "neighborhood",
        ghost_mode_enabled: true, share_arrival_status: true, share_safe_return_status: false,
      }],
      failOn: ({ table }) => table === "trip_crew_location_preferences",
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, OWNER_TOKEN);
    assert.equal(
      r.status, 503,
      `expected 503 degraded_unavailable, got ${r.status} ${JSON.stringify(r.body)}`,
    );
    assert.equal(r.body.error, "degraded_unavailable");
    // And nothing about the ghosted member leaked in the refusal body.
    assert.ok(!JSON.stringify(r.body).includes("IT Park"));
  });

  it("C6. an UNREADABLE trip_members roster refuses rather than serving a short crew", async () => {
    // Fail ONLY the roster read inside getCrewMap. It projects user_id first;
    // the access gate projects "role, status". Failing the table wholesale
    // would knock out the gate too and the resulting 403 would masquerade as
    // the refusal under test. `fired` proves the injector actually matched —
    // a rename of the projection must break this test loudly, not silently
    // turn it into an assertion about an un-failed read.
    let fired = 0;
    setClients(liveSharingState({
      locationPreferences: [{ user_id: ACCEPTED_ID, hotel_blur_enabled: false }],
      failOn: ({ table, columns }) => {
        const hit = table === "trip_members" && Boolean(columns?.startsWith("user_id"));
        if (hit) fired++;
        return hit;
      },
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`, undefined, OWNER_TOKEN);
    assert.equal(fired, 1, "the roster read was never failed — the injector missed it");
    assert.equal(
      r.status, 503,
      `expected 503, got ${r.status} ${JSON.stringify(r.body)} — an unreadable roster must not render as a small crew`,
    );
    assert.equal(r.body.error, "degraded_unavailable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. startLiveShare — the stop-then-insert ordering
// ═══════════════════════════════════════════════════════════════════════════════

describe("D. POST /crew/live-share/start — a failed stop must not be followed by an insert", () => {
  it("D1. CONTROL — a healthy start stops the old session and inserts the new one", async () => {
    const rec = setClients(baseState({
      crewSessions: [{
        id: "old", trip_id: TRIP_ID, user_id: OWNER_ID, status: "active",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        allowed_member_ids: [ACCEPTED_ID, REMOVED_ID],
      }],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, liveShareBody([ACCEPTED_ID]), OWNER_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(rec.updates.filter((u) => u.table === "trip_crew_location_sessions").length, 1);
    assert.equal(rec.inserts.filter((i) => i.table === "trip_crew_location_sessions").length, 1);
  });

  it("D2. when the stop UPDATE fails, no second active session is inserted and the route refuses", async () => {
    const rec = setClients(baseState({
      crewSessions: [{
        id: "old", trip_id: TRIP_ID, user_id: OWNER_ID, status: "active",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        allowed_member_ids: [ACCEPTED_ID, REMOVED_ID],
      }],
      failOn: ({ table, op }) => table === "trip_crew_location_sessions" && op === "update",
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, liveShareBody([ACCEPTED_ID]), OWNER_TOKEN);

    assert.equal(
      rec.inserts.filter((i) => i.table === "trip_crew_location_sessions").length,
      0,
      "the previous session was NOT stopped, so a second active session must not be created",
    );
    assert.notEqual(r.status, 201);
    assert.equal(r.status, 500, `expected db_error 500, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "db_error");
    assert.equal(r.body.ok, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. lib/tripMembership — the crew token's own status gate
// ═══════════════════════════════════════════════════════════════════════════════

function membershipClient(members: any[], trips: any[] = TRIPS) {
  const rec: Recorder = { inserts: [], updates: [] };
  return makeFakeClient(baseState({ tripMembers: members, trips }), rec);
}

describe("E. lib/tripMembership — a removed member is not accepted crew", () => {
  it("E1. isAcceptedTripMember is false for {role:member, status:removed}", async () => {
    const sc = membershipClient([M_OWNER, M_REMOVED]);
    assert.equal(await isAcceptedTripMember(sc, TRIP_ID, REMOVED_ID), false);
  });

  it("E2. CONTROL — isAcceptedTripMember is true for an accepted member", async () => {
    const sc = membershipClient([M_OWNER, M_ACCEPTED]);
    assert.equal(await isAcceptedTripMember(sc, TRIP_ID, ACCEPTED_ID), true);
  });

  it("E3. CONTROL — the trip owner is accepted crew without a trip_members row", async () => {
    const sc = membershipClient([]);
    assert.equal(await isAcceptedTripMember(sc, TRIP_ID, OWNER_ID), true);
  });

  it("E4. acceptedCrewSize does not count a removed member", async () => {
    const sc = membershipClient([M_OWNER, M_REMOVED]);
    assert.equal(await acceptedCrewSize(sc, TRIP_ID), 1);
  });

  it("E5. CONTROL — acceptedCrewSize counts owner + accepted member as 2", async () => {
    const sc = membershipClient([M_OWNER, M_ACCEPTED]);
    assert.equal(await acceptedCrewSize(sc, TRIP_ID), 2);
  });

  it("E6. a removed member does not mint a shared-crew token", async () => {
    const sc = membershipClient([M_OWNER, M_ACCEPTED, M_REMOVED]);
    assert.equal(await isSharedCrewMember(sc, TRIP_ID, REMOVED_ID), false);
  });

  it("E7. CONTROL — an accepted member on a 2-person trip does mint one", async () => {
    const sc = membershipClient([M_OWNER, M_ACCEPTED]);
    assert.equal(await isSharedCrewMember(sc, TRIP_ID, ACCEPTED_ID), true);
  });

  it("E8. a trip whose only other member was removed is not a shared crew", async () => {
    const sc = membershipClient([M_OWNER, M_REMOVED]);
    assert.equal(await isSharedCrewMember(sc, TRIP_ID, OWNER_ID), false);
  });
});
