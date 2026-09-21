/**
 * VERIFICATION LANE V1 — privacy / authorization.
 *
 * The layover write surface, against the three callers that matter:
 *
 *   1. an ANONYMOUS caller,
 *   2. an authenticated caller who is NOT the session's owner,
 *   3. the owner (the positive control, without which 1 and 2 prove nothing).
 *
 * ── WHY THIS FILE EXISTS ALONGSIDE layoverUnreadableReads.test.ts ──────────
 *
 * That file pins the FAIL-CLOSED half: an unreadable `layover_sessions` must
 * answer 503, and a genuinely MISSING session must still answer 404. Both arms
 * are already covered there, and this file does not repeat them.
 *
 * What was NOT covered anywhere is the arm in between, which is the actual
 * authorization question: a session that EXISTS and belongs to SOMEBODY ELSE.
 * `getSession()` (services/airport/LayoverSessionService.ts) filters
 * `.eq("user_id", userId)`, so a stranger's read returns `data: null` and
 * `ownedSessionOr()` renders that as 404 — the same 404 a missing session gets,
 * which is the right answer (a distinct 403 would confirm the session exists)
 * but is indistinguishable from "no such row" unless a test stages a real row
 * owned by a real other user. Nothing did.
 *
 * Every write route in `routes/airport.ts` outside the `/admin/` block reaches
 * that one helper through `requireOwnedSession`, so a regression in it is a
 * regression in all eighteen at once. That is the thing worth pinning.
 *
 * ── RESULT ON FIRST RUN, STATED HONESTLY ───────────────────────────────────
 *
 * GREEN on first run (12/12) against unmodified `routes/airport.ts` at
 * f224ae67e. This is a proof, not a repair, and the file says so rather than
 * inventing a red phase it did not have.
 *
 * What a green-on-arrival test still owes the reader is evidence that its
 * assertions BITE, so two mutations were run and reverted:
 *
 *   MUTATION 1 — `.eq("user_id", userId)` deleted from `getSession()`
 *   (services/airport/LayoverSessionService.ts). Measured: 8 pass, 4 FAIL —
 *   POST /stops, POST /observations, POST /crew and PATCH /share all answered
 *   200 for the stranger, appended to the owner's plan, emitted layover_events
 *   against the owner's session, and switched the owner's `share_city_status`
 *   to true.
 *
 *   DELETE did NOT fail under mutation 1, and that is worth recording rather
 *   than glossing: `DELETE /sessions/:id` does not go through
 *   `requireOwnedSession` at all. It calls `endSessionWrite()`, which carries
 *   its OWN `.eq("user_id", userId)`. So the layover surface has two
 *   independent ownership filters, not one, and a fix applied to only the
 *   obvious one would leave the other open.
 *
 *   MUTATION 2 — `.eq("user_id", userId)` deleted from `endSessionWrite()`.
 *   Measured: the DELETE case FAILS (the stranger's request answered 200 and
 *   the owner's session was closed under them).
 *
 * Both mutations were reverted; neither was committed.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verifyAuthzLayoverCrossTenant.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const OWNER = "owner-user-1";
const STRANGER = "stranger-user-2";
const OWNER_TOKEN = "tok-owner";
const STRANGER_TOKEN = "tok-stranger";

const SESSION = "session-1";

let server: http.Server;
let base: string;

function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: any }> {
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
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let p: any;
          try { p = raw ? JSON.parse(raw) : null; } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * One session, owned by OWNER, with STRANGER a perfectly real authenticated
 * user who simply does not own it. Both tokens resolve — that is the point: if
 * the stranger's token did not resolve, every assertion below would pass for
 * the wrong reason.
 */
function stage() {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "layover_stable_recommendation_ids_enabled", enabled: false },
    ],
    airport_profiles: [airportRow({})],
    layover_sessions: [sessionRow({ id: SESSION, user_id: OWNER })],
    layover_plan_stops: [],
    layover_recommendations: [],
    layover_events: [],
    discovery_places: [],
    blocks: [],
    profiles: [],
  };
  _setTestClient(
    makeLayoverDb(tables, {
      users: { [OWNER_TOKEN]: OWNER, [STRANGER_TOKEN]: STRANGER },
    }),
    true, // also stands in for getServiceClient() — every airport route uses it
  );
  return tables;
}

const NEW_STOP = {
  title: "Din Tai Fung",
  durationMin: 60,
  travelMin: 0,
  insideAirport: true,
};

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

// ═══════════════════════════════════════════════════════════════════════════
// 1. The positive control. Everything below is worthless without it: a route
//    that refuses EVERYONE satisfies every negative assertion in this file.
// ═══════════════════════════════════════════════════════════════════════════

describe("the OWNER can write to their own layover", () => {
  it("POST /stops writes the stop", async () => {
    const t = stage();
    const r = await call("POST", `/api/airport/sessions/${SESSION}/stops`, OWNER_TOKEN, NEW_STOP);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(t.layover_plan_stops.length, 1);
    assert.equal(t.layover_plan_stops[0].session_id, SESSION);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The anonymous caller. `requireUser` is the gate; it must fire before the
//    session is even looked up.
// ═══════════════════════════════════════════════════════════════════════════

describe("what stops an ANONYMOUS caller", () => {
  const writes: Array<[string, string, unknown]> = [
    ["POST", `/api/airport/sessions/${SESSION}/stops`, NEW_STOP],
    ["POST", `/api/airport/sessions/${SESSION}/observations`, { factType: "security_wait_minutes", value: 15 }],
    ["POST", `/api/airport/sessions/${SESSION}/crew`, { title: "Noodles?" }],
    ["PATCH", `/api/airport/sessions/${SESSION}/share`, { shareCityStatus: true }],
    ["DELETE", `/api/airport/sessions/${SESSION}`, undefined],
  ];

  for (const [method, path, body] of writes) {
    it(`${method} ${path.replace(SESSION, ":id")} → 401, and nothing is written`, async () => {
      const t = stage();
      const before = JSON.stringify(t);
      const r = await call(method, path, null, body);
      assert.equal(r.status, 401, JSON.stringify(r.body));
      assert.equal(JSON.stringify(t), before, "an unauthenticated write must leave the world untouched");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The authenticated stranger. THE case this suite existed without.
//
//    RED EVIDENCE: see the two mutations named in this file's header. Between
//    them, every case in this block has been observed failing against a
//    deliberately broken ownership filter — and the fact that ONE mutation was
//    not enough to break them all is how the second, independent ownership
//    filter in `endSessionWrite()` was found.
// ═══════════════════════════════════════════════════════════════════════════

describe("what stops an authenticated caller who is NOT the owner", () => {
  it("POST /stops → 404, and the owner's plan is unchanged", async () => {
    const t = stage();
    const r = await call("POST", `/api/airport/sessions/${SESSION}/stops`, STRANGER_TOKEN, NEW_STOP);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(t.layover_plan_stops.length, 0, "a stranger must not be able to append to someone else's plan");
  });

  it("the 404 does not confirm the session exists", async () => {
    // A 403 here would be an existence oracle: it would tell an enumerating
    // caller which session ids are real. 404 for both "no such session" and
    // "not yours" is the deliberate answer, and the refusal text must not
    // undo it by naming the owner.
    const t = stage();
    const r = await call("POST", `/api/airport/sessions/${SESSION}/stops`, STRANGER_TOKEN, NEW_STOP);
    // Asserted FIRST, and it is not a duplicate of the case above: without it
    // this test passes when the route answers 200, because a success body
    // contains neither the owner's id nor the word "forbidden". A
    // no-such-string assertion is vacuous unless the refusal is pinned too.
    assert.equal(r.status, 404, JSON.stringify(r.body));
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(OWNER), text);
    assert.ok(!text.includes("forbidden"), text);
    assert.equal(t.layover_plan_stops.length, 0);
  });

  it("POST /observations → 404, and no layover event is emitted", async () => {
    // The observation channel is a shared corpus, so the tempting reading is
    // that anyone may post to it. The route disagrees, and it is right to: the
    // report is bound to a session and to `emitLayoverEvent(sc, session.id,
    // user.id, ...)`, so a stranger's report would attribute an event row to
    // somebody else's layover.
    const t = stage();
    const r = await call(
      "POST",
      `/api/airport/sessions/${SESSION}/observations`,
      STRANGER_TOKEN,
      { factType: "security_wait_minutes", value: 15 },
    );
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(t.layover_events.length, 0);
  });

  it("POST /crew → 404, and no crew is formed on the owner's session", async () => {
    const t = stage();
    const r = await call("POST", `/api/airport/sessions/${SESSION}/crew`, STRANGER_TOKEN, { title: "Noodles?" });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(t.layover_events.length, 0);
  });

  it("PATCH /share → 404, and the owner's city-sharing setting is untouched", async () => {
    // The most consequential of the lot: `share_city_status` is what puts a
    // traveller's location in front of other people. A cross-tenant write here
    // is a stranger switching on someone else's location sharing.
    const t = stage();
    const beforeFlag = t.layover_sessions[0].share_city_status;
    assert.equal(beforeFlag, false, "positive control: the fixture starts with sharing OFF");
    const r = await call("PATCH", `/api/airport/sessions/${SESSION}/share`, STRANGER_TOKEN, {
      shareCityStatus: true,
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(
      t.layover_sessions[0].share_city_status,
      false,
      "a stranger must not be able to switch on another traveller's city sharing",
    );
  });

  it("DELETE /sessions/:id → 404, and the session survives", async () => {
    const t = stage();
    const r = await call("DELETE", `/api/airport/sessions/${SESSION}`, STRANGER_TOKEN);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(t.layover_sessions.length, 1, "a stranger must not be able to end someone else's layover");
  });
});
