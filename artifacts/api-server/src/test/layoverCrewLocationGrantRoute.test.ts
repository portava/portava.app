/**
 * census-layover L166 / L203 (B58 lane LAY-C1) — the precise crew sharing
 * control on the wire: POST/DELETE /api/airport/sessions/:id/crew/location-grant
 * (routes/layoverCrewLocation.ts, a separate router) and `yourShare` on the crew
 * payload GET /crew serves (routes/airport.ts `crewPayload`, line-neutral).
 *
 *   L166 "Precise crew sharing: separate explicit control, off by default"
 *   L203 "Crew membership/location rows require membership and explicit permission"
 *
 * The flag `layover_crew_location_sharing_enabled` is seeded FALSE (3787). These
 * cases prove what OFF means (no grant can be created, no share is reported
 * active, the control is not offered) and what ON does, at OQ-1/OQ-2's
 * fail-closed defaults — not an approval of either.
 *
 * Runs the two routers in index.ts's order over `fakeLayoverDb` (no RLS, no
 * FKs; the database half is src/test/db/layoverCrewLocationGrants.db.test.ts).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverCrewLocationGrantRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import layoverCrewLocationRouter from "../routes/layoverCrewLocation.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

let server: http.Server;
let base: string;

const A_TOKEN = "loc-token-a";
const B_TOKEN = "loc-token-b";
const C_TOKEN = "loc-token-c";
const USER_A = "loc-user-a";
const USER_B = "loc-user-b";
const USER_C = "loc-user-c";
const SESSION_A = "loc-session-a";
const SESSION_B = "loc-session-b";
const SESSION_B2 = "loc-session-b2";
const SESSION_C = "loc-session-c";
const CREW_ID = "loc-crew-1";

type Reply = { status: number; body: any };

function call(token: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const crewUrl = (sessionId: string, suffix = "") => `/api/airport/sessions/${sessionId}/crew${suffix}`;
const grantUrl = (sessionId: string) => crewUrl(sessionId, "/location-grant");

interface StageOpts {
  sharing?: boolean;
  persistence?: boolean;
  grants?: Record<string, any>[];
  checkpoints?: Record<string, any>[];
  prefs?: Record<string, any>[];
  failures?: Record<string, { message: string; code?: string }>;
  bInCrew?: boolean;
  bJoinedAt?: string;
  sessionBStatus?: string;
}


/** A (owner) and B (member) in one open crew in Taoyuan; C a traveller in the city outside it. */
function stage(opts: StageOpts = {}) {
  const now = Date.now();
  const joined = new Date(now - 60 * 60_000).toISOString();
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      ...(opts.sharing === undefined ? [] : [{ flag: "layover_crew_location_sharing_enabled", enabled: opts.sharing }]),
      { flag: "layover_decision_persistence_enabled", enabled: opts.persistence ?? true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({ id: SESSION_A, user_id: USER_A, departure_time: new Date(now + 9 * 3_600_000).toISOString() }),
      sessionRow({ id: SESSION_B, user_id: USER_B, departure_time: new Date(now + 8 * 3_600_000).toISOString(), status: opts.sessionBStatus ?? "active" }),
      sessionRow({ id: SESSION_B2, user_id: USER_B, departure_time: new Date(now + 8 * 3_600_000).toISOString() }),
      sessionRow({ id: SESSION_C, user_id: USER_C, departure_time: new Date(now + 8 * 3_600_000).toISOString() }),
    ],
    layover_crews: [{
      id: CREW_ID, city: "taoyuan", airport_ref: "TPE", created_by: USER_A, created_session_id: SESSION_A,
      title: "Ramen", meeting_point_label: null, status: "open", max_members: 6,
      expires_at: new Date(now + 6 * 3_600_000).toISOString(),
      created_at: joined, updated_at: joined,
    }],
    layover_crew_members: [
      { crew_id: CREW_ID, user_id: USER_A, session_id: SESSION_A, role: "owner", joined_at: joined, left_at: null },
      ...(opts.bInCrew === false ? [] : [{ crew_id: CREW_ID, user_id: USER_B, session_id: SESSION_B, role: "member", joined_at: opts.bJoinedAt ?? joined, left_at: null }]),
    ],
    layover_crew_location_grants: opts.grants ?? [],
    layover_checkpoints: (opts.checkpoints ?? []).map((c) => ({ expires_at: new Date(now + 48 * 3_600_000).toISOString(), ...c })),
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
    blocks: [],
    user_follows: [
      { follower_id: USER_A, following_id: USER_B },
      { follower_id: USER_B, following_id: USER_A },
    ],
    profiles: [
      { id: USER_A, handle: "ann", name: "Ann", avatar_url: null },
      { id: USER_B, handle: "bo", name: "Bo", avatar_url: null },
      { id: USER_C, handle: "cy", name: "Cy", avatar_url: null },
    ],
    location_preferences: opts.prefs ?? [
      { user_id: USER_A, location_mode: "city", sharing_paused: false },
      { user_id: USER_B, location_mode: "city", sharing_paused: false },
    ],
    trip_crew_location_preferences: [],
    trips: [],
  };
  _setTestClient(
    makeLayoverDb(tables, {
      users: { [A_TOKEN]: USER_A, [B_TOKEN]: USER_B, [C_TOKEN]: USER_C },
      failures: opts.failures ?? {},
    }),
    true,
  );
  return tables;
}

/**
 * The ceiling the route must derive: min(crew expiry, B's certified hard
 * return). The hard return is read off GET /crew's own certified solution
 * (`requiredReturnBy` is `deadline.hardReturnTime`, LayoverCrewService.ts), so
 * the test does not re-derive feasibility.
 */
async function expectedCeilingMs(tables: Record<string, any[]>): Promise<number> {
  const r = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
  const mine = (r.body.solution.members as any[]).find((m) => m.userId === USER_B);
  assert.ok(mine?.requiredReturnBy, `B must be certified: ${JSON.stringify(r.body.solution)}`);
  return Math.min(Date.parse(tables.layover_crews[0].expires_at), Date.parse(mine.requiredReturnBy));
}

const liveGrant = (over: Record<string, any> = {}) => ({
  id: `g-${Math.random().toString(36).slice(2, 8)}`,
  crew_id: CREW_ID, granted_by_user_id: USER_B, session_id: SESSION_B,
  granted_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  revoked_at: null, created_at: new Date().toISOString(),
  ...over,
});

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  // index.ts's order: airport first, then the separate routers.
  app.use("/api", airportRouter);
  app.use("/api", layoverCrewLocationRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("L166 'off by default' — the flag OFF (its seed) or ABSENT", () => {
  for (const [label, sharing] of [["seeded FALSE", false], ["row absent (3787 unapplied)", undefined]] as const) {
    it(`${label}: GET /crew offers no control and reports nothing active; the grant store is not even read`, async () => {
      // A failing grant read would surface as a degrade if it were made at all.
      stage({ sharing, failures: { "layover_crew_location_grants:select": { message: "must not be read" } }, grants: [liveGrant()] });
      const r = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.yourShare, { available: false, live: false, reason: "feature_off", expiresAt: null });
      assert.equal(r.body.degradedReasons.includes("location_grants_unreadable"), false);
    });

    it(`${label}: POST is refused (404 feature_disabled) and nothing is written`, async () => {
      const tables = stage({ sharing });
      const r = await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body.error, "feature_disabled");
      assert.equal(tables.layover_crew_location_grants.length, 0);
    });
  }

  it("OFF: stopping is still possible — a grant made while it was ON is revoked", async () => {
    const tables = stage({ sharing: false, grants: [liveGrant({ id: "g1" })] });
    const r = await call(B_TOKEN, "DELETE", grantUrl(SESSION_B));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.revoked, 1);
    assert.ok(tables.layover_crew_location_grants[0].revoked_at, "the grant must be revoked");
  });
});

describe("L166 the explicit control, flag ON", () => {
  it("nothing is shared until the traveller taps: a fresh crew member reads not live, never_granted", async () => {
    stage({ sharing: true });
    const r = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.yourShare, { available: true, live: false, reason: "no_live_grant:never_granted", expiresAt: null });
  });

  it("POST grants: ONE row from the crew's session, bounded by min(crew expiry, certified hard return); the reply and a FRESH read say live", async () => {
    const tables = stage({ sharing: true });
    const before = Date.now();
    const r = await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.inCrew, true);
    assert.equal(r.body.alreadyGranted, false);
    assert.equal(tables.layover_crew_location_grants.length, 1);
    const row = tables.layover_crew_location_grants[0];
    assert.deepEqual([row.crew_id, row.granted_by_user_id, row.session_id, row.revoked_at ?? null], [CREW_ID, USER_B, SESSION_B, null]);
    const ceiling = await expectedCeilingMs(tables);
    assert.equal(Date.parse(row.expires_at), ceiling, "the grant's expiry is the derived ceiling, nothing invented");
    assert.ok(Date.parse(row.granted_at) >= before - 1000);
    assert.equal(r.body.yourShare.available, true);
    assert.equal(r.body.yourShare.live, true, JSON.stringify(r.body.yourShare));
    assert.equal(r.body.yourShare.reason, "live_scoped_grant");
    assert.ok(Date.parse(r.body.yourShare.expiresAt) <= ceiling);

    const fresh = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.equal(fresh.body.yourShare.live, true);
  });

  it("a requested earlier end is honoured, a later one is clamped, an unknown field is refused", async () => {
    const tables = stage({ sharing: true });
    const soon = new Date(Date.now() + 15 * 60_000).toISOString();
    const r = await call(B_TOKEN, "POST", grantUrl(SESSION_B), { expiresAt: soon });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Date.parse(tables.layover_crew_location_grants[0].expires_at), Date.parse(soon));

    const t2 = stage({ sharing: true });
    const far = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();
    const r2 = await call(B_TOKEN, "POST", grantUrl(SESSION_B), { expiresAt: far });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const row = t2.layover_crew_location_grants[0];
    assert.equal(Date.parse(row.expires_at), await expectedCeilingMs(t2), "a week is clamped to the derived ceiling");

    const t3 = stage({ sharing: true });
    const bad = await call(B_TOKEN, "POST", grantUrl(SESSION_B), { expiresAt: soon, durationHours: 99 });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(t3.layover_crew_location_grants.length, 0);
  });

  it("a double tap is one grant", async () => {
    const tables = stage({ sharing: true });
    await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
    const again = await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.alreadyGranted, true);
    assert.equal(tables.layover_crew_location_grants.length, 1);
  });

  it("DELETE stops it: the row is revoked (kept, so the reason is user_revoked, not never_granted)", async () => {
    const tables = stage({ sharing: true });
    await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
    const stop = await call(B_TOKEN, "DELETE", grantUrl(SESSION_B));
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.equal(stop.body.revoked, 1);
    assert.equal(tables.layover_crew_location_grants.length, 1);
    assert.ok(tables.layover_crew_location_grants[0].revoked_at);
    assert.equal(stop.body.yourShare.live, false);
    assert.equal(stop.body.yourShare.reason, "no_live_grant:user_revoked");
    assert.equal(stop.body.yourShare.expiresAt, null);
  });

  it("a revocation that could not be written is NOT reported as stopped", async () => {
    stage({ sharing: true, grants: [liveGrant()], failures: { "layover_crew_location_grants:update": { message: "timeout", code: "57014" } } });
    const r = await call(B_TOKEN, "DELETE", grantUrl(SESSION_B));
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(String(r.body.message), /may still be on/i);
  });
});

describe("L203 — membership AND explicit permission, read before any write", () => {
  it("not in a crew: 404, nothing written", async () => {
    const tables = stage({ sharing: true });
    const r = await call(C_TOKEN, "POST", grantUrl(SESSION_C), {});
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(tables.layover_crew_location_grants.length, 0);
  });

  it("from a session other than the one the traveller is in the crew with: 409, nothing written", async () => {
    const tables = stage({ sharing: true });
    const r = await call(B_TOKEN, "POST", grantUrl(SESSION_B2), {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(tables.layover_crew_location_grants.length, 0);
  });

  it("an ended layover: 400, nothing written", async () => {
    const tables = stage({ sharing: true, sessionBStatus: "completed" });
    const r = await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(tables.layover_crew_location_grants.length, 0);
  });

  it("an unreadable membership: 503, nothing written", async () => {
    const tables = stage({ sharing: true, failures: { "layover_crew_members:select": { message: "boom" } } });
    const r = await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(tables.layover_crew_location_grants.length, 0);
  });

  it("sharing paused or off: 403 sharing_disabled; preferences unreadable: 503 — nothing written either way", async () => {
    for (const [prefs, failures, status] of [
      [[{ user_id: USER_B, location_mode: "city", sharing_paused: true }], {}, 403],
      [[{ user_id: USER_B, location_mode: "off", sharing_paused: false }], {}, 403],
      [undefined, { "location_preferences:select": { message: "boom" } }, 503],
    ] as const) {
      const tables = stage({ sharing: true, prefs: prefs as any, failures: failures as any });
      const r = await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.equal(tables.layover_crew_location_grants.length, 0);
    }
  });

  it("airport re-entry unverifiable — 2992's store OFF (409 reentry_unverifiable) or unreadable (503): nothing written", async () => {
    const off = stage({ sharing: true, persistence: false });
    const r = await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.reason, "reentry_unverifiable");
    assert.equal(off.layover_crew_location_grants.length, 0);

    const broken = stage({ sharing: true, failures: { "layover_checkpoints:select": { message: "boom" } } });
    const r2 = await call(B_TOKEN, "POST", grantUrl(SESSION_B), {});
    assert.equal(r2.status, 503, JSON.stringify(r2.body));
    assert.equal(broken.layover_crew_location_grants.length, 0);
  });
});

describe("yourShare on the crew payload — honest, and about the viewer only", () => {
  it("an unreadable grant table is UNKNOWN (null) with location_grants_unreadable; the crew is still served", async () => {
    stage({ sharing: true, failures: { "layover_crew_location_grants:select": { message: "boom" } } });
    const r = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.yourShare, null);
    assert.equal(r.body.degraded, true);
    assert.ok(r.body.degradedReasons.includes("location_grants_unreadable"));
    assert.equal(r.body.crew.memberCount, 2);
  });

  it("an AIRPORT_REENTRY after the grant ends it; persistence OFF makes it not active (reentry_unverifiable)", async () => {
    stage({ sharing: true, grants: [liveGrant()], checkpoints: [{ id: "cp1", session_id: SESSION_B, checkpoint_type: "AIRPORT_REENTRY", observed_at: new Date(Date.now() - 2 * 60_000).toISOString(), source: "TRAVELLER", confidence: "MEDIUM", dedup_key: "k" }] });
    const r = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.equal(r.body.yourShare.live, false);
    assert.equal(r.body.yourShare.reason, "no_live_grant:airport_reentry");

    stage({ sharing: true, persistence: false, grants: [liveGrant()] });
    const r2 = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.deepEqual(r2.body.yourShare, { available: true, live: false, reason: "reentry_unverifiable", expiresAt: null });
  });

  it("a grant made before the CURRENT membership began does not restart (rejoin / restore)", async () => {
    stage({ sharing: true, grants: [liveGrant()], bJoinedAt: new Date(Date.now() - 60_000).toISOString() });
    const r = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.equal(r.body.yourShare.live, false);
    assert.equal(r.body.yourShare.reason, "granted_before_membership");
  });

  it("a crewmate's live grant is not the viewer's share, and NO crewmate rung or id is published", async () => {
    stage({ sharing: true, grants: [liveGrant()] });
    const r = await call(A_TOKEN, "GET", crewUrl(SESSION_A));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.yourShare, { available: true, live: false, reason: "no_live_grant:never_granted", expiresAt: null });
    assert.equal("locationRungs" in r.body, false, "#569's per-member rungs are deliberately not published");
    assert.equal(JSON.stringify(r.body.yourShare).includes(USER_B), false);
  });
});

describe("leave and disband revoke (grants never outlive the membership)", () => {
  it("a member who leaves: their grants in this crew are revoked", async () => {
    const tables = stage({ sharing: true, grants: [liveGrant({ id: "b1" })] });
    const r = await call(B_TOKEN, "POST", crewUrl(SESSION_B, "/leave"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(tables.layover_crew_location_grants.find((g) => g.id === "b1")!.revoked_at);
  });

  it("the owner leaving disbands, and every member's grant in the crew is revoked", async () => {
    const tables = stage({ sharing: true, grants: [liveGrant({ id: "b1" }), liveGrant({ id: "a1", granted_by_user_id: USER_A, session_id: SESSION_A })] });
    const r = await call(A_TOKEN, "POST", crewUrl(SESSION_A, "/leave"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.disbanded, true);
    for (const g of tables.layover_crew_location_grants) assert.ok(g.revoked_at, `${g.id} must be revoked`);
  });

  it("leaving is never blocked by the grant store: absent (3787 unapplied) or failing, the leave succeeds", async () => {
    for (const code of ["42P01", "57014"]) {
      const tables = stage({ sharing: true, failures: { "layover_crew_location_grants:update": { message: "x", code } } });
      const r = await call(B_TOKEN, "POST", crewUrl(SESSION_B, "/leave"));
      assert.equal(r.status, 200, `${code}: ${JSON.stringify(r.body)}`);
      assert.ok(tables.layover_crew_members.find((m) => m.user_id === USER_B)!.left_at, code);
    }
  });
});

