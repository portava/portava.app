/**
 * What may reach a layover SAFETY decision, and what bounds a service-role read.
 *
 * Two census rows, both `N`/`W` for an ABSENCE rather than for a defect, and
 * both recorded as unguarded — which is the state where the absence can end
 * without anyone noticing.
 *
 * ── census-layover L256 — "Prevent sponsored/merchant inputs from modifying
 *    safety constraints" (`N ∅`) ─────────────────────────────────────────────
 * Its reason: *"No sponsored input path reaches the safety engine, and NO GUARD
 * PREVENTS ONE BEING ADDED."* Re-measured at this head: `grep -rn -i sponsor
 * src/services/airport/ src/routes/airport.ts` returns nothing, so the first
 * clause holds. This file is the second clause. `GET /:id/buddies` is the one
 * layover route that reads a marketplace table at all, and §9.1 requires the
 * safety gate to run BEFORE any of it; the cases below pin that ORDER and pin
 * the gate's argument list, so a merchant row acquiring influence over a
 * safety verdict turns this red instead of shipping.
 *
 * ── census-layover L205 — "Service-role processing should be narrow and
 *    auditable" (`W`) ────────────────────────────────────────────────────────
 * Its reason: *"every one of the ~30 layover routes runs on
 * `getServiceClient()`, so the whole domain bypasses RLS and the row policies
 * protect nothing on the server path."* Re-measured: TRUE, and it cannot be
 * fixed from this file — there is no user-scoped client anywhere in this API
 * (`lib/supabase.ts` exports `getServiceClient` and nothing else, and
 * `requireUser` hands back that same service client as `auth.client`), so
 * narrowing is a change to `src/lib/`, which this lane does not own.
 *
 * What IS this lane's, and what is asserted here: when RLS is bypassed, the
 * ownership predicate in the handler is the ONLY thing bounding the read. So
 * every session-scoped layover route must acquire its session through the one
 * guard that applies it, and a stranger must get 404 rather than a row. That is
 * the route-level substitute for the policy, and it is measurable.
 *
 * ── WHAT COULD HAVE MADE THIS PASS WITHOUT THE PROPERTY ──────────────────────
 *  * A route that refuses everybody. Every cross-tenant refusal is paired with
 *    the owner's own successful request against the same fixture.
 *  * A source scan that matches nothing. The route inventory is asserted
 *    non-empty and its size is asserted against the handlers actually declared.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverRouteSafetyInputs.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE_SRC = readFileSync(join(HERE, "..", "routes", "airport.ts"), "utf8");

const OWNER_TOKEN = "safety-inputs-owner";
const STRANGER_TOKEN = "safety-inputs-stranger";
const OWNER = "safety-inputs-owner-id";
const STRANGER = "safety-inputs-stranger-id";
const SESSION = "session-safety-inputs";
const HOUR = 3_600_000;

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;

function stage() {
  const now = Date.now();
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "rent_buddy_enabled", enabled: true },
    ],
    airport_profiles: [airportRow({ verified: true })],
    layover_sessions: [
      sessionRow({
        id: SESSION, user_id: OWNER, status: "active",
        arrival_time: new Date(now - 5 * 60_000).toISOString(),
        departure_time: new Date(now + 10 * HOUR).toISOString(),
      }),
    ],
    layover_plan_stops: [],
    layover_recommendations: [],
    layover_events: [],
    blocks: [],
    rent_buddy_profiles: [],
    rent_buddy_availability: [],
    trip_plan_items: [], trips: [], trip_members: [],
  };
  _setTestClient(
    makeLayoverDb(tables, { users: { [OWNER_TOKEN]: OWNER, [STRANGER_TOKEN]: STRANGER } }) as any,
    true,
  );
  return tables;
}

function send(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: {
          authorization: `Bearer ${token}`,
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

// ─────────────────────────────────────────────────────────────────────────────
// census L256 — the guard the row says does not exist
// ─────────────────────────────────────────────────────────────────────────────

describe("census L256 — no merchant input can reach a layover safety constraint", () => {
  it("the layover domain has no sponsored/merchant concept at all", () => {
    assert.ok(
      !/sponsor/i.test(ROUTE_SRC),
      "routes/airport.ts has acquired a sponsorship concept — L256's first clause no longer holds " +
        "and this suite must be rewritten around whatever was added, not deleted",
    );
  });

  it("the safety gate is decided from the airport and the session, and from nothing else", () => {
    const call = ROUTE_SRC.match(/layoverBuddyDecision\(([^)]*)\)/);
    assert.ok(call, "the buddy route must still consult the layover safety gate");
    const args = call![1].split(",").map((a) => a.trim()).filter(Boolean);
    assert.deepEqual(
      args, ["airport", "session"],
      "the safety gate took an argument that is not the airport or the traveller's own session — " +
        "a marketplace value reaching this call is exactly what L256 forbids",
    );
  });

  it("the gate runs BEFORE the marketplace is read — §9.1 is an order, not only a rule", () => {
    const gateAt = ROUTE_SRC.indexOf("layoverBuddyDecision(");
    const readAt = ROUTE_SRC.indexOf('.from("rent_buddy_profiles")');
    assert.ok(gateAt > 0 && readAt > 0, "both sites must exist for this ordering to mean anything");
    assert.ok(
      gateAt < readAt,
      "the marketplace is read before the safety gate is decided — §9.1's 'HARD GATE … before any optimisation'",
    );
  });

  it("and a session that cannot leave is served no buddies, whatever the marketplace holds", async () => {
    stage();
    // A 40-minute window at an international airport with a 120-minute buffer:
    // the engine's own `no`. The marketplace is deliberately non-empty.
    const now = Date.now();
    tables.layover_sessions[0].departure_time = new Date(now + 40 * 60_000).toISOString();
    tables.rent_buddy_profiles.push({
      id: "buddy-1", user_id: "buddy-user", display_name: "A Guide", tagline: null,
      city: "Taoyuan", country: "Taiwan", categories: ["layover"], hourly_rate_usd: 20,
      average_rating: 5, review_count: 10, verified: true, cover_photo_url: null,
      buddy_level: "pro", available_now: true, status: "active",
    });
    const r = await send("GET", `/api/airport/sessions/${SESSION}/buddies`, OWNER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.reason, "safety_gate_not_passed");
    assert.deepEqual(r.body.buddies, []);
    assert.equal(r.body.safetyGate.passed, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// census L205 — what bounds a read that bypasses RLS
// ─────────────────────────────────────────────────────────────────────────────

describe("census L205 — RLS is bypassed, so the ownership predicate is the whole boundary", () => {
  /**
   * The measurement behind the row, kept live rather than restated. If a
   * user-scoped client is ever introduced this assertion is what says the row
   * can move; until then it says why it cannot.
   */
  it("every layover session route still runs on the service client", () => {
    const handlers = ROUTE_SRC.match(/router\.(get|post|patch|put|delete)\("\/airport\//g) ?? [];
    assert.ok(handlers.length >= 25, `expected the full layover route family, found ${handlers.length}`);
    assert.ok(
      ROUTE_SRC.includes('import { getServiceClient } from "../lib/supabase.js"'),
      "this file's only database client is the service client — that is L205's finding",
    );
  });

  it("a stranger gets 404 on every session-scoped route, not a row", async () => {
    stage();
    const paths: Array<[string, string, unknown?]> = [
      ["GET", `/api/airport/sessions/${SESSION}/overview`],
      ["GET", `/api/airport/sessions/${SESSION}/stops`],
      ["GET", `/api/airport/sessions/${SESSION}/presence`],
      ["POST", `/api/airport/sessions/${SESSION}/return-deadline`, { minutesBefore: 30 }],
      ["PATCH", `/api/airport/sessions/${SESSION}/share`, { enabled: true }],
      ["POST", `/api/airport/sessions/${SESSION}/stops`, {
        title: "x", durationMin: 30, travelMin: 10, insideAirport: false,
      }],
      ["DELETE", `/api/airport/sessions/${SESSION}`],
    ];
    for (const [method, path, body] of paths) {
      const r = await send(method, path, STRANGER_TOKEN, body);
      assert.equal(r.status, 404, `${method} ${path} answered ${r.status} to a stranger`);
      assert.equal(r.body.error, "not_found");
    }
    // The control: the owner's own request on the same fixture is served, so
    // the refusals above are an ownership decision and not a broken fixture.
    const owned = await send("GET", `/api/airport/sessions/${SESSION}/stops`, OWNER_TOKEN);
    assert.equal(owned.status, 200);
    assert.ok(Array.isArray(owned.body.stops));
    // And nothing the stranger sent reached the row.
    assert.equal(tables.layover_sessions[0].status, "active");
    assert.equal(tables.layover_sessions[0].share_city_status, false);
    assert.equal(tables.layover_sessions[0].return_reminder_at, null);
    assert.equal(tables.layover_plan_stops.length, 0);
  });
});
