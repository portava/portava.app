/**
 * census-layover L154 — "**Crew** — cache meeting point" — the SERVER half.
 *
 * ── THE DEFECT, STATED BEFORE IT IS FIXED ────────────────────────────────────
 * `buildOfflineBundle` returned `crewMeetingPoint: unavailable("no_crew_storage")`
 * for every session, typed `OfflineCapability<never>`, so it could not have said
 * anything else. The client half has been ready since §28.3
 * (`describeCrewMeetingPoint` renders "Meet your crew at …" from a label), and
 * the crew card shows the meeting point ONLINE. So the one fact about a crew
 * worth surviving the network dying — where to meet them — was never cached,
 * and the reason the device was given ("no crew storage") had been false since
 * 2984 created `layover_crews`.
 *
 * ── WHAT IT NOW SAYS, AND THE FOUR WAYS IT CAN SAY "NO" ──────────────────────
 *   in a crew with a meeting point   available, the crew's own label verbatim
 *   in no crew                       `not_in_crew` — measured, not assumed
 *   in a crew with no meeting point  `no_meeting_point_set`
 *   the crew read failed             `crew_unreadable` — NOT "not in a crew":
 *                                    a traveller told that offline walks away
 *                                    from people who are waiting for them
 *   the caller did not read it       `crew_not_read` (pinned in
 *                                    src/test/layoverDegradedOffline.test.ts)
 * Only the traveller's OWN crew's point is ever cached: another crew meeting in
 * the same city is somebody else's arrangement, and is not.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/airport/__tests__/layoverOfflineCrewMeetingPoint.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";

let server: http.Server;
let base: string;
const TOKEN = "ocm-token-b";
const USER_A = "ocm-user-a";
const USER_B = "ocm-user-b";
const SESSION_A = "ocm-session-a";
const SESSION_B = "ocm-session-b";
const HOUR = 3_600_000;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

/**
 * A's crew "Ramen" meets at the Terminal 2 food court. `bInCrew` puts B in it;
 * otherwise B is in no crew while A's crew meets in the same city.
 */
function stage(opts: {
  bInCrew?: boolean;
  meetingPoint?: string | null;
  failures?: Record<string, { message: string }>;
} = {}) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const member = (userId: string, sessionId: string, role: "owner" | "member") => ({
    crew_id: "crew-ramen", user_id: userId, session_id: sessionId, role, joined_at: iso(now - 60_000), left_at: null,
  });
  _setTestClient(
    makeLayoverDb(
      {
        feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
        airport_profiles: [airportRow()],
        layover_sessions: [
          sessionRow({ id: SESSION_A, user_id: USER_A, departure_time: iso(now + 9 * HOUR) }),
          sessionRow({ id: SESSION_B, user_id: USER_B, departure_time: iso(now + 8 * HOUR) }),
        ],
        layover_crews: [{
          id: "crew-ramen", city: "taoyuan", airport_ref: "TPE", created_by: USER_A, created_session_id: SESSION_A,
          title: "Ramen in the old town",
          meeting_point_label: opts.meetingPoint === undefined ? "Terminal 2 food court" : opts.meetingPoint,
          status: "open", max_members: 6, expires_at: iso(now + 8 * HOUR),
          created_at: iso(now - 60_000), updated_at: iso(now - 60_000),
        }],
        layover_crew_members: [
          member(USER_A, SESSION_A, "owner"),
          ...(opts.bInCrew ? [member(USER_B, SESSION_B, "member")] : []),
        ],
        layover_events: [], layover_plan_stops: [], trip_plan_items: [],
        blocks: [], profiles: [], location_preferences: [], trips: [],
      },
      { users: { [TOKEN]: USER_B }, failures: opts.failures ?? {} },
    ),
    true,
  );
}

async function bundleOnOverview() {
  const r = await get(`/api/airport/sessions/${SESSION_B}/overview`);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  assert.ok(r.body.offlineBundle, `no offlineBundle on the overview: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("L154 — the offline bundle carries the traveller's own crew meeting point", () => {
  it("1. in a crew with a meeting point: it is cached, verbatim", async () => {
    stage({ bInCrew: true });
    const body = await bundleOnOverview();
    assert.deepEqual(body.offlineBundle.crewMeetingPoint,
      { available: true, value: "Terminal 2 food court", reason: null });
  });

  it("2. in no crew: 'not_in_crew' — and ANOTHER crew's point in the same city is not cached", async () => {
    stage({ bInCrew: false });
    const body = await bundleOnOverview();
    assert.deepEqual(body.offlineBundle.crewMeetingPoint,
      { available: false, value: null, reason: "not_in_crew" });
  });

  it("3. in a crew that set no meeting point: says so", async () => {
    stage({ bInCrew: true, meetingPoint: null });
    const body = await bundleOnOverview();
    assert.deepEqual(body.offlineBundle.crewMeetingPoint,
      { available: false, value: null, reason: "no_meeting_point_set" });
  });

  it("4. a blank meeting point is no meeting point, not an answer", async () => {
    stage({ bInCrew: true, meetingPoint: "   " });
    const body = await bundleOnOverview();
    assert.deepEqual(body.offlineBundle.crewMeetingPoint,
      { available: false, value: null, reason: "no_meeting_point_set" });
  });

  it("5. an unreadable crew is 'crew_unreadable', NOT 'not_in_crew' — and the overview still answers", async () => {
    stage({ bInCrew: true, failures: { "layover_crew_members:select": { message: "relation unavailable" } } });
    const body = await bundleOnOverview();
    assert.deepEqual(body.offlineBundle.crewMeetingPoint,
      { available: false, value: null, reason: "crew_unreadable" });
    assert.ok(body.offlineBundle.returnDeadline.hardReturnTime, "the deadline is still cached");
  });

  it("6. an unreadable crew row is 'crew_unreadable' too", async () => {
    stage({ bInCrew: true, failures: { "layover_crews:select": { message: "relation unavailable" } } });
    const body = await bundleOnOverview();
    assert.equal(body.offlineBundle.crewMeetingPoint.reason, "crew_unreadable");
  });

  it("7. no reason anywhere on the bundle is the false 'no_crew_storage'", async () => {
    stage({ bInCrew: false });
    const body = await bundleOnOverview();
    assert.ok(!JSON.stringify(body.offlineBundle).includes("no_crew_storage"));
  });
});
