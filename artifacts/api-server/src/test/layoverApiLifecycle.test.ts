/**
 * census-layover **L239** — "E2E tests for detection → evaluation → plan →
 * execution → return → completion."
 *
 * ── THE ROW'S STATED REASON, RE-TESTED ───────────────────────────────────────
 * L239's last verdict is `N`, and its reason — restated verbatim by §24's
 * blocker table — is *"Four of the six stages have no implementation to test."*
 * That was true when it was written and it is NOT true at this head. Measured
 * against `routes/airport.ts` as it stands:
 *
 *   detection    POST /airport/sessions/:id/disruption   EXISTS — and the only
 *                producer is the traveller, which the route says on the wire
 *                (`disruption.source: "traveller"`). There is no flight feed.
 *   evaluation   GET  /airport/sessions/:id/safety       EXISTS
 *   plan         POST /airport/sessions/:id/stops        EXISTS
 *   execution    PATCH /…/stops/:stopId, POST /…/reorder EXISTS
 *   return       POST /airport/sessions/:id/return-now   EXISTS
 *   completion   DELETE /airport/sessions/:id?outcome=…  EXISTS
 *
 * So ONE stage lacks an implementation, not four, and the missing thing is a
 * PRODUCER rather than a route. This suite walks all six over the real Express
 * router, in order, on ONE session, and asserts each stage's output is carried
 * into the next — which is the property an E2E test has and six unit tests do
 * not.
 *
 * ── WHAT THIS SUITE DOES NOT CLAIM ───────────────────────────────────────────
 * It does not claim L239 is closed. Detection has no producer: nothing on this
 * tree observes a delay, so the "detection" stage is a traveller typing what
 * a departure board told them. The case below asserts exactly that and fails
 * the day the route starts claiming a source it does not have.
 *
 * ── WHAT COULD HAVE MADE IT PASS WITHOUT THE PROPERTY ────────────────────────
 *  * A crash at any stage. Every stage asserts a status code AND a body field.
 *  * Stages that do not compose. The deadline from the evaluation stage is
 *    compared against the one the return stage publishes; the stop written in
 *    the plan stage is the stop the return stage cancels, read back out of the
 *    table rather than out of a response body.
 *  * A session that was never actually closed. Completion is asserted from
 *    `layover_sessions[0].status`, not from `ok: true`.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverApiLifecycle.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const TOKEN = "lifecycle-token";
const USER = "lifecycle-user";
const SESSION = "session-lifecycle";
const HOUR = 3_600_000;

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;

function stage(over: Record<string, unknown> = {}) {
  const now = Date.now();
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
    ],
    airport_profiles: [airportRow({ verified: true })],
    layover_sessions: [
      sessionRow({
        id: SESSION, user_id: USER, status: "active",
        arrival_time: new Date(now - 10 * 60_000).toISOString(),
        departure_time: new Date(now + 12 * HOUR).toISOString(),
        flight_type: "international", immigration_required: false,
        ...over,
      }),
    ],
    layover_plan_stops: [],
    layover_recommendations: [],
    layover_events: [],
    trip_plan_items: [], trips: [], trip_members: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER } }) as any, true);
  return tables;
}

function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        let acc = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { acc += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

const eventTypes = () => (tables.layover_events ?? []).map((e: any) => e.event_type);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => { server?.close(); _setTestClient(null as any, false); });

describe("census L239 — one layover walks detection → … → completion over the real router", () => {
  it("every stage runs, and each one's output is what the next one reads", async () => {
    stage();

    // ── 1. DETECTION ────────────────────────────────────────────────────────
    // The only producer is the traveller. That is a limitation and the route
    // publishes it rather than implying a feed.
    const detected = await send("POST", `/api/airport/sessions/${SESSION}/disruption`, {
      kind: "delay", delayMinutes: 40,
    });
    assert.equal(detected.status, 200, "detection stage");
    assert.equal(detected.body.ok, true);
    assert.equal(detected.body.disruption.source, "traveller");
    assert.equal(detected.body.disruption.state, "DELAYED");

    // ── 2. EVALUATION ───────────────────────────────────────────────────────
    const evaluated = await send("GET", `/api/airport/sessions/${SESSION}/safety`);
    assert.equal(evaluated.status, 200, "evaluation stage");
    assert.equal(evaluated.body.featureEnabled, true);
    assert.ok(evaluated.body.certification?.inputHash, "the evaluation is certified");
    assert.ok(typeof evaluated.body.hardReturnTime === "string");
    const evaluatedDeadline = evaluated.body.hardReturnTime;
    assert.ok(evaluated.body.usableMinutes > 0, "a 12-hour layover has usable time");

    // ── 3. PLAN ─────────────────────────────────────────────────────────────
    const planned = await send("POST", `/api/airport/sessions/${SESSION}/stops`, {
      title: "Din Tai Fung", durationMin: 60, travelMin: 45,
      insideAirport: false, lat: 25.1247, lng: 121.2342,
    });
    assert.equal(planned.status, 200, "plan stage");
    assert.equal(planned.body.stops.length, 1);
    assert.ok(planned.body.planFit, "the plan is certified against the window");
    assert.equal(planned.body.planFit.fit, "fits");
    const stopId = planned.body.stops[0].id;

    // ── 4. EXECUTION ────────────────────────────────────────────────────────
    // The traveller edits the plan they are living. The row is read back from
    // the TABLE, not from the response, so a handler that answered without
    // writing cannot pass this.
    const executed = await send("PATCH", `/api/airport/sessions/${SESSION}/stops/${stopId}`, {
      durationMin: 90,
    });
    assert.equal(executed.status, 200, "execution stage");
    assert.equal(tables.layover_plan_stops[0].duration_min, 90);

    // ── 5. RETURN ───────────────────────────────────────────────────────────
    const returned = await send("POST", `/api/airport/sessions/${SESSION}/return-now`, {});
    assert.equal(returned.status, 200, "return stage");
    assert.equal(returned.body.ok, true);
    assert.ok(returned.body.returnContract, "§15.1's return contract is published");
    assert.equal(
      returned.body.returnContract.hardReturnTime, evaluatedDeadline,
      "the deadline the traveller was evaluated against is the deadline they are sent back by",
    );
    assert.deepEqual(
      returned.body.cancelledStopIds, [stopId],
      "the landside stop planned at stage 3 is the stop the abort cancels",
    );
    assert.equal(
      tables.layover_plan_stops.length, 0,
      "and it is gone from the table, not merely absent from the body",
    );
    assert.ok(returned.body.effects.includes("ledger_recorded"));

    // ── 6. COMPLETION ───────────────────────────────────────────────────────
    const completed = await send(
      "DELETE", `/api/airport/sessions/${SESSION}?outcome=completed&passportStamp=true`,
    );
    assert.equal(completed.status, 200, "completion stage");
    assert.equal(completed.body.outcome, "completed");
    assert.equal(
      tables.layover_sessions[0].status, "completed",
      "completion is a fact about the row, not a field in a response",
    );
    // The election was made and is REPORTED either way — `passport_stamps_enabled`
    // is absent from this fixture, so the honest answer is a refusal with a name.
    assert.equal(completed.body.passportStamp.requested, true);
    assert.equal(completed.body.passportStamp.written, false);
    assert.equal(completed.body.passportStamp.reason, "feature_disabled");

    // ── the trail the six stages left ───────────────────────────────────────
    const trail = eventTypes();
    for (const expected of [
      "session_updated",        // detection
      "plan_stop_added",        // plan
      "plan_stop_updated",      // execution
      "safe_return_aborted",    // return
    ]) {
      assert.ok(trail.includes(expected), `the ledger should hold ${expected}; it holds ${JSON.stringify(trail)}`);
    }
  });

  it("the stage that is NOT built is detection, and nothing pretends otherwise", async () => {
    stage();
    const r = await send("POST", `/api/airport/sessions/${SESSION}/disruption`, {
      kind: "cancellation",
    });
    assert.equal(r.status, 200);
    // A cancellation reported by a human is a cancellation reported by a human.
    // The day a feed exists this assertion is what makes someone change it.
    assert.equal(r.body.disruption.source, "traveller");
    assert.equal(r.body.disruption.state, "CANCELLED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// census L221 — "6h visa-free → landside + return contract"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * L221's stated reason is *"No return contract (L24)."*
 *
 * RE-TESTED AND FALSE at this head. L24 is about a `layover_return_plans`
 * TABLE, which really is absent; a return CONTRACT is a different artifact and
 * it exists — `services/airport/LayoverSafeReturnService.ts:144` declares it,
 * `buildReturnContract` builds it and `POST /:id/return-now` publishes it. The
 * scenario below drives the spec's own 6-hour case over the real router and
 * pins both halves.
 *
 * It is NOT `C`. "visa-free" is unrepresentable — there is no entry-permission
 * field on `layover_sessions` (census L34, `N`) — and the contract's `route` is
 * hard-`null` with `routeUnavailableReason: "no_routing_provider"`, so a
 * traveller is told WHEN to leave and never HOW to get back. Both are asserted
 * so the case fails the day either changes.
 */
describe("census L221 — 6h international at a curated airport: landside, with the contract", () => {
  it("the window reaches the city and the abort hands back a full return contract", async () => {
    const now = Date.now();
    stage({
      arrival_time: new Date(now - 60_000).toISOString(),
      departure_time: new Date(now + 6 * HOUR).toISOString(),
      flight_type: "international",
      immigration_required: false,
      checked_bags: false,
    });

    const safety = await send("GET", `/api/airport/sessions/${SESSION}/safety`);
    assert.equal(safety.status, 200);
    assert.ok(safety.body.usableMinutes > 0, "6h international at a curated airport leaves usable time");
    assert.ok(
      safety.body.safeEnvelope && safety.body.safeEnvelope.radiusMetres > 0,
      "there is a landside envelope to explore",
    );

    const abort = await send("POST", `/api/airport/sessions/${SESSION}/return-now`, {});
    assert.equal(abort.status, 200);
    const c = abort.body.returnContract;
    assert.ok(c, "the return contract exists — L221's stated reason is false at this head");
    assert.equal(typeof c.hardReturnTime, "string");
    assert.equal(typeof c.bufferMinutes, "number");
    assert.ok(c.certification?.inputHash, "the contract names the computation behind it");
    assert.equal(c.airport.iataCode, "TPE");

    // The half that is still missing, asserted rather than assumed.
    assert.equal(c.route, null, "there is no route back — only a deadline");
    assert.equal(c.routeUnavailableReason, "no_routing_provider");
  });

  it("the 'visa-free' half of L221 has no field to carry it", async () => {
    stage();
    const r = await send("GET", `/api/airport/sessions/${SESSION}/overview`);
    assert.equal(r.status, 200);
    const names = Object.keys(r.body.session ?? {}).map((k) => k.toLowerCase());
    for (const term of ["visa", "entry", "permission", "eligib"]) {
      assert.ok(
        !names.some((n) => n.includes(term)),
        `the session now carries a '${term}' field — L221's unrepresentable half may have become representable, ` +
          "and this scenario must be rewritten rather than left asserting an absence",
      );
    }
  });
});
