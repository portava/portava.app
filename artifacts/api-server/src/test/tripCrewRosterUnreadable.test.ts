/**
 * Trip Crew Location — DENY IS NOT UNKNOWN.
 *
 * §70.6 of docs/architecture/census-trips.md reported, and deliberately did not
 * fix, a swallowed read in `routes/tripCrewLocation.ts`: `getMemberRole` and
 * `getMemberRoleAny` read `trip_members` as `const { data } = await ...`, and
 * supabase-js RESOLVES on a database error. A failed roster read was therefore
 * byte-identical to "there is no such row", and seven crew-location endpoints
 * turned it into **403 `not_member`** — telling a member of the trip, in the
 * app's own words, that they are not on it. 403 is also not retryable, so a
 * client that honours it stops asking.
 *
 * `getAcceptedMemberIds` was the sharpest form: [] on a failed read made every
 * requested live-share recipient fail the accepted-member test, and the route
 * answered **400 `invalid_payload`** — *"These user IDs are not accepted trip
 * members: …"* — a specific accusation about named people, assembled out of a
 * query that never answered.
 *
 * FAIL-CLOSED IS NOT WHAT CHANGED. An unreadable roster still grants nothing;
 * every test below asserts the request is refused. What changed is WHICH
 * refusal: 503 `degraded_unavailable` (the vocabulary lib/http.ts already
 * carries, retryable) instead of a verdict about the member.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/tripCrewRosterUnreadable.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import tripCrewLocationRouter from "../routes/tripCrewLocation.js";

let server: http.Server;
let base: string;

const TOKEN = "roster-test-token";
const USER_ID = "user-roster-1";
const MEMBER_ID = "user-roster-member";
const TRIP_ID = "trip-roster-uuid";

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
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

interface State {
  flags?: Record<string, boolean>;
  trips?: any[];
  tripMembers?: any[];
  crewSessions?: any[]; /** trust_restrictions rows (census-trust §31's gate cases; kept on this line so cited lines below keep their numbers). */ trustRestrictions?: any[];
  /** Tables whose reads RESOLVE with an error — the real supabase-js shape. §31: `errorFor` overrides the resolved error per table (default: a coded PGRST999); `writes` records every table a write was ISSUED against, in order. */
  errorTables?: string[]; errorFor?: Record<string, { code: string; message: string }>; writes?: string[];
}

function makeClient(state: State = {}) {
  const errorOn = state.errorTables ?? [];

  function rowsFor(table: string): any[] {
    if (table === "feature_flags") {
      return Object.entries(state.flags ?? {}).map(([flag, enabled]) => ({ flag, enabled }));
    }
    if (table === "trips") return state.trips ?? [];
    if (table === "trip_members") return state.tripMembers ?? [];
    if (table === "trip_crew_location_sessions") return state.crewSessions ?? []; if (table === "trust_restrictions") return state.trustRestrictions ?? [];
    return [];
  }

  function builder(table: string) {
    const failing = errorOn.includes(table);
    const err = state.errorFor?.[table] ?? { message: `relation "${table}" is unavailable`, code: "PGRST999" };
    const filters: Array<(r: any) => boolean> = [];
    let _maybe = false;
    let pendingWrite = false;

    const b: any = {
      select() { return b; },
      insert() { pendingWrite = true; state.writes?.push(table); return b; },
      update() { pendingWrite = true; return b; },
      upsert() { pendingWrite = true; return b; },
      delete() { pendingWrite = true; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is() { return b; },
      lt() { return b; },
      gt() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { _maybe = true; return resolveOne(); },
      single() { return resolveOne(); },
      then(onF: any, onR: any) { return resolveMany().then(onF, onR); },
    };

    async function resolveOne() {
      if (failing) return { data: null, error: err };
      if (pendingWrite) return { data: { id: "generated" }, error: null };
      const m = rowsFor(table).filter((r) => filters.every((f) => f(r)));
      return { data: (_maybe ? m[0] : m[0]) ?? null, error: null };
    }
    async function resolveMany() {
      if (failing) return { data: null, error: err };
      if (pendingWrite) return { data: [{ id: "generated" }], error: null };
      return { data: rowsFor(table).filter((r) => filters.every((f) => f(r))), error: null };
    }
    return b;
  }

  return {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  } as any;
}

const FLAGS = {
  trip_crew_map_enabled: true,
  trip_crew_live_share_enabled: true,
  trip_crew_ghost_mode_enabled: true,
};
/** USER_ID is a MEMBER, not the owner — so the gate must consult trip_members. */
const TRIPS = [{ id: TRIP_ID, owner_id: "someone-else" }];
const MEMBERS = [
  { trip_id: TRIP_ID, user_id: USER_ID, role: "member", status: "accepted" },
  { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
];

function set(c: any) { _setTestClient(c, true); _setTestServiceClient(c); }

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", tripCrewLocationRouter);
  // The global handler the real app uses for a thrown refusal that carries its
  // own status/code (CrewMapUnavailableError).
  app.use((e: any, _rq: any, res: any, _n: any) => {
    res.status(e?.status ?? 500).json({ error: e?.code ?? "server_error", message: e?.message });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("crew location — an unreadable roster is not a verdict about the member", () => {

  // CONTROL FIRST. Each unreadable case below is paired against one of these
  // two: a real non-member must still get 403, and a real member must still be
  // served. A test that only asserts 503 would pass on a route that answered
  // 503 to everyone.
  it("C1. CONTROL — a readable roster still refuses a genuine non-member with 403", async () => {
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: [] }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/location-preferences`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });

  it("C2. CONTROL — a readable roster still admits an accepted member", async () => {
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/location-preferences`);
    assert.equal(r.status, 200);
  });

  it("1. GET crew/location-preferences answers 503, not 403, when trip_members cannot be read", async () => {
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, errorTables: ["trip_members"] }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/location-preferences`);
    assert.equal(r.status, 503, "an unread roster is retryable, not a refusal of this person");
    assert.equal(r.body.error, "degraded_unavailable");
    assert.notEqual(r.body.error, "not_member");
    assert.ok(
      !/not a member|Only accepted/i.test(String(r.body.message ?? "")),
      `a member must not be told they are not one: ${r.body.message}`,
    );
  });

  it("2. PUT crew/location-preferences answers 503, not 403 — a WRITE is not attempted on an undecided gate", async () => {
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, errorTables: ["trip_members"] }));
    const r = await req("PUT", `/api/trips/${TRIP_ID}/crew/location-preferences`, { ghostModeEnabled: true });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("3. ghost-mode enable and disable both answer 503 — including the one a scared member needs", async () => {
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, errorTables: ["trip_members"] }));
    const on = await req("POST", `/api/trips/${TRIP_ID}/crew/ghost-mode/enable`);
    assert.equal(on.status, 503);
    assert.equal(on.body.error, "degraded_unavailable");
    const off = await req("POST", `/api/trips/${TRIP_ID}/crew/ghost-mode/disable`);
    assert.equal(off.status, 503);
    assert.equal(off.body.error, "degraded_unavailable");
  });

  it("4. crew/map (the widest gate, which admits pending invitees) answers 503, not 403", async () => {
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, errorTables: ["trip_members"] }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/map`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("5. an unreadable TRIPS row is also 503 — the owner test is half the gate", async () => {
    // A member whose owner check could not run is in the same position: the
    // second read may legitimately find nothing, and "not a member" would then
    // be asserted on the strength of an owner lookup that never answered.
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, errorTables: ["trips"] }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/location-preferences`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("6. live-share start does not accuse named recipients when the roster cannot be read", async () => {
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, errorTables: ["trip_members"] }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "1h",
      visibilityLevel: "nearby",
      allowedMemberIds: [MEMBER_ID],
    });
    assert.notEqual(r.status, 400, "a read failure is not a bad request");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.ok(
      !String(r.body.message ?? "").includes(MEMBER_ID),
      `a real crew member must not be named as not-a-member: ${r.body.message}`,
    );
  });

  it("6a. the recipient check itself is guarded — the OWNER passes the gate without reading trip_members", async () => {
    // WHY THIS CASE EXISTS, STATED RATHER THAN IMPLIED. Mutation N4 (delete the
    // error check inside getAcceptedMemberIds) SURVIVED test 6: the owner/member
    // gate reads `trip_members` too, so it refused first and the recipient scan
    // was never reached. An OWNER is resolved from `trips.owner_id` alone, so
    // this is the only shape in which the second read's guard is the one under
    // test. Without it the answer is 400 "these user IDs are not accepted trip
    // members" naming a real member.
    set(makeClient({
      flags: FLAGS,
      trips: [{ id: TRIP_ID, owner_id: USER_ID }],
      tripMembers: MEMBERS,
      errorTables: ["trip_members"],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "1h",
      visibilityLevel: "nearby",
      allowedMemberIds: [MEMBER_ID],
    });
    assert.notEqual(r.status, 400, "a read failure is not a bad request");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.ok(
      !String(r.body.message ?? "").includes(MEMBER_ID),
      `a real crew member must not be named as not-a-member: ${r.body.message}`,
    );
  });

  it("6b. CONTROL — a readable roster still rejects a genuine stranger as a recipient (400)", async () => {
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, {
      duration: "1h",
      visibilityLevel: "nearby",
      allowedMemberIds: ["a-total-stranger"],
    });
    assert.equal(r.status, 400, "the accusation is correct when the roster WAS read");
    assert.equal(r.body.error, "invalid_payload");
    assert.ok(String(r.body.message ?? "").includes("a-total-stranger"));
  });

  it("7. GET crew/live-shares says 'could not read' rather than serving an empty list", async () => {
    // The gate passes (roster readable); the SESSIONS table is what fails. The
    // old code returned 200 { liveShares: [] } — "nobody is sharing right now",
    // which is a statement about the crew that a member would act on.
    set(makeClient({
      flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS,
      crewSessions: [], errorTables: ["trip_crew_location_sessions"],
    }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/live-shares`);
    assert.notEqual(r.status, 200, "an unread sessions table must not answer 'nobody is sharing'");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("7b. CONTROL — a readable, genuinely empty sessions table still answers 200 with []", async () => {
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, crewSessions: [] }));
    const r = await req("GET", `/api/trips/${TRIP_ID}/crew/live-shares`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.liveShares, []);
  });
});

// ── census-trust §31 — the live-share gate must not grant on an UNREAD restriction ──
//
// `location_plan_join` ("cannot join location-based plans") gates the START of
// a live LOCATION broadcast to a trip's crew. getRestrictionState used to keep
// this type — and private_plan_access — OPEN on a degraded read ("low-risk
// actions stay open"), so with trust_restrictions unreadable a restricted user
// started broadcasting their position to the group: the exact harm the
// restriction exists to prevent, granted by a read that never answered. The
// gate now refuses with the retryable 503 the hosting gate already uses, and
// never with the restriction message (that would accuse an unrestricted user).
describe("crew live-share start — an unread trust restriction is not 'no restriction' (census-trust §31)", () => {
  const START = { duration: "1h", visibilityLevel: "nearby", allowedMemberIds: [MEMBER_ID] };

  it("T1. CONTROL — a readable, empty trust_restrictions lets an accepted member start sharing", async () => {
    const writes: string[] = [];
    set(makeClient({ flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, trustRestrictions: [], writes }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, START);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(writes.includes("trip_crew_location_sessions"), "the share was written");
  });

  it("T2. CONTROL — an ACTIVE location_plan_join restriction refuses with 403 trust_restriction", async () => {
    const writes: string[] = [];
    set(makeClient({
      flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, writes,
      trustRestrictions: [{ user_id: USER_ID, restriction_type: "location_plan_join" }],
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, START);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "trust_restriction");
    assert.ok(!writes.includes("trip_crew_location_sessions"), "a restricted user's share is not written");
  });

  it("T3. an UNREADABLE trust_restrictions answers 503 — no share is started, and nobody is told they are restricted", async () => {
    const writes: string[] = [];
    set(makeClient({
      flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, writes,
      errorTables: ["trust_restrictions"],
      errorFor: { trust_restrictions: { code: "57014", message: "canceling statement due to statement timeout" } },
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, START);
    assert.notEqual(r.status, 201, "an unread restriction state must not start a location broadcast");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.notEqual(r.body.error, "trust_restriction", "an outage is not a restriction on this person");
    assert.ok(!writes.includes("trip_crew_location_sessions"), "no session row may be written on an undecided gate");
  });

  it("T4. a COLUMN-drift error (42703 '… does not exist') is an unread state too — 503, not a started share", async () => {
    const writes: string[] = [];
    set(makeClient({
      flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, writes,
      errorTables: ["trust_restrictions"],
      errorFor: { trust_restrictions: { code: "42703", message: "column trust_restrictions.lifted_at does not exist" } },
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, START);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.ok(!writes.includes("trip_crew_location_sessions"));
  });

  it("T5. CONTROL — a genuinely ABSENT table (42P01, never migrated) still means 'no restriction exists': the share starts", async () => {
    const writes: string[] = [];
    set(makeClient({
      flags: FLAGS, trips: TRIPS, tripMembers: MEMBERS, writes,
      errorTables: ["trust_restrictions"],
      errorFor: { trust_restrictions: { code: "42P01", message: 'relation "public.trust_restrictions" does not exist' } },
    }));
    const r = await req("POST", `/api/trips/${TRIP_ID}/crew/live-share/start`, START);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
});
