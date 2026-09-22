/**
 * census-layover L185 / L186 / L188 — the crew JOIN is not scoped to the city
 * the crew discovery list is scoped to.
 *
 * §26.4 hands the next pass exactly this question: "whether L185/L186/L188 and
 * L131 move now that the crew tables are real". They are real — 2984 is applied
 * to production and to CI (§26.1) — so the rows are no longer blocked on
 * storage, and what is left is the ROUTES' behaviour, which §26.2 explicitly
 * declined to measure.
 *
 * ── THE DEFECT, STATED BEFORE IT IS FIXED ────────────────────────────────────
 * A crew is a CITY-level thing, and the route layer says so in three places:
 *
 *   - `openCrewsInCity` filters `.eq("city", canonCity(city))`
 *     (`services/layover/LayoverCrewStore.ts#openCrewsInCity`);
 *   - `POST /crew` refuses to FORM a crew when the city is unknown —
 *     "We do not know which city this layover is in";
 *   - `GET /crew` refuses to LIST crews when the city is unknown, and says so
 *     in a comment: "a crew is a CITY-level thing and we do not know the city".
 *
 * `POST /crew/:crewId/join` checks none of it. It takes a crew id from the URL
 * and joins it, so the DISCOVERY surface is scoped and the ACTION behind it is
 * not — the shape this repository has scored `W` repeatedly: a filtered list in
 * front of an unfiltered write.
 *
 * Two consequences, and neither is cosmetic:
 *
 *  1. CERTIFICATION. `sharedReturnBy` is a MINIMUM over every member's
 *     `required_return_by`, each derived from that member's own airport. A
 *     traveller in Dubai joining a Taoyuan crew drags the shared deadline onto
 *     a clock 4,000 miles away, and `meeting_point_label` ("Terminal 2 food
 *     court") names a place they cannot reach. The crew is certified, and the
 *     certificate is nonsense.
 *  2. WHO MAY SEE A CREWMATE. Membership is the FIRST of the three gates
 *     `crewMemberCards` applies (the route header says so). The other two —
 *     blocks and `publishableUserIds`/`nameVisibilitySet` — still hold, so this
 *     is not a raw leak. It is a WIDENING: those travellers made themselves
 *     visible to a crew in their own city, and an unscoped join lets someone
 *     who is in no position to meet them past the first gate.
 *
 * A traveller whose city is UNKNOWN is the sharper case, because the GET route
 * refuses to serve them a single crew and the POST route lets them into any.
 *
 * WHAT THIS FILE DOES NOT PROVE. It runs against `fakeLayoverDb`, which models
 * no RLS and no foreign keys. 2984 gives the crew tables zero policies and zero
 * `anon`/`authenticated` grants deliberately (§26.1), so the route layer is the
 * ONLY answer to this question — there is no database-level scope that could
 * catch it underneath. That is what makes an unscoped join reachable rather
 * than merely untidy, and it is why the fix belongs here.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/layover/__tests__/layoverCrewCityScope.test.ts
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

const A_TOKEN = "scope-token-a";
const B_TOKEN = "scope-token-b";
const USER_A = "scope-user-a";
const USER_B = "scope-user-b";
const SESSION_A = "scope-session-a";
const SESSION_B = "scope-session-b";
const CREW_ID = "crew-taoyuan-1";

type Reply = { status: number; body: any };

function call(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
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

const TPE = airportRow();

const DUBAI = airportRow({
  id: "airport-dxb", iata_code: "DXB", name: "Dubai International Airport",
  city: "Dubai", country: "United Arab Emirates", country_code: "AE",
  timezone: "Asia/Dubai", lat: 25.2532, lng: 55.3657,
});

/**
 * The city-unknown airport. `crewCityFor` falls back to `session.manualCity`
 * when the profile's city is the literal "Unknown", so the session must carry
 * no manual city either for the city to be genuinely absent.
 */
const NOWHERE = airportRow({
  id: "airport-unk", iata_code: "UNK", name: "Unknown Airport",
  city: "Unknown", country: "Unknown", country_code: null,
});

/**
 * A is on a layover in Taoyuan and owns an open crew there. B's airport is the
 * variable: same city (the control), a different city, or a city we do not
 * know.
 */
function stage(opts: { bAirport: Record<string, any>; bManualCity?: string | null }) {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [TPE, ...(opts.bAirport.id === TPE.id ? [] : [opts.bAirport])],
    layover_sessions: [
      sessionRow({ id: SESSION_A, user_id: USER_A, departure_time: new Date(now + 9 * 3_600_000).toISOString() }),
      sessionRow({
        id: SESSION_B,
        user_id: USER_B,
        airport_id: opts.bAirport.id,
        manual_city: opts.bManualCity ?? null,
        departure_time: new Date(now + 5 * 3_600_000).toISOString(),
      }),
    ],
    layover_crews: [
      {
        id: CREW_ID, city: "taoyuan", airport_ref: "TPE",
        created_by: USER_A, created_session_id: SESSION_A,
        title: "Ramen in the old town", meeting_point_label: "Terminal 2 food court",
        status: "open", max_members: 6,
        expires_at: new Date(now + 8 * 3_600_000).toISOString(),
        created_at: new Date(now - 60_000).toISOString(),
        updated_at: new Date(now - 60_000).toISOString(),
      },
    ],
    layover_crew_members: [
      { crew_id: CREW_ID, user_id: USER_A, session_id: SESSION_A, role: "owner", joined_at: new Date(now - 60_000).toISOString(), left_at: null },
    ],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
    blocks: [],
    profiles: [
      { id: USER_A, handle: "ann", name: "Ann", avatar_url: null },
      { id: USER_B, handle: "bo", name: "Bo", avatar_url: null },
    ],
    location_preferences: [
      { user_id: USER_A, location_mode: "city", sharing_paused: false },
      { user_id: USER_B, location_mode: "city", sharing_paused: false },
    ],
    trips: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [A_TOKEN]: USER_A, [B_TOKEN]: USER_B }, failures: {} }), true);
  return tables;
}

const liveMembers = (tables: Record<string, any[]>, userId: string) =>
  tables.layover_crew_members!.filter((m) => m.user_id === userId && (m.left_at ?? null) === null);

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
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("L185 — a crew join is scoped to the city the crew is in", () => {
  it("CONTROL: a traveller in the same city joins, and the crew is certified over both", async () => {
    const tables = stage({ bAirport: TPE });
    const joined = await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${CREW_ID}/join`));
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.inCrew, true);
    assert.equal(joined.body.crew.memberCount, 2);
    // The membership row is real, not echoed.
    assert.equal(liveMembers(tables, USER_B).length, 1);
  });

  it("a traveller on a layover in ANOTHER CITY is refused, and no membership is written", async () => {
    const tables = stage({ bAirport: DUBAI });

    // The premise: discovery already refuses to show B this crew, because B is
    // in Dubai and the crew is in Taoyuan. If this ever stops being true the
    // assertion below is measuring the wrong asymmetry.
    const list = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.inCrew, false);
    assert.deepEqual(list.body.crews, [], "discovery must not offer a crew in another city");

    const joined = await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${CREW_ID}/join`));
    assert.equal(
      joined.status, 400,
      `a Dubai layover joined a Taoyuan crew: ${JSON.stringify(joined.body)}`,
    );
    assert.equal(joined.body.error, "invalid_payload");
    assert.match(String(joined.body.message), /city|another/i);

    // REFUSED MEANS NOTHING WAS WRITTEN. A refusal that still inserts the row
    // is the same defect with a worse error message.
    assert.equal(liveMembers(tables, USER_B).length, 0, "a refused join still wrote a membership row");

    // And the crew the founder sees is still a crew of one.
    const mine = await call(A_TOKEN, "GET", crewUrl(SESSION_A));
    assert.equal(mine.body.crew.memberCount, 1, "a refused joiner is counted as a crewmate");
  });

  it("a traveller whose CITY IS UNKNOWN is refused, exactly as discovery refuses them", async () => {
    const tables = stage({ bAirport: NOWHERE, bManualCity: null });

    // The asymmetry in one pair of calls: GET refuses to name a single crew,
    // and POST let them into a named one.
    const list = await call(B_TOKEN, "GET", crewUrl(SESSION_B));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.reason, "city_unknown");
    assert.deepEqual(list.body.crews, []);

    const joined = await call(B_TOKEN, "POST", crewUrl(SESSION_B, `/${CREW_ID}/join`));
    assert.equal(
      joined.status, 400,
      `a layover with no known city joined a Taoyuan crew: ${JSON.stringify(joined.body)}`,
    );
    assert.equal(joined.body.error, "invalid_payload");

    assert.equal(liveMembers(tables, USER_B).length, 0, "a refused join still wrote a membership row");
  });
});
